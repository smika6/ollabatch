// The agent's settings, owned by this machine's owner. The local page edits
// them; when the owner lets the pool manage this PC (`remote`), the host's
// dashboard can too, field by field, and whichever change is newer wins.
import path from 'node:path';
import fs from 'node:fs';
import { readJson, writeJsonAtomic } from '../state.mjs';

export function loadConfig(dir, { trusted = false } = {}) {
  const file = path.join(dir, 'config.json');
  const fresh = !fs.existsSync(file);
  const saved = readJson(file) || {};
  return {
    host: saved.host ?? null,
    password: saved.password ?? null,
    trusted: saved.trusted ?? !!trusted,
    // Older configs and untrusted installs start with remote control off.
    remote: saved.remote ?? (fresh ? !!trusted : false),
    policy: saved.policy ?? 'when-free',
    schedule: saved.schedule ?? [],
    playground: {
      path: path.join(dir, 'playground'), limitGB: 50, downloads: !!trusted, locked: [], lastUsed: {},
      ...saved.playground,
    },
    cards: saved.cards ?? {},
    changedAt: saved.changedAt ?? {},       // field → when the owner last changed it (this machine's clock)
    remoteSeen: saved.remoteSeen ?? {},     // field → the host's stamp of the last remote value handled
    remoteVersion: saved.remoteVersion ?? 0,
    policyBy: saved.policyBy ?? 'owner',   // who set the policy in force: 'owner' or 'pool'
  };
}

export function saveConfig(dir, cfg) {
  writeJsonAtomic(path.join(dir, 'config.json'), cfg);
}
