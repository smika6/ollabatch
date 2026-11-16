// Runs one job's command on the host: its env points every Ollama client at
// the job's own address on the host, output goes to <logDir>/<id>.log, and
// "done/total" lines become progress.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { parseProgress, DEFAULT_PROGRESS } from './progress.mjs';

const IS_WIN = process.platform === 'win32';

export function jobEnv(job, port) {
  const base = `http://127.0.0.1:${port}`;
  return {
    ...process.env, ...job.env,
    OLLAMA_URL: `${base}/j/${job.id}`, OLLAMA_HOST: `${base}/j/${job.id}`,
    OLLABATCH_JOB_ID: job.id, OLLABATCH_PROGRESS_URL: `${base}/ob/jobs/${job.id}/progress`,
    ...(job.model ? { OLLAMA_MODEL: job.model } : {}),
  };
}

export function startJob(job, { port, logDir, onProgress, onExit }) {
  fs.mkdirSync(logDir, { recursive: true });
  const fd = fs.openSync(path.join(logDir, `${job.id}.log`), 'a');
  const pattern = job.progressPattern ? new RegExp(job.progressPattern) : DEFAULT_PROGRESS;
  // POSIX: own process group, so kill() can signal the whole tree.
  const child = spawn(job.command, job.args, {
    cwd: job.cwd, env: jobEnv(job, port), shell: job.shell, windowsHide: true, detached: !IS_WIN,
  });

  let buf = '';
  const onData = (chunk) => {
    fs.writeSync(fd, chunk);
    buf += chunk.toString('utf8');
    const lines = buf.split(/\r\n|\r|\n/);
    buf = lines.pop();
    for (const line of lines) {
      const p = parseProgress(line, pattern);
      if (p) onProgress(p);
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  let finished = false;
  const exited = new Promise((resolve) => {
    const finish = (code) => {
      if (finished) return;
      finished = true;
      if (buf) { const p = parseProgress(buf, pattern); if (p) onProgress(p); }
      fs.closeSync(fd);
      onExit(code);
      resolve();
    };
    child.on('error', (e) => { fs.writeSync(fd, `ollabatch: ${e.message}\n`); finish(127); });
    child.on('close', (code, signal) => finish(code ?? (signal ? 1 : 0)));
  });

  return {
    pid: child.pid,
    async kill() {
      if (finished) return;
      if (IS_WIN) {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } else {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
        const hard = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, 5_000);
        exited.finally(() => clearTimeout(hard));
      }
      await exited;
    },
  };
}
