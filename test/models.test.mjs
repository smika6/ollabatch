import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseModel, modelForCard, rewriteModel } from '../src/models.mjs';

const cards = [{ models: ['12b'], slots: 4 }, { models: ['12b', '26b'], slots: 2 }];

test('chooseModel: first model with enough cards', () => {
  assert.equal(chooseModel(['26b', '12b'], cards, 1), '26b');
  assert.equal(chooseModel(['26b', '12b'], cards, 2), '12b');
});

test('chooseModel: nobody reaches minCards → the model with the most slots', () => {
  assert.equal(chooseModel(['26b', '12b'], cards, 5), '12b');
  assert.equal(chooseModel(['26b', 'x'], cards, 5), '26b');
});

test('chooseModel: no card has any → null', () => {
  assert.equal(chooseModel(['70b'], cards), null);
  assert.equal(chooseModel(['12b'], []), null);
});

test('modelForCard picks the first listed model the card has', () => {
  assert.equal(modelForCard(['26b', '12b'], ['12b', '26b']), '26b');
  assert.equal(modelForCard(['26b', '12b'], ['12b']), '12b');
  assert.equal(modelForCard(['26b'], ['12b']), null);
});

test('rewriteModel replaces the top-level model only', () => {
  assert.deepEqual(JSON.parse(rewriteModel('{"model":"a","x":1,"options":{"model":"keep"}}', 'b')),
    { model: 'b', x: 1, options: { model: 'keep' } });
  assert.equal(rewriteModel('not json', 'b'), 'not json');
  assert.equal(rewriteModel('{"x":1}', 'b'), '{"x":1}');
});
