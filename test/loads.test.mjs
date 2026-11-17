// One reload is one load, however many answers waited for it; and the
// model-switching warning counts switches, not reloads of the same model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoadCounter } from '../src/infer.mjs';
import { Insights } from '../src/insights.mjs';
import { thrashing } from '../src/dashboard/view.mjs';

const loaded = (model, loadSec, totalSec) => ({ model, loaded: true, loadSec, totalSec, promptTokens: 10, outputTokens: 20, genSec: 1 });

test('answers that all waited for the same reload count it once', () => {
  const c = new LoadCounter();
  const t = 1_000_000;
  // 4 at once after a restart: all report the 15 s load, finishing at different times.
  const answers = [[t, 17], [t + 1200, 18.2], [t + 2500, 19.4], [t + 4000, 20.9]].map(([at, total]) => c.dedupe('5080', loaded('gemma4:12b', 15, total), at));
  assert.deepEqual(answers.map((s) => s.loaded), [true, false, false, false]);
  assert.equal(answers[1].loadSec, 0);
  // A later restart is a new load.
  assert.equal(c.dedupe('5080', loaded('gemma4:12b', 15, 17), t + 60_000).loaded, true);
  // Another card, or another model, is its own load.
  assert.equal(c.dedupe('arc', loaded('gemma4:12b', 15, 17), t).loaded, true);
  assert.equal(c.dedupe('5080', loaded('qwen3.5:9b', 9, 10), t + 60_500).loaded, true);
  assert.equal(c.dedupe('5080', null, t), null);
});

test('reloading the same model is not switching; alternating models is', () => {
  let t = 10 * 3_600_000;
  const ins = new Insights({ now: () => t });
  const rec = (model) => { ins.record({ card: 'a', job: 'j', model, ok: true, retried: false, waitSec: 0, latencySec: 1, stats: loaded(model, 10, 12) }); t += 60_000; };
  for (let i = 0; i < 8; i++) rec('gemma4:12b');   // the slot tuner restarting the server, say
  assert.equal(ins.loadsLastHour('a'), 8);
  assert.equal(ins.switchesLastHour('a'), 0);
  assert.deepEqual(thrashing({ a: ins.switchesLastHour('a') }), []);
  for (let i = 0; i < 8; i++) rec(i % 2 ? 'gemma4:12b' : 'qwen3.5:9b');
  assert.equal(ins.switchesLastHour('a'), 8);
  assert.deepEqual(thrashing({ a: ins.switchesLastHour('a') }), ['a']);
  const back = Insights.fromJSON(JSON.parse(JSON.stringify(ins.toJSON())), { now: () => t });
  assert.equal(back.switchesLastHour('a'), 8, 'switches survive a restart');
});
