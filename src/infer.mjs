// Ollama ends every answer with its own numbers: tokens read and written, how
// long each took, and how long the model took to load. Reading them as answers
// pass through the host gives inference insights with nothing new on the cards.
const NS = 1e9;
const LOAD_MS = 50;   // anything shorter is the model already being in memory

export function parseStats(body, contentType = '') {
  if (!body) return null;
  let obj;
  try {
    if (/ndjson/.test(contentType) || body.trimEnd().includes('\n')) {
      const lines = body.trim().split('\n').filter(Boolean);
      obj = JSON.parse(lines.findLast((l) => /"done"\s*:\s*true/.test(l)) ?? lines.at(-1));
    } else {
      obj = JSON.parse(body);
    }
  } catch { return null; }
  if (!obj || typeof obj !== 'object' || obj.total_duration == null) return null;
  const sec = (v) => (typeof v === 'number' ? v / NS : null);
  const num = (v) => (typeof v === 'number' ? v : null);
  return {
    model: obj.model ?? null, promptTokens: num(obj.prompt_eval_count), outputTokens: num(obj.eval_count),
    promptSec: sec(obj.prompt_eval_duration), genSec: sec(obj.eval_duration), loadSec: sec(obj.load_duration),
    loaded: (obj.load_duration ?? 0) / 1e6 > LOAD_MS, totalSec: sec(obj.total_duration),
  };
}

// One reload, many answers: every request that waited for a model to load
// reports that same load (a card running 4 at once reports one reload 4
// times). Answers whose load finished within a few seconds of each other on
// the same card and model are one load; only the first counts.
const SAME_LOAD_MS = 5_000;
export class LoadCounter {
  constructor() { this.last = new Map(); }   // card → { model, endMs }

  // `stats` with `loaded` cleared if this load was already counted.
  dedupe(card, stats, answeredAt) {
    if (!stats?.loaded) return stats;
    const endMs = answeredAt - ((stats.totalSec ?? 0) - (stats.loadSec ?? 0)) * 1000;   // when its load finished
    const prev = this.last.get(card);
    if (prev && prev.model === stats.model && Math.abs(prev.endMs - endMs) < SAME_LOAD_MS) return { ...stats, loaded: false, loadSec: 0 };
    this.last.set(card, { model: stats.model, endMs });
    return stats;
  }
}
