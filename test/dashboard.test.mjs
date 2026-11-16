import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHost } from '../src/host.mjs';
import { lanAddress } from '../testdata/helpers.mjs';

const host = await startHost({ port: 0, password: 'secret-pw', stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ollabatch dash ')) });
after(() => host.close());
const base = `http://127.0.0.1:${host.port}`;

test('serves the page, script and styles', async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  const html = await page.text();
  assert.match(html, /src="app\.js"/);
  assert.match(html, /href="style\.css"/);
  for (const [p, type, start] of [['/app.js', /javascript/, '// ollabatch dashboard'], ['/style.css', /css/, ':root']]) {
    const r = await fetch(`${base}${p}`);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-type'), type);
    assert.ok((await r.text()).startsWith(start), `${p} is served as-is`);
  }
});

test('the host\'s own browser gets the password; other devices do not', async (t) => {
  const local = await (await fetch(`${base}/`)).text();
  assert.match(local, /data-token="secret-pw"/);
  assert.doesNotMatch(local, /__OLLABATCH_TOKEN__/);
  const ip = lanAddress();
  if (!ip) return t.skip('no LAN address');
  const lan = await (await fetch(`http://${ip}:${host.port}/`)).text();
  assert.match(lan, /data-token=""/);
  assert.doesNotMatch(lan, /secret-pw/);
});
