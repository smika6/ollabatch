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
  id: 'tag', name: 'Tag ${catalog}', command: 'node', args: ['scripts/tag.js', '--catalog', '${catalog}'],
  cwd: 'work', env: { CATALOG: '${catalog}', FIXED: 'x' }, models: ['gemma4:12b'],
  params: [{ name: 'catalog', values: ['royals', 'global'], default: 'royals' }, { name: 'mode', values: ['fast', 'full'] }],
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
  const job = instantiate(t, { catalog: 'global', mode: 'fast' });
  assert.equal(job.name, 'Tag global');
  assert.deepEqual(job.args, ['scripts/tag.js', '--catalog', 'global']);
  assert.deepEqual(job.env, { CATALOG: 'global', FIXED: 'x' });
  assert.equal(job.command, 'node');
  assert.equal(job.template, 'tag');
});

test('a value outside the allowed list throws', () => {
  const [t] = loadTemplates(fixture({ templates: [TAG] }).file);
  assert.throws(() => instantiate(t, { catalog: 'evil; rm -rf', mode: 'fast' }), /catalog/);
});

test('a missing param uses its default, else throws', () => {
  const [t] = loadTemplates(fixture({ templates: [TAG] }).file);
  assert.equal(instantiate(t, { mode: 'full' }).name, 'Tag royals');
  assert.throws(() => instantiate(t, {}), /mode/);
});

test('a bad progressPattern or a non-string arg is rejected at load', () => {
  assert.throws(() => loadTemplates(fixture({ templates: [{ ...TAG, progressPattern: '(' }] }).file), /progressPattern/);
  assert.throws(() => loadTemplates(fixture({ templates: [{ ...TAG, args: [1] }] }).file), /args/);
});

test('command never comes from params', () => {
  const [t] = loadTemplates(fixture({ templates: [{ ...TAG, command: '${catalog}' }] }).file);
  assert.equal(instantiate(t, { catalog: 'global', mode: 'fast' }).command, '${catalog}');
});
