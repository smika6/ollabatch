import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordServers, reapRecorded } from '../src/agent/reap.mjs';

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ollabatch reap ')), 'servers.json');

test('leftover servers from a previous agent are stopped, and only Ollama processes', async () => {
  const f = file();
  recordServers(f, { 'nvidia-1': 111, 'intel-2': 222 });
  const killed = [];
  const r = await reapRecorded({ file: f, isOllama: async (pid) => pid === 111, kill: async (pid) => { killed.push(pid); } });
  assert.deepEqual(killed, [111]);
  assert.deepEqual(r, [111]);
  assert.equal(fs.existsSync(f), false, 'the record is cleared');
});

test('no record → nothing to do', async () => {
  assert.deepEqual(await reapRecorded({ file: file(), isOllama: async () => true, kill: async () => { throw new Error('no'); } }), []);
});
