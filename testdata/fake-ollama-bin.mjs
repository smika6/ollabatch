// A stand-in for `ollama serve`, launched as a real process by tests.
//   node fake-ollama-bin.mjs serve
// Honours OLLAMA_HOST, OLLAMA_NUM_PARALLEL (requests beyond it wait),
// OLLAMA_MODELS (models = manifests on disk). Prints an "inference compute"
// log line naming its GPU like Ollama does: FAKE_GPU, or FAKE_GPU_BY_VK (JSON
// map of GGML_VK_VISIBLE_DEVICES index → name). FAKE_MS delays each chat;
// FAKE_EXIT_AFTER_MS exits (a crash); FAKE_FAIL_PULL=1 fails pulls half-way;
// FAKE_PULL_SIZE sets the pulled blob's size in bytes (default 1024).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const env = process.env;
const [hostName, port] = (env.OLLAMA_HOST || '127.0.0.1:11434').split(':');
const parallel = Math.max(1, Number(env.OLLAMA_NUM_PARALLEL) || 1);
const store = env.OLLAMA_MODELS || path.join(process.cwd(), '.fake-models');
const gpu = env.FAKE_GPU_BY_VK ? (JSON.parse(env.FAKE_GPU_BY_VK)[env.GGML_VK_VISIBLE_DEVICES ?? '0'] || 'none') : (env.FAKE_GPU || 'Fake GPU');
const manifestDir = path.join(store, 'manifests', 'registry.ollama.ai', 'library');

const split = (name) => { const [n, t = 'latest'] = name.split(':'); return [n, t]; };
function models() {
  const out = [];
  if (!fs.existsSync(manifestDir)) return out;
  for (const n of fs.readdirSync(manifestDir)) for (const t of fs.readdirSync(path.join(manifestDir, n))) out.push(`${n}:${t}`);
  return out;
}

let active = 0;
const waiting = [];
const slot = () => (active < parallel ? (active++, Promise.resolve()) : new Promise((r) => waiting.push(r)));
const free = () => { const next = waiting.shift(); if (next) next(); else active--; };

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url === '/api/version') return json(200, { version: '0.0.0-fake', parallel });
    if (req.url === '/api/tags') return json(200, { models: models().map((name) => ({ name, model: name })) });
    if (req.url === '/api/ps') return json(200, { models: [] });
    const b = body ? JSON.parse(body) : {};
    if (req.url === '/api/chat' || req.url === '/api/generate') {
      await slot();
      setTimeout(() => { free(); json(200, { model: b.model, message: { content: 'ok' }, done: true }); }, Number(env.FAKE_MS) || 0);
      return;
    }
    if (req.url === '/api/pull') {
      const [n, t] = split(b.model || b.name);
      const size = Number(env.FAKE_PULL_SIZE) || 1024;
      const data = Buffer.alloc(size, 7);
      const digest = `sha256:${crypto.createHash('sha256').update(data).digest('hex')}`;
      const blobs = path.join(store, 'blobs');
      fs.mkdirSync(blobs, { recursive: true });
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(`${JSON.stringify({ status: 'pulling', digest, total: size, completed: Math.floor(size / 2) })}\n`);
      if (env.FAKE_FAIL_PULL === '1') {
        fs.writeFileSync(path.join(blobs, `${digest.replace(':', '-')}-partial`), data.subarray(0, size / 2));
        res.end(`${JSON.stringify({ error: 'connection reset' })}\n`);
        return;
      }
      fs.writeFileSync(path.join(blobs, digest.replace(':', '-')), data);
      fs.mkdirSync(path.join(manifestDir, n), { recursive: true });
      fs.writeFileSync(path.join(manifestDir, n, t), JSON.stringify({ schemaVersion: 2, config: { digest, size: 0 }, layers: [{ digest, size }] }));
      res.end(`${JSON.stringify({ status: 'success' })}\n`);
      return;
    }
    if (req.url === '/api/delete') {
      const [n, t] = split(b.model || b.name);
      fs.rmSync(path.join(manifestDir, n, t), { force: true });
      return json(200, {});
    }
    json(404, { error: 'not found' });
  });
});

server.listen(Number(port), hostName, () => {
  console.error(`time=now level=INFO source=routes.go msg="Listening on ${hostName}:${port} (version 0.0.0-fake)"`);
  setTimeout(() => console.error(`time=now level=INFO source=types.go:32 msg="inference compute" id=0 library=FAKE name=FAKE0 description="${gpu}" total="16 GiB"`), 50);
});
if (env.FAKE_EXIT_AFTER_MS) setTimeout(() => process.exit(1), Number(env.FAKE_EXIT_AFTER_MS));
