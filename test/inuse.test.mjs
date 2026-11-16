import { test } from 'node:test';
import assert from 'node:assert/strict';
import { learnLuids, ownPids, cardsInUse } from '../src/agent/inuse.mjs';

// Shapes from a live sample on a PC with an RTX 5080 (CUDA, compute engine)
// and an Arc A770 (Vulkan, 3D engine), each running one of the agent's servers.
const NV = '0x00000000_0x00015278', ARC = '0x00000000_0x000155a8';
const CARDS = [{ id: 'nvidia-2d000', name: 'NVIDIA GeForce RTX 5080' }, { id: 'intel-963936', name: 'Intel(R) Arc(TM) A770 Graphics' }];
const SERVERS = { 'nvidia-2d000': 41176, 'intel-963936': 41756 };
const procs = [
  { pid: 41756, ppid: 36368, name: 'ollama.exe' }, { pid: 41176, ppid: 36368, name: 'ollama.exe' },
  { pid: 41112, ppid: 41756, name: 'llama-server.exe' }, { pid: 39540, ppid: 41176, name: 'llama-server.exe' },
];
const own = [
  { pid: 39540, luid: NV, engtype: 'compute', util: 89.8 },
  { pid: 41112, luid: ARC, engtype: '3d', util: 56.4 },
];
const sample = (fg, engines = []) => ({ fg, engines: [...own, ...engines], procs });
const fg = (extra) => ({ pid: 5000, exe: 'game', cls: 'UnityWndClass', fullscreen: true, monitor: '\\\\.\\DISPLAY6', adapter: 'NVIDIA GeForce RTX 5080', ...extra });

test('learns each card\'s adapter from where its own server works', () => {
  assert.deepEqual(learnLuids(sample(null), SERVERS), { 'nvidia-2d000': NV, 'intel-963936': ARC });
});

test('own pids include the servers and their runners', () => {
  assert.deepEqual([...ownPids(sample(null), SERVERS)].sort(), [39540, 41112, 41176, 41756]);
});

const ctx = (s) => ({ luids: learnLuids(s, SERVERS), ownPids: ownPids(s, SERVERS), cards: CARDS });

test('pauses the card the fullscreen program renders on, not the one driving its monitor', () => {
  const s = sample(fg(), [{ pid: 5000, luid: ARC, engtype: '3d', util: 70 }]);
  assert.deepEqual([...cardsInUse(s, ctx(s))], ['intel-963936']);
});

test('falls back to the monitor\'s card when the program shows no GPU work', () => {
  const s = sample(fg({ exe: 'chrome' }));
  assert.deepEqual([...cardsInUse(s, ctx(s))], ['nvidia-2d000']);
});

test('background GPU use never pauses', () => {
  const s = sample(fg({ fullscreen: false, exe: 'chrome' }), [{ pid: 7000, luid: NV, engtype: '3d', util: 40 }]);
  assert.equal(cardsInUse(s, ctx(s)).size, 0);
});

test('the desktop, taskbar and lock screen are not fullscreen programs', () => {
  for (const f of [fg({ cls: 'Progman', exe: 'explorer' }), fg({ cls: 'WorkerW', exe: 'explorer' }), fg({ exe: 'LockApp', cls: 'Windows.UI.Core.CoreWindow' })]) {
    const s = sample(f);
    assert.equal(cardsInUse(s, ctx(s)).size, 0, f.cls);
  }
});

test('no foreground window → nothing in use', () => {
  const s = sample(null);
  assert.equal(cardsInUse(s, ctx(s)).size, 0);
});
