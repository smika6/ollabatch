// The loop every card runs, in-process on the host or remote via `ollabatch join`:
// take a request, run it on this card's Ollama, hand back the result.

export const REQUEST_TIMEOUT_MS = 9 * 60_000;

export async function workerLoop({ take, finish, ollama, stop, isPaused = () => false, unload }) {
  while (!stop.stopped) {
    let req;
    try { req = await take(); } catch { await sleep(3000); continue; }
    if (!req) {
      if (isPaused() && unload) await unload();
      continue;
    }
    let result;
    try {
      // Under the host's 10-minute lease, so a hung Ollama frees the slot
      // instead of pinning it on every re-lease.
      const r = await fetch(`${ollama}${req.path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: req.body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      result = { status: r.status, body: await r.text(), contentType: r.headers.get('content-type') || undefined };
    } catch (e) {
      result = { status: 0, error: e.cause?.code || e.message };
    }
    try { await finish(req, result); } catch { /* the host re-queues on lease expiry */ }
  }
}

// Pausing a card frees its VRAM (its owner wants the GPU back): ask Ollama to
// drop every loaded model, once per pause; resume reloads on demand.
export function makeUnloader(ollama, log = () => {}) {
  let done = false;
  return {
    reset: () => { done = false; },
    unload: async () => {
      if (done) return;
      done = true;
      try {
        const ps = await (await fetch(`${ollama}/api/ps`, { signal: AbortSignal.timeout(5000) })).json();
        for (const m of ps.models || []) {
          await fetch(`${ollama}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: m.name, keep_alive: 0 }) });
        }
        log(`paused - unloaded ${(ps.models || []).length} model(s) from ${ollama}`);
      } catch (e) { log(`paused - couldn't unload from ${ollama}: ${e.message}`); }
    },
  };
}

export async function ollamaModels(url) {
  const r = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`${url}/api/tags: HTTP ${r.status}`);
  return (await r.json()).models.map((m) => m.name);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
