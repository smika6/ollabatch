import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SlotTuner } from '../src/agent/tuner.mjs';

const MIN = 60_000;
const TOTAL = 16303;

// Simulates a card: every 10 s, `rate(slots)` items/s complete. Applies the
// tuner's slot changes the way the agent does (restart → onRestart).
function sim({ rate, free = () => 8000, queued = () => true, oomAt = () => false, saved = null, version = 'v1', start = 0 }) {
  let now = start, completed = 0, ooms = 0;
  const t = new SlotTuner({ now: () => now, saved, ollamaVersion: version });
  const changes = [];
  const run = (ms) => {
    for (const end = now + ms; now < end;) {
      now += 10_000;
      completed += rate(t.slots, now) * 10;
      if (oomAt(t.slots, now)) ooms++;
      const a = t.observe({ completed, oomErrors: ooms, freeMB: free(t.slots, now), totalMB: TOTAL, queued: queued(now) });
      if (a) { changes.push(a.setSlots); t.applied(a.setSlots); t.onRestart(); }
    }
  };
  return { t, run, changes, at: () => now };
}

const table = (m) => (s) => m[s] ?? m[Math.max(...Object.keys(m).map(Number))];

test('climbs while each step gains at least 10%, then settles on the best', () => {
  const s = sim({ rate: table({ 1: 1.0, 2: 1.8, 3: 2.05, 4: 2.1 }) });
  s.run(30 * MIN);
  assert.equal(s.t.slots, 3);
  assert.equal(s.t.phase, 'settled');
  assert.deepEqual(s.changes, [2, 3, 4, 3]);
});

test('a step that leaves too little free VRAM is undone', () => {
  const s = sim({ rate: table({ 1: 1, 2: 2, 3: 3 }), free: (slots) => (slots >= 2 ? 900 : 8000) });
  s.run(30 * MIN);
  assert.equal(s.t.slots, 1);
  assert.deepEqual(s.changes, [2, 1]);
});

test('unknown free VRAM does not block climbing', () => {
  const s = sim({ rate: table({ 1: 1, 2: 2, 3: 2.05 }), free: () => null });
  s.run(30 * MIN);
  assert.equal(s.t.slots, 2);
});

test('an out-of-memory error steps down at once', () => {
  const s = sim({ rate: table({ 1: 1, 2: 2, 3: 3 }), oomAt: (slots) => slots === 3 });
  s.run(30 * MIN);
  assert.equal(s.t.slots, 2);
});

test('a slowdown under 50% for 3 minutes with queued work steps down', () => {
  let slow = false;
  const s = sim({ rate: (slots) => (slow ? 0.5 : table({ 1: 1, 2: 1.8, 3: 2.05, 4: 2.1 })(slots)) });
  s.run(30 * MIN);
  assert.equal(s.t.slots, 3);
  slow = true;
  s.run(2 * MIN);
  assert.equal(s.t.slots, 3, 'not before 3 minutes');
  s.run(2 * MIN);
  assert.equal(s.t.slots, 2);
});

test('no step down for a slow rate when there is no queued work', () => {
  let idle = false;
  const s = sim({ rate: (slots) => (idle ? 0 : table({ 1: 1, 2: 1.8, 3: 2.05, 4: 2.1 })(slots)), queued: () => !idle });
  s.run(30 * MIN);
  idle = true;
  s.run(10 * MIN);
  assert.equal(s.t.slots, 3);
});

test('free VRAM under the margin steps down, and climbing back waits 15 minutes', () => {
  let game = false;
  const s = sim({ rate: table({ 1: 1, 2: 1.8, 3: 2.05, 4: 2.1 }), free: () => (game ? 500 : 8000) });
  s.run(30 * MIN);
  assert.equal(s.t.slots, 3);
  game = true;
  s.run(MIN / 2);
  assert.equal(s.t.slots, 2);
  game = false;
  s.run(10 * MIN);
  assert.equal(s.t.slots, 2, 'waits');
  s.run(10 * MIN);
  assert.equal(s.t.slots, 3, 'climbs back to the tuned count');
});

test('a restart is not a slowdown', () => {
  const s = sim({ rate: table({ 1: 1, 2: 1.8, 3: 2.05, 4: 2.1 }) });
  s.run(30 * MIN);
  s.t.onRestart();
  assert.equal(s.t.observe({ completed: 0, oomErrors: 0, freeMB: 8000, totalMB: TOTAL, queued: true }), null);
});

test('an idle card never climbs: no work, no measurement', () => {
  const s = sim({ rate: () => 0, queued: () => false });
  s.run(60 * MIN);
  assert.equal(s.t.slots, 1);
  assert.equal(s.t.phase, 'measuring');
  assert.deepEqual(s.changes, []);
});

test('a long pause inside a measuring window does not settle the card low', () => {
  let paused = false;
  const s = sim({ rate: (slots) => (paused ? 0 : table({ 1: 1.0, 2: 1.8, 3: 2.05, 4: 2.1 })(slots)), queued: () => !paused });
  s.run(10_000 * 2);   // a little measuring at 1 slot
  paused = true;
  s.run(30 * MIN);
  paused = false;
  s.run(30 * MIN);
  assert.equal(s.t.slots, 3);
});

test('caps at 8 slots', () => {
  const s = sim({ rate: (slots) => slots });
  s.run(60 * MIN);
  assert.equal(s.t.slots, 8);
});

test('reuses a fresh saved tuning; re-measures an old one or a new Ollama', () => {
  const now = 100 * 24 * 60 * MIN;
  const saved = (days, v = 'v1') => ({ slots: 3, ratePerSec: 2, measuredAt: now - days * 24 * 60 * MIN, ollamaVersion: v });
  assert.equal(new SlotTuner({ now: () => now, saved: saved(1), ollamaVersion: 'v1' }).slots, 3);
  assert.equal(new SlotTuner({ now: () => now, saved: saved(8), ollamaVersion: 'v1' }).slots, 1);
  assert.equal(new SlotTuner({ now: () => now, saved: saved(1, 'v0'), ollamaVersion: 'v1' }).slots, 1);
});

test('toJSON carries what to save', () => {
  const s = sim({ rate: table({ 1: 1.0, 2: 1.8, 3: 2.05, 4: 2.1 }) });
  s.run(30 * MIN);
  const j = s.t.toJSON();
  assert.equal(j.slots, 3);
  assert.equal(j.ollamaVersion, 'v1');
  assert.ok(Math.abs(j.ratePerSec - 2.05) < 0.01);
});
