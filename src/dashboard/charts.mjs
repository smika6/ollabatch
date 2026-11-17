// Inline-SVG charts as strings (no DOM, unit-tested). A null value is
// "unknown": lines break there and nothing is drawn, never a drop to 0.
import { esc } from './view.mjs';

const fmt = (v) => (v >= 1e6 ? `${+(v / 1e6).toFixed(1)}M` : v >= 1e4 ? `${Math.round(v / 1e3)}k` : v >= 10 ? v.toFixed(0) : String(+v.toFixed(v >= 1 ? 1 : 2)));
const pad2 = (n) => String(n).padStart(2, '0');
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Fold a long series into at most `max` buckets: 'sum' for counts, 'mean'
// for rates and levels (ignoring unknowns), 'max' for peaks.
export function fold(values, max, mode = 'sum') {
  if (values.length <= max) return values.slice();
  const k = Math.ceil(values.length / max), out = [];
  for (let i = 0; i < values.length; i += k) {
    const part = values.slice(i, i + k), known = part.filter((v) => v != null);
    if (!known.length) { out.push(null); continue; }
    if (mode === 'max') out.push(Math.max(...known));
    else if (mode === 'mean') out.push(known.reduce((s, v) => s + v, 0) / known.length);
    else out.push(known.reduce((s, v) => s + v, 0));
  }
  return out;
}

// Clock labels for a time axis: "14:05" within a day, "Mon 14:00" beyond.
export function timeLabel(t, step) {
  const d = new Date(t);
  return step >= 3_600_000 ? `${DAYS[d.getDay()]} ${pad2(d.getHours())}:00` : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

const segments = (pts) => {
  const out = [];
  let cur = [];
  for (const p of pts) { if (p) cur.push(p); else if (cur.length) { out.push(cur); cur = []; } }
  if (cur.length) out.push(cur);
  return out;
};

// series: [{ label, color, values, dash? }]; kind: 'line' | 'area' | 'bars'.
// t0/step: the first bucket's time and the bucket size, for the time axis.
export function chartSvg({ w = 600, h = 180, series = [], kind = 'line', stacked = kind !== 'line', unit = '', max = null, t0 = null, step = null }) {
  const pad = { l: 40, r: 8, t: 8, b: 18 };
  const n = Math.max(0, ...series.map((s) => s.values.length));
  const sums = Array.from({ length: n }, (_, i) => series.reduce((s, x) => s + (x.values[i] ?? 0), 0));
  const top = max ?? Math.max(1e-9, ...(stacked ? sums : series.flatMap((s) => s.values.filter((v) => v != null))));
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const x = (i) => pad.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v) => h - pad.b - (Math.min(v, top) / top) * ih;
  let out = `<line class="grid" x1="${pad.l}" x2="${w - pad.r}" y1="${y(0)}" y2="${y(0)}"/><line class="grid" x1="${pad.l}" x2="${w - pad.r}" y1="${y(top)}" y2="${y(top)}"/>`;
  out += `<text x="4" y="${y(top) + 4}">${esc(fmt(top))}${esc(unit)}</text><text x="4" y="${y(0)}">0</text>`;
  if (t0 != null && step && n) {
    out += `<text x="${pad.l}" y="${h - 3}">${esc(timeLabel(t0, step))}</text>`;
    if (n > 4) out += `<text x="${x(Math.floor((n - 1) / 2))}" y="${h - 3}" text-anchor="middle">${esc(timeLabel(t0 + Math.floor((n - 1) / 2) * step, step))}</text>`;
    out += `<text x="${w - pad.r}" y="${h - 3}" text-anchor="end">now</text>`;
  }
  if (!n) return out;
  const base = Array(n).fill(0);
  const bw = Math.max(1, (iw / n) * 0.8);
  series.forEach((s, k) => {
    const color = s.color;
    const title = `<title>${esc(s.label)}</title>`;
    if (kind === 'bars') {
      let rects = '';
      s.values.forEach((v, i) => {
        if (!v) return;
        const b0 = stacked ? base[i] : 0;
        const bx = n === 1 ? pad.l + iw / 2 - bw / 2 : x(i) - bw / 2 + (stacked ? 0 : (k - (series.length - 1) / 2) * (bw / series.length));
        const wid = stacked ? bw : bw / series.length;
        rects += `<rect x="${bx.toFixed(1)}" y="${y(b0 + v).toFixed(1)}" width="${wid.toFixed(1)}" height="${Math.max(0.5, y(b0) - y(b0 + v)).toFixed(1)}"/>`;
        if (stacked) base[i] += v;
      });
      out += `<g fill="${color}">${title}${rects}</g>`;
    } else if (kind === 'area') {
      const tops = s.values.map((v, i) => base[i] + (v ?? 0));
      const line = tops.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
      const floor = base.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).reverse().join(' ');
      out += `<polygon points="${line} ${floor}" fill="${color}" fill-opacity=".55" stroke="${color}" stroke-width="1">${title}</polygon>`;
      tops.forEach((v, i) => { base[i] = v; });
    } else {
      const pts = s.values.map((v, i) => (v == null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`));
      for (const seg of segments(pts)) {
        out += seg.length === 1
          ? `<circle cx="${seg[0].split(',')[0]}" cy="${seg[0].split(',')[1]}" r="1.8" fill="${color}">${title}</circle>`
          : `<polyline points="${seg.join(' ')}" fill="none" stroke="${color}" stroke-width="1.6"${s.dash ? ' stroke-dasharray="4 3"' : ''}>${title}</polyline>`;
      }
    }
  });
  return out;
}

// A tiny line for a card's bay: no axes, gaps for unknowns, a dot on the latest value.
export function sparkSvg(values, { w = 110, h = 26, max = null, color = 'currentColor' } = {}) {
  const known = values.filter((v) => v != null);
  if (!known.length) return '';
  const top = max ?? Math.max(1e-9, ...known);
  const x = (i) => 1 + (values.length <= 1 ? (w - 2) / 2 : (i / (values.length - 1)) * (w - 2));
  const y = (v) => h - 2 - (Math.min(v, top) / top) * (h - 4);
  const pts = values.map((v, i) => (v == null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`));
  let out = segments(pts).map((seg) => `<polyline points="${seg.join(' ')}" fill="none" stroke="${color}" stroke-width="1.3"/>`).join('');
  const last = values.map((v, i) => [v, i]).filter(([v]) => v != null).at(-1);
  out += `<circle cx="${x(last[1]).toFixed(1)}" cy="${y(last[0]).toFixed(1)}" r="2" fill="${color}"/>`;
  return out;
}

// Model loads per card as marks on a shared timeline; bigger marks for more loads.
export function markerRowsSvg({ w = 600, rows = [], t0 = null, step = null, color = 'currentColor' }) {
  const pad = { l: 150, r: 8 }, rowH = 22;
  const h = rows.length * rowH + 18;
  const n = Math.max(1, ...rows.map((r) => r.values.length));
  const x = (i) => pad.l + (n <= 1 ? 0 : (i / (n - 1)) * (w - pad.l - pad.r));
  let out = '';
  rows.forEach((r, k) => {
    const cy = k * rowH + rowH / 2;
    out += `<text x="4" y="${cy + 4}">${esc(r.label.length > 22 ? `${r.label.slice(0, 21)}…` : r.label)}</text>`;
    out += `<line class="grid" x1="${pad.l}" x2="${w - pad.r}" y1="${cy}" y2="${cy}"/>`;
    r.values.forEach((v, i) => {
      if (!v) return;
      out += `<circle cx="${x(i).toFixed(1)}" cy="${cy}" r="${Math.min(8, 2.5 + v).toFixed(1)}" fill="${color}" fill-opacity=".75"><title>${v} load${v === 1 ? '' : 's'}</title></circle>`;
    });
  });
  if (t0 != null && step) {
    out += `<text x="${pad.l}" y="${h - 3}">${esc(timeLabel(t0, step))}</text><text x="${w - pad.r}" y="${h - 3}" text-anchor="end">now</text>`;
  }
  return { h, inner: out };
}
