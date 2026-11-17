// A lending card cleans up after itself: no work for a while, or a host that
// went away, frees its GPU memory; it says the host is gone; and the host's
// built-in card steps out for an agent that starts later.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHost } from '../src/host.mjs';
import { startCardWorker } from '../src/card-worker.mjs';
import { startFakeOllama } from '../testdata/fake-ollama.mjs';
import { waitFor, api } from '../testdata/helpers.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ob cleanup '));
const cleanup = [];
after(async () => { for (const f of cleanup.reverse()) await f(); });

async function setup(hostOpts = {}) {
  const h = await startHost({ port: 0, password: 'secret-pw', stateDir: tmp(), beacon: false, ...hostOpts });
  cleanup.push(() => h.close());
  const f = await startFakeOllama();
  cleanup.push(() => f.close());
  return { h, f, base: `http://127.0.0.1:${h.port}`, call: api(`http://127.0.0.1:${h.port}`, 'secret-pw') };
}
const chat = (call) => call('POST', '/api/chat', { model: 'fake', stream: false, keep_alive: '24h', messages: [{ role: 'user', content: 'x' }] });

test('a card with no work frees its GPU memory, whatever keep_alive the job asked for', async () => {
  const s = await setup();
  const w = await startCardWorker({ hostUrl: s.base, password: 'secret-pw', ollama: s.f.url, slots: 1, id: 'c1', idleUnloadMs: 1500 });
  cleanup.push(() => w.leave());
  assert.equal((await chat(s.call)).status, 200);
  assert.deepEqual([...s.f.state.loaded], ['fake'], 'loaded while working');
  await waitFor(() => s.f.state.loaded.size === 0, 10_000, 'unloaded after the idle time');
  assert.equal((await chat(s.call)).status, 200, 'and it works again on the next request');
  assert.deepEqual([...s.f.state.loaded], ['fake']);
});

test('when the host goes away the card notices, frees the GPU, and carries on when it\'s back', async () => {
  const dir = tmp();
  const h = await startHost({ port: 0, password: 'secret-pw', stateDir: dir, beacon: false });
  const port = h.port;
  const f = await startFakeOllama();
  cleanup.push(() => f.close());
  const base = `http://127.0.0.1:${port}`;
  const w = await startCardWorker({ hostUrl: base, password: 'secret-pw', ollama: f.url, slots: 1, id: 'c1', idleUnloadMs: 2000 });
  cleanup.push(() => w.leave());
  assert.equal((await chat(api(base, 'secret-pw'))).status, 200);
  await h.close();   // the host is killed
  await waitFor(() => w.stats().hostDownSince != null, 10_000, 'noticed the host is gone');
  await waitFor(() => f.state.loaded.size === 0, 15_000, 'GPU memory freed');
  const h2 = await startHost({ port, password: 'secret-pw', stateDir: dir, beacon: false });
  cleanup.push(() => h2.close());
  await waitFor(() => w.stats().hostDownSince == null, 15_000, 'back');
  assert.equal((await chat(api(base, 'secret-pw'))).status, 200, 'working again');
});

test('the host\'s built-in card steps out when an agent starts on its machine later', async () => {
  let agent = false;
  const f = await startFakeOllama();
  cleanup.push(() => f.close());
  const s = await setup({ local: { url: f.url, slots: 1 }, agentProbe: async () => agent, agentRecheckMs: 200 });
  const active = async () => (await s.call('GET', '/ob/status')).json.workers.filter((x) => x.active).length;
  assert.equal(await active(), 1);
  agent = true;
  await waitFor(async () => (await active()) === 0, 10_000, 'built-in card left');
});
