// `ollabatch install`: put `ollabatch` on this user's PATH and start the agent
// at login. Per user, no admin rights. All file and command I/O is injected,
// so the per-OS steps are tested without touching the real machine.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const RC_LINE = 'export PATH="$HOME/.local/bin:$PATH"';

export const realIo = {
  write: (p, text, mode) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text, mode ? { mode } : undefined); if (mode) fs.chmodSync(p, mode); },
  read: (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } },
  remove: (p) => fs.rmSync(p, { force: true }),
  exec: (cmd, args) => new Promise((resolve) => execFile(cmd, args, { windowsHide: true }, (e, out) => resolve(e ? null : out))),
};

export function defaults() {
  return {
    platform: process.platform, home: os.homedir(),
    localAppData: process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    appData: process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    nodePath: process.execPath, uid: process.getuid?.() ?? 0,
  };
}

function paths({ platform, home, localAppData, appData }) {
  if (platform === 'win32') {
    const binDir = `${localAppData}\\ollabatch\\bin`;
    return { binDir, launcher: `${binDir}\\ollabatch.cmd`,
      login: `${appData}\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\ollabatch-agent.vbs` };
  }
  const binDir = `${home}/.local/bin`;
  return { binDir, launcher: `${binDir}/ollabatch`,
    login: platform === 'darwin' ? `${home}/Library/LaunchAgents/dev.ollabatch.agent.plist` : `${home}/.config/systemd/user/ollabatch-agent.service`,
    rcs: platform === 'darwin' ? [`${home}/.zshrc`] : [`${home}/.bashrc`, `${home}/.profile`] };
}

const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

export async function installAgent(o) {
  const { platform, nodePath, binPath, trusted, uid, write, read, exec } = o;
  const p = paths(o);
  const agentArgs = ['agent', ...(trusted ? ['--trusted'] : [])];
  const files = [];
  if (platform === 'win32') {
    write(p.launcher, `@"${nodePath}" "${binPath}" %*\r\n`);
    // Hidden window: the agent runs in the user's session, so it can see fullscreen programs.
    const cmdLine = [nodePath, binPath].map((s) => `""${s}""`).join(' ') + ` ${agentArgs.join(' ')}`;
    write(p.login, `CreateObject("WScript.Shell").Run "${cmdLine}", 0, False\r\n`);
    await exec('wscript', [p.login]);   // start it now too, not only at the next login
    const userPath = o.userPath ?? '';
    const parts = userPath.split(';').filter(Boolean);
    if (!parts.some((x) => x.toLowerCase() === p.binDir.toLowerCase())) {
      const next = [...parts, p.binDir].join(';').replace(/'/g, "''");
      await exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', `[Environment]::SetEnvironmentVariable('Path', '${next}', 'User')`]);
    }
  } else {
    write(p.launcher, `#!/bin/sh\nexec "${nodePath}" "${binPath}" "$@"\n`, 0o755);
    for (const rc of p.rcs) {
      const text = read(rc) ?? '';
      if (!text.includes('.local/bin')) write(rc, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${RC_LINE}\n`);
    }
    if (platform === 'darwin') {
      const args = [nodePath, binPath, ...agentArgs].map((a) => `    <string>${xml(a)}</string>`).join('\n');
      write(p.login, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.ollabatch.agent</string>
  <key>ProgramArguments</key><array>
${args}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
`);
      await exec('launchctl', ['bootout', `gui/${uid}`, p.login]);
      await exec('launchctl', ['bootstrap', `gui/${uid}`, p.login]);
    } else {
      write(p.login, `[Unit]\nDescription=ollabatch agent\n\n[Service]\nExecStart="${nodePath}" "${binPath}" ${agentArgs.join(' ')}\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n`);
      await exec('systemctl', ['--user', 'daemon-reload']);
      await exec('systemctl', ['--user', 'enable', '--now', 'ollabatch-agent']);
    }
  }
  files.push(p.launcher, p.login);
  return { files, binDir: p.binDir };
}

export async function uninstallAgent(o) {
  const { platform, uid, remove, exec } = o;
  const p = paths(o);
  if (platform === 'darwin') await exec('launchctl', ['bootout', `gui/${uid}`, p.login]);
  if (platform === 'linux') await exec('systemctl', ['--user', 'disable', '--now', 'ollabatch-agent']);
  remove(p.launcher);
  remove(p.login);
  if (platform === 'win32' && o.userPath) {
    const next = o.userPath.split(';').filter((x) => x && x.toLowerCase() !== p.binDir.toLowerCase()).join(';').replace(/'/g, "''");
    await exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', `[Environment]::SetEnvironmentVariable('Path', '${next}', 'User')`]);
  }
}
