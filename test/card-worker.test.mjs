import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHost } from '../src/host.mjs';
import { startCardWorker } from '../src/card-worker.mjs';
import { startFakeOllama } from '../testdata/fake-ollama.mjs';
import { pullWorker, waitFor, api } from '../testdata/helpers.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ollabatch card '));
const cleanup = [];
after(async () => { for (const f of cleanup.reverse()) await f(); });

async function hostAt(port = 0, stateDir = tmp()) {
  const h = await startHost({ port, password: 'secret-pw', stateDir, beacon: false });
  cleanup.push(() => h.close());
  return { h, base: `http://127.0.0.1:${h.port}`, stateDir };
}
async function fake(opts) {
  const f = await startFakeOllama(opts);
  cleanup.push(() => f.close());
  return f;
}
async function card(base, ollama, extra = {}) {
  const w = await startCardWorker({ hostUrl: base, password: 'secret-pw', ollama, slots: 1, id: 'desk-card0', label: 'Card 0', machine: 'desk', ...extra });
  cleanup.push(() => w.leave());
  return w;
}
const chat = (base) => api(base, 'secret-pw')('POST', '/api/chat', { model: 'fake', stream: false, messages: [] });

test('pause aborts in-flight requests and hands them back', async () => {
  const { base } = await hostAt();
  const slow = await fake({ delayMs: 3000 });
  const w = await card(base, slow.url);
  const pending = chat(base);
  await waitFor(() => w.stats().inflight === 1, 5000, 'in flight');
  const t0 = Date.now();
  await w.setPaused(true, 'paused-in-use');
  assert.ok(Date.now() - t0 < 1000, 'pause returns quickly');
  const status = await fetch(`${base}/pool/status`).then((r) => r.json());
  assert.equal(status.inflight, 0);
  assert.equal(status.queued, 1);
  const quick = await fake();
  const other = await pullWorker(base, { id: 'other', ollama: quick.url, token: 'secret-pw' });
  cleanup.push(() => other.stop());
  assert.equal((await pending).status, 200);
  assert.equal(w.stats().failed, 0);
});

test('a paused card takes no work until resumed', async () => {
  const { base } = await hostAt();
  const f = await fake();
  const w = await card(base, f.url);
  await w.setPaused(true, 'paused-by-owner');
  const pending = chat(base);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(f.calls.length, 0);
  await w.setPaused(false);
  assert.equal((await pending).status, 200);
});

test('setSlots grows and shrinks concurrency', async () => {
  const { base } = await hostAt();
  const f = await fake({ delayMs: 400 });
  const w = await card(base, f.url);
  await w.setSlots(3);
  await Promise.all(Array.from({ length: 6 }, () => chat(base)));
  assert.equal(f.state.peak, 3);
  await w.setSlots(1);
  f.state.peak = 0;
  await Promise.all(Array.from({ length: 3 }, () => chat(base)));
  assert.equal(f.state.peak, 1);
  const status = await fetch(`${base}/pool/status`).then((r) => r.json());
  assert.equal(status.workers.find((x) => x.id === 'desk-card0').slots, 1);
});

test('stable id across a host restart', async () => {
  const first = await hostAt();
  const f = await fake();
  await card(first.base, f.url);
  const port = first.h.port;
  await first.h.close();
  const second = await hostAt(port, first.stateDir);
  await waitFor(async () => (await fetch(`${second.base}/pool/status`).then((r) => r.json())).workers.length === 1, 10_000, 're-register');
  assert.equal((await chat(second.base)).status, 200);
  const status = await fetch(`${second.base}/pool/status`).then((r) => r.json());
  assert.deepEqual(status.workers.map((x) => x.id), ['desk-card0']);
});

test('out-of-memory results are counted', async () => {
  const { base } = await hostAt();
  const f = await fake({ failWith: { status: 500, body: '{"error":"CUDA error: out of memory"}' } });
  const w = await card(base, f.url);
  chat(base).catch(() => {});
  await waitFor(() => w.stats().oomErrors >= 1, 5000, 'oom counted');
});

test('registers machine, labels and hardware', async () => {
  const { base } = await hostAt();
  const f = await fake();
  await card(base, f.url, { labels: { gpu: 'nvidia' }, hardware: { name: 'RTX', vramMB: 16303 } });
  const s = await api(base, 'secret-pw')('GET', '/ob/status');
  const c = s.json.workers.find((x) => x.id === 'desk-card0');
  assert.equal(c.machine, 'desk');
  assert.equal(c.labels.gpu, 'nvidia');
});
