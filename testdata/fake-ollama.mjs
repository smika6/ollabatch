// A tiny Ollama stand-in for tests: /api/tags, /api/chat, /api/generate, /api/ps.
// Streams NDJSON unless the body says "stream": false, like the real one.
// `peak` records the most requests it held at once; `failWith` makes every
// chat/generate answer with that status and body.
import http from 'node:http';

export const NDJSON = '{"message":{"content":"o"},"done":false}\n{"message":{"content":"k"},"done":true}\n';

export function startFakeOllama({ models = ['fake'], delayMs = 0, failWith = null } = {}) {
  const calls = [];
  const state = { active: 0, peak: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/api/tags') return json(res, { models: models.map((name) => ({ name, model: name })) });
      if (req.url === '/api/ps') return json(res, { models: [] });
      if (req.url === '/api/chat' || req.url === '/api/generate') {
        const b = JSON.parse(body || '{}');
        calls.push(b);
        state.active++;
        state.peak = Math.max(state.peak, state.active);
        const done = () => { state.active--; };
        res.on('close', done);
        setTimeout(() => {
          if (res.destroyed) return;
          if (failWith) { res.writeHead(failWith.status, { 'Content-Type': 'application/json' }); return res.end(failWith.body); }
          if (b.stream === false) {
            return json(res, { model: b.model, message: { content: 'ok' }, done: true, total_duration: 2e8, load_duration: 1e7,
              prompt_eval_count: 10, prompt_eval_duration: 5e7, eval_count: 20, eval_duration: 1e8 });
          }
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          res.end(NDJSON);
        }, delayMs);
        return;
      }
      res.writeHead(404); res.end('not found');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, calls, state,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
  })));
}

function json(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
