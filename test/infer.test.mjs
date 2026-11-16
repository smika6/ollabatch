import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStats } from '../src/infer.mjs';

const NS = 1e9;
const final = { model: 'gemma4:12b', done: true, total_duration: 3 * NS, load_duration: 1.5 * NS,
  prompt_eval_count: 120, prompt_eval_duration: 0.4 * NS, eval_count: 300, eval_duration: 1 * NS };

test('parses every answer shape', () => {
  assert.deepEqual(parseStats(JSON.stringify({ ...final, message: { content: 'hi' } }), 'application/json'), {
    model: 'gemma4:12b', promptTokens: 120, outputTokens: 300, promptSec: 0.4, genSec: 1, loadSec: 1.5, loaded: true, totalSec: 3,
  });
  const ndjson = `${JSON.stringify({ model: 'gemma4:12b', message: { content: 'o' }, done: false })}\n${JSON.stringify(final)}\n`;
  assert.equal(parseStats(ndjson, 'application/x-ndjson').outputTokens, 300);
  const embed = parseStats(JSON.stringify({ model: 'nomic', embeddings: [[0.1]], total_duration: 0.2 * NS, load_duration: 0.01 * NS, prompt_eval_count: 8 }));
  assert.deepEqual(embed, { model: 'nomic', promptTokens: 8, outputTokens: null, promptSec: null, genSec: null, loadSec: 0.01, loaded: false, totalSec: 0.2 });
  assert.equal(parseStats('not json'), null);
  assert.equal(parseStats(''), null);
  assert.equal(parseStats(JSON.stringify({ error: 'model not found' })), null);
});

test('a load counts only above 50 ms', () => {
  assert.equal(parseStats(JSON.stringify({ ...final, load_duration: 0.04 * NS })).loaded, false);
  assert.equal(parseStats(JSON.stringify({ ...final, load_duration: 0.06 * NS })).loaded, true);
});
