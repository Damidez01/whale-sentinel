// Sliding window + KV store with optional file persistence
// If /data is mounted (Railway volume), kvStore survives restarts.
// Windows are always in-memory (they're short-lived by design).

const fs   = require('fs');
const path = require('path');

const PERSIST_PATH = '/data/store.json';
const PERSIST_MS   = 30_000; // flush to disk every 30s

const windows = new Map(); // key -> [{value, ts}]
const kvStore  = new Map(); // key -> {value, expires}

// ── Persistence ──────────────────────────────────────────────

function loadFromDisk() {
  try {
    if (!fs.existsSync(PERSIST_PATH)) return;
    const raw  = fs.readFileSync(PERSIST_PATH, 'utf8');
    const data = JSON.parse(raw);
    const now  = Date.now();
    let loaded = 0;
    for (const [k, v] of Object.entries(data)) {
      if (v.expires > now) { // skip already-expired keys
        kvStore.set(k, v);
        loaded++;
      }
    }
    console.log(`[store] Loaded ${loaded} keys from ${PERSIST_PATH}`);
  } catch (err) {
    console.warn(`[store] Could not load from disk: ${err.message}`);
  }
}

function flushToDisk() {
  try {
    const dir = path.dirname(PERSIST_PATH);
    if (!fs.existsSync(dir)) return; // /data not mounted — skip silently
    const now  = Date.now();
    const data = {};
    for (const [k, v] of kvStore) {
      if (v.expires > now) data[k] = v; // only persist non-expired
    }
    fs.writeFileSync(PERSIST_PATH, JSON.stringify(data), 'utf8');
  } catch {
    // /data not mounted or not writable — in-memory only, that's fine
  }
}

// Load on startup, flush every 30s
loadFromDisk();
setInterval(flushToDisk, PERSIST_MS);

// ── Sliding window ───────────────────────────────────────────

function _clean(key, windowMs) {
  const now   = Date.now();
  const items = (windows.get(key) || []).filter(i => now - i.ts < windowMs);
  windows.set(key, items);
  return items;
}

function windowAdd(key, value, windowSeconds) {
  const items = _clean(key, windowSeconds * 1000);
  items.push({ value, ts: Date.now() });
  windows.set(key, items);
  return items.length;
}

function windowGet(key, windowSeconds) {
  return _clean(key, windowSeconds * 1000).map(i => i.value);
}

function windowCountUnique(key, windowSeconds) {
  const items = _clean(key, windowSeconds * 1000);
  return new Set(items.map(i => i.value)).size;
}

// ── Simple KV (dedup / cooldown) ────────────────────────────

function setKey(key, value, ttlSeconds) {
  kvStore.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
}

function getKey(key) {
  const item = kvStore.get(key);
  if (!item) return null;
  if (Date.now() > item.expires) { kvStore.delete(key); return null; }
  return item.value;
}

function deleteKey(key) {
  kvStore.delete(key);
}

// Periodic cleanup every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of kvStore) {
    if (now > v.expires) kvStore.delete(k);
  }
}, 5 * 60 * 1000);

module.exports = { windowAdd, windowGet, windowCountUnique, setKey, getKey, deleteKey };
