import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JobStore, JobStateError } from '../src/jobs.mjs';

const spec = (name, extra = {}) => ({ name, command: 'node', args: ['x.js', name], cwd: '.', ...extra });

test('add gives monotonic ids that survive a reload', () => {
  const s = new JobStore();
  assert.equal(s.add(spec('a')).id, 'j1');
  assert.equal(s.add(spec('b')).id, 'j2');
  const s2 = JobStore.fromJSON(JSON.parse(JSON.stringify(s.toJSON())));
  assert.equal(s2.add(spec('c')).id, 'j3');
  assert.deepEqual(s2.list().map((j) => j.name), ['a', 'b', 'c']);
});

test('new jobs start queued with empty progress and defaults', () => {
  const j = new JobStore().add(spec('a'));
  assert.equal(j.status, 'queued');
  assert.deepEqual(j.progress, { done: 0, total: null, rate: 0 });
  assert.equal(j.modelPolicy, 'one');
  assert.equal(j.minCards, 1);
  assert.deepEqual(j.models, []);
});

test('move reorders queued jobs and rankOf follows', () => {
  const s = new JobStore();
  const [a, b, c] = ['a', 'b', 'c'].map((n) => s.add(spec(n)));
  s.move(c.id, 0);
  assert.deepEqual(s.list().map((j) => j.name), ['c', 'a', 'b']);
  assert.equal(s.rankOf(c.id), 0);
  assert.equal(s.rankOf(b.id), 2);
  assert.equal(s.rankOf('_'), Infinity);
  s.move(a.id, 99);
  assert.deepEqual(s.list().map((j) => j.name), ['c', 'b', 'a']);
});

test('moving a running job throws JobStateError', () => {
  const s = new JobStore();
  const a = s.add(spec('a'));
  s.markStarted(a.id, { model: 'm' });
  assert.throws(() => s.move(a.id, 0), (e) => e instanceof JobStateError && e.message.includes(a.id) && e.message.includes('running'));
});

test('pause and resume a running job', () => {
  const s = new JobStore();
  const a = s.add(spec('a'));
  s.markStarted(a.id, { model: 'm' });
  s.pause(a.id);
  assert.equal(s.get(a.id).status, 'paused');
  s.resume(a.id);
  assert.equal(s.get(a.id).status, 'running');
  assert.throws(() => s.resume(a.id), JobStateError);
});

test('cancel a queued job never starts it', () => {
  const s = new JobStore();
  const a = s.add(spec('a'));
  s.cancel(a.id);
  assert.equal(s.get(a.id).status, 'cancelled');
  assert.deepEqual(s.startable(1), []);
});

test('rerun appends a queued clone', () => {
  const s = new JobStore();
  const a = s.add(spec('a'));
  s.add(spec('b'));
  s.markStarted(a.id, { model: 'm' });
  s.markFinished(a.id, 3);
  assert.equal(s.get(a.id).status, 'failed');
  const r = s.rerun(a.id);
  assert.notEqual(r.id, a.id);
  assert.equal(r.status, 'queued');
  assert.equal(r.command, 'node');
  assert.deepEqual(r.args, ['x.js', 'a']);
  assert.equal(s.list().at(-1).id, r.id);
  assert.throws(() => s.rerun(s.list()[1].id), JobStateError); // b is still queued
});

test('markFinished: exit 0 → done', () => {
  const s = new JobStore();
  const a = s.add(spec('a'));
  s.markStarted(a.id, { model: 'm' });
  s.markFinished(a.id, 0);
  assert.equal(s.get(a.id).status, 'done');
  assert.equal(s.get(a.id).exitCode, 0);
  assert.ok(s.get(a.id).finishedAt);
});

test('startable fills free running slots in queue order', () => {
  const s = new JobStore();
  const [a, b, c] = ['a', 'b', 'c'].map((n) => s.add(spec(n)));
  assert.deepEqual(s.startable(2).map((j) => j.id), [a.id, b.id]);
  s.markStarted(a.id, { model: 'm' });
  assert.deepEqual(s.startable(1), []);
  s.pause(a.id);
  assert.deepEqual(s.startable(1), []); // paused still occupies its slot
  assert.deepEqual(s.startable(2).map((j) => j.id), [b.id]);
  s.cancel(a.id);
  assert.deepEqual(s.startable(1).map((j) => j.id), [b.id]);
  void c;
});

test('waiting is a reason, not a status', () => {
  const s = new JobStore();
  const a = s.add(spec('a'));
  s.markWaiting(a.id, 'waiting for cards');
  assert.equal(s.get(a.id).status, 'queued');
  assert.equal(s.get(a.id).reason, 'waiting for cards');
  s.markStarted(a.id, { model: 'm' });
  assert.equal(s.get(a.id).reason, null);
});

test('restart: running jobs fail; restartable ones are re-queued at their old index', () => {
  const s = new JobStore();
  s.add(spec('first'));
  const keep = s.add(spec('keep', { restartable: true }));
  const lose = s.add(spec('lose'));
  s.add(spec('last'));
  s.markStarted(keep.id, { model: 'm' });
  s.markStarted(lose.id, { model: 'm' });
  const r = JobStore.fromJSON(JSON.parse(JSON.stringify(s.toJSON())));
  assert.equal(r.get(keep.id).status, 'failed');
  assert.equal(r.get(keep.id).reason, 'host restarted');
  assert.equal(r.get(lose.id).status, 'failed');
  const names = r.list().map((j) => `${j.name}:${j.status}`);
  assert.deepEqual(names, ['first:queued', 'keep:queued', 'keep:failed', 'lose:failed', 'last:queued']);
});
