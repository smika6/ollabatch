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
