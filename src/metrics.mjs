// Per-minute counters per card and per job, for the dashboard graphs.
const MIN = 60_000;

export class Metrics {
  constructor({ now = Date.now, minutes = 1440 } = {}) {
    this.now = now;
    this.minutes = minutes;
    this.buckets = []; // [{ t, card: { id: {done, failed, ms} }, job: { ... } }], oldest first
  }

  record({ cardId, jobId, ok, ms }) {
    const t = Math.floor(this.now() / MIN) * MIN;
    let b = this.buckets.at(-1);
    if (!b || b.t !== t) {
      b = { t, card: {}, job: {} };
      this.buckets.push(b);
      const cutoff = t - this.minutes * MIN;
      while (this.buckets.length && this.buckets[0].t <= cutoff) this.buckets.shift();
    }
    for (const [kind, id] of [['card', cardId], ['job', jobId]]) {
      const c = (b[kind][id] ??= { done: 0, failed: 0, ms: 0 });
      if (ok) c.done++; else c.failed++;
      c.ms += ms;
    }
  }

  series({ by = 'card', minutes = 60 } = {}) {
    const t0 = Math.floor(this.now() / MIN) * MIN - (minutes - 1) * MIN;
    const rows = {};
    for (const b of this.buckets) {
      const i = (b.t - t0) / MIN;
      if (i < 0 || i >= minutes) continue;
      for (const [id, c] of Object.entries(b[by])) {
        const r = (rows[id] ??= { done: Array(minutes).fill(0), failed: Array(minutes).fill(0), avgMs: Array(minutes).fill(0) });
        r.done[i] = c.done;
        r.failed[i] = c.failed;
        r.avgMs[i] = Math.round(c.ms / (c.done + c.failed));
      }
    }
    return { t0, step: MIN, rows };
  }

  toJSON() { return { minutes: this.minutes, buckets: this.buckets }; }

  static fromJSON(obj, { now } = {}) {
    const m = new Metrics({ now, minutes: obj?.minutes || 1440 });
    m.buckets = obj?.buckets || [];
    return m;
  }
}
