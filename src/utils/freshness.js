// Use event time, not discovery time, when deciding whether an alert is live.
const minutes = Number(process.env.ALERT_MAX_AGE_MIN || 30);
if (!Number.isFinite(minutes) || minutes <= 0) throw Error('Invalid ALERT_MAX_AGE_MIN');
const MAX_AGE_MS = minutes * 60000;
const cutoff = (now = Date.now()) => now - MAX_AGE_MS;
const isFresh = (at, now = Date.now()) => Number.isFinite(at) && at > 0 && at >= cutoff(now);
const freshAlert = (alert, now = Date.now(), queuedAt) => isFresh(alert.eventAt ?? queuedAt, now);

module.exports = { MAX_AGE_MS, cutoff, isFresh, freshAlert };
