// Pure rendering helpers for the dashboard (no DOM, so they're unit-tested).
// Values an agent reports as null read "unknown", never 0.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export const FINISHED = new Set(['done', 'failed', 'cancelled']);

const HOLDING = new Set(['paused-by-owner', 'paused-in-use', 'outside-schedule', 'never']);
export const ownerHolds = (owner) => !!owner && HOLDING.has(owner.state);
export const ownerText = (owner) => `Paused on its PC: ${owner.reason || owner.state}`;

// ── numbers and time ────────────────────────────────────────────────────────
export function dur(sec) {
  if (sec == null || !Number.isFinite(sec)) return '';
  if (sec < 60) return 'under a minute';
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}
export const rate = (r) => (r >= 10 ? r.toFixed(0) : r >= 1 ? r.toFixed(1) : r.toFixed(2));
export function big(n) {
  if (n == null || !Number.isFinite(n)) return 'unknown';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)} k`;
  return n.toLocaleString('en-US');
}
const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "around 03:40", "around 03:40 tomorrow", "around Thu 03:40".
export function clockAt(sec, now = Date.now()) {
  if (sec == null || !Number.isFinite(sec)) return '';
  const at = new Date(now + sec * 1000);
  const days = Math.round((new Date(at).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000);
  return `around ${days === 0 ? hhmm(at) : days === 1 ? `${hhmm(at)} tomorrow` : `${DAYS[at.getDay()]} ${hhmm(at)}`}`;
}
export const etaText = (sec, now) => (sec == null ? '' : `${dur(sec)} left, ${clockAt(sec, now)}`);

// When something happened, short: "14:05" today, "Mon 14:05" this week, else "3 Nov".
export function whenText(t, now = Date.now()) {
  if (!t) return '';
  const d = new Date(t);
  if (new Date(now).toDateString() === d.toDateString()) return hhmm(d);
  if (now - t < 6 * 86_400_000) return `${DAYS[d.getDay()]} ${hhmm(d)}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

// ── machines ────────────────────────────────────────────────────────────────
export function hardwareMeta(r) {
  const out = [];
  if (r.backend) out.push(r.backend);
  if (r.vramMB) out.push(`${Math.round(r.vramMB / 1024)} GB${r.vendor === 'apple' ? ' shared' : ''}`);
  out.push(r.freeMB == null ? 'free memory unknown' : `${(r.freeMB / 1024).toFixed(1)} GB free`);
  out.push(r.tempC == null ? 'temperature unknown' : `${r.tempC}°C`);
  out.push(r.util == null ? 'use unknown' : `${Math.round(r.util)}% use`);
  out.push(r.powerW == null ? 'power unknown' : `${Math.round(r.powerW)} W`);
  if (r.slots) out.push(`${r.slots} at once${r.fixedSlots && r.fixedSlots !== 'auto' ? ', fixed' : r.tuning ? `, ${r.tuning}` : ''}`);
  return out;
}

// A card its machine reports but isn't lending right now: shown, greyed, with why.
export function idleBayHtml(r) {
  return `<div class="bay idle-card">
    <div class="top1"><span class="label">${esc(r.name)}</span></div>
    <div class="meta">${hardwareMeta(r).map((m) => `<span>${esc(m)}</span>`).join('')}</div>
    <div class="note">${esc(r.reason || r.state)}</div>
  </div>`;
}

export function playgroundLine(report) {
  const pg = report?.playground;
  if (!pg) return '';
  const used = (pg.usedBytes / 1024 ** 3).toFixed(1);
  const locked = (pg.models || []).filter((m) => m.locked).length;
  const n = (pg.models || []).length;
  let s = `Models: ${used} of ${pg.limitGB} GB, ${n} model${n === 1 ? '' : 's'}${locked ? ` (${locked} locked)` : ''}.`;
  const d = report.download;
  if (d) s += d.total ? ` Downloading ${d.model}, ${Math.round((100 * d.completed) / d.total)}%.` : ` Downloading ${d.model}.`;
  return s;
}

// What a machine's agent says a remotely settable field is right now.
export function fieldValue(report, name) {
  if (!report) return undefined;
  if (name === 'policy') return report.policy;
  if (name === 'schedule') return report.schedule;
  if (name === 'playground.limitGB') return report.playground?.limitGB;
  if (name === 'playground.downloads') return report.playground?.downloads;
  if (name === 'locked') return (report.playground?.models || []).filter((m) => m.locked).map((m) => m.name).sort();
  const m = /^cards\.([\w-]+)\.(paused|disabled|slots)$/.exec(name);
  const c = m && (report.cards || []).find((x) => x.id === m[1]);
  if (!c) return undefined;
  return m[2] === 'slots' ? c.fixedSlots ?? 'auto' : !!c[m[2]];
}
const norm = (name, v) => {
  if (name === 'locked') return Array.isArray(v) ? [...new Set(v.map(String))].sort() : v;
  if (/\.slots$/.test(name)) return v == null || v === 'auto' ? 'auto' : Number(v);
  if (/\.(paused|disabled)$|downloads$/.test(name)) return !!v;
  if (name === 'playground.limitGB') return Math.max(1, Number(v));
  return v;
};

// Fields the dashboard set that the PC hasn't taken yet ('pending'), or that
// its owner changed back on the PC since ('override').
export function pendingFields(machine) {
  const out = {};
  const override = new Set(machine?.report?.localOverride || []);
  for (const [name, f] of Object.entries(machine?.desired?.fields || {})) {
    if (override.has(name)) out[name] = 'override';
    else if (JSON.stringify(fieldValue(machine.report, name)) !== JSON.stringify(norm(name, f.value))) out[name] = 'pending';
  }
  return out;
}
export const PENDING_TEXT = { pending: 'waiting for the PC', override: 'changed back on the PC' };

// Cards that switched models more than `limit` times in the last hour. Reloading
// the same model (a restart, the slot tuner trying a new count) isn't switching.
export const thrashing = (switchesLastHour, limit = 6) => Object.entries(switchesLastHour || {}).filter(([, n]) => n > limit).map(([id]) => id);
export const THRASH_TEXT = 'This card keeps switching models. Give its jobs one model, or a selector that keeps them on separate cards.';

const CMD_TEXT = { 'restart-card': 'restart', retune: 're-tune', pull: 'download', 'remove-model': 'remove' };
const CMD_STATE = { queued: 'waiting for the PC', done: 'done', failed: 'failed', rejected: 'refused by the PC', expired: 'expired, the PC never picked it up' };
export function commandText(c, cardName = (id) => id) {
  const what = `${CMD_TEXT[c.type] || c.type}${c.card ? ` ${cardName(c.card)}` : ''}${c.model ? ` ${c.model}` : ''}`;
  return `${what}: ${CMD_STATE[c.state] || c.state}${c.error && c.state !== 'done' ? ` (${c.error.replace(/^rejected:\s*/, '')})` : ''}`;
}

// ── jobs ────────────────────────────────────────────────────────────────────
export const ranFor = (j) => (j.startedAt != null && j.finishedAt != null ? (j.finishedAt - j.startedAt) / 1000 : null);
export function statusText(j) {
  if (j.status === 'failed') return j.reason ? `failed: ${j.reason}` : j.exitCode != null ? `failed, exit ${j.exitCode}` : 'failed';
  if (j.status === 'done') return j.exitCode != null ? `done, exit ${j.exitCode}` : 'done';
  return j.status;
}
export const modelsText = (j) => (j.modelsUsed?.length ? j.modelsUsed.join(', ') : j.model || (j.models || []).join(' or ') || '');
export const outTokPerSec = (s) => (s?.genSec > 0 ? s.outputTokens / s.genSec : null);
export const summaryLine = (j) => (j.summary?.text ? j.summary.text.split(/(?<=[.!?])\s/)[0].slice(0, 140) : '');

// Each card's share of a job's requests, biggest first.
export function cardShares(stats) {
  const list = Object.entries(stats?.cards || {}).map(([id, c]) => ({ id, label: c.label || id, requests: c.requests, outputTokens: c.outputTokens }));
  const total = list.reduce((s, c) => s + c.requests, 0) || 1;
  return list.map((c) => ({ ...c, pct: Math.round((100 * c.requests) / total) })).sort((a, b) => b.requests - a.requests);
}

export function historyRowHtml(j, now = Date.now()) {
  const s = j.stats || {};
  const cards = cardShares(s).map((c) => c.label);
  return `<tr class="${esc(j.status)}">
    <td class="name"><button class="linkish" data-job="${esc(j.id)}">${esc(j.name)}</button></td>
    <td><span class="state ${esc(j.status)}">${esc(statusText(j))}</span></td>
    <td>${esc(whenText(j.finishedAt, now))}</td>
    <td class="n">${esc(dur(ranFor(j)))}</td>
    <td class="n">${esc(j.progress?.done ? j.progress.done.toLocaleString('en-US') : '')}</td>
    <td>${esc(modelsText(j))}</td>
    <td>${esc(cards.length > 2 ? `${cards.slice(0, 2).join(', ')} +${cards.length - 2}` : cards.join(', '))}</td>
    <td class="n">${s.outputTokens ? esc(big(s.outputTokens)) : ''}</td>
    <td class="sum">${esc(summaryLine(j))}</td>
  </tr>`;
}

// Per-minute items from a job's cumulative progress timeline.
export function timelineRates(tl) {
  if (!tl?.done?.length) return [];
  return tl.done.map((v, i) => Math.max(0, v - (i ? tl.done[i - 1] : 0)));
}
