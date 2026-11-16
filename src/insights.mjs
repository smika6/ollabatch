// Inference and machine insights over time: per-minute buckets for the last
// 24 h, rolled up into hours for 30 days. Every completed request is recorded
// per card, per model and per job; agents' reports add per-card samples.
const MIN = 60_000, HOUR = 60 * MIN;
const RANGES = { '1h': [MIN, 60], '6h': [MIN, 360], '24h': [MIN, 1440], '7d': [HOUR, 168], '30d': [HOUR, 720] };
const KEEP = 200;   // wait/latency samples kept per bucket for percentiles

const emptyAgg = () => ({ requests: 0, failed: 0, retried: 0, promptTokens: 0, outputTokens: 0, genSec: 0, loads: 0, loadSec: 0, waits: [], lats: [] });
const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(p * s.length) - 1)];
};
function addTo(a, b) {
  for (const k of ['requests', 'failed', 'retried', 'promptTokens', 'outputTokens', 'genSec', 'loads', 'loadSec']) a[k] += b[k];
  a.waits = a.waits.concat(b.waits).slice(-KEEP);
  a.lats = a.lats.concat(b.lats).slice(-KEEP);
}
const point = (a) => ({ requests: a.requests, failed: a.failed, retried: a.retried, promptTokens: a.promptTokens, outputTokens: a.outputTokens,
  genSec: +a.genSec.toFixed(3), loads: a.loads, loadSec: +a.loadSec.toFixed(3),
  waitP50: pct(a.waits, 0.5), waitP90: pct(a.waits, 0.9), latP50: pct(a.lats, 0.5), latP90: pct(a.lats, 0.9) });

export class Insights {
  constructor({ now = Date.now, minutes = 1440, hours = 720 } = {}) {
    Object.assign(this, { clock: now, keepMinutes: minutes, keepHours: hours });
    this.minutes = [];   // [{ t, rows: { 'card:a': agg, ... }, cards: { a: sample } }], oldest first
    this.hours = [];
    this.lastModel = {};
  }

  #bucket() {
    const t = Math.floor(this.clock() / MIN) * MIN;
    let b = this.minutes.at(-1);
    if (!b || b.t !== t) {
      b = { t, rows: {}, cards: {} };
      this.minutes.push(b);
      this.#roll(t);
    }
    return b;
  }

  // Minutes older than the minute window fold into hour buckets.
  #roll(t) {
    while (this.minutes.length && this.minutes[0].t <= t - this.keepMinutes * MIN) {
      const m = this.minutes.shift();
      const ht = Math.floor(m.t / HOUR) * HOUR;
      let h = this.hours.find((x) => x.t === ht);
      if (!h) { h = { t: ht, rows: {}, cards: {} }; this.hours.push(h); this.hours.sort((x, y) => x.t - y.t); }
      for (const [k, a] of Object.entries(m.rows)) addTo((h.rows[k] ??= emptyAgg()), a);
      Object.assign(h.cards, m.cards);
    }
    while (this.hours.length && this.hours[0].t <= t - this.keepHours * HOUR) this.hours.shift();
  }

  record({ card, job, model, ok, retried, waitSec, latencySec, stats }) {
    const b = this.#bucket();
    const m = stats?.model || model || 'unknown';
    if (ok && stats?.model) this.lastModel[card] = stats.model;
    for (const key of [`card:${card}`, `model:${m}`, `job:${job}`]) {
      const a = (b.rows[key] ??= emptyAgg());
      a.requests++;
      if (!ok) a.failed++;
      if (retried) a.retried++;
      if (stats) {
        a.promptTokens += stats.promptTokens || 0;
        a.outputTokens += stats.outputTokens || 0;
        a.genSec += stats.genSec || 0;
        if (stats.loaded) { a.loads++; a.loadSec += stats.loadSec || 0; }
      }
      if (waitSec != null && a.waits.length < KEEP) a.waits.push(+waitSec.toFixed(3));
      if (latencySec != null && a.lats.length < KEEP) a.lats.push(+latencySec.toFixed(3));
    }
  }

  sampleCard(cardId, sample) { this.#bucket().cards[cardId] = { ...sample }; }

  #window(range) {
    const [step, count] = RANGES[range] || RANGES['1h'];
    const t0 = Math.floor(this.clock() / step) * step - (count - 1) * step;
    return { step, count, t0 };
  }

  // Minute and hour buckets that fall in the window, grouped by its step.
  #grouped(range) {
    const { step, count, t0 } = this.#window(range);
    const slots = Array.from({ length: count }, () => ({ rows: {}, cards: {} }));
    for (const b of step === HOUR ? [...this.hours, ...this.minutes] : this.minutes) {
      const i = Math.floor((b.t - t0) / step);
      if (i < 0 || i >= count) continue;
      for (const [k, a] of Object.entries(b.rows)) addTo((slots[i].rows[k] ??= emptyAgg()), a);
      Object.assign(slots[i].cards, b.cards);
    }
    return { step, t0, slots };
  }

  series({ by = 'card', range = '1h' } = {}) {
    const { step, t0, slots } = this.#grouped(range);
    const ids = new Set(slots.flatMap((s) => Object.keys(s.rows)).filter((k) => k.startsWith(`${by}:`)).map((k) => k.slice(by.length + 1)));
    const rows = {};
    for (const id of ids) rows[id] = slots.map((s) => point(s.rows[`${by}:${id}`] || emptyAgg()));
    return { t0, step, rows };
  }

  cardSeries(cardId, range = '1h') {
    return this.#grouped(range).slots.map((s) => s.cards[cardId] || null);
  }

  loadsLastHour(cardId) {
    const since = this.clock() - HOUR;
    return this.minutes.filter((b) => b.t > since).reduce((s, b) => s + (b.rows[`card:${cardId}`]?.loads || 0), 0);
  }

  now() {
    const since = this.clock() - MIN;
    const recent = this.minutes.filter((b) => b.t >= Math.floor(since / MIN) * MIN);
    const out = recent.reduce((s, b) => s + Object.entries(b.rows).filter(([k]) => k.startsWith('card:')).reduce((x, [, a]) => x + a.outputTokens, 0), 0);
    return { outputTokPerSec: +(out / 60).toFixed(2), loadedModels: { ...this.lastModel } };
  }

  toJSON() { return { minutes: this.minutes, hours: this.hours, lastModel: this.lastModel }; }

  static fromJSON(obj, opts = {}) {
    const i = new Insights(opts);
    Object.assign(i, { minutes: obj?.minutes || [], hours: obj?.hours || [], lastModel: obj?.lastModel || {} });
    return i;
  }
}
