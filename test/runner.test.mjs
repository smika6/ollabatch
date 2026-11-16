import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startJob } from '../src/runner.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rigpool runner '));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const job = (args, extra = {}) => ({ id: 'j9', command: process.execPath, args, cwd: tmp(), env: {}, shell: false, model: null, ...extra });

function run(j, logDir) {
  const progress = [];
  return new Promise((resolve) => {
    const h = startJob(j, { port: 4321, logDir, onProgress: (p) => progress.push(p), onExit: (code) => resolve({ code, progress, h }) });
  });
}

test('reports progress, logs output and exits 0, in a cwd with a space', async () => {
  const logDir = tmp();
  const { code, progress } = await run(job([path.join(FIX, 'print-progress.mjs')], { model: 'gemma4:12b' }), logDir);
  assert.equal(code, 0);
  assert.deepEqual(progress.at(-1), { done: 3, total: 3 });
  assert.equal(progress.length, 3);
  const log = fs.readFileSync(path.join(logDir, 'j9.log'), 'utf8');
  assert.match(log, /job j9 url http:\/\/127\.0\.0\.1:4321\/j\/j9 model gemma4:12b/);
  assert.match(log, /3\/3 done/);
});

test('job env carries the progress URL and the job env', async () => {
  const logDir = tmp();
  const script = 'console.log(process.env.RIGPOOL_PROGRESS_URL, process.env.OLLAMA_HOST, process.env.EXTRA)';
  const { code } = await run(job(['-e', script], { env: { EXTRA: 'yes' } }), logDir);
  assert.equal(code, 0);
  const log = fs.readFileSync(path.join(logDir, 'j9.log'), 'utf8');
  assert.match(log, /http:\/\/127\.0\.0\.1:4321\/rp\/jobs\/j9\/progress http:\/\/127\.0\.0\.1:4321\/j\/j9 yes/);
});

test('a custom progress pattern', async () => {
  const { progress } = await run(job(['-e', 'console.log("item 2 of 8")'], { progressPattern: 'item (\\d+) of (\\d+)' }), tmp());
  assert.deepEqual(progress, [{ done: 2, total: 8 }]);
});

test('kill() takes down the whole process tree', async () => {
  const logDir = tmp();
  let exited;
  const done = new Promise((r) => { exited = r; });
  const h = startJob(job([path.join(FIX, 'spawn-child.mjs')]), { port: 1, logDir, onProgress: () => {}, onExit: exited });
  const log = path.join(logDir, 'j9.log');
  let grandchild;
  for (let i = 0; i < 100 && !grandchild; i++) {
    await new Promise((r) => setTimeout(r, 50));
    grandchild = Number(fs.existsSync(log) && fs.readFileSync(log, 'utf8').match(/grandchild (\d+)/)?.[1]);
  }
  assert.ok(grandchild, 'grandchild pid logged');
  assert.ok(alive(h.pid) && alive(grandchild));
  await h.kill();
  await done;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(alive(h.pid), false);
  assert.equal(alive(grandchild), false);
});
