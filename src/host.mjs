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
import { RequestQueue } from './queue.mjs';
import { JobStore, JobStateError } from './jobs.mjs';
import { Metrics } from './metrics.mjs';
import { parseSelector, matchesSelector } from './labels.mjs';
import { chooseModel, modelForCard, rewriteModel } from './models.mjs';
import { advance, etaSeconds, queueEta } from './progress.mjs';
import { startJob } from './runner.mjs';
import { loadTemplates, instantiate, specProblem } from './templates.mjs';
import { readJson, writeJsonAtomic, createSaver } from './state.mjs';
import { workerLoop, makeUnloader, ollamaModels } from './worker.mjs';
import { startBeacon, BEACON_PORT } from './discovery.mjs';

// An agent on this machine answers on its local page; then it lends the GPUs
// and the host's own built-in card stays off (two servers on one GPU would
// fight over its memory, worst on a Mac's shared memory).
async function probeLocalAgent() {
  try { return (await fetch('http://127.0.0.1:11510/status', { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
}

const DASHBOARD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dashboard');
const INFERENCE = /^\/api\/(chat|generate|show|embed|embeddings)$/;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const STATIC = { '/app.js': 'text/javascript', '/style.css': 'text/css' };
const JOB_ACTIONS = new Set(['move', 'pause', 'resume', 'cancel', 'rerun']);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function startHost({
  port = 11500, password, stateDir = '.ollabatch', jobsFile = null, maxRunning = 1,
  local = null, bind = '0.0.0.0', now = Date.now, log = () => {},
  localForced = false, agentProbe = probeLocalAgent,
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
  const userLabels = state.cardLabels || {};   // cardKey → { k: v }, set from the dashboard/CLI
  const metrics = Metrics.fromJSON(readJson(files.metrics), { now });
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
    const job = store.get(jobId);
    return !!job && job.status === 'running' && hasModel(w, job) && cardFits(w, job);
  };
  const queue = new RequestQueue({ now, canServe, rankOf: (id) => (id === '_' ? Infinity : store.rankOf(id)) });
  const liveCards = () => queue.activeWorkers().filter((w) => !w.paused);

  const saveState = () => writeJsonAtomic(files.state, { jobs: store.toJSON(), cardLabels: userLabels });
  const saveMetrics = () => { try { writeJsonAtomic(files.metrics, metrics.toJSON()); } catch (e) { log(`! couldn't save metrics: ${e.message}`); } };
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
      onProgress: (p) => { store.setProgress(job.id, advance(job.progress, p, now())); saver.schedule(); },
      onExit: (code) => {
        handles.delete(job.id);
        if (closing) return;   // the next host start records it as "host restarted"
        store.markFinished(job.id, code);
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
      metrics.record({ cardId: workerId, jobId: lease.jobId, ok: result.status >= 200 && result.status < 300, ms: now() - lease.leasedAt });
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
  function fullStatus(isLoopback) {
    const s = queue.status();
    const all = cards();
    const byMachine = new Map([...reports.keys()].map((m) => [m, []]));
    for (const c of all) {
      if (!byMachine.has(c.machine)) byMachine.set(c.machine, []);
      byMachine.get(c.machine).push(c);
    }
    return {
      jobs: store.list().map(publicJob), queueEta: queueEta(store.list()),
      perSec: s.perSec, queued: s.queued, inflight: s.inflight, done: s.done, models: s.models,
      workers: all, machines: [...byMachine].map(([machine, list]) => ({ machine, cards: list, report: reports.get(machine) || null })),
      templates: templates.map((t) => ({ id: t.id, name: t.name, params: t.params, models: t.models || [], selector: t.selector || '' })),
      settings: { maxRunning }, canCreate: isLoopback,
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

  function logTail(job, lines) {
    try {
      const text = fs.readFileSync(path.join(files.logs, `${job.id}.log`), 'utf8');
      return text.split(/\r?\n|\r/).slice(-lines).join('\n');
    } catch { return ''; }
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
    if (req.method === 'GET' && STATIC[p]) {
      try { return send(res, 200, fs.readFileSync(path.join(DASHBOARD, p.slice(1))), STATIC[p]); } catch { return send(res, 404, 'not found', 'text/plain'); }
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
      reports.set(b.machine, { ...b, seenAt: now() });
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && p === '/pool/wants') {
      return send(res, 200, { cards: wantsFor(url.searchParams.get('machine') || '') });
    }
    if (req.method === 'POST' && p === '/pool/pause') {
      const b = await readJsonBody(req);
      const w = queue.workers.get(b.id);
      // The machine's owner has the final say: only they can resume what they paused.
      if (w && !b.paused && ownerHolds(w)) throw new HttpError(409, `paused on its machine: ${ownerOf(w).reason || ownerOf(w).state}`);
      if (!queue.setPaused(b.id, b.paused)) throw new HttpError(404, 'unknown card');
      changed();
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && p === '/pool/info') {
      return send(res, 200, { token, port: listenPort, urls: lanAddresses().map((a) => `http://${a}:${listenPort}`) });
    }

    // Control API.
    if (req.method === 'GET' && p === '/ob/status') return send(res, 200, fullStatus(loopback));
    if (req.method === 'GET' && p === '/ob/metrics') {
      const by = url.searchParams.get('by') === 'job' ? 'job' : 'card';
      const minutes = Math.min(1440, Math.max(1, Number(url.searchParams.get('minutes')) || 60));
      return send(res, 200, metrics.series({ by, minutes }));
    }
    if (req.method === 'POST' && p === '/ob/jobs') return send(res, 200, publicJob(newJob(await readJsonBody(req), loopback)));
    if ((m = p.match(/^\/ob\/jobs\/([\w-]+)\/(\w+)$/))) {
      const job = jobOr404(m[1]);
      if (req.method === 'GET' && m[2] === 'log') {
        return send(res, 200, logTail(job, Math.min(5000, Number(url.searchParams.get('tail')) || 200)), 'text/plain; charset=utf-8');
      }
      if (req.method === 'POST' && m[2] === 'progress') {
        if (!loopback) throw new HttpError(403, 'progress comes from the job itself');
        const b = await readJsonBody(req);
        if (!Number.isFinite(Number(b.done))) throw new HttpError(400, 'done must be a number');
        store.setProgress(job.id, advance(job.progress, { done: Number(b.done), total: b.total == null ? undefined : Number(b.total) }, now()));
        saver.schedule();
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && JOB_ACTIONS.has(m[2])) return send(res, 200, await jobAction(job, m[2], await readJsonBody(req)));
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

  const timers = [
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
    } catch (e) { log(`! local Ollama not joined (${e.message})`); }
  }
  tick();

  return {
    port: listenPort, token, store, queue,
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
