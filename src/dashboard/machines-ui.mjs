// Machines: one shelf per machine, one bay per card, live sparklines, and —
// for PCs whose owner lets the pool manage them — their settings and controls.
import { $, S, call, patch, toast, busy, tone } from './core.mjs';
import { esc, rate, hardwareMeta, ownerHolds, ownerText, idleBayHtml, playgroundLine, pendingFields, PENDING_TEXT, commandText, thrashing, THRASH_TEXT, whenText } from './view.mjs';
import { sparkSvg, chartSvg, fold } from './charts.mjs';

export const M = { editing: null, spark: {}, cardOpen: null, cardRange: '1h' };
const POLICY_TEXT = { 'when-free': 'when the GPU is free', always: 'always', schedule: 'on a schedule', never: 'never' };
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const pendTag = (pend, name) => (pend[name] ? `<span class="pend ${pend[name]}">${esc(PENDING_TEXT[pend[name]])}</span>` : '');

// ── sparklines ──────────────────────────────────────────────────────────────
const key = (machine, hw, c) => c?.id || hw?.workerId || `${machine}-${hw.id}`;
function sparks(id) {
  const s = M.spark[id];
  if (!s?.some(Boolean)) return '';
  const last = (f) => [...s].reverse().find((v) => v && f(v) != null);
  const pick = (f) => s.map((v) => (v ? f(v) : null));
  const vramPct = (v) => (v.vramMB && v.vramUsedMB != null ? (100 * v.vramUsedMB) / v.vramMB : null);
  const items = [
    ['temp', pick((v) => v.tempC), null, (v) => `${v.tempC}°C`, (v) => v.tempC],
    ['memory', pick(vramPct), 100, (v) => `${Math.round(vramPct(v))}%`, vramPct],
    ['use', pick((v) => v.util), 100, (v) => `${Math.round(v.util)}%`, (v) => v.util],
  ];
  return `<button class="sparks" data-card-detail="${esc(id)}" title="Open this card's graphs">${items.map(([label, vals, max, text, f]) => {
    const l = last(f);
    return `<span class="spark"><svg viewBox="0 0 110 26" aria-hidden="true">${sparkSvg(vals, { max, color: tone('--focus') })}</svg><small>${label} ${l ? esc(text(l)) : 'unknown'}</small></span>`;
  }).join('')}</button>`;
}

export async function loadSparks() {
  const ids = new Set();
  for (const m of S.status?.machines || []) {
    for (const c of m.cards) if (c.active) ids.add(c.id);
    for (const hw of m.report?.cards || []) ids.add(hw.workerId || `${m.machine}-${hw.id}`);
  }
  await Promise.all([...ids].map(async (id) => {
    try { M.spark[id] = (await call('GET', `/ob/insights/cards/${encodeURIComponent(id)}?range=1h`)).samples; } catch { /* keep the last */ }
  }));
}

// ── bays ────────────────────────────────────────────────────────────────────
function cardControls(m, hw, pend) {
  if (!m.report?.remote || !hw) return '';
  const id = hw.id;
  return `<div class="acts remote">
    <label class="inline">At once <select data-mset="cards.${esc(id)}.slots" aria-label="Requests at once on ${esc(hw.name)}">
      ${['auto', 1, 2, 3, 4, 5, 6, 7, 8].map((n) => `<option value="${n}" ${String(hw.fixedSlots ?? 'auto') === String(n) ? 'selected' : ''}>${n === 'auto' ? 'auto' : n}</option>`).join('')}
    </select></label>${pendTag(pend, `cards.${id}.slots`)}
    <button data-mset="cards.${esc(id)}.disabled" data-value="${hw.disabled ? 'false' : 'true'}">${hw.disabled ? 'Turn lending on' : 'Turn lending off'}</button>${pendTag(pend, `cards.${id}.disabled`)}
    ${hw.paused ? `<button data-mset="cards.${esc(id)}.paused" data-value="false">Resume on its PC</button>${pendTag(pend, `cards.${id}.paused`)}` : ''}
    ${hw.slots ? `<button data-mcmd="restart-card" data-card="${esc(id)}" title="Stop and start this card's Ollama server">Restart server</button>` : ''}
    ${hw.slots && (hw.fixedSlots ?? 'auto') === 'auto' ? `<button data-mcmd="retune" data-card="${esc(id)}" title="Forget the measured setting and measure again from 1">Re-tune</button>` : ''}
  </div>`;
}

function bay(c, m, pend, thrash) {
  const jobs = S.status.jobs;
  const hw = m.report?.cards?.find((x) => x.workerId === c.id);
  const held = ownerHolds(c.owner);
  const state = !c.active ? 'gone' : c.paused ? 'paused' : c.inflight ? 'working' : 'idle';
  const leds = Array.from({ length: c.slots }, (_, i) => `<i class="${i < c.inflight ? 'on' : ''}"></i>`).join('');
  const job = c.jobId && c.jobId !== '_' ? jobs.find((j) => j.id === c.jobId) : null;
  const chips = Object.entries(c.labels).filter(([k]) => k !== 'machine' && !k.startsWith('model:'))
    .map(([k, v]) => `<span class="chip ${k in c.userLabels ? 'user' : ''}">${esc(k)}=${esc(v)}</span>`).join('');
  const loaded = hw ? hw.loadedModels || [] : S.loadedModels?.[c.id] ? [S.loadedModels[c.id]] : [];
  const meta = [
    state,
    c.active && !c.paused ? `${rate(c.perSec * 60)}/min` : '',
    c.avgMs ? `${(c.avgMs / 1000).toFixed(1)} s per item` : '',
    job && state === 'working' ? `on ${job.name}` : '',
    `${c.done.toLocaleString('en-US')} done`,
  ].filter(Boolean);
  const edit = M.editing === c.id
    ? `<form class="labelEdit" data-card="${esc(c.id)}"><input name="labels" value="${esc(Object.entries(c.userLabels).map(([k, v]) => `${k}=${v}`).join(', '))}" placeholder="owner=sam, vision=1" aria-label="Labels for ${esc(c.label)}"><button class="primary" type="submit">Save</button><button type="button" data-cancel-edit>Cancel</button></form>`
    : '';
  // A card held on its PC can be resumed from here only if the pool manages that PC (then via the settings button).
  const pauseBtn = held ? '' : `<button data-pause="${esc(c.id)}" data-to="${c.paused ? '0' : '1'}">${c.paused ? 'Resume card' : 'Pause card'}</button>`;
  return `<div class="bay ${state}">
    <div class="top1"><span class="label">${esc(c.label || c.id)}</span><span class="leds" title="${c.inflight} of ${c.slots} slots busy">${leds}</span></div>
    <div class="meta">${meta.map((x) => `<span>${esc(x)}</span>`).join('')}</div>
    ${hw ? `<div class="meta">${hardwareMeta(hw).map((x) => `<span>${esc(x)}</span>`).join('')}</div>` : ''}
    ${loaded.length ? `<div class="meta"><span>in memory: ${esc(loaded.join(', '))}</span></div>` : ''}
    ${sparks(key(m.machine, hw, c))}
    ${held ? `<div class="note">${esc(ownerText(c.owner))}</div>` : ''}
    ${thrash ? `<div class="warn small">${esc(THRASH_TEXT)}</div>` : ''}
    <div class="chips">${c.models.map((x) => `<span class="chip">${esc(x)}</span>`).join('')}${chips}</div>
    ${c.lastError ? `<div class="err">Last error: ${esc(c.lastError)}</div>` : ''}
    ${edit}
    ${c.active ? `<div class="acts">${pauseBtn}<button data-edit="${esc(c.id)}">Edit labels</button></div>` : ''}
    ${cardControls(m, hw, pend)}
  </div>`;
}

function idleBay(hw, m, pend) {
  const extra = `${sparks(key(m.machine, hw))}${cardControls(m, hw, pend)}</div>`;
  return idleBayHtml(hw).replace(/<\/div>\s*$/, () => extra);   // a function: `$&` in a card name stays text
}

// ── the machine's own panel (settings, models, commands) ────────────────────
function panel(m, pend) {
  const r = m.report;
  if (!r) return '<p class="note shelf-note">This machine joined without the ollabatch agent, so only its cards show here.</p>';
  if (!r.remote) return `<p class="note shelf-note">Managed by its owner: lends ${esc(POLICY_TEXT[r.policy] || r.policy)}. To manage it from here, tick “Let the pool manage this PC” on that PC's ollabatch page (http://127.0.0.1:11510).</p>`;
  const w = r.schedule?.[0] || { days: [0, 1, 2, 3, 4, 5, 6], from: '23:00', to: '07:00' };
  const models = r.playground?.models || [];
  const cardName = (id) => r.cards.find((c) => c.id === id)?.name || id;
  const cmds = (m.commands || []).slice(0, 5);
  return `<details class="mpanel" data-machine="${esc(m.machine)}"><summary>Manage ${esc(m.machine)}${Object.keys(pend).length ? ` <span class="pend pending">${Object.keys(pend).length} change${Object.keys(pend).length === 1 ? '' : 's'} on the way</span>` : ''}</summary>
    <form class="msettings grid2" data-machine="${esc(m.machine)}">
      <label>Lend <select name="policy">${Object.entries(POLICY_TEXT).map(([v, t]) => `<option value="${v}" ${r.policy === v ? 'selected' : ''}>${t}</option>`).join('')}</select>${pendTag(pend, 'policy')}</label>
      <label>From <input type="time" name="from" value="${esc(w.from)}"></label>
      <label>To <input type="time" name="to" value="${esc(w.to)}">${pendTag(pend, 'schedule')}</label>
      <div class="days">${DAY.map((d, i) => `<label><input type="checkbox" name="day" value="${i}" ${w.days.includes(i) ? 'checked' : ''}> ${d}</label>`).join('')}</div>
      <label>Model space (GB) <input type="number" name="limitGB" min="1" value="${esc(r.playground?.limitGB ?? 50)}">${pendTag(pend, 'playground.limitGB')}</label>
      <label>Downloads <select name="downloads"><option value="1" ${r.playground?.downloads ? 'selected' : ''}>allowed</option><option value="0" ${r.playground?.downloads ? '' : 'selected'}>not allowed</option></select>${pendTag(pend, 'playground.downloads')}</label>
      <div><button class="primary" type="submit">Save for this PC</button></div>
    </form>
    <h4>Models on this PC ${pendTag(pend, 'locked')}</h4>
    <table class="mmodels"><tbody>${models.length ? models.map((x) => `<tr><td>${esc(x.name)}</td><td class="n">${x.linked ? 'its own copy' : `${(x.size / 1024 ** 3).toFixed(1)} GB`}</td>
      <td class="n"><button data-mlock="${esc(x.name)}" data-on="${x.locked ? '0' : '1'}">${x.locked ? 'Unlock' : 'Lock'}</button>${x.locked ? '' : ` <button data-mcmd="remove-model" data-model="${esc(x.name)}">Remove</button>`}</td></tr>`).join('')
      : '<tr><td class="note">No models in its playground yet.</td></tr>'}</tbody></table>
    <form class="mpull row" data-machine="${esc(m.machine)}"><input name="model" placeholder="Download a model, e.g. qwen3:8b" aria-label="Model to download on ${esc(m.machine)}"><button type="submit">Download</button></form>
    ${Object.keys(r.downloadFailures || {}).length ? `<h4>Downloads that failed</h4><ul class="cmds">${Object.entries(r.downloadFailures).map(([model, f]) =>
      `<li class="failed">${esc(model)}: ${esc(f.error || 'failed')} (${esc(f.count)} tr${f.count === 1 ? 'y' : 'ies'}; next try ${esc(whenText(f.until, f.until + 1))})</li>`).join('')}</ul>` : ''}
    ${cmds.length ? `<h4>Recent requests to this PC</h4><ul class="cmds">${cmds.map((c) => `<li class="${esc(c.state)}">${esc(commandText(c, cardName))}</li>`).join('')}</ul>` : ''}
  </details>`;
}

export function renderMachines() {
  const s = S.status;
  if (!s.machines.length) {
    patch($('machines'), [{ key: 'empty', html: '<p class="empty">No machines yet. Use “Add a machine” below on any computer with Ollama.</p>' }]);
    return;
  }
  const thrash = new Set(thrashing(S.switchesLastHour));
  patch($('machines'), s.machines.map((m) => {
    const on = m.cards.filter((c) => c.active).length;
    const lentIds = new Set(m.cards.map((c) => c.id));
    const idle = (m.report?.cards || []).filter((r) => !r.workerId || !lentIds.has(r.workerId));
    const total = m.cards.length + idle.length;
    const pg = playgroundLine(m.report);
    const pend = pendingFields(m);
    const badge = m.report ? (m.report.remote ? '<span class="badge on">managed by the pool</span>' : '<span class="badge">managed by its owner</span>') : '';
    return { key: m.machine, html: `<div class="shelf"><h3>${esc(m.machine)}<span>${badge} ${on} of ${total} card${total === 1 ? '' : 's'} lending</span></h3>
      ${pg ? `<p class="note shelf-note">${esc(pg)}</p>` : ''}
      ${m.cards.map((c) => bay(c, m, pend, thrash.has(c.id))).join('')}${idle.map((hw) => idleBay(hw, m, pend)).join('')}
      ${panel(m, pend)}</div>` };
  }));
  // A redraw must not close a panel you opened.
  for (const d of document.querySelectorAll('.mpanel')) if (M.open?.has(d.dataset.machine)) d.open = true;
}

// ── card detail ─────────────────────────────────────────────────────────────
export async function renderCardDetail() {
  const id = M.cardOpen;
  if (!id) return;
  const samples = (await call('GET', `/ob/insights/cards/${encodeURIComponent(id)}?range=${M.cardRange}`)).samples;
  const RANGES = { '1h': 60_000, '6h': 60_000, '24h': 60_000, '7d': 3_600_000, '30d': 3_600_000 };
  const step0 = RANGES[M.cardRange], k = Math.max(1, Math.ceil(samples.length / 180));
  const t0 = Math.floor(Date.now() / step0) * step0 - (samples.length - 1) * step0;
  const pick = (f) => fold(samples.map((v) => (v ? f(v) : null)), 180, 'mean');
  const name = S.status.workers.find((w) => w.id === id)?.label
    || S.status.machines.flatMap((m) => (m.report?.cards || []).map((c) => [`${m.machine}-${c.id}`, c.name])).find(([x]) => x === id)?.[1] || id;
  const fig = (title, unit, series, max = null) => `<figure><figcaption>${esc(title)}</figcaption><svg class="chart small" viewBox="0 0 640 120">${chartSvg({ w: 640, h: 120, kind: 'line', unit, max, t0, step: step0 * k, series })}</svg></figure>`;
  const c = tone('--focus');
  $('cardBody').innerHTML = `<div class="head"><h2>${esc(name)}</h2>
      <div class="seg" id="cardRange">${['1h', '6h', '24h', '7d', '30d'].map((r) => `<button data-crange="${r}" class="${r === M.cardRange ? 'on' : ''}">${r}</button>`).join('')}</div>
      <button data-close-card>Close</button></div>
    ${samples.some(Boolean) ? [
    fig('Temperature', '°C', [{ label: 'temperature', color: tone('--bad'), values: pick((v) => v.tempC) }]),
    fig('Memory used', ' GB', [{ label: 'used', color: c, values: pick((v) => (v.vramUsedMB == null ? null : v.vramUsedMB / 1024)) }], (samples.find((v) => v?.vramMB)?.vramMB || 0) / 1024 || null),
    fig('GPU use', '%', [{ label: 'use', color: c, values: pick((v) => v.util) }], 100),
    fig('Power', ' W', [{ label: 'power', color: tone('--amber'), values: pick((v) => v.powerW) }]),
    fig('Slots', '', [{ label: 'slots', color: tone('--mute'), values: pick((v) => v.slots), dash: true }, { label: 'busy', color: tone('--ok'), values: pick((v) => v.slotsBusy) }]),
  ].join('') : '<p class="note">No reports from this card\'s machine in this range. Cards joined with the ollabatch agent report their hardware every 10 seconds.</p>'}
    <p class="note">Gaps are times its driver didn't say; they're never drawn as zero.</p>`;
}

// ── actions ─────────────────────────────────────────────────────────────────
const machineOf = (el) => el.closest('.shelf')?.dataset.key;

async function setRemote(machine, fields) {
  await call('PUT', `/ob/machines/${encodeURIComponent(machine)}/settings`, fields);
  toast(`Sent to ${machine}. It takes effect on its next check, within about 10 seconds.`);
}
async function command(machine, body) {
  await call('POST', `/ob/machines/${encodeURIComponent(machine)}/commands`, body);
  toast(`Asked ${machine} to ${body.type.replace('-card', '').replace('-model', '').replace('retune', 're-tune').replace('pull', 'download')}${body.model ? ` ${body.model}` : ''}.`);
}

export function initMachines(refresh) {
  M.open = new Set();
  document.addEventListener('toggle', (e) => {
    if (!e.target.matches?.('.mpanel')) return;
    if (e.target.open) M.open.add(e.target.dataset.machine); else M.open.delete(e.target.dataset.machine);
  }, true);

  document.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !$('machines').contains(b) && !$('cardDialog').contains(b)) return;
    const machine = machineOf(b);
    if (b.dataset.pause) {
      busy(b, async () => { await call('POST', '/pool/pause', { id: b.dataset.pause, paused: b.dataset.to === '1' }); await refresh(); });
    } else if (b.dataset.edit) {
      M.editing = b.dataset.edit; renderMachines();
      document.querySelector('.labelEdit input')?.focus();
    } else if (b.dataset.cancelEdit !== undefined) {
      M.editing = null; renderMachines();
    } else if (b.dataset.mset && b.tagName === 'BUTTON') {
      busy(b, async () => { await setRemote(machine, { [b.dataset.mset]: b.dataset.value === 'true' }); await refresh(); });
    } else if (b.dataset.mcmd) {
      if (b.dataset.mcmd === 'remove-model' && !confirm(`Remove ${b.dataset.model} from ${machine}?`)) return;
      busy(b, async () => { await command(machine, { type: b.dataset.mcmd, card: b.dataset.card, model: b.dataset.model }); await refresh(); });
    } else if (b.dataset.mlock) {
      const m = S.status.machines.find((x) => x.machine === machine);
      const locked = new Set((m.report.playground.models || []).filter((x) => x.locked).map((x) => x.name));
      if (b.dataset.on === '1') locked.add(b.dataset.mlock); else locked.delete(b.dataset.mlock);
      busy(b, async () => { await setRemote(machine, { locked: [...locked] }); await refresh(); });
    } else if (b.dataset.cardDetail) {
      M.cardOpen = b.dataset.cardDetail;
      $('cardBody').innerHTML = '<p class="note">Loading…</p>';
      $('cardDialog').showModal();
      renderCardDetail().catch((err) => toast(err.message, 'bad'));
    } else if (b.dataset.crange) {
      M.cardRange = b.dataset.crange; renderCardDetail().catch(() => {});
    } else if (b.dataset.closeCard !== undefined) {
      $('cardDialog').close();
    }
  });
  $('cardDialog').addEventListener('close', () => { M.cardOpen = null; });

  document.addEventListener('change', (e) => {
    const el = e.target;
    if (el.tagName !== 'SELECT' || !el.dataset.mset) return;
    busy(el, async () => { await setRemote(machineOf(el), { [el.dataset.mset]: el.value === 'auto' ? 'auto' : Number(el.value) }); el.blur(); await refresh(); });
  });

  document.addEventListener('submit', (e) => {
    const f = e.target;
    if (f.classList.contains('labelEdit')) {
      e.preventDefault();
      busy(f.querySelector('button'), async () => {
        const labels = {};
        for (const part of f.labels.value.split(',').map((x) => x.trim()).filter(Boolean)) {
          const i = part.indexOf('=');
          if (i < 1) throw new Error(`"${part}" should look like key=value`);
          labels[part.slice(0, i).trim()] = part.slice(i + 1).trim();
        }
        await call('POST', '/ob/cards/labels', { card: f.dataset.card, labels });
        M.editing = null;
        await refresh();
      });
    } else if (f.classList.contains('msettings')) {
      e.preventDefault();
      const m = S.status.machines.find((x) => x.machine === f.dataset.machine);
      const r = m.report;
      const days = [...f.querySelectorAll('input[name="day"]:checked')].map((x) => Number(x.value));
      const want = { policy: f.policy.value, 'playground.limitGB': Number(f.limitGB.value), 'playground.downloads': f.downloads.value === '1' };
      const schedule = [{ days, from: f.from.value, to: f.to.value }];
      if (JSON.stringify(schedule) !== JSON.stringify(r.schedule || [])) want.schedule = schedule;
      // Send only what changed, so an older value never overwrites a newer change made on the PC.
      const changed = Object.fromEntries(Object.entries(want).filter(([k, v]) => k === 'schedule'
        || v !== (k === 'policy' ? r.policy : k === 'playground.limitGB' ? r.playground?.limitGB : r.playground?.downloads)));
      if (!Object.keys(changed).length) { toast('Nothing changed.'); return; }
      busy(f.querySelector('button[type=submit]'), async () => { await setRemote(f.dataset.machine, changed); f.querySelector('button[type=submit]').blur(); await refresh(); });
    } else if (f.classList.contains('mpull')) {
      e.preventDefault();
      const model = f.model.value.trim();
      if (!model) return;
      busy(f.querySelector('button'), async () => { await command(f.dataset.machine, { type: 'pull', model }); f.model.value = ''; await refresh(); });
    }
  });
}

