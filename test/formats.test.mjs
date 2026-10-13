import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Instance } from '../src/rbx/instance.js';
import { modelFromSpec } from '../src/backends/local/index.js';
import { validateModel, formatSupports, isDefaultish, closestName } from '../src/rbx/validate.js';
import { dryRunUnsupported } from '../src/rbx/io.js';
import { serializeXml, deserializeXml, xmlValueTypes } from '../src/rbx/xml.js';
import { serializeModel, deserializeModel } from '../src/rbx/binary.js';
import { serializationFor, db } from '../src/rbx/reflection.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-formats-'));
const codes = (r) => r.diagnostics.map((d) => d.code);

// --- the loss bug -----------------------------------------------------------
// The binary writer used to omit any property whose value type it had no
// encoding for, and never said so. An agent would set it, the write would
// "succeed", and the file would disagree with the intent.

test('a property with no binary encoding is an error, not a silent drop', () => {
  const roots = modelFromSpec([
    { className: 'Part', name: 'P', properties: { Size: [1, 1, 1], UniqueId: { index: 1, time: 2, random: 3 } } },
  ]);
  const result = validateModel(roots, { format: 'xml' });
  const d = result.diagnostics.find((x) => x.code === 'unsupported-type');
  assert.ok(d, 'expected unsupported-type');
  assert.equal(d.severity, 'error');
  assert.equal(d.path, 'P.UniqueId');
  assert.match(d.message, /would be dropped/);
});

test('dryRunUnsupported predicts exactly what a write would lose', () => {
  const roots = modelFromSpec([
    { className: 'Part', name: 'P', properties: { Size: [1, 1, 1], UniqueId: { index: 1, time: 2, random: 3 } } },
  ]);
  assert.deepEqual(dryRunUnsupported(path.join(tmp, 'a.rbxm'), roots), [], 'binary can encode UniqueId');
  assert.deepEqual(dryRunUnsupported(path.join(tmp, 'a.rbxmx'), roots), ['UniqueId:UniqueId']);
});

test('a class merely declaring an unsupported type costs nothing', () => {
  // Studio.Font is a QFont and TextChatMessage.Timestamp a DateTime, but a
  // model that never sets them must not be reported.
  const roots = modelFromSpec([{ className: 'Part', name: 'P', properties: { Size: [1, 1, 1] } }]);
  assert.equal(validateModel(roots, { format: 'binary' }).ok, true);
  assert.equal(validateModel(roots, { format: 'xml' }).ok, true);
});

test('defaults materialised by the loader are not reported as loss', () => {
  // Both codecs write every serializable property, so a round trip produces
  // values nobody set. Those must stay quiet or every load would look broken.
  const roots = modelFromSpec([{ className: 'Part', name: 'P', properties: { Size: [1, 1, 1] } }]);
  const reloaded = deserializeModel(serializeModel(roots));
  assert.equal(validateModel(reloaded, { format: 'xml' }).ok, true);
  assert.equal(
    dryRunUnsupported(path.join(tmp, 'b.rbxmx'), reloaded).includes('UniqueId:UniqueId'),
    false,
  );
});

test('a genuinely dropped value fails a conversion', () => {
  const roots = modelFromSpec([
    { className: 'Part', name: 'P', properties: { UniqueId: { index: 5, time: 6, random: 7 } } },
  ]);
  // Binary keeps it; XML cannot, so converting must say so.
  const binary = serializeModel(roots);
  const back = deserializeModel(binary);
  assert.deepEqual(back[0].get('UniqueId'), { index: 5, time: 6, random: 7 });
  assert.equal(validateModel(back, { format: 'xml' }).ok, false);
});

// --- formatSupports ---------------------------------------------------------

test('formatSupports agrees with what the codecs actually do', () => {
  const ser = serializationFor('Part');
  assert.equal(formatSupports(ser.forward.get('Size'), 'binary'), true);
  assert.equal(formatSupports(ser.forward.get('Size'), 'xml'), true);
  assert.equal(formatSupports({ valueType: 'QFont' }, 'binary'), false);
  assert.equal(formatSupports({ valueType: 'QFont' }, 'xml'), false);
  // An enum is a number either way.
  assert.equal(formatSupports({ valueType: 'Material' }, 'binary'), true);
  assert.equal(formatSupports({ valueType: 'Material' }, 'xml'), true);
});

test('an unspecified format is checked against the strictest one', () => {
  assert.equal(formatSupports({ valueType: 'UniqueId' }, null), true, 'binary knows UniqueId');
  assert.equal(formatSupports({ valueType: 'QFont' }, null), false);
});

// --- isDefaultish -----------------------------------------------------------

test('isDefaultish recognises every shape a default takes', () => {
  assert.equal(isDefaultish(undefined), true);
  assert.equal(isDefaultish(null), true);
  assert.equal(isDefaultish(0), true);
  assert.equal(isDefaultish(false), true);
  assert.equal(isDefaultish(''), true);
  assert.equal(isDefaultish([]), true);
  assert.equal(isDefaultish({ x: 0, y: 0, z: 0 }), true);
  assert.equal(isDefaultish({ index: 0, time: 0, random: 0 }), true);
  assert.equal(isDefaultish(1), false);
  assert.equal(isDefaultish('a'), false);
  assert.equal(isDefaultish({ x: 1, y: 0, z: 0 }), false);
  assert.equal(isDefaultish({ index: 0, time: 0, random: 9 }), false);
});

// --- suggestions ------------------------------------------------------------

test('a suggestion never repeats the name that was rejected', () => {
  // RobloxLocked is a real Instance property, so it used to be suggested for
  // itself: "did you mean: RobloxLocked?" on a typo of RobloxLocked.
  assert.equal(closestName('RobloxLocked', ['RobloxLocked']), null);
  assert.equal(closestName('Sizee', ['Size']), 'Size');
});

test('a real but unsaved property is distinguished from a typo', () => {
  const p = new Instance('Part', 'P');
  p.set('RobloxLocked', true); // exists on Instance, canSave = false
  const saved = validateModel([p]);
  const d = saved.diagnostics[0];
  assert.equal(d.code, 'unserializable-property');
  assert.match(d.message, /not saved to model files/);

  const typo = new Instance('Part', 'Q');
  typo.set('Sizee', { x: 1, y: 1, z: 1 });
  const wrong = validateModel([typo]);
  assert.equal(wrong.diagnostics[0].code, 'unknown-property');
  assert.equal(wrong.diagnostics[0].suggestion, 'Size');
});

// --- XML tags ---------------------------------------------------------------

test('ContentId and ProtectedString get their own XML tags', () => {
  const p = new Instance('Decal', 'D');
  p.set('Texture', 'rbxassetid://12345');
  const xml = serializeXml([p]);
  assert.match(xml, /<ContentId name="Texture">rbxassetid:\/\/12345<\/ContentId>/);
});

test('XML refuses types it cannot represent instead of inventing an encoding', () => {
  const p = new Instance('Part', 'P');
  p.set('UniqueId', { index: 1, time: 2, random: 3 });
  const seen = [];
  serializeXml([p], { onUnsupported: (list) => seen.push(...list) });
  assert.deepEqual(seen, ['UniqueId:UniqueId']);

  p.set('SecurityCapabilities', 0b1010);
  const strict = [];
  assert.throws(
    () => serializeXml([p], { strictUnsupported: true, onUnsupported: (l) => strict.push(...l) }),
    /no faithful XML form/,
  );
});

// --- differential round-trip ------------------------------------------------
// The strongest test available without the reference implementation: for every
// value type the codecs claim to support, find a real serializable property
// that uses it and prove a value survives a write/read cycle in *both* codecs.
// This is what caught the always-false Faces encoder and the Font enum/datatype
// collision.

const SAMPLES = {
  bool: true,
  int: -7,
  int64: 4294967296,
  float: 1.5,
  double: 2.25,
  string: 'hi',
  BinaryString: Uint8Array.from([1, 2, 255, 0, 128]),
  ContentId: 'rbxassetid://9',
  ProtectedString: 'secret',
  Content: { source: 'uri', value: 'rbxassetid://1' },
  Vector2: { x: 1, y: 2 },
  Vector3: { x: 1, y: 2, z: 3 },
  CFrame: { position: { x: 1, y: 2, z: 3 }, rotation: [0, 1, 0, -1, 0, 0, 0, 0, 1] },
  Color3: { r: 0.25, g: 0.5, b: 0.75 },
  UDim: { scale: 1, offset: 2 },
  UDim2: { x: { scale: 1, offset: 2 }, y: { scale: 3, offset: 4 } },
  Ray: { origin: { x: 0, y: 1, z: 2 }, direction: { x: 0, y: 0, z: 1 } },
  Faces: 40,
  Axes: 5,
  BrickColor: 194,
  NumberRange: { min: 1, max: 5 },
  Rect: { min: { x: 0, y: 0 }, max: { x: 5, y: 5 } },
  NumberSequence: { keypoints: [{ time: 0, value: 1, envelope: 0 }, { time: 1, value: 2, envelope: 0 }] },
  ColorSequence: {
    keypoints: [{ time: 0, color: { r: 1, g: 0, b: 0 } }, { time: 1, color: { r: 0, g: 0, b: 1 } }],
  },
  PhysicalProperties: { density: 0.5, friction: 0.25, elasticity: 0.5, frictionWeight: 1, elasticityWeight: 1 },
  Font: { family: 'rbxasset://fonts/families/LegacyArial.json', weight: 400, style: 0, cachedFaceId: '' },
};

/** First class/property in the reflection DB that serializes this value type. */
function findSerializableProperty(typeName) {
  for (const [cls, info] of Object.entries(db().classes)) {
    for (const [prop, entry] of Object.entries(info.props)) {
      if (entry[0] === typeName && entry[2] === 1) return { cls, prop };
    }
  }
  return null;
}

/** Compare while tolerating f32 rounding, which the format itself introduces. */
function normalize(value) {
  if (value instanceof Uint8Array) return Array.from(value);
  return JSON.parse(
    JSON.stringify(value, (key, v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v)),
  );
}

for (const [typeName, sample] of Object.entries(SAMPLES)) {
  test(`${typeName} round-trips through both codecs`, () => {
    const loc = findSerializableProperty(typeName);
    assert.ok(loc, `no serializable property of type ${typeName} to test with`);
    const inst = new Instance(loc.cls, 'X');
    inst.set(loc.prop, sample);

    const viaXml = deserializeXml(serializeXml([inst]))[0];
    assert.deepEqual(
      normalize(viaXml.get(loc.prop)),
      normalize(sample),
      `XML round-trip of ${loc.cls}.${loc.prop} (${typeName})`,
    );

    const viaBinary = deserializeModel(serializeModel([inst]))[0];
    assert.deepEqual(
      normalize(viaBinary.get(loc.prop)),
      normalize(sample),
      `binary round-trip of ${loc.cls}.${loc.prop} (${typeName})`,
    );
  });
}

test('the XML support set and the implementation agree', () => {
  // Color3uint8 is the wire form of Color3, applied through the patch database,
  // so no property declares it as its canonical type; it has its own test below.
  // Color3uint8 reaches the wire through the patch database (see below);
  // Vector3int16 and Instance have no serializable property to test through.
  const coveredElsewhere = new Set(['Instance', 'Vector3int16', 'Color3uint8']);
  for (const typeName of xmlValueTypes) {
    if (coveredElsewhere.has(typeName)) continue;
    assert.ok(
      typeName in SAMPLES,
      `${typeName} is advertised as supported but is not covered by a round-trip test`,
    );
  }
  assert.equal(xmlValueTypes.has('SharedString'), false, 'SharedString has no encoder');
});

test('the patched Color3uint8 wire form survives in both codecs', () => {
  // BasePart.Color is a Color3 in the API and a Color3uint8 in the file.
  const part = new Instance('Part', 'P');
  part.set('Color', { r: 0.6, g: 0.2, b: 0.2 });
  for (const back of [
    deserializeXml(serializeXml([part]))[0],
    deserializeModel(serializeModel([part]))[0],
  ]) {
    const color = back.get('Color');
    assert.ok(Math.abs(color.r - 0.6) < 0.01, `red channel round-tripped as ${color.r}`);
    assert.ok(Math.abs(color.g - 0.2) < 0.01);
    assert.ok(Math.abs(color.b - 0.2) < 0.01);
  }
});

// --- regressions ------------------------------------------------------------

test('Faces and Axes bitmasks survive (they used to always encode as false)', () => {
  const { cls, prop } = findSerializableProperty('Faces');
  const inst = new Instance(cls, 'X');
  inst.set(prop, 40); // Top | Back | Bottom
  assert.equal(deserializeXml(serializeXml([inst]))[0].get(prop), 40);
  assert.equal(deserializeModel(serializeModel([inst]))[0].get(prop), 40);
});

test('a Font datatype property is not mistaken for the Font enum', () => {
  // The API dump gives the legacy enum and the datatype the same name, and
  // TextLabel.Font (enum) is deprecated while FontFace (datatype) is current.
  assert.equal(serializationFor('TextLabel').forward.get('FontFace').isEnum, false);
  assert.equal(serializationFor('GetTextBoundsParams').forward.get('Font').isEnum, false);
  assert.equal(serializationFor('Part').forward.get('Material').isEnum, true);

  const params = new Instance('GetTextBoundsParams', 'P');
  params.set('Font', { family: 'rbxasset://fonts/families/LegacyArial.json', weight: 700, style: 0, cachedFaceId: '' });
  const back = deserializeXml(serializeXml([params]))[0];
  assert.equal(back.get('Font').weight, 700, 'a font written as 0 would lose the weight');
});

test('BinaryString bytes survive the binary codec', () => {
  const { cls, prop } = findSerializableProperty('BinaryString');
  const bytes = Uint8Array.from([0, 255, 128, 1]);
  const inst = new Instance(cls, 'X');
  inst.set(prop, bytes);
  const back = deserializeModel(serializeModel([inst]))[0].get(prop);
  assert.deepEqual(Array.from(back), [0, 255, 128, 1]);
});
