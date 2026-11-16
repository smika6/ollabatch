import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHost } from '../src/host.mjs';
import { listenBeacons } from '../src/discovery.mjs';
import { startFakeOllama } from '../testdata/fake-ollama.mjs';
import { pullWorker, waitFor, api } from '../testdata/helpers.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rigpool hostagent '));
const cleanup = [];
after(async () => { for (const f of cleanup.reverse()) await f(); });
const LONG = { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: os.tmpdir() };

async function host(opts = {}) {
  const h = await startHost({ port: 0, password: 'secret-pw', stateDir: tmp(), beacon: false, ...opts });
  cleanup.push(() => h.close());
  const base = `http://127.0.0.1:${h.port}`;
  return { h, base, call: api(base, 'secret-pw') };
}
async function worker(base, id, models, extra) {
  const f = await startFakeOllama({ models });
  cleanup.push(() => f.close());
  const w = await pullWorker(base, { id, ollama: f.url, models, token: 'secret-pw', extra });
  cleanup.push(() => w.stop());
  return f;
}

test('wants: a running job\'s actual model, a queued job\'s first choice, only for matching cards', async () => {
  const s = await host();
  await worker(s.base, 'desk-nv', ['gemma4:12b'], { machine: 'desk', labels: { gpu: 'nvidia' } });
  const running = (await s.call('POST', '/rp/jobs', { name: 'r', ...LONG, models: ['gemma4:26b', 'gemma4:12b'] })).json;
  await waitFor(async () => (await s.call('GET', '/rp/status')).json.jobs.find((j) => j.id === running.id).status === 'running', 5000, 'running');
  await s.call('POST', '/rp/jobs', { name: 'q', ...LONG, models: ['gemma4:26b', 'gemma4:12b'] });
  await s.call('POST', '/rp/jobs', { name: 'arc only', ...LONG, models: ['qwen:9b'], selector: 'gpu=intel' });
  const w = await s.call('GET', '/pool/wants?machine=desk');
  assert.deepEqual(w.json, { cards: { 'desk-nv': ['gemma4:12b', 'gemma4:26b'] } });
  assert.deepEqual((await s.call('GET', '/pool/wants?machine=elsewhere')).json, { cards: {} });
});

test('a machine report shows in status and sets each card\'s owner state', async () => {
  const s = await host();
  await worker(s.base, 'desk-nv', ['m'], { machine: 'desk' });
  const report = { machine: 'desk', os: 'win32', agent: '0.2.0', policy: 'when-free',
    cards: [{ id: 'nvidia-2d000', workerId: 'desk-nv', name: 'NVIDIA GeForce RTX 5080', vramMB: 16303, freeMB: null, tempC: null,
      state: 'paused-in-use', reason: 'a fullscreen program is using this GPU', slots: 2, tuning: 'tuned' },
    { id: 'intel-963936', workerId: null, name: 'Intel(R) Arc(TM) A770 Graphics', vramMB: 16256, state: 'disabled', reason: 'lending turned off' }],
    playground: { limitGB: 50, usedBytes: 0, models: [] }, download: null };
  assert.equal((await s.call('POST', '/pool/machine', report)).status, 200);
  const st = (await s.call('GET', '/rp/status')).json;
  const m = st.machines.find((x) => x.machine === 'desk');
  assert.equal(m.report.cards.length, 2);
  assert.equal(m.report.cards[1].tempC, undefined);
  assert.deepEqual(st.workers.find((w) => w.id === 'desk-nv').owner, { state: 'paused-in-use', reason: 'a fullscreen program is using this GPU' });
});

test('a machine that only reports (lends nothing) is still listed', async () => {
  const s = await host();
  await s.call('POST', '/pool/machine', { machine: 'gf-pc', os: 'win32', cards: [{ id: 'nvidia-1', workerId: null, name: 'RTX 3060 Ti', state: 'never' }] });
  const m = (await s.call('GET', '/rp/status')).json.machines.find((x) => x.machine === 'gf-pc');
  assert.ok(m);
  assert.deepEqual(m.cards, []);
});

test('the dashboard cannot resume a card its owner paused', async () => {
  const s = await host();
  await worker(s.base, 'desk-nv', ['m'], { machine: 'desk' });
  await s.call('POST', '/pool/machine', { machine: 'desk', cards: [{ id: 'c', workerId: 'desk-nv', state: 'paused-by-owner', reason: 'paused on this PC' }] });
  assert.equal((await s.call('POST', '/pool/pause', { id: 'desk-nv', paused: false })).status, 409);
  assert.equal((await s.call('POST', '/pool/pause', { id: 'desk-nv', paused: true })).status, 200);
});

test('the built-in local card is skipped when an agent answers, unless forced', async () => {
  const f = await startFakeOllama();
  cleanup.push(() => f.close());
  const skipped = await host({ local: { url: f.url, slots: 1 }, agentProbe: async () => true });
  assert.equal((await skipped.call('GET', '/rp/status')).json.workers.length, 0);
  const forced = await host({ local: { url: f.url, slots: 1 }, localForced: true, agentProbe: async () => true });
  assert.equal((await forced.call('GET', '/rp/status')).json.workers.length, 1);
});

test('the beacon announces name and URL and never the password', async () => {
  const p = 41000 + Math.floor(Math.random() * 20000);
  const heard = [];
  const l = await listenBeacons({ port: p, onHost: (h) => heard.push(h) });
  cleanup.push(() => l.stop());
  const s = await host({ beacon: true, beaconPort: p, beaconTargets: ['127.0.0.1'] });
  await waitFor(() => heard.length > 0, 8000, 'beacon');
  assert.match(heard[0].url, new RegExp(`:${s.h.port}$`));
  assert.equal(heard[0].name, os.hostname());
});
