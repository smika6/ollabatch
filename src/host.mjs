// The host: job queue, scheduler, request router, dashboard and state, in one
// process. Jobs run here as local commands; every inference request they make
// goes to /j/<job>/api/* on loopback and is routed to a card whose labels match
// the job. Cards pull work over /pool/* (the original worker protocol, kept
// compatible), so worker machines open no ports.
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { RequestQueue, errorText } from './queue.mjs';
import { JobStore, JobStateError } from './jobs.mjs';
import { Metrics } from './metrics.mjs';
import { Insights } from './insights.mjs';
import { parseStats, LoadCounter } from './infer.mjs';
import { addRequestToJob, prune, trimLog, filterHistory, toCsv, timelineAdd } from './history.mjs';
import { buildPrompt } from './summary.mjs';
import { RemoteStore } from './remote.mjs';
import { VERSION } from './version.mjs';
import { parseSelector, matchesSelector } from './labels.mjs';
import { chooseModel, modelForCard, rewriteModel } from './models.mjs';
import { advance, etaSeconds, queueEta } from './progress.mjs';
import { startJob } from './runner.mjs';
import { loadTemplates, instantiate, specProblem } from './templates.mjs';
import { readJson, writeJsonAtomic, createSaver } from './state.mjs';
import { workerLoop, makeUnloader, ollamaModels } from './worker.mjs';
import { startBeacon, BEACON_PORT } from './discovery.mjs';
import { tarFiles, appFiles } from './tar.mjs';

// An agent on this machine answers on its local page; then it lends the GPUs
// and the host's own built-in card stays off (two servers on one GPU would
// fight over its memory, worst on a Mac's shared memory).
async function probeLocalAgent() {
  // Any answer counts: an agent still starting its GPU servers answers 503.
  try { await fetch('http://127.0.0.1:11510/status', { signal: AbortSignal.timeout(1500) }); return true; } catch { return false; }
}

const DASHBOARD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dashboard');
const INSTALLERS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'install');
const APP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const INFERENCE = /^\/api\/(chat|generate|show|embed|embeddings)$/;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// Dashboard files by name only (no slashes, no dots but the extension), so a path can't leave the folder.
const STATIC = /^\/[a-z][a-z-]*\.(mjs|js|css)$/;
const MIME = { mjs: 'text/javascript', js: 'text/javascript', css: 'text/css' };
const JOB_ACTIONS = new Set(['move', 'pause', 'resume', 'cancel', 'rerun']);

const bare = (addr) => String(addr ?? '').replace(/^::ffff:/, '');
function decode(s) {
  try { return decodeURIComponent(s); } catch { throw new HttpError(400, 'bad %-escape in the address'); }
}

// What an agent reports, with every field the dashboard shows forced to its
// type: a report is data from another machine, never markup.
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const str = (v, max = 300) => (v == null ? null : String(v).slice(0, max));
const bool = (v) => v === true;
export function cleanReport(b) {
  const pg = b.playground && typeof b.playground === 'object' ? b.playground : null;
  const list = (v) => (Array.isArray(v) ? v : []);
  return {
    machine: str(b.machine, 200), os: str(b.os, 40), agent: str(b.agent, 40), policy: str(b.policy, 20), watcher: b.watcher !== false,
    remote: bool(b.remote), trusted: bool(b.trusted), appliedVersion: num(b.appliedVersion),
    localOverride: list(b.localOverride).map((x) => str(x, 120)).slice(0, 100),
    schedule: list(b.schedule).slice(0, 14).map((w) => ({ days: list(w?.days).map(num).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6), from: str(w?.from, 5), to: str(w?.to, 5) })),
    cards: list(b.cards).slice(0, 64).map((c) => ({
      id: str(c?.id, 64), workerId: str(c?.workerId, 200), name: str(c?.name, 200), vendor: str(c?.vendor, 40),
      vramMB: num(c?.vramMB), freeMB: num(c?.freeMB), util: num(c?.util), tempC: num(c?.tempC), powerW: num(c?.powerW),
      display: bool(c?.display), state: str(c?.state, 40), reason: str(c?.reason), slots: num(c?.slots),
      fixedSlots: c?.fixedSlots === 'auto' || c?.fixedSlots == null ? 'auto' : num(c.fixedSlots), paused: bool(c?.paused), disabled: bool(c?.disabled),
      backend: str(c?.backend, 20), loadedModel: str(c?.loadedModel, 200), loadedModels: list(c?.loadedModels).map((x) => str(x, 200)).slice(0, 16), tuning: str(c?.tuning, 40), thermal: str(c?.thermal, 20),
    })),
    playground: pg && { path: str(pg.path, 500), limitGB: num(pg.limitGB), usedBytes: num(pg.usedBytes) ?? 0, downloads: bool(pg.downloads),
      models: list(pg.models).slice(0, 500).map((x) => ({ name: str(x?.name, 200), size: num(x?.size) ?? 0, linked: bool(x?.linked), locked: bool(x?.locked) })) },
    download: b.download && typeof b.download === 'object' ? { model: str(b.download.model, 200), completed: num(b.download.completed) ?? 0, total: num(b.download.total) } : null,
    downloadFailures: Object.fromEntries(Object.entries(b.downloadFailures && typeof b.downloadFailures === 'object' ? b.downloadFailures : {}).slice(0, 50)
      .map(([m, f]) => [str(m, 200), { count: num(f?.count) ?? 0, until: num(f?.until), error: str(f?.error) }])),
  };
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function startHost({
  port = 11500, password, stateDir = '.ollabatch', jobsFile = null, maxRunning = 1,
  local = null, bind = '0.0.0.0', now = Date.now, log = () => {},
  localForced = false, agentProbe = probeLocalAgent, agentRecheckMs = 30_000,
  beacon = true, beaconPort = BEACON_PORT, beaconTargets = undefined,
} = {}) {
  fs.mkdirSync(stateDir, { recursive: true });
  const files = { state: path.join(stateDir, 'state.json'), metrics: path.join(stateDir, 'metrics.json'), token: path.join(stateDir, 'token'), logs: path.join(stateDir, 'logs') };

  // Reuse the saved password so joined machines keep working across restarts.
  let saved = '';
  try { saved = fs.readFileSync(files.token, 'utf8').trim(); } catch { /* first start */ }
  if (password != null && String(password).length < 6) throw new Error('the pool password must be at least 6 characters');
  const token = password || saved || crypto.randomBytes(9).toString('base64url');
  fs.writeFileSync(files.token, token);

  const state = readJson(files.state) || {};
  const store = JobStore.fromJSON(state.jobs, { now, isAlive: pidAlive });
  for (const j of store.list()) delete j.summaryState;   // a summary waiting when the host stopped isn't running now
  const userLabels = state.cardLabels || {};
  const settings = { summaries: 'manual', summaryModel: null, ...(state.settings || {}) };   // cardKey → { k: v }, set from the dashboard/CLI
  const metrics = Metrics.fromJSON(readJson(files.metrics), { now });
  files.insights = path.join(stateDir, 'insights.json');
  const insights = Insights.fromJSON(readJson(files.insights), { now });
  const remote = RemoteStore.fromJSON(state.remote, { now });
  const loadCounter = new LoadCounter();
  let onRequestDone = null;   // set by job stats (history)
  const templates = loadTemplates(jobsFile);
  const selectors = new Map();                 // jobId → parsed selector
  const handles = new Map();                   // jobId → runner handle
  let closing = false, listenPort = port;

  const selectorOf = (job) => {
    if (!selectors.has(job.id)) selectors.set(job.id, parseSelector(job.selector));
    return selectors.get(job.id);
  };
  const cardKey = (w) => `${w.machine}|${w.label || w.id}`;
  const labelsOf = (w) => ({
    machine: w.machine,
    ...Object.fromEntries((w.models || []).map((m) => [`model:${m}`, '1'])),
    ...(w.labels || {}),
    ...(userLabels[cardKey(w)] || {}),
  });
  const cardFits = (w, job) => matchesSelector(labelsOf(w), selectorOf(job));
  const hasModel = (w, job) => {
    if (!job.models.length) return true;
    return job.modelPolicy === 'any' ? job.models.some((m) => w.models.includes(m)) : w.models.includes(job.model);
  };
  const canServe = (w, jobId) => {
    if (jobId === '_') return true;
    if (jobId === '_summary') return summaryCard(w);
    const job = store.get(jobId);
    return !!job && job.status === 'running' && hasModel(w, job) && cardFits(w, job);
  };
  const queue = new RequestQueue({ now, canServe, rankOf: (id) => (id === '_summary' ? Infinity : id === '_' ? Number.MAX_SAFE_INTEGER : store.rankOf(id)) });
  const liveCards = () => queue.activeWorkers().filter((w) => !w.paused);

  const saveState = () => writeJsonAtomic(files.state, { jobs: store.toJSON(), cardLabels: userLabels, settings, remote: remote.toJSON() });
  let saveTimelines = () => {};   // set with job history below
  const saveMetrics = () => {
    try { writeJsonAtomic(files.metrics, metrics.toJSON()); writeJsonAtomic(files.insights, insights.toJSON()); }
    catch (e) { log(`! couldn't save metrics: ${e.message}`); }
    saveTimelines();
  };
  const saver = createSaver(saveState, 500, (e) => log(`! couldn't save state: ${e.message}`));
  const changed = () => { saver.schedule(); setImmediate(tick); };

  // ── scheduler ────────────────────────────────────────────────────────────
  // Start queued jobs in order while running slots are free. A job whose cards
  // aren't online waits without holding up the jobs behind it.
  function tick() {
    if (closing) return;
    let dirty = false;
    const setReason = (job, reason) => { if (job.reason !== reason) { job.reason = reason; dirty = true; } };
    let free = maxRunning - store.list().filter((j) => j.status === 'running' || j.status === 'paused').length;
    for (const job of store.list()) {
      if (job.status === 'running') {
        setReason(job, liveCards().some((w) => hasModel(w, job) && cardFits(w, job)) ? null : 'waiting for cards');
        continue;
      }
      if (job.status !== 'queued' || free <= 0) continue;
      const cards = liveCards().filter((w) => cardFits(w, job));
      let model = null;
      if (job.models.length) {
        model = job.modelPolicy === 'any'
          ? (cards.some((w) => job.models.some((m) => w.models.includes(m))) ? job.models[0] : null)
          : chooseModel(job.models, cards, job.minCards);
        if (!model) { setReason(job, 'waiting for cards'); continue; }
      } else if (!cards.length) { setReason(job, 'waiting for cards'); continue; }
      launch(job, model);
      free--;
      dirty = true;
    }
    if (dirty) { saver.schedule(); queue.reoffer(); }
  }

  function launch(job, model) {
    store.markStarted(job.id, { model });
    let handle;
    try {
      handle = start(job);
    } catch (e) {
      store.markFinished(job.id, 127);
      job.reason = `couldn't start: ${e.message}`;
      log(`job ${job.id} ${job.name} couldn't start: ${e.message}`);
      return;
    }
    handles.set(job.id, handle);
    // Saved right away: after a hard crash the next start must know this pid.
    job.pid = handle.pid;
    saver.schedule(); saver.flush();
    log(`job ${job.id} ${job.name} started${model ? ` on ${model}` : ''}`);
  }

  function start(job) {
    return startJob(job, {
      port: listenPort, logDir: files.logs,
      onProgress: (p) => { store.setProgress(job.id, advance(job.progress, p, now())); progressed(job, p.done); saver.schedule(); },
      onExit: (code) => {
        handles.delete(job.id);
        if (closing) return;   // the next host start records it as "host restarted"
        store.markFinished(job.id, code);
        finished(job);
        queue.dropJob(job.id, 'job exited');
        log(`job ${job.id} ${job.name} exited ${code}`);
        changed();
      },
    });
  }

  async function cancel(job) {
    store.cancel(job.id);
    queue.dropJob(job.id, 'job cancelled');
    const h = handles.get(job.id);
    if (h) await h.kill();
    changed();
  }

  // What a card is handed: for "any"-model jobs, the body names the model this card has.
  function prepare(lease, workerId) {
    const job = lease.jobId !== '_' && store.get(lease.jobId);
    if (job && job.modelPolicy === 'any' && job.models.length) {
      const m = modelForCard(job.models, queue.workers.get(workerId)?.models || []);
      if (m) return { ...lease, body: rewriteModel(lease.body, m) };
    }
    return lease;
  }

  function finish(reqId, workerId, result) {
    const lease = queue.leased.get(reqId);
    const accepted = queue.complete(reqId, workerId, result);
    if (accepted && lease) {
      const ok = result.status >= 200 && result.status < 300;
      metrics.record({ cardId: workerId, jobId: lease.jobId, ok, ms: now() - lease.leasedAt });
      const stats = ok ? loadCounter.dedupe(workerId, parseStats(result.body, result.contentType), now()) : null;
      insights.record({ card: workerId, job: lease.jobId, model: stats?.model, ok, retried: lease.attempts > 1,
        waitSec: (lease.leasedAt - lease.enqueuedAt) / 1000, latencySec: (now() - lease.leasedAt) / 1000, stats });
      onRequestDone?.(lease, workerId, ok, stats, result);
    }
    return accepted;
  }

  // ── views ────────────────────────────────────────────────────────────────
  const publicJob = (j) => {
    const { env, ...rest } = j;   // env can hold secrets; it never leaves the host
    return { ...rest, eta: etaSeconds(j.progress) };
  };
  // What each machine's agent last said about itself (hardware, owner state, playground).
  const reports = new Map();   // machine → { ...report, seenAt }
  const ownerOf = (w) => {
    const c = reports.get(w.machine)?.cards?.find((x) => x.workerId === w.id);
    return c ? { state: c.state, reason: c.reason ?? null } : null;
  };
  const ownerHolds = (w) => ['paused-by-owner', 'paused-in-use', 'outside-schedule', 'never'].includes(ownerOf(w)?.state);
  function cards() {
    return queue.status().workers.map((w) => {
      const raw = queue.workers.get(w.id);
      return { ...w, key: cardKey(raw), labels: labelsOf(raw), userLabels: userLabels[cardKey(raw)] || {}, owner: ownerOf(raw) };
    });
  }
  function recentJobs() {
    const all = store.list();
    const done = new Set(all.filter((j) => ['done', 'failed', 'cancelled'].includes(j.status)).sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0)).slice(0, 20));
    return all.filter((j) => !['done', 'failed', 'cancelled'].includes(j.status) || done.has(j));
  }
  function fullStatus(isLoopback) {
    const s = queue.status();
    const all = cards();
    const byMachine = new Map([...reports.keys()].map((m) => [m, []]));
    for (const c of all) {
      if (!byMachine.has(c.machine)) byMachine.set(c.machine, []);
      byMachine.get(c.machine).push(c);
    }
    return {
      // Active jobs plus the 20 most recent finished ones; the rest is in /ob/history.
      jobs: recentJobs().map(publicJob), queueEta: queueEta(store.list()),
      perSec: s.perSec, queued: s.queued, inflight: s.inflight, done: s.done, models: s.models,
      // Each machine with what the dashboard asked of it, so controls can show
      // "waiting for the PC" until its agent reports the change.
      workers: all, machines: [...byMachine].map(([machine, list]) => ({ machine, cards: list, report: reports.get(machine) || null,
        desired: remote.desired(machine), commands: remote.commands(machine).slice(0, 8) })),
      templates: templates.map((t) => ({ id: t.id, name: t.name, params: t.params, models: t.models || [], selector: t.selector || '' })),
      settings: { maxRunning }, canCreate: isLoopback, version: VERSION,
    };
  }

  // ── HTTP ─────────────────────────────────────────────────────────────────
  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
  const readJsonBody = async (req) => {
    const text = await readBody(req);
    try { return text ? JSON.parse(text) : {}; } catch { throw new HttpError(400, 'body is not JSON'); }
  };
  const send = (res, status, body, type = 'application/json') => {
    res.writeHead(status, { 'Content-Type': type });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  // A loopback socket alone isn't trust: any web page in a browser on this
  // machine connects from 127.0.0.1 too. Also require a local Host header
  // (defeats DNS rebinding) and no foreign Origin (defeats cross-site posts).
  const hostName = (req) => (req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  const foreignOrigin = (req) => req.headers.origin != null && req.headers.origin !== `http://${req.headers.host}`;
  const isLoopback = (req) => LOOPBACK.has(req.socket.remoteAddress) && LOCAL_NAMES.has(hostName(req)) && !foreignOrigin(req);
  const authed = (req, url) => isLoopback(req) || req.headers['x-pool-token'] === token || url.searchParams.get('token') === token;
  const jobOr404 = (id) => {
    const job = store.get(id);
    if (!job) throw new HttpError(404, `no job ${id}`);
    return job;
  };

  async function inference(req, res, jobId, apiPath) {
    if (!isLoopback(req)) return send(res, 403, { error: 'ollabatch: the model API is only for jobs on this host' });
    const live = () => {
      const job = jobOr404(jobId);
      if (job.status !== 'running' && job.status !== 'paused') throw new HttpError(409, `job ${jobId} is ${job.status}`);
    };
    if (jobId !== '_') live();
    else if (!queue.activeWorkers().length) return send(res, 503, { error: 'ollabatch: no cards have joined yet' });
    const body = await readBody(req);
    if (jobId !== '_') live();   // it may have been cancelled while the body arrived
    // A client that gives up (timeout, retry, exit) takes its request with it.
    const gone = new AbortController();
    res.on('close', () => { if (!res.writableEnded) gone.abort(); });
    const r = await queue.enqueue({ jobId, path: apiPath, body, signal: gone.signal });
    if (gone.signal.aborted) return;
    return send(res, r.status, r.body, r.contentType || 'application/json');
  }

  function tagsFor(jobId) {
    if (jobId === '_') return queue.models();
    const job = jobOr404(jobId);
    const have = new Set(queue.activeWorkers().filter((w) => canServe(w, jobId)).flatMap((w) => w.models));
    if (job.modelPolicy !== 'any' && job.model) return have.has(job.model) ? [job.model] : [];
    return job.models.length ? job.models.filter((m) => have.has(m)) : [...have];
  }

  function newJob(body, loopback) {
    let spec;
    if (body.template) {
      const t = templates.find((x) => x.id === body.template);
      if (!t) throw new HttpError(404, `no template ${body.template}`);
      try { spec = instantiate(t, body.params || {}); } catch (e) { throw new HttpError(400, e.message); }
    } else {
      // A free-form command runs on this machine: only from the host itself.
      if (!loopback) throw new HttpError(403, 'ollabatch: only templates can be added from another machine');
      spec = { ...body };
    }
    const problem = specProblem(spec);
    if (problem) throw new HttpError(400, problem);
    try { parseSelector(spec.selector); } catch (e) { throw new HttpError(400, e.message); }
    const job = store.add(spec);
    changed();
    return job;
  }

  async function jobAction(job, action, body) {
    try {
      if (action === 'move') store.move(job.id, Number(body.index));
      else if (action === 'pause') store.pause(job.id);
      else if (action === 'resume') { store.resume(job.id); queue.reoffer(); }
      else if (action === 'cancel') { await cancel(job); return publicJob(job); }
      else if (action === 'rerun') { const j = store.rerun(job.id); changed(); return publicJob(j); }
    } catch (e) {
      if (e instanceof JobStateError) throw new HttpError(409, e.message);
      throw e;
    }
    changed();
    return publicJob(job);
  }

  // Per card of a machine, the models jobs would use it for: a running job's
  // actual model (or its whole list when any model will do), a queued job's
  // first choice. The host matches selectors because dashboard labels live here.
  function wantsFor(machine) {
    const out = {};
    const jobs = store.list().filter((j) => (j.status === 'running' || j.status === 'paused' || j.status === 'queued') && j.models.length);
    for (const w of queue.workers.values()) {
      if (w.machine !== machine || w.gone) continue;
      const models = [];
      for (const j of jobs) {
        if (!cardFits(w, j)) continue;
        const want = j.status === 'queued' ? [j.models[0]] : j.modelPolicy === 'any' ? j.models : [j.model];
        for (const m of want) if (m && !models.includes(m)) models.push(m);
      }
      out[w.id] = models;
    }
    return out;
  }

  function logTail(job, lines, q = null) {
    try {
      const text = fs.readFileSync(path.join(files.logs, `${job.id}.log`), 'utf8');
      let all = text.split(/\r?\n|\r/);
      if (q) { const needle = q.toLowerCase(); all = all.filter((l) => l.toLowerCase().includes(needle)); }
      return all.slice(-lines).join('\n');
    } catch { return ''; }
  }

  // ── history ──────────────────────────────────────────────────────────────
  const historyDir = path.join(stateDir, 'history');
  const timelines = new Map();   // running jobs' per-minute done counts
  const timelineFile = (id) => path.join(historyDir, `${id}.json`);
  // A running job's graph is saved with the metrics (every minute and at
  // shutdown), so a job that carries on after a host restart keeps its history.
  function progressed(job, done) {
    if (!timelines.has(job.id)) timelines.set(job.id, readJson(timelineFile(job.id)) || {});
    timelineAdd(timelines.get(job.id), done, now());
  }
  saveTimelines = () => {
    for (const [id, tl] of timelines) {
      try { fs.mkdirSync(historyDir, { recursive: true }); writeJsonAtomic(timelineFile(id), tl); } catch { /* the graph is optional */ }
    }
  };
  function finished(job) {
    const tl = timelines.get(job.id);
    if (tl) {
      try { writeJsonAtomic(timelineFile(job.id), tl); } catch { /* the graph is optional */ }
      timelines.delete(job.id);
    }
    try { trimLog(path.join(files.logs, `${job.id}.log`)); } catch { /* best effort */ }
    onJobFinished?.(job);
  }
  let onJobFinished = null;   // set by summaries
  onRequestDone = (lease, workerId, ok, stats, result) => {
    const job = lease.jobId !== '_' && store.get(lease.jobId);
    if (!job) return;
    addRequestToJob(job, { card: workerId, cardLabel: queue.workers.get(workerId)?.label, ok, retried: lease.attempts > 1, stats,
      error: ok ? null : errorText(result) });
    saver.schedule();
  };
  function forget(id) {
    store.remove(id);
    fs.rmSync(path.join(files.logs, `${id}.log`), { force: true });
    fs.rmSync(timelineFile(id), { force: true });
    saver.schedule();
  }

  // ── summaries ────────────────────────────────────────────────────────────
  // Only cards the pool's owner controls see a job's log: the host's own
  // machine, or machines whose owner let the pool manage them. And only when
  // they have nothing else to do, without swapping out a loaded model.
  // Trust rests on where a card connected from, not on what it says: a card
  // naming the host's machine must connect from this machine, and a report
  // saying "remote" counts only from the address the card registered from.
  const own = (addr) => addr === 'local' || /^(::ffff:)?127\./.test(addr) || addr === '::1' || lanAddresses().includes(bare(addr));
  const trustedCard = (w) => w.host === 'local' || (w.machine === os.hostname() && own(w.host))
    || (reports.get(w.machine)?.remote === true && bare(reports.get(w.machine).from) === bare(w.host));
  function summaryCard(w) {
    if (!trustedCard(w) || w.paused) return false;
    if (queue.pending.some((r) => r.jobId !== '_summary' && canServe(w, r.jobId))) return false;
    const loaded = reports.get(w.machine)?.cards?.find((c) => c.workerId === w.id)?.loadedModel;
    return !loaded || summaryModels.has(loaded);
  }
  const summaryModels = new Map();   // model → summaries waiting for it
  function pickSummaryModel(job) {
    const cards = queue.activeWorkers().filter(trustedCard);
    if (job.model && cards.some((w) => w.models.includes(job.model))) return job.model;
    if (settings.summaryModel) return settings.summaryModel;
    const counts = {};
    for (const w of cards) for (const mdl of w.models) counts[mdl] = (counts[mdl] || 0) + 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  }
  async function summarize(job) {
    const model = pickSummaryModel(job);
    if (!model) { job.summaryError = 'no trusted card with a model is online'; return; }
    const { system, user } = buildPrompt(job, logTail(job, 400));
    job.summaryState = 'running';
    summaryModels.set(model, (summaryModels.get(model) || 0) + 1);
    try {
      const r = await queue.enqueue({ jobId: '_summary', path: '/api/chat', leaseMs: 120_000, maxAttempts: 1, signal: AbortSignal.timeout(60 * 60_000),
        body: JSON.stringify({ model, stream: false, options: { temperature: 0.2 }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }) });
      const text = r.status >= 200 && r.status < 300 ? JSON.parse(r.body).message?.content?.trim() : null;
      if (text) { job.summary = { text: text.slice(0, 4000), model, at: now(), source: 'pool' }; job.summaryError = null; }
      else job.summaryError = `the summary request failed (${r.status})`;
    } catch (e) {
      job.summaryError = e.message;
    } finally {
      job.summaryState = null;
      if (summaryModels.get(model) > 1) summaryModels.set(model, summaryModels.get(model) - 1); else summaryModels.delete(model);
      saver.schedule();
    }
  }
  onJobFinished = (job) => {
    if (job.summary?.source === 'job' || settings.summaries === 'off') return;
    const t = job.template && templates.find((x) => x.id === job.template);
    if (settings.summaries === 'auto' || t?.summary) summarize(job).catch(() => {});
  };

  function pruneHistory() {
    for (const id of prune({ jobs: store.list(), now: now() })) forget(id);
    saver.schedule();
  }

  function dashboard(res, isLocal) {
    let html;
    try { html = fs.readFileSync(path.join(DASHBOARD, 'index.html'), 'utf8'); } catch { return send(res, 404, 'dashboard not built', 'text/plain'); }
    // The host's own browser gets the password baked in; other devices type it once.
    const attr = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    return send(res, 200, html.replace('__OLLABATCH_TOKEN__', isLocal ? attr(token) : ''), 'text/html; charset=utf-8');
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://ollabatch');
    const p = url.pathname;
    if (foreignOrigin(req)) return send(res, 403, { error: 'ollabatch: cross-site request refused' });
    const loopback = isLoopback(req);

    // Model API for jobs (loopback only).
    let m;
    if (req.method === 'POST' && INFERENCE.test(p)) return inference(req, res, '_', p);
    if (req.method === 'POST' && (m = p.match(/^\/j\/([\w-]+)(\/api\/(?:chat|generate|show|embed|embeddings))$/))) return inference(req, res, m[1], m[2]);
    if (req.method === 'GET' && (m = p.match(/^(?:\/j\/([\w-]+))?\/api\/(tags|version)$/))) {
      if (!loopback) return send(res, 403, { error: 'ollabatch: the model API is only for jobs on this host' });
      if (m[2] === 'version') return send(res, 200, { version: 'ollabatch' });
      return send(res, 200, { models: tagsFor(m[1] || '_').map((name) => ({ name, model: name })) });
    }

    if (req.method === 'GET' && (p === '/' || p === '/pool')) return dashboard(res, loopback);
    if (req.method === 'GET' && (m = STATIC.exec(p))) {
      try { return send(res, 200, fs.readFileSync(path.join(DASHBOARD, p.slice(1))), MIME[m[1]]); } catch { return send(res, 404, 'not found', 'text/plain'); }
    }
    // One-command installers and the app itself, for machines joining for the
    // first time. Open source and secret-free, so no password.
    if (req.method === 'GET' && (p === '/install.ps1' || p === '/install.sh')) {
      const h = req.headers.host || '';
      if (!/^[A-Za-z0-9.\-]+(:\d+)?$/.test(h)) throw new HttpError(400, 'bad Host header');
      // ?trusted=1: one of the pool owner's own PCs, which the pool may then manage.
      const text = fs.readFileSync(path.join(INSTALLERS, p.slice(1)), 'utf8').replaceAll('__HOST__', `http://${h}`)
        .replaceAll('__INSTALL_ARGS__', url.searchParams.get('trusted') === '1' ? '--trusted' : '');
      return send(res, 200, text, 'text/plain; charset=utf-8');
    }
    if (req.method === 'GET' && p === '/ollabatch.tar') {
      res.writeHead(200, { 'Content-Type': 'application/x-tar', 'Content-Disposition': 'attachment; filename="ollabatch.tar"' });
      return res.end(tarFiles(APP_ROOT, appFiles(APP_ROOT)));
    }
    // Legacy status for older join clients: no commands, no env.
    if (req.method === 'GET' && p === '/pool/status') {
      return send(res, 200, { ...queue.status(), progress: null, jobs: store.list().map((j) => ({ id: j.id, name: j.name, status: j.status, progress: j.progress })) });
    }

    if (!authed(req, url)) return send(res, 401, { error: 'ollabatch: missing or wrong password' });

    // Worker protocol.
    if (req.method === 'POST' && p === '/pool/register') {
      const b = await readJsonBody(req);
      if (!b.id) throw new HttpError(400, 'id required');
      const machine = b.machine || (b.id.startsWith('local-') ? b.id.slice(6) : b.id.split('-')[0]) || req.socket.remoteAddress;
      const labels = b.labels && typeof b.labels === 'object' ? Object.fromEntries(Object.entries(b.labels).map(([k, v]) => [k, String(v)])) : {};
      queue.register(b.id, { label: b.label, slots: b.slots, models: b.models || [], host: req.socket.remoteAddress, machine, labels });
      log(`+ card ${b.label || b.id} on ${machine}`);
      changed();
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/pool/leave') {
      const b = await readJsonBody(req);
      queue.leave(b.id);
      changed();
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && p === '/pool/work') {
      const id = url.searchParams.get('worker');
      if (!queue.workers.has(id)) return send(res, 409, { error: 'register first' });
      const lease = await queue.take(id, { waitMs: 25_000 });
      if (lease) return send(res, 200, prepare(lease, id));
      res.writeHead(204, { 'x-pool-paused': queue.isPaused(id) ? '1' : '0' });
      return res.end();
    }
    if (req.method === 'POST' && p === '/pool/result') {
      const accepted = finish(url.searchParams.get('job'), url.searchParams.get('worker'), await readJsonBody(req));
      return send(res, accepted ? 200 : 410, { accepted });
    }
    if (req.method === 'POST' && p === '/pool/release') {
      const b = await readJsonBody(req);
      if (!Array.isArray(b.ids)) throw new HttpError(400, 'ids must be a list');
      return send(res, 200, { released: queue.release(String(b.worker), b.ids.map(String)) });
    }
    if (req.method === 'POST' && p === '/pool/machine') {
      const b = await readJsonBody(req);
      if (typeof b.machine !== 'string' || !b.machine) throw new HttpError(400, 'machine is required');
      if (b.cards != null && !Array.isArray(b.cards)) throw new HttpError(400, 'cards must be a list');
      reports.set(b.machine, { ...cleanReport(b), from: req.socket.remoteAddress, seenAt: now() });
      for (const c of reports.get(b.machine).cards) {
        const w = c.workerId && queue.workers.get(c.workerId);
        insights.sampleCard(c.workerId || `${b.machine}-${c.id}`, { tempC: c.tempC ?? null, vramMB: c.vramMB ?? null,
          vramUsedMB: c.vramMB != null && c.freeMB != null ? c.vramMB - c.freeMB : null, util: c.util ?? null, powerW: c.powerW ?? null,
          slots: c.slots ?? null, slotsBusy: w ? [...queue.leased.values()].filter((r) => r.workerId === w.id).length : null, state: c.state });
      }
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && p === '/pool/wants') {
      return send(res, 200, { cards: wantsFor(url.searchParams.get('machine') || '') });
    }
    if (req.method === 'POST' && p === '/pool/pause') {
      const b = await readJsonBody(req);
      const w = queue.workers.get(b.id);
      // The machine's owner has the final say: only they can resume what they paused.
      // A machine that lets the pool manage it can be resumed from here when its
      // owner paused it by hand; a game running or the schedule still wins.
      if (w && !b.paused && ownerHolds(w)) {
        const own = ownerOf(w), rep = reports.get(w.machine);
        if (own.state !== 'paused-by-owner' || rep?.remote !== true) throw new HttpError(409, `paused on its machine: ${own.reason || own.state}`);
        const c = rep.cards.find((x) => x.workerId === w.id);
        remote.setDesired(w.machine, { [`cards.${c.id}.paused`]: false });
        saver.schedule();
      }
      if (!queue.setPaused(b.id, b.paused)) throw new HttpError(404, 'unknown card');
      changed();
      return send(res, 200, { ok: true });
    }
    // Remote control, pulled by agents on their tick.
    if (req.method === 'GET' && p === '/pool/settings') return send(res, 200, { ...remote.desired(url.searchParams.get('machine') || ''), now: now() });
    if (req.method === 'GET' && p === '/pool/commands') return send(res, 200, { commands: remote.pending(url.searchParams.get('machine') || '') });
    if (req.method === 'POST' && (m = p.match(/^\/pool\/commands\/([\w-]+)$/))) {
      const b = await readJsonBody(req);
      const ok = remote.ack(String(b.machine || ''), m[1], { ok: !!b.ok, error: b.error ? String(b.error).slice(0, 500) : null });
      if (ok) { saver.schedule(); log(`${b.ok ? '✓' : '!'} ${b.machine}: command ${m[1]}${b.error ? ` ${b.error}` : ''}`); }
      return send(res, ok ? 200 : 410, { accepted: ok });
    }
    if (req.method === 'GET' && p === '/pool/info') {
      return send(res, 200, { token, port: listenPort, version: VERSION, urls: lanAddresses().map((a) => `http://${a}:${listenPort}`) });
    }

    // Control API.
    if (req.method === 'GET' && p === '/ob/status') return send(res, 200, fullStatus(loopback));
    if (req.method === 'GET' && p === '/ob/insights') {
      return send(res, 200, insights.series({ by: ['card', 'model', 'job'].includes(url.searchParams.get('by')) ? url.searchParams.get('by') : 'card', range: url.searchParams.get('range') || '1h' }));
    }
    if (req.method === 'GET' && p === '/ob/insights/now') {
      const n = insights.now();
      const ids = [...queue.workers.keys()];
      return send(res, 200, { ...n, loadsLastHour: Object.fromEntries(ids.map((id) => [id, insights.loadsLastHour(id)])),
        switchesLastHour: Object.fromEntries(ids.map((id) => [id, insights.switchesLastHour(id)])) });
    }
    if (req.method === 'GET' && (m = p.match(/^\/ob\/insights\/cards\/([^/]+)$/))) {
      return send(res, 200, { range: url.searchParams.get('range') || '1h', samples: insights.cardSeries(decode(m[1]), url.searchParams.get('range') || '1h') });
    }
    if (req.method === 'GET' && p === '/ob/metrics') {
      const by = url.searchParams.get('by') === 'job' ? 'job' : 'card';
      const minutes = Math.min(1440, Math.max(1, Number(url.searchParams.get('minutes')) || 60));
      return send(res, 200, metrics.series({ by, minutes }));
    }
    if (req.method === 'POST' && p === '/ob/jobs') return send(res, 200, publicJob(newJob(await readJsonBody(req), loopback)));
    if (p === '/ob/settings') {
      if (req.method === 'GET') return send(res, 200, settings);
      if (req.method === 'PUT') {
        const b = await readJsonBody(req);
        if (b.summaries != null) {
          if (!['off', 'manual', 'auto'].includes(b.summaries)) throw new HttpError(400, 'summaries is off, manual or auto');
          settings.summaries = b.summaries;
        }
        if (b.summaryModel !== undefined) settings.summaryModel = b.summaryModel ? String(b.summaryModel) : null;
        saver.schedule();
        return send(res, 200, settings);
      }
    }
    if (req.method === 'GET' && p === '/ob/history') {
      const sp = url.searchParams;
      const r = filterHistory(store.list(), { q: sp.get('q'), status: sp.get('status'), template: sp.get('template'),
        from: sp.get('from') ?? undefined, to: sp.get('to') ?? undefined, limit: sp.get('limit'), before: sp.get('before') });
      return send(res, 200, { jobs: r.jobs.map(publicJob), next: r.next });
    }
    if (req.method === 'GET' && p === '/ob/history/export') {
      const all = filterHistory(store.list(), { limit: 100_000 }).jobs.map(publicJob);
      if (url.searchParams.get('format') === 'csv') {
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="ollabatch-history.csv"' });
        return res.end(toCsv(all));
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="ollabatch-history.json"' });
      return res.end(JSON.stringify(all));
    }
    if ((m = p.match(/^\/ob\/jobs\/([\w-]+)$/))) {
      const job = jobOr404(m[1]);
      if (req.method === 'GET') return send(res, 200, { ...publicJob(job), timeline: timelines.get(job.id) || readJson(timelineFile(job.id)) || null });
      if (req.method === 'PATCH') {
        const b = await readJsonBody(req);
        if (b.notes != null) job.notes = String(b.notes).slice(0, 10_000);
        saver.schedule();
        return send(res, 200, publicJob(job));
      }
      if (req.method === 'DELETE') {
        if (!['done', 'failed', 'cancelled'].includes(job.status)) throw new HttpError(409, `job ${job.id} is ${job.status}; cancel it first`);
        forget(job.id);
        return send(res, 200, { ok: true });
      }
    }
    if ((m = p.match(/^\/ob\/jobs\/([\w-]+)\/(\w+)$/))) {
      const job = jobOr404(m[1]);
      if (req.method === 'GET' && m[2] === 'log') {
        if (url.searchParams.get('download')) {
          const file = path.join(files.logs, `${job.id}.log`);
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${job.id}.log"` });
          return fs.existsSync(file) ? fs.createReadStream(file).pipe(res) : res.end('');
        }
        return send(res, 200, logTail(job, Math.min(5000, Number(url.searchParams.get('tail')) || 200), url.searchParams.get('q')), 'text/plain; charset=utf-8');
      }
      if (req.method === 'POST' && m[2] === 'summarize') {
        if (settings.summaries === 'off') throw new HttpError(409, 'summaries are switched off in the host settings');
        if (!['done', 'failed', 'cancelled'].includes(job.status)) throw new HttpError(409, 'only finished jobs can be summarized');
        if (job.summaryState === 'running') return send(res, 200, { started: false, running: true });
        summarize(job).catch(() => {});
        return send(res, 200, { started: true });
      }
      if (req.method === 'POST' && m[2] === 'progress') {
        if (!loopback) throw new HttpError(403, 'progress comes from the job itself');
        const b = await readJsonBody(req);
        if (typeof b.summary === 'string' && b.summary.trim()) {
          job.summary = { text: b.summary.trim().slice(0, 4000), model: null, at: now(), source: 'job' };
        }
        if (b.done != null) {
          if (!Number.isFinite(Number(b.done))) throw new HttpError(400, 'done must be a number');
          store.setProgress(job.id, advance(job.progress, { done: Number(b.done), total: b.total == null ? undefined : Number(b.total) }, now()));
          progressed(job, Number(b.done));
        }
        saver.schedule();
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && JOB_ACTIONS.has(m[2])) return send(res, 200, await jobAction(job, m[2], await readJsonBody(req)));
    }
    if ((m = p.match(/^\/ob\/machines\/([^/]+)\/(settings|commands)$/))) {
      const machine = decode(m[1]);
      if (req.method === 'GET' && m[2] === 'settings') return send(res, 200, remote.desired(machine));
      if (req.method === 'GET' && m[2] === 'commands') return send(res, 200, remote.commands(machine));
      const managed = () => {
        if (!reports.has(machine)) throw new HttpError(404, `no machine ${machine}`);
        if (reports.get(machine).remote !== true) throw new HttpError(409, `${machine}'s owner hasn't let the pool manage it (on that PC: "Let the pool manage this PC")`);
      };
      if (req.method === 'PUT' && m[2] === 'settings') {
        managed();
        const b = await readJsonBody(req);
        let d;
        try { d = remote.setDesired(machine, b, { cards: (reports.get(machine).cards || []).map((c) => c.id) }); } catch (e) { throw new HttpError(400, e.message); }
        saver.schedule();
        log(`~ ${machine}: settings ${Object.keys(b).join(', ')}`);
        return send(res, 200, d);
      }
      if (req.method === 'POST' && m[2] === 'commands') {
        managed();
        const b = await readJsonBody(req);
        if (['restart-card', 'retune'].includes(b.type) && !b.card) throw new HttpError(400, `${b.type} needs a card`);
        if (['pull', 'remove-model'].includes(b.type) && !b.model) throw new HttpError(400, `${b.type} needs a model`);
        let c;
        try { c = remote.queueCommand(machine, b); } catch (e) { throw new HttpError(400, e.message); }
        saver.schedule();
        log(`~ ${machine}: ${c.type}${c.card ? ` ${c.card}` : ''}${c.model ? ` ${c.model}` : ''}`);
        return send(res, 200, c);
      }
    }
    if (req.method === 'POST' && p === '/ob/cards/labels') {
      const b = await readJsonBody(req);
      const w = queue.workers.get(b.card);
      if (!w) throw new HttpError(404, `no card ${b.card}`);
      if (!b.labels || typeof b.labels !== 'object') throw new HttpError(400, 'labels must be an object');
      userLabels[cardKey(w)] = Object.fromEntries(Object.entries(b.labels).filter(([k]) => k).map(([k, v]) => [k, String(v)]));
      changed();
      queue.reoffer();
      return send(res, 200, { ok: true, labels: labelsOf(w) });
    }
    return send(res, 404, { error: 'not found' });
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((e) => {
      if (res.headersSent) return res.end();
      send(res, e instanceof HttpError ? e.status : 500, { error: e.message });
    });
  });
  server.requestTimeout = 0;      // requests can wait a long time for a card
  server.headersTimeout = 60_000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, bind, resolve); });
  listenPort = server.address().port;

  pruneHistory();
  const timers = [
    setInterval(pruneHistory, 24 * 60 * 60_000),
    setInterval(() => queue.expireLeases(), 30_000),
    setInterval(tick, 1_000),
    setInterval(saveMetrics, 60_000),
  ];
  for (const t of timers) t.unref();

  // The host's own GPU joins in-process.
  const localStop = { stopped: false };
  let useLocal = !!local?.url;
  if (useLocal && !localForced && await agentProbe()) {
    useLocal = false;
    log('a ollabatch agent runs on this machine: it lends the GPUs, so the built-in local card stays off (--local forces it)');
  }
  const beaconer = beacon && lanAddresses().length
    ? startBeacon({ port: beaconPort, targets: beaconTargets, info: { name: os.hostname(), url: `http://${lanAddresses()[0]}:${listenPort}` } })
    : null;
  if (useLocal) {
    const id = `local-${os.hostname()}`;
    const register = (models) => queue.register(id, { label: local.label || `${os.hostname()} (local)`, slots: local.slots || 2, models, host: 'local', machine: os.hostname(), labels: local.labels || {} });
    try {
      const models = await ollamaModels(local.url);
      register(models);
      timers.push(setInterval(() => register(models), 30_000));
      timers.at(-1).unref();
      const unloader = makeUnloader(local.url, log);
      for (let i = 0; i < (local.slots || 2); i++) {
        workerLoop({
          take: async () => { const l = await queue.take(id, { waitMs: 25_000 }); if (l) unloader.reset(); return l && prepare(l, id); },
          finish: (lease, result) => finish(lease.id, id, result),
          ollama: local.url, stop: localStop, isPaused: () => queue.isPaused(id), unload: unloader.unload,
        });
      }
      // An agent started on this machine later takes over its GPUs: the
      // built-in card steps out instead of sharing the GPU with it.
      const regTimer = timers.at(-1);
      if (!localForced) {
        timers.push(setInterval(async () => {
          if (localStop.stopped || !(await agentProbe())) return;
          localStop.stopped = true;
          clearInterval(regTimer);
          queue.leave(id);
          changed();
          log('a ollabatch agent started on this machine: it lends the GPUs now, so the built-in local card stepped out');
        }, agentRecheckMs));
        timers.at(-1).unref();
      }
    } catch (e) { log(`! local Ollama not joined (${e.message})`); }
  }
  tick();

  return {
    port: listenPort, token, store, queue, remote,
    async close() {
      if (closing) return;
      closing = true;
      localStop.stopped = true;
      beaconer?.stop();
      for (const t of timers) clearInterval(t);
      saver.flush();
      try { saveState(); } catch (e) { log(`! couldn't save state: ${e.message}`); }
      saveMetrics();
      await Promise.all([...handles.values()].map((h) => h.kill()));
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

export function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
}
