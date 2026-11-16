import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHost } from '../src/host.mjs';
import { startFakeOllama, NDJSON } from '../testdata/fake-ollama.mjs';
import { pullWorker, waitFor, lanAddress, api } from '../testdata/helpers.mjs';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'testdata');
const CALL = path.join(DATA, 'call-ollama.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rigpool host '));
const cleanup = [];
after(async () => { for (const f of cleanup.reverse()) await f(); });

async function setup({ cards = [], hostOpts = {} } = {}) {
  const host = await startHost({ port: 0, password: 'secret-pw', stateDir: tmp(), bind: '0.0.0.0', ...hostOpts });
  cleanup.push(() => host.close());
  const base = `http://127.0.0.1:${host.port}`;
  const out = { host, base, call: api(base, 'secret-pw'), fakes: {}, workers: {} };
  for (const c of cards) {
    const fake = await startFakeOllama({ models: c.models || ['fake'], delayMs: c.delayMs || 0 });
    cleanup.push(() => fake.close());
    const w = await pullWorker(base, { id: c.id, ollama: fake.url, models: c.models || ['fake'], token: 'secret-pw', extra: c.extra || {} });
    cleanup.push(() => w.stop());
    out.fakes[c.id] = fake;
    out.workers[c.id] = w;
  }
  return out;
}

const loopbackJob = (extra = {}) => ({ name: 'calls', command: process.execPath, args: [CALL, '5'], cwd: DATA, models: ['fake'], ...extra });
const jobById = async (call, id) => (await call('GET', '/rp/status')).json.jobs.find((j) => j.id === id);

test('routes job requests by selector', async () => {
  const s = await setup({ cards: [
    { id: 'nv', extra: { machine: 'desk', labels: { gpu: 'nvidia' } } },
    { id: 'arc', extra: { machine: 'desk', labels: { gpu: 'intel' } } },
  ] });
  const r = await s.call('POST', '/rp/jobs', loopbackJob({ selector: 'gpu=nvidia' }));
  assert.equal(r.status, 200, r.text);
  const job = await waitFor(async () => { const j = await jobById(s.call, r.json.id); return j.status === 'done' && j; }, 15_000, 'job done');
  assert.equal(job.progress.done, 5);
  assert.equal(s.fakes.nv.calls.length, 5);
  assert.equal(s.fakes.arc.calls.length, 0);
});

test('ndjson passthrough on the anonymous route', async () => {
  const s = await setup({ cards: [{ id: 'w' }] });
  const r = await fetch(`${s.base}/api/chat`, { method: 'POST', body: JSON.stringify({ model: 'fake', messages: [] }) });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/x-ndjson');
  assert.equal(await r.text(), NDJSON);
});

test('inference and free-form jobs are loopback-only; LAN may use templates', async (t) => {
  const ip = lanAddress();
  if (!ip) return t.skip('no LAN address');
  const dir = tmp();
  const jobsFile = path.join(dir, 'rigpool.jobs.json');
  fs.writeFileSync(jobsFile, JSON.stringify({ templates: [{ id: 'one', command: process.execPath, args: [CALL, '1'], cwd: DATA, models: ['fake'] }] }));
  const s = await setup({ cards: [{ id: 'w' }], hostOpts: { jobsFile } });
  const lan = api(`http://${ip}:${s.host.port}`, 'secret-pw');
  assert.equal((await lan('POST', '/api/chat', { model: 'fake', stream: false })).status, 403);
  assert.equal((await lan('POST', '/rp/jobs', loopbackJob())).status, 403);
  assert.equal((await api(`http://${ip}:${s.host.port}`, 'wrong')('GET', '/rp/status')).status, 401);
  const ok = await lan('POST', '/rp/jobs', { template: 'one', params: {} });
  assert.equal(ok.status, 200, ok.text);
  await waitFor(async () => (await jobById(s.call, ok.json.id)).status === 'done', 15_000, 'template job done');
  const status = (await lan('GET', '/rp/status')).json;
  assert.equal(status.jobs[0].env, undefined, 'job env is never sent to browsers');
});

test('a job whose selector matches no card waits, then starts when a label is added', async () => {
  const s = await setup({ cards: [{ id: 'nv', extra: { labels: { gpu: 'nvidia' } } }] });
  const r = await s.call('POST', '/rp/jobs', loopbackJob({ args: [CALL, '1'], selector: 'gpu=amd' }));
  await waitFor(async () => (await jobById(s.call, r.json.id)).reason === 'waiting for cards', 5_000, 'waiting reason');
  assert.equal((await jobById(s.call, r.json.id)).status, 'queued');
  assert.equal((await s.call('POST', '/rp/cards/labels', { card: 'nv', labels: { gpu: 'amd' } })).status, 200);
  await waitFor(async () => (await jobById(s.call, r.json.id)).status === 'done', 15_000, 'job done');
});

test('a waiting job does not hold up the one behind it', async () => {
  const s = await setup({ cards: [{ id: 'w' }] });
  const stuck = await s.call('POST', '/rp/jobs', loopbackJob({ args: [CALL, '1'], selector: 'gpu=amd' }));
  const next = await s.call('POST', '/rp/jobs', loopbackJob({ args: [CALL, '1'] }));
  await waitFor(async () => (await jobById(s.call, next.json.id)).status === 'done', 15_000, 'second job done');
  assert.equal((await jobById(s.call, stuck.json.id)).status, 'queued');
});

test('cancel mid-flight: job cancelled, late result refused, host keeps serving', async () => {
  const s = await setup({ cards: [{ id: 'slow', delayMs: 1500 }] });
  const r = await s.call('POST', '/rp/jobs', loopbackJob({ args: [CALL, '3'] }));
  await waitFor(async () => (await s.call('GET', '/rp/status')).json.workers.find((w) => w.id === 'slow')?.inflight === 1, 10_000, 'in flight');
  assert.equal((await s.call('POST', `/rp/jobs/${r.json.id}/cancel`)).status, 200);
  assert.equal((await jobById(s.call, r.json.id)).status, 'cancelled');
  await waitFor(() => s.workers.slow.state.results.includes(410), 5_000, 'late result refused');
  assert.equal((await s.call('GET', '/rp/status')).status, 200);
});

test('an old-protocol worker (no machine, no labels) serves anonymous requests', async () => {
  const s = await setup();
  const fake = await startFakeOllama();
  cleanup.push(() => fake.close());
  const w = await pullWorker(s.base, { id: 'JacobPC-http-127-0-0-1-11434-abc', ollama: fake.url, token: 'secret-pw' });
  cleanup.push(() => w.stop());
  const r = await s.call('POST', '/api/chat', { model: 'fake', stream: false, messages: [] });
  assert.equal(r.status, 200);
  assert.equal(r.json.message.content, 'ok');
  const legacy = await fetch(`${s.base}/pool/status`).then((x) => x.json());
  assert.equal(legacy.workers[0].id, 'JacobPC-http-127-0-0-1-11434-abc');
  const status = (await s.call('GET', '/rp/status')).json;
  assert.equal(status.machines[0].machine, 'JacobPC');
});

test('restart: a running job comes back failed with reason "host restarted"', async () => {
  const stateDir = tmp();
  const fake = await startFakeOllama({ delayMs: 5000 });
  cleanup.push(() => fake.close());
  const h1 = await startHost({ port: 0, password: 'secret-pw', stateDir });
  const base1 = `http://127.0.0.1:${h1.port}`;
  const w = await pullWorker(base1, { id: 'w', ollama: fake.url, token: 'secret-pw' });
  const r = await api(base1, 'secret-pw')('POST', '/rp/jobs', loopbackJob({ args: [CALL, '1'] }));
  await waitFor(async () => (await jobById(api(base1, 'secret-pw'), r.json.id)).status === 'running', 10_000, 'running');
  w.stop();
  await h1.close();
  const h2 = await startHost({ port: 0, password: 'secret-pw', stateDir });
  cleanup.push(() => h2.close());
  const job = await jobById(api(`http://127.0.0.1:${h2.port}`, 'secret-pw'), r.json.id);
  assert.equal(job.status, 'failed');
  assert.equal(job.reason, 'host restarted');
});

test('reorder, pause/resume and rerun through the control API', async () => {
  const s = await setup();
  const a = (await s.call('POST', '/rp/jobs', loopbackJob({ name: 'a', args: [CALL, '1'] }))).json;
  const b = (await s.call('POST', '/rp/jobs', loopbackJob({ name: 'b', args: [CALL, '1'] }))).json;
  // No cards: a starts (no model constraint? it has models) — both wait queued.
  assert.equal((await s.call('POST', `/rp/jobs/${b.id}/move`, { index: 0 })).status, 200);
  const names = (await s.call('GET', '/rp/status')).json.jobs.map((j) => j.name);
  assert.deepEqual(names, ['b', 'a']);
  assert.equal((await s.call('POST', `/rp/jobs/${a.id}/pause`)).status, 409); // queued jobs can't pause
  assert.equal((await s.call('POST', `/rp/jobs/nope/cancel`)).status, 404);
  await s.call('POST', `/rp/jobs/${a.id}/cancel`);
  const re = await s.call('POST', `/rp/jobs/${a.id}/rerun`);
  assert.equal(re.status, 200);
  assert.equal(re.json.name, 'a');
  assert.equal(re.json.status, 'queued');
});
