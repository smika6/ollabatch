import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tarFiles, appFiles } from '../src/tar.mjs';
import { installAgent, uninstallAgent } from '../src/agent/install.mjs';
import { startHost } from '../src/host.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ollabatch install '));

test('the app archive unpacks with the system tar, byte for byte', () => {
  const files = appFiles(ROOT);
  assert.ok(files.includes('bin/ollabatch.mjs') && files.includes('src/host.mjs') && files.includes('package.json'));
  assert.ok(!files.some((f) => f.startsWith('test/') || f.startsWith('.git')));
  const out = tmp();
  const tarPath = path.join(out, 'app.tar');
  fs.writeFileSync(tarPath, tarFiles(ROOT, files));
  const dest = path.join(out, 'x');
  fs.mkdirSync(dest);
  execFileSync('tar', ['-xf', tarPath, '-C', dest]);
  for (const f of files) assert.ok(fs.readFileSync(path.join(dest, f)).equals(fs.readFileSync(path.join(ROOT, f))), f);
});

// A fake filesystem + command log, so install runs anywhere without touching the real one.
function fakeIo() {
  const files = new Map(), commands = [];
  return {
    files, commands,
    io: {
      write: (p, text, mode) => files.set(p, { text, mode }),
      read: (p) => (files.has(p) ? files.get(p).text : null),
      remove: (p) => files.delete(p),
      exec: async (cmd, args) => { commands.push([cmd, ...args]); return ''; },
    },
  };
}
const base = (platform, extra = {}) => ({ platform, home: '/home/sam', localAppData: 'C:\\Users\\Sam Smith\\AppData\\Local',
  appData: 'C:\\Users\\Sam Smith\\AppData\\Roaming', nodePath: platform === 'win32' ? 'C:\\Program Files\\nodejs\\node.exe' : '/usr/bin/node',
  binPath: platform === 'win32' ? 'C:\\Users\\Sam Smith\\AppData\\Local\\ollabatch\\app\\bin\\ollabatch.mjs' : '/home/sam/.ollabatch/app/bin/ollabatch.mjs',
  uid: 501, userPath: 'C:\\Windows;C:\\Tools', trusted: false, ...extra });

test('Windows: launcher on the user PATH, agent at login, paths with spaces quoted', async () => {
  const f = fakeIo();
  const r = await installAgent({ ...base('win32'), ...f.io });
  const cmd = f.files.get('C:\\Users\\Sam Smith\\AppData\\Local\\ollabatch\\bin\\ollabatch.cmd').text;
  assert.match(cmd, /^@"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Sam Smith\\AppData\\Local\\ollabatch\\app\\bin\\ollabatch.mjs" %\*/);
  const vbs = [...f.files.keys()].find((k) => k.endsWith('Startup\\ollabatch-agent.vbs'));
  assert.ok(vbs);
  assert.match(f.files.get(vbs).text, /agent/);
  assert.ok(f.commands.some((c) => c[0] === 'wscript' && c[1] === vbs), 'starts the agent now, not only at next login');
  const setPath = f.commands.find((c) => c.join(' ').includes("SetEnvironmentVariable('Path'"));
  assert.ok(setPath, 'adds to the user PATH');
  assert.match(setPath.join(' '), /C:\\Windows;C:\\Tools;C:\\Users\\Sam Smith\\AppData\\Local\\ollabatch\\bin/);
  assert.ok(r.files.length >= 2);
});

test('the PATH is only changed once', async () => {
  const f = fakeIo();
  await installAgent({ ...base('win32', { userPath: 'C:\\Windows;C:\\Users\\Sam Smith\\AppData\\Local\\ollabatch\\bin' }), ...f.io });
  assert.equal(f.commands.filter((c) => c.join(' ').includes('SetEnvironmentVariable')).length, 0);
});

test('macOS: ~/.local/bin launcher, zshrc line once, LaunchAgent loaded', async () => {
  const f = fakeIo();
  await installAgent({ ...base('darwin', { trusted: true }), ...f.io });
  assert.equal(f.files.get('/home/sam/.local/bin/ollabatch').mode, 0o755);
  assert.match(f.files.get('/home/sam/.zshrc').text, /export PATH="\$HOME\/\.local\/bin:\$PATH"/);
  const plist = f.files.get('/home/sam/Library/LaunchAgents/dev.ollabatch.agent.plist').text;
  assert.match(plist, /<string>--trusted<\/string>/);
  assert.ok(f.commands.some((c) => c[0] === 'launchctl' && c.includes('bootstrap') && c.includes('gui/501')));
  await installAgent({ ...base('darwin'), ...f.io });
  assert.equal(f.files.get('/home/sam/.zshrc').text.match(/\.local\/bin/g).length, 1);
});

test('Linux: systemd user unit enabled', async () => {
  const f = fakeIo();
  await installAgent({ ...base('linux'), ...f.io });
  assert.match(f.files.get('/home/sam/.config/systemd/user/ollabatch-agent.service').text, /ExecStart="\/usr\/bin\/node" "\/home\/sam\/.ollabatch\/app\/bin\/ollabatch.mjs" agent/);
  assert.ok(f.commands.some((c) => c.join(' ') === 'systemctl --user enable --now ollabatch-agent'));
});

test('uninstall removes what install added', async () => {
  const f = fakeIo();
  await installAgent({ ...base('linux'), ...f.io });
  await uninstallAgent({ ...base('linux'), ...f.io });
  assert.ok(!f.files.has('/home/sam/.local/bin/ollabatch'));
  assert.ok(!f.files.has('/home/sam/.config/systemd/user/ollabatch-agent.service'));
});

test('the host serves the installers with its URL and no password, and the app archive', async (t) => {
  const h = await startHost({ port: 0, password: 'secret-pw', stateDir: tmp(), beacon: false });
  after(() => h.close());
  const url = `http://127.0.0.1:${h.port}`;
  for (const p of ['/install.ps1', '/install.sh']) {
    const text = await (await fetch(`${url}${p}`)).text();
    assert.ok(text.includes(url), `${p} names the host`);
    assert.ok(!text.includes('secret-pw'), `${p} carries no password`);
    assert.ok(!/[^\x00-\x7f]/.test(text), `${p} is ASCII`);
  }
  const tar = Buffer.from(await (await fetch(`${url}/ollabatch.tar`)).arrayBuffer());
  assert.equal(tar.length % 512, 0);
  assert.ok(tar.includes(Buffer.from('bin/ollabatch.mjs')));
});
