// ollabatch agent page: this machine's cards, lending rules and model playground.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const STATE_TEXT = { lending: 'lending', 'paused-by-owner': 'paused', 'paused-in-use': 'stepped aside', 'outside-schedule': 'off schedule',
  never: 'not lending', disabled: 'lending off', starting: 'starting', restarting: 'restarting', misconfigured: 'needs attention', 'not-joined': 'not in a pool', 'waiting-for-host': 'waiting for the host' };
let S = null, formsFilled = '', pendingJoin = null;

const gb = (b) => (b / 1024 ** 3).toFixed(1);
const unknown = (v, f = (x) => x) => (v == null ? 'unknown' : f(v));

async function act(action) {
  const r = await fetch('/act', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  S = j; render();
}

// A Lend button on the pool's dashboard opens this page with
// #join=<host>&pw=<password>. It only fills in the question; joining always
// takes a click on Lend, so a link alone can never sign this PC up.
function readJoinLink() {
  const h = new URLSearchParams(location.hash.slice(1));
  const url = h.get('join');
  if (!url || !/^http:\/\/[A-Za-z0-9.\-]+:\d+\/?$/.test(url)) return;
  pendingJoin = { url: url.replace(/\/+$/, ''), password: h.get('pw') || '' };
  history.replaceState(null, '', location.pathname);   // the password doesn't linger in the address bar
  $('confirmText').textContent = `The pool at ${pendingJoin.url} will be able to use this PC's GPUs by the rules below. You can pause or leave at any time from this page.`
    + (pendingJoin.password ? '' : ' Enter the pool password (it was printed when the host started).');
  $('confirmPwRow').hidden = !!pendingJoin.password;
  $('confirm').hidden = false;
}
// end readJoinLink

function renderCards() {
  if (!S.cards.length) { $('cards').innerHTML = '<p class="note">No GPUs found yet.</p>'; return; }
  $('cards').innerHTML = S.cards.map((c) => `<div class="bay ${c.state === 'lending' ? '' : 'paused'}">
    <div class="top1"><span class="label">${esc(c.name)}</span><span class="state">${esc(STATE_TEXT[c.state] || c.state)}</span></div>
    <div class="meta">${c.backend ? `<span>${esc(c.backend)}</span>` : ''}<span>${esc(c.vramMB ? `${(c.vramMB / 1024).toFixed(0)} GB${c.vendor === 'apple' ? ' shared' : ''}` : '')}</span>
      <span>${esc(unknown(c.freeMB, (f) => `${(f / 1024).toFixed(1)} GB free`))}</span><span>use ${esc(unknown(c.util, (u) => `${u}%`))}</span>
      <span>temperature ${esc(unknown(c.tempC, (t) => `${t}°C`))}</span><span>power ${esc(unknown(c.powerW, (w) => `${Math.round(w)} W`))}</span>
      ${c.slots ? `<span>${esc(c.slots)} at once${c.fixedSlots !== 'auto' ? ' (fixed)' : c.tuning ? ` (${esc(c.tuning)})` : ''}</span>` : ''}
      ${c.loadedModel ? `<span>in memory: ${esc(c.loadedModels.join(', '))}</span>` : ''}</div>
    ${c.reason ? `<div class="note">${esc(c.reason)}</div>` : ''}
    <div class="acts">
      ${c.paused ? `<button data-a="resume" data-card="${esc(c.id)}">Resume</button>` : `<button data-a="pause" data-card="${esc(c.id)}">Pause</button>`}
      ${c.disabled ? `<button data-a="enable" data-card="${esc(c.id)}">Turn lending on</button>` : `<button data-a="disable" data-card="${esc(c.id)}">Turn lending off</button>`}
      <label class="inline">Requests at once <select data-slots="${esc(c.id)}" aria-label="Requests at once on ${esc(c.name)}">
        ${['auto', 1, 2, 3, 4, 5, 6, 7, 8].map((n) => `<option value="${n}" ${String(c.fixedSlots) === String(n) ? 'selected' : ''}>${n === 'auto' ? 'auto (measured)' : n}</option>`).join('')}
      </select></label>
      ${c.slots ? `<button data-a="restart" data-card="${esc(c.id)}" title="Stop and start this card's Ollama server">Restart</button>` : ''}
      ${c.slots && c.fixedSlots === 'auto' ? `<button data-a="retune" data-card="${esc(c.id)}" title="Forget the measured setting and measure again from 1">Re-tune</button>` : ''}
    </div></div>`).join('');
}

function renderPool() {
  const found = S.hostsFound.filter((h) => h.url !== S.host);
  $('pool').innerHTML = (S.joined ? `<p>Lending to <b>${esc(S.host)}</b>. <button data-a="leave">Leave pool</button></p>` : '<p>Not in a pool yet.</p>')
    + (found.length ? `<p class="note">Found on this network: ${found.map((h) => `<button data-fill="${esc(h.url)}">${esc(h.name)} (${esc(h.url)})</button>`).join(' ')}</p>` : '');
  $('joinForm').hidden = S.joined;
  $('remote').checked = !!S.remote;
  $('remoteNote').textContent = S.remote
    ? (S.localOverride?.length ? `You changed ${S.localOverride.join(', ')} here after the pool did; your setting stands until the pool changes it again.` : 'The pool\'s dashboard can change these settings and restart or re-tune cards. A change you make here always wins over an older one from the pool.')
    : 'Only this page can change this PC. The pool sees its hardware and state.';
}

function renderModels() {
  const pg = S.playground;
  $('pgSummary').textContent = `${gb(pg.usedBytes)} of ${pg.limitGB} GB used in ${pg.path}. Models this PC already had are linked in and take no extra space.`
    + (S.download ? ` Downloading ${S.download.model}${S.download.total ? `: ${Math.round((100 * S.download.completed) / S.download.total)}%` : ''}.` : '');
  $('models').innerHTML = pg.models.length ? pg.models.map((m) => `<tr><td>${esc(m.name)}</td><td class="n">${m.linked ? 'linked' : `${gb(m.size)} GB`}</td>
    <td class="n">${m.locked ? `<button data-a="unlock" data-model="${esc(m.name)}">Unlock</button>` : `<button data-a="lock" data-model="${esc(m.name)}">Lock</button>`}
    ${m.locked ? '' : `<button data-a="remove" data-model="${esc(m.name)}">Remove</button>`}</td></tr>`).join('')
    : '<tr><td class="note">No models in the playground yet. They arrive when the pool needs them.</td></tr>';
}

// Fill the forms from the agent, again whenever its settings change (the pool
// may change them) unless you're in the middle of editing one.
function fillForms() {
  const sig = JSON.stringify([S.policy, S.schedule, S.playground.limitGB, S.playground.downloads]);
  if (formsFilled === sig || document.activeElement?.closest('#policyForm, #pgForm')) return;
  formsFilled = sig;
  document.querySelector(`input[name="policy"][value="${S.policy}"]`).checked = true;
  const w = S.schedule[0] || { days: [0, 1, 2, 3, 4, 5, 6], from: '23:00', to: '07:00' };
  $('from').value = w.from; $('to').value = w.to;
  $('days').innerHTML = DAY_NAMES.map((d, i) => `<label><input type="checkbox" value="${i}" ${w.days.includes(i) ? 'checked' : ''}> ${d}</label>`).join('');
  $('scheduleBox').hidden = S.policy !== 'schedule';
  $('limit').value = S.playground.limitGB;
  $('downloads').value = S.playground.downloads ? '1' : '0';
}

function render() {
  const lending = S.cards.filter((c) => c.state === 'lending').length;
  $('summary').textContent = `${S.machine}: ${lending} of ${S.cards.length} card${S.cards.length === 1 ? '' : 's'} lending${S.joined ? '' : ', not in a pool'}. ollabatch ${S.agent}`;
  $('watcherNote').hidden = S.watcher !== false;
  renderCards(); renderPool(); renderModels(); fillForms();
}

async function poll() {
  try { S = await (await fetch('/status')).json(); render(); } catch { $('summary').textContent = 'The agent isn\'t answering. Is it running?'; }
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  try {
    if (b.dataset.a) {
      if (b.dataset.a === 'remove' && !confirm(`Remove ${b.dataset.model} from the playground?`)) return;
      await act({ type: b.dataset.a, card: b.dataset.card, model: b.dataset.model });
    } else if (b.dataset.fill) {
      $('joinUrl').value = b.dataset.fill; $('joinPw').focus();
    } else if (b.id === 'confirmYes' && pendingJoin) {
      await act({ type: 'join', url: pendingJoin.url, password: pendingJoin.password || $('confirmPw').value });
      pendingJoin = null; $('confirm').hidden = true;
    } else if (b.id === 'confirmNo') {
      pendingJoin = null; $('confirm').hidden = true;
    }
  } catch (err) { alert(err.message); }
});

document.addEventListener('change', async (e) => {
  if (e.target.name === 'policy') $('scheduleBox').hidden = e.target.value !== 'schedule';
  try {
    if (e.target.dataset.slots) await act({ type: 'slots', card: e.target.dataset.slots, slots: e.target.value });
    if (e.target.id === 'remote') await act({ type: 'remote', on: e.target.checked });
  } catch (err) { alert(err.message); poll(); }
});

document.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    if (e.target.id === 'joinForm') {
      await act({ type: 'join', url: $('joinUrl').value.trim(), password: $('joinPw').value });
    } else if (e.target.id === 'policyForm') {
      const policy = document.querySelector('input[name="policy"]:checked').value;
      const days = [...document.querySelectorAll('#days input:checked')].map((x) => Number(x.value));
      await act({ type: 'policy', policy, schedule: [{ days, from: $('from').value, to: $('to').value }] });
    } else if (e.target.id === 'pgForm') {
      await act({ type: 'playground', limitGB: Number($('limit').value), downloads: $('downloads').value === '1' });
    } else if (e.target.id === 'pullForm') {
      await act({ type: 'pull', model: $('pullModel').value.trim() });
      $('pullModel').value = '';
    }
  } catch (err) { alert(err.message); }
});

readJoinLink();
poll();
setInterval(poll, 2000);
