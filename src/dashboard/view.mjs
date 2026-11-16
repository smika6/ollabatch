// Pure rendering helpers for the dashboard's machine inventory (no DOM, so
// they're unit-tested). Values an agent reports as null read "unknown".
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const HOLDING = new Set(['paused-by-owner', 'paused-in-use', 'outside-schedule', 'never']);
export const ownerHolds = (owner) => !!owner && HOLDING.has(owner.state);
export const ownerText = (owner) => `Paused on its PC: ${owner.reason || owner.state}`;

export function hardwareMeta(r) {
  const out = [];
  if (r.vramMB) out.push(`${Math.round(r.vramMB / 1024)} GB`);
  out.push(r.freeMB == null ? 'free memory unknown' : `${(r.freeMB / 1024).toFixed(1)} GB free`);
  out.push(r.tempC == null ? 'temperature unknown' : `${r.tempC}°C`);
  out.push(r.powerW == null ? 'power unknown' : `${Math.round(r.powerW)} W`);
  if (r.slots) out.push(`${r.slots} at once${r.tuning ? `, ${r.tuning}` : ''}`);
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
  if (d) s += ` Downloading ${d.model}, ${Math.round((100 * d.completed) / (d.total || 1))}%.`;
  return s;
}
