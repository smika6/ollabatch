import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFakeOllama } from '../testdata/fake-ollama.mjs';
import { waitFor } from '../testdata/helpers.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'rigpool.mjs');
const CALL = path.join(ROOT, 'testdata', 'call-ollama.mjs');
const kids = [];
after(() => { for (const k of kids) k.kill(); });

const cli = (args) => new Promise((resolve) => {
  execFile(process.execPath, [BIN, ...args], { cwd: ROOT }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
});

function startLong(args) {
  const p = spawn(process.execPath, [BIN, ...args], { cwd: ROOT });
  kids.push(p);
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  return { p, output: () => out };
}

test('host + join + submit + ls end to end', async () => {
  const fake = await startFakeOllama();
  after(() => fake.close());
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'rigpool cli '));
  const host = startLong(['host', '--port', '0', '--password', 'secret-pw', '--state', state, '--no-local']);
  const port = await waitFor(() => host.output().match(/listening on :(\d+)/)?.[1], 10_000, 'host listening');
  const url = `http://127.0.0.1:${port}`;
  assert.match(host.output().split('\n')[0], /^listening on :\d+/);

  const join = startLong(['join', url, '--password', 'secret-pw', '--ollama', fake.url, '--label', 'nv', '--labels', 'gpu=nvidia']);
  await waitFor(() => /joined/.test(join.output()), 10_000, 'joined');

  const sub = await cli(['submit', '--host', url, '--name', 't', '--model', 'fake', '--select', 'gpu=nvidia', '--', process.execPath, CALL, '3']);
  assert.equal(sub.code, 0, sub.stderr);
  const id = sub.stdout.trim();
  assert.match(id, /^j\d+$/);

  await waitFor(async () => {
    const ls = await cli(['ls', '--host', url]);
    return ls.stdout.split('\n').some((l) => l.startsWith(id) && /\bdone\b/.test(l));
  }, 15_000, 'job done in ls');
  assert.equal(fake.calls.length, 3);
});

test('errors exit 1 with a rigpool: prefix', async () => {
  const r = await cli(['move', 'nope', '0', '--host', 'http://127.0.0.1:9']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^rigpool: /);
  const u = await cli(['frobnicate']);
  assert.equal(u.code, 1);
  assert.match(u.stderr, /^rigpool: /);
});
