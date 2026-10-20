// Counts remain rolling-window counts. Remember reached milestones across window
// dips and restarts; reset only after a full hour without qualifying activity.
function progress(previous, count, initial, now = Date.now(), quietMs = 3600000, total) {
  const old = previous && now - previous.at < quietMs ? previous : { stage: 0 };
  const stage = count < initial ? 0 : count < 10 ? 1 : Math.floor(count / 10) + 1;
  const valued = Number.isFinite(total) && total > 0;
  const doubled = count >= initial && valued && old.alertedTotal > 0 && total >= old.alertedTotal * 2;
  const notify = stage > old.stage || doubled;
  return { notify, state: { at: now, stage: Math.max(stage, old.stage),
    alertedTotal: notify && valued ? total : old.alertedTotal } };
}
function makeProgress({ getKey, setKey }) {
  return (key, count, initial, total) => {
    const id = `alert-progress:${key}`, result = progress(getKey(id), count, initial, Date.now(), 3600000, total);
    setKey(id, result.state, 3600);
    return result.notify;
  };
}
module.exports = { progress, makeProgress };
