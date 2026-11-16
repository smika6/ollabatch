import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPage } from '../src/agent/page.mjs';

const acts = [];
const agent = { status: () => ({ machine: 'testbox', cards: [], hostsFound: [] }), act: async (a) => { acts.push(a); } };
const page = await startPage({ agent, port: 0 });
after(() => page.close());

function raw({ method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: page.port, method, path: p, headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    r.on('error', reject);
    r.end(body);
  });
}

test('serves status and the page to this machine', async () => {
  assert.equal(JSON.parse((await raw({ path: '/status' })).text).machine, 'testbox');
  assert.match((await raw()).text, /<title>ollabatch on this PC<\/title>/);
});

test('refuses web pages from elsewhere and rebound host names', async () => {
  const body = JSON.stringify({ type: 'pause', card: 'x' });
  assert.equal((await raw({ method: 'POST', path: '/act', headers: { Origin: 'http://evil.example', 'Content-Type': 'text/plain' }, body })).status, 403);
  assert.equal((await raw({ path: '/status', headers: { Host: `evil.example:${page.port}` } })).status, 403);
  assert.equal(acts.length, 0);
});

test('an action from this machine reaches the agent', async () => {
  const r = await raw({ method: 'POST', path: '/act', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'pause', card: 'nvidia-1' }) });
  assert.equal(r.status, 200);
  assert.deepEqual(acts.at(-1), { type: 'pause', card: 'nvidia-1' });
});

test('joining from a link needs a click: the page never acts from the address alone', () => {
  const js = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'agent', 'page', 'app.js'), 'utf8');
  const hashHandler = js.slice(js.indexOf('function readJoinLink'), js.indexOf('// end readJoinLink'));
  assert.ok(hashHandler.length > 0, 'readJoinLink exists');
  assert.doesNotMatch(hashHandler, /act\(|\/act/);
});
