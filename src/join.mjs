// Join a host with one card. Only connects out, so this machine opens no ports.
import os from 'node:os';
import crypto from 'node:crypto';
import { startCardWorker } from './card-worker.mjs';

export async function join({ hostUrl, password = '', ollama = 'http://127.0.0.1:11434', slots = 2, label, labels = {}, log = () => {} }) {
  if (!/^https?:\/\//.test(hostUrl || '')) throw new Error('join needs the host URL, e.g. http://192.168.1.20:11500');
  ollama = ollama.replace(/\/+$/, '');
  const id = `${os.hostname()}-${ollama.replace(/\W+/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  label ||= `${os.hostname()} ${ollama.replace(/^https?:\/\//, '')}`;
  const w = await startCardWorker({ hostUrl, password, ollama, slots, id, label, labels, log });
  log(`joined ${hostUrl} as "${label}" - ${slots} slot(s) - Ollama ${ollama}`);
  return { id, leave: () => w.leave() };
}
