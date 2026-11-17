import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Insights } from '../src/insights.mjs';
import { startHost } from '../src/host.mjs';
import { startFakeOllama } from '../testdata/fake-ollama.mjs';
import { pullWorker, waitFor, api } from '../testdata/helpers.mjs';

const MIN = 60_000, HOUR = 60 * MIN;
const stats = (o = {}) => ({ model: 'm', promptTokens: 10, outputTokens: 20, promptSec: 0.1, genSec: 1, loadSec: 0, loaded: false, totalSec: 1.2, ...o });

test('records land per card, model and job, with wait/latency percentiles', () => {
  let t = 100 * MIN;
  const ins = new Insights({ now: () => t });
  for (let i = 1; i <= 10; i++) ins.record({ card: 'a', job: 'j1', model: 'm', ok: true, retried: i === 1, waitSec: i, latencySec: i * 2, stats: stats() });
  ins.record({ card: 'b', job: 'j1', model: 'm', ok: false, retried: false, waitSec: 0, latencySec: 1, stats: null });
  const s = ins.series({ by: 'card', range: '1h' });
  assert.equal(s.step, MIN);
  const a = s.rows.a.at(-1);
  assert.equal(a.requests, 10);
  assert.equal(a.retried, 1);
  assert.equal(a.outputTokens, 200);
  assert.equal(a.waitP50, 5);
  assert.equal(a.waitP90, 9);
  assert.equal(s.rows.b.at(-1).failed, 1);
  assert.equal(ins.series({ by: 'model', range: '1h' }).rows.m.at(-1).requests, 11, 'the failed request was for model m too');
  assert.equal(ins.series({ by: 'job', range: '1h' }).rows.j1.at(-1).requests, 11);
});

test('loads are counted and the last hour is summed per card', () => {
  let t = 10 * HOUR;
  const ins = new Insights({ now: () => t });
  for (let i = 0; i < 7; i++) { ins.record({ card: 'arc', job: 'j', model: i % 2 ? 'a' : 'b', ok: true, retried: false, waitSec: 0, latencySec: 1, stats: stats({ loaded: true, loadSec: 4 }) }); t += 5 * MIN; }
  assert.equal(ins.loadsLastHour('arc'), 7);
  t += 2 * HOUR;
  assert.equal(ins.loadsLastHour('arc'), 0);
});

test('minute buckets older than 24 h roll up into hours, and 7d/30d ranges read hours', () => {
  let t = 1000 * HOUR;
  const ins = new Insights({ now: () => t });
  for (let i = 0; i < 6; i++) { ins.record({ card: 'a', job: 'j', model: 'm', ok: true, retried: false, waitSec: 1, latencySec: 1, stats: stats() }); t += 10 * MIN; }
  t += 30 * HOUR;
  ins.record({ card: 'a', job: 'j', model: 'm', ok: true, retried: false, waitSec: 1, latencySec: 1, stats: stats() });
  assert.ok(ins.minutes.every((b) => b.t > t - 24 * HOUR - MIN), 'old minutes rolled away');
  const week = ins.series({ by: 'card', range: '7d' });
  assert.equal(week.step, HOUR);
  assert.equal(week.rows.a.reduce((s, p) => s + p.requests, 0), 7);
});

test('card samples and "now" numbers; JSON round-trip', () => {
  const t = 50 * HOUR;
  const ins = new Insights({ now: () => t });
  ins.sampleCard('a', { tempC: 66, vramUsedMB: 12000, vramMB: 16303, util: 90, powerW: 250, slotsBusy: 2, slots: 2, state: 'lending' });
  ins.record({ card: 'a', job: 'j', model: 'gemma4:12b', ok: true, retried: false, waitSec: 0, latencySec: 1, stats: stats({ model: 'gemma4:12b', outputTokens: 600 }) });
  assert.equal(ins.cardSeries('a', '1h').at(-1).tempC, 66);
  const n = ins.now();
  assert.equal(n.outputTokPerSec, 10);
  assert.deepEqual(n.loadedModels, { a: 'gemma4:12b' });
  const back = Insights.fromJSON(JSON.parse(JSON.stringify(ins.toJSON())), { now: () => t });
  assert.deepEqual(back.series({ by: 'card', range: '1h' }), ins.series({ by: 'card', range: '1h' }));
});

test('the host records answers that pass through the pool', async () => {
  const h = await startHost({ port: 0, password: 'secret-pw', stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ob ins ')), beacon: false });
  const f = await startFakeOllama();
  const w = await pullWorker(`http://127.0.0.1:${h.port}`, { id: 'w', ollama: f.url, token: 'secret-pw' });
  after(async () => { w.stop(); await f.close(); await h.close(); });
  const call = api(`http://127.0.0.1:${h.port}`, 'secret-pw');
  assert.equal((await call('POST', '/api/chat', { model: 'fake', stream: false, messages: [] })).status, 200);
  const s = await waitFor(async () => { const r = (await call('GET', '/ob/insights?by=card&range=1h')).json; return r.rows.w && r; }, 3000, 'recorded');
  assert.equal(s.rows.w.at(-1).outputTokens, 20);
  assert.equal((await call('GET', '/ob/insights/now')).status, 200);
});

test('"output tokens per second now" covers the last 60 s, not up to two minutes', () => {
  let t = 70 * HOUR;
  const ins = new Insights({ now: () => t });
  for (let s = 0; s < 120; s++) { ins.record({ card: 'a', job: 'j', model: 'm', ok: true, retried: false, waitSec: 0, latencySec: 1, stats: stats({ outputTokens: 10 }) }); t += 1000; }
  t -= 1000;   // at :59 of the second minute, after a steady 10 tok/s
  assert.ok(Math.abs(ins.now().outputTokPerSec - 10) < 0.5, `got ${ins.now().outputTokPerSec}`);
});
