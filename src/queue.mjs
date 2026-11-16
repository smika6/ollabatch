// Request queue: every inference request a job makes waits here until a card
// (worker) pulls it. Pure — no HTTP — so the scheduling rules are unit-tested.
//
// Pull model: workers ask for work, so faster cards take more of it and a card
// can join or leave mid-run. The host injects two policies:
//   canServe(worker, jobId)  may this card run this job's requests (selector, models, pause)
//   rankOf(jobId)            lower runs first; follows the job queue order
//
// Reliability:
//   - a leased request whose worker goes quiet past `leaseMs` is re-queued;
//   - a worker failure (network error, 5xx, model missing) re-queues it,
//     preferring a card that hasn't failed it; after `maxAttempts` the client
//     gets the last error;
//   - any other 4xx is returned as-is — retrying won't help.

export class RequestQueue {
  constructor({ leaseMs = 600_000, maxAttempts = 4, now = Date.now, canServe = () => true, rankOf = () => 0 } = {}) {
    this.leaseMs = leaseMs;
    this.maxAttempts = maxAttempts;
    this.now = now;
    this.canServe = canServe;
    this.rankOf = rankOf;
    this.pending = [];          // requests waiting for a card, arrival order
    this.leased = new Map();    // requestId → request
    this.waiters = [];          // idle take() calls: { workerId, resolve, timer }
    this.workers = new Map();   // workerId → stats
    this.nextId = 1;
  }

  // ── client side ──────────────────────────────────────────────────────────
  // `signal`: the client went away (timed out, retried, exited) — drop the
  // request instead of running it on a GPU for nobody.
  enqueue({ jobId = '_', path, body, signal }) {
    return new Promise((resolve) => {
      const r = { id: String(this.nextId++), jobId, path, body, attempts: 0, triedBy: new Set(), resolve, enqueuedAt: this.now() };
      if (signal) {
        if (signal.aborted) return resolve({ status: 499, body: JSON.stringify({ error: 'client gone' }) });
        signal.addEventListener('abort', () => this.#abort(r), { once: true });
      }
      this.#offer(r);
    });
  }

  // Resolves every pending and leased request of a job (it exited or was
  // cancelled). Late results for them are refused by complete().
  dropJob(jobId, reason) {
    const done = { status: 499, body: JSON.stringify({ error: reason }) };
    let n = 0;
    this.pending = this.pending.filter((r) => (r.jobId === jobId ? (r.resolve(done), n++, false) : true));
    for (const r of [...this.leased.values()]) {
      if (r.jobId === jobId) { this.leased.delete(r.id); r.resolve(done); n++; }
    }
    return n;
  }

  // ── worker side ──────────────────────────────────────────────────────────
  register(id, { label = '', slots = 1, models = [], host = '', machine = '', labels = {} } = {}) {
    const w = this.workers.get(id) || { id, done: 0, failed: 0, emaMs: 0, recent: [], joinedAt: this.now(), paused: false, jobId: null };
    Object.assign(w, { label, slots: Math.max(1, Number(slots) || 1), models, host, machine, labels, lastSeen: this.now(), gone: false });
    this.workers.set(id, w);
    return w;
  }

  leave(id) {
    const w = this.workers.get(id);
    if (w) w.gone = true;
    this.#releaseWaiters(id);
    for (const r of [...this.leased.values()]) if (r.workerId === id) this.#requeue(r, 'worker left');
  }

  // Pause = hand this card no new requests (its owner wants the GPU back);
  // ones it already holds still finish.
  setPaused(id, paused) {
    const w = this.workers.get(id);
    if (!w) return false;
    w.paused = !!paused;
    if (w.paused) this.#releaseWaiters(id);
    else this.reoffer();
    return true;
  }

  isPaused(id) { return !!this.workers.get(id)?.paused; }

  // Resolves to a request leased to this worker, or null after `waitMs`.
  take(workerId, { waitMs = 25_000 } = {}) {
    const w = this.workers.get(workerId);
    if (w) w.lastSeen = this.now();
    if (w?.paused) return new Promise((resolve) => setTimeout(() => resolve(null), Math.min(waitMs, 5_000)));
    const r = this.#nextFor(workerId);
    if (r) return Promise.resolve(this.#lease(r, workerId));
    return new Promise((resolve) => {
      const waiter = { workerId, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== waiter);
        resolve(null);
      }, waitMs);
      this.waiters.push(waiter);
    });
  }

  // result: { status, body, contentType?, error? } — status 0 = network failure on the worker.
  complete(requestId, workerId, result) {
    const r = this.leased.get(requestId);
    if (!r || r.workerId !== workerId) return false; // expired, dropped, or re-leased elsewhere
    this.leased.delete(requestId);
    const w = this.workers.get(workerId);
    if (w) w.lastSeen = this.now();
    const ms = this.now() - r.leasedAt;
    const retryable = !result || result.status === 0 || result.status >= 500 || result.status === 404;
    if (!retryable) {
      if (w && result.status < 400) {
        w.done++;
        w.emaMs = w.emaMs ? w.emaMs * 0.8 + ms * 0.2 : ms;
        w.recent.push(this.now());
        if (w.recent.length > 300) w.recent.shift();
      }
      r.resolve(result.contentType
        ? { status: result.status, body: result.body, contentType: result.contentType }
        : { status: result.status, body: result.body });
      return true;
    }
    if (w) { w.failed++; w.lastError = String(result?.error || `HTTP ${result?.status}`).slice(0, 200); }
    if (r.attempts >= this.maxAttempts) {
      r.resolve({ status: 502, body: JSON.stringify({ error: `rigpool: gave up after ${r.attempts} attempts — last: ${w?.lastError || 'unknown'}` }) });
    } else {
      this.#requeue(r, w?.lastError);
    }
    return true;
  }

  // Call periodically: re-queue requests whose worker went quiet. Expiries
  // count as attempts, so a request no card can finish isn't re-run forever.
  expireLeases() {
    const cutoff = this.now() - this.leaseMs;
    for (const r of [...this.leased.values()]) {
      if (r.leasedAt >= cutoff) continue;
      if (r.attempts >= this.maxAttempts) {
        this.leased.delete(r.id);
        r.resolve({ status: 502, body: JSON.stringify({ error: `rigpool: gave up after ${r.attempts} attempts — last: lease expired` }) });
      } else {
        this.#requeue(r, 'lease expired');
      }
    }
  }

  // Re-match pending requests to idle waiters — after a job resumes, a label
  // changes, or anything else that widens canServe.
  reoffer() {
    for (const waiter of [...this.waiters]) {
      const r = this.#nextFor(waiter.workerId);
      if (!r) continue;
      this.waiters = this.waiters.filter((x) => x !== waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(this.#lease(r, waiter.workerId));
    }
  }

  // A card is active if it polled recently or is holding a request: one busy
  // on long generations doesn't poll, but it isn't gone.
  activeWorkers(windowMs = 90_000) {
    const since = this.now() - windowMs;
    const busy = new Set([...this.leased.values()].map((r) => r.workerId));
    return [...this.workers.values()].filter((w) => !w.gone && (w.lastSeen >= since || busy.has(w.id)));
  }

  // Models every active worker has (what an unrestricted request can use).
  models() {
    const active = this.activeWorkers();
    if (!active.length) return [];
    return active[0].models.filter((m) => active.every((w) => w.models.includes(m)));
  }

  status(windowMs = 60_000) {
    const since = this.now() - windowMs;
    const inflightBy = {};
    for (const r of this.leased.values()) inflightBy[r.workerId] = (inflightBy[r.workerId] || 0) + 1;
    const active = new Set(this.activeWorkers().map((w) => w.id));
    const workers = [...this.workers.values()].map((w) => ({
      id: w.id, label: w.label, host: w.host, machine: w.machine, labels: w.labels, models: w.models,
      slots: w.slots, active: active.has(w.id), paused: !!w.paused, jobId: w.jobId,
      inflight: inflightBy[w.id] || 0, done: w.done, failed: w.failed, avgMs: Math.round(w.emaMs),
      perSec: +(w.recent.filter((t) => t >= since).length / (windowMs / 1000)).toFixed(2), lastError: w.lastError || '',
    }));
    return {
      workers, queued: this.pending.length, inflight: this.leased.size,
      perSec: +workers.reduce((s, w) => s + w.perSec, 0).toFixed(2),
      done: workers.reduce((s, w) => s + w.done, 0), models: this.models(),
    };
  }

  // ── internals ────────────────────────────────────────────────────────────
  #worker(id) { return this.workers.get(id) || { id, labels: {}, models: [] }; }

  #lease(r, workerId) {
    r.attempts++;
    r.workerId = workerId;
    r.leasedAt = this.now();
    r.triedBy.add(workerId);
    this.leased.set(r.id, r);
    const w = this.workers.get(workerId);
    if (w) w.jobId = r.jobId;
    return { id: r.id, jobId: r.jobId, path: r.path, body: r.body };
  }

  // Best pending request for this worker: one it may serve, preferring ones it
  // hasn't failed, then the lowest job rank, then arrival order.
  #nextFor(workerId) {
    const w = this.#worker(workerId);
    let best = -1, bestKey = null;
    for (let i = 0; i < this.pending.length; i++) {
      const r = this.pending[i];
      if (!this.canServe(w, r.jobId)) continue;
      const key = [r.triedBy.has(workerId) ? 1 : 0, this.rankOf(r.jobId)];
      if (best < 0 || key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) { best = i; bestKey = key; }
    }
    return best < 0 ? null : this.pending.splice(best, 1)[0];
  }

  #offer(r) {
    // Straight to an idle card that may serve it, preferring one that hasn't tried it.
    const fits = (x) => !this.workers.get(x.workerId)?.paused && this.canServe(this.#worker(x.workerId), r.jobId);
    let i = this.waiters.findIndex((x) => fits(x) && !r.triedBy.has(x.workerId));
    if (i < 0) i = this.waiters.findIndex(fits);
    if (i < 0) { this.pending.push(r); return; }
    const waiter = this.waiters.splice(i, 1)[0];
    clearTimeout(waiter.timer);
    waiter.resolve(this.#lease(r, waiter.workerId));
  }

  #requeue(r, why) {
    this.leased.delete(r.id);
    r.lastWhy = why;
    this.#offer(r);
  }

  #abort(r) {
    const i = this.pending.indexOf(r);
    if (i >= 0) this.pending.splice(i, 1);
    else if (this.leased.get(r.id) === r) this.leased.delete(r.id);
    else return;
    r.resolve({ status: 499, body: JSON.stringify({ error: 'client gone' }) });
  }

  #releaseWaiters(id) {
    this.waiters = this.waiters.filter((x) => (x.workerId === id ? (clearTimeout(x.timer), x.resolve(null), false) : true));
  }
}
