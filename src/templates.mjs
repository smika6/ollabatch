// Job templates: the only jobs a browser on the LAN may add. The command
// lives in a file on the host; the dashboard can only pick a template and
// fill its params from each param's allowed values.
//
// ollabatch.jobs.json: { "templates": [{ "id", "name", "command", "args": [], "cwd"?, "env"?,
//   "models": [], "modelPolicy"?, "minCards"?, "selector"?, "progressPattern"?, "estimate"?,
//   "restartable"?, "shell"?, "params"?: [{ "name", "values": [], "default"? }] }] }
import path from 'node:path';
import { readJson } from './state.mjs';

const SPEC_KEYS = ['models', 'modelPolicy', 'minCards', 'selector', 'progressPattern', 'estimate', 'restartable', 'shell'];

// Shape checks for a job spec, shared by templates and the host's job API: a
// bad regex or a non-string arg must be refused up front, not crash the
// scheduler when the job starts.
export function specProblem(spec) {
  if (typeof spec.command !== 'string' || !spec.command) return 'command must be a non-empty string';
  if (spec.args != null && (!Array.isArray(spec.args) || spec.args.some((a) => typeof a !== 'string'))) return 'args must be a list of strings';
  if (spec.cwd != null && typeof spec.cwd !== 'string') return 'cwd must be a string';
  if (spec.env != null && (typeof spec.env !== 'object' || Array.isArray(spec.env) || Object.values(spec.env).some((v) => typeof v !== 'string'))) return 'env must map names to strings';
  if (spec.models != null && (!Array.isArray(spec.models) || spec.models.some((m) => typeof m !== 'string'))) return 'models must be a list of names';
  if (spec.modelPolicy != null && !['one', 'any'].includes(spec.modelPolicy)) return 'modelPolicy is "one" or "any"';
  if (spec.progressPattern != null) {
    try { new RegExp(spec.progressPattern); } catch (e) { return `progressPattern: ${e.message}`; }
  }
  return null;
}

export function loadTemplates(file) {
  if (!file) return [];
  const doc = readJson(file);
  if (doc == null) return [];
  const bad = (why) => new Error(`${file}: ${why}`);
  if (!Array.isArray(doc.templates)) throw bad('expected { "templates": [...] }');
  const dir = path.dirname(path.resolve(file));
  return doc.templates.map((t, i) => {
    if (!t || typeof t.id !== 'string' || !t.id) throw bad(`template ${i} needs an "id"`);
    const problem = specProblem(t);
    if (problem) throw bad(`template "${t.id}": ${problem}`);
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
