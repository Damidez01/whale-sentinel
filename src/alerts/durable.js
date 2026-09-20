const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

class DurableState {
  constructor(file) {
    this.file = file;
    this.data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) :
      { version: 1, blocked: {}, queue: [], sent: {}, messages: {}, commands: {} };
    if (this.data.version !== 1 || !Array.isArray(this.data.queue) ||
      ['blocked','sent','messages','commands'].some(k => !this.data[k] || typeof this.data[k] !== 'object')) {
      throw new Error('Invalid Telegram state; preserve the file and inspect it');
    }
    this.update(() => {}); // Fail at startup if durable storage is unavailable.
  }
  update(fn) {
    const next = structuredClone(this.data);
    const result = fn(next);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = this.file + '.tmp';
    const fd = fs.openSync(temp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(next)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, this.file);
    this.data = next;
    return result;
  }
  isBlocked(address, now = Date.now()) {
    const row = this.data.blocked[address?.toLowerCase()];
    return !!row && (!row.until || row.until > now);
  }
}

class Delivery {
  constructor(state, { send, render, now = Date.now, rateMs = 8000, onError = () => {} }) {
    Object.assign(this, { state, send, render, now, rateMs, onError });
    this.busy = false;
    this.nextSend = 0;
  }
  enqueue(alert) {
    if (this.state.isBlocked(alert.wallet, this.now())) return false;
    const id = alert.alertId || randomUUID();
    if (this.state.data.queue.some(x => x.id === id) || this.state.data.sent[id] > this.now()) return false;
    this.state.update(s => {
      for (const [k,v] of Object.entries(s.sent)) if (v <= this.now()) delete s.sent[k];
      s.queue.push({ id, alert, at: this.now(), attempts: 0, nextAttempt: 0 });
    });
    return true;
  }
  async tick() {
    if (this.busy || this.now() < this.nextSend) return;
    const item = this.state.data.queue.find(x => x.nextAttempt <= this.now());
    if (!item) return;
    this.busy = true;
    try {
      if (this.state.isBlocked(item.alert.wallet, this.now())) {
        this.state.update(s => { s.queue = s.queue.filter(x => x.id !== item.id); });
        return;
      }
      const result = await this.send(this.render(item.alert), item.alert, item.plain);
      this.nextSend = this.now() + this.rateMs;
      this.state.update(s => {
        s.queue = s.queue.filter(x => x.id !== item.id);
        s.sent[item.id] = this.now() + 300000;
        if (result?.message_id && /^0x[0-9a-f]{40}$/i.test(item.alert.wallet || '')) {
          s.messages[result.message_id] = item.alert.wallet.toLowerCase();
          const ids = Object.keys(s.messages);
          for (const id of ids.slice(0, Math.max(0, ids.length - 10000))) delete s.messages[id];
        }
      });
    } catch (err) {
      const body = err.response?.body;
      const retry = Number(body?.parameters?.retry_after) || 0;
      this.state.update(s => {
        const row = s.queue.find(x => x.id === item.id);
        if (!row) return;
        row.attempts++;
        if (body?.error_code === 400 && /parse entities/i.test(body.description || '')) row.plain = true;
        row.nextAttempt = this.now() + Math.max(retry * 1000, Math.min(300000, 1000 * 2 ** Math.min(row.attempts, 8)));
        if (retry) this.nextSend = row.nextAttempt;
      });
      this.onError(body?.error_code || 'network/storage');
    } finally { this.busy = false; }
  }
}
module.exports = { DurableState, Delivery };
