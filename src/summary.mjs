// AI summaries of finished jobs, written by the pool's own GPUs. The prompt
// carries the job's facts and the tail of its log, with anything that looks
// like a secret removed first; a job's environment is never included.

// A line goes if it looks like it carries a secret: key=, "password": ,
// Authorization: ..., Bearer/Basic credentials, --token value, user:pass@ in a URL.
const SECRET_LINE = new RegExp([
  String.raw`(key|token|password|passwd|pwd|secret|credential)["']?\s*[=:]`,
  String.raw`\bauthorization\b`,
  String.raw`\b(bearer|basic)\s+\S+`,
  String.raw`--(password|passwd|token|api-?key|key|secret)[=\s]+\S+`,
  String.raw`\b[a-z][\w+.-]*://[^\s/:@]+:[^\s/@]+@`,
  String.raw`\bsk-[A-Za-z0-9_-]{8,}`,
].join('|'), 'i');
const LONG_TOKEN = /[A-Za-z0-9+/_-]{32,}={0,2}/g;

export function scrub(text) {
  return String(text ?? '').split(/\r?\n/).filter((l) => !SECRET_LINE.test(l)).map((l) => l.replace(LONG_TOKEN, '[redacted]')).join('\n');
}
const one = (s) => scrub(s).replace(/\n/g, ' ') || '[redacted]';

const dur = (ms) => {
  if (!ms || ms < 0) return 'unknown';
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

export function buildPrompt(job, logTail) {
  const s = job.stats || {};
  const facts = [
    `Job: ${one(job.name)}${job.template ? ` (template ${one(job.template)})` : ''}`,
    `Result: ${job.status}${job.exitCode != null ? `, exit code ${job.exitCode}` : ''}${job.reason ? `, ${one(job.reason)}` : ''}`,
    `Ran for: ${dur((job.finishedAt || 0) - (job.startedAt || 0))}`,
    `Progress: ${job.progress?.done ?? 0}${job.progress?.total ? ` of ${job.progress.total}` : ''} items`,
    `Model: ${job.model || (job.modelsUsed || []).join(', ') || 'unknown'}`,
    `Requests: ${s.requests ?? 0}, failed attempts ${s.failed ?? 0}, retried ${s.retried ?? 0}, output tokens ${s.outputTokens ?? 0}, model loads ${s.loads ?? 0}`,
    ...(s.lastErrors?.length ? [`Last errors: ${s.lastErrors.map(one).join(' | ')}`] : []),
  ];
  return {
    system: 'You summarize finished batch jobs for the person who runs them. Write 3 to 6 plain sentences: what the job did, '
      + 'what failed and why, and anything unusual worth checking. No preamble, no headings, no lists.',
    user: `${facts.join('\n')}\n\nThe last part of its log:\n${scrub(logTail).slice(-8000)}`,
  };
}
