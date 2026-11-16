// The machine agent: finds this machine's GPUs, runs one pinned Ollama per
// card, lends them to the host by its owner's rules, tunes each card's slots
// by measurement, and keeps a model playground filled with what the pool
// wants. Every 10 s it re-checks everything and reports to the host.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { detectCards, cardLabels, execRun } from './probes.mjs';
import { CardServer, pickPorts, isPortFree } from './server.mjs';
import { SlotTuner } from './tuner.mjs';
import { LendPolicy } from './policy.mjs';
import { startWatcher, learnLuids, ownPids, cardsInUse } from './inuse.mjs';
import { listModels, linkModel, removeModel, usage, planEviction, remoteSize, cleanPartial } from './playground.mjs';
import { loadConfig, saveConfig } from './config.mjs';
import { readJson, writeJsonAtomic } from '../state.mjs';
import { startCardWorker } from '../card-worker.mjs';
import { listenBeacons, BEACON_PORT } from '../discovery.mjs';

const GB = 1024 ** 3, MB = 1024 ** 2;
const VERSION = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

export async function startAgent({
  dir = path.join(os.homedir(), '.ollabatch', 'agent'), host, password, trusted = false,
  machine = os.hostname(), run = execRun, platform = process.platform,
  ollama = { command: 'ollama', args: [] }, serverEnv = () => ({}),
  userStore = process.env.OLLAMA_MODELS || path.join(os.homedir(), '.ollama', 'models'),
  now = Date.now, tickMs = 10_000, basePort = 11440, beaconPort = BEACON_PORT,
  watcher = startWatcher, fetchRegistry = globalThis.fetch, log = () => {},
} = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const cfg = loadConfig(dir, { trusted });
  if (host) cfg.host = host.replace(/\/+$/, '');
  if (password) cfg.password = password;
  const save = () => { try { saveConfig(dir, cfg); } catch (e) { log(`! couldn't save config: ${e.message}`); } };
  save();
  const tunings = readJson(path.join(dir, 'tuning.json')) || {};
  const logDir = path.join(dir, 'logs');
  const policy = new LendPolicy({ now });
  const cards = new Map();   // cardId → { card, server, worker, tuner, state, reason, version }
  let inUse = new Set();
  let download = null;
  let closed = false;

  const cardCfg = (id) => (cfg.cards[id] ??= {});
  const headers = () => ({ 'Content-Type': 'application/json', 'x-pool-token': cfg.password || '' });
  const workerId = (id) => `${machine}-${id}`;

  const beacons = await listenBeacons({ port: beaconPort });
  const watch = watcher({
    platform,
    onSample: (sample) => {
      const pids = Object.fromEntries([...cards].filter(([, c]) => c.server?.child?.pid).map(([id, c]) => [id, c.server.child.pid]));
      inUse = cardsInUse(sample, { luids: learnLuids(sample, pids), ownPids: ownPids(sample, pids), cards: [...cards.values()].map((c) => c.card) });
    },
  });

  async function ensureServer(c) {
    if (c.server || c.card.integrated || cardCfg(c.card.id).disabled) return;
    const [port] = await pickPorts(1, isPortFree, basePort + c.index * 2);
    const saved = tunings[c.card.id];
    c.server = new CardServer({
      card: c.card, port, slots: saved?.slots || 1, playground: cfg.playground.path, ollama, logDir, log,
      vulkanCandidates: [...cards.keys()].map((_, i) => i),
      // The agent's servers share one playground; never let one prune what another is pulling.
      extraEnv: { OLLAMA_NOPRUNE: '1', ...serverEnv(c.card) },
    });
    c.server.on('crash', () => { c.tuner?.onRestart(); c.worker?.setPaused(true, 'restarting'); });
    c.server.on('ready', () => { c.tuner?.onRestart(); });
    const r = await c.server.start();
    if (!r.confirmed) return;
    try { c.version = (await (await fetch(`${c.server.url}/api/version`)).json()).version; } catch { c.version = null; }
    c.tuner = new SlotTuner({ now, saved, ollamaVersion: c.version });
    if (c.tuner.slots !== c.server.slots) await c.server.restart(c.tuner.slots);
  }

  async function apply() {
    const ids = [...cards.keys()];
    const ownerPaused = new Set(ids.filter((id) => cardCfg(id).paused));
    const decisions = policy.evaluate({ policy: cfg.policy, schedule: cfg.schedule, inUse, ownerPaused, cards: ids });
    for (const [id, c] of cards) {
      const d = decisions[id];
      if (c.card.integrated) { Object.assign(c, { state: 'disabled', reason: 'integrated GPU (not lent by default)' }); continue; }
      if (cardCfg(id).disabled) { Object.assign(c, { state: 'disabled', reason: 'lending turned off for this card' }); if (c.worker) await c.worker.setPaused(true, 'disabled'); continue; }
      if (!c.server || c.server.state !== 'ready') {
        Object.assign(c, { state: c.server?.state || 'starting', reason: c.server?.state === 'misconfigured' ? `its server never picked this GPU (saw "${c.server.gpuName}")` : null });
        continue;
      }
      if (!cfg.host) { Object.assign(c, { state: 'not-joined', reason: 'not joined to a pool yet' }); continue; }
      if (!d.lend) {
        Object.assign(c, { state: d.reason, reason: REASONS[d.reason] });
        if (c.worker) await c.worker.setPaused(true, d.reason);
        continue;
      }
      Object.assign(c, { state: 'lending', reason: null });
      if (!c.worker) {
        try {
          c.worker = await startCardWorker({ hostUrl: cfg.host, password: cfg.password || '', ollama: c.server.url, slots: c.server.slots,
            id: workerId(id), label: c.card.name, machine, log,
            labels: { ...cardLabels(c.card), ...(cardCfg(id).labels || {}) },
            hardware: { name: c.card.name, vendor: c.card.vendor, vramMB: c.card.vramMB } });
        } catch (e) { Object.assign(c, { state: 'not-joined', reason: `can't reach the host: ${e.message}` }); continue; }
      } else {
        await c.worker.setPaused(false);
      }
    }
  }

  async function tune() {
    for (const [id, c] of cards) {
      if (c.state !== 'lending' || !c.worker || !c.tuner) continue;
      const st = c.worker.stats();
      const act = c.tuner.observe({ completed: st.done, oomErrors: st.oomErrors, freeMB: c.card.freeMB, totalMB: c.card.vramMB, queued: st.inflight > 0 });
      if (act) {
        await c.worker.setPaused(true, 'retuning');
        await c.server.restart(act.setSlots);
        await c.worker.setSlots(act.setSlots);
        c.tuner.onRestart();
        await c.worker.setPaused(false);
      }
      if (c.tuner.phase !== 'measuring' && tunings[id]?.measuredAt !== c.tuner.measuredAt) {
        tunings[id] = c.tuner.toJSON();
        try { writeJsonAtomic(path.join(dir, 'tuning.json'), tunings); } catch { /* next time */ }
      }
    }
  }

  // What the pool wants on this machine, by the owner's rules — checked when
  // the host asks and again right before acting.
  async function models() {
    if (!cfg.host || download) return;
    let wants;
    try {
      const r = await fetch(`${cfg.host}/pool/wants?machine=${encodeURIComponent(machine)}`, { headers: headers(), signal: AbortSignal.timeout(5000) });
      if (!r.ok) return;
      wants = (await r.json()).cards || {};
    } catch { return; }
    const pg = cfg.playground;
    const have = () => new Set(listModels(pg.path).map((m) => m.name));
    const wanted = new Set(Object.values(wants).flat());
    for (const m of wanted) pg.lastUsed[m] = now();
    const userModels = new Set(listModels(userStore).map((m) => m.name));
    for (const [wid, list] of Object.entries(wants)) {
      const c = [...cards.values()].find((x) => workerId(x.card.id) === wid);
      if (!c?.worker) continue;
      for (const model of list) {
        if (have().has(model)) continue;
        if (userModels.has(model)) {
          try { linkModel(userStore, pg.path, model); log(`linked ${model} from this machine's own models`); } catch (e) { log(`! couldn't link ${model}: ${e.message}`); continue; }
          await refreshAll();
          continue;
        }
        if (!pg.downloads) continue;
        const size = await remoteSize(model, { fetch: fetchRegistry });
        if (size == null || size + GB > c.card.vramMB * MB) continue;
        if (!cfg.playground.downloads) continue;   // the owner may have changed their mind meanwhile
        const all = listModels(pg.path);
        const plan = planEviction({ models: usage(pg.path, all).models, needBytes: size, limitBytes: pg.limitGB * GB,
          usedBytes: usage(pg.path, all).usedBytes, locked: new Set(pg.locked), inUse: wanted, lastUsed: pg.lastUsed });
        if (!plan) continue;
        for (const name of plan) {
          if (cfg.playground.locked.includes(name) || wanted.has(name)) continue;
          await del(c, name);
        }
        await pull(c, model, size);
        await refreshAll();
        return;   // one download at a time
      }
    }
  }

  async function del(c, name) {
    try { await fetch(`${c.server.url}/api/delete`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: name }) }); }
    catch { removeModel(cfg.playground.path, name); }
  }

  async function pull(c, model, size) {
    download = { model, completed: 0, total: size };
    try {
      const r = await fetch(`${c.server.url}/api/pull`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, stream: true }) });
      const text = await r.text();
      for (const line of text.split('\n').filter(Boolean)) {
        const m = JSON.parse(line);
        if (m.error) throw new Error(m.error);
        if (m.completed) download.completed = m.completed;
      }
      log(`downloaded ${model}`);
    } catch (e) {
      log(`! download of ${model} failed: ${e.message}`);
      cleanPartial(cfg.playground.path);
    } finally {
      download = null;
    }
  }

  async function refreshAll() { for (const c of cards.values()) await c.worker?.refreshModels(); }

  function report() {
    const pg = cfg.playground;
    const all = listModels(pg.path);
    const u = usage(pg.path, all);
    return {
      machine, os: platform, agent: VERSION, policy: cfg.policy, watcher: watch.supported !== false,
      cards: [...cards.values()].map((c) => ({
        id: c.card.id, workerId: c.worker ? workerId(c.card.id) : null, name: c.card.name, vendor: c.card.vendor,
        vramMB: c.card.vramMB, freeMB: c.card.freeMB, util: c.card.util, tempC: c.card.tempC, powerW: c.card.powerW,
        display: c.card.display, state: c.state, reason: c.reason, slots: c.server?.slots ?? null,
        tuning: c.tuner ? (c.tuner.phase === 'measuring' ? `trying ${c.tuner.slots}` : 'tuned') : null,
      })),
      playground: { path: pg.path, limitGB: pg.limitGB, usedBytes: u.usedBytes, downloads: pg.downloads,
        models: u.models.map((m) => ({ ...m, locked: pg.locked.includes(m.name) })) },
      download,
    };
  }

  async function sendReport() {
    if (!cfg.host) return;
    try { await fetch(`${cfg.host}/pool/machine`, { method: 'POST', headers: headers(), body: JSON.stringify(report()), signal: AbortSignal.timeout(5000) }); }
    catch { /* host down: the next tick tries again */ }
  }

  let ticking = false;
  async function tick() {
    if (ticking || closed) return;
    ticking = true;
    try {
      const found = await detectCards({ run, platform });
      found.forEach((card, index) => {
        const c = cards.get(card.id);
        if (c) c.card = card; else cards.set(card.id, { card, index, server: null, worker: null, tuner: null, state: 'starting', reason: null });
      });
      for (const c of cards.values()) await ensureServer(c);
      await apply();
      await tune();
      await models();
      await sendReport();
    } catch (e) {
      log(`! agent tick: ${e.message}`);
    } finally {
      ticking = false;
    }
  }

  await tick();
  const timer = setInterval(tick, tickMs);

  const api = {
    status() {
      const r = report();
      return { ...r, host: cfg.host, joined: !!cfg.host, schedule: cfg.schedule, hostsFound: [...beacons.hosts().values()],
        cards: r.cards.map((c) => ({ ...c, paused: !!cardCfg(c.id).paused, disabled: !!cardCfg(c.id).disabled, labels: cardCfg(c.id).labels || {} })) };
    },
    async act(a) {
      const card = a.card && cards.get(a.card);
      if (a.card && !card) throw new Error(`no card ${a.card}`);
      switch (a.type) {
        case 'pause': cardCfg(a.card).paused = true; break;
        case 'resume': cardCfg(a.card).paused = false; break;
        case 'disable': cardCfg(a.card).disabled = true; break;
        case 'enable': cardCfg(a.card).disabled = false; break;
        case 'policy':
          if (!['when-free', 'always', 'schedule', 'never'].includes(a.policy)) throw new Error('policy is when-free, always, schedule or never');
          cfg.policy = a.policy;
          if (Array.isArray(a.schedule)) cfg.schedule = a.schedule;
          break;
        case 'playground':
          if (a.limitGB != null) cfg.playground.limitGB = Math.max(1, Number(a.limitGB));
          if (a.downloads != null) cfg.playground.downloads = !!a.downloads;
          if (a.path) cfg.playground.path = String(a.path);   // takes effect when the servers next start
          break;
        case 'lock': if (!cfg.playground.locked.includes(a.model)) cfg.playground.locked.push(a.model); break;
        case 'unlock': cfg.playground.locked = cfg.playground.locked.filter((m) => m !== a.model); break;
        case 'remove': {
          if (cfg.playground.locked.includes(a.model)) throw new Error(`${a.model} is locked`);
          const any = [...cards.values()].find((c) => c.server?.state === 'ready');
          if (any) await del(any, a.model); else removeModel(cfg.playground.path, a.model);
          await refreshAll();
          break;
        }
        case 'join': {
          if (!/^http:\/\/[A-Za-z0-9.\-]+:\d+\/?$/.test(a.url || '')) throw new Error('the host URL should look like http://192.168.1.20:11500');
          for (const c of cards.values()) { await c.worker?.leave(); c.worker = null; }
          cfg.host = a.url.replace(/\/+$/, '');
          cfg.password = String(a.password || '');
          break;
        }
        case 'leave':
          for (const c of cards.values()) { await c.worker?.leave(); c.worker = null; }
          cfg.host = null;
          break;
        default: throw new Error(`unknown action ${a.type}`);
      }
      save();
      await apply();
      await sendReport();
    },
    async close() {
      closed = true;
      clearInterval(timer);
      watch.stop();
      beacons.stop();
      for (const c of cards.values()) { await c.worker?.leave(); await c.server?.stop(); }
    },
  };
  return api;
}

const REASONS = {
  'paused-by-owner': 'paused on this machine',
  'paused-in-use': 'a fullscreen program is using this GPU',
  'outside-schedule': 'outside the lending schedule',
  never: 'lending is off on this machine',
};
