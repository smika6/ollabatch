// The agent's Ollama servers outlive it if the agent is killed (and on Windows
// always). It records their pids; the next agent stops any still running before
// starting its own, so two servers never fight over one GPU's memory. A pid is
// only stopped if it is still an Ollama process: pids get reused.
import fs from 'node:fs';
import { execFile, spawnSync } from 'node:child_process';
import { readJson, writeJsonAtomic } from '../state.mjs';

export function recordServers(file, pidsByCard) {
  try { writeJsonAtomic(file, pidsByCard); } catch { /* best effort */ }
}

export async function reapRecorded({ file, isOllama = isOllamaPid, kill = killPid }) {
  const recorded = readJson(file) || {};
  const killed = [];
  for (const pid of Object.values(recorded)) {
    if (Number.isInteger(pid) && await isOllama(pid)) { await kill(pid); killed.push(pid); }
  }
  fs.rmSync(file, { force: true });
  return killed;
}

export function isOllamaPid(pid) {
  return new Promise((resolve) => {
    const [cmd, args] = process.platform === 'win32'
      ? ['tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']]
      : ['ps', ['-p', String(pid), '-o', 'comm=']];
    execFile(cmd, args, { windowsHide: true }, (e, out) => resolve(!e && /ollama/i.test(out)));
  });
}

export async function killPid(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else { try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } } }
}
