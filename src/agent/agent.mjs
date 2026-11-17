// The machine agent: finds this machine's GPUs, runs one pinned Ollama per
// card, lends them to the host by its owner's rules, tunes each card's slots
// by measurement, and keeps a model playground filled with what the pool
// wants. Every 10 s it re-checks everything and reports to the host.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { detectCards, cardLabels, execRun, backendFromLog } from './probes.mjs';
import { CardServer, pickPorts, isPortFree } from './server.mjs';
import { SlotTuner } from './tuner.mjs';
import { LendPolicy } from './policy.mjs';
import { startWatcher, learnLuids, ownPids, cardsInUse, rememberLuids, adapterStats } from './inuse.mjs';
import { listModels, linkModel, removeModel, usage, planEviction, remoteSize, cleanPartial } from './playground.mjs';
import { loadConfig, saveConfig } from './config.mjs';
import { readJson, writeJsonAtomic } from '../state.mjs';
import { startCardWorker } from '../card-worker.mjs';
import { listenBeacons, BEACON_PORT } from '../discovery.mjs';
import { recordServers, reapRecorded } from './reap.mjs';
import { validSchedule } from '../remote.mjs';

const GB = 1024 ** 3, MB = 1024 ** 2;
const STALL_MS = 120_000;                 // a download with no progress this long is abandoned
const RETRY_BASE_MS = 10 * 60_000, RETRY_MAX_MS = 6 * 60 * 60_000;
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
  const serversFile = path.join(dir, 'servers.json');
  const reaped = await reapRecorded({ file: serversFile });
  if (reaped.length) log(`stopped ${reaped.length} Ollama server(s) a previous agent left running`);
  const cfg = loadConfig(dir, { trusted });
  if (host) cfg.host = host.replace(/\/+$/, '');
  if (password) cfg.password = password;
  const save = () => { try { saveConfig(dir, cfg); } catch (e) { log(`! couldn't save config: ${e.message}`); } };
  save();
  const tunings = readJson(path.join(dir, 'tuning.json')) || {};
  // Adapter LUIDs only change when Windows restarts: keep what was learned for
  // this boot, so a restarted agent shows an idle Arc's use and memory at once.
  const luidFile = path.join(dir, 'luids.json');
  const bootAt = Date.now() - os.uptime() * 1000;
  const savedLuids = readJson(luidFile);
  const logDir = path.join(dir, 'logs');
  const policy = new LendPolicy({ now });
  const cards = new Map();   // cardId → { card, server, worker, tuner, state, reason, version }
  let inUse = new Set();
  let luids = savedLuids && Math.abs(savedLuids.bootAt - bootAt) < 120_000 ? savedLuids.luids || {} : {};   // cardId → adapter LUID
  let adapters = { at: 0, stats: {} };   // the latest per-adapter use and memory (Windows)
  let download = null;
  const failures = {};   // model → { count, until }: downloads back off after failing
  let closed = false;

  const cardCfg = (id) => (cfg.cards[id] ??= {});

  // Every setting the owner (on the local page) or, when they allow it, the
  // pool (from the dashboard) can change, by field. `norm` is what `set`
  // would store, so "does this PC differ from what the pool asked" compares like with like.
  const POLICIES = ['when-free', 'always', 'schedule', 'never'];
  const slotsOf = (v) => {
    if (v == null || v === 'auto') return 'auto';
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 8) throw new Error('slots is auto or a number from 1 to 8');
    return n;
  };
  const FIELDS = {
    policy: { get: () => cfg.policy, norm: (v) => v,
      set: (v) => { if (!POLICIES.includes(v)) throw new Error('policy is when-free, always, schedule or never'); cfg.policy = v; } },
    schedule: { get: () => cfg.schedule, norm: (v) => v,
      set: (v) => { if (!validSchedule(v)) throw new Error('a schedule is a list of { days: [0-6], from: "HH:MM", to: "HH:MM" }'); cfg.schedule = v; } },
    'playground.limitGB': { get: () => cfg.playground.limitGB, norm: (v) => Math.max(1, Number(v)),
      set: (v) => { if (!Number.isFinite(Number(v))) throw new Error('the playground limit must be a number of GB'); cfg.playground.limitGB = Math.max(1, Number(v)); } },
    'playground.downloads': { get: () => cfg.playground.downloads, norm: (v) => !!v, set: (v) => { cfg.playground.downloads = !!v; } },
    locked: { get: () => cfg.playground.locked, norm: (v) => (Array.isArray(v) ? [...new Set(v.map(String))] : v),
      set: (v) => { if (!Array.isArray(v)) throw new Error('locked must be a list of models'); cfg.playground.locked = [...new Set(v.map(String))]; } },
  };
  function field(name) {
    if (FIELDS[name]) return FIELDS[name];
    const m = /^cards\.([\w-]+)\.(paused|disabled|slots)$/.exec(name);
    if (!m) return null;
    const [, id, k] = m;
    if (!cards.has(id)) return null;
    if (k === 'slots') {
      return { get: () => cardCfg(id).slots ?? 'auto', norm: (v) => { try { return slotsOf(v); } catch { return v; } },
        set: (v) => { const n = slotsOf(v); if (n === 'auto') delete cardCfg(id).slots; else cardCfg(id).slots = n; } };
    }
    return { get: () => !!cardCfg(id)[k], norm: (v) => !!v, set: (v) => { cardCfg(id)[k] = !!v; } };
  }
  const setLocal = (name, value) => {
    const fl = field(name);
    if (!fl) throw new Error(`no ${name} on this machine`);
    fl.set(value);
    cfg.changedAt[name] = now();
    if (name === 'policy') cfg.policyBy = 'owner';
  };
  const headers = () => ({ 'Content-Type': 'application/json', 'x-pool-token': cfg.password || '' });
  const workerId = (id) => `${machine}-${id}`;

  const beacons = await listenBeacons({ port: beaconPort });
  const watch = watcher({
    platform,
    onSample: (sample) => {
      const pids = Object.fromEntries([...cards].filter(([, c]) => c.server?.child?.pid).map(([id, c]) => [id, c.server.child.pid]));
      const next = rememberLuids(luids, learnLuids(sample, pids));
      if (JSON.stringify(next) !== JSON.stringify(luids)) { try { writeJsonAtomic(luidFile, { bootAt, luids: next }); } catch { /* next time */ } }
      luids = next;
      adapters = { at: Date.now(), stats: adapterStats(sample) };
      inUse = cardsInUse(sample, { luids, ownPids: ownPids(sample, pids), cards: [...cards.values()].map((c) => c.card) });
    },
  });

  const record = () => recordServers(serversFile,
    Object.fromEntries([...cards].filter(([, c]) => c.server?.child?.pid).map(([id, c]) => [id, c.server.child.pid])));

  async function ensureServer(c) {
    if (c.server || c.card.integrated || cardCfg(c.card.id).disabled) return;
    const [port] = await pickPorts(1, isPortFree, basePort + c.index * 2);
    const saved = tunings[c.card.id];
    const fixed = cardCfg(c.card.id).slots;
    c.server = new CardServer({
      card: c.card, port, slots: fixed || saved?.slots || 1, playground: cfg.playground.path, ollama, logDir, log,
      vulkanCandidates: [...cards.keys()].map((_, i) => i),
      // The agent's servers share one playground; never let one prune what another is pulling.
      extraEnv: { OLLAMA_NOPRUNE: '1', ...serverEnv(c.card) },
    });
    c.server.on('crash', () => { c.tuner?.onRestart(); c.worker?.setPaused(true, 'restarting'); });
    c.server.on('ready', () => { c.tuner?.onRestart(); record(); });
    const r = await c.server.start();
    if (!r.confirmed) return;
    try { c.version = (await (await fetch(`${c.server.url}/api/version`)).json()).version; } catch { c.version = null; }
    c.tuner = new SlotTuner({ now, saved, ollamaVersion: c.version });
    if (!fixed && c.tuner.slots !== c.server.slots) await c.server.restart(c.tuner.slots);
  }

  async function apply() {
    const ids = [...cards.keys()];
    const ownerPaused = new Set(ids.filter((id) => cardCfg(id).paused));
    // A policy the pool set never lends a card while a fullscreen program uses
    // it: managing a PC from the dashboard can't take a game's GPU.
    const decisions = policy.evaluate({ policy: cfg.policy, schedule: cfg.schedule, inUse, ownerPaused, cards: ids, stepAside: cfg.policyBy === 'pool' });
    for (const [id, c] of cards) {
      const d = decisions[id];
      if (c.card.integrated) { Object.assign(c, { state: 'disabled', reason: 'integrated GPU (not lent by default)' }); continue; }
      if (cardCfg(id).disabled) { Object.assign(c, { state: 'disabled', reason: 'lending turned off for this card' }); if (c.worker) await c.worker.setPaused(true, 'disabled'); continue; }
      if (!c.server || c.server.state !== 'ready') {
        Object.assign(c, { state: c.server?.state || 'starting', reason: c.server?.state === 'misconfigured' ? `its server never picked this GPU (saw "${c.server.gpuName}")` : null });
        if (c.worker) await c.worker.setPaused(true, 'restarting');   // never lease work to a dead port
        continue;
      }
      if (!cfg.host) { Object.assign(c, { state: 'not-joined', reason: 'not joined to a pool yet' }); continue; }
      if (!d.lend) {
        Object.assign(c, { state: d.reason, reason: REASONS[d.reason] });
        if (c.worker) await c.worker.setPaused(true, d.reason);
        continue;
      }
      Object.assign(c, { state: 'lending', reason: null });
      // Lending, but the host isn't answering: say so (its models are freed
      // after the idle time) instead of looking busy.
      const down = c.worker?.stats().hostDownSince;
      if (down && Date.now() - down > 20_000) {
        const at = new Date(down);
        Object.assign(c, { state: 'waiting-for-host', reason: `the pool's host (${cfg.host}) hasn't answered since ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}; GPU memory is freed after 5 idle minutes, and it carries on when the host is back` });
      }
      if (!c.worker) {
        try {
          c.worker = await startCardWorker({ hostUrl: cfg.host, password: cfg.password || '', ollama: c.server.url, slots: c.server.slots,
            id: workerId(id), label: c.card.name, machine, log, releaseNetworkErrors: true,
            labels: { ...cardLabels(c.card), ...(cardCfg(id).labels || {}) },
            hardware: { name: c.card.name, vendor: c.card.vendor, vramMB: c.card.vramMB } });
        } catch (e) {
          // The host is down or restarting: wait for it (retried every check), not "not joined".
          const unreachable = /fetch failed|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|timeout/i.test(`${e.message} ${e.cause?.code || ''}`);
          Object.assign(c, unreachable
            ? { state: 'waiting-for-host', reason: `the pool's host (${cfg.host}) isn't answering; this card joins as soon as it does` }
            : { state: 'not-joined', reason: `the host turned this card away: ${e.message}` });
          continue;
        }
      } else if (c.pausedFor) {
        c.tuner?.onRestart();   // a fresh measurement after a pause
        await c.worker.setPaused(false);
      }
      c.pausedFor = null;
    }
    for (const c of cards.values()) if (c.state !== 'lending' && c.state !== 'waiting-for-host' && c.worker) c.pausedFor = c.state;
  }

  // Restart a card's server (a slot change, or by request) without leasing
  // work to it meanwhile; resumes only if it was lending before.
  async function restartCard(c, slots) {
    const lending = c.state === 'lending';
    await c.worker?.setPaused(true, 'restarting');
    const r = await c.server.restart(slots);
    await c.worker?.setSlots(slots);
    c.tuner?.onRestart();
    if (lending && r.confirmed) await c.worker?.setPaused(false);
    else if (lending) c.pausedFor = 'restarting';   // the next apply() resumes it once the server is back
    return r;
  }

  async function tune() {
    for (const [id, c] of cards) {
      if (c.state !== 'lending' || !c.worker || !c.tuner) continue;
      // Slots fixed by the owner (or the pool): no measuring, just hold them.
      const fixed = cardCfg(id).slots;
      if (fixed) {
        c.fixed = true;
        if (c.server.slots !== fixed) await restartCard(c, fixed);
        continue;
      }
      if (c.fixed) {   // back to auto: pick up where the saved tuning left off
        c.fixed = false;
        c.tuner = new SlotTuner({ now, saved: tunings[id], ollamaVersion: c.version });
        if (c.tuner.slots !== c.server.slots) await restartCard(c, c.tuner.slots);
        continue;
      }
      const st = c.worker.stats();
      const act = c.tuner.observe({ completed: st.done, oomErrors: st.oomErrors, freeMB: c.card.freeMB, totalMB: c.card.vramMB, queued: st.inflight > 0 });
      if (act) {
        await c.worker.setPaused(true, 'retuning');
        const r = await c.server.restart(act.setSlots);
        await c.worker.setSlots(act.setSlots);
        c.tuner.onRestart();
        if (r.confirmed) await c.worker.setPaused(false);
        else c.pausedFor = 'restarting';   // the next apply() resumes it once the server is back
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
        if (failures[model] && now() < failures[model].until) continue;   // backing off after a failed try
        try { await startPull(model, { card: c, keep: wanted }); } catch (e) { if (/disk/.test(e.message)) log(`! ${e.message}`); continue; }
        return;   // one download at a time
      }
    }
  }

  // Every download, whoever asks (the pool's wants, a dashboard command, the
  // owner on the local page), keeps to the owner's limits: downloads allowed
  // (the owner's own request is that permission), the model fits a card, and
  // the playground limit and free disk hold after evicting unlocked models.
  async function startPull(model, { card = null, keep = new Set(), byOwner = false } = {}) {
    if (!model) throw new Error('which model?');
    if (download) throw new Error(`already downloading ${download.model}`);
    const pg = cfg.playground;
    if (!byOwner && !pg.downloads) throw new Error("downloads aren't allowed on this PC; its owner can allow them on its page");
    const ready = card ? [card] : [...cards.values()].filter((x) => x.server?.state === 'ready').sort((a, b) => b.card.vramMB - a.card.vramMB);
    if (!ready.length) throw new Error('no card server is running yet');
    const size = await remoteSize(model, { fetch: fetchRegistry });
    if (size == null) throw new Error(`couldn't find ${model} in the Ollama registry`);
    if (!byOwner && !pg.downloads) throw new Error("downloads aren't allowed on this PC; its owner can allow them on its page");   // they may have changed their mind meanwhile
    const c = ready.find((x) => size + GB <= x.card.vramMB * MB);
    if (!c) throw new Error(`${model} (${(size / GB).toFixed(1)} GB) is too big for ${card ? card.card.name : 'any card here'}`);
    if (download) throw new Error(`already downloading ${download.model}`);
    const inUse = new Set([...keep, ...[...cards.values()].flatMap((x) => x.loaded || [])]);
    const all = listModels(pg.path);
    const u = usage(pg.path, all);
    const plan = planEviction({ models: u.models, needBytes: size, limitBytes: pg.limitGB * GB, usedBytes: u.usedBytes,
      locked: new Set(pg.locked), inUse, lastUsed: pg.lastUsed });
    if (!plan) throw new Error(`${model} (${(size / GB).toFixed(1)} GB) doesn't fit in this PC's ${pg.limitGB} GB model space, even after removing unlocked models`);
    if (!diskHas(size + 2 * GB)) throw new Error(`not enough free disk for ${model}`);
    for (const name of plan) if (!pg.locked.includes(name) && !inUse.has(name)) await del(c, name);
    pg.lastUsed[model] = now();   // so the next eviction doesn't take it straight back out
    // In the background: a long download must not stop the agent's checks
    // (a game starting, the owner pausing) or its reports.
    download = { model, completed: 0, total: size };
    pull(c, model).then(refreshAll).catch(() => {});
  }

  async function removeLocal(model) {
    if (cfg.playground.locked.includes(model)) throw new Error(`${model} is locked`);
    const any = [...cards.values()].find((c) => c.server?.state === 'ready');
    if (any) await del(any, model); else removeModel(cfg.playground.path, model);
    await refreshAll();
  }

  async function runCommand(cmd) {
    const c = cmd.card ? cards.get(cmd.card) : null;
    if (cmd.card && !c) throw new Error(`no card ${cmd.card} on this machine`);
    switch (cmd.type) {
      case 'restart-card': {
        if (!c?.server) throw new Error('that card has no server to restart');
        const r = await restartCard(c, c.server.slots);
        if (!r.confirmed) throw new Error(`${c.card.name}'s server hasn't come back yet; the agent keeps trying`);
        return;
      }
      case 'retune': {
        if (!c?.server) throw new Error('that card has no server yet');
        if (cardCfg(cmd.card).slots) throw new Error(`slots are fixed at ${cardCfg(cmd.card).slots}; set them to auto first`);
        delete tunings[cmd.card];
        try { writeJsonAtomic(path.join(dir, 'tuning.json'), tunings); } catch { /* next time */ }
        c.tuner = new SlotTuner({ now, saved: null, ollamaVersion: c.version });
        await restartCard(c, c.tuner.slots);
        log(`re-tuning ${c.card.name} from 1 slot`);
        return;
      }
      case 'pull': return startPull(cmd.model);
      case 'remove-model': return removeLocal(cmd.model);
      default: throw new Error(`unknown command ${cmd.type}`);
    }
  }

  // Settings and commands from the pool, pulled each tick (agents only ever
  // connect out). A field the pool set is applied only if the owner hasn't
  // changed it here since; comparing needs the host's clock against ours, so
  // the host sends its time and we correct for the difference.
  let localOverride = [];
  async function syncRemote() {
    if (!cfg.host) return;
    const q = `machine=${encodeURIComponent(machine)}`;
    if (cfg.remote) {
      try {
        const t0 = now();
        const r = await fetch(`${cfg.host}/pool/settings?${q}`, { headers: headers(), signal: AbortSignal.timeout(5000) });
        if (r.ok) {
          const d = await r.json();
          const skew = d.now != null ? d.now - (t0 + now()) / 2 : 0;
          let dirty = false;
          for (const [name, f] of Object.entries(d.fields || {})) {
            const fl = field(name);
            if (!fl || cfg.remoteSeen[name] === f.at) continue;
            cfg.remoteSeen[name] = f.at;
            dirty = true;
            if ((cfg.changedAt[name] ?? 0) >= f.at - skew) continue;   // the owner changed it here since
            try { fl.set(f.value); cfg.changedAt[name] = f.at - skew; if (name === 'policy') cfg.policyBy = 'pool'; log(`the pool set ${name}`); }
            catch (e) { log(`! the pool's ${name} was refused: ${e.message}`); }
          }
          if (cfg.remoteVersion !== d.version) { cfg.remoteVersion = d.version; dirty = true; }
          localOverride = Object.entries(d.fields || {})
            .filter(([name, f]) => field(name) && JSON.stringify(field(name).get()) !== JSON.stringify(field(name).norm(f.value)))
            .map(([name]) => name);
          if (dirty) save();
        }
      } catch { /* host down: next tick */ }
    } else localOverride = [];
    let list;
    try {
      const r = await fetch(`${cfg.host}/pool/commands?${q}`, { headers: headers(), signal: AbortSignal.timeout(5000) });
      if (!r.ok) return;
      list = (await r.json()).commands || [];
    } catch { return; }
    for (const cmd of list) {
      let error = null;
      if (!cfg.remote) error = "rejected: this PC's owner hasn't let the pool manage it";
      else {
        try { await runCommand(cmd); log(`ran the pool's ${cmd.type}${cmd.card ? ` on ${cmd.card}` : ''}${cmd.model ? ` ${cmd.model}` : ''}`); }
        catch (e) { error = e.message; }
      }
      try {
        await fetch(`${cfg.host}/pool/commands/${encodeURIComponent(cmd.id)}`, { method: 'POST', headers: headers(),
          body: JSON.stringify({ machine, ok: !error, error }), signal: AbortSignal.timeout(5000) });
      } catch { /* it expires on the host */ }
    }
  }

  // Which models each card's server has in memory right now.
  async function loaded() {
    await Promise.all([...cards.values()].map(async (c) => {
      if (c.server?.state !== 'ready') { c.loaded = []; return; }
      try { c.loaded = ((await (await fetch(`${c.server.url}/api/ps`, { signal: AbortSignal.timeout(1500) })).json()).models || []).map((m) => m.name); }
      catch { /* keep the last answer */ }
    }));
  }

  async function del(c, name) {
    try { await fetch(`${c.server.url}/api/delete`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: name }) }); }
    catch { removeModel(cfg.playground.path, name); }
  }

  function diskHas(bytes) {
    try {
      fs.mkdirSync(cfg.playground.path, { recursive: true });
      const s = fs.statfsSync(cfg.playground.path);
      return s.bavail * s.bsize >= bytes;
    } catch { return true; }   // can't tell here: let Ollama report a full disk
  }

  async function pull(c, model) {
    const ac = new AbortController();
    let stall = null;
    const arm = () => { clearTimeout(stall); stall = setTimeout(() => ac.abort(), STALL_MS); };
    try {
      arm();
      const r = await fetch(`${c.server.url}/api/pull`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, stream: true }), signal: ac.signal });
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '', ok = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        arm();
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines.filter(Boolean)) {
          const m = JSON.parse(line);
          if (m.error) throw new Error(m.error);
          if (m.completed) download.completed = m.completed;
          if (m.status === 'success') ok = true;
        }
      }
      if (!ok) throw new Error('the download ended before it finished');
      delete failures[model];
      log(`downloaded ${model}`);
    } catch (e) {
      const f = (failures[model] ??= { count: 0, until: 0 });
      f.count++;
      f.error = ac.signal.aborted ? 'it stalled for 2 minutes' : e.message;
      f.until = now() + Math.min(RETRY_BASE_MS * 2 ** (f.count - 1), RETRY_MAX_MS);
      log(`! download of ${model} failed (${ac.signal.aborted ? 'stalled' : e.message}); next try in ${Math.round((f.until - now()) / 60_000)} min`);
      cleanPartial(cfg.playground.path);   // drops half-written manifests; keeps Ollama's partial blobs so a retry resumes
    } finally {
      clearTimeout(stall);
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
      remote: !!cfg.remote, trusted: !!cfg.trusted, appliedVersion: cfg.remoteVersion, localOverride, schedule: cfg.schedule,
      cards: [...cards.values()].map((c) => ({
        id: c.card.id, workerId: c.worker ? workerId(c.card.id) : null, name: c.card.name, vendor: c.card.vendor,
        vramMB: c.card.vramMB, freeMB: c.card.freeMB, util: c.card.util, tempC: c.card.tempC, powerW: c.card.powerW,
        display: c.card.display, state: c.state, reason: c.reason, slots: c.server?.slots ?? null,
        backend: c.backend ?? null, fixedSlots: cardCfg(c.card.id).slots ?? 'auto', paused: !!cardCfg(c.card.id).paused, disabled: !!cardCfg(c.card.id).disabled, loadedModel: c.loaded?.[0] ?? null, loadedModels: c.loaded ?? [],
        tuning: c.tuner ? (c.tuner.phase === 'measuring' ? `trying ${c.tuner.slots}` : 'tuned') : null,
      })),
      playground: { path: pg.path, limitGB: pg.limitGB, usedBytes: u.usedBytes, downloads: pg.downloads,
        models: u.models.map((m) => ({ ...m, locked: pg.locked.includes(m.name) })) },
      download, downloadFailures: Object.fromEntries(Object.entries(failures).map(([m, f]) => [m, { count: f.count, until: f.until, error: f.error ?? null }])),
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
      let found = await detectCards({ run, platform });
      // Once nvidia-smi has named the NVIDIA cards, a moment it fails (a driver
      // reset, early boot) must not let the Windows list add them again under
      // another id: that would start a second server on the same GPU.
      if ([...cards.values()].some((c) => c.card.source === 'nvidia-smi')) {
        found = found.filter((c) => c.vendor !== 'nvidia' || c.source === 'nvidia-smi');
      }
      // Cards nvidia-smi doesn't cover (Intel Arc, AMD on Windows): use and
      // memory from Windows' own per-adapter counters, once we know the adapter.
      if (Date.now() - adapters.at < 20_000) {
        found = found.map((card) => {
          const st = card.source === 'windows' && luids[card.id] ? adapters.stats[luids[card.id]] ?? { util: 0, usedBytes: null } : null;
          return st ? { ...card, util: st.util, freeMB: st.usedBytes == null ? null : Math.max(0, card.vramMB - Math.round(st.usedBytes / MB)) } : card;
        });
      }
      found.forEach((card, index) => {
        const c = cards.get(card.id);
        if (c) c.card = card; else cards.set(card.id, { card, index, server: null, worker: null, tuner: null, state: 'starting', reason: null });
      });
      for (const c of cards.values()) await ensureServer(c);
      await syncRemote();
      await apply();
      await tune();
      await models();
      await loaded();
      for (const c of cards.values()) if (c.server) c.backend = backendFromLog(logTail(path.join(logDir, `ollama-${c.card.id}.log`))) ?? c.backend ?? null;
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
      return { ...r, host: cfg.host, joined: !!cfg.host, schedule: cfg.schedule, hostsFound: [...beacons.hosts().values()], downloadFailures: { ...failures },
        cards: r.cards.map((c) => ({ ...c, paused: !!cardCfg(c.id).paused, disabled: !!cardCfg(c.id).disabled, labels: cardCfg(c.id).labels || {} })) };
    },
    async act(a) {
      const card = a.card && cards.get(a.card);
      if (a.card && !card) throw new Error(`no card ${a.card}`);
      switch (a.type) {
        case 'pause': setLocal(`cards.${a.card}.paused`, true); break;
        case 'resume': setLocal(`cards.${a.card}.paused`, false); break;
        case 'disable': setLocal(`cards.${a.card}.disabled`, true); break;
        case 'enable': setLocal(`cards.${a.card}.disabled`, false); break;
        case 'slots': if (!card) throw new Error('which card?'); setLocal(`cards.${a.card}.slots`, a.slots); break;
        case 'policy':
          setLocal('policy', a.policy);
          if (Array.isArray(a.schedule)) setLocal('schedule', a.schedule);
          break;
        case 'playground':
          if (a.limitGB != null) setLocal('playground.limitGB', a.limitGB);
          if (a.downloads != null) setLocal('playground.downloads', a.downloads);
          if (a.path) cfg.playground.path = String(a.path);   // takes effect when the servers next start
          break;
        case 'lock': setLocal('locked', [...cfg.playground.locked, a.model]); break;
        case 'unlock': setLocal('locked', cfg.playground.locked.filter((m) => m !== a.model)); break;
        case 'remove': await removeLocal(a.model); break;
        case 'remote': cfg.remote = !!a.on; if (!cfg.remote) localOverride = []; break;
        case 'restart': await runCommand({ type: 'restart-card', card: a.card }); break;
        case 'retune': await runCommand({ type: 'retune', card: a.card }); break;
        case 'pull': await startPull(String(a.model || '').trim(), { byOwner: true }); break;
        case 'join': {
          if (!/^http:\/\/[A-Za-z0-9.\-]+:\d+\/?$/.test(a.url || '')) throw new Error('the host URL should look like http://192.168.1.20:11500');
          for (const c of cards.values()) { await c.worker?.leave(); c.worker = null; }
          const url = a.url.replace(/\/+$/, '');
          // Letting one pool manage this PC isn't letting the next one: switching
          // pools turns it off until the owner says so again.
          if (cfg.host && cfg.host !== url) Object.assign(cfg, { remote: false, remoteSeen: {}, remoteVersion: 0, policyBy: 'owner' });
          cfg.host = url;
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

// The end of a log file (a card server's log can grow large).
function logTail(file, bytes = 256 * 1024) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const buf = Buffer.alloc(Math.min(bytes, size));
      fs.readSync(fd, buf, 0, buf.length, size - buf.length);
      return buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

const REASONS = {
  'paused-by-owner': 'paused on this machine',
  'paused-in-use': 'a fullscreen program is using this GPU',
  'outside-schedule': 'outside the lending schedule',
  never: 'lending is off on this machine',
};
