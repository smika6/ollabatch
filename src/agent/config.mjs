// The agent's settings, owned by this machine's owner (the local page edits
// them; the host only reads what the agent reports).
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../state.mjs';

export function loadConfig(dir, { trusted = false } = {}) {
  const saved = readJson(path.join(dir, 'config.json')) || {};
  return {
    host: saved.host ?? null,
    password: saved.password ?? null,
    policy: saved.policy ?? 'when-free',
    schedule: saved.schedule ?? [],
    playground: {
      path: path.join(dir, 'playground'), limitGB: 50, downloads: !!trusted, locked: [], lastUsed: {},
      ...saved.playground,
    },
    cards: saved.cards ?? {},
  };
}

export function saveConfig(dir, cfg) {
  writeJsonAtomic(path.join(dir, 'config.json'), cfg);
}
