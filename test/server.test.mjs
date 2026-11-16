import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backendEnv, pickPorts, isPortFree, CardServer } from '../src/agent/server.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'testdata', 'fake-ollama-bin.mjs');
const OLLAMA = { command: process.execPath, args: [BIN] };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rigpool server '));
const servers = [];
after(async () => { for (const s of servers) await s.stop(); });

const RTX = { id: 'nvidia-2d000', vendor: 'nvidia', name: 'NVIDIA GeForce RTX 5080', index: 0, vramMB: 16303 };
const ARC = { id: 'intel-963936', vendor: 'intel', name: 'Intel(R) Arc(TM) A770 Graphics', index: 1, vramMB: 16256 };
const freePort = async () => (await pickPorts(1, isPortFree, 40000 + Math.floor(Math.random() * 20000)))[0];

function server(card, extraEnv = {}, opts = {}) {
  const s = new CardServer({ card, port: opts.port, slots: opts.slots || 1, playground: tmp(), ollama: OLLAMA, logDir: tmp(), extraEnv,
    backoffMs: opts.backoffMs, vulkanCandidates: opts.vulkanCandidates });
  servers.push(s);
  return s;
}

test('backendEnv pins NVIDIA by CUDA and Arc by Vulkan', () => {
  const common = { OLLAMA_HOST: '127.0.0.1:11440', OLLAMA_MODELS: '/pg', OLLAMA_NUM_PARALLEL: '2', OLLAMA_KEEP_ALIVE: '24h', OLLAMA_MAX_LOADED_MODELS: '1' };
  assert.deepEqual(backendEnv(RTX, { port: 11440, slots: 2, playground: '/pg' }), { ...common, CUDA_VISIBLE_DEVICES: '0', OLLAMA_VULKAN: '0' });
  assert.deepEqual(backendEnv(ARC, { port: 11440, slots: 2, playground: '/pg', vulkanIndex: 1 }),
    { ...common, CUDA_VISIBLE_DEVICES: '-1', OLLAMA_VULKAN: '1', GGML_VK_VISIBLE_DEVICES: '1' });
  assert.deepEqual(backendEnv({ vendor: 'apple', index: 0 }, { port: 11440, slots: 2, playground: '/pg' }), common);
});

test('skips occupied ports', async () => {
  assert.deepEqual(await pickPorts(2, async (p) => p !== 11440), [11441, 11442]);
  const port = await freePort();
  const blocker = net.createServer().listen(port, '127.0.0.1');
  await new Promise((r) => blocker.once('listening', r));
  assert.equal(await isPortFree(port), false);
  blocker.close();
});

test('starts and confirms the GPU it was pinned to', async () => {
  const s = server(RTX, { FAKE_GPU: 'NVIDIA GeForce RTX 5080' }, { port: await freePort() });
  const r = await s.start();
  assert.deepEqual(r, { confirmed: true, gpuName: 'NVIDIA GeForce RTX 5080' });
  assert.equal(s.state, 'ready');
  assert.equal((await (await fetch(`${s.url}/api/version`)).json()).version, '0.0.0-fake');
});

test('a wrong Vulkan device is retried with the next index', async () => {
  const byVk = JSON.stringify({ 0: 'NVIDIA GeForce RTX 5080', 1: 'Intel(R) Arc(TM) A770 Graphics' });
  const s = server(ARC, { FAKE_GPU_BY_VK: byVk }, { port: await freePort(), vulkanCandidates: [0, 1] });
  assert.equal((await s.start()).confirmed, true);
  assert.equal(s.vulkanIndex, 1);
});

test('no matching device → misconfigured', async () => {
  const s = server(ARC, { FAKE_GPU_BY_VK: JSON.stringify({ 0: 'Other', 1: 'Other' }) }, { port: await freePort(), vulkanCandidates: [0, 1] });
  assert.equal((await s.start()).confirmed, false);
  assert.equal(s.state, 'misconfigured');
});

test('a crash restarts with growing backoff', async () => {
  const s = server(RTX, { FAKE_GPU: 'NVIDIA GeForce RTX 5080', FAKE_EXIT_AFTER_MS: '400' }, { port: await freePort(), backoffMs: 150 });
  const waits = [];
  let readies = 0;
  s.on('crash', ({ wait }) => waits.push(wait));
  s.on('ready', () => readies++);
  await s.start();
  const end = Date.now() + 15_000;
  while (readies < 3 && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  assert.ok(readies >= 3, `came back ${readies - 1} times`);
  assert.deepEqual(waits.slice(0, 2), [150, 300]);
});

test('restart(slots) brings the server back with the new parallel count', async () => {
  const s = server(RTX, { FAKE_GPU: 'NVIDIA GeForce RTX 5080' }, { port: await freePort() });
  await s.start();
  await s.restart(3);
  assert.equal((await (await fetch(`${s.url}/api/version`)).json()).parallel, 3);
});
