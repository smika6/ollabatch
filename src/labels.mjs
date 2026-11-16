// Card labels and job selectors. A "sub-pool" is just a label several cards
// share; a job's selector says which cards may serve it.
//
//   selector: "gpu=nvidia, vram>=12, owner!=gf, vision"
//   labels:   { gpu: "nvidia", vram: "16", vision: "1" }

const REQ = /^([\w.:/-]+)\s*(>=|<=|!=|=)\s*(.+)$/;
const KEY = /^[\w.:/-]+$/;

export function parseSelector(text) {
  if (!text || !text.trim()) return [];
  return text.split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
    const m = part.match(REQ);
    if (!m) {
      if (!KEY.test(part)) throw new Error(`bad selector term "${part}"`);
      return { key: part, op: 'has' };
    }
    const [, key, op, raw] = m;
    const value = raw.trim();
    if ((op === '>=' || op === '<=') && !Number.isFinite(Number(value))) {
      throw new Error(`selector "${key}${op}${value}" needs a number`);
    }
    return { key, op, value };
  });
}

export function matchesSelector(labels, reqs) {
  return reqs.every(({ key, op, value }) => {
    const have = labels[key];
    if (op === '!=') return have !== value;
    if (have === undefined) return false;
    if (op === 'has') return true;
    if (op === '=') return have === value;
    const n = Number(have);
    if (!Number.isFinite(n)) return false;
    return op === '>=' ? n >= Number(value) : n <= Number(value);
  });
}

export function formatSelector(reqs) {
  return reqs.map(({ key, op, value }) => (op === 'has' ? key : `${key}${op}${value}`)).join(',');
}

export function parseLabels(text) {
  const out = {};
  if (!text || !text.trim()) return out;
  for (const part of text.split(',').map((p) => p.trim()).filter(Boolean)) {
    const i = part.indexOf('=');
    const key = i > 0 ? part.slice(0, i).trim() : '';
    if (!KEY.test(key)) throw new Error(`bad label "${part}" (want key=value)`);
    out[key] = part.slice(i + 1).trim();
  }
  return out;
}
