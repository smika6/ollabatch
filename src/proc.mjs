// Stop a child and everything it started. `ollama serve` runs its model in a
// separate runner process that holds the VRAM, so killing only the parent
// would leave the GPU full.
import { spawnSync } from 'node:child_process';

export const IS_WIN = process.platform === 'win32';

// The child must have been spawned with `detached: !IS_WIN` (its own process group on POSIX).
export function killTree(child, { graceMs = 5000 } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  const exited = new Promise((resolve) => child.once('exit', resolve));
  if (IS_WIN) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ }
    const hard = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, graceMs);
    exited.finally(() => clearTimeout(hard));
  }
  return exited;
}
