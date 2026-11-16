import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson, writeJsonAtomic, createSaver, adoptLegacyDir } from '../src/state.mjs';

test('a pre-rename .rigpool folder is moved to .ollabatch once', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ollabatch legacy '));
  fs.mkdirSync(path.join(root, '.rigpool'));
  fs.writeFileSync(path.join(root, '.rigpool', 'token'), 'kept');
  assert.equal(adoptLegacyDir(path.join(root, '.ollabatch'), path.join(root, '.rigpool')), true);
  assert.equal(fs.readFileSync(path.join(root, '.ollabatch', 'token'), 'utf8'), 'kept');
  fs.mkdirSync(path.join(root, '.rigpool'));
  assert.equal(adoptLegacyDir(path.join(root, '.ollabatch'), path.join(root, '.rigpool')), false, 'never overwrites');
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ollabatch state '));

test('write then read', () => {
  const f = path.join(tmp(), 'state.json');
  writeJsonAtomic(f, { a: 1, b: [2] });
  assert.deepEqual(readJson(f), { a: 1, b: [2] });
});

test('missing file reads as null; corrupt file throws with its path', () => {
  const dir = tmp();
  assert.equal(readJson(path.join(dir, 'nope.json')), null);
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{"a":');
  assert.throws(() => readJson(bad), (e) => e.message.includes(bad));
});

test('a leftover temp file does not affect the real one', () => {
  const f = path.join(tmp(), 'state.json');
  writeJsonAtomic(f, { ok: true });
  fs.writeFileSync(`${f}.tmp`, 'garbage{');
  assert.deepEqual(readJson(f), { ok: true });
  writeJsonAtomic(f, { ok: 2 });
  assert.deepEqual(readJson(f), { ok: 2 });
});

test('replaces an existing file', () => {
  const f = path.join(tmp(), 'state.json');
  writeJsonAtomic(f, { v: 1 });
  writeJsonAtomic(f, { v: 2 });
  assert.deepEqual(readJson(f), { v: 2 });
  assert.equal(fs.existsSync(`${f}.tmp`), false);
});

test('a failing save is reported, not thrown, and retried on the next schedule', async () => {
  let calls = 0;
  const errors = [];
  const saver = createSaver(() => { calls++; if (calls === 1) throw new Error('EPERM'); }, 10, (e) => errors.push(e.message));
  saver.schedule();
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(errors, ['EPERM']);
  saver.schedule();
  saver.flush();
  assert.equal(calls, 2);
});

test('saver debounces and flush writes only when scheduled', async () => {
  let writes = 0;
  const saver = createSaver(() => { writes++; }, 50);
  saver.flush();
  assert.equal(writes, 0);
  saver.schedule(); saver.schedule(); saver.schedule();
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(writes, 1);
  saver.schedule();
  saver.flush();
  assert.equal(writes, 2);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(writes, 2);
});
