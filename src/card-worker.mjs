// One card's connection to the host, steerable by the machine agent: pause
// (hand in-flight work back and free the GPU), change how many requests run
// at once, move to another host or server, leave. `join` is this with defaults.
import os from 'node:os';
import { makeUnloader, ollamaModels, REQUEST_TIMEOUT_MS } from './worker.mjs';

const OOM = /out of memory|failed to allocate|CUDA error: out of memory/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startCardWorker({
  hostUrl, password = '', ollama, slots = 2, id, label, labels = {},
  machine = os.hostname(), hardware = null, log = () => {}, releaseNetworkErrors = false,
}) {
  if (!/^https?:\/\//.test(hostUrl || '')) throw new Error('needs the host URL, e.g. http://192.168.1.20:11500');
  const s = {
    host: hostUrl.replace(/\/+$/, ''), password, ollama: ollama.replace(/\/+$/, ''), slots,
    models: await ollamaModels(ollama.replace(/\/+$/, '')), paused: false, hostPaused: false, stopped: false,
    done: 0, failed: 0, oomErrors: 0, recentMs: [],
  };
  const loops = new Set();   // { stop, ac, reqId }
  const unloader = makeUnloader(s.ollama, log);
  const headers = () => ({ 'Content-Type': 'application/json', 'x-pool-token': s.password });

  const register = async () => {
    const r = await fetch(`${s.host}/pool/register`, { method: 'POST', headers: headers(),
      body: JSON.stringify({ id, label, slots: s.slots, models: s.models, machine, labels, hardware }) });
    if (r.status === 401) throw new Error('the host rejected the pool password');
    if (!r.ok) throw new Error(`register: HTTP ${r.status}`);
  };
  const release = async (ids, reason) => {
    if (!ids.length) return;
    try {
      await fetch(`${s.host}/pool/release`, { method: 'POST', headers: headers(), body: JSON.stringify({ worker: id, ids, reason }) });
    } catch { /* host gone: its lease expiry re-queues them */ }
  };

  async function take() {
    const r = await fetch(`${s.host}/pool/work?worker=${encodeURIComponent(id)}`, { headers: headers() });
    if (r.status === 204) { s.hostPaused = r.headers.get('x-pool-paused') === '1'; return null; }
    s.hostPaused = false;
    if (r.status === 409) { await register(); return null; }   // the host restarted
    if (!r.ok) throw new Error(`work: HTTP ${r.status}`);
    return r.json();
  }

  async function runLoop(loop) {
    while (!loop.stop && !s.stopped) {
      if (s.paused) { await sleep(300); continue; }
      let req;
      try { req = await take(); } catch { await sleep(3000); continue; }
      if (!req) {
        if (s.hostPaused) await unloader.unload();
        continue;
      }
      if (s.paused || loop.stop || s.stopped) { await release([req.id], 'paused'); continue; }
      unloader.reset();
      loop.ac = new AbortController();
      loop.reqId = req.id;
      const t0 = Date.now();
      let result = null;
      try {
        const r = await fetch(`${s.ollama}${req.path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: req.body,
          signal: AbortSignal.any([loop.ac.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) });
        result = { status: r.status, body: await r.text(), contentType: r.headers.get('content-type') || undefined };
      } catch (e) {
        if (!loop.ac.signal.aborted) result = { status: 0, error: e.cause?.code || e.message };
      }
      loop.ac = null; loop.reqId = null;
      if (!result) continue;   // aborted by a pause: already released
      // This card's own server is down (crashed, restarting): that's not the
      // request's fault, so hand it back without spending an attempt, and wait.
      if (result.status === 0 && releaseNetworkErrors) {
        await release([req.id], 'card server unreachable');
        await sleep(2000);
        continue;
      }
      if (result.status >= 200 && result.status < 300) {
        s.done++;
        s.recentMs.push(Date.now() - t0);
        if (s.recentMs.length > 50) s.recentMs.shift();
      } else {
        s.failed++;
        if (OOM.test(result.body || '') || OOM.test(result.error || '')) s.oomErrors++;
      }
      try {
        await fetch(`${s.host}/pool/result?worker=${encodeURIComponent(id)}&job=${encodeURIComponent(req.id)}`,
          { method: 'POST', headers: headers(), body: JSON.stringify(result) });
      } catch { /* the host re-queues on lease expiry */ }
    }
    loops.delete(loop);
  }

  const spawn = () => { const loop = { stop: false, ac: null, reqId: null }; loops.add(loop); runLoop(loop); };
  const active = () => [...loops].filter((l) => !l.stop);

  await register();
  for (let i = 0; i < s.slots; i++) spawn();
  // Heartbeat: keeps the card listed while every slot is on a long request,
  // and picks up models pulled since.
  const beat = setInterval(async () => {
    try { s.models = await ollamaModels(s.ollama); await register(); } catch { /* next beat */ }
  }, 30_000);
  log(`card ${label || id} joined ${s.host} - ${s.slots} slot(s)`);

  return {
    id,
    async setPaused(paused, reason = 'paused') {
      if (paused === s.paused) return;
      s.paused = paused;
      if (!paused) { unloader.reset(); return; }
      const held = [...loops].filter((l) => l.ac);
      const ids = held.map((l) => l.reqId);
      for (const l of held) l.ac.abort();
      await release(ids, reason);
      await unloader.unload();
    },
    async setSlots(n) {
      n = Math.max(1, Math.floor(n));
      s.slots = n;
      const now = active();
      for (let i = now.length; i < n; i++) spawn();
      for (const l of now.slice(n)) l.stop = true;   // finish the current request, then exit
      try { await register(); } catch { /* next beat */ }
    },
    // After a model is linked or pulled: tell the host now, not at the next heartbeat.
    async refreshModels() {
      try { s.models = await ollamaModels(s.ollama); await register(); } catch { /* next beat */ }
    },
    models: () => [...s.models],
    setOllama(url) { s.ollama = url.replace(/\/+$/, ''); },
    setHost(url, pw = s.password) { s.host = url.replace(/\/+$/, ''); s.password = pw; },
    stats: () => ({ done: s.done, failed: s.failed, inflight: [...loops].filter((l) => l.ac).length, recentMs: [...s.recentMs], oomErrors: s.oomErrors }),
    async leave() {
      clearInterval(beat);
      s.stopped = true;
      for (const l of loops) l.ac?.abort();
      try { await fetch(`${s.host}/pool/leave`, { method: 'POST', headers: headers(), body: JSON.stringify({ id }) }); } catch { /* host gone */ }
    },
  };
}
