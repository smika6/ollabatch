import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startHost } from '../src/host.mjs';
import { startAgent } from '../src/agent/agent.mjs';
import { listModels } from '../src/agent/playground.mjs';
import { waitFor, api } from '../testdata/helpers.mjs';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'testdata');
const BIN = path.join(DATA, 'fake-ollama-bin.mjs');
const CALL = path.join(DATA, 'call-ollama.mjs');
const NVSMI = fs.readFileSync(path.join(DATA, 'probes', 'nvidia-smi.csv'), 'utf8');   // RTX 5080 + RTX 3080
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ollabatch agent '));
const cleanup = [];
after(async () => { for (const f of cleanup.reverse()) await f(); });

async function host(port = 0, stateDir = tmp()) {
  const h = await startHost({ port, password: 'secret-pw', stateDir, beacon: false });
  cleanup.push(() => h.close());
  const base = `http://127.0.0.1:${h.port}`;
  return { h, base, stateDir, call: api(base, 'secret-pw') };
}

// A put-model helper in Ollama's layout, for the "owner's own store".
function putModel(store, name, size = 64) {
  const [n, t] = name.split(':');
  const data = Buffer.alloc(size, 3);
  const digest = `sha256:${crypto.createHash('sha256').update(data).update(name).digest('hex')}`;
  fs.mkdirSync(path.join(store, 'blobs'), { recursive: true });
  fs.writeFileSync(path.join(store, 'blobs', digest.replace(':', '-')), data);
  const dir = path.join(store, 'manifests', 'registry.ollama.ai', 'library', n);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, t), JSON.stringify({ config: { digest, size }, layers: [] }));
}

async function agent(base, extra = {}) {
  const watch = { emit: null };
  const a = await startAgent({
    dir: tmp(), host: base, password: 'secret-pw', machine: 'testbox', trusted: true,
    run: async (cmd) => (cmd === 'nvidia-smi' ? NVSMI : null), platform: 'linux',
    ollama: { command: process.execPath, args: [BIN] }, serverEnv: (card) => ({ FAKE_GPU: card.name }),
    userStore: tmp(), tickMs: 200, basePort: 42000 + Math.floor(Math.random() * 10000),
    watcher: ({ onSample }) => { watch.emit = onSample; return { supported: true, stop() {} }; },
    intel: ({ onSample }) => { watch.intel = onSample; return { stop() {} }; },
    fetchRegistry: async () => ({ ok: true, json: async () => ({ config: { size: 64 }, layers: [] }) }),
    ...extra,
  });
  cleanup.push(() => a.close());
  return { a, watch };
}

const job = (call, models = []) => call('POST', '/ob/jobs', { name: 'calls', command: process.execPath, args: [CALL, '5'], cwd: DATA, models });
const status = async (call, id) => (await call('GET', '/ob/status')).json.jobs.find((j) => j.id === id);

test('lends both cards end to end and reports its hardware', async () => {
  const s = await host();
  const { a } = await agent(s.base);
  await waitFor(async () => (await s.call('GET', '/ob/status')).json.workers.filter((w) => w.active).length === 2, 45_000, 'two cards');
  const j = (await job(s.call)).json;
  await waitFor(async () => (await status(s.call, j.id)).status === 'done', 45_000, 'job done');
  const m = (await s.call('GET', '/ob/status')).json.machines.find((x) => x.machine === 'testbox');
  assert.equal(m.cards.length, 2);
  assert.deepEqual(m.report.cards.map((c) => c.name).sort(), ['NVIDIA GeForce RTX 3080', 'NVIDIA GeForce RTX 5080']);
  assert.equal(m.report.cards.find((c) => c.name.includes('5080')).vramMB, 16303);
  assert.ok(m.report.playground);
  assert.ok(a.status().cards.every((c) => c.state === 'lending'));
});

test('an owner pause takes a card out of the pool within seconds', async () => {
  const s = await host();
  const { a } = await agent(s.base);
  await waitFor(() => a.status().cards.length === 2 && a.status().cards.every((c) => c.state === 'lending'), 45_000, 'lending');
  const id = a.status().cards[0].id;
  const t0 = Date.now();
  await a.act({ type: 'pause', card: id });
  assert.equal(a.status().cards.find((c) => c.id === id).state, 'paused-by-owner');
  await waitFor(async () => (await s.call('GET', '/ob/status')).json.workers.find((w) => w.id === `testbox-${id}`)?.owner?.state === 'paused-by-owner', 5000, 'reported');
  assert.ok(Date.now() - t0 < 15_000);
});

test('a fullscreen program pauses the card it uses', async () => {
  const s = await host();
  const skew = { ms: 0 };
  const { a, watch } = await agent(s.base, { now: () => Date.now() + skew.ms });
  await waitFor(() => a.status().cards.length === 2 && a.status().cards.every((c) => c.state === 'lending'), 45_000, 'lending');
  const card = a.status().cards.find((c) => c.name.includes('5080'));
  const sample = { fg: { pid: 999999, exe: 'game', cls: 'Game', fullscreen: true, adapter: card.name }, engines: [], procs: [] };
  watch.emit(sample);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(a.status().cards.find((c) => c.id === card.id).state, 'lending', 'not before 10 s');
  skew.ms = 11_000;
  watch.emit(sample);
  await waitFor(() => a.status().cards.find((c) => c.id === card.id).state === 'paused-in-use', 5000, 'paused in use');
  assert.equal(a.status().cards.find((c) => c.id !== card.id).state, 'lending');
});

test('the owner\'s pause holds while the host is down and after it returns', async () => {
  const first = await host();
  const { a } = await agent(first.base);
  await waitFor(() => a.status().cards.length === 2 && a.status().cards.every((c) => c.state === 'lending'), 45_000, 'lending');
  const id = a.status().cards[0].id;
  const port = first.h.port;
  await first.h.close();
  await a.act({ type: 'pause', card: id });
  const second = await host(port, first.stateDir);
  await waitFor(async () => (await second.call('GET', '/ob/status')).json.workers.some((w) => w.active), 15_000, 'other card back');
  await new Promise((r) => setTimeout(r, 1000));
  const w = (await second.call('GET', '/ob/status')).json.workers.find((x) => x.id === `testbox-${id}`);
  assert.ok(!w || !w.active || w.owner?.state === 'paused-by-owner', 'the paused card is not lending');
  assert.equal(a.status().cards.find((c) => c.id === id).state, 'paused-by-owner');
});

test('a wanted model the owner already has is linked, not downloaded', async () => {
  const s = await host();
  const userStore = tmp();
  putModel(userStore, 'mine:1');
  let pulls = 0;
  const { a } = await agent(s.base, { userStore, trusted: false, fetchRegistry: async () => { pulls++; return { ok: false }; } });
  await waitFor(() => a.status().cards.length === 2, 45_000, 'cards');
  const j = (await job(s.call, ['mine:1'])).json;
  await waitFor(async () => (await status(s.call, j.id)).status === 'done', 30_000, 'job done on the linked model');
  const pg = a.status().playground;
  assert.ok(pg.models.some((m) => m.name === 'mine:1' && m.linked));
  assert.equal(pulls, 0);
});

test('a wanted model is downloaded only when downloads are on', async () => {
  const off = await host();
  const { a: noDl } = await agent(off.base, { trusted: false });
  await waitFor(() => noDl.status().cards.length === 2, 45_000, 'cards');
  await job(off.call, ['tiny:1']);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(listModels(noDl.status().playground.path).length, 0);

  const on = await host();
  const { a: dl } = await agent(on.base, { trusted: true });
  await waitFor(() => dl.status().cards.length === 2, 45_000, 'cards');
  const j = (await job(on.call, ['tiny:1'])).json;
  await waitFor(async () => (await status(on.call, j.id)).status === 'done', 60_000, 'job done on the pulled model');
  assert.ok(listModels(dl.status().playground.path).some((m) => m.name === 'tiny:1'));
});

test('an Intel Arc gets temperature, power and use from Intel\'s control library, before its adapter is known', async () => {
  const s = await host();
  const WIN = fs.readFileSync(path.join(DATA, 'probes', 'win-adapters.json'), 'utf8');
  const run = async (cmd) => (cmd === 'nvidia-smi' ? NVSMI : cmd === 'powershell' ? WIN : null);
  const { a, watch } = await agent(s.base, { run, platform: 'win32' });
  const arc = () => a.status().cards.find((c) => c.name.includes('Arc'));
  await waitFor(() => watch.intel && arc(), 30_000, 'Arc found, reader started');
  watch.intel({ devices: [{ luid: '0x00000000_0x000151fa', name: 'Intel(R) Arc(TM) A770 Graphics', tempC: 47, powerW: 35.7, util: 3 }] });
  await waitFor(() => arc().tempC === 47, 10_000, 'temperature');
  assert.equal(arc().powerW, 35.7);
  assert.equal(arc().util, 3);
  assert.equal(a.status().cards.find((c) => c.name.includes('5080')).tempC, 69, 'nvidia-smi still owns NVIDIA cards (its fixture says 69°C)');
});

test('a failed nvidia-smi read never adds a duplicate of an NVIDIA card', async () => {
  const s = await host();
  const WIN = fs.readFileSync(path.join(DATA, 'probes', 'win-adapters.json'), 'utf8');
  let smiCalls = 0;
  const run = async (cmd) => (cmd === 'nvidia-smi' ? (smiCalls++ === 0 ? NVSMI : null) : cmd === 'powershell' ? WIN : null);
  const { a } = await agent(s.base, { run, platform: 'win32' });
  await new Promise((r) => setTimeout(r, 1500));   // several ticks with nvidia-smi failing
  const names = a.status().cards.map((c) => c.name);
  assert.equal(names.filter((n) => n.includes('5080')).length, 1, names.join(', '));
});

test('a slow download doesn\'t freeze the agent: it keeps checking in and reporting', async () => {
  const s = await host();
  const { a } = await agent(s.base, { trusted: true, serverEnv: (card) => ({ FAKE_GPU: card.name, FAKE_PULL_MS: '5000' }) });
  await waitFor(() => a.status().cards.length === 2 && a.status().cards.every((c) => c.state === 'lending'), 45_000, 'lending');
  await job(s.call, ['tiny:1']);
  await waitFor(() => a.status().download, 30_000, 'download started');
  const seen = async () => (await s.call('GET', '/ob/status')).json.machines.find((m) => m.machine === 'testbox').report.seenAt;
  const before = await seen();
  await new Promise((r) => setTimeout(r, 1200));
  assert.ok(await seen() > before, 'reports kept coming during the download');
  assert.ok(a.status().download, 'still downloading in the background');
});

test('a failed download backs off instead of retrying every tick', async () => {
  const s = await host();
  const { a } = await agent(s.base, { trusted: true, serverEnv: (card) => ({ FAKE_GPU: card.name, FAKE_FAIL_PULL: '1' }) });
  await waitFor(() => a.status().cards.length === 2, 45_000, 'cards');
  await job(s.call, ['tiny:1']);
  await waitFor(() => a.status().downloadFailures?.['tiny:1']?.count === 1, 30_000, 'first failure');
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(a.status().downloadFailures['tiny:1'].count, 1);
});

test('the owner\'s rules are checked again right before a download', async () => {
  const s = await host();
  let agentRef = null;
  let asked = 0;
  const { a } = await agent(s.base, {
    trusted: true,
    fetchRegistry: async () => { asked++; await agentRef.act({ type: 'playground', downloads: false }); return { ok: true, json: async () => ({ config: { size: 64 }, layers: [] }) }; },
  });
  agentRef = a;
  await waitFor(() => a.status().cards.length === 2, 45_000, 'cards');
  await job(s.call, ['tiny:1']);
  await waitFor(() => asked > 0, 30_000, 'size asked');
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(listModels(a.status().playground.path).length, 0);
});
