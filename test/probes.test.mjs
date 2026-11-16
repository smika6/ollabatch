import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNvidiaSmi, parseWindowsAdapters, parseMacDisplays, parseRocmSmi, parseXpuSmi, mergeCards, detectCards, cardLabels } from '../src/agent/probes.mjs';

const P = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'testdata', 'probes');
const fx = (f) => fs.readFileSync(path.join(P, f), 'utf8');

test('parseNvidiaSmi reads live stats and keeps unreported values null', () => {
  const [rtx, old] = parseNvidiaSmi(fx('nvidia-smi.csv'));
  assert.deepEqual(rtx, { id: 'nvidia-2d000', source: 'nvidia-smi', vendor: 'nvidia', name: 'NVIDIA GeForce RTX 5080', busId: '00000000:2D:00.0', index: 0,
    vramMB: 16303, freeMB: 4301, util: 60, tempC: 69, powerW: 247.87, display: true, integrated: false });
  assert.equal(old.powerW, null);
  assert.equal(old.display, false);
  assert.equal(old.index, 1);
});

test('parseWindowsAdapters takes real VRAM from qwMemorySize, not the 4 GB-capped AdapterRAM', () => {
  const cards = parseWindowsAdapters(fx('win-adapters.json'));
  const arc = cards.find((c) => c.vendor === 'intel');
  assert.equal(arc.name, 'Intel(R) Arc(TM) A770 Graphics');
  assert.equal(arc.vramMB, 16256);
  assert.equal(arc.tempC, null);
  assert.equal(arc.util, null);
  assert.match(arc.id, /^intel-[0-9a-f]{6}$/);
  assert.equal(cards.find((c) => c.vendor === 'nvidia').vramMB, 16303);
  const igpu = cards.find((c) => c.vendor === 'amd');
  assert.equal(igpu.integrated, true);
});

test('mergeCards: nvidia-smi rows win for NVIDIA, Windows rows supply the rest', () => {
  const merged = mergeCards(parseNvidiaSmi(fx('nvidia-smi.csv')), parseWindowsAdapters(fx('win-adapters.json')));
  assert.deepEqual(merged.map((c) => c.name).sort(),
    ['AMD Radeon(TM) Graphics', 'Intel(R) Arc(TM) A770 Graphics', 'NVIDIA GeForce RTX 3080', 'NVIDIA GeForce RTX 5080']);
  assert.equal(merged.find((c) => c.name.includes('5080')).tempC, 69);
});

test('parseMacDisplays: one Apple card with unified memory', () => {
  const [m] = parseMacDisplays(fx('mac-displays.json'), 36 * 1024 ** 3);
  assert.equal(m.vendor, 'apple');
  assert.equal(m.name, 'Apple M3 Pro');
  assert.equal(m.vramMB, 36864);
  assert.equal(m.integrated, false);
});

test('parseRocmSmi', () => {
  const [r] = parseRocmSmi(fx('rocm-smi.json'));
  assert.equal(r.vendor, 'amd');
  assert.equal(r.name, 'Radeon RX 7900 XTX');
  assert.equal(r.vramMB, 24560);
  assert.equal(r.freeMB, 23536);
  assert.equal(r.util, 3);
  assert.equal(r.tempC, 40);
});

test('parseXpuSmi fills live Intel stats', () => {
  const [x] = parseXpuSmi(fx('xpu-discovery.json'), [fx('xpu-stats.json')]);
  assert.equal(x.vendor, 'intel');
  assert.equal(x.vramMB, 16256);
  assert.equal(x.util, 12);
  assert.equal(x.tempC, 47);
  assert.equal(x.powerW, 31);
  assert.equal(x.freeMB, 16256 - 2048);
});

test('detectCards never throws and returns [] when nothing is installed', async () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    assert.deepEqual(await detectCards({ run: async () => null, platform }), []);
    assert.deepEqual(await detectCards({ run: async () => { throw new Error('boom'); }, platform }), []);
  }
});

test('detectCards on Windows combines nvidia-smi and the adapter list', async () => {
  const run = async (cmd) => (cmd === 'nvidia-smi' ? fx('nvidia-smi.csv') : cmd === 'powershell' ? fx('win-adapters.json') : null);
  const cards = await detectCards({ run, platform: 'win32' });
  assert.equal(cards.length, 4);
});

test('cardLabels', () => {
  const [rtx] = parseNvidiaSmi(fx('nvidia-smi.csv'));
  assert.deepEqual(cardLabels(rtx), { gpu: 'nvidia', vram: '15', display: '1' });
  const arc = parseWindowsAdapters(fx('win-adapters.json')).find((c) => c.vendor === 'intel');
  assert.deepEqual(cardLabels(arc), { gpu: 'intel', vram: '15' });
});
