import test from 'node:test';
import assert from 'node:assert/strict';
import { validateModel, validateValue, closestName, knownPropertyNames } from '../src/rbx/validate.js';
import { serializationFor } from '../src/rbx/reflection.js';
import { Instance } from '../src/rbx/instance.js';
import { coerce } from '../src/backends/local/index.js';
import { v3 } from '../src/rbx/datatypes.js';

function part(props = {}) {
  const p = new Instance('Part', 'P');
  for (const [k, v] of Object.entries(props)) p.set(k, v);
  return p;
}

function codes(result) {
  return result.diagnostics.map((d) => d.code);
}

test('closestName suggests near misses', () => {
  assert.equal(closestName('Sizee', ['Size', 'Anchored', 'Material']), 'Size');
  assert.equal(closestName('matrial', ['Material', 'Size']), 'Material');
  assert.equal(closestName('zzzzzz', ['Size', 'Material']), null);
});

test('knownPropertyNames includes canonical and serialized names', () => {
  const names = knownPropertyNames('Part');
  assert.ok(names.includes('Size'));
  assert.ok(names.includes('size'));
  assert.ok(names.includes('CFrame'));
});

test('a valid model reports no problems', () => {
  const result = validateModel([part({ Size: v3(4, 1, 2), Anchored: true, Material: 256 })]);
  assert.equal(result.ok, true);
  assert.equal(result.errorCount, 0);
  assert.equal(result.warningCount, 0);
});

test('unknown property is an error with a suggestion', () => {
  const result = validateModel([part({ Sizee: v3(1, 1, 1) })]);
  assert.equal(result.ok, false);
  const d = result.diagnostics.find((x) => x.code === 'unknown-property');
  assert.ok(d, 'expected unknown-property');
  assert.equal(d.severity, 'error');
  assert.equal(d.suggestion, 'Size');
  assert.equal(d.path, 'P.Sizee');
});

test('wrong value type is an error', () => {
  const result = validateModel([part({ Size: 'oops' })]);
  assert.equal(result.ok, false);
  const d = result.diagnostics.find((x) => x.code === 'invalid-value');
  assert.ok(d);
  assert.match(d.message, /expected \{x, y, z\}/);
});

test('invalid enum item is an error with a suggestion', () => {
  const result = validateModel([part({ Material: 999999 })]);
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('invalid-enum-value'));
});

test('invalid enum given as a number outside the domain is caught', () => {
  const p = part();
  p.set('Material', 12345);
  const result = validateModel([p]);
  assert.equal(result.ok, false);
});

test('out-of-range numeric properties warn', () => {
  const result = validateModel([part({ Transparency: 5 })]);
  assert.equal(result.ok, true, 'warnings alone do not fail in non-strict mode');
  assert.equal(result.warningCount, 1);
  assert.ok(codes(result).includes('out-of-range'));
});

test('strict mode turns warnings into failures', () => {
  const result = validateModel([part({ Transparency: 5 })], { strict: true });
  assert.equal(result.ok, false);
});

test('duplicate child names warn', () => {
  const root = new Instance('Folder', 'Root');
  root.addChild(new Instance('Part', 'Dup'));
  root.addChild(new Instance('Part', 'Dup'));
  const result = validateModel([root]);
  assert.ok(codes(result).includes('duplicate-name'));
});

test('reference type is checked', () => {
  const model = new Instance('Model', 'M');
  const folder = new Instance('Folder', 'NotAPart');
  model.addChild(folder);
  model.set('PrimaryPart', folder);
  const result = validateModel([model]);
  const d = result.diagnostics.find((x) => x.code === 'invalid-reference');
  assert.ok(d, 'expected invalid-reference');
  assert.equal(d.expected, 'BasePart');
});

test('a correct reference passes', () => {
  const model = new Instance('Model', 'M');
  const p = new Instance('Part', 'Primary');
  model.addChild(p);
  model.set('PrimaryPart', p);
  const result = validateModel([model]);
  assert.equal(result.ok, true);
});

test('coerce leaves malformed values untouched instead of defaulting them', () => {
  // The old behaviour silently produced (0,0,0), which hid agent mistakes.
  assert.equal(coerce('oops', 'Vector3'), 'oops');
  assert.equal(coerce([1, 2], 'Vector3').length, 2);
  assert.deepEqual(coerce([1, 2, 3], 'Vector3'), v3(1, 2, 3));
  assert.deepEqual(coerce({ x: 1, y: 2, z: 3 }, 'Vector3'), v3(1, 2, 3));
});

test('validateValue reports nested CFrame rotation problems', () => {
  const info = serializationFor('Part').forward.get('CFrame');
  const diags = validateValue({ position: { x: 0, y: 0, z: 0 }, rotation: [1, 0, 0] }, info, 'P.CFrame');
  assert.equal(diags.length, 1);
  assert.match(diags[0].message, /rotation expected 9 numbers/);
});

// --- canonical vs serialized types ------------------------------------------
// BasePart.Color is a Color3 (0..1) in the API but is persisted as Color3uint8.
// Validating only the on-disk type let a [255, 0, 0] "red" be silently clamped.

test('out-of-range Color3 channels warn even though Color is stored as Color3uint8', () => {
  // As a spec arrives: coerce() turns [2, 0, 0] into {r, g, b} first.
  const result = validateModel([part({ Color: coerce([2, 0, 0], 'Color3') })]);
  const d = result.diagnostics.find((x) => x.code === 'color-out-of-range');
  assert.ok(d, 'expected color-out-of-range');
  assert.equal(d.severity, 'warning');
  assert.equal(d.path, 'P.Color.r');
  assert.equal(d.actual, 2);
  // 0..255 values are the common mistake, so they get the fraction spelled out.
  assert.match(d.note, /0\.\.1 fractions/);
  assert.equal(d.suggestion, '0.0078 (2/255)');
});

test('an uncoerced array color is still range-checked', () => {
  const result = validateModel([part({ Color: [2, 0, 0] })]);
  const d = result.diagnostics.find((x) => x.code === 'color-out-of-range');
  assert.ok(d, 'expected color-out-of-range');
  assert.equal(d.path, 'P.Color.0');
});

test('a non-color value on Color is still a shape error', () => {
  const result = validateModel([part({ Color: 'red' })]);
  assert.ok(codes(result).includes('invalid-value'));
});

test('a color in 0..1 does not warn', () => {
  const result = validateModel([part({ Color: [0.6, 0.2, 0.2] })]);
  assert.equal(result.warningCount, 0);
});

test('out-of-range colors fail in strict mode', () => {
  const result = validateModel([part({ Color: [2, 0, 0] })], { strict: true });
  assert.equal(result.ok, false);
});

test('coerce does not throw on an unknown enum item', () => {
  // Throwing here aborted the run and hid every other problem in the model.
  assert.equal(coerce('Concree', 'Material'), 'Concree');
  assert.equal(coerce(999, 'Material'), 999);
});

test('every problem in a model is reported in one pass', () => {
  const result = validateModel([
    part({ Sizee: [1, 1, 1], Material: 'Concree', Transparency: 5, Color: [2, 0, 0] }),
  ]);
  const seen = codes(result);
  assert.ok(seen.includes('unknown-property'), 'unknown-property');
  assert.ok(seen.includes('invalid-enum-item'), 'invalid-enum-item');
  assert.ok(seen.includes('out-of-range'), 'out-of-range');
  assert.ok(seen.includes('color-out-of-range'), 'color-out-of-range');
  assert.equal(result.errorCount, 2);
  assert.equal(result.warningCount, 2);
});
