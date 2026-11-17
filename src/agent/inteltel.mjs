// Intel GPU temperature, power and use on Windows, from intel.ps1 (Intel's
// Graphics Control Library). Runs only where the library is installed; if the
// reader dies it is started again a minute later.
import path from 'node:path';
import { spawn as spawnChild } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'intel.ps1');
const NO_LIBRARY = 3;   // intel.ps1's exit code when ControlLib.dll isn't installed
const norm = (s) => String(s || '').toLowerCase().replace(/\((r|tm)\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

export function startIntelTelemetry({ spawn = spawnChild, onSample, platform = process.platform, retryMs = 60_000 } = {}) {
  if (platform !== 'win32') return { stop() {} };
  let child = null, stopped = false, timer = null;
  const start = () => {
    child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], { windowsHide: true });
    let buf = '';
    child.stdout?.on('data', (d) => {
      buf += d;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) { try { if (l.trim()) onSample(JSON.parse(l)); } catch { /* skip a torn line */ } }
    });
    child.on('error', () => {});
    child.on('exit', (code) => { if (!stopped && code !== NO_LIBRARY) timer = setTimeout(start, retryMs); });
  };
  start();
  return { stop() { stopped = true; clearTimeout(timer); try { child?.kill(); } catch { /* gone */ } } };
}

// This card's Intel telemetry: by adapter LUID when the agent knows it, else by
// name when exactly one Intel device has that name.
export function intelFor(card, devices, luid) {
  const list = Array.isArray(devices) ? devices : [];
  if (luid) {
    const hit = list.find((d) => String(d.luid).toLowerCase() === String(luid).toLowerCase());
    if (hit) return hit;
  }
  const named = list.filter((d) => norm(d.name) === norm(card.name));
  return named.length === 1 ? named[0] : null;
}
