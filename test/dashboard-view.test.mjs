import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hardwareMeta, ownerHolds, ownerText, idleBayHtml, playgroundLine } from '../src/dashboard/view.mjs';

const rtx = { id: 'nvidia-2d000', workerId: 'pc-nvidia-2d000', name: 'NVIDIA GeForce RTX 5080', vramMB: 16303, freeMB: 4297, tempC: 66, powerW: 247.9, slots: 2, tuning: 'tuned', state: 'lending' };
const arc = { id: 'intel-963936', workerId: null, name: 'Intel(R) Arc(TM) A770 Graphics', vramMB: 16256, freeMB: null, tempC: null, powerW: null, slots: null, tuning: null,
  state: 'paused-in-use', reason: 'a fullscreen program is using this GPU' };

test('hardware line: VRAM, free, temperature, power, slots', () => {
  assert.deepEqual(hardwareMeta(rtx), ['16 GB', '4.2 GB free', '66°C', '248 W', '2 at once, tuned']);
});

test('values a driver does not report read "unknown", never 0', () => {
  const m = hardwareMeta(arc);
  assert.ok(m.includes('temperature unknown'));
  assert.ok(m.includes('free memory unknown'));
  assert.ok(!m.some((x) => /\b0\s*(°C|W|GB free)/.test(x)));
});

test('owner pauses are explained and hold the Resume button', () => {
  assert.equal(ownerHolds({ state: 'paused-in-use' }), true);
  assert.equal(ownerHolds({ state: 'paused-by-owner' }), true);
  assert.equal(ownerHolds({ state: 'lending' }), false);
  assert.equal(ownerHolds(null), false);
  assert.equal(ownerText({ state: 'paused-in-use', reason: 'a fullscreen program is using this GPU' }), 'Paused on its PC: a fullscreen program is using this GPU');
});

test('a card the machine is not lending is shown greyed with why, and no buttons', () => {
  const html = idleBayHtml(arc);
  assert.match(html, /class="bay idle-card"/);
  assert.match(html, /Intel\(R\) Arc\(TM\) A770 Graphics/);
  assert.match(html, /a fullscreen program is using this GPU/);
  assert.doesNotMatch(html, /<button/);
  assert.match(idleBayHtml({ ...arc, name: '<img src=x onerror=alert(1)>' }), /&#60;img/);
});

test('playground line with a download in progress', () => {
  const report = { playground: { limitGB: 50, usedBytes: 6.5e9, models: [{ name: 'a', locked: true }, { name: 'b', locked: false }] },
    download: { model: 'gemma4:26b', completed: 4.25e9, total: 17e9 } };
  assert.equal(playgroundLine(report), 'Models: 6.1 of 50 GB, 2 models (1 locked). Downloading gemma4:26b, 25%.');
  assert.equal(playgroundLine({}), '');
});
