import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileLog } from '../src/agent/filelog.mjs';

test('the agent log is stamped and kept small by rolling to .1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob log '));
  const file = path.join(dir, 'agent.log');
  const log = fileLog(file, { maxBytes: 200, now: () => new Date(2026, 10, 17, 9, 5, 7) });
  log('NVIDIA GeForce RTX 5080: lending -> paused-in-use (a fullscreen program is using this GPU)');
  assert.match(fs.readFileSync(file, 'utf8'), /^2026-11-17 09:05:07 NVIDIA .*paused-in-use/);
  for (let i = 0; i < 10; i++) log(`line ${i} ${'x'.repeat(40)}`);
  assert.ok(fs.existsSync(`${file}.1`));
  assert.ok(fs.statSync(file).size < 400);
  assert.match(fs.readFileSync(file, 'utf8'), /line 9/);
});
