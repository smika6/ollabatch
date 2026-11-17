import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../src/version.mjs';
import { versionNote } from '../src/dashboard/view.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('one version everywhere, and the changelog has an entry for it', () => {
  assert.equal(VERSION, JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
  assert.equal(execFileSync(process.execPath, [path.join(ROOT, 'bin', 'ollabatch.mjs'), '--version'], { encoding: 'utf8' }).trim(), `ollabatch ${VERSION}`);
  assert.match(fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'), new RegExp(`^## ${VERSION.replace(/\./g, '\\.')} `, 'm'));
});

test('a machine on another version is flagged with how to update it', () => {
  assert.equal(versionNote('0.2.0', '0.2.0'), null);
  assert.equal(versionNote(undefined, '0.2.0'), null);
  assert.match(versionNote('0.1.0', '0.2.0'), /older.*installer/);
  assert.match(versionNote('0.10.0', '0.9.3'), /newer.*update the host/, 'compared as numbers, not text');
});
