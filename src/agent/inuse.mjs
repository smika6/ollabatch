// Which cards a fullscreen program is using (Windows), from the sampler's
// lines (fullscreen.ps1). Only a fullscreen program counts, so a card that
// drives the monitors keeps lending while its owner browses or watches video
// in a window.
import path from 'node:path';
import { spawn as spawnChild } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fullscreen.ps1');
const SHELL_CLASSES = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd']);
const SHELL_EXES = new Set(['explorer', 'lockapp', 'searchhost', 'startmenuexperiencehost', 'shellexperiencehost']);
const norm = (s) => String(s || '').toLowerCase().replace(/\((r|tm)\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

export function startWatcher({ spawn = spawnChild, onSample, platform = process.platform } = {}) {
  if (platform !== 'win32') return { supported: false, stop() {} };
  const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], { windowsHide: true });
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const l of lines) { try { if (l.trim()) onSample(JSON.parse(l)); } catch { /* skip a torn line */ } }
  });
  child.on('error', () => {});
  return { supported: true, stop() { try { child.kill(); } catch { /* gone */ } } };
}

function descendants(procs, root) {
  const out = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of procs || []) if (out.has(p.ppid) && !out.has(p.pid)) { out.add(p.pid); grew = true; }
  }
  return out;
}

// serverPids: cardId → pid of that card's `ollama serve`. Its model runs in a child process.
export function ownPids(sample, serverPids) {
  const all = new Set();
  for (const pid of Object.values(serverPids)) for (const p of descendants(sample.procs, pid)) all.add(p);
  return all;
}

export function learnLuids(sample, serverPids) {
  const out = {};
  for (const [cardId, pid] of Object.entries(serverPids)) {
    const mine = descendants(sample.procs, pid);
    const row = (sample.engines || []).filter((e) => mine.has(e.pid) && e.util > 0).sort((a, b) => b.util - a.util)[0];
    if (row) out[cardId] = row.luid;
  }
  return out;
}

// A card's adapter is learned only while its own server shows GPU work; a
// paused or idle card shows none, so what was learned must be remembered.
export function rememberLuids(remembered, learned) {
  return { ...remembered, ...learned };
}

// Per adapter, from one sample: use % the way Task Manager shows it (the
// busiest engine type, summed over processes) and dedicated memory in use.
export function adapterStats(sample) {
  const out = {};
  const byType = {};
  for (const e of sample?.engines || []) {
    const k = `${String(e.luid).toLowerCase()}|${e.engtype}`;
    byType[k] = (byType[k] || 0) + (Number(e.util) || 0);
  }
  for (const [k, v] of Object.entries(byType)) {
    const luid = k.split('|')[0];
    (out[luid] ??= { util: 0, usedBytes: null }).util = Math.min(100, Math.max(out[luid].util, Math.round(v)));
  }
  for (const m of sample?.mem || []) {
    const o = (out[String(m.luid).toLowerCase()] ??= { util: 0, usedBytes: null });
    o.usedBytes = (o.usedBytes || 0) + (Number(m.bytes) || 0);
  }
  return out;
}

export function cardsInUse(sample, { luids, ownPids: own, cards }) {
  const f = sample.fg;
  const used = new Set();
  if (!f || !f.fullscreen || own.has(f.pid)) return used;
  if (SHELL_CLASSES.has(f.cls) || SHELL_EXES.has(String(f.exe).toLowerCase())) return used;
  const byLuid = Object.fromEntries(Object.entries(luids).map(([card, luid]) => [luid, card]));
  const rows = (sample.engines || []).filter((e) => e.pid === f.pid && e.util > 0);
  for (const e of rows) if (byLuid[e.luid]) used.add(byLuid[e.luid]);
  // The monitor's card only when the program shows no GPU work at all: work on
  // an adapter we can't name is not evidence about the monitor's card.
  if (!rows.length && f.adapter) {
    const card = cards.find((c) => norm(c.name) === norm(f.adapter));
    if (card) used.add(card.id);
  }
  return used;
}
