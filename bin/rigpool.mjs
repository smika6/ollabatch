#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { startHost, lanAddresses } from '../src/host.mjs';
import { join } from '../src/join.mjs';
import { parseLabels } from '../src/labels.mjs';

const HELP = {
  host: 'rigpool host [--port 11500] [--password pw] [--jobs rigpool.jobs.json] [--max-running 1] [--state .rigpool] [--local http://127.0.0.1:11434] [--local-slots 2] [--no-local]',
  join: 'rigpool join <host-url> --password pw [--ollama http://127.0.0.1:11434] [--slots 2] [--label name] [--labels k=v,...]',
  submit: 'rigpool submit [--host url] --name n [--model m]... [--any-model] [--select selector] [--cwd dir] [--shell] -- <command> [args...]',
  ls: 'rigpool ls [--host url]',
  move: 'rigpool move <job> <index> [--host url]',
  pause: 'rigpool pause <job>', resume: 'rigpool resume <job>', cancel: 'rigpool cancel <job>', rerun: 'rigpool rerun <job>',
  log: 'rigpool log <job> [--tail 200] [--host url]',
};
const FLAGS = new Set(['--no-local', '--any-model', '--shell', '--help']);

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
    const jobsFile = f.jobs || (fs.existsSync('rigpool.jobs.json') ? path.resolve('rigpool.jobs.json') : null);
    const h = await startHost({
      port: Number(f.port ?? 11500), password: f.password, stateDir: f.state || '.rigpool', jobsFile,
      maxRunning: Number(f['max-running'] || 1),
      local: f['no-local'] ? null : { url: f.local || 'http://127.0.0.1:11434', slots: Number(f['local-slots'] || 2) },
      log: (s) => console.log(s),
    });
    console.log(`listening on :${h.port}`);
    console.log(`dashboard: http://127.0.0.1:${h.port}/`);
    for (const ip of lanAddresses()) console.log(`join from another machine: rigpool join http://${ip}:${h.port} --password ${f.password ? '<your password>' : h.token}`);
    const stop = async () => { await h.close(); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
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
    const job = await call(f, 'POST', '/rp/jobs', {
      name: f.name || path.basename(command), command, args, cwd: path.resolve(f.cwd || '.'),
      models: f.model || [], modelPolicy: f['any-model'] ? 'any' : 'one', selector: f.select || '', shell: !!f.shell,
    });
    console.log(job.id);
  },
  async ls(a) {
    const s = await call(a.flags, 'GET', '/rp/status');
    for (const j of s.jobs) {
      const prog = j.progress.total ? `${j.progress.done}/${j.progress.total}` : `${j.progress.done}`;
      console.log([j.id, j.status, prog, dur(j.eta), j.model || '', j.name, j.reason ? `(${j.reason})` : ''].join('\t'));
    }
    const q = s.queueEta;
    console.log(`queue: ~${dur(q.seconds) || '0m'} left${q.unknown ? ` + ${q.unknown} job(s) without an estimate` : ''} - ${s.workers.filter((w) => w.active).length} card(s) online`);
  },
  async move(a) { await call(a.flags, 'POST', `/rp/jobs/${need(a, 0, 'move')}/move`, { index: Number(need(a, 1, 'move')) }); },
  async pause(a) { await call(a.flags, 'POST', `/rp/jobs/${need(a, 0, 'pause')}/pause`, {}); },
  async resume(a) { await call(a.flags, 'POST', `/rp/jobs/${need(a, 0, 'resume')}/resume`, {}); },
  async cancel(a) { await call(a.flags, 'POST', `/rp/jobs/${need(a, 0, 'cancel')}/cancel`, {}); },
  async rerun(a) { console.log((await call(a.flags, 'POST', `/rp/jobs/${need(a, 0, 'rerun')}/rerun`, {})).id); },
  async log(a) { process.stdout.write(`${await call(a.flags, 'GET', `/rp/jobs/${need(a, 0, 'log')}/log?tail=${Number(a.flags.tail || 200)}`)}\n`); },
};

function need(a, i, cmd) {
  if (a._[i] === undefined) throw new Error(`usage: ${HELP[cmd]}`);
  return a._[i];
}

async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(Object.values(HELP).join('\n'));
    return;
  }
  if (!COMMANDS[cmd]) throw new Error(`unknown command "${cmd}" (try: rigpool help)`);
  const a = parse(argv);
  if (a.flags.help) { console.log(HELP[cmd]); return; }
  await COMMANDS[cmd](a);
}

main().catch((e) => { process.stderr.write(`rigpool: ${e.message}\n`); process.exit(1); });
