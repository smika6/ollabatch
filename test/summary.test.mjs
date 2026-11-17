import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrub, buildPrompt } from '../src/summary.mjs';
import { startHost } from '../src/host.mjs';
import { startFakeOllama } from '../testdata/fake-ollama.mjs';
import { pullWorker, waitFor, api } from '../testdata/helpers.mjs';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'testdata');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ob sum '));
const cleanup = [];
after(async () => { for (const f of cleanup.reverse()) await f(); });

test('scrub removes lines that look like secrets and long tokens', () => {
  const out = scrub('ok line\nAPI_KEY=abc123\nAuthorization: Bearer xyz\npassword: hunter2\nhash 0123456789abcdef0123456789abcdef0123 done');
  assert.match(out, /ok line/);
  assert.doesNotMatch(out, /abc123|xyz|hunter2/);
  assert.match(out, /hash \[redacted\] done/);
});

test('the prompt has the job\'s facts and its scrubbed log, never its env', () => {
  const job = { id: 'j1', name: 'Royals · enhance', status: 'failed', exitCode: 1, env: { TAGS_PUSH_KEY: 'sekrit' }, startedAt: 0, finishedAt: 3_600_000,
    progress: { done: 10, total: 20 }, stats: { requests: 30, failed: 2, retried: 1, outputTokens: 900, loads: 1, lastErrors: ['Arc: HTTP 500'] } };
  const p = buildPrompt(job, 'line 1\ntoken=abc\nError: push failed');
  const all = `${p.system}\n${p.user}`;
  assert.match(all, /Royals · enhance/);
  assert.match(all, /failed/);
  assert.match(all, /push failed/);
  assert.doesNotMatch(all, /sekrit|token=abc/);
});

async function setup(settings) {
  const h = await startHost({ port: 0, password: 'secret-pw', stateDir: tmp(), beacon: false });
  cleanup.push(() => h.close());
  const base = `http://127.0.0.1:${h.port}`;
  const call = api(base, 'secret-pw');
  if (settings) await call('PUT', '/ob/settings', settings);
  return { h, base, call };
}
async function card(base, id, machine, delayMs = 0) {
  const f = await startFakeOllama({ delayMs });
  cleanup.push(() => f.close());
  const w = await pullWorker(base, { id, ollama: f.url, token: 'secret-pw', extra: { machine } });
  cleanup.push(() => w.stop());
  return f;
}
const quickJob = (call) => call('POST', '/ob/jobs', { name: 'calls', command: process.execPath, args: [path.join(DATA, 'call-ollama.mjs'), '1'], cwd: DATA });
const isSummary = (b) => (b.messages || []).some((m) => /summar/i.test(m.content || ''));

test('a summary runs only on a trusted card, after real work', async () => {
  const s = await setup();
  const trusted = await card(s.base, 'mine', os.hostname(), 300);
  const stranger = await card(s.base, 'theirs', 'gf-pc');
  const j = (await quickJob(s.call)).json;
  await waitFor(async () => (await s.call('GET', `/ob/jobs/${j.id}`)).json.status === 'done', 15_000, 'job done');
  // Keep real work queued, then ask for the summary.
  const real = Array.from({ length: 6 }, () => s.call('POST', '/api/chat', { model: 'fake', stream: false, messages: [{ role: 'user', content: 'work' }] }));
  assert.equal((await s.call('POST', `/ob/jobs/${j.id}/summarize`)).status, 200);
  await Promise.all(real);
  const d = await waitFor(async () => { const x = (await s.call('GET', `/ob/jobs/${j.id}`)).json; return x.summary && x; }, 15_000, 'summary');
  assert.equal(d.summary.source, 'pool');
  assert.equal(d.summary.text, 'ok');
  assert.ok(trusted.calls.some(isSummary), 'the trusted card wrote it');
  assert.ok(!stranger.calls.some(isSummary), 'the other person\'s card never saw the log');
});

test('a job\'s own summary wins over an automatic one', async () => {
  const s = await setup({ summaries: 'auto' });
  await card(s.base, 'mine', os.hostname());
  const script = 'fetch(process.env.OLLABATCH_PROGRESS_URL,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({summary:"did it myself"})}).then(()=>{})';
  const j = (await s.call('POST', '/ob/jobs', { name: 'self', command: process.execPath, args: ['-e', script], cwd: DATA })).json;
  await waitFor(async () => (await s.call('GET', `/ob/jobs/${j.id}`)).json.status === 'done', 15_000, 'done');
  await new Promise((r) => setTimeout(r, 800));
  const d = (await s.call('GET', `/ob/jobs/${j.id}`)).json;
  assert.deepEqual([d.summary.source, d.summary.text], ['job', 'did it myself']);
});

test('summaries switched off refuse the button', async () => {
  const s = await setup({ summaries: 'off' });
  await card(s.base, 'mine', os.hostname());
  const j = (await quickJob(s.call)).json;
  await waitFor(async () => (await s.call('GET', `/ob/jobs/${j.id}`)).json.status === 'done', 15_000, 'done');
  assert.equal((await s.call('POST', `/ob/jobs/${j.id}/summarize`)).status, 409);
  assert.equal((await s.call('GET', '/ob/settings')).json.summaries, 'off');
});

test('scrub also catches JSON keys, Authorization, URL credentials, --password and sk- keys; facts are scrubbed too', () => {
  const out = scrub('{"password": "hunter2"}\nAuthorization: Basic dXNlcjpwYXNz\npostgres://admin:hunter2@db/x\nrun --password hunter2\nkey sk-abc12345678\ntokens: 4000 out');
  assert.doesNotMatch(out, /hunter2|dXNlcjpwYXNz|sk-abc/);
  assert.match(out, /tokens: 4000 out/, 'ordinary progress lines stay');
  const p = buildPrompt({ name: 'sync --token abc123', status: 'failed', reason: 'api_key=zzz', stats: { lastErrors: ['card: Bearer qqq'] } }, '');
  assert.doesNotMatch(`${p.system}${p.user}`, /abc123|zzz|qqq/);
});

test('a summary waiting when the host stopped is not "running" after a restart', async () => {
  const dir = tmp();
  const h = await startHost({ port: 0, password: 'secret-pw', stateDir: dir, beacon: false });
  const call = api(`http://127.0.0.1:${h.port}`, 'secret-pw');
  const j = (await quickJob(call)).json;
  h.store.get(j.id).summaryState = 'running';
  await h.close();
  const h2 = await startHost({ port: 0, password: 'secret-pw', stateDir: dir, beacon: false });
  cleanup.push(() => h2.close());
  const d = (await api(`http://127.0.0.1:${h2.port}`, 'secret-pw')('GET', `/ob/jobs/${j.id}`)).json;
  assert.equal(d.summaryState, undefined);
});
