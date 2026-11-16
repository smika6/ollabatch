import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadTemplates, instantiate } from '../src/templates.mjs';

function fixture(obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigpool tpl '));
  const file = path.join(dir, 'rigpool.jobs.json');
  fs.writeFileSync(file, JSON.stringify(obj));
  return { dir, file };
}

const TAG = {
  id: 'tag', name: 'Label ${split}', command: 'node', args: ['label.js', '--split', '${split}'],
  cwd: 'work', env: { SPLIT: '${split}', FIXED: 'x' }, models: ['gemma4:12b'],
  params: [{ name: 'split', values: ['train', 'eval'], default: 'train' }, { name: 'mode', values: ['fast', 'full'] }],
};

test('missing file → no templates', () => {
  assert.deepEqual(loadTemplates(null), []);
  assert.deepEqual(loadTemplates(path.join(os.tmpdir(), 'no-such-rigpool.jobs.json')), []);
});

test('invalid file throws with its path', () => {
  const { file } = fixture({ templates: [{ id: 'x' }] });
  assert.throws(() => loadTemplates(file), (e) => e.message.includes(file));
});

test('loads templates and resolves a relative cwd against the file', () => {
  const { dir, file } = fixture({ templates: [TAG] });
  const [t] = loadTemplates(file);
  assert.equal(t.id, 'tag');
  assert.equal(t.cwd, path.join(dir, 'work'));
});

test('instantiate substitutes params in name, args and env', () => {
  const { file } = fixture({ templates: [TAG] });
  const [t] = loadTemplates(file);
  const job = instantiate(t, { split: 'eval', mode: 'fast' });
  assert.equal(job.name, 'Label eval');
  assert.deepEqual(job.args, ['label.js', '--split', 'eval']);
  assert.deepEqual(job.env, { SPLIT: 'eval', FIXED: 'x' });
  assert.equal(job.command, 'node');
  assert.equal(job.template, 'tag');
});

test('a value outside the allowed list throws', () => {
  const [t] = loadTemplates(fixture({ templates: [TAG] }).file);
  assert.throws(() => instantiate(t, { split: 'evil; rm -rf', mode: 'fast' }), /split/);
});

test('a missing param uses its default, else throws', () => {
  const [t] = loadTemplates(fixture({ templates: [TAG] }).file);
  assert.equal(instantiate(t, { mode: 'full' }).name, 'Label train');
  assert.throws(() => instantiate(t, {}), /mode/);
});

test('a bad progressPattern or a non-string arg is rejected at load', () => {
  assert.throws(() => loadTemplates(fixture({ templates: [{ ...TAG, progressPattern: '(' }] }).file), /progressPattern/);
  assert.throws(() => loadTemplates(fixture({ templates: [{ ...TAG, args: [1] }] }).file), /args/);
});

test('command never comes from params', () => {
  const [t] = loadTemplates(fixture({ templates: [{ ...TAG, command: '${split}' }] }).file);
  assert.equal(instantiate(t, { split: 'eval', mode: 'fast' }).command, '${split}');
});
