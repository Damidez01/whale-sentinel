// Pure in-memory sliding window store
// Keyed time-sorted lists for burst/pattern detection

const windows = new Map(); // key -> [{value, ts}]
const kvStore  = new Map(); // key -> {value, expires}

// ── Sliding window ──────────────────────────────────────────

function _clean(key, windowMs) {
  const now   = Date.now();
  const items = (windows.get(key) || []).filter(i => now - i.ts < windowMs);
  windows.set(key, items);
  return items;
}

/** Add entry, return current count in window */
function windowAdd(key, value, windowSeconds) {
  const items = _clean(key, windowSeconds * 1000);
  items.push({ value, ts: Date.now() });
  windows.set(key, items);
  return items.length;
}

/** Get all values currently in window */
function windowGet(key, windowSeconds) {
  return _clean(key, windowSeconds * 1000).map(i => i.value);
}

/** Count unique values in window */
function windowCountUnique(key, windowSeconds) {
  const items = _clean(key, windowSeconds * 1000);
  return new Set(items.map(i => i.value)).size;
}

// ── Simple KV (dedup / cooldown) ───────────────────────────

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
