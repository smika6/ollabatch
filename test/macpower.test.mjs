import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePowermetrics, makeMacPower, POWERMETRICS } from '../src/agent/macpower.mjs';
import { hardwareMeta } from '../src/dashboard/view.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// What `sudo powermetrics --samplers gpu_power,thermal -i 1000 -n 1` prints on Apple silicon.
const PM = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'testdata', 'probes', 'powermetrics.txt'), 'utf8');

test('powermetrics: GPU power, how busy it is, and thermal pressure (no °C on Apple silicon)', () => {
  assert.deepEqual(parsePowermetrics(PM), { powerW: 31.5, util: 87, thermal: 'nominal' });
  assert.deepEqual(parsePowermetrics('sudo: a password is required'), { powerW: null, util: null, thermal: null });
});

test('without a passwordless sudo rule it stays quiet and asks again 10 minutes later', async () => {
  let t = 0, calls = 0, allowed = false;
  const run = async (cmd, args) => { calls++; assert.equal(cmd, 'sudo'); assert.deepEqual(args, POWERMETRICS); return allowed ? PM : null; };
  const mp = makeMacPower({ run, now: () => t });
  assert.equal(await mp.sample(), null);
  t += 60_000;
  assert.equal(await mp.sample(), null);
  assert.equal(calls, 1, 'not asked again within 10 minutes');
  allowed = true;
  t += 10 * 60_000;
  assert.equal((await mp.sample()).powerW, 31.5);
  assert.equal((await mp.sample()).thermal, 'nominal');
  assert.equal(calls, 3);
});

test('a Mac shows its thermal pressure where a temperature would be', () => {
  const line = hardwareMeta({ vendor: 'apple', backend: 'Metal', vramMB: 32768, freeMB: 20000, util: 87, tempC: null, powerW: 31.5, thermal: 'nominal' });
  assert.ok(line.includes('thermal nominal'));
  assert.ok(line.includes('32 W'));
});
