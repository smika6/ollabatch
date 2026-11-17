// ollabatch dashboard. Polls /ob/status every 2 s; insights, sparklines and
// history refresh on slower timers. Each section lives in its own module.
import { $, S, saved, call, patch, toast, busy } from './core.mjs';
import { esc, rate, dur, etaText, clockAt, statusText, FINISHED } from './view.mjs';
import { initHistory, loadHistory, fillTemplates, loadSettings, openJob } from './history-ui.mjs';
import { initInsights, renderInsights, renderThrash, I } from './insights-ui.mjs';
import { initMachines, renderMachines, loadSparks, renderCardDetail, M } from './machines-ui.mjs';

function showGate(on, failed = false) {
  $('gate').hidden = !on;
  $('app').hidden = on;
  $('gateError').hidden = !failed;
  if (on) $('summary').textContent = 'Locked';
}
S.onLocked = () => showGate(true);

// ── summary + live tiles ────────────────────────────────────────────────────
function renderSummary(s) {
  const online = s.workers.filter((w) => w.active && !w.paused).length;
  const running = s.jobs.filter((j) => j.status === 'running');
  const q = s.queueEta;
  const left = q.seconds ? `queue done in about ${dur(q.seconds)}, ${clockAt(q.seconds)}` : running.length ? 'working out the time left' : 'nothing queued';
  const unknown = q.unknown ? `, plus ${q.unknown} job${q.unknown > 1 ? 's' : ''} without an estimate` : '';
  $('summary').textContent = `${online} card${online === 1 ? '' : 's'} working, ${left}${unknown}.`;
  const machines = s.machines.filter((m) => m.cards.some((c) => c.active)).length;
  const tps = I.now?.outputTokPerSec;
  const inMemory = new Set(Object.values(I.now?.loadedModels || {}).filter(Boolean)).size;
  $('stats').innerHTML = [
    [rate(s.perSec * 60), 'items per minute'],
    [tps == null ? '…' : rate(tps), 'output tokens per second'],
    [running.length, running.length === 1 ? 'job running' : 'jobs running'],
    [s.jobs.filter((j) => j.status === 'queued').length, 'queued'],
    [`${online}/${s.workers.length}`, `cards on ${machines} machine${machines === 1 ? '' : 's'}`],
    [inMemory, inMemory === 1 ? 'model in memory' : 'models in memory'],
  ].map(([v, l]) => `<div class="stat"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join('');
}

// ── queue ───────────────────────────────────────────────────────────────────
function jobRow(j, i, list) {
  const p = j.progress;
  const pct = p.total ? Math.min(100, (100 * p.done) / p.total) : 0;
  const waiting = j.reason === 'waiting for cards';
  const stateText = waiting ? 'waiting for cards' : statusText(j);
  const meta = [
    p.total ? `${p.done.toLocaleString('en-US')} of ${p.total.toLocaleString('en-US')}` : p.done ? `${p.done.toLocaleString('en-US')} done` : '',
    p.rate ? `${rate(p.rate)}/s` : '',
    j.eta != null && j.status === 'running' ? etaText(j.eta) : '',
    j.model || (j.models.length ? j.models.join(' or ') : ''),
    j.selector ? `needs ${j.selector}` : '',
    j.summary && FINISHED.has(j.status) ? 'has a summary' : '',
  ].filter(Boolean);
  const queued = list.filter((x) => x.status === 'queued');
  const qi = queued.indexOf(j);
  const acts = [];
  if (j.status === 'queued') {
    acts.push(`<button data-act="move" data-id="${j.id}" data-index="${i - 1}" ${qi <= 0 ? 'disabled' : ''} aria-label="Move ${esc(j.name)} up">Up</button>`);
    acts.push(`<button data-act="move" data-id="${j.id}" data-index="${i + 1}" ${qi === queued.length - 1 ? 'disabled' : ''} aria-label="Move ${esc(j.name)} down">Down</button>`);
  }
  if (j.status === 'running') acts.push(`<button data-act="pause" data-id="${j.id}">Pause</button>`);
  if (j.status === 'paused') acts.push(`<button data-act="resume" data-id="${j.id}">Resume</button>`);
  if (['queued', 'running', 'paused'].includes(j.status)) acts.push(`<button data-act="cancel" data-id="${j.id}">Cancel</button>`);
  if (FINISHED.has(j.status)) acts.push(`<button data-act="rerun" data-id="${j.id}">Run again</button>`);
  acts.push(`<button data-job="${j.id}">Details</button>`);
  return `<li class="job ${esc(j.status)}">
    <div class="line1"><span class="name">${esc(j.name)}</span><span class="state ${waiting ? 'wait' : esc(j.status)}">${esc(stateText)}</span></div>
    ${j.status === 'running' || j.status === 'paused' ? `<div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div>` : ''}
    ${meta.length ? `<div class="meta">${meta.map((m) => `<span>${esc(m)}</span>`).join('')}</div>` : ''}
    <div class="acts">${acts.join('')}</div>
  </li>`;
}

function renderJobs(s) {
  const live = s.jobs.filter((j) => !FINISHED.has(j.status));
  const past = s.jobs.filter((j) => FINISHED.has(j.status)).sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0)).slice(0, 5);
  if (!s.jobs.length) {
    patch($('jobs'), [{ key: 'empty', html: `<li class="empty">No jobs yet. ${s.templates.length ? 'Use Add job to queue one.' : 'Run <code>ollabatch submit</code> on the host, or add templates to <code>ollabatch.jobs.json</code> to queue jobs from here.'}</li>` }]);
    return;
  }
  patch($('jobs'), [...live, ...past].map((j) => ({ key: j.id, html: jobRow(j, s.jobs.indexOf(j), s.jobs) })));
}

function renderAddForm(s) {
  const f = $('addForm');
  if (f.dataset.built === String(s.templates.length)) return;
  f.dataset.built = String(s.templates.length);
  if (!s.templates.length) {
    f.innerHTML = '<p class="note">There are no job templates yet. Add them to <code>ollabatch.jobs.json</code> where the host runs, then restart it.</p>';
    return;
  }
  const options = s.templates.map((t) => `<option value="${esc(t.id)}">${esc(t.name.replace(/\$\{(\w+)\}/g, '$1'))}</option>`).join('');
  f.innerHTML = `<label>Job<select name="template">${options}</select></label><div id="params"></div>
    <div class="row"><button class="primary" type="submit">Add to queue</button></div>`;
  const fill = () => {
    const t = s.templates.find((x) => x.id === f.template.value);
    $('params').innerHTML = t.params.map((p) => `<label>${esc(p.name)}<select name="p:${esc(p.name)}">${p.values.map((v) =>
      `<option ${v === p.default ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>`).join('');
  };
  f.template.addEventListener('change', fill);
  fill();
}

// ── finished-job alerts ─────────────────────────────────────────────────────
// In-page toasts always; browser notifications if you switch them on and the
// browser allows them (only on secure pages: the host's own 127.0.0.1 page).
const NOTIFY_KEY = 'ollabatch-notify';
const canNotify = () => 'Notification' in window && window.isSecureContext;
let seen = null;
function announce(s) {
  const now = new Map(s.jobs.map((j) => [j.id, j.status]));
  if (seen) {
    for (const j of s.jobs) {
      const was = seen.get(j.id);
      if (!was || was === j.status || !FINISHED.has(j.status) || j.status === 'cancelled') continue;
      const text = j.status === 'done' ? `${j.name} finished.` : `${j.name} failed${j.reason ? `: ${j.reason}` : j.exitCode != null ? ` (exit ${j.exitCode})` : ''}.`;
      toast(text, j.status === 'done' ? 'ok' : 'bad', 10_000);
      if (saved.get(NOTIFY_KEY) === '1' && canNotify() && Notification.permission === 'granted') {
        try { new Notification('ollabatch', { body: text, tag: j.id }); } catch { /* some browsers only notify from a service worker */ }
      }
      loadHistory().catch(() => {});
    }
  }
  seen = now;
}
function renderNotify() {
  const on = saved.get(NOTIFY_KEY) === '1' && canNotify() && Notification.permission === 'granted';
  $('notifyToggle').textContent = on ? 'Notifications on' : 'Notify me';
  $('notifyToggle').setAttribute('aria-pressed', String(on));
}
async function toggleNotify() {
  if (!canNotify()) {
    toast(`Browser notifications only work on the host's own page (http://127.0.0.1:${S.info?.port || 11500}). Here you still get alerts on the page.`);
    return;
  }
  if (saved.get(NOTIFY_KEY) === '1') { saved.set(NOTIFY_KEY, '0'); renderNotify(); return; }
  const p = await Notification.requestPermission();
  saved.set(NOTIFY_KEY, p === 'granted' ? '1' : '0');
  if (p !== 'granted') toast('The browser said no. Alerts still show on this page.');
  renderNotify();
}

// ── join ────────────────────────────────────────────────────────────────────
let OS = /Windows/.test(navigator.userAgent) ? 'win' : 'unix';
function renderJoin() {
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const url = local && S.info?.urls?.[0] ? S.info.urls[0] : location.origin;
  // The password rides after '#', so it never leaves the computer that clicks.
  $('lendLink').href = `http://127.0.0.1:11510/#join=${encodeURIComponent(url)}&pw=${encodeURIComponent(S.token)}`;
  const t = $('trustedPc').checked ? '?trusted=1' : '';
  $('installCmd').textContent = OS === 'win' ? `irm "${url}/install.ps1${t}" | iex` : `curl -fsSL "${url}/install.sh${t}" | sh`;
  document.querySelectorAll('[data-os]').forEach((x) => x.classList.toggle('on', x.dataset.os === OS));
  $('joinCmd').textContent = `ollabatch join ${url} --password ${S.token}`;
}
async function copy(text) {
  if (navigator.clipboard && window.isSecureContext) { try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back */ } }
  // Plain-http LAN pages have no async clipboard; the old path still works there.
  const ta = Object.assign(document.createElement('textarea'), { value: text });
  ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch { /* blocked */ }
  ta.remove();
  return ok;
}

// ── wiring ──────────────────────────────────────────────────────────────────
async function tick() {
  try {
    S.status = await call('GET', '/ob/status');
    showGate(false);
    S.loadsLastHour = I.now?.loadsLastHour;
    S.loadedModels = I.now?.loadedModels;
    renderSummary(S.status); renderJobs(S.status); renderMachines(); renderAddForm(S.status);
    fillTemplates(S.status.templates);
    announce(S.status);
  } catch (e) {
    if (e.message !== 'locked') $('summary').textContent = `Can't reach the host (${e.message}). Retrying.`;
  }
}
const slow = async () => {
  await Promise.all([renderInsights().catch(() => {}), loadSparks().catch(() => {})]);
  renderThrash();
  if (M.cardOpen) renderCardDetail().catch(() => {});
};

async function unlock() {
  try {
    S.info = await call('GET', '/pool/info');
    saved.set('ollabatch-token', S.token);
    renderJoin(); renderNotify();
    await tick();
    await Promise.all([loadSettings().catch(() => {}), loadHistory().catch(() => {})]);
    slow().then(() => { if (S.status) renderMachines(); });
  } catch { /* the gate is showing */ }
}

$('trustedPc').addEventListener('change', renderJoin);
initHistory();
initInsights(() => renderInsights().catch((e) => toast(e.message, 'bad')));
initMachines(tick);

document.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.act) {
    if (b.dataset.act === 'cancel' && !confirm('Cancel this job? Its process is stopped.')) return;
    await busy(b, async () => {
      const r = await call('POST', `/ob/jobs/${b.dataset.id}/${b.dataset.act}`, b.dataset.act === 'move' ? { index: Number(b.dataset.index) } : {});
      if (b.dataset.act === 'rerun') toast(`Queued again as ${r.name}.`, 'ok');
      await tick();
    });
  } else if (b.id === 'addToggle') {
    const f = $('addForm'); f.hidden = !f.hidden; b.setAttribute('aria-expanded', String(!f.hidden));
  } else if (b.dataset.copy) {
    b.textContent = (await copy($(b.dataset.copy).textContent)) ? 'Copied' : 'Select and copy';
    setTimeout(() => { b.textContent = 'Copy'; }, 1600);
  } else if (b.dataset.os) {
    OS = b.dataset.os; renderJoin();
  } else if (b.id === 'notifyToggle') {
    toggleNotify();
  }
});

document.addEventListener('submit', async (e) => {
  const f = e.target;
  if (f.id === 'gateForm') {
    e.preventDefault();
    S.token = $('gateInput').value.trim();
    await unlock();
    if (!$('gate').hidden) showGate(true, true);
  } else if (f.id === 'addForm') {
    e.preventDefault();
    const params = {};
    for (const el of f.querySelectorAll('select[name^="p:"]')) params[el.name.slice(2)] = el.value;
    await busy(f.querySelector('button'), async () => {
      await call('POST', '/ob/jobs', { template: f.template.value, params });
      f.hidden = true; $('addToggle').setAttribute('aria-expanded', 'false');
      await tick();
    });
  }
});

// Deep links: #job=<id> opens that job's details.
const deep = new URLSearchParams(location.hash.slice(1)).get('job');

if (S.token) unlock().then(() => { if (deep) openJob(deep).catch(() => {}); }); else showGate(true);
setInterval(() => { if (!$('app').hidden) tick(); }, 2000);
setInterval(() => { if (!$('app').hidden) slow(); }, 30_000);
