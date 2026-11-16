// Join a host with one card: register, then pull requests and run them on
// this card's Ollama. Only connects out, so this machine opens no ports.
import os from 'node:os';
import crypto from 'node:crypto';
import { workerLoop, makeUnloader, ollamaModels } from './worker.mjs';

export async function join({ hostUrl, password = '', ollama = 'http://127.0.0.1:11434', slots = 2, label, labels = {}, log = () => {} }) {
  if (!/^https?:\/\//.test(hostUrl || '')) throw new Error('join needs the host URL, e.g. http://192.168.1.20:11500');
  hostUrl = hostUrl.replace(/\/+$/, '');
  ollama = ollama.replace(/\/+$/, '');
  const id = `${os.hostname()}-${ollama.replace(/\W+/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  const headers = { 'Content-Type': 'application/json', 'x-pool-token': password };
  const models = await ollamaModels(ollama);
  label ||= `${os.hostname()} ${ollama.replace(/^https?:\/\//, '')}`;
  const register = async () => {
    const r = await fetch(`${hostUrl}/pool/register`, { method: 'POST', headers,
      body: JSON.stringify({ id, label, slots, models, machine: os.hostname(), labels }) });
    if (r.status === 401) throw new Error('the host rejected the pool password');
    if (!r.ok) throw new Error(`register: HTTP ${r.status}`);
  };
  await register();
  log(`joined ${hostUrl} as "${label}" - ${slots} slot(s) - Ollama ${ollama} - ${models.length} models`);

  let paused = false;
  const stop = { stopped: false };
  const unloader = makeUnloader(ollama, log);
  const take = async () => {
    const r = await fetch(`${hostUrl}/pool/work?worker=${encodeURIComponent(id)}`, { headers });
    if (r.status === 204) {
      const now = r.headers.get('x-pool-paused') === '1';
      if (now !== paused) log(now ? 'paused from the dashboard - GPU freed' : 'resumed from the dashboard');
      paused = now;
      return null;
    }
    paused = false;
    unloader.reset();
    if (r.status === 409) { await register(); return null; }   // the host restarted
    if (!r.ok) throw new Error(`work: HTTP ${r.status}`);
    return r.json();
  };
  const finish = (req, result) => fetch(`${hostUrl}/pool/result?worker=${encodeURIComponent(id)}&job=${encodeURIComponent(req.id)}`,
    { method: 'POST', headers, body: JSON.stringify(result) });
  for (let i = 0; i < slots; i++) workerLoop({ take, finish, ollama, stop, isPaused: () => paused, unload: unloader.unload });

  return {
    id,
    async leave() {
      stop.stopped = true;
      try { await fetch(`${hostUrl}/pool/leave`, { method: 'POST', headers, body: JSON.stringify({ id }) }); } catch { /* host gone */ }
    },
  };
}
