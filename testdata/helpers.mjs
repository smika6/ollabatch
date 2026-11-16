// Test helpers: a minimal HTTP worker (the /pool/* protocol) and polling.
import os from 'node:os';

export async function pullWorker(hostUrl, { id, label = id, models = ['fake'], slots = 1, ollama, token = '', extra = {} }) {
  const headers = { 'Content-Type': 'application/json', 'x-pool-token': token };
  const register = () => fetch(`${hostUrl}/pool/register`, { method: 'POST', headers, body: JSON.stringify({ id, label, slots, models, ...extra }) });
  const r = await register();
  if (!r.ok) throw new Error(`register ${r.status}`);
  const state = { stopped: false, results: [] };
  const loop = async () => {
    while (!state.stopped) {
      let res;
      try { res = await fetch(`${hostUrl}/pool/work?worker=${encodeURIComponent(id)}`, { headers }); } catch { return; }
      if (res.status === 204) continue;
      if (res.status === 409) { await register(); continue; }
      if (!res.ok) return;
      const job = await res.json();
      const o = await fetch(`${ollama}${job.path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: job.body });
      const result = { status: o.status, body: await o.text(), contentType: o.headers.get('content-type') };
      try {
        const done = await fetch(`${hostUrl}/pool/result?worker=${encodeURIComponent(id)}&job=${encodeURIComponent(job.id)}`,
          { method: 'POST', headers, body: JSON.stringify(result) });
        state.results.push(done.status);
      } catch { return; }
    }
  };
  for (let i = 0; i < slots; i++) loop();
  return { state, stop: () => { state.stopped = true; } };
}

export async function waitFor(fn, ms = 10_000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export const lanAddress = () => Object.values(os.networkInterfaces()).flat()
  .find((a) => a && a.family === 'IPv4' && !a.internal)?.address;

export const api = (base, token = '') => async (method, path, body) => {
  const r = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json', 'x-pool-token': token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: r.status, json, text, headers: r.headers };
};
