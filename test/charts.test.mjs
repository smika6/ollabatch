import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fold, chartSvg, sparkSvg, markerRowsSvg, timeLabel } from '../src/dashboard/charts.mjs';

test('fold sums counts, averages levels, and keeps unknown as unknown', () => {
  assert.deepEqual(fold([1, 2, 3, 4], 2), [3, 7]);
  assert.deepEqual(fold([1, null, 3, 5], 2, 'mean'), [1, 4]);
  assert.deepEqual(fold([null, null, 2, 9], 2, 'max'), [null, 9]);
  assert.deepEqual(fold([1, 2], 10), [1, 2]);
});

test('an unknown value breaks the line instead of dropping to 0', () => {
  const svg = chartSvg({ series: [{ label: 'temp', color: 'red', values: [60, 61, null, null, 62, 63] }], kind: 'line' });
  assert.equal((svg.match(/<polyline/g) || []).length, 2);
  assert.doesNotMatch(svg, /NaN/);
});

test('stacked areas, bars, labels and the time axis', () => {
  const t0 = new Date(2026, 10, 16, 14, 0).getTime();
  const svg = chartSvg({ series: [{ label: 'a', color: 'red', values: [1, 2, 3] }, { label: 'b', color: 'blue', values: [1, 1, 1] }], kind: 'area', unit: '/s', t0, step: 60_000 });
  assert.equal((svg.match(/<polygon/g) || []).length, 2);
  assert.match(svg, /4\/s/);            // stacked top is 3 + 1
  assert.match(svg, />14:00</);
  const bars = chartSvg({ series: [{ label: 'x <y>', color: 'red', values: [0, 5, null] }], kind: 'bars' });
  assert.equal((bars.match(/<rect/g) || []).length, 1);
  assert.match(bars, /x &#60;y&#62;/);
  assert.equal(timeLabel(t0, 3_600_000), 'Mon 14:00');
  assert.doesNotMatch(chartSvg({ series: [] }), /NaN/);
});

test('sparklines and load markers', () => {
  assert.equal(sparkSvg([null, null]), '');
  const s = sparkSvg([1, null, 3]);
  assert.match(s, /<circle/);
  assert.doesNotMatch(s, /NaN/);
  const m = markerRowsSvg({ rows: [{ label: 'RTX 5080', values: [0, 2, 0] }, { label: 'Arc', values: [0, 0, 0] }] });
  assert.equal((m.inner.match(/<circle/g) || []).length, 1);
  assert.equal(m.h, 62);
});
