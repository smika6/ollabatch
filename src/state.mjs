// JSON state on disk. Writes go to <file>.tmp, are fsynced, then renamed over
// the real file, so a crash mid-save leaves the previous state intact.
import fs from 'node:fs';
import path from 'node:path';

export function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${file}: ${e.message}`);
  }
}

export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

export function createSaver(write, ms = 500) {
  let timer = null;
  const run = () => { timer = null; write(); };
  return {
    schedule() { if (!timer) timer = setTimeout(run, ms); },
    flush() { if (timer) { clearTimeout(timer); run(); } },
  };
}
