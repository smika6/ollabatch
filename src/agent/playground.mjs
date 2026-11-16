// The model playground: the folder the agent's Ollama servers keep models in,
// laid out exactly like Ollama's own store (blobs by digest, one manifest per
// name:tag). Models the owner already has are hard-linked in, not copied: a
// link costs no space and removing it never touches the owner's copy.
import fs from 'node:fs';
import path from 'node:path';

const REG = 'registry.ollama.ai';
const blobFile = (store, digest) => path.join(store, 'blobs', digest.replace(':', '-'));
const splitName = (name) => {
  const [full, tag = 'latest'] = name.split(':');
  const [ns, model] = full.includes('/') ? full.split('/') : ['library', full];
  return { ns, model, tag };
};
const manifestFile = (store, name) => { const { ns, model, tag } = splitName(name); return path.join(store, 'manifests', REG, ns, model, tag); };
const blobsOf = (manifest) => [manifest.config, ...(manifest.layers || [])].filter((b) => b?.digest);

export function listModels(store) {
  const root = path.join(store, 'manifests', REG);
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const ns of fs.readdirSync(root)) {
    for (const model of fs.readdirSync(path.join(root, ns))) {
      for (const tag of fs.readdirSync(path.join(root, ns, model))) {
        let manifest;
        try { manifest = JSON.parse(fs.readFileSync(path.join(root, ns, model, tag), 'utf8')); } catch { continue; }
        const blobs = blobsOf(manifest).map(({ digest, size }) => ({ digest, size }));
        if (!blobs.every((b) => fs.existsSync(blobFile(store, b.digest)))) continue;
        out.push({ name: `${ns === 'library' ? '' : `${ns}/`}${model}:${tag}`, manifest, blobs, size: blobs.reduce((s, b) => s + b.size, 0) });
      }
    }
  }
  return out;
}

export function linkModel(fromStore, toStore, name, { link = fs.linkSync, copy = fs.copyFileSync } = {}) {
  const manifest = JSON.parse(fs.readFileSync(manifestFile(fromStore, name), 'utf8'));
  let copied = false;
  fs.mkdirSync(path.join(toStore, 'blobs'), { recursive: true });
  for (const b of blobsOf(manifest)) {
    const to = blobFile(toStore, b.digest);
    if (fs.existsSync(to)) continue;
    try {
      link(blobFile(fromStore, b.digest), to);
    } catch (e) {
      if (e.code !== 'EXDEV' && e.code !== 'EPERM') throw e;
      copy(blobFile(fromStore, b.digest), to);
      copied = true;
    }
  }
  // The manifest last: until it exists, Ollama doesn't see a half-linked model.
  const mf = manifestFile(toStore, name);
  fs.mkdirSync(path.dirname(mf), { recursive: true });
  fs.writeFileSync(mf, JSON.stringify(manifest));
  return { linked: !copied, copied };
}

// Fallback for when no server is running; normally Ollama's /api/delete does this.
export function removeModel(store, name) {
  const mf = manifestFile(store, name);
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(mf, 'utf8')); } catch { return; }
  fs.rmSync(mf, { force: true });
  const stillUsed = new Set(listModels(store).flatMap((m) => m.blobs.map((b) => b.digest)));
  for (const b of blobsOf(manifest)) if (!stillUsed.has(b.digest)) fs.rmSync(blobFile(store, b.digest), { force: true });
}

// Bytes the playground really holds: blobs with another hard link (the
// owner's copy) cost nothing; blobs shared between models count once.
export function usage(store, models) {
  const seen = new Map();
  for (const m of models) for (const b of m.blobs) {
    if (seen.has(b.digest)) continue;
    let nlink = 1;
    try { nlink = fs.statSync(blobFile(store, b.digest)).nlink; } catch { /* gone */ }
    seen.set(b.digest, nlink > 1 ? 0 : b.size);
  }
  return {
    usedBytes: [...seen.values()].reduce((s, n) => s + n, 0),
    models: models.map((m) => ({ name: m.name, size: m.size, linked: m.blobs.every((b) => seen.get(b.digest) === 0) })),
  };
}

export function planEviction({ models, needBytes, limitBytes, usedBytes, locked, inUse, lastUsed }) {
  if (needBytes > limitBytes) return null;
  let over = usedBytes + needBytes - limitBytes;
  if (over <= 0) return [];
  const out = [];
  const candidates = models.filter((m) => !m.linked && !locked.has(m.name) && !inUse.has(m.name))
    .sort((a, b) => (lastUsed[a.name] ?? 0) - (lastUsed[b.name] ?? 0));
  for (const m of candidates) {
    out.push(m.name);
    over -= m.size;
    if (over <= 0) return out;
  }
  return null;
}

export async function remoteSize(name, { fetch = globalThis.fetch } = {}) {
  const { ns, model, tag } = splitName(name);
  try {
    const r = await fetch(`https://${REG}/v2/${ns}/${model}/manifests/${tag}`,
      { headers: { Accept: 'application/vnd.docker.distribution.manifest.v2+json' }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return null;
    const m = await r.json();
    return (m.config?.size || 0) + (m.layers || []).reduce((s, l) => s + (l.size || 0), 0);
  } catch {
    return null;
  }
}

// After a failed or killed pull: drop manifests whose blobs are missing, so a
// half-downloaded model never counts as present. Ollama's `-partial` blobs are
// kept: the next pull resumes from them instead of starting over.
export function cleanPartial(store) {
  const root = path.join(store, 'manifests', REG);
  if (!fs.existsSync(root)) return;
  for (const ns of fs.readdirSync(root)) for (const model of fs.readdirSync(path.join(root, ns))) {
    for (const tag of fs.readdirSync(path.join(root, ns, model))) {
      const file = path.join(root, ns, model, tag);
      let ok = false;
      try { ok = blobsOf(JSON.parse(fs.readFileSync(file, 'utf8'))).every((b) => fs.existsSync(blobFile(store, b.digest))); } catch { /* unreadable */ }
      if (!ok) fs.rmSync(file, { force: true });
    }
  }
}
