import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Metrics } from '../src/metrics.mjs';

const MIN = 60_000;

test('records land in per-minute buckets, zero-filled, oldest first', () => {
  let now = 100 * MIN;
  const m = new Metrics({ now: () => now });
  m.record({ cardId: 'a', jobId: 'j1', ok: true, ms: 100 });
  m.record({ cardId: 'a', jobId: 'j1', ok: true, ms: 300 });
  now += 2 * MIN;
  m.record({ cardId: 'a', jobId: 'j1', ok: false, ms: 50 });
  const s = m.series({ by: 'card', minutes: 3 });
  assert.equal(s.step, MIN);
  assert.equal(s.t0, 100 * MIN);
  assert.deepEqual(s.rows.a.done, [2, 0, 0]);
  assert.deepEqual(s.rows.a.failed, [0, 0, 1]);
  assert.deepEqual(s.rows.a.avgMs, [200, 0, 50]);
});

test('series by job', () => {
  const m = new Metrics({ now: () => 5 * MIN });
  m.record({ cardId: 'a', jobId: 'j1', ok: true, ms: 10 });
  m.record({ cardId: 'b', jobId: 'j1', ok: true, ms: 10 });
  m.record({ cardId: 'b', jobId: 'j2', ok: true, ms: 10 });
  const s = m.series({ by: 'job', minutes: 1 });
  assert.deepEqual(s.rows.j1.done, [2]);
  assert.deepEqual(s.rows.j2.done, [1]);
});

test('data older than the window is dropped', () => {
  let now = 0;
  const m = new Metrics({ now: () => now, minutes: 10 });
  m.record({ cardId: 'a', jobId: 'j', ok: true, ms: 1 });
  now = 20 * MIN;
  m.record({ cardId: 'b', jobId: 'j', ok: true, ms: 1 });
  assert.equal(m.buckets.length, 1);
  assert.equal(m.series({ by: 'card', minutes: 30 }).rows.a, undefined);
});

test('JSON round-trip keeps the series', () => {
  const now = () => 7 * MIN;
  const m = new Metrics({ now });
  m.record({ cardId: 'a', jobId: 'j', ok: true, ms: 40 });
  const m2 = Metrics.fromJSON(JSON.parse(JSON.stringify(m.toJSON())), { now });
  assert.deepEqual(m2.series({ by: 'card', minutes: 2 }), m.series({ by: 'card', minutes: 2 }));
});
