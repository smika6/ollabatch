// An Apple GPU's power and the Mac's thermal pressure, from powermetrics.
// powermetrics needs root, so this works only where the owner allowed it to run
// without a password (one sudoers line, see docs/home-setup.md); otherwise it
// stays quiet and asks again every 10 minutes. Apple silicon reports no GPU
// temperature in °C, only the thermal pressure level (nominal, fair, serious,
// critical).

export const POWERMETRICS = ['-n', '/usr/bin/powermetrics', '--samplers', 'gpu_power,thermal', '-i', '1000', '-n', '1'];
const RETRY_MS = 10 * 60_000;

export function parsePowermetrics(text) {
  const t = String(text || '');
  const mw = /GPU Power:\s*([\d.]+)\s*mW/i.exec(t);
  const busy = /GPU HW active residency:\s*([\d.]+)\s*%/i.exec(t);
  const thermal = /Current pressure level:\s*(\w+)/i.exec(t);
  return {
    powerW: mw ? Math.round(Number(mw[1]) / 100) / 10 : null,
    util: busy ? Math.round(Number(busy[1])) : null,
    thermal: thermal ? thermal[1].toLowerCase() : null,
  };
}

// sample() → { powerW, util, thermal } or null; never throws.
export function makeMacPower({ run, now = Date.now }) {
  let blockedUntil = 0;
  return {
    async sample() {
      if (now() < blockedUntil) return null;
      let out = null;
      try { out = await run('sudo', POWERMETRICS); } catch { out = null; }
      const r = parsePowermetrics(out);
      if (r.powerW == null && r.util == null && r.thermal == null) { blockedUntil = now() + RETRY_MS; return null; }
      return r;
    },
  };
}
