// Job progress, rates and ETAs. Jobs report "done/total" on stdout or by POST;
// the rate is an EMA over samples at least 5 s apart so a burst of lines
// doesn't swing the ETA.

export const DEFAULT_PROGRESS = /(\d[\d,]*)\s*\/\s*(\d[\d,]*)/;
const MIN_GAP_MS = 5_000;
const ALPHA = 0.3;
const num = (s) => Number(String(s).replace(/,/g, ''));

export function parseProgress(line, pattern = DEFAULT_PROGRESS) {
  const m = line.match(pattern);
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  const done = num(m[1]), total = num(m[2]);
  return Number.isFinite(done) && Number.isFinite(total) ? { done, total } : null;
}

export function advance(progress, sample, now) {
  const p = { ...progress, done: sample.done };
  if (sample.total != null) p.total = sample.total;
  if (p.at == null) return { ...p, at: now, atDone: sample.done };
  // Done went down: the job started its next pass; old speed no longer applies.
  if (sample.done < progress.done) return { ...p, rate: 0, at: now, atDone: sample.done };
  const gap = now - p.at;
  if (gap < MIN_GAP_MS) return p;
  const inst = (sample.done - p.atDone) / (gap / 1000);
  return { ...p, rate: p.rate ? ALPHA * inst + (1 - ALPHA) * p.rate : inst, at: now, atDone: sample.done };
}

export function etaSeconds(progress) {
  if (progress.total == null || !progress.rate) return null;
  return Math.max(0, progress.total - progress.done) / progress.rate;
}

// Running jobs use their own ETA; queued ones use their total (or the
// template's estimate) at the current job's speed. Anything else is counted
// as unknown instead of guessed.
export function queueEta(jobs) {
  const running = jobs.filter((j) => j.status === 'running');
  const refRate = running.findLast((j) => j.progress.rate > 0)?.progress.rate || 0;
  let seconds = 0, unknown = 0;
  for (const j of jobs) {
    if (j.status === 'running') {
      const eta = etaSeconds(j.progress);
      if (eta == null) unknown++; else seconds += eta;
    } else if (j.status === 'queued') {
      const size = j.progress.total ?? j.estimate;
      if (size == null || !refRate) unknown++; else seconds += size / refRate;
    }
  }
  return { seconds, unknown };
}
