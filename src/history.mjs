// Job history: what each job did (per-card requests, tokens, retries, model
// loads), how to find it again, and how long it is kept.
import fs from 'node:fs';

const FINISHED = new Set(['done', 'failed', 'cancelled']);
const DAY = 24 * 60 * 60_000;

const emptyStats = () => ({ requests: 0, failed: 0, retried: 0, promptTokens: 0, outputTokens: 0, genSec: 0, loads: 0, loadSec: 0, cards: {}, lastErrors: [] });

export function addRequestToJob(job, { card, cardLabel, ok, retried, stats, error }) {
  const s = (job.stats ??= emptyStats());
  s.requests++;
  if (!ok) s.failed++;
  if (retried) s.retried++;
  const c = (s.cards[card] ??= { label: cardLabel || card, requests: 0, outputTokens: 0 });
  c.requests++;
  if (stats) {
    s.promptTokens += stats.promptTokens || 0;
    s.outputTokens += stats.outputTokens || 0;
    c.outputTokens += stats.outputTokens || 0;
    s.genSec = +(s.genSec + (stats.genSec || 0)).toFixed(3);
    if (stats.loaded) { s.loads++; s.loadSec = +(s.loadSec + (stats.loadSec || 0)).toFixed(3); }
    if (stats.model) { job.modelsUsed ??= []; if (!job.modelsUsed.includes(stats.model)) job.modelsUsed.push(stats.model); }
  }
  if (!ok && error) s.lastErrors = [...s.lastErrors, `${cardLabel || card}: ${String(error).slice(0, 200)}`].slice(-5);
}

// Ids of finished jobs to forget: beyond the newest `maxJobs`, or older than
// `maxAgeMs`. Queued, running and paused jobs are never touched.
export function prune({ jobs, now, maxJobs = 2000, maxAgeMs = 90 * DAY }) {
  const done = jobs.filter((j) => FINISHED.has(j.status)).sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
  return done.filter((j, i) => i >= maxJobs || now - (j.finishedAt || 0) > maxAgeMs).map((j) => j.id);
}

export function trimLog(file, maxBytes = 20 * 1024 * 1024) {
  let size;
  try { size = fs.statSync(file).size; } catch { return; }
  if (size <= maxBytes) return;
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(maxBytes);
  fs.readSync(fd, buf, 0, maxBytes, size - maxBytes);
  fs.closeSync(fd);
  fs.writeFileSync(file, buf);
}

export function filterHistory(jobs, { q, status, template, from, to, limit = 50, before } = {}) {
  const needle = q ? String(q).toLowerCase() : null;
  let list = jobs.filter((j) => FINISHED.has(j.status))
    .filter((j) => !needle || [j.name, j.template, j.id, j.model, ...(j.modelsUsed || []), j.summary?.text, j.notes].some((x) => String(x ?? '').toLowerCase().includes(needle)))
    .filter((j) => !status || j.status === status)
    .filter((j) => !template || j.template === template)
    .filter((j) => from == null || (j.finishedAt || 0) >= Number(from))
    .filter((j) => to == null || (j.finishedAt || 0) <= Number(to))
    .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
  if (before) { const i = list.findIndex((j) => j.id === before); list = i < 0 ? [] : list.slice(i + 1); }
  const page = list.slice(0, Math.max(1, Number(limit) || 50));
  return { jobs: page, next: list.length > page.length ? page.at(-1).id : null };
}

const CSV_COLUMNS = ['id', 'name', 'status', 'template', 'model', 'started', 'finished', 'durationSec', 'exitCode', 'done', 'total', 'requests', 'failed', 'outputTokens'];
const cell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const iso = (t) => (t ? new Date(t).toISOString() : '');

export function toCsv(jobs) {
  const rows = jobs.map((j) => [j.id, j.name, j.status, j.template, j.model, iso(j.startedAt), iso(j.finishedAt),
    j.startedAt && j.finishedAt ? Math.round((j.finishedAt - j.startedAt) / 1000) : '', j.exitCode,
    j.progress?.done, j.progress?.total, j.stats?.requests, j.stats?.failed, j.stats?.outputTokens].map(cell).join(','));
  return [CSV_COLUMNS.join(','), ...rows].join('\n') + '\n';
}

// Per-minute "done" counts over a job's life, for its progress graph.
export function timelineAdd(tl, done, now) {
  const step = 60_000;
  const t = Math.floor(now / step) * step;
  if (!tl.t0) { tl.t0 = t; tl.step = step; tl.done = []; }
  const i = Math.round((t - tl.t0) / step);
  if (i >= 1440 * 7) return tl;   // a week of minutes is plenty for a graph
  for (let k = tl.done.length; k < i; k++) tl.done[k] = tl.done[k - 1] ?? 0;
  tl.done[i] = done;
  return tl;
}
