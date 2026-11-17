import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RequestQueue, errorText } from '../src/queue.mjs';

const ok = (body = '{"ok":1}') => ({ status: 200, body });
const req = (body, jobId = 'j1') => ({ jobId, path: '/api/chat', body });

// â”€â”€ core queue behaviour â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

test('a waiting worker gets a request the moment a client enqueues it', async () => {
  const q = new RequestQueue();
  q.register('w1', { slots: 1 });
  const taking = q.take('w1');
  const result = q.enqueue(req('{"a":1}'));
  const r = await taking;
  assert.equal(r.path, '/api/chat');
  assert.equal(r.body, '{"a":1}');
  q.complete(r.id, 'w1', ok());
  assert.deepEqual(await result, { status: 200, body: '{"ok":1}' });
  assert.equal(q.status().workers[0].done, 1);
});

test('queues requests until a worker asks, FIFO within a job', async () => {
  const q = new RequestQueue();
  q.register('w1');
  q.enqueue(req('first'));
  q.enqueue(req('second'));
  assert.equal(q.status().queued, 2);
  assert.equal((await q.take('w1')).body, 'first');
  assert.equal((await q.take('w1')).body, 'second');
});

test('take resolves null when nothing arrives in time', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const q = new RequestQueue();
  q.register('w1');
  const p = q.take('w1', { waitMs: 1000 });
  t.mock.timers.tick(1000);
  assert.equal(await p, null);
});

test('re-queues a worker failure to a different worker', async () => {
  const q = new RequestQueue();
  q.register('bad'); q.register('good');
  const result = q.enqueue(req('x'));
  const r1 = await q.take('bad');
  q.complete(r1.id, 'bad', { status: 0, error: 'ECONNREFUSED' });
  const r2 = await q.take('good');
  assert.equal(r2.id, r1.id);
  q.complete(r2.id, 'good', ok());
  assert.equal((await result).status, 200);
  const bad = q.status().workers.find((w) => w.id === 'bad');
  assert.equal(bad.failed, 1);
  assert.equal(bad.done, 0);
});

test('errors say what Ollama said, and when', async () => {
  assert.equal(errorText({ status: 500, body: '{"error":"model runner has unexpectedly stopped"}' }), 'HTTP 500: model runner has unexpectedly stopped');
  assert.equal(errorText({ status: 502, body: 'Bad Gateway\nmore' }), 'HTTP 502: Bad Gateway');
  assert.equal(errorText({ status: 500, body: '' }), 'HTTP 500');
  assert.equal(errorText({ status: 0, error: 'ECONNREFUSED' }), 'ECONNREFUSED');
  const t = 1000;
  const q = new RequestQueue({ now: () => t });
  q.register('a'); q.register('b');
  q.enqueue(req('x'));
  const r = await q.take('a');
  q.complete(r.id, 'a', { status: 500, body: '{"error":"boom"}' });
  const a = q.status().workers.find((w) => w.id === 'a');
  assert.deepEqual([a.lastError, a.lastErrorAt], ['HTTP 500: boom', 1000]);
});

test('a request that fails the same way on two cards is handed back, not tried on every card', async () => {
  const q = new RequestQueue();
  for (const id of ['a', 'b', 'c']) q.register(id);
  const result = q.enqueue(req('poison'));
  const bad = { status: 500, body: '{"error":"failed to parse output"}' };
  const r1 = await q.take('a');
  q.complete(r1.id, 'a', bad);
  const r2 = await q.take('b');
  q.complete(r2.id, 'b', bad);
  const res = await result;
  assert.equal(res.status, 500);
  assert.match(JSON.parse(res.body).error, /2 cards failed this request the same way.*failed to parse output/);
  assert.equal(q.status().queued, 0, 'card c never got it');
  // A card that couldn't be reached says nothing about the request: keep going.
  const again = q.enqueue(req('flaky'));
  const s1 = await q.take('a');
  q.complete(s1.id, 'a', { status: 0, error: 'ECONNREFUSED' });
  const s2 = await q.take('b');
  q.complete(s2.id, 'b', { status: 0, error: 'ECONNREFUSED' });
  const s3 = await q.take('c');
  q.complete(s3.id, 'c', ok());
  assert.equal((await again).status, 200);
});

test('a missing model (404) is retryable, other 4xx are final', async () => {
  const q = new RequestQueue({ maxAttempts: 2 });
  q.register('w');
  const r404 = q.enqueue(req('a'));
  const j = await q.take('w');
  q.complete(j.id, 'w', { status: 404, body: 'model not found' });
  assert.equal(q.status().queued, 1);
  const r400 = q.enqueue(req('b'));
  const taken = [await q.take('w'), await q.take('w')];
  assert.equal(taken[0].body, 'b'); // one this worker hasn't failed goes first
  const ja = taken.find((x) => x.body === 'a');
  const jb = taken.find((x) => x.body === 'b');
  q.complete(jb.id, 'w', { status: 400, body: 'bad request' });
  assert.deepEqual(await r400, { status: 400, body: 'bad request' });
  q.complete(ja.id, 'w', { status: 404, body: 'model not found' });
  assert.equal((await r404).status, 502);
});

test('re-queues requests whose lease expired and ignores the late result', async () => {
  let now = 0;
  const q = new RequestQueue({ leaseMs: 100, now: () => now });
  q.register('slow'); q.register('fast');
  const result = q.enqueue(req('x'));
  const r = await q.take('slow');
  now = 500;
  q.expireLeases();
  const again = await q.take('fast');
  assert.equal(again.id, r.id);
  assert.equal(q.complete(r.id, 'slow', ok('late')), false);
  q.complete(again.id, 'fast', ok('fresh'));
  assert.deepEqual(await result, { status: 200, body: 'fresh' });
});

test('leave re-queues the worker\'s requests; models() is the intersection', async () => {
  const q = new RequestQueue();
  q.register('a', { models: ['gemma4:12b', 'qwen3:8b'] });
  q.register('b', { models: ['gemma4:12b'] });
  assert.deepEqual(q.models(), ['gemma4:12b']);
  q.enqueue(req('x'));
  await q.take('a');
  q.leave('a');
  assert.equal(q.status().queued, 1);
  assert.deepEqual(q.models(), ['gemma4:12b']);
});

test('a paused worker gets no new requests and resumes cleanly', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const q = new RequestQueue();
  q.register('gpu');
  const waiting = q.take('gpu');
  q.setPaused('gpu', true);
  assert.equal(await waiting, null);
  q.enqueue(req('x'));
  const paused = q.take('gpu');
  t.mock.timers.tick(5000);
  assert.equal(await paused, null);
  assert.equal(q.status().queued, 1);
  assert.equal(q.status().workers[0].paused, true);
  q.setPaused('gpu', false);
  assert.equal((await q.take('gpu')).body, 'x');
});

// â”€â”€ job-aware routing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

test('routes only to eligible cards', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const q = new RequestQueue({ canServe: (w, jobId) => jobId !== 'x' || w.id === 'a' });
  q.register('a'); q.register('b');
  q.enqueue(req('only-a', 'x'));
  const fromB = q.take('b', { waitMs: 1000 });
  t.mock.timers.tick(1000);
  assert.equal(await fromB, null);
  assert.equal((await q.take('a')).body, 'only-a');
});

test('requeues only to eligible cards', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const q = new RequestQueue({ canServe: (w) => w.id !== 'b' });
  q.register('a'); q.register('b'); q.register('c');
  q.enqueue(req('x'));
  const r = await q.take('a');
  const bWait = q.take('b', { waitMs: 1000 });
  q.leave('a');
  t.mock.timers.tick(1000);
  assert.equal(await bWait, null);
  assert.equal((await q.take('c')).id, r.id);
});

test('priority follows rankOf', async () => {
  const rank = { late: 5, early: 1 };
  const q = new RequestQueue({ rankOf: (id) => rank[id] });
  q.register('w');
  q.enqueue(req('from-late', 'late'));
  q.enqueue(req('from-early', 'early'));
  assert.equal((await q.take('w')).body, 'from-early');
  assert.equal((await q.take('w')).body, 'from-late');
});

test('anonymous ranks last', async () => {
  const q = new RequestQueue({ rankOf: (id) => (id === '_' ? Infinity : 0) });
  q.register('w');
  q.enqueue(req('anon', '_'));
  q.enqueue(req('real', 'j1'));
  assert.equal((await q.take('w')).body, 'real');
});

test('dropJob resolves pending and leased requests with the reason', async () => {
  const q = new RequestQueue();
  q.register('w');
  const leased = q.enqueue(req('a'));
  const r = await q.take('w');
  const pending = q.enqueue(req('b'));
  const other = q.enqueue(req('c', 'j2'));
  assert.equal(q.dropJob('j1', 'job exited'), 2);
  for (const p of [leased, pending]) {
    const res = await p;
    assert.equal(res.status, 499);
    assert.match(res.body, /job exited/);
  }
  assert.equal(q.complete(r.id, 'w', ok()), false);
  assert.equal(q.status().queued, 1);
  const rc = await q.take('w');
  q.complete(rc.id, 'w', ok());
  assert.equal((await other).status, 200);
});

test('contentType passes through to the client', async () => {
  const q = new RequestQueue();
  q.register('w');
  const result = q.enqueue(req('x'));
  const r = await q.take('w');
  q.complete(r.id, 'w', { status: 200, body: 'a\nb\n', contentType: 'application/x-ndjson' });
  assert.deepEqual(await result, { status: 200, body: 'a\nb\n', contentType: 'application/x-ndjson' });
});

test('reoffer hands a newly eligible request to an idle waiter', async () => {
  let allowed = false;
  const q = new RequestQueue({ canServe: () => allowed });
  q.register('a');
  const waiting = q.take('a', { waitMs: 60_000 });
  q.enqueue(req('x'));
  allowed = true;
  q.reoffer();
  assert.equal((await waiting).body, 'x');
});

test('a card busy on long requests stays active', async () => {
  let now = 0;
  const q = new RequestQueue({ now: () => now });
  q.register('w');
  q.enqueue(req('long'));
  await q.take('w');
  now = 200_000;
  assert.deepEqual(q.activeWorkers().map((w) => w.id), ['w']);
});

test('lease expiries count toward maxAttempts', async () => {
  let now = 0;
  const q = new RequestQueue({ leaseMs: 100, maxAttempts: 2, now: () => now });
  q.register('w');
  const result = q.enqueue(req('slow'));
  await q.take('w');
  now = 500; q.expireLeases();
  await q.take('w');
  now = 1000; q.expireLeases();
  const r = await result;
  assert.equal(r.status, 502);
  assert.match(r.body, /lease expired/);
  assert.equal(q.status().queued, 0);
});

test('an aborted request leaves the queue and its late result is refused', async () => {
  const q = new RequestQueue();
  q.register('w');
  const ac1 = new AbortController();
  const pending = q.enqueue({ ...req('gone'), signal: ac1.signal });
  ac1.abort();
  assert.equal((await pending).status, 499);
  assert.equal(q.status().queued, 0);
  const ac2 = new AbortController();
  const leased = q.enqueue({ ...req('gone too'), signal: ac2.signal });
  const r = await q.take('w');
  ac2.abort();
  assert.equal((await leased).status, 499);
  assert.equal(q.complete(r.id, 'w', ok()), false);
});

test('release re-queues without spending an attempt', async () => {
  const q = new RequestQueue({ maxAttempts: 1 });
  q.register('gamer'); q.register('other');
  const result = q.enqueue(req('x'));
  const r = await q.take('gamer');
  assert.equal(q.release('gamer', [r.id]), 1);
  const again = await q.take('other');
  assert.equal(again.id, r.id);
  q.complete(again.id, 'other', ok());
  assert.equal((await result).status, 200);
});

test('release ignores requests held by another worker', async () => {
  const q = new RequestQueue();
  q.register('a'); q.register('b');
  q.enqueue(req('x'));
  const r = await q.take('a');
  assert.equal(q.release('b', [r.id, 'nope']), 0);
  assert.equal(q.status().inflight, 1);
});

test('status carries machine, labels and the latest job', async () => {
  const q = new RequestQueue();
  q.register('w', { machine: 'desk', labels: { gpu: 'nvidia' } });
  q.enqueue(req('x', 'j7'));
  await q.take('w');
  const w = q.status().workers[0];
  assert.equal(w.machine, 'desk');
  assert.deepEqual(w.labels, { gpu: 'nvidia' });
  assert.equal(w.jobId, 'j7');
});
