const fs   = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const DATA_FILE = path.join(__dirname, '../../data/flagged.json');
const FLAG_TC_MS  = (Number(process.env.FLAG_TC_HOURS  || 48)) * 3600_000;
const FLAG_HOP_MS = (Number(process.env.FLAG_HOP_HOURS || 24)) * 3600_000;

// In-memory registry: address -> { reason, source, flaggedAt, expiresAt }
let registry = {};

// ── Persistence ─────────────────────────────────────────────

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      registry = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      // Prune expired on load
      const now = Date.now();
      for (const addr of Object.keys(registry)) {
        if (registry[addr].expiresAt < now) delete registry[addr];
      }
      logger.info(`[Flagged] Loaded ${Object.keys(registry).length} flagged wallets from disk`);
    }
  } catch (err) {
    logger.error('[Flagged] Failed to load registry', { error: err.message });
    registry = {};
  }
}

function save() {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(registry, null, 2));
  } catch (err) {
    logger.error('[Flagged] Failed to save registry', { error: err.message });
  }
}

// ── Public API ───────────────────────────────────────────────

function flag(address, reason, source, ttlMs = FLAG_TC_MS) {
  const addr = address?.toLowerCase();
  if (!addr) return;

  const now = Date.now();
  registry[addr] = {
    reason,
    source,
    flaggedAt: now,
    expiresAt: now + ttlMs,
  };

  logger.warn(`[Flagged] Wallet flagged: ${addr.slice(0, 10)}... reason=${reason}`);
  save();
}

function flagHop(address, sourceAddress) {
  flag(address, 'TC_HOP', sourceAddress, FLAG_HOP_MS);
}

function isFlagged(address) {
  const addr = address?.toLowerCase();
  if (!addr) return null;

  const entry = registry[addr];
  if (!entry) return null;

  if (Date.now() > entry.expiresAt) {
    delete registry[addr];
    save();
    return null;
  }

  return entry; // { reason, source, flaggedAt, expiresAt }
}

function getFlaggedCount() {
  const now = Date.now();
  return Object.values(registry).filter(e => e.expiresAt > now).length;
}

function shortAddr(addr) {
  if (!addr) return '???';
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

// Load on startup
load();

// Auto-save every 5 min
setInterval(save, 5 * 60_000);

module.exports = { flag, flagHop, isFlagged, getFlaggedCount, shortAddr };
