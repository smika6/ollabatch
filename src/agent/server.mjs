// One Ollama server per card, pinned to that GPU, on its own loopback port.
// It confirms from Ollama's own log which GPU it actually picked, and comes
// back after a crash (a driver reset, say) with a growing delay.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { killTree, IS_WIN } from '../proc.mjs';

const COMPUTE = /msg="inference compute".*?description="([^"]+)"/;
const norm = (s) => String(s).toLowerCase().replace(/\((r|tm)\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function usesVulkan(card, platform = process.platform) {
  return card.vendor === 'intel' || card.vendor === 'other' || (card.vendor === 'amd' && platform !== 'linux');
}

export function backendEnv(card, { port, slots, playground, vulkanIndex = null, platform = process.platform }) {
  const env = {
    OLLAMA_HOST: `127.0.0.1:${port}`, OLLAMA_MODELS: playground, OLLAMA_NUM_PARALLEL: String(slots),
    OLLAMA_KEEP_ALIVE: '24h', OLLAMA_MAX_LOADED_MODELS: '1',
  };
  if (card.vendor === 'nvidia') Object.assign(env, { CUDA_VISIBLE_DEVICES: String(card.index), OLLAMA_VULKAN: '0' });
  else if (card.vendor === 'amd' && platform === 'linux') Object.assign(env, { ROCR_VISIBLE_DEVICES: String(card.index) });
  else if (usesVulkan(card, platform)) Object.assign(env, { CUDA_VISIBLE_DEVICES: '-1', OLLAMA_VULKAN: '1', GGML_VK_VISIBLE_DEVICES: String(vulkanIndex ?? 0) });
  return env;
}

export function isPortFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

export async function pickPorts(count, isFree = isPortFree, base = 11440) {
  const out = [];
  for (let p = base; out.length < count && p < base + 200; p++) if (await isFree(p)) out.push(p);
  return out;
}

export class CardServer extends EventEmitter {
  constructor({ card, port, slots = 1, playground, ollama, logDir, extraEnv = {}, backoffMs = 5000, maxBackoffMs = 300_000,
    vulkanCandidates = [0], log = () => {} }) {
    super();
    Object.assign(this, { card, port, slots, playground, ollama, logDir, extraEnv, log });
    this.baseBackoff = backoffMs ?? 5000;
    this.maxBackoff = maxBackoffMs;
    this.backoff = this.baseBackoff;
    this.candidates = usesVulkan(card) ? vulkanCandidates : [null];
    this.vulkanIndex = usesVulkan(card) ? vulkanCandidates[0] : null;
    this.state = 'stopped';
    this.gpuName = null;
    this.child = null;
    this.stopping = false;
    this.timer = null;
    fs.mkdirSync(playground, { recursive: true });
    fs.mkdirSync(logDir, { recursive: true });
  }

  get url() { return `http://127.0.0.1:${this.port}`; }

  async start() {
    this.stopping = false;
    this.state = 'starting';
    // Try the remembered Vulkan index first, then the rest.
    const order = [this.vulkanIndex, ...this.candidates.filter((c) => c !== this.vulkanIndex)];
    let down = false;
    for (const vk of order) {
      const r = await this.#launch(vk);
      if (this.stopping) return { confirmed: false, gpuName: this.gpuName };
      if (r === 'ok') {
        this.vulkanIndex = vk;
        this.state = 'ready';
        this.startedAt = Date.now();
        this.emit('ready');
        return { confirmed: true, gpuName: this.gpuName };
      }
      if (r === 'down') down = true;
      await this.#kill();
    }
    // A server that never came up (a GPU not back after a driver reset, say)
    // gets retried; only a server that named a different GPU is misconfigured.
    if (down) { this.#retryLater(); return { confirmed: false, gpuName: this.gpuName }; }
    this.state = 'misconfigured';
    this.log(`card ${this.card.name}: its server never picked this GPU (last saw "${this.gpuName}")`);
    return { confirmed: false, gpuName: this.gpuName };
  }

  async restart(slots = this.slots) {
    this.slots = slots;
    await this.stop();
    return this.start();
  }

  async stop() {
    this.stopping = true;
    clearTimeout(this.timer);
    await this.#kill();
    this.state = 'stopped';
  }

  async #kill() {
    const c = this.child;
    this.child = null;
    if (c) await killTree(c);
  }

  async #launch(vk) {
    this.gpuName = null;
    const env = { ...process.env, ...backendEnv(this.card, { port: this.port, slots: this.slots, playground: this.playground, vulkanIndex: vk }), ...this.extraEnv };
    const logFile = fs.openSync(path.join(this.logDir, `ollama-${this.card.id}.log`), 'a');
    const child = spawn(this.ollama.command, [...this.ollama.args, 'serve'], { env, windowsHide: true, detached: !IS_WIN });
    this.child = child;
    let buf = '';
    const onData = (d) => {
      fs.writeSync(logFile, d);
      buf += d.toString('utf8');
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) { const m = l.match(COMPUTE); if (m) this.gpuName = m[1]; }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', () => {});
    child.on('exit', () => {
      try { fs.closeSync(logFile); } catch { /* closed */ }
      if (this.child === child && !this.stopping && this.state === 'ready') this.#crashed();
    });

    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline && this.child === child && child.exitCode === null) {
      try { if ((await fetch(`${this.url}/api/version`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch { /* not yet */ }
      await sleep(150);
    }
    const gpuDeadline = Date.now() + 30_000;
    while (!this.gpuName && Date.now() < gpuDeadline && child.exitCode === null) await sleep(100);
    if (!this.gpuName) return 'down';
    const a = norm(this.gpuName), b = norm(this.card.name);
    return a.includes(b) || b.includes(a) ? 'ok' : 'mismatch';
  }

  #crashed() {
    if (Date.now() - (this.startedAt || 0) >= 10 * 60_000) this.backoff = this.baseBackoff;
    this.#retryLater(true);
  }

  #retryLater(crashed = false) {
    this.state = 'restarting';
    const wait = this.backoff;
    if (crashed) this.emit('crash', { wait });
    this.backoff = Math.min(this.backoff * 2, this.maxBackoff);
    this.log(`card ${this.card.name}: server ${crashed ? 'exited' : "didn't come up"}, retrying in ${Math.round(wait / 1000)} s`);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { if (!this.stopping) this.start().catch(() => {}); }, wait);
  }

  // Tests only: behave as if the running server just crashed.
  crashForTest() { this.#crashed(); }
}
