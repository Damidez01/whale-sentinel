const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { DurableState, Delivery } = require('../src/alerts/durable');
const { commandHandler } = require('../src/alerts/commands');
const { extraAccumulation } = require('../src/monitors/accumulationExtra');
const A = '0x' + '1'.repeat(40), B = '0x' + '2'.repeat(40);
function state(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chainhound-test-'));
  t.after(() => { for (const file of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, file)); fs.rmdirSync(dir); });
  return new DurableState(path.join(dir, 'telegram.json'));
}
function message(text, id = 1) { return { text, message_id: id, from: { id: 123 }, chat: { id: 123, type: 'private' } }; }
test('private owner blocks persist across restart and unauthorized users cannot change exclusions', t => {
  const s = state(t), handle = commandHandler(s, { chatId: '123' });
  assert.equal(handle({ ...message(`/block ${A}`), from: { id: 999 } }), null);
  assert.equal(handle({ ...message(`/block ${A}`), chat: { id: 999, type: 'private' } }), null);
  assert.equal(s.isBlocked(A), false);
  assert.match(handle(message(`/block ${A} exchange wallet`)), /Saved/);
  const restarted = new DurableState(s.file); assert.equal(restarted.isBlocked(A), true);
  assert.match(handle(message('/blocked', 2)), /exchange wallet/);
  assert.match(handle(message(`/unblock ${A}`, 3)), /Removed/); assert.equal(s.isBlocked(A), false);
});
test('group commands fail closed without an explicit authorized user', t => {
  const s = state(t), msg = { ...message(`/block ${A}`), chat: { id: -123, type: 'supergroup' } };
  assert.equal(commandHandler(s, { chatId: '-123' })(msg), null);
  assert.match(commandHandler(s, { chatId: '-123', adminIds: ['123'] })(msg), /Saved/);
});
test('reply blocks use saved alert metadata; mute expires and replay does not extend it', t => {
  const s = state(t); let now = 100000;
  s.update(d => { d.messages[50] = A; });
  const handle = commandHandler(s, { chatId: '123', now: () => now });
  const msg = { ...message('/mute 1h'), reply_to_message: { message_id: 50 } };
  assert.match(handle(msg), /Muted/); assert.equal(s.isBlocked(A, now), true);
  now += 3600001; assert.equal(s.isBlocked(A, now), false);
  assert.match(handle(msg), /already applied/); assert.equal(s.isBlocked(A, now), false);
  assert.match(handle({ ...message('/block', 2), reply_to_message: { message_id: 999, text: A } }), /Supply a valid/);
});
test('failed alert remains durable, honors Telegram retry_after, and records dedup only on success', async t => {
  const s = state(t); let now = 1000, calls = 0;
  const d = new Delivery(s, { now: () => now, render: a => a.body, send: async () => {
    calls++; if (calls === 1) throw { response: { body: { error_code: 429, parameters: { retry_after: 20 } } } };
    return { message_id: 55 };
  } });
  d.enqueue({ alertId: 'a', wallet: A, body: 'Alert' }); await d.tick();
  assert.equal(s.data.queue.length, 1); assert.equal(s.data.sent.a, undefined);
  const restarted = new DurableState(s.file);
  assert.equal(restarted.data.queue[0].nextAttempt, 21000);
  const resumed = new Delivery(restarted, { now: () => now, render: a => a.body, send: async () => { calls++; return { message_id: 55 }; } });
  now = 20000; await resumed.tick(); assert.equal(calls, 1);
  now = 21000; await resumed.tick(); assert.equal(calls, 2); assert.equal(restarted.data.queue.length, 0);
  assert.equal(restarted.data.messages[55], A); assert.equal(resumed.enqueue({ alertId: 'a' }), false);
});
test('blocking removes queued wallet alerts but preserves another watched wallet sending to it', t => {
  const s = state(t), d = new Delivery(s, { send: async () => {}, render: () => '' });
  d.enqueue({ alertId: 'own', wallet: A }); d.enqueue({ alertId: 'other', wallet: B, destination: A });
  commandHandler(s, { chatId: '123' })(message(`/block ${A}`));
  assert.deepEqual(s.data.queue.map(x => x.id), ['other']);
  assert.equal(d.enqueue({ wallet: A }), false);
});
test('a failing alert does not hold up other alerts and bad Markdown retries as plain text', async t => {
  const s = state(t); let now = 1000; const sent = [];
  const d = new Delivery(s, { now: () => now, rateMs: 0, render: a => a.body, send: async (text, a, plain) => {
    if (text === 'bad' && !plain) throw { response: { body: { error_code: 400, description: "can't parse entities" } } };
    sent.push(text);
  } });
  d.enqueue({ alertId: 'a', body: 'bad' }); d.enqueue({ alertId: 'b', body: 'good' });
  await d.tick(); await d.tick(); assert.deepEqual(sent, ['good']);
  now += 3000; await d.tick(); assert.deepEqual(sent, ['good', 'bad']);
});
test('corrupt persisted state fails instead of erasing exclusions and pending alerts', t => {
  const s = state(t); fs.writeFileSync(s.file, '{broken'); assert.throws(() => new DurableState(s.file));
});
function engine() {
  let now = 10000000; const windows = new Map(), kv = new Map(), alerts = [];
  const store = {
    windowGet: (k, seconds) => (windows.get(k) || []).filter(x => now - x.at < seconds * 1000).map(x => x.value),
    windowAdd(k, value, seconds) { const rows = (windows.get(k) || []).filter(x => now - x.at < seconds * 1000); rows.push({ value, at: now }); windows.set(k, rows); return rows.length; },
    getKey: k => kv.get(k)?.until > now ? kv.get(k).value : null,
    setKey: (k, value, ttl) => kv.set(k, { value, until: now + ttl * 1000 }),
  };
  const sandbox = { module: { exports: {} }, process: { env: {} }, console, setInterval: () => {},
    require: name => {
      if (name === '../utils/store') return store;
      if (name === '../alerts/telegram') return { sendAlert: a => alerts.push(a), isBlocked: a => a === 'blocked' };
      if (name === './accumulationExtra') return { extraAccumulation };
      if (name === '../intelligence/flagged') return { shortAddr: a => a };
      if (name === '../utils/prices') return { fmtUSD: n => '$' + n };
      return {};
    } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/monitors/evm.js'), 'utf8') + '\nmodule.exports.check = checkAccumulationRules;', sandbox);
  return { alerts, check: sandbox.module.exports.check, advance: ms => { now += ms; } };
}
test('original 100k x 3 and escalating counts remain, without duplicate additional alerts', async () => {
  const e = engine();
  for (let i = 0; i < 7; i++) await e.check({ to: A, hash: 't' + i }, 100000, 'ETH');
  assert.equal(e.alerts.length, 3); assert.ok(e.alerts[0].title.includes('Rapid Fund'));
  assert.ok(e.alerts.slice(1).every(a => a.title.includes('Escalating')));
  assert.ok(e.alerts.every(a => !a.alertId.includes('additional')));
});
test('additional >50k x 5 rule is strict, recipient-specific and escalates at seven', async () => {
  const e = engine();
  for (let i = 0; i < 5; i++) await e.check({ to: A, hash: 'eq' + i }, 50000, 'ETH');
  assert.equal(e.alerts.length, 0);
  for (let i = 0; i < 7; i++) await e.check({ to: A, hash: 'gt' + i }, 50001, 'ETH');
  assert.equal(e.alerts.length, 2); assert.ok(e.alerts.every(a => a.alertId.includes('additional')));
  await e.check({ to: B, hash: 'other' }, 60000, 'ETH'); assert.equal(e.alerts.length, 2);
});
test('additional rule respects 30-minute expiry and built-in exchange exclusions', async () => {
  const e = engine();
  for (let i = 0; i < 4; i++) await e.check({ to: A, hash: 'a' + i }, 60000, 'ETH');
  e.advance(30 * 60000); await e.check({ to: A, hash: 'late' }, 60000, 'ETH'); assert.equal(e.alerts.length, 0);
  for (let i = 0; i < 7; i++) await e.check({ to: '0x28c6c06298d514db089934071355e5743bf21d60', hash: 'b' + i }, 60000, 'ETH');
  assert.equal(e.alerts.length, 0);
});
test('Telegram integration delivers buttons and only the owner can use callbacks or reply commands', async t => {
  const s = state(t), sent = [], handlers = {}, acknowledgements = [];
  let tick, client;
  class Bot {
    constructor(token, options) { this.options = options; client = this; }
    on(event, fn) { handlers[event] = fn; }
    async startPolling() {}
    async sendMessage(chat, text, options) { sent.push({ chat, text, options }); return { message_id: sent.length }; }
    async answerCallbackQuery(id, options) { acknowledgements.push(options.text); }
  }
  const sandbox = { module: { exports: {} }, process: { env: { TELEGRAM_CHAT_ID: '123', TELEGRAM_DATA_DIR: path.dirname(s.file) } },
    setInterval: fn => { tick = fn; return 1; }, require: name => {
      if (name === 'node-telegram-bot-api') return Bot;
      if (name === 'path') return path;
      if (name === './durable') return { DurableState, Delivery };
      if (name === './commands') return { commandHandler };
      return { warn() {}, error() {}, info() {} };
    } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/alerts/telegram.js'), 'utf8'), sandbox);
  const api = sandbox.module.exports;
  api.startTelegram();
  assert.deepEqual(Array.from(client.options.polling.params.allowed_updates), ['message', 'callback_query']);
  api.sendAlert({ alertId: 'test', wallet: A, title: 'Test', body: 'Body', chain: 'ETH' });
  await tick();
  assert.equal(sent[0].options.reply_markup.inline_keyboard[0][0].callback_data, 'block-wallet');
  handlers.callback_query({ id: 'evil', data: 'block-wallet', from: { id: 999 }, message: { message_id: 1, chat: { id: 123, type: 'private' } } });
  assert.equal(api.isBlocked(A), false);
  handlers.callback_query({ id: 'owner', data: 'block-wallet', from: { id: 123 }, message: { message_id: 1, chat: { id: 123, type: 'private' } } });
  assert.equal(api.isBlocked(A), true);
  handlers.message({ ...message('/unblock', 22), reply_to_message: { message_id: 1 } });
  assert.equal(api.isBlocked(A), false);
  assert.equal(acknowledgements[0], 'Not authorized');
});
