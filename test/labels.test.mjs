import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSelector, matchesSelector, formatSelector, parseLabels } from '../src/labels.mjs';

test('parseSelector reads every operator', () => {
  assert.deepEqual(parseSelector('gpu=nvidia, vram>=12, owner!=gf, vision'), [
    { key: 'gpu', op: '=', value: 'nvidia' },
    { key: 'vram', op: '>=', value: '12' },
    { key: 'owner', op: '!=', value: 'gf' },
    { key: 'vision', op: 'has' },
  ]);
});

test('parseSelector: empty means no requirements', () => {
  assert.deepEqual(parseSelector(''), []);
  assert.deepEqual(parseSelector('  '), []);
  assert.deepEqual(parseSelector(undefined), []);
});

test('parseSelector rejects a non-numeric comparison', () => {
  assert.throws(() => parseSelector('vram>=abc'), /vram/);
});

test('matchesSelector', () => {
  const reqs = parseSelector('gpu=nvidia,vram>=12');
  assert.equal(matchesSelector({ gpu: 'nvidia', vram: '16' }, reqs), true);
  assert.equal(matchesSelector({ gpu: 'nvidia', vram: '8' }, reqs), false);
});

test('missing key fails =, >=, <=, has and passes !=', () => {
  for (const s of ['x=1', 'x>=1', 'x<=1', 'x']) assert.equal(matchesSelector({}, parseSelector(s)), false, s);
  assert.equal(matchesSelector({}, parseSelector('x!=1')), true);
});

test('numeric ops compare numbers, not strings', () => {
  assert.equal(matchesSelector({ vram: '9' }, parseSelector('vram>=12')), false);
  assert.equal(matchesSelector({ vram: '100' }, parseSelector('vram>=12')), true);
  assert.equal(matchesSelector({ vram: 'big' }, parseSelector('vram>=12')), false);
});

test('formatSelector round-trips', () => {
  assert.equal(formatSelector(parseSelector('gpu=nvidia,vram>=12')), 'gpu=nvidia,vram>=12');
  assert.equal(formatSelector(parseSelector('vision, owner!=gf')), 'vision,owner!=gf');
});

test('parseLabels', () => {
  assert.deepEqual(parseLabels('owner=gf, display=1'), { owner: 'gf', display: '1' });
  assert.deepEqual(parseLabels(''), {});
  assert.throws(() => parseLabels('bad'), /bad/);
});
