import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RemoteStore } from '../src/remote.mjs';
import { startHost } from '../src/host.mjs';
import { startAgent } from '../src/agent/agent.mjs';
import { loadConfig } from '../src/agent/config.mjs';
import { waitFor, api } from '../testdata/helpers.mjs';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'testdata');
const BIN = path.join(DATA, 'fake-ollama-bin.mjs');
const NVSMI = fs.readFileSync(path.join(DATA, 'probes', 'nvidia-smi.csv'), 'utf8');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ob remote '));
const cleanup = [];
after(async () => { for (const f of cleanup.reverse()) await f(); });

test('settings are stamped per field and versioned; commands expire after 10 minutes', () => {
  let t = 1000;
  const r = new RemoteStore({ now: () => t });
  r.setDesired('pc', { policy: 'always', 'cards.nvidia-1.slots': 3 });
  t = 2000;
  const d = r.setDesired('pc', { 'playground.limitGB': 80 });
  assert.equal(d.version, 2);
  assert.deepEqual(d.fields.policy, { value: 'always', at: 1000 });
  assert.deepEqual(d.fields['playground.limitGB'], { value: 80, at: 2000 });
  assert.throws(() => r.setDesired('pc', { 'cards.x.labels': {} }), /labels/);
  const c = r.queueCommand('pc', { type: 'restart-card', card: 'nvidia-1' });
  assert.deepEqual(r.pending('pc').map((x) => x.id), [c.id]);
  t += 11 * 60_000;
  assert.deepEqual(r.pending('pc'), []);
  assert.equal(r.commands('pc')[0].state, 'expired');
});

async function host() {
  const h = await startHost({ port: 0, password: 'secret-pw', stateDir: tmp(), beacon: false });
  cleanup.push(() => h.close());
  const base = `http://127.0.0.1:${h.port}`;
  return { h, base, call: api(base, 'secret-pw') };
}
async function agent(base, extra = {}) {
  const a = await startAgent({
    dir: tmp(), host: base, password: 'secret-pw', machine: 'box', trusted: true,
    run: async (cmd) => (cmd === 'nvidia-smi' ? NVSMI : null), platform: 'linux',
    ollama: { command: process.execPath, args: [BIN] }, serverEnv: (card) => ({ FAKE_GPU: card.name }),
    userStore: tmp(), tickMs: 200, basePort: 43000 + Math.floor(Math.random() * 9000),
    watcher: () => ({ supported: true, stop() {} }), fetchRegistry: async () => ({ ok: false }), ...extra,
  });
  cleanup.push(() => a.close());
  await waitFor(() => a.status().cards.length === 2 && a.status().cards.every((c) => c.state === 'lending'), 45_000, 'lending');
  return a;
}
const report = async (call) => (await call('GET', '/ob/status')).json.machines.find((m) => m.machine === 'box')?.report;

test('a machine whose owner hasn\'t allowed it can\'t be changed or commanded', async () => {
  const s = await host();
  await agent(s.base, { trusted: false });
  await waitFor(async () => (await report(s.call))?.remote === false, 10_000, 'reported');
  assert.equal((await s.call('PUT', '/ob/machines/box/settings', { policy: 'never' })).status, 409);
  assert.equal((await s.call('POST', '/ob/machines/box/commands', { type: 'restart-card', card: 'nvidia-2d000' })).status, 409);
});

test('per-field newest wins: a remote change and a newer local change both stand', async () => {
  const s = await host();
  const a = await agent(s.base);
  await waitFor(async () => (await report(s.call))?.remote === true, 10_000, 'remote on');
  assert.equal((await s.call('PUT', '/ob/machines/box/settings', { 'playground.downloads': true })).status, 200);
  await waitFor(() => a.status().playground.downloads === true, 10_000, 'remote applied');
  await new Promise((r) => setTimeout(r, 20));
  await a.act({ type: 'playground', downloads: false });   // the owner, later, on the PC
  await s.call('PUT', '/ob/machines/box/settings', { policy: 'always' });
  await waitFor(() => a.status().policy === 'always', 10_000, 'second remote change applied');
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(a.status().playground.downloads, false, 'the owner\'s newer change stands');
  assert.deepEqual((await report(s.call)).localOverride, ['playground.downloads']);
});

test('fixed slots pin a card; commands run and are acknowledged; remote off rejects them', async () => {
  const s = await host();
  const a = await agent(s.base);
  await waitFor(async () => (await report(s.call))?.remote === true, 10_000, 'remote on');
  const id = a.status().cards.find((c) => c.name.includes('5080')).id;
  await s.call('PUT', '/ob/machines/box/settings', { [`cards.${id}.slots`]: 3 });
  await waitFor(() => a.status().cards.find((c) => c.id === id).slots === 3, 30_000, 'pinned to 3');
  const c = (await s.call('POST', '/ob/machines/box/commands', { type: 'restart-card', card: id })).json;
  await waitFor(async () => (await s.call('GET', '/ob/machines/box/commands')).json.find((x) => x.id === c.id).state === 'done', 30_000, 'restart done');
  await a.act({ type: 'remote', on: false });
  const late = s.h.remote.queueCommand('box', { type: 'retune', card: id });   // queued before the host heard about it
  await waitFor(async () => (await s.call('GET', '/ob/machines/box/commands')).json.find((x) => x.id === late.id).state === 'rejected', 10_000, 'rejected');
});

test('remote defaults: on for trusted installs, off otherwise and for older configs', () => {
  assert.equal(loadConfig(tmp(), { trusted: true }).remote, true);
  assert.equal(loadConfig(tmp(), { trusted: false }).remote, false);
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ host: 'http://x:1', playground: { downloads: true } }));
  assert.equal(loadConfig(dir, { trusted: false }).remote, false);
});

test('the dashboard can resume a card its owner paused only when the pool manages the PC', async () => {
  for (const trusted of [false, true]) {
    const s = await host();
    const a = await agent(s.base, { trusted });
    const id = a.status().cards[0].id;
    await a.act({ type: 'pause', card: id });
    await waitFor(async () => (await report(s.call))?.cards.find((c) => c.id === id).state === 'paused-by-owner', 10_000, 'owner pause reported');
    const wid = (await report(s.call)).cards.find((c) => c.id === id).workerId;
    const r = await s.call('POST', '/pool/pause', { id: wid, paused: false });
    if (!trusted) { assert.equal(r.status, 409); continue; }
    assert.equal(r.status, 200);
    await waitFor(() => a.status().cards.find((c) => c.id === id).state === 'lending', 15_000, 'resumed on the PC');
  }
});
