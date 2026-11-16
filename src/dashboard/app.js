// ollabatch dashboard: polls /ob/status every 2 s and /ob/metrics every 30 s.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const store = {
  get: () => { try { return localStorage.getItem('ollabatch-token') || ''; } catch { return ''; } },
  set: (v) => { try { localStorage.setItem('ollabatch-token', v); } catch { /* private mode */ } },
};
let TOKEN = document.body.dataset.token || store.get();
let STATUS = null, INFO = null, RANGE = 60, editing = null;

async function call(method, path, body) {
  const r = await fetch(path, {
    method, headers: { 'Content-Type': 'application/json', 'x-pool-token': TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (r.status === 401) { showGate(true); throw new Error('locked'); }
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { /* text */ }
  if (!r.ok) throw new Error(json?.error || `HTTP ${r.status}`);
  return json ?? text;
}

function dur(sec) {
  if (sec == null || !isFinite(sec)) return '';
  if (sec < 60) return 'under a minute';
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}
const rate = (r) => (r >= 10 ? r.toFixed(0) : r >= 1 ? r.toFixed(1) : r.toFixed(2));

// Redraw only the rows whose HTML changed, so a poll every 2 s doesn't steal
// keyboard focus or a pending click from rows that stayed the same.
function patch(container, items) {
  const old = new Map([...container.children].map((el) => [el.dataset.key, el]));
  let prev = null;
  for (const { key, html } of items) {
    let el = old.get(key);
    if (!el || el.dataset.html !== html) {
      const tpl = document.createElement('template');
      tpl.innerHTML = html.trim();
      const fresh = tpl.content.firstElementChild;
      fresh.dataset.key = key;
      fresh.dataset.html = html;
      if (el) el.replaceWith(fresh);
      el = fresh;
    }
    old.delete(key);
    const want = prev ? prev.nextElementSibling : container.firstElementChild;
    if (want !== el) container.insertBefore(el, want);
    prev = el;
  }
  for (const el of old.values()) el.remove();
}

function showGate(on, failed = false) {
  $('gate').hidden = !on;
  $('app').hidden = on;
  $('gateError').hidden = !failed;
  if (on) $('summary').textContent = 'Locked';
}

// ── summary + stats ──────────────────────────────────────────────────────────
function renderSummary(s) {
  const online = s.workers.filter((w) => w.active && !w.paused).length;
  const running = s.jobs.filter((j) => j.status === 'running');
  const q = s.queueEta;
  const left = q.seconds ? `queue done in about ${dur(q.seconds)}` : running.length ? 'working out the time left' : 'nothing queued';
  const unknown = q.unknown ? `, plus ${q.unknown} job${q.unknown > 1 ? 's' : ''} without an estimate` : '';
  $('summary').textContent = `${online} card${online === 1 ? '' : 's'} working, ${left}${unknown}.`;
  const machines = s.machines.filter((m) => m.cards.some((c) => c.active)).length;
  $('stats').innerHTML = [
    [rate(s.perSec * 60), 'items per minute'],
    [running.length, running.length === 1 ? 'job running' : 'jobs running'],
    [s.jobs.filter((j) => j.status === 'queued').length, 'queued'],
    [`${online}/${s.workers.length}`, `cards on ${machines} machine${machines === 1 ? '' : 's'}`],
  ].map(([v, l]) => `<div class="stat"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join('');
}

// ── queue ────────────────────────────────────────────────────────────────────
function jobRow(j, i, list) {
  const p = j.progress;
  const pct = p.total ? Math.min(100, (100 * p.done) / p.total) : 0;
  const waiting = j.reason === 'waiting for cards';
  const stateText = waiting ? 'waiting for cards' : j.reason && j.status === 'failed' ? `failed: ${j.reason}` : j.status === 'failed' ? `failed (exit ${j.exitCode})` : j.status;
  const meta = [
    p.total ? `${p.done.toLocaleString()} of ${p.total.toLocaleString()}` : p.done ? `${p.done.toLocaleString()} done` : '',
    p.rate ? `${rate(p.rate)}/s` : '',
    j.eta != null && j.status === 'running' ? `${dur(j.eta)} left` : '',
    j.model || (j.models.length ? j.models.join(' or ') : ''),
    j.selector ? `needs ${j.selector}` : '',
  ].filter(Boolean);
  const queuedIdx = list.filter((x) => x.status === 'queued');
  const qi = queuedIdx.indexOf(j);
  const acts = [];
  if (j.status === 'queued') {
    acts.push(`<button data-act="move" data-id="${j.id}" data-index="${i - 1}" ${qi <= 0 ? 'disabled' : ''} aria-label="Move ${esc(j.name)} up">Up</button>`);
    acts.push(`<button data-act="move" data-id="${j.id}" data-index="${i + 1}" ${qi === queuedIdx.length - 1 ? 'disabled' : ''} aria-label="Move ${esc(j.name)} down">Down</button>`);
  }
  if (j.status === 'running') acts.push(`<button data-act="pause" data-id="${j.id}">Pause</button>`);
  if (j.status === 'paused') acts.push(`<button data-act="resume" data-id="${j.id}">Resume</button>`);
  if (['queued', 'running', 'paused'].includes(j.status)) acts.push(`<button data-act="cancel" data-id="${j.id}">Cancel</button>`);
  if (['done', 'failed', 'cancelled'].includes(j.status)) acts.push(`<button data-act="rerun" data-id="${j.id}">Run again</button>`);
  if (j.startedAt) acts.push(`<button data-log="${j.id}" data-name="${esc(j.name)}">Log</button>`);
  return `<li class="job ${esc(j.status)}">
    <div class="line1"><span class="name">${esc(j.name)}</span><span class="state ${waiting ? 'wait' : esc(j.status)}">${esc(stateText)}</span></div>
    ${j.status === 'running' || j.status === 'paused' ? `<div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div>` : ''}
    ${meta.length ? `<div class="meta">${meta.map((m) => `<span>${esc(m)}</span>`).join('')}</div>` : ''}
    <div class="acts">${acts.join('')}</div>
  </li>`;
}

function renderJobs(s) {
  // Active and queued first, then the most recent finished ones.
  const live = s.jobs.filter((j) => !['done', 'failed', 'cancelled'].includes(j.status));
  const past = s.jobs.filter((j) => ['done', 'failed', 'cancelled'].includes(j.status)).slice(-8).reverse();
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
  // "Chat calls (${count})" reads as "Chat calls (count)" until a value is picked.
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

// ── machines ─────────────────────────────────────────────────────────────────
function bay(c, jobs) {
  const state = !c.active ? 'gone' : c.paused ? 'paused' : c.inflight ? 'working' : 'idle';
  const leds = Array.from({ length: c.slots }, (_, i) => `<i class="${i < c.inflight ? 'on' : ''}"></i>`).join('');
  const job = c.jobId && c.jobId !== '_' ? jobs.find((j) => j.id === c.jobId) : null;
  const auto = new Set(['machine']);
  const chips = Object.entries(c.labels).filter(([k]) => !auto.has(k) && !k.startsWith('model:'))
    .map(([k, v]) => `<span class="chip ${k in c.userLabels ? 'user' : ''}">${esc(k)}=${esc(v)}</span>`).join('');
  const meta = [
    state,
    c.active && !c.paused ? `${rate(c.perSec * 60)}/min` : '',
    c.avgMs ? `${(c.avgMs / 1000).toFixed(1)} s per item` : '',
    job && state === 'working' ? `on ${job.name}` : '',
    `${c.done.toLocaleString()} done`,
  ].filter(Boolean);
  const edit = editing === c.id
    ? `<form class="labelEdit" data-card="${esc(c.id)}"><input name="labels" value="${esc(Object.entries(c.userLabels).map(([k, v]) => `${k}=${v}`).join(', '))}" placeholder="owner=sam, vision=1" aria-label="Labels for ${esc(c.label)}"><button class="primary" type="submit">Save</button><button type="button" data-cancel-edit>Cancel</button></form>`
    : '';
  return `<div class="bay ${state}">
    <div class="top1"><span class="label">${esc(c.label || c.id)}</span><span class="leds" title="${c.inflight} of ${c.slots} slots busy">${leds}</span></div>
    <div class="meta">${meta.map((m) => `<span>${esc(m)}</span>`).join('')}</div>
    <div class="chips">${c.models.map((m) => `<span class="chip">${esc(m)}</span>`).join('')}${chips}</div>
    ${c.lastError ? `<div class="err">Last error: ${esc(c.lastError)}</div>` : ''}
    ${edit}
    ${c.active ? `<div class="acts"><button data-pause="${esc(c.id)}" data-to="${c.paused ? '0' : '1'}">${c.paused ? 'Resume card' : 'Pause card'}</button><button data-edit="${esc(c.id)}">Edit labels</button></div>` : ''}
  </div>`;
}

function renderMachines(s) {
  if (editing) return; // don't redraw under someone typing
  if (!s.machines.length) {
    patch($('machines'), [{ key: 'empty', html: '<p class="empty">No machines yet. Use the join command below on any computer with Ollama.</p>' }]);
    return;
  }
  patch($('machines'), s.machines.map((m) => {
    const on = m.cards.filter((c) => c.active).length;
    return { key: m.machine, html: `<div class="shelf"><h3>${esc(m.machine)}<span>${on} of ${m.cards.length} card${m.cards.length === 1 ? '' : 's'} online</span></h3>${m.cards.map((c) => bay(c, s.jobs)).join('')}</div>` };
  }));
}

// ── graphs ───────────────────────────────────────────────────────────────────
const COLORS = getComputedStyle(document.documentElement).getPropertyValue('--series').split(',').map((s) => s.trim());

function chart(svg, rows, { stacked, unit }) {
  const W = svg.clientWidth || 600, H = svg.clientHeight || 200, pad = { l: 36, r: 8, t: 8, b: 18 };
  const ids = Object.keys(rows);
  const n = ids.length ? rows[ids[0]].length : RANGE;
  const sums = Array.from({ length: n }, (_, i) => ids.reduce((s, id) => s + rows[id][i], 0));
  const max = Math.max(1e-9, ...(stacked ? sums : ids.flatMap((id) => rows[id])));
  const x = (i) => pad.l + (i / Math.max(1, n - 1)) * (W - pad.l - pad.r);
  const y = (v) => H - pad.b - (v / max) * (H - pad.t - pad.b);
  let out = `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(0)}" y2="${y(0)}"/><line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(max)}" y2="${y(max)}"/>`;
  out += `<text x="4" y="${y(max) + 4}">${esc(rate(max))}${unit}</text><text x="4" y="${y(0)}">0</text>`;
  out += `<text x="${pad.l}" y="${H - 3}">${RANGE >= 1440 ? '24 h ago' : RANGE >= 360 ? '6 h ago' : '1 h ago'}</text><text x="${W - pad.r}" y="${H - 3}" text-anchor="end">now</text>`;
  const base = Array(n).fill(0);
  ids.forEach((id, k) => {
    const color = COLORS[k % COLORS.length];
    const top = rows[id].map((v, i) => (stacked ? base[i] + v : v));
    const line = top.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    if (stacked) {
      const floor = base.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).reverse().join(' ');
      out += `<polygon points="${line} ${floor}" fill="${color}" fill-opacity=".55" stroke="${color}" stroke-width="1"/>`;
      top.forEach((v, i) => { base[i] = v; });
    } else {
      out += `<polyline points="${line}" fill="none" stroke="${color}" stroke-width="1.6"/>`;
    }
  });
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = out;
}

async function renderGraphs() {
  const m = await call('GET', `/ob/metrics?by=card&minutes=${RANGE}`);
  // Long ranges: 5-minute buckets keep the shape readable.
  const step = RANGE > 60 ? 5 : 1;
  const fold = (arr, mean) => {
    const out = [];
    for (let i = 0; i < arr.length; i += step) {
      const part = arr.slice(i, i + step);
      const sum = part.reduce((s, v) => s + v, 0);
      out.push(mean ? (part.filter(Boolean).length ? sum / part.filter(Boolean).length : 0) : sum / step);
    }
    return out;
  };
  const label = (id) => STATUS?.workers.find((w) => w.id === id)?.label || id;
  const done = {}, lat = {};
  for (const [id, r] of Object.entries(m.rows)) { done[id] = fold(r.done); lat[id] = fold(r.avgMs, true).map((v) => v / 1000); }
  chart($('rateChart'), done, { stacked: true, unit: '/min' });
  chart($('latChart'), lat, { stacked: false, unit: ' s' });
  $('rateLegend').innerHTML = Object.keys(done).map((id, k) => `<span><i style="background:${COLORS[k % COLORS.length]}"></i>${esc(label(id))}</span>`).join('') || 'No work recorded in this range yet.';
}

// ── join ─────────────────────────────────────────────────────────────────────
function renderJoin() {
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const url = local && INFO?.urls?.[0] ? INFO.urls[0] : location.origin;
  $('joinCmd').textContent = `ollabatch join ${url} --password ${TOKEN}`;
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

// ── wiring ───────────────────────────────────────────────────────────────────
async function tick() {
  try {
    STATUS = await call('GET', '/ob/status');
    showGate(false);
    renderSummary(STATUS); renderJobs(STATUS); renderMachines(STATUS); renderAddForm(STATUS);
  } catch (e) {
    if (e.message !== 'locked') $('summary').textContent = `Can't reach the host (${e.message}). Retrying.`;
  }
}

async function unlock() {
  try {
    INFO = await call('GET', '/pool/info');
    store.set(TOKEN);
    renderJoin();
    await tick();
    renderGraphs().catch(() => {});
  } catch { /* the gate is showing */ }
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  try {
    if (b.dataset.act) {
      b.disabled = true;
      const body = b.dataset.act === 'move' ? { index: Number(b.dataset.index) } : {};
      if (b.dataset.act === 'cancel' && !confirm('Cancel this job? Its process is stopped.')) { b.disabled = false; return; }
      await call('POST', `/ob/jobs/${b.dataset.id}/${b.dataset.act}`, body);
      await tick();
    } else if (b.dataset.pause) {
      b.disabled = true;
      await call('POST', '/pool/pause', { id: b.dataset.pause, paused: b.dataset.to === '1' });
      await tick();
    } else if (b.dataset.edit) {
      editing = b.dataset.edit; editingRender();
    } else if (b.dataset.cancelEdit !== undefined) {
      editing = null; await tick();
    } else if (b.dataset.log) {
      $('logTitle').textContent = `Log: ${b.dataset.name}`;
      $('logText').textContent = await call('GET', `/ob/jobs/${b.dataset.log}/log?tail=400`) || '(empty)';
      $('logDialog').showModal();
    } else if (b.dataset.range) {
      RANGE = Number(b.dataset.range);
      document.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b));
      await renderGraphs();
    } else if (b.id === 'addToggle') {
      const f = $('addForm'); f.hidden = !f.hidden; b.setAttribute('aria-expanded', String(!f.hidden));
    } else if (b.id === 'copyJoin') {
      b.textContent = (await copy($('joinCmd').textContent)) ? 'Copied' : 'Select and copy';
      setTimeout(() => { b.textContent = 'Copy'; }, 1600);
    } else if (b.id === 'logClose') {
      $('logDialog').close();
    }
  } catch (err) {
    if (err.message !== 'locked') alert(err.message);
    b.disabled = false;
  }
});

function editingRender() {
  const id = editing; editing = null;
  renderMachines(STATUS);
  editing = id;
  const host = [...document.querySelectorAll('[data-edit]')].find((x) => x.dataset.edit === id)?.closest('.bay');
  if (host) host.insertAdjacentHTML('beforeend', bay(STATUS.workers.find((w) => w.id === id), STATUS.jobs).match(/<form class="labelEdit"[\s\S]*?<\/form>/)[0]);
  host?.querySelector('.labelEdit input')?.focus();
}

document.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    if (f.id === 'gateForm') {
      TOKEN = $('gateInput').value.trim();
      await unlock();
      if (!$('gate').hidden) showGate(true, true);
    } else if (f.id === 'addForm') {
      const params = {};
      for (const el of f.querySelectorAll('select[name^="p:"]')) params[el.name.slice(2)] = el.value;
      await call('POST', '/ob/jobs', { template: f.template.value, params });
      f.hidden = true; $('addToggle').setAttribute('aria-expanded', 'false');
      await tick();
    } else if (f.classList.contains('labelEdit')) {
      const labels = {};
      for (const part of f.labels.value.split(',').map((s) => s.trim()).filter(Boolean)) {
        const i = part.indexOf('=');
        if (i < 1) throw new Error(`"${part}" should look like key=value`);
        labels[part.slice(0, i).trim()] = part.slice(i + 1).trim();
      }
      await call('POST', '/ob/cards/labels', { card: f.dataset.card, labels });
      editing = null;
      await tick();
    }
  } catch (err) { if (err.message !== 'locked') alert(err.message); }
});

if (TOKEN) unlock(); else showGate(true);
setInterval(() => { if (!$('app').hidden) tick(); }, 2000);
setInterval(() => { if (!$('app').hidden) renderGraphs().catch(() => {}); }, 30000);
