// Answer every prompt in a JSONL file; append answers to another JSONL file.
// Resumes: lines already answered (by index) are skipped on the next run.
//
//   node batch-prompts.mjs prompts.jsonl answers.jsonl
//   each input line: {"prompt": "..."} or {"messages": [...]}
// Env (set by ollabatch): OLLAMA_URL, OLLAMA_MODEL. CONCURRENCY (default 4)
// requests in flight, so several cards stay busy.
import fs from 'node:fs';

const [input, output] = process.argv.slice(2);
if (!input || !output) { console.error('usage: node batch-prompts.mjs <in.jsonl> <out.jsonl>'); process.exit(2); }
const url = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const model = process.env.OLLAMA_MODEL || 'gemma4:12b';
const concurrency = Number(process.env.CONCURRENCY) || 4;

const lines = fs.readFileSync(input, 'utf8').split('\n').filter((l) => l.trim());
const done = new Set(fs.existsSync(output)
  ? fs.readFileSync(output, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).index) : []);
const todo = lines.map((l, index) => ({ index, ...JSON.parse(l) })).filter((x) => !done.has(x.index));
let finished = done.size, errors = 0;
console.log(`to answer: ${todo.length} of ${lines.length}`);

async function answer(item) {
  const messages = item.messages || [{ role: 'user', content: item.prompt }];
  const r = await fetch(`${url}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const body = await r.json();
  fs.appendFileSync(output, `${JSON.stringify({ index: item.index, model: body.model, answer: body.message?.content ?? '' })}\n`);
}

const queue = [...todo];
await Promise.all(Array.from({ length: concurrency }, async () => {
  for (let item; (item = queue.shift());) {
    try { await answer(item); } catch (e) { errors++; console.error(`line ${item.index + 1}: ${e.message}`); }
    finished++;
    console.log(`${finished}/${lines.length} · errors ${errors}`);
  }
}));
process.exitCode = errors ? 1 : 0;
