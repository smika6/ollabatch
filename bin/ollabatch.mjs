#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { startHost, lanAddresses } from '../src/host.mjs';
import { join } from '../src/join.mjs';
import { parseLabels } from '../src/labels.mjs';
import { adoptLegacyDir } from '../src/state.mjs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { startAgent } from '../src/agent/agent.mjs';
import { startPage } from '../src/agent/page.mjs';
import { installAgent, uninstallAgent, defaults, realIo } from '../src/agent/install.mjs';
import { loadConfig, saveConfig } from '../src/agent/config.mjs';
import { VERSION } from '../src/version.mjs';
import { fileLog } from '../src/agent/filelog.mjs';

const HELP = {
  host: 'ollabatch host [--port 11500] [--password pw] [--jobs ollabatch.jobs.json] [--max-running 1] [--state .ollabatch] [--local http://127.0.0.1:11434] [--local-slots 2] [--no-local] [--no-beacon]',
  join: 'ollabatch join <host-url> --password pw [--ollama http://127.0.0.1:11434] [--slots 2] [--label name] [--labels k=v,...]',
  submit: 'ollabatch submit [--host url] --name n [--model m]... [--any-model] [--select selector] [--cwd dir] [--shell] -- <command> [args...]',
  ls: 'ollabatch ls [--host url]',
  move: 'ollabatch move <job> <index> [--host url]',
  pause: 'ollabatch pause <job>', resume: 'ollabatch resume <job>', cancel: 'ollabatch cancel <job>', rerun: 'ollabatch rerun <job>',
  log: 'ollabatch log <job> [--tail 200] [--host url]',
  agent: 'ollabatch agent [--host url] [--password pw] [--dir path] [--trusted]   |   ollabatch agent status',
  install: 'ollabatch install [--host url] [--password pw] [--trusted]   (puts ollabatch on your PATH and starts the agent at login)',
  uninstall: 'ollabatch uninstall',
};
const FLAGS = new Set(['--no-beacon', '--no-local', '--any-model', '--shell', '--help', '--trusted']);
const BIN = fileURLToPath(import.meta.url);

async function userPath() {
  if (process.platform !== 'win32') return '';
  return (await realIo.exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', "[Environment]::GetEnvironmentVariable('Path', 'User')"]) || '').trim();
}

// Reinstalling or uninstalling: stop the running agent first, so it takes its
// GPU servers down with it instead of leaving them beside a new agent's.
async function stopRunningAgent() {
  try { await fetch('http://127.0.0.1:11510/quit', { method: 'POST', signal: AbortSignal.timeout(2000) }); } catch { return; }
  for (let i = 0; i < 40; i++) {
    try { await fetch('http://127.0.0.1:11510/status', { signal: AbortSignal.timeout(500) }); } catch { return; }
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function install(f) {
  await stopRunningAgent();
  // Config first: installAgent starts the agent right away, and an agent that
  // started before this was saved would read no host and then save over it.
  if (f.host || f.trusted) {
    const dir = path.join(os.homedir(), '.ollabatch', 'agent');
    const cfg = loadConfig(dir, { trusted: !!f.trusted });
    if (f.host) cfg.host = f.host.replace(/\/+$/, '');
    if (f.password) cfg.password = f.password;
    // A trusted install is one of the pool owner's own PCs: let the pool manage it.
    if (f.trusted) Object.assign(cfg, { trusted: true, remote: true });
    saveConfig(dir, cfg);
  }
  const r = await installAgent({ ...defaults(), ...realIo, binPath: BIN, trusted: !!f.trusted, userPath: await userPath() });
  console.log(`ollabatch is on your PATH (${r.binDir}); open a new terminal to use it.`);
  console.log('The agent starts at login. Its page: http://127.0.0.1:11510/');
}

function parse(argv) {
  const out = { _: [], flags: {}, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out.rest = argv.slice(i + 1); break; }
    if (!a.startsWith('--')) { out._.push(a); continue; }
    if (FLAGS.has(a)) { out.flags[a.slice(2)] = true; continue; }
    const v = argv[++i];
    if (v === undefined) throw new Error(`${a} needs a value`);
    const k = a.slice(2);
    out.flags[k] = k === 'model' ? [...(out.flags.model || []), v] : v;
  }
  return out;
}

const hostOf = (f) => (f.host || 'http://127.0.0.1:11500').replace(/\/+$/, '');

async function call(f, method, p, body) {
  let r;
  try {
    r = await fetch(`${hostOf(f)}${p}`, { method, headers: { 'Content-Type': 'application/json', 'x-pool-token': f.password || '' },
      body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) { throw new Error(`can't reach ${hostOf(f)} (${e.cause?.code || e.message})`); }
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { /* plain text */ }
  if (!r.ok) throw new Error(json?.error || `HTTP ${r.status}`);
  return json ?? text;
}

const dur = (s) => (s == null ? '' : s < 60 ? '<1m' : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.floor(s / 3600)}h${Math.round((s % 3600) / 60)}m`);

const COMMANDS = {
  async host(a) {
    const f = a.flags;
    // Pre-rename names still work: a .rigpool folder moves over, a rigpool.jobs.json is read.
    if (!f.state && adoptLegacyDir(path.resolve('.ollabatch'), path.resolve('.rigpool'))) console.log('moved .rigpool to .ollabatch (the project was renamed)');
    const jobsFile = f.jobs || ['ollabatch.jobs.json', 'rigpool.jobs.json'].map((n) => path.resolve(n)).find((p) => fs.existsSync(p)) || null;
    const h = await startHost({
      port: Number(f.port ?? 11500), password: f.password, stateDir: f.state || '.ollabatch', jobsFile,
      maxRunning: Number(f['max-running'] || 1),
      local: f['no-local'] ? null : { url: f.local || 'http://127.0.0.1:11434', slots: Number(f['local-slots'] || 2) },
      localForced: !!f.local, beacon: !f['no-beacon'],
      log: (s) => console.log(s),
    });
    console.log(`listening on :${h.port}`);
    console.log(`dashboard: http://127.0.0.1:${h.port}/`);
    for (const ip of lanAddresses()) console.log(`join from another machine: ollabatch join http://${ip}:${h.port} --password ${f.password ? '<your password>' : h.token}`);
    const stop = async () => { await h.close(); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  },
  async agent(a) {
    const f = a.flags;
    if (a._[0] === 'install') return install(f);
    if (a._[0] === 'uninstall') return COMMANDS.uninstall(a);
    if (a._[0] === 'status') {
      let s;
      try { s = await (await fetch('http://127.0.0.1:11510/status')).json(); } catch { throw new Error('the agent is not running on this machine'); }
      console.log(`${s.machine}: ${s.joined ? `lending to ${s.host}` : 'not in a pool'} - policy ${s.policy}`);
      for (const c of s.cards) console.log(`  ${c.name}\t${c.state}${c.reason ? ` (${c.reason})` : ''}${c.slots ? `\t${c.slots} slot(s)` : ''}`);
      return;
    }
    // The page first: if another agent already runs here, stop before starting any GPU servers.
    let agent = null;
    const stop = async () => { await page?.close(); await agent?.close(); process.exit(0); };
    let page;
    try { page = await startPage({ onQuit: stop }); } catch (e) {
      if (e.code === 'EADDRINUSE') throw new Error('an agent is already running on this machine (http://127.0.0.1:11510/)');
      throw e;
    }
    const dir = f.dir || path.join(os.homedir(), '.ollabatch', 'agent');
    const toFile = fileLog(path.join(dir, 'agent.log'));
    const log = (s) => { console.log(s); toFile(s); };
    log(`ollabatch ${VERSION} agent starting`);
    agent = await startAgent({ dir, host: f.host, password: f.password, trusted: !!f.trusted, log });
    page.setAgent(agent);
    console.log(`agent running - its page: http://127.0.0.1:${page.port}/`);
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  },
  async install(a) { return install(a.flags); },
  async uninstall() {
    await stopRunningAgent();
    await uninstallAgent({ ...defaults(), ...realIo, userPath: await userPath() });
    console.log('ollabatch removed from your PATH and from starting at login.');
  },
  async join(a) {
    const f = a.flags;
    const w = await join({ hostUrl: a._[0], password: f.password || '', ollama: f.ollama, slots: Number(f.slots || 2),
      label: f.label, labels: parseLabels(f.labels || ''), log: (s) => console.log(s) });
    const leave = async () => { await w.leave(); process.exit(0); };
    process.on('SIGINT', leave);
    process.on('SIGTERM', leave);
  },
  async submit(a) {
    const f = a.flags;
    if (!a.rest.length) throw new Error(`no command; usage: ${HELP.submit}`);
    const [command, ...args] = a.rest;
    const job = await call(f, 'POST', '/ob/jobs', {
      name: f.name || path.basename(command), command, args, cwd: path.resolve(f.cwd || '.'),
      models: f.model || [], modelPolicy: f['any-model'] ? 'any' : 'one', selector: f.select || '', shell: !!f.shell,
    });
    console.log(job.id);
  },
  async ls(a) {
    const s = await call(a.flags, 'GET', '/ob/status');
    for (const j of s.jobs) {
      const prog = j.progress.total ? `${j.progress.done}/${j.progress.total}` : `${j.progress.done}`;
      console.log([j.id, j.status, prog, dur(j.eta), j.model || '', j.name, j.reason ? `(${j.reason})` : ''].join('\t'));
    }
    const q = s.queueEta;
    console.log(`queue: ~${dur(q.seconds) || '0m'} left${q.unknown ? ` + ${q.unknown} job(s) without an estimate` : ''} - ${s.workers.filter((w) => w.active).length} card(s) online`);
  },
  async move(a) { await call(a.flags, 'POST', `/ob/jobs/${need(a, 0, 'move')}/move`, { index: Number(need(a, 1, 'move')) }); },
  async pause(a) { await call(a.flags, 'POST', `/ob/jobs/${need(a, 0, 'pause')}/pause`, {}); },
  async resume(a) { await call(a.flags, 'POST', `/ob/jobs/${need(a, 0, 'resume')}/resume`, {}); },
  async cancel(a) { await call(a.flags, 'POST', `/ob/jobs/${need(a, 0, 'cancel')}/cancel`, {}); },
  async rerun(a) { console.log((await call(a.flags, 'POST', `/ob/jobs/${need(a, 0, 'rerun')}/rerun`, {})).id); },
  async log(a) { process.stdout.write(`${await call(a.flags, 'GET', `/ob/jobs/${need(a, 0, 'log')}/log?tail=${Number(a.flags.tail || 200)}`)}\n`); },
};

function need(a, i, cmd) {
  if (a._[i] === undefined) throw new Error(`usage: ${HELP[cmd]}`);
  return a._[i];
}

async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  if (cmd === '--version' || cmd === 'version' || cmd === '-v') { console.log(`ollabatch ${VERSION}`); return; }
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(Object.values(HELP).join('\n'));
    return;
  }
  if (!COMMANDS[cmd]) throw new Error(`unknown command "${cmd}" (try: ollabatch help)`);
  const a = parse(argv);
  if (a.flags.help) { console.log(HELP[cmd]); return; }
  await COMMANDS[cmd](a);
}

main().catch((e) => { process.stderr.write(`ollabatch: ${e.message}\n`); process.exit(1); });
