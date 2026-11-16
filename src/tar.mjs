// A minimal ustar writer, so the host can hand a joining machine its own copy
// of ollabatch (GET /ollabatch.tar) and the built-in `tar` on Windows 10+,
// macOS and Linux unpacks it. No git or npm needed on the joining machine.
import fs from 'node:fs';
import path from 'node:path';

const APP = ['bin', 'src', 'examples'];
const APP_FILES = ['package.json', 'README.md', 'LICENSE'];

export function appFiles(root) {
  const out = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(r); else if (e.isFile()) out.push(r);
    }
  };
  for (const d of APP) if (fs.existsSync(path.join(root, d))) walk(d);
  for (const f of APP_FILES) if (fs.existsSync(path.join(root, f))) out.push(f);
  return out.sort();
}

function header(name, size, mtime) {
  const h = Buffer.alloc(512);
  let prefix = '';
  if (Buffer.byteLength(name) > 100) {   // ustar splits long paths at a '/'
    const i = name.lastIndexOf('/', 155);
    prefix = name.slice(0, i);
    name = name.slice(i + 1);
  }
  const put = (s, off, len) => h.write(s, off, len, 'utf8');
  const oct = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0';
  put(name, 0, 100);
  put(oct(0o644, 8), 100, 8);
  put(oct(0, 8), 108, 8);
  put(oct(0, 8), 116, 8);
  put(oct(size, 12), 124, 12);
  put(oct(Math.floor(mtime / 1000), 12), 136, 12);
  put('        ', 148, 8);
  put('0', 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  put(prefix, 345, 155);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}

export function tarFiles(root, relPaths) {
  const parts = [];
  for (const rel of relPaths) {
    const file = path.join(root, rel);
    const data = fs.readFileSync(file);
    parts.push(header(rel, data.length, fs.statSync(file).mtimeMs), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}
