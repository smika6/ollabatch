import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LendPolicy } from '../src/agent/policy.mjs';

const S = 1000, MIN = 60 * S;
const cards = ['a', 'b'];
function at(t0) {
  let now = t0;
  const p = new LendPolicy({ now: () => now });
  const ev = (inUse = [], extra = {}) => p.evaluate({ policy: 'when-free', schedule: [], inUse: new Set(inUse), ownerPaused: new Set(), cards, ...extra });
  return { p, ev, step: (ms) => { now += ms; } };
}

test('a card pauses only after 10 s of fullscreen use', () => {
  const { ev, step } = at(0);
  assert.equal(ev(['a']).a.lend, true);
  step(5 * S);
  assert.equal(ev(['a']).a.lend, true);
  step(5 * S);
  const r = ev(['a']);
  assert.deepEqual(r.a, { lend: false, reason: 'paused-in-use' });
  assert.equal(r.b.lend, true);
});

test('a short burst never pauses', () => {
  const { ev, step } = at(0);
  ev(['a']); step(5 * S);
  assert.equal(ev([]).a.lend, true);
  step(6 * S);
  assert.equal(ev(['a']).a.lend, true);
});

test('resumes 3 minutes after the program leaves fullscreen', () => {
  const { ev, step } = at(0);
  ev(['a']); step(10 * S); ev(['a']);
  step(5 * S);
  assert.equal(ev([]).a.lend, false);
  step(2 * MIN);
  assert.equal(ev([]).a.lend, false);
  step(MIN);
  assert.equal(ev([]).a.lend, true);
});

test('always ignores fullscreen use; never never lends', () => {
  const { ev, step } = at(0);
  ev(['a']); step(20 * S);
  assert.equal(ev(['a'], { policy: 'always' }).a.lend, true);
  assert.deepEqual(ev([], { policy: 'never' }).a, { lend: false, reason: 'never' });
});

test('owner pause wins over always', () => {
  const { ev } = at(0);
  assert.deepEqual(ev([], { policy: 'always', ownerPaused: new Set(['b']) }).b, { lend: false, reason: 'paused-by-owner' });
});

test('schedule windows, including one that crosses midnight', () => {
  const every = [0, 1, 2, 3, 4, 5, 6];
  const night = [{ days: every, from: '23:00', to: '07:00' }];
  const local = (h, m = 0) => new Date(2026, 10, 16, h, m).getTime();
  const lendAt = (t) => at(t).ev([], { policy: 'schedule', schedule: night }).a;
  assert.equal(lendAt(local(2)).lend, true);
  assert.equal(lendAt(local(23, 30)).lend, true);
  assert.deepEqual(lendAt(local(12)), { lend: false, reason: 'outside-schedule' });
  const monOnly = [{ days: [1], from: '23:00', to: '07:00' }];   // starts Monday night
  const tue2am = new Date(2026, 10, 17, 2, 0).getTime();          // 2026-11-17 is a Tuesday
  assert.equal(at(tue2am).ev([], { policy: 'schedule', schedule: monOnly }).a.lend, true);
  const mon2am = new Date(2026, 10, 16, 2, 0).getTime();
  assert.equal(at(mon2am).ev([], { policy: 'schedule', schedule: monOnly }).a.lend, false);
});

test('a policy the pool set still steps aside for a fullscreen program', () => {
  const { ev, step } = at(0);
  ev(['a'], { policy: 'always', stepAside: true });
  step(10 * S);
  assert.deepEqual(ev(['a'], { policy: 'always', stepAside: true }).a, { lend: false, reason: 'paused-in-use' });
  assert.equal(ev(['a'], { policy: 'always' }).a.lend, true, 'the owner\'s own "always" means always');
});

test('a malformed schedule never matches and never throws', () => {
  const { ev } = at(new Date(2026, 10, 16, 12, 0).getTime());
  for (const schedule of [[{}], [null], [{ days: [1], from: 'x', to: '13:00' }], 'nope']) {
    assert.equal(ev([], { policy: 'schedule', schedule }).a.reason, 'outside-schedule');
  }
});
