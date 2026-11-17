// Regression tests for the remote-control review: validation, typed reports,
// persistence, the owner's download limits, who set the policy, switching
// pools, and newest-wins across disagreeing clocks and restarts.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { RemoteStore } from '../src/remote.mjs';
import { startHost } from '../src/host.mjs';
import { startAgent } from '../src/agent/agent.mjs';
import { waitFor, api } from '../testdata/helpers.mjs';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'testdata');
const BIN = path.join(DATA, 'fake-ollama-bin.mjs');
const NVSMI = fs.readFileSync(path.join(DATA, 'probes', 'nvidia-smi.csv'), 'utf8');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ob review '));
const cleanup = [];
after(async () => { for (const f of cleanup.reverse()) await f(); });

async function host(dir = tmp()) {
  const h = await startHost({ port: 0, password: 'secret-pw', stateDir: dir, beacon: false });
  cleanup.push(() => h.close());
  const base = `http://127.0.0.1:${h.port}`;
  return { h, base, call: api(base, 'secret-pw') };
}
async function agent(base, extra = {}, { lending = true } = {}) {
  const a = await startAgent({
    dir: tmp(), host: base, password: 'secret-pw', machine: 'box', trusted: true,
    run: async (cmd) => (cmd === 'nvidia-smi' ? NVSMI : null), platform: 'linux',
    ollama: { command: process.execPath, args: [BIN] }, serverEnv: (card) => ({ FAKE_GPU: card.name }),
    userStore: tmp(), tickMs: 200, basePort: 43000 + Math.floor(Math.random() * 9000),
    watcher: () => ({ supported: true, stop() {} }), fetchRegistry: async () => ({ ok: false }), ...extra,
  });
  cleanup.push(() => a.close());
  await waitFor(() => a.status().cards.length === 2 && (!lending || a.status().cards.every((c) => c.state === 'lending')), 45_000, 'cards up');
  return a;
}
const report = async (call, machine = 'box') => (await call('GET', '/ob/status')).json.machines.find((m) => m.machine === machine)?.report;
const answered = (call, machine, id) => waitFor(async () => {
  const x = (await call('GET', `/ob/machines/${machine}/commands`)).json.find((y) => y.id === id);
  return x.state !== 'queued' && x;
}, 20_000, `command ${id} answered`);
const config = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));

test('the host checks every remote value, applies a patch whole or not at all, and stamps strictly increasing', () => {
  const r = new RemoteStore({ now: () => 5 });
  for (const bad of [{ schedule: [{}] }, { schedule: [{ days: [9], from: '23:00', to: '07:00' }] }, { policy: 'sometimes' },
    { 'cards.__proto__.disabled': true }, { 'cards.a.slots': 9 }, { 'playground.downloads': 'yes' }, { locked: 'x' }, {}, null, []]) {
    assert.throws(() => r.setDesired('pc', bad), Error, JSON.stringify(bad));
  }
  assert.throws(() => r.setDesired('pc', { policy: 'always', 'cards.ghost.paused': true }, { cards: ['real'] }), /no card ghost/);
  assert.deepEqual(r.desired('pc'), { version: 0, fields: {} }, 'nothing applied');
  assert.deepEqual(Object.keys(r.machines), [], 'reading creates nothing');
  const a = r.setDesired('pc', { policy: 'always' }).fields.policy.at;
  const b = r.setDesired('pc', { policy: 'never' }).fields.policy.at;
  assert.ok(b > a, 'two writes in the same millisecond still differ');
  assert.equal(r.setDesired('pc', { schedule: [{ days: [0, 6], from: '23:00', to: '07:00' }] }).version, 3);
});

test('reports are stored typed: hostile values never reach the dashboard as markup', async () => {
  const s = await host();
  const evil = '<img src=x onerror=alert(1)>';
  await s.call('POST', '/pool/machine', { machine: 'x', remote: true, cards: [{ id: 'c1', name: evil, tempC: evil, slots: evil, fixedSlots: evil }],
    playground: { limitGB: evil, models: [{ name: 'm', size: evil, locked: 'yes' }] }, downloadFailures: { m: { count: evil, until: evil, error: evil } }, extra: evil });
  const r = await report(s.call, 'x');
  assert.equal(r.downloadFailures.m.count, 0);
  assert.equal(r.cards[0].tempC, null);
  assert.equal(r.cards[0].slots, null);
  assert.equal(r.cards[0].fixedSlots, null);
  assert.equal(r.playground.limitGB, null);
  assert.equal(r.playground.models[0].locked, false);
  assert.equal(r.extra, undefined);
  assert.equal(typeof r.cards[0].name, 'string', 'text stays text; the page escapes it');
  assert.equal((await s.call('GET', '/ob/insights/cards/%E0%A4%A')).status, 400, 'a bad %-escape is a 400');
  assert.equal((await s.call('PUT', '/ob/machines/x/settings', { 'cards.__proto__.disabled': true })).status, 400);
  assert.equal((await s.call('PUT', '/ob/machines/x/settings', { 'cards.ghost.disabled': true })).status, 400, 'only cards it reported');
});

test('remote settings and commands survive a host restart', async () => {
  const dir = tmp();
  const h = await startHost({ port: 0, password: 'secret-pw', stateDir: dir, beacon: false });
  const call = api(`http://127.0.0.1:${h.port}`, 'secret-pw');
  await call('POST', '/pool/machine', { machine: 'box', remote: true, cards: [] });
  assert.equal((await call('PUT', '/ob/machines/box/settings', { policy: 'always' })).status, 200);
  assert.equal((await call('POST', '/ob/machines/box/commands', { type: 'pull', model: 'qwen3:8b' })).status, 200);
  await h.close();
  const s = await host(dir);
  assert.equal((await s.call('GET', '/ob/machines/box/settings')).json.fields.policy.value, 'always');
  assert.equal((await s.call('GET', '/ob/machines/box/commands')).json[0].model, 'qwen3:8b');
});

const manifest = (bytes) => async () => ({ ok: true, json: async () => ({ config: { size: 0 }, layers: [{ size: bytes }] }) });

test('a download the pool asks for keeps to the owner\'s limits', async () => {
  const s = await host();
  const a = await agent(s.base, { fetchRegistry: manifest(1024 ** 2) });
  await waitFor(async () => (await report(s.call))?.remote === true, 10_000, 'remote on');
  const pull = async (machine, model) => answered(s.call, machine, (await s.call('POST', `/ob/machines/${machine}/commands`, { type: 'pull', model })).json.id);
  await a.act({ type: 'playground', downloads: false });
  const off = await pull('box', 'tiny:1b');
  assert.equal(off.state, 'failed');
  assert.match(off.error, /downloads aren't allowed/);
  await a.act({ type: 'playground', downloads: true });
  const ok = await pull('box', 'tiny:1b');
  assert.equal(ok.state, 'done', ok.error);
  await agent(s.base, { machine: 'box2', fetchRegistry: manifest(40 * 1024 ** 3) }, { lending: false });
  await waitFor(async () => (await report(s.call, 'box2'))?.remote === true, 30_000, 'box2 remote on');
  // Its card servers may still be starting under load; ask again until one answers on size.
  const big = await waitFor(async () => { const r = await pull('box2', 'huge:70b'); return !/no card server/.test(r.error || '') && r; }, 60_000, 'a size answer');
  assert.match(big.error, /too big/);
});

test('a policy set from the pool is remembered as the pool\'s; switching pools turns management off', async () => {
  const s = await host();
  const dir = tmp();
  const a = await agent(s.base, { dir });
  await waitFor(async () => (await report(s.call))?.remote === true, 10_000, 'remote on');
  await s.call('PUT', '/ob/machines/box/settings', { policy: 'always' });
  await waitFor(() => a.status().policy === 'always', 10_000, 'applied');
  assert.equal(config(dir).policyBy, 'pool');
  await a.act({ type: 'policy', policy: 'always' });
  assert.equal(config(dir).policyBy, 'owner');
  await a.act({ type: 'join', url: 'http://127.0.0.1:9', password: 'x' });
  assert.equal(a.status().remote, false, 'a different pool has to be allowed again');
});

test('a remote setting is ignored while the owner hasn\'t allowed it', async () => {
  const s = await host();
  const a = await agent(s.base, { trusted: false });
  s.h.remote.setDesired('box', { policy: 'never' });
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(a.status().policy, 'when-free');
});

// A stand-in host whose clock runs 10 minutes ahead, with settings the test controls.
async function fakeHost() {
  const AHEAD = 10 * 60_000;
  const st = { fields: {}, version: 0 };
  const srv = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/pool/settings')) return res.end(JSON.stringify({ version: st.version, fields: st.fields, now: Date.now() + AHEAD }));
    if (req.url.startsWith('/pool/commands')) return res.end(JSON.stringify({ commands: [] }));
    res.statusCode = 404;
    return res.end('{}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  cleanup.push(() => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }));
  return { base: `http://127.0.0.1:${srv.address().port}`, st, AHEAD };
}

test('newest wins across clocks that disagree, and across an agent restart', async () => {
  const f = await fakeHost();
  const dir = tmp();
  const a = await agent(f.base, { dir }, { lending: false });
  await a.act({ type: 'playground', downloads: false });   // the owner, at agent time T
  const T = Date.now();
  // The dashboard's change was made 5 s BEFORE the owner's, stamped by a host clock 10 min ahead.
  f.st.fields = { 'playground.downloads': { value: true, at: T - 5000 + f.AHEAD } };
  f.st.version = 1;
  await waitFor(() => a.status().appliedVersion === 1, 10_000, 'seen');
  assert.equal(a.status().playground.downloads, false, 'the owner\'s later change stands');
  assert.deepEqual(a.status().localOverride, ['playground.downloads']);
  await a.close();
  const b = await agent(f.base, { dir }, { lending: false });   // restarted: it remembers what it handled
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(b.status().playground.downloads, false);
  f.st.fields = { 'playground.downloads': { value: true, at: Date.now() + f.AHEAD } };   // a fresh change, after the owner's
  f.st.version = 2;
  await waitFor(() => b.status().playground.downloads === true, 10_000, 'newer remote change applied');
});
