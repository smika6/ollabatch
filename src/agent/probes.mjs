// What GPUs this machine has, from the tools each platform ships. Every probe
// returns [] rather than throwing; a value a driver doesn't report stays null
// ("unknown"), never 0.
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

const MB = 1024 * 1024;
const num = (v) => { const n = Number(String(v ?? '').trim()); return Number.isFinite(n) && String(v ?? '').trim() !== '' ? n : null; };
const shortHash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 6);
const card = (c) => ({ id: '', source: null, vendor: 'other', name: '', busId: null, index: 0, vramMB: 0, freeMB: null, util: null,
  tempC: null, powerW: null, display: null, integrated: false, ...c });

export const NVIDIA_QUERY = ['--query-gpu=index,pci.bus_id,name,memory.total,memory.free,utilization.gpu,temperature.gpu,power.draw,display_active',
  '--format=csv,noheader,nounits'];

// Windows: the adapter list, with real VRAM from the driver's registry key
// (Win32_VideoController.AdapterRAM is a 32-bit value and tops out at 4 GB).
export const WIN_PROBE = [
  "$cls='HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}';",
  '$reg=@{}; Get-ChildItem $cls -EA SilentlyContinue | Where-Object { $_.PSChildName -match \'^\\d{4}$\' } | ForEach-Object {',
  '  $p = Get-ItemProperty $_.PSPath -EA SilentlyContinue; if ($p.DriverDesc) { $reg[$p.DriverDesc] = $p.\'HardwareInformation.qwMemorySize\' } };',
  '$list = @(Get-CimInstance Win32_VideoController | ForEach-Object { [pscustomobject]@{ Name = $_.Name; PNPDeviceID = $_.PNPDeviceID;',
  '  AdapterCompatibility = $_.AdapterCompatibility; AdapterRAM = $_.AdapterRAM; qwMemorySize = $reg[$_.Name] } });',
  'ConvertTo-Json -InputObject $list -Compress',
].join('\n');

function vendorOf(text) {
  const t = String(text).toLowerCase();
  if (t.includes('nvidia')) return 'nvidia';
  if (t.includes('intel')) return 'intel';
  if (t.includes('advanced micro') || t.includes('amd') || t.includes('radeon')) return 'amd';
  if (t.includes('apple')) return 'apple';
  return 'other';
}

export function parseNvidiaSmi(csv) {
  return String(csv || '').split(/\r?\n/).filter((l) => l.trim()).map((line) => {
    const [index, busId, name, total, free, util, temp, power, display] = line.split(',').map((x) => x.trim());
    const bus = busId.split(':').slice(-2).join('').replace(/\W/g, '').toLowerCase();
    const t = num(temp);
    return card({ id: `nvidia-${bus || index}`, source: 'nvidia-smi', vendor: 'nvidia', name, busId, index: Number(index), vramMB: num(total) ?? 0,
      freeMB: num(free), util: num(util), tempC: t == null ? null : Math.round(t), powerW: num(power),
      display: display === 'Enabled' ? true : display === 'Disabled' ? false : null });
  });
}

export function parseWindowsAdapters(json) {
  let list;
  try { list = JSON.parse(json); } catch { return []; }
  return (Array.isArray(list) ? list : [list]).filter(Boolean).map((a, index) => {
    const vendor = vendorOf(`${a.AdapterCompatibility} ${a.Name}`);
    const bytes = num(a.qwMemorySize) ?? num(a.AdapterRAM) ?? 0;
    const vramMB = Math.round(bytes / MB);
    return card({ id: `${vendor}-${shortHash(a.PNPDeviceID || a.Name)}`, source: 'windows', vendor, name: a.Name, index, vramMB, integrated: vramMB < 4096 });
  });
}

export function parseMacDisplays(json, memBytes, ioreg = '') {
  let doc;
  try { doc = JSON.parse(json); } catch { return []; }
  const stats = parseIoreg(ioreg);
  const vramMB = Math.round(memBytes / MB);
  return (doc.SPDisplaysDataType || []).slice(0, 1).map((g, index) => card({
    id: `apple-${index}`, source: 'system_profiler', vendor: 'apple', name: g.sppci_model || g._name, index, vramMB,
    util: stats.util, freeMB: stats.inUseBytes == null || !vramMB ? null : Math.max(0, vramMB - Math.round(stats.inUseBytes / MB)),
  }));
}

// `ioreg -r -d 1 -w 0 -c IOAccelerator`: the GPU's use and the memory it has
// in use, without admin rights. (Temperature and power on a Mac need admin
// tools such as powermetrics, so they stay unknown.)
export function parseIoreg(text) {
  const t = String(text || '');
  const util = num(/"Device Utilization %"\s*=\s*(\d+)/.exec(t)?.[1]);
  const inUseBytes = num(/"In use system memory"\s*=\s*(\d+)/.exec(t)?.[1]);
  return { util, inUseBytes };
}

export function parseRocmSmi(json) {
  let doc;
  try { doc = JSON.parse(json); } catch { return []; }
  return Object.entries(doc).filter(([k]) => /^card\d+$/.test(k)).map(([k, v]) => {
    const total = num(v['VRAM Total Memory (B)']);
    const used = num(v['VRAM Total Used Memory (B)']);
    const t = num(v['Temperature (Sensor edge) (C)']);
    const index = Number(k.slice(4));
    const vramMB = total == null ? 0 : Math.round(total / MB);
    return card({ id: `amd-${index}`, source: 'rocm-smi', vendor: 'amd', name: v['Card series'] || v['Card model'] || k, index, vramMB,
      freeMB: total != null && used != null ? Math.round((total - used) / MB) : null,
      util: num(v['GPU use (%)']), tempC: t == null ? null : Math.round(t), integrated: vramMB < 4096 });
  });
}

export function parseXpuSmi(discoveryJson, statsJsons = []) {
  let doc;
  try { doc = JSON.parse(discoveryJson); } catch { return []; }
  const stats = new Map();
  for (const s of statsJsons) {
    try {
      const d = JSON.parse(s);
      stats.set(d.device_id, Object.fromEntries((d.device_level || []).map((m) => [m.metrics_type, num(m.value)])));
    } catch { /* skip */ }
  }
  return (doc.device_list || []).map((d) => {
    const vramMB = Math.round((num(d.memory_physical_size_byte) ?? 0) / MB);
    const m = stats.get(d.device_id) || {};
    const used = m.XPUM_STATS_MEMORY_USED;
    const bus = String(d.pci_bdf_address || '').split(':').slice(-2).join('').replace(/\W/g, '').toLowerCase();
    return card({ id: `intel-${bus || d.device_id}`, source: 'xpu-smi', vendor: 'intel', name: d.device_name, busId: d.pci_bdf_address || null,
      index: d.device_id, vramMB, freeMB: used == null ? null : vramMB - Math.round(used / MB),
      util: m.XPUM_STATS_GPU_UTILIZATION ?? null, tempC: m.XPUM_STATS_GPU_CORE_TEMPERATURE ?? null,
      powerW: m.XPUM_STATS_POWER ?? null, integrated: vramMB < 4096 });
  });
}

// nvidia-smi knows NVIDIA cards best; the Windows list fills in everyone else.
export function mergeCards(nvidia, windows) {
  return [...nvidia, ...windows.filter((c) => c.vendor !== 'nvidia' || !nvidia.length)];
}

export function execRun(cmd, args, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * MB }, (err, stdout) => resolve(err ? null : stdout));
  });
}

export async function detectCards({ run = execRun, platform = process.platform } = {}) {
  const safe = async (cmd, args) => { try { return await run(cmd, args); } catch { return null; } };
  try {
    if (platform === 'darwin') {
      const [json, mem, io] = await Promise.all([safe('system_profiler', ['SPDisplaysDataType', '-json']), safe('sysctl', ['-n', 'hw.memsize']),
        safe('ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'])]);
      return json ? parseMacDisplays(json, num(mem) ?? 0, io || '') : [];
    }
    const nvidia = parseNvidiaSmi(await safe('nvidia-smi', NVIDIA_QUERY) || '');
    if (platform === 'win32') {
      const win = await safe('powershell', ['-NoProfile', '-NonInteractive', '-Command', WIN_PROBE]);
      return mergeCards(nvidia, win ? parseWindowsAdapters(win) : []);
    }
    const rocm = parseRocmSmi(await safe('rocm-smi', ['--showproductname', '--showmeminfo', 'vram', '--showuse', '--showtemp', '--json']) || '{}');
    let xpu = [];
    const disc = await safe('xpu-smi', ['discovery', '-j']);
    if (disc) {
      const ids = (() => { try { return (JSON.parse(disc).device_list || []).map((d) => d.device_id); } catch { return []; } })();
      const stats = (await Promise.all(ids.map((id) => safe('xpu-smi', ['stats', '-d', String(id), '-j'])))).filter(Boolean);
      xpu = parseXpuSmi(disc, stats);
    }
    return [...nvidia, ...rocm, ...xpu];
  } catch {
    return [];
  }
}

// Which backend a card's Ollama really runs on, from its server log: the
// device it loaded the model on ("using device Vulkan0 (...)"), else what it
// found at start ("inference compute ... library=CUDA"). Apple's MLX engine
// names itself in its runner lines.
const BACKEND_NAMES = { cuda: 'CUDA', vulkan: 'Vulkan', metal: 'Metal', mtl: 'Metal', rocm: 'ROCm', hip: 'ROCm', sycl: 'SYCL', mlx: 'MLX', cpu: 'CPU' };
const backendName = (s) => BACKEND_NAMES[String(s).toLowerCase()] || s;
export function backendFromLog(text) {
  const t = String(text || '');
  let best = null, at = -1;
  const take = (re, i = 1) => { for (const m of t.matchAll(re)) if (m.index > at) { at = m.index; best = backendName(m[i]); } };
  take(/msg="inference compute"[^\n]*?\blibrary=([A-Za-z]+)/g);
  take(/using device ([A-Za-z]+?)\d* \(/g);
  take(/\b(mlx)[ _-]?(?:runner|engine|server)\b/gi);
  return best;
}

export function cardLabels(c) {
  const labels = { gpu: c.vendor, vram: String(Math.floor(c.vramMB / 1024)) };
  if (c.display === true) labels.display = '1';
  return labels;
}
