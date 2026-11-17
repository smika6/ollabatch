// Insights: what the pool's inference is doing over time, by card, model or job.
import { $, S, call, colorOf, cardLabel, jobName, tone } from './core.mjs';
import { esc, big, rate, thrashing, THRASH_TEXT } from './view.mjs';
import { chartSvg, markerRowsSvg, fold } from './charts.mjs';

export const I = { range: '1h', by: 'card', now: null };
const MINUTES = { '1h': 60, '6h': 360, '24h': 1440 };
const POINTS = 180;   // most points a chart draws; longer ranges are folded

const labelOf = (by, id) => (by === 'card' ? cardLabel(id) : by === 'job' ? (id === '_' ? 'jobs outside ollabatch' : id === '_summary' ? 'AI summaries' : jobName(id)) : id);

function draw(svgId, opts) {
  const svg = $(svgId);
  const w = Math.max(320, Math.round(svg.clientWidth || 600)), h = Math.round(svg.clientHeight || 180);
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.innerHTML = chartSvg({ w, h, ...opts });
}
function legend(elId, ids, by) {
  $(elId).innerHTML = ids.length
    ? ids.map((id) => `<span><i style="background:${colorOf(`${by}:${id}`)}"></i>${esc(labelOf(by, id))}</span>`).join('')
    : '<span>Nothing recorded in this range yet.</span>';
}

// Fold every series of a {t0, step, rows} answer to POINTS buckets.
function folded(r, pick, mode) {
  const ids = Object.keys(r.rows);
  const n = r.rows[ids[0]]?.length || 0;
  const k = Math.max(1, Math.ceil(n / POINTS));
  return { ids, step: r.step * k, t0: r.t0, rows: Object.fromEntries(ids.map((id) => [id, fold(r.rows[id].map(pick), POINTS, mode)])) };
}

export async function renderInsights() {
  const { range, by } = I;
  const [main, cards, models, now] = await Promise.all([
    call('GET', `/ob/insights?by=${by}&range=${range}`),
    by === 'card' ? null : call('GET', `/ob/insights?by=card&range=${range}`),
    call('GET', `/ob/insights?by=model&range=${range}`),
    call('GET', '/ob/insights/now'),
  ]);
  I.now = now;
  const byCard = cards || main;

  // Items per minute comes from the older per-card metrics (kept 24 h).
  $('itemsFig').hidden = !MINUTES[range];
  if (MINUTES[range]) {
    const m = await call('GET', `/ob/metrics?by=card&minutes=${MINUTES[range]}`);
    const ids = Object.keys(m.rows);
    const k = Math.max(1, Math.ceil(MINUTES[range] / POINTS));
    draw('rateChart', { kind: 'area', unit: '/min', t0: Date.now() - (MINUTES[range] - 1) * 60_000, step: 60_000 * k,
      series: ids.map((id) => ({ label: cardLabel(id), color: colorOf(`card:${id}`), values: fold(m.rows[id].done, POINTS, 'mean') })) });
    legend('rateLegend', ids, 'card');
  }

  const sec = (step) => step / 1000;
  const tok = folded(main, (p) => p.outputTokens, 'sum');
  draw('tokChart', { kind: 'area', unit: '/s', t0: tok.t0, step: tok.step,
    series: tok.ids.map((id) => ({ label: labelOf(by, id), color: colorOf(`${by}:${id}`), values: tok.rows[id].map((v) => (v == null ? 0 : v / sec(tok.step))) })) });
  legend('tokLegend', tok.ids, by);

  const sum = (r, pick) => {
    const f = folded(r, pick, 'sum');
    return { ...f, total: Array.from({ length: f.rows[f.ids[0]]?.length || 0 }, (_, i) => f.ids.reduce((s, id) => s + (f.rows[id][i] || 0), 0)) };
  };
  const pIn = sum(main, (p) => p.promptTokens), pOut = sum(main, (p) => p.outputTokens);
  draw('ioChart', { kind: 'bars', stacked: false, t0: pIn.t0, step: pIn.step, series: [
    { label: 'prompt tokens (read)', color: tone('--focus'), values: pIn.total }, { label: 'output tokens (written)', color: tone('--amber'), values: pOut.total }] });

  // Model loads, always per card: that's where the time is lost.
  const loads = folded(byCard, (p) => p.loads, 'sum');
  const svg = $('loadChart');
  const w = Math.max(320, Math.round(svg.clientWidth || 600));
  const mk = markerRowsSvg({ w, t0: loads.t0, step: loads.step, color: tone('--amber'),
    rows: loads.ids.map((id) => ({ label: cardLabel(id), values: loads.rows[id] })) });
  svg.setAttribute('viewBox', `0 0 ${w} ${mk.h}`); svg.style.height = `${mk.h}px`; svg.innerHTML = mk.inner;
  const loadSec = Object.fromEntries(loads.ids.map((id) => [id, byCard.rows[id].reduce((s, p) => s + p.loadSec, 0)]));
  const loadN = Object.fromEntries(loads.ids.map((id) => [id, byCard.rows[id].reduce((s, p) => s + p.loads, 0)]));
  const loaders = loads.ids.filter((id) => loadN[id] > 0);
  $('loadNote').textContent = loaders.length
    ? `${loaders.map((id) => `${cardLabel(id)}: ${loadN[id]} load${loadN[id] === 1 ? '' : 's'}, ${Math.round(loadSec[id])} s`).join(' · ')}. Every load is time a card spends not answering.`
    : 'No model loads in this range: every card kept its model in memory.';

  const lat = folded(main, (p) => p.latP50, 'mean'), lat90 = folded(main, (p) => p.latP90, 'mean');
  draw('latChart', { kind: 'line', unit: ' s', t0: lat.t0, step: lat.step, series: lat.ids.flatMap((id) => [
    { label: `${labelOf(by, id)}, median`, color: colorOf(`${by}:${id}`), values: lat.rows[id] },
    { label: `${labelOf(by, id)}, slowest 10%`, color: colorOf(`${by}:${id}`), values: lat90.rows[id], dash: true }]) });
  const wait = folded(main, (p) => p.waitP50, 'mean'), wait90 = folded(main, (p) => p.waitP90, 'mean');
  draw('waitChart', { kind: 'line', unit: ' s', t0: wait.t0, step: wait.step, series: wait.ids.flatMap((id) => [
    { label: `${labelOf(by, id)}, median`, color: colorOf(`${by}:${id}`), values: wait.rows[id] },
    { label: `${labelOf(by, id)}, slowest 10%`, color: colorOf(`${by}:${id}`), values: wait90.rows[id], dash: true }]) });
  legend('latLegend', lat.ids, by);

  const failed = sum(main, (p) => p.failed), retried = sum(main, (p) => p.retried);
  draw('failChart', { kind: 'bars', t0: failed.t0, step: failed.step, series: [
    { label: 'failed attempts', color: tone('--bad'), values: failed.total }, { label: 'retried', color: tone('--amber'), values: retried.total }] });
  const fails = failed.total.reduce((s, v) => s + (v || 0), 0), retries = retried.total.reduce((s, v) => s + (v || 0), 0);
  $('failNote').textContent = fails || retries ? `${fails} failed attempt${fails === 1 ? '' : 's'} and ${retries} retr${retries === 1 ? 'y' : 'ies'} in this range.` : 'No failures in this range.';

  // Slot use per card, from the agents' reports.
  const workers = S.status?.workers.filter((x) => x.active) || [];
  const samples = await Promise.all(workers.map((x) => call('GET', `/ob/insights/cards/${encodeURIComponent(x.id)}?range=${range}`).then((r) => [x.id, r.samples]).catch(() => [x.id, []])));
  const use = samples.filter(([, s]) => s.some((v) => v?.slots)).map(([id, s]) => ({ label: cardLabel(id), color: colorOf(`card:${id}`),
    values: fold(s.map((v) => (v?.slots && v.slotsBusy != null ? (100 * v.slotsBusy) / v.slots : null)), POINTS, 'mean') }));
  draw('slotChart', { kind: 'line', unit: '%', max: 100, t0: main.t0, step: main.step * Math.max(1, Math.ceil((samples[0]?.[1].length || 1) / POINTS)), series: use });
  $('slotNote').textContent = use.length ? 'Busy slots as a share of each card\'s slots, from its machine\'s reports.' : 'Slot use appears once a machine\'s agent reports in (cards joined with ollabatch agent or install).';

  renderModelTable(models);
  renderThrash();
}

function renderModelTable(r) {
  const rows = Object.entries(r.rows).map(([model, pts]) => {
    const t = pts.reduce((a, p) => ({ requests: a.requests + p.requests, failed: a.failed + p.failed, promptTokens: a.promptTokens + p.promptTokens,
      outputTokens: a.outputTokens + p.outputTokens, genSec: a.genSec + p.genSec, loads: a.loads + p.loads, loadSec: a.loadSec + p.loadSec }),
    { requests: 0, failed: 0, promptTokens: 0, outputTokens: 0, genSec: 0, loads: 0, loadSec: 0 });
    return { model, ...t };
  }).sort((a, b) => b.requests - a.requests);
  // 'unknown': answers that carried no stats (failed requests, or a server that doesn't report them).
  $('modelRows').innerHTML = rows.length ? rows.map((m) => `<tr><td>${m.model === 'unknown' ? '<span class="note">unknown (answers without stats)</span>' : esc(m.model)}</td><td class="n">${big(m.requests)}</td><td class="n">${m.failed || ''}</td>
    <td class="n">${big(m.promptTokens)}</td><td class="n">${big(m.outputTokens)}</td><td class="n">${m.genSec ? rate(m.outputTokens / m.genSec) : 'unknown'}</td>
    <td class="n">${m.loads}${m.loads ? ` (${Math.round(m.loadSec)} s)` : ''}</td></tr>`).join('')
    : '<tr><td colspan="7" class="note">No model answers in this range yet.</td></tr>';
}

export function renderThrash() {
  const bad = thrashing(I.now?.switchesLastHour);
  $('thrash').hidden = !bad.length;
  $('thrash').innerHTML = bad.length ? `<b>${bad.map((id) => esc(cardLabel(id))).join(', ')}</b> switched models more than 6 times in the last hour. ${esc(THRASH_TEXT)}` : '';
}

export function initInsights(onChange) {
  for (const [group, key] of [['rangePick', 'range'], ['byPick', 'by']]) {
    $(group).addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      I[key] = b.dataset.v;
      $(group).querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      onChange();
    });
  }
}
