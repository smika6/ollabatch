// What the agent can tell about cards beyond nvidia-smi: Apple GPUs (ioreg),
// Windows adapters (performance counters) and each card's real backend.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseIoreg, parseMacDisplays, backendFromLog, detectCards } from '../src/agent/probes.mjs';
import { adapterStats } from '../src/agent/inuse.mjs';
import { hardwareMeta } from '../src/dashboard/view.mjs';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'testdata', 'probes');
const IOREG = `+-o AGXAcceleratorG15X  <class AGXAcceleratorG15X, id 0x1000003f2, registered, matched, active, busy 0 (0 ms), retain 30>
    {
      "IOClass" = "AGXAcceleratorG15X"
      "PerformanceStatistics" = {"In use system memory (driver)"=0,"Alloc system memory"=9389549568,"Tiler Utilization %"=31,"Renderer Utilization %"=88,"In use system memory"=10737418240,"Device Utilization %"=91}
    }`;

test('Apple GPUs: use and memory in use from ioreg, no admin rights needed', () => {
  assert.deepEqual(parseIoreg(IOREG), { util: 91, inUseBytes: 10737418240 });
  assert.deepEqual(parseIoreg(''), { util: null, inUseBytes: null });
  const json = fs.readFileSync(path.join(DATA, 'mac-displays.json'), 'utf8');
  const [c] = parseMacDisplays(json, 64 * 1024 ** 3, IOREG);
  assert.equal(c.util, 91);
  assert.equal(c.freeMB, 64 * 1024 - 10 * 1024);
  assert.equal(c.tempC, null, 'temperature needs admin tools on a Mac: unknown, never 0');
  assert.equal(parseMacDisplays(json, 64 * 1024 ** 3)[0].util, null);
});

test('detectCards on a Mac asks ioreg too', async () => {
  const json = fs.readFileSync(path.join(DATA, 'mac-displays.json'), 'utf8');
  const run = async (cmd) => ({ system_profiler: json, sysctl: String(32 * 1024 ** 3), ioreg: IOREG })[cmd] ?? null;
  const [c] = await detectCards({ run, platform: 'darwin' });
  assert.equal(c.util, 91);
});

test('the backend a card really runs on, from its Ollama log', () => {
  const nvidia = [
    'time=2026-11-16T23:16:12.140-06:00 level=INFO source=types.go:32 msg="inference compute" id=0 filter_id=0 library=CUDA compute=12.0 name=CUDA0 description="NVIDIA GeForce RTX 5080"',
    'llama_prepare_model_devices: using device CUDA0 (NVIDIA GeForce RTX 5080) (0000:2d:00.0) - 14985 MiB free',
  ].join('\n');
  assert.equal(backendFromLog(nvidia), 'CUDA');
  const arc = [
    'msg="inference compute" id=0 filter_id=0 library=Vulkan name=Vulkan0 description="NVIDIA GeForce RTX 5080"',
    'msg="inference compute" id=0 filter_id=1 library=Vulkan name=Vulkan0 description="Intel(R) Arc(TM) A770 Graphics"',
    'llama_prepare_model_devices: using device Vulkan0 (Intel(R) Arc(TM) A770 Graphics) (unknown id) - 15486 MiB free',
  ].join('\n');
  assert.equal(backendFromLog(arc), 'Vulkan');
  assert.equal(backendFromLog('msg="inference compute" id=0 library=Metal name=Metal\nusing device MTL0 (Apple M4 Max) - 98304 MiB free'), 'Metal');
  assert.equal(backendFromLog('msg="inference compute" library=Metal\nmsg="starting mlx runner" model=x'), 'MLX', 'the latest word wins');
  assert.equal(backendFromLog(''), null);
});

test('Windows adapters: use like Task Manager (busiest engine type) and dedicated memory', () => {
  const sample = {
    engines: [
      { pid: 1, luid: '0x0_0xa', engtype: '3D', util: 30 }, { pid: 2, luid: '0x0_0xa', engtype: '3D', util: 25 },
      { pid: 1, luid: '0x0_0xa', engtype: 'Compute_0', util: 40 }, { pid: 3, luid: '0x0_0xb', engtype: '3D', util: 120 },
    ],
    mem: [{ luid: '0x0_0xa', bytes: 4 * 1024 ** 3 }, { luid: '0x0_0xc', bytes: 1024 ** 3 }],
  };
  assert.deepEqual(adapterStats(sample), {
    '0x0_0xa': { util: 55, usedBytes: 4 * 1024 ** 3 },
    '0x0_0xb': { util: 100, usedBytes: null },
    '0x0_0xc': { util: 0, usedBytes: 1024 ** 3 },
  });
  assert.deepEqual(adapterStats(null), {});
});

test('the dashboard line shows backend, shared memory and use; unknown stays unknown', () => {
  assert.deepEqual(hardwareMeta({ backend: 'Metal', vendor: 'apple', vramMB: 65536, freeMB: 55296, util: 91, tempC: null, powerW: null }),
    ['Metal', '64 GB shared', '54.0 GB free', 'temperature unknown', '91% use', 'power unknown']);
});
