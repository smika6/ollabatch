// History: finished jobs, searchable, and a detail drawer for any job.
import { $, call, download, toast, busy, colorOf, tone } from './core.mjs';
import { esc, historyRowHtml, statusText, whenText, dur, ranFor, modelsText, big, rate, outTokPerSec, cardShares, timelineRates, etaText, FINISHED } from './view.mjs';
import { chartSvg, fold } from './charts.mjs';

let next = null, openId = null, drawerTimer = null, logQuery = '';

function filters() {
  const day = (v, end) => (v ? new Date(`${v}T${end ? '23:59:59' : '00:00:00'}`).getTime() : null);
  const q = new URLSearchParams();
  if ($('hq').value.trim()) q.set('q', $('hq').value.trim());
  if ($('hstatus').value) q.set('status', $('hstatus').value);
  if ($('htemplate').value) q.set('template', $('htemplate').value);
  const from = day($('hfrom').value), to = day($('hto').value, true);
  if (from != null) q.set('from', from);
  if (to != null) q.set('to', to);
  return q;
}

export async function loadHistory({ more = false } = {}) {
  const q = filters();
  q.set('limit', '25');
  if (more && next) q.set('before', next);
  const r = await call('GET', `/ob/history?${q}`);
  next = r.next;
  const rows = r.jobs.map((j) => historyRowHtml(j)).join('');
  if (more) $('histRows').insertAdjacentHTML('beforeend', rows);
  else $('histRows').innerHTML = rows || `<tr><td colspan="9" class="note">${q.toString().replace(/limit=\d+&?/, '') ? 'No finished jobs match.' : 'Finished jobs show up here.'}</td></tr>`;
  $('histMore').hidden = !next;
}

export function fillTemplates(templates) {
  const sel = $('htemplate');
  if (sel.dataset.n === String(templates.length)) return;
  sel.dataset.n = String(templates.length);
  sel.innerHTML = '<option value="">any template</option>' + templates.map((t) => `<option value="${esc(t.id)}">${esc(t.name.replace(/\$\{(\w+)\}/g, '$1'))}</option>`).join('');
}

export async function loadSettings() {
  const s = await call('GET', '/ob/settings');
  $('summaries').value = s.summaries;
}

// ── drawer ──────────────────────────────────────────────────────────────────
function facts(j) {
  const s = j.stats || {};
  const tps = outTokPerSec(s);
  const shares = cardShares(s);
  const head = [
    j.finishedAt ? `Finished ${whenText(j.finishedAt)}` : j.startedAt ? `Started ${whenText(j.startedAt)}` : 'Not started yet',
    ranFor(j) != null ? `ran ${dur(ranFor(j))}` : j.status === 'running' && j.eta != null ? etaText(j.eta) : '',
    j.progress?.done ? `${j.progress.done.toLocaleString('en-US')}${j.progress.total ? ` of ${j.progress.total.toLocaleString('en-US')}` : ''} items` : '',
    modelsText(j),
    j.selector ? `selector ${j.selector}` : '',
  ].filter(Boolean);
  const rows = [
    ['Cards', shares.length ? shares.map((c) => `<span class="share"><i style="background:${colorOf(`card:${c.id}`)};width:${Math.max(4, c.pct)}px"></i>${esc(c.label)} ${c.pct}%</span>`).join(' ') : '<span class="note">no requests yet</span>', true],
    ['Requests', `${big(s.requests ?? 0)} answered${s.failed ? `, ${s.failed} failed attempts` : ''}${s.retried ? `, ${s.retried} retried` : ''}`],
    ['Tokens', !s.requests ? 'none yet' : !s.promptTokens && !s.outputTokens ? 'unknown (the answers carried no stats)'
      : `${big(s.promptTokens)} in · ${big(s.outputTokens)} out${tps ? ` · ${rate(tps)} tok/s average output speed` : ''}`],
    ['Model loads', s.loads ? `${s.loads} load${s.loads === 1 ? '' : 's'}, ${Math.round(s.loadSec)} s in total` : 'none'],
    ...(s.lastErrors?.length ? [['Last errors', s.lastErrors.map((e) => `<div class="err">${esc(e)}</div>`).join(''), true]] : []),
  ];
  return { head, rows };
}

function summaryBlock(j) {
  const off = $('summaries').value === 'off';
  const btn = !FINISHED.has(j.status) ? '' : j.summaryState === 'running'
    ? '<span class="note">Writing a summary on one of your cards…</span>'
    : off ? '<span class="note">AI summaries are off (History settings).</span>'
      : `<button data-dact="summarize">${j.summary ? 'Regenerate' : 'Summarize'}</button>`;
  const by = j.summary ? (j.summary.source === 'job' ? 'written by the job' : `by the pool${j.summary.model ? `, ${esc(j.summary.model)}` : ''}`) : '';
  return `<section class="dsum"><div class="head"><h3>Summary ${by ? `<span class="note">(${by})</span>` : ''}</h3>${btn}</div>
    ${j.summary ? `<p>${esc(j.summary.text)}</p>` : `<p class="note">${FINISHED.has(j.status) ? 'No summary yet.' : 'Summaries are for finished jobs.'}</p>`}
    ${j.summaryError ? `<p class="err">The last try failed: ${esc(j.summaryError)}</p>` : ''}</section>`;
}

function progressChart(j) {
  const tl = j.timeline;
  const per = fold(timelineRates(tl), 120, 'sum');
  if (!per.length) return '<p class="note">No progress over time recorded for this job.</p>';
  const step = tl.step * Math.ceil(tl.done.length / per.length);
  return `<svg class="chart small" viewBox="0 0 640 120" role="img" aria-label="Items finished over time">${chartSvg({ w: 640, h: 120, kind: 'bars', unit: '', t0: tl.t0, step,
    series: [{ label: 'items', color: tone('--amber'), values: per }] })}</svg><p class="note">Items finished per ${step >= 3_600_000 ? 'hour' : step > 60_000 ? `${step / 60_000} minutes` : 'minute'}.</p>`;
}

async function renderDrawer() {
  const j = await call('GET', `/ob/jobs/${openId}`);
  const f = facts(j);
  const acts = [
    FINISHED.has(j.status) ? '<button data-dact="rerun">Run again</button>' : '',
    j.startedAt ? '<button data-dact="download">Download log</button>' : '',
    FINISHED.has(j.status) ? '<button data-dact="delete" class="danger">Delete</button>' : '',
  ].join('');
  const keepNotes = $('dnotes') && document.activeElement === $('dnotes') ? $('dnotes').value : null;
  $('drawerBody').innerHTML = `
    <div class="head"><h2>${esc(j.name)}</h2><span class="state ${esc(j.status)}">${esc(statusText(j))}</span><button data-dact="close" aria-label="Close">Close</button></div>
    <p class="note">${f.head.map(esc).join(' · ')}</p>
    <div class="row">${acts}</div>
    ${summaryBlock(j)}
    <section><h3>Progress over time</h3>${progressChart(j)}</section>
    <dl class="facts">${f.rows.map(([k, v, html]) => `<dt>${esc(k)}</dt><dd>${html ? v : esc(v)}</dd>`).join('')}</dl>
    <section><h3>Notes</h3><textarea id="dnotes" rows="3" placeholder="Anything worth remembering about this run">${esc(j.notes || '')}</textarea>
      <div class="row"><button data-dact="notes">Save notes</button></div></section>
    <section><div class="head"><h3>Log</h3><input id="dlogq" type="search" placeholder="Find in log" value="${esc(logQuery)}" aria-label="Find in log"></div>
      <pre id="dlog" class="logbox">…</pre></section>`;
  if (keepNotes != null) { $('dnotes').value = keepNotes; $('dnotes').focus(); }
  if (j.startedAt) {
    const q = logQuery ? `&q=${encodeURIComponent(logQuery)}` : '';
    $('dlog').textContent = (await call('GET', `/ob/jobs/${j.id}/log?tail=400${q}`)) || (logQuery ? 'No lines match.' : '(empty)');
  } else $('dlog').textContent = 'The job hasn\'t started.';
  clearTimeout(drawerTimer);
  // Keep it live while the job runs or a summary is being written.
  if (!FINISHED.has(j.status) || j.summaryState === 'running') refreshSoon(j.id);
}
function refreshSoon(id) {
  drawerTimer = setTimeout(() => {
    if (openId !== id) return;
    if (document.activeElement?.matches('#dnotes, #dlogq')) refreshSoon(id);   // not while you're typing
    else renderDrawer().catch(() => {});
  }, 4000);
}

export async function openJob(id) {
  openId = id; logQuery = '';
  $('drawerBody').innerHTML = '<p class="note">Loading…</p>';
  if (!$('jobDrawer').open) $('jobDrawer').showModal();
  await renderDrawer();
}

async function drawerAction(b) {
  const a = b.dataset.dact, id = openId;
  if (a === 'close') { $('jobDrawer').close(); return; }
  await busy(b, async () => {
    if (a === 'summarize') { await call('POST', `/ob/jobs/${id}/summarize`); toast('Writing a summary on one of your cards. It waits behind real work.'); }
    if (a === 'rerun') { const j = await call('POST', `/ob/jobs/${id}/rerun`, {}); toast(`Queued again as ${j.name}.`, 'ok'); }
    if (a === 'download') await download(`/ob/jobs/${id}/log?download=1`, `${id}.log`);
    if (a === 'notes') { await call('PATCH', `/ob/jobs/${id}`, { notes: $('dnotes').value }); toast('Notes saved.', 'ok'); }
    if (a === 'delete') {
      if (!confirm('Delete this job from the history? Its log and record are removed for good.')) return;
      await call('DELETE', `/ob/jobs/${id}`);
      $('jobDrawer').close();
      toast('Deleted.');
      await loadHistory();
      return;
    }
    await renderDrawer();
  });
}

export function initHistory() {
  let t = null;
  const refilter = () => { clearTimeout(t); t = setTimeout(() => loadHistory().catch(() => {}), 250); };
  $('histFilter').addEventListener('input', refilter);
  $('histFilter').addEventListener('submit', (e) => { e.preventDefault(); refilter(); });
  $('histMore').addEventListener('click', (e) => busy(e.target, () => loadHistory({ more: true })));
  $('exportCsv').addEventListener('click', (e) => busy(e.target, () => download('/ob/history/export?format=csv', 'ollabatch-history.csv')));
  $('exportJson').addEventListener('click', (e) => busy(e.target, () => download('/ob/history/export?format=json', 'ollabatch-history.json')));
  $('summaries').addEventListener('change', (e) => busy(e.target, async () => {
    await call('PUT', '/ob/settings', { summaries: e.target.value });
    toast({ off: 'AI summaries are off.', manual: 'AI summaries run when you ask for one.', auto: 'Every finished job gets an AI summary from an idle card of yours.' }[e.target.value], 'ok');
  }));
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-job]');
    if (b) { openJob(b.dataset.job).catch((err) => toast(err.message, 'bad')); return; }
    const d = e.target.closest('[data-dact]');
    if (d) drawerAction(d);
  });
  document.addEventListener('input', (e) => {
    if (e.target.id !== 'dlogq') return;
    logQuery = e.target.value;
    clearTimeout(t);
    t = setTimeout(async () => {
      const q = logQuery ? `&q=${encodeURIComponent(logQuery)}` : '';
      try { $('dlog').textContent = (await call('GET', `/ob/jobs/${openId}/log?tail=400${q}`)) || (logQuery ? 'No lines match.' : '(empty)'); } catch { /* keep */ }
    }, 250);
  });
  $('jobDrawer').addEventListener('close', () => { openId = null; clearTimeout(drawerTimer); });
}
