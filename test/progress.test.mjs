import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROGRESS, parseProgress, advance, etaSeconds, queueEta } from '../src/progress.mjs';

test('parseProgress reads done/total with commas', () => {
  assert.deepEqual(parseProgress('  650/5,394 · 0.5/s · errors 0'), { done: 650, total: 5394 });
  assert.equal(parseProgress('no numbers here'), null);
  assert.ok(DEFAULT_PROGRESS instanceof RegExp);
});

test('parseProgress with a custom pattern', () => {
  assert.deepEqual(parseProgress('item 7 of 20', /item (\d+) of (\d+)/), { done: 7, total: 20 });
  assert.equal(parseProgress('3/9', /item (\d+) of (\d+)/), null);
});

test('advance: EMA rate over samples at least 5 s apart', () => {
  let p = { done: 0, total: 100, rate: 0 };
  p = advance(p, { done: 0 }, 0);
  p = advance(p, { done: 10 }, 10_000);           // 1/s
  assert.equal(p.rate, 1);
  const before = p;
  p = advance(p, { done: 12 }, 12_000);           // < 5 s: done moves, rate doesn't
  assert.equal(p.done, 12);
  assert.equal(p.rate, before.rate);
  p = advance(p, { done: 40 }, 20_000);           // 30 items / 10 s since last sample = 3/s
  assert.ok(Math.abs(p.rate - (0.3 * 3 + 0.7 * 1)) < 1e-9);
  assert.equal(p.total, 100);
});

test('advance: a total in the sample replaces the old one', () => {
  const p = advance({ done: 0, total: null, rate: 0 }, { done: 1, total: 50 }, 0);
  assert.equal(p.total, 50);
});

test('advance: done going down resets the rate (next pass in the same job)', () => {
  let p = { done: 0, total: 10, rate: 0 };
  p = advance(p, { done: 0 }, 0);
  p = advance(p, { done: 10 }, 10_000);
  p = advance(p, { done: 2, total: 50 }, 20_000);
  assert.equal(p.rate, 0);
  assert.equal(p.done, 2);
});

test('etaSeconds', () => {
  assert.equal(etaSeconds({ done: 100, total: 200, rate: 2 }), 50);
  assert.equal(etaSeconds({ done: 100, total: null, rate: 2 }), null);
  assert.equal(etaSeconds({ done: 100, total: 200, rate: 0 }), null);
});

test('queueEta sums known parts and counts the unknowns', () => {
  const jobs = [
    { status: 'running', progress: { done: 100, total: 200, rate: 2 } },  // 50 s
    { status: 'queued', progress: { done: 0, total: null, rate: 0 }, estimate: 40 }, // 40 / 2 = 20 s
    { status: 'queued', progress: { done: 0, total: null, rate: 0 }, estimate: null },
    { status: 'done', progress: { done: 5, total: 5, rate: 0 } },
  ];
  assert.deepEqual(queueEta(jobs), { seconds: 70, unknown: 1 });
});

test('queueEta without any running rate counts queued jobs as unknown', () => {
  assert.deepEqual(queueEta([{ status: 'queued', progress: { done: 0, total: 10, rate: 0 } }]), { seconds: 0, unknown: 1 });
});
