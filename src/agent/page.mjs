// The agent's local page, http://127.0.0.1:11510: this machine's owner
// pauses cards, sets lending rules and manages the model playground here. Only
// programs on this machine may use it, never a web page from somewhere else
// (same Host/Origin rules as the host's loopback trust).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILES = {
  '/': [path.join(HERE, 'page', 'index.html'), 'text/html; charset=utf-8'],
  '/app.js': [path.join(HERE, 'page', 'app.js'), 'text/javascript'],
  '/style.css': [path.join(HERE, '..', 'dashboard', 'style.css'), 'text/css'],
};
const LOCAL_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function startPage({ agent, port = 11510 }) {
  const server = http.createServer(async (req, res) => {
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    const hostName = (req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
    const origin = req.headers.origin;
    if (!LOCAL_NAMES.has(hostName) || (origin != null && origin !== `http://${req.headers.host}`)) {
      return send(403, { error: 'ollabatch: this page only answers this machine' });
    }
    const url = new URL(req.url, 'http://page');
    try {
      if (req.method === 'GET' && FILES[url.pathname]) {
        const [file, type] = FILES[url.pathname];
        return send(200, fs.readFileSync(file), type);
      }
      if (req.method === 'GET' && url.pathname === '/status') return send(200, agent.status());
      if (req.method === 'POST' && url.pathname === '/act') {
        let body = '';
        for await (const c of req) body += c;
        await agent.act(JSON.parse(body || '{}'));
        return send(200, agent.status());
      }
      return send(404, { error: 'not found' });
    } catch (e) {
      return send(400, { error: e.message });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ port: server.address().port, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) }));
  });
}
