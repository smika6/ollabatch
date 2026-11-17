import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { intelFor, startIntelTelemetry } from '../src/agent/inteltel.mjs';

const arc = { luid: '0x00000000_0x000151fa', name: 'Intel(R) Arc(TM) A770 Graphics', tempC: 47, powerW: 35.7, util: 0 };

test('Intel telemetry matches a card by adapter LUID (any case), else by a unique name', () => {
  const card = { name: 'Intel(R) Arc(TM) A770 Graphics' };
  assert.equal(intelFor(card, [arc], '0x00000000_0x000151FA'), arc);
  assert.equal(intelFor(card, [arc], null), arc);
  assert.equal(intelFor(card, [arc, { ...arc, luid: 'x' }], null), null, 'two cards with one name need the LUID');
  assert.equal(intelFor({ name: 'NVIDIA GeForce RTX 5080' }, [arc], null), null);
  assert.equal(intelFor(card, null, null), null);
});

function fakeSpawn() {
  const spawned = [];
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => child.emit('exit', null);
    spawned.push(child);
    return child;
  };
  return { spawn, spawned };
}

test('the reader passes samples on, restarts after a crash, and stays off without the library', async () => {
  const f = fakeSpawn();
  const got = [];
  const r = startIntelTelemetry({ spawn: f.spawn, platform: 'win32', retryMs: 20, onSample: (s) => got.push(s) });
  f.spawned[0].stdout.emit('data', `${JSON.stringify({ devices: [arc] })}\n{"torn`);
  assert.deepEqual(got, [{ devices: [arc] }]);
  f.spawned[0].emit('exit', 1);   // crashed
  await new Promise((res) => setTimeout(res, 60));
  assert.equal(f.spawned.length, 2, 'started again');
  f.spawned[1].emit('exit', 3);   // no ControlLib.dll on this PC
  await new Promise((res) => setTimeout(res, 60));
  assert.equal(f.spawned.length, 2, 'not retried');
  r.stop();
  assert.equal(startIntelTelemetry({ spawn: f.spawn, platform: 'linux', onSample() {} }).stop(), undefined);
  assert.equal(f.spawned.length, 2, 'never on other systems');
});
