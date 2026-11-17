import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hardwareMeta, ownerHolds, ownerText, idleBayHtml, playgroundLine } from '../src/dashboard/view.mjs';

const rtx = { id: 'nvidia-2d000', workerId: 'pc-nvidia-2d000', name: 'NVIDIA GeForce RTX 5080', vramMB: 16303, freeMB: 4297, tempC: 66, powerW: 247.9, slots: 2, tuning: 'tuned', state: 'lending' };
const arc = { id: 'intel-963936', workerId: null, name: 'Intel(R) Arc(TM) A770 Graphics', vramMB: 16256, freeMB: null, tempC: null, powerW: null, slots: null, tuning: null,
  state: 'paused-in-use', reason: 'a fullscreen program is using this GPU' };

test('hardware line: VRAM, free, temperature, power, slots', () => {
  assert.deepEqual(hardwareMeta(rtx), ['16 GB', '4.2 GB free', '66°C', 'use unknown', '248 W', '2 at once, tuned']);
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

import { clockAt, etaText, whenText, big, pendingFields, fieldValue, thrashing, commandText, cardShares, historyRowHtml, timelineRates, statusText, outTokPerSec, summaryLine } from '../src/dashboard/view.mjs';

test('clock-time ETAs say today, tomorrow, or the weekday', () => {
  const now = new Date(2026, 10, 16, 22, 0).getTime();   // a Monday, 22:00
  assert.equal(clockAt(40 * 60, now), 'around 22:40');
  assert.equal(clockAt(5 * 3600, now), 'around 03:00 tomorrow');
  assert.equal(clockAt(3 * 86400, now), 'around Thu 22:00');
  assert.equal(etaText(90 * 60, now), '1h 30m left, around 23:30');
  assert.equal(etaText(null, now), '');
  assert.equal(whenText(new Date(2026, 10, 16, 9, 5).getTime(), now), '09:05');
  assert.equal(whenText(new Date(2026, 10, 14, 9, 5).getTime(), now), 'Sat 09:05');
  assert.equal(whenText(new Date(2026, 9, 3).getTime(), now), '3 Oct');
});

test('big numbers stay short; unknown stays unknown', () => {
  assert.deepEqual([big(950), big(41_200), big(1_900_000), big(null)], ['950', '41 k', '1.9 M', 'unknown']);
});

const machine = (fields, report) => ({ desired: { version: 1, fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { value: v, at: 1 }])) }, report });
const rep = { policy: 'when-free', schedule: [], playground: { limitGB: 50, downloads: false, models: [{ name: 'b', locked: true }, { name: 'a', locked: true }] },
  cards: [{ id: 'nvidia-1', fixedSlots: 'auto', paused: false, disabled: false }], localOverride: [] };

test('a dashboard change waits for the PC until its report shows it', () => {
  assert.deepEqual(pendingFields(machine({ policy: 'always', 'cards.nvidia-1.slots': 3 }, rep)), { policy: 'pending', 'cards.nvidia-1.slots': 'pending' });
  assert.deepEqual(pendingFields(machine({ policy: 'when-free', 'cards.nvidia-1.slots': 'auto', locked: ['a', 'b'], 'playground.limitGB': '50' }, rep)), {});
  assert.deepEqual(pendingFields(machine({ policy: 'always' }, { ...rep, localOverride: ['policy'] })), { policy: 'override' });
  assert.equal(fieldValue(rep, 'cards.gone.paused'), undefined);
});

test('a card loading models more than 6 times an hour is flagged', () => {
  assert.deepEqual(thrashing({ a: 6, b: 7, c: 0 }), ['b']);
});

test('commands read as what happened, in words', () => {
  assert.equal(commandText({ type: 'restart-card', card: 'nvidia-1', state: 'queued' }, () => 'RTX 5080'), 'restart RTX 5080: waiting for the PC');
  assert.equal(commandText({ type: 'retune', card: 'x', state: 'rejected', error: "rejected: this PC's owner hasn't let the pool manage it" }),
    "re-tune x: refused by the PC (this PC's owner hasn't let the pool manage it)");
  assert.equal(commandText({ type: 'pull', model: 'qwen3:8b', state: 'done' }), 'download qwen3:8b: done');
});

const job = { id: 'j1', name: 'Royals <enhance>', status: 'failed', exitCode: 1, startedAt: 0, finishedAt: 2 * 3600_000 + 14 * 60_000,
  progress: { done: 2515 }, modelsUsed: ['gemma4:12b'], summary: { text: 'Tagged 2,515 items. Three failed twice.' },
  stats: { outputTokens: 400_000, genSec: 10_000, cards: { a: { label: 'RTX 5080', requests: 61, outputTokens: 1 }, b: { label: 'Arc', requests: 21, outputTokens: 1 }, c: { label: 'MacBook', requests: 18, outputTokens: 1 } } } };

test('history rows: escaped name, status, duration, items, cards, tokens, first summary sentence', () => {
  const html = historyRowHtml(job, 1e13);
  assert.match(html, /Royals &#60;enhance&#62;/);
  assert.match(html, /failed, exit 1/);
  assert.match(html, /2h 14m/);
  assert.match(html, /2,515/);
  assert.match(html, /RTX 5080, Arc \+1/);
  assert.match(html, /400 k/);
  assert.match(html, /Tagged 2,515 items\.</);
  assert.equal(summaryLine({}), '');
  assert.equal(statusText({ status: 'failed', reason: 'cancelled by the host' }), 'failed: cancelled by the host');
});

test('card shares and speed', () => {
  assert.deepEqual(cardShares(job.stats).map((c) => [c.label, c.pct]), [['RTX 5080', 61], ['Arc', 21], ['MacBook', 18]]);
  assert.equal(outTokPerSec(job.stats), 40);
  assert.equal(outTokPerSec({ outputTokens: 5, genSec: 0 }), null);
});

test('timeline rates are per-minute deltas of the running total', () => {
  assert.deepEqual(timelineRates({ done: [10, 10, 25, 40] }), [10, 0, 15, 15]);
  assert.deepEqual(timelineRates(null), []);
});
