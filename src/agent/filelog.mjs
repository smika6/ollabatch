// The agent runs hidden (started at login), so what it says goes to a file
// too: ~/.ollabatch/agent/agent.log, kept under `maxBytes` by moving the full
// file to agent.log.1. Each line starts with the local time.
import fs from 'node:fs';
import path from 'node:path';

export function fileLog(file, { maxBytes = 5 * 1024 * 1024, now = () => new Date() } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return (line) => {
    try {
      const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
      if (size > maxBytes) fs.renameSync(file, `${file}.1`);
      const d = now();
      const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${d.toTimeString().slice(0, 8)}`;
      fs.appendFileSync(file, `${stamp} ${line}\n`);
    } catch { /* logging must never stop the agent */ }
  };
}
