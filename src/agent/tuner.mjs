// How many requests a card runs at once, found by measuring instead of
// guessing from memory sizes. Climb one slot at a time while it pays (>= 10%
// more items/s) and free VRAM stays above the margin; keep watching after,
// because a card can be fine for minutes and then slow down when memory gets
// tight. The agent applies each change by restarting the card's server.

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const WINDOW_COUNT = 20;          // completions, or
const WINDOW_MS = 3 * MIN;        // busy time, whichever comes first
const MIN_COUNT = 5;              // a window with fewer completions is discarded, never judged
const GAIN = 0.10;
const SLOW = 0.5;
const SLOW_FOR_MS = 3 * MIN;
const DOWN_COOLDOWN_MS = MIN;     // let a restarted server settle before judging it again
const RETRY_UP_MS = 15 * MIN;
const SAVED_FOR_MS = 7 * DAY;

export class SlotTuner {
  constructor({ now = Date.now, saved = null, ollamaVersion = null, maxSlots = 8 } = {}) {
    this.now = now;
    this.version = ollamaVersion;
    this.maxSlots = maxSlots;
    this.rates = {};          // slots → measured items/s
    this.history = [];        // [t, completed] for the slowdown check
    this.lastDown = -Infinity;
    this.slowSince = null;
    this.rebase = true;
    const fresh = saved && saved.ollamaVersion === ollamaVersion && now() - saved.measuredAt < SAVED_FOR_MS;
    if (fresh) {
      Object.assign(this, { slots: saved.slots, tunedSlots: saved.slots, tunedRate: saved.ratePerSec, measuredAt: saved.measuredAt, phase: 'settled' });
    } else {
      Object.assign(this, { slots: 1, tunedSlots: null, tunedRate: null, measuredAt: null, phase: 'measuring' });
    }
  }

  applied(slots) { this.slots = slots; }

  // A restart (slot change, crash) starts a fresh measurement; it is never a slowdown.
  onRestart() { this.rebase = true; this.slowSince = null; this.history = []; }

  observe({ completed, oomErrors, freeMB, totalMB, queued }) {
    const now = this.now();
    if (this.rebase) {
      Object.assign(this, { rebase: false, base: completed, oomBase: oomErrors, busyMs: 0, lastObs: now });
      this.history = [[now, completed]];
      return null;
    }
    // Only time with work in flight counts toward a measurement: an idle or
    // paused card would otherwise "measure" 0 items/s and climb or settle on it.
    if (queued) this.busyMs += now - this.lastObs;
    this.lastObs = now;
    if (oomErrors > this.oomBase) {
      this.oomBase = oomErrors;
      return this.#down(now, { cap: true });
    }
    const margin = Math.max(1024, 0.1 * totalMB);
    const lowVram = freeMB != null && freeMB < margin;
    if (lowVram && this.slots > 1 && now - this.lastDown >= DOWN_COOLDOWN_MS) return this.#down(now, { cap: this.phase === 'measuring' });

    if (this.phase === 'measuring') {
      const n = completed - this.base, elapsed = this.busyMs;
      if (n < WINDOW_COUNT && elapsed < WINDOW_MS) return null;
      if (n < MIN_COUNT || elapsed <= 0) {   // too little to judge: start the window over
        Object.assign(this, { base: completed, busyMs: 0 });
        return null;
      }
      const rate = n / (elapsed / 1000);
      this.rates[this.slots] = rate;
      const prev = this.rates[this.slots - 1];
      if (prev != null && rate < prev * (1 + GAIN)) return this.#settle(this.slots - 1, prev, now, true);
      if (this.slots < this.maxSlots && !lowVram) return this.#set(this.slots + 1);
      return this.#settle(this.slots, rate, now, false);
    }

    this.history.push([now, completed]);
    while (this.history.length > 1 && now - this.history[1][0] >= MIN) this.history.shift();
    const [t0, c0] = this.history[0];
    const recent = now > t0 ? (completed - c0) / ((now - t0) / 1000) : null;
    if (queued && this.tunedRate && recent != null && now - t0 >= MIN / 2 && recent < SLOW * this.tunedRate) {
      this.slowSince ??= now;
      if (now - this.slowSince >= SLOW_FOR_MS) return this.#down(now, { cap: false });
    } else {
      this.slowSince = null;
    }

    if (this.phase === 'backoff' && now - this.lastDown >= RETRY_UP_MS && this.slots < this.tunedSlots && !lowVram) {
      if (this.slots + 1 === this.tunedSlots) this.phase = 'settled';
      return this.#set(this.slots + 1);
    }
    return null;
  }

  toJSON() {
    return { slots: this.tunedSlots ?? this.slots, ratePerSec: this.tunedRate, measuredAt: this.measuredAt, ollamaVersion: this.version };
  }

  #set(slots) { this.slots = slots; return { setSlots: slots }; }

  #settle(slots, rate, now, change) {
    Object.assign(this, { phase: 'settled', tunedSlots: slots, tunedRate: rate, measuredAt: now });
    return change ? this.#set(slots) : null;
  }

  // cap: the lower count becomes the tuned one (out of memory, or a climb that didn't fit).
  #down(now, { cap }) {
    if (this.slots <= 1) return null;
    const to = this.slots - 1;
    this.lastDown = now;
    this.slowSince = null;
    if (this.phase === 'measuring' || cap) {
      Object.assign(this, { phase: 'settled', tunedSlots: to, tunedRate: this.rates[to] ?? this.tunedRate, measuredAt: now });
    } else {
      this.phase = 'backoff';
    }
    return this.#set(to);
  }
}
