// A job: N sequential chat calls to its Ollama address, printing i/N.
const n = Number(process.argv[2] || 1);
const url = process.env.OLLAMA_URL;
const model = process.env.OLLAMA_MODEL || 'fake';
for (let i = 1; i <= n; i++) {
  const r = await fetch(`${url}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, stream: false, messages: [{ role: 'user', content: `hi ${i}` }] }),
  });
  if (!r.ok) { console.error(`call ${i}: HTTP ${r.status} ${await r.text()}`); process.exit(1); }
  console.log(`${i}/${n}`);
}
