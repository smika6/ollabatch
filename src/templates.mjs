// Job templates: the only jobs a browser on the LAN may add. The command
// lives in a file on the host; the dashboard can only pick a template and
// fill its params from each param's allowed values.
//
// rigpool.jobs.json: { "templates": [{ "id", "name", "command", "args": [], "cwd"?, "env"?,
//   "models": [], "modelPolicy"?, "minCards"?, "selector"?, "progressPattern"?, "estimate"?,
//   "restartable"?, "shell"?, "params"?: [{ "name", "values": [], "default"? }] }] }
import path from 'node:path';
import { readJson } from './state.mjs';

const SPEC_KEYS = ['models', 'modelPolicy', 'minCards', 'selector', 'progressPattern', 'estimate', 'restartable', 'shell'];

export function loadTemplates(file) {
  if (!file) return [];
  const doc = readJson(file);
  if (doc == null) return [];
  const bad = (why) => new Error(`${file}: ${why}`);
  if (!Array.isArray(doc.templates)) throw bad('expected { "templates": [...] }');
  const dir = path.dirname(path.resolve(file));
  return doc.templates.map((t, i) => {
    if (!t || typeof t.id !== 'string' || !t.id) throw bad(`template ${i} needs an "id"`);
    if (typeof t.command !== 'string' || !t.command) throw bad(`template "${t.id}" needs a "command"`);
    if (t.args != null && !Array.isArray(t.args)) throw bad(`template "${t.id}": "args" must be a list`);
    for (const p of t.params || []) {
      if (!p?.name || !Array.isArray(p.values) || !p.values.length) throw bad(`template "${t.id}": each param needs a name and values`);
    }
    return { ...t, name: t.name || t.id, args: t.args || [], env: t.env || {}, params: t.params || [],
      cwd: path.resolve(dir, t.cwd || '.') };
  });
}

export function instantiate(template, params = {}) {
  const values = {};
  for (const p of template.params) {
    const v = params[p.name] ?? p.default;
    if (v == null) throw new Error(`template "${template.id}": param "${p.name}" is required`);
    if (!p.values.includes(v)) throw new Error(`template "${template.id}": ${p.name} must be one of ${p.values.join(', ')}`);
    values[p.name] = v;
  }
  const fill = (s) => String(s).replace(/\$\{(\w+)\}/g, (m, k) => (k in values ? values[k] : m));
  const spec = {
    name: fill(template.name), command: template.command, args: template.args.map(fill), cwd: template.cwd,
    env: Object.fromEntries(Object.entries(template.env).map(([k, v]) => [k, fill(v)])), template: template.id,
  };
  for (const k of SPEC_KEYS) if (template[k] !== undefined) spec[k] = template[k];
  return spec;
}
