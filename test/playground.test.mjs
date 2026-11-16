import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { listModels, linkModel, removeModel, usage, planEviction, remoteSize, cleanPartial } from '../src/agent/playground.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ollabatch pg '));
const GB = 1024 ** 3;

// Writes a model the way Ollama stores it: blobs by digest, a manifest per name:tag.
function putModel(store, name, sizes) {
  const [n, t = 'latest'] = name.split(':');
  const layers = sizes.map((size, i) => {
    const data = Buffer.alloc(size, (i + n.length) % 251);
    const digest = `sha256:${crypto.createHash('sha256').update(data).update(name).update(String(i)).digest('hex')}`;
    fs.mkdirSync(path.join(store, 'blobs'), { recursive: true });
    fs.writeFileSync(path.join(store, 'blobs', digest.replace(':', '-')), data);
    return { digest, size };
  });
  const dir = path.join(store, 'manifests', 'registry.ollama.ai', 'library', n);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, t), JSON.stringify({ schemaVersion: 2, config: layers[0], layers: layers.slice(1) }));
}

test('listModels reads manifests and sizes', () => {
  const s = tmp();
  putModel(s, 'gemma4:12b', [100, 4000]);
  putModel(s, 'qwen:9b', [50, 900]);
  const m = listModels(s);
  assert.deepEqual(m.map((x) => [x.name, x.size]).sort(), [['gemma4:12b', 4100], ['qwen:9b', 950]]);
});

test('links instead of copying, and linked models cost nothing', () => {
  const user = tmp(), pg = tmp();
  putModel(user, 'gemma4:12b', [100, 4000]);
  assert.deepEqual(linkModel(user, pg, 'gemma4:12b'), { linked: true, copied: false });
  const [m] = listModels(pg);
  assert.equal(m.name, 'gemma4:12b');
  const u = usage(pg, listModels(pg));
  assert.equal(u.usedBytes, 0);
  assert.equal(u.models[0].linked, true);
  const blob = path.join(pg, 'blobs', m.blobs[1].digest.replace(':', '-'));
  assert.equal(fs.statSync(blob).nlink, 2);
});

test('removing a linked model leaves the owner\'s copy', () => {
  const user = tmp(), pg = tmp();
  putModel(user, 'gemma4:12b', [100, 4000]);
  linkModel(user, pg, 'gemma4:12b');
  removeModel(pg, 'gemma4:12b');
  assert.equal(listModels(pg).length, 0);
  const [mine] = listModels(user);
  for (const b of mine.blobs) assert.equal(fs.statSync(path.join(user, 'blobs', b.digest.replace(':', '-'))).nlink, 1);
});

test('across drives it copies, and the copy counts toward the limit', () => {
  const user = tmp(), pg = tmp();
  putModel(user, 'gemma4:12b', [100, 4000]);
  const exdev = () => { const e = new Error('cross-device'); e.code = 'EXDEV'; throw e; };
  assert.deepEqual(linkModel(user, pg, 'gemma4:12b', { link: exdev }), { linked: false, copied: true });
  assert.equal(usage(pg, listModels(pg)).usedBytes, 4100);
});

test('evicts least recently used unlocked models until the new one fits', () => {
  const models = [
    { name: 'a', size: 10 * GB, linked: false }, { name: 'b', size: 20 * GB, linked: false },
    { name: 'c', size: 15 * GB, linked: false }, { name: 'mine', size: 30 * GB, linked: true },
  ];
  const plan = planEviction({ models, needBytes: 12 * GB, limitBytes: 50 * GB, usedBytes: 45 * GB,
    locked: new Set(), inUse: new Set(), lastUsed: { a: 300, b: 100, c: 200 } });
  assert.deepEqual(plan, ['b']);
  assert.deepEqual(planEviction({ models, needBytes: 1 * GB, limitBytes: 50 * GB, usedBytes: 45 * GB, locked: new Set(), inUse: new Set(), lastUsed: {} }), []);
});

test('never evicts locked or in-use models; null when it can\'t fit', () => {
  const models = [{ name: 'a', size: 10 * GB, linked: false }, { name: 'b', size: 20 * GB, linked: false }];
  const base = { models, limitBytes: 30 * GB, usedBytes: 30 * GB, lastUsed: { a: 1, b: 2 } };
  assert.deepEqual(planEviction({ ...base, needBytes: 15 * GB, locked: new Set(['a']), inUse: new Set() }), ['b']);
  assert.equal(planEviction({ ...base, needBytes: 15 * GB, locked: new Set(['a']), inUse: new Set(['b']) }), null);
  assert.equal(planEviction({ ...base, needBytes: 40 * GB, locked: new Set(), inUse: new Set() }), null);
});

test('a failed pull leaves the cache consistent', () => {
  const pg = tmp();
  putModel(pg, 'good:1', [10, 20]);
  fs.writeFileSync(path.join(pg, 'blobs', 'sha256-abc-partial'), 'half');
  const dir = path.join(pg, 'manifests', 'registry.ollama.ai', 'library', 'broken');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'latest'), JSON.stringify({ config: { digest: 'sha256:missing', size: 5 }, layers: [] }));
  cleanPartial(pg);
  assert.deepEqual(listModels(pg).map((m) => m.name), ['good:1']);
  assert.equal(fs.existsSync(path.join(pg, 'blobs', 'sha256-abc-partial')), false);
});

test('remoteSize sums a registry manifest', async () => {
  const calls = [];
  const fetch = async (url, opts) => {
    calls.push([url, opts.headers.Accept]);
    return { ok: true, json: async () => ({ config: { size: 500 }, layers: [{ size: 8_000_000_000 }, { size: 1000 }] }) };
  };
  assert.equal(await remoteSize('gemma4:12b', { fetch }), 8_000_001_500);
  assert.equal(calls[0][0], 'https://registry.ollama.ai/v2/library/gemma4/manifests/12b');
  assert.match(calls[0][1], /manifest\.v2\+json/);
  assert.equal(await remoteSize('someone/model', { fetch: async () => ({ ok: false }) }), null);
});
