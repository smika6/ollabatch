// Job store: the ordered queue of batch jobs and their lifecycle. Pure; the
// host persists it with toJSON() and spawns what startable() returns.
//
//   queued → running ⇄ paused → done | failed | cancelled
//
// "Waiting for cards" is a reason on a queued or running job, not a status:
// an overnight run shouldn't fail because a PC was asleep.

export class JobStateError extends Error {}

const FINISHED = new Set(['done', 'failed', 'cancelled']);
const SPEC_KEYS = ['name', 'command', 'args', 'cwd', 'env', 'models', 'modelPolicy', 'minCards', 'selector',
  'progressPattern', 'estimate', 'restartable', 'shell', 'template'];

export class JobStore {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.jobs = [];
    this.nextId = 1;
  }

  add(spec, at = this.jobs.length) {
    const job = {
      name: spec.name || spec.command, command: spec.command, args: spec.args || [], cwd: spec.cwd || process.cwd(),
      env: spec.env || {}, models: spec.models || [], modelPolicy: spec.modelPolicy || 'one', minCards: spec.minCards || 1,
      selector: spec.selector || '', progressPattern: spec.progressPattern || null, estimate: spec.estimate ?? null,
      restartable: !!spec.restartable, shell: !!spec.shell, template: spec.template || null,
      id: `j${this.nextId++}`, status: 'queued', progress: { done: 0, total: null, rate: 0 }, model: null, reason: null,
      createdAt: this.now(), startedAt: null, finishedAt: null, exitCode: null,
    };
    this.jobs.splice(at, 0, job);
    return job;
  }

  get(id) { return this.jobs.find((j) => j.id === id); }
  list() { return this.jobs; }

  rankOf(id) {
    const i = this.jobs.findIndex((j) => j.id === id);
    return i < 0 ? Infinity : i;
  }

  move(id, index) {
    const job = this.#want(id, ['queued'], 'move');
    this.jobs.splice(this.jobs.indexOf(job), 1);
    this.jobs.splice(Math.max(0, Math.min(index, this.jobs.length)), 0, job);
  }

  pause(id) { this.#want(id, ['running'], 'pause').status = 'paused'; }
  resume(id) { this.#want(id, ['paused'], 'resume').status = 'running'; }

  cancel(id) {
    const job = this.#want(id, ['queued', 'running', 'paused'], 'cancel');
    Object.assign(job, { status: 'cancelled', finishedAt: this.now(), reason: null });
  }

  markCancelled(id) { this.cancel(id); }

  rerun(id) {
    const job = this.#want(id, [...FINISHED], 'rerun');
    return this.add(Object.fromEntries(SPEC_KEYS.map((k) => [k, job[k]])));
  }

  markStarted(id, { model = null } = {}) {
    Object.assign(this.#want(id, ['queued'], 'start'), { status: 'running', model, reason: null, startedAt: this.now() });
  }

  markWaiting(id, reason) { this.#want(id, ['queued', 'running', 'paused'], 'wait').reason = reason; }

  setProgress(id, progress) {
    const job = this.get(id);
    if (!job) return;
    job.progress = progress;
    if (job.reason === 'waiting for cards') job.reason = null;
  }

  // A job cancelled while its process was dying stays cancelled.
  markFinished(id, exitCode) {
    const job = this.get(id);
    if (!job || FINISHED.has(job.status)) return;
    Object.assign(job, { status: exitCode === 0 ? 'done' : 'failed', exitCode, finishedAt: this.now() });
  }

  startable(maxRunning) {
    const busy = this.jobs.filter((j) => j.status === 'running' || j.status === 'paused').length;
    const free = Math.max(0, maxRunning - busy);
    return this.jobs.filter((j) => j.status === 'queued').slice(0, free);
  }

  toJSON() { return { nextId: this.nextId, jobs: this.jobs }; }

  // A job that was running when the host went down is failed; a restartable
  // one is also re-queued where it stood (resume-by-default jobs pick up the rest).
  static fromJSON(obj, { now } = {}) {
    const s = new JobStore({ now });
    s.nextId = obj?.nextId || 1;
    s.jobs = obj?.jobs || [];
    for (const job of [...s.jobs]) {
      if (job.status !== 'running' && job.status !== 'paused') continue;
      Object.assign(job, { status: 'failed', reason: 'host restarted', finishedAt: s.now() });
      if (job.restartable) s.add(Object.fromEntries(SPEC_KEYS.map((k) => [k, job[k]])), s.jobs.indexOf(job));
    }
    return s;
  }

  #want(id, states, action) {
    const job = this.get(id);
    if (!job) throw new JobStateError(`no job ${id}`);
    if (!states.includes(job.status)) throw new JobStateError(`can't ${action} ${id}: it is ${job.status}`);
    return job;
  }
}
