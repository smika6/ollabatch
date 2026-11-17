// What every dashboard section shares: the password, API calls, keyed
// redraws, toasts, file downloads and the chart colors.
export const $ = (id) => document.getElementById(id);

const saved = {
  get: (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
export { saved };

export const S = { token: document.body.dataset.token || saved.get('ollabatch-token'), status: null, info: null, onLocked: () => {} };

export async function call(method, path, body) {
  const r = await fetch(path, {
    method, headers: { 'Content-Type': 'application/json', 'x-pool-token': S.token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (r.status === 401) { S.onLocked(); throw new Error('locked'); }
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { /* text */ }
  if (!r.ok) throw new Error(json?.error || `HTTP ${r.status}`);
  return json ?? text;
}

// Downloads go through fetch so the password stays in a header, never in a URL.
export async function download(path, filename) {
  const r = await fetch(path, { headers: { 'x-pool-token': S.token } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const url = URL.createObjectURL(await r.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// Redraw only the children whose HTML changed, so a poll every 2 s doesn't
// steal focus or close an open menu: a child holding focus is left alone
// until you leave it.
export function patch(container, items) {
  const old = new Map([...container.children].map((el) => [el.dataset.key, el]));
  let prev = null;
  for (const { key, html } of items) {
    let el = old.get(key);
    if (!el || (el.dataset.html !== html && !el.contains(document.activeElement))) {
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

export function toast(text, kind = 'info', ms = 6000) {
  const box = $('toasts');
  const el = Object.assign(document.createElement('div'), { className: `toast ${kind}`, textContent: text });
  box.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

export const COLORS = getComputedStyle(document.documentElement).getPropertyValue('--series').split(',').map((s) => s.trim());
// The same thing keeps its color across charts and redraws.
const assigned = new Map();
export const colorOf = (id) => {
  if (!assigned.has(id)) assigned.set(id, COLORS[assigned.size % COLORS.length]);
  return assigned.get(id);
};

export const cardLabel = (id) => S.status?.workers.find((w) => w.id === id)?.label || id;
export const jobName = (id) => S.status?.jobs.find((j) => j.id === id)?.name || id;

// Wrap a button's async work: disable it meanwhile, show errors as toasts.
export async function busy(button, work) {
  if (button) button.disabled = true;
  try { return await work(); } catch (e) { if (e.message !== 'locked') toast(e.message, 'bad'); return undefined; } finally { if (button) button.disabled = false; }
}

// A theme color as a literal value: SVG attributes don't resolve var().
export const tone = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
