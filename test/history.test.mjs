import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addRequestToJob, prune, trimLog, filterHistory, toCsv } from '../src/history.mjs';
import { startHost } from '../src/host.mjs';
import { startFakeOllama } from '../testdata/fake-ollama.mjs';
import { pullWorker, waitFor, api } from '../testdata/helpers.mjs';

const DAY = 24 * 60 * 60_000;
const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'testdata');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ob hist '));

test('request stats accumulate per job and per card', () => {
  const job = { id: 'j1' };
  const st = { model: 'm', promptTokens: 10, outputTokens: 20, genSec: 1, loaded: true, loadSec: 2 };
  addRequestToJob(job, { card: 'a', cardLabel: 'RTX', ok: true, retried: false, stats: st });
  addRequestToJob(job, { card: 'a', cardLabel: 'RTX', ok: true, retried: true, stats: { ...st, loaded: false } });
  addRequestToJob(job, { card: 'b', cardLabel: 'Arc', ok: false, retried: false, stats: null, error: 'HTTP 500' });
  assert.deepEqual(job.stats.cards, { a: { label: 'RTX', requests: 2, outputTokens: 40 }, b: { label: 'Arc', requests: 1, outputTokens: 0 } });
  assert.equal(job.stats.requests, 3);
  assert.equal(job.stats.failed, 1);
  assert.equal(job.stats.retried, 1);
  assert.equal(job.stats.loads, 1);
  assert.deepEqual(job.stats.lastErrors, ['Arc: HTTP 500']);
  assert.deepEqual(job.modelsUsed, ['m']);
});

test('retention keeps the newest 2,000 finished jobs within 90 days and never touches live ones', () => {
  const now = 1000 * DAY;
  const jobs = Array.from({ length: 2050 }, (_, i) => ({ id: `j${i}`, status: 'done', finishedAt: now - i * 60_000 }));
  jobs.push({ id: 'old', status: 'failed', finishedAt: now - 100 * DAY }, { id: 'live', status: 'running', finishedAt: null }, { id: 'q', status: 'queued' });
  const gone = new Set(prune({ jobs, now }));
  assert.equal(gone.size, 51);
  assert.ok(gone.has('old') && gone.has('j2049') && !gone.has('j0') && !gone.has('live') && !gone.has('q'));
});

test('trimLog keeps the tail', () => {
  const f = path.join(tmp(), 'j.log');
  fs.writeFileSync(f, 'a'.repeat(1000) + 'TAIL');
  trimLog(f, 100);
  const t = fs.readFileSync(f, 'utf8');
  assert.ok(t.length <= 100 && t.endsWith('TAIL'));
});

test('filters, search and paging, newest first', () => {
  const jobs = [
    { id: 'j1', name: 'Royals · enhance', status: 'done', template: 'enhance', finishedAt: 1000 },
    { id: 'j2', name: 'Global · aka', status: 'failed', template: 'aka', finishedAt: 2000 },
    { id: 'j3', name: 'Global · enhance', status: 'done', template: 'enhance', finishedAt: 3000 },
    { id: 'j4', name: 'running', status: 'running', finishedAt: null },
  ];
  assert.deepEqual(filterHistory(jobs, {}).jobs.map((j) => j.id), ['j3', 'j2', 'j1']);
  assert.deepEqual(filterHistory(jobs, { q: 'global' }).jobs.map((j) => j.id), ['j3', 'j2']);
  assert.deepEqual(filterHistory(jobs, { status: 'done', template: 'enhance' }).jobs.map((j) => j.id), ['j3', 'j1']);
  const p1 = filterHistory(jobs, { limit: 2 });
  assert.deepEqual(p1.jobs.map((j) => j.id), ['j3', 'j2']);
  assert.equal(p1.next, 'j2');
  assert.deepEqual(filterHistory(jobs, { limit: 2, before: 'j2' }).jobs.map((j) => j.id), ['j1']);
  assert.deepEqual(filterHistory(jobs, { from: 1500, to: 2500 }).jobs.map((j) => j.id), ['j2']);
});

test('CSV export escapes commas and quotes', () => {
  const csv = toCsv([{ id: 'j1', name: 'a, "b"', status: 'done', startedAt: 0, finishedAt: 60_000, exitCode: 0, progress: { done: 5, total: 5 }, stats: { outputTokens: 9 } }]);
  const [head, row] = csv.trim().split('\n');
  assert.match(head, /^id,name,status,/);
  assert.match(row, /^j1,"a, ""b""",done,/);
});

test('the host keeps per-job stats, a timeline, notes, logs and history', async () => {
  const h = await startHost({ port: 0, password: 'secret-pw', stateDir: tmp(), beacon: false });
  const f = await startFakeOllama();
  const w = await pullWorker(`http://127.0.0.1:${h.port}`, { id: 'w', label: 'Card W', ollama: f.url, token: 'secret-pw' });
  after(async () => { w.stop(); await f.close(); await h.close(); });
  const call = api(`http://127.0.0.1:${h.port}`, 'secret-pw');
  const j = (await call('POST', '/ob/jobs', { name: 'calls', command: process.execPath, args: [path.join(DATA, 'call-ollama.mjs'), '3'], cwd: DATA })).json;
  const live = await call('POST', '/ob/jobs', { name: 'long', command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: DATA });
  await waitFor(async () => (await call('GET', `/ob/jobs/${j.id}`)).json.status === 'done', 15_000, 'done');
  const d = (await call('GET', `/ob/jobs/${j.id}`)).json;
  assert.equal(d.stats.requests, 3);
  assert.equal(d.stats.outputTokens, 60);
  assert.equal(d.stats.cards.w.requests, 3);
  assert.ok(Array.isArray(d.timeline.done));
  assert.equal((await call('PATCH', `/ob/jobs/${j.id}`, { notes: 'looked fine' })).json.notes, 'looked fine');
  const hist = (await call('GET', '/ob/history?q=calls')).json;
  assert.deepEqual(hist.jobs.map((x) => x.id), [j.id]);
  assert.match((await call('GET', `/ob/jobs/${j.id}/log?q=3/3`)).text, /3\/3/);
  const dl = await fetch(`http://127.0.0.1:${h.port}/ob/jobs/${j.id}/log?download=1`);
  assert.match(dl.headers.get('content-disposition') || '', /attachment/);
  assert.match((await call('GET', '/ob/history/export?format=csv')).text, /^id,name,status/);
  assert.equal((await call('DELETE', `/ob/jobs/${live.json.id}`)).status, 409);
  assert.equal((await call('DELETE', `/ob/jobs/${j.id}`)).status, 200);
  assert.equal((await call('GET', `/ob/jobs/${j.id}`)).status, 404);
});

test('a running job\'s progress graph survives a host restart', async () => {
  const dir = tmp();
  const h = await startHost({ port: 0, password: 'secret-pw', stateDir: dir, beacon: false });
  const f = await startFakeOllama();
  const w = await pullWorker(`http://127.0.0.1:${h.port}`, { id: 'w', ollama: f.url, token: 'secret-pw' });
  const call = api(`http://127.0.0.1:${h.port}`, 'secret-pw');
  const j = (await call('POST', '/ob/jobs', { name: 'long', command: process.execPath, args: ['-e', 'setTimeout(()=>{},20000)'], cwd: DATA })).json;
  await waitFor(async () => (await call('GET', `/ob/jobs/${j.id}`)).json.status === 'running', 10_000, 'running');
  assert.equal((await call('POST', `/ob/jobs/${j.id}/progress`, { done: 5, total: 10 })).status, 200);
  w.stop();
  await h.close();
  await f.close();
  const h2 = await startHost({ port: 0, password: 'secret-pw', stateDir: dir, beacon: false });
  after(() => h2.close());
  const d = (await api(`http://127.0.0.1:${h2.port}`, 'secret-pw')('GET', `/ob/jobs/${j.id}`)).json;
  assert.equal(d.timeline?.done.at(-1), 5);
});

test('history search also finds models used, summaries and notes', () => {
  const jobs = [
    { id: 'a', name: 'one', status: 'done', finishedAt: 3, modelsUsed: ['gemma4:12b'] },
    { id: 'b', name: 'two', status: 'done', finishedAt: 2, summary: { text: 'Three items timed out.' } },
    { id: 'c', name: 'three', status: 'failed', finishedAt: 1, notes: 'rerun after the driver update' },
  ];
  assert.deepEqual(filterHistory(jobs, { q: 'GEMMA' }).jobs.map((j) => j.id), ['a']);
  assert.deepEqual(filterHistory(jobs, { q: 'timed out' }).jobs.map((j) => j.id), ['b']);
  assert.deepEqual(filterHistory(jobs, { q: 'driver' }).jobs.map((j) => j.id), ['c']);
});

test('CSV quotes carriage returns and defuses spreadsheet formulas', () => {
  const csv = toCsv([{ id: 'a', name: '=HYPERLINK("x")', status: 'done', template: '@t', exitCode: -1, progress: {}, stats: {} }, { id: 'b', name: 'two\rlines', status: 'done' }]);
  assert.match(csv, /"'=HYPERLINK\(""x""\)"/);
  assert.match(csv, /,'@t,/);
  assert.match(csv, /,-1,/, 'numbers stay numbers');
  assert.match(csv, /"two\rlines"/);
});
