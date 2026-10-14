import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeModel, deserializeModel } from '../src/rbx/binary.js';
import { Instance } from '../src/rbx/instance.js';
import { v3, cframe, numberSequence, colorSequence } from '../src/rbx/datatypes.js';
import {
  propertiesFor,
  serializationFor,
  isA,
  propertyAccessFor,
  classAccessFor,
  isDeprecatedEnumItem,
  dataVersion,
} from '../src/rbx/reflection.js';
import { validateModel } from '../src/rbx/validate.js';

function roundTrip(roots) {
  return deserializeModel(serializeModel(roots));
}

test('round-trips a folder tree with names and hierarchy', () => {
  const folder = new Instance('Folder', 'Root');
  const child = new Instance('Folder', 'Child');
  folder.addChild(child);
  child.addChild(new Instance('Part', 'Leaf'));

  const [root] = roundTrip([folder]);
  assert.equal(root.name, 'Root');
  assert.equal(root.className, 'Folder');
  assert.equal(root.children[0].name, 'Child');
  assert.equal(root.children[0].children[0].name, 'Leaf');
  assert.equal(root.children[0].children[0].getFullName(), 'Root.Child.Leaf');
});

test('round-trips BasePart properties including patched serialized names', () => {
  const part = new Instance('Part', 'P');
  part.set('Size', v3(4, 1, 2));
  part.set('Anchored', true);
  part.set('CanCollide', false);
  part.set('Color', { r: 1, g: 0.5, b: 0 });
  part.set('Transparency', 0.25);
  part.set('Material', 256);
  part.set('Shape', 0);

  const [p] = roundTrip([part]);
  assert.deepEqual(p.get('Size'), { x: 4, y: 1, z: 2 });
  assert.equal(p.get('Anchored'), true);
  assert.equal(p.get('CanCollide'), false);
  assert.equal(p.get('Transparency'), 0.25);
  assert.equal(p.get('Material'), 256);
  // Color is persisted as Color3uint8; 0.5 survives at byte precision.
  const color = p.get('Color');
  assert.ok(Math.abs(color.r - 1) < 1e-6);
  assert.ok(Math.abs(color.g - 0.5) < 0.01);
  assert.ok(Math.abs(color.b - 0) < 1e-6);
});

test('round-trips CFrame rotations exactly', () => {
  const part = new Instance('Part', 'P');
  part.set('CFrame', cframe(v3(1.5, -2, 3), [0, 0, 1, 1, 0, 0, 0, 1, 0]));
  const [p] = roundTrip([part]);
  const cf = p.get('CFrame');
  assert.deepEqual(cf.position, { x: 1.5, y: -2, z: 3 });
  assert.deepEqual(cf.rotation, [0, 0, 1, 1, 0, 0, 0, 1, 0]);
});

test('round-trips instance references', () => {
  const model = new Instance('Model', 'M');
  const primary = new Instance('Part', 'Primary');
  model.addChild(primary);
  model.set('PrimaryPart', primary);

  const [m] = roundTrip([model]);
  assert.equal(m.get('PrimaryPart'), m.children[0]);
});

test('round-trips sequences', () => {
  const emitter = new Instance('ParticleEmitter', 'E');
  emitter.set('Size', numberSequence([{ time: 0, value: 1, envelope: 0 }, { time: 1, value: 2, envelope: 0.5 }]));
  emitter.set('Color', colorSequence([{ time: 0, color: { r: 1, g: 0, b: 0 } }]));

  const [e] = roundTrip([emitter]);
  assert.equal(e.get('Size').keypoints.length, 2);
  assert.equal(e.get('Size').keypoints[1].value, 2);
  assert.equal(e.get('Color').keypoints[0].color.r, 1);
});

test('round-trips deeply nested trees', () => {
  const root = new Instance('Folder', 'A');
  let cur = root;
  for (let i = 0; i < 50; i++) {
    const next = new Instance('Folder', `N${i}`);
    cur.addChild(next);
    cur = next;
  }
  const [r] = roundTrip([root]);
  let depth = 0;
  let node = r;
  while (node.children.length) {
    node = node.children[0];
    depth++;
  }
  assert.equal(depth, 50);
  assert.equal(node.name, 'N49');
});

test('serialized names come from patches', () => {
  const ser = serializationFor('Part');
  assert.equal(ser.forward.get('Size').serializedName, 'size');
  assert.equal(ser.forward.get('Color').valueType, 'Color3uint8');
  assert.equal(ser.forward.get('Shape').serializedName, 'shape');
  assert.equal(ser.reverse.get('size').canonicalName, 'Size');
});

test('reflection knows class hierarchy', () => {
  assert.ok(isA('Part', 'BasePart'));
  assert.ok(isA('Part', 'Instance'));
  assert.ok(!isA('Folder', 'BasePart'));
  assert.ok(propertiesFor('Part').has('Anchored'));
  // Size is not in the engine's CanSave set; it is reachable via patches only.
  assert.ok(serializationFor('Part').forward.has('Size'));
});

// --- access flags from the API dump ----------------------------------------
//
// The dump records, per property, who may read and write it and whether it is
// read-only, deprecated, scriptable and replicated. Regenerating reflection.json
// with scripts/gen-reflection.mjs packs those into one integer per property.

test('access flags are present and cover the properties that need them', () => {
  const data = dataVersion();
  assert.equal(data.hasAccessFlags, true, 'reflection.json must carry access flags');
  assert.ok(data.annotatedProperties > 1000);
  assert.equal(data.hasDeprecatedEnumItems, true);
});

test('a normal property is writable from a game script', () => {
  for (const [cls, prop] of [
    ['Part', 'Anchored'],
    ['Part', 'Size'],
    ['Humanoid', 'Health'],
    ['Sound', 'Volume'],
  ]) {
    const access = propertyAccessFor(cls, prop);
    assert.equal(access.writeSecurity, 'None', `${cls}.${prop}`);
    assert.equal(access.writableFromGame, true, `${cls}.${prop}`);
    assert.equal(access.readOnly, false, `${cls}.${prop}`);
    assert.equal(access.deprecated, false, `${cls}.${prop}`);
  }
});

test('a property inherited from a base class reports its own flags', () => {
  // Anchored is declared on BasePart; asking about Part must still work.
  const onPart = propertyAccessFor('Part', 'Anchored');
  const onBase = propertyAccessFor('BasePart', 'Anchored');
  assert.deepEqual(onPart, onBase);
});

test('restricted write security is reported with the level that restricts it', () => {
  // Each level admits a different class of writer, and the distinction is the
  // whole point: a game script, a plugin, and the Studio command bar are three
  // different things, and "cannot be written" is only true of the right one.
  const cases = [
    // httpEnabled is a local-user setting: the command bar can set it, a game
    // script and a plugin cannot.
    ['HttpService', 'HttpEnabled', 'LocalUserSecurity', { game: false, plugin: false, studio: true }],
    // MeshPart.MeshId is delivered by the engine.
    ['MeshPart', 'MeshId', 'NotAccessibleSecurity', { game: false, plugin: false, studio: false }],
    // Engine-internal.
    ['Instance', 'UniqueId', 'RobloxSecurity', { game: false, plugin: false, studio: false }],
  ];
  for (const [cls, prop, level, expected] of cases) {
    const access = propertyAccessFor(cls, prop);
    assert.equal(access.writeSecurity, level, `${cls}.${prop}`);
    assert.equal(access.writableFromGame, expected.game, `${cls}.${prop} game`);
    assert.equal(access.writableFromPlugin, expected.plugin, `${cls}.${prop} plugin`);
    assert.equal(access.writableFromStudio, expected.studio, `${cls}.${prop} studio`);
  }
});

test('plugin security is distinguishable from game and studio access', () => {
  // 193 persisted properties need plugin security: writable from a new-CoreScript
  // style plugin, not from a game script.
  const access = propertyAccessFor('KeyframeSequence', 'AuthoredHipHeight');
  assert.equal(access.writeSecurity, 'PluginSecurity');
  assert.equal(access.writableFromGame, false);
  assert.equal(access.writableFromPlugin, true);
});

test('deprecated classes and properties are marked', () => {
  assert.equal(classAccessFor('Hat').deprecated, true);
  assert.equal(classAccessFor('Part').deprecated, false);

  assert.equal(propertyAccessFor('Part', 'BackParamA').deprecated, true);
  assert.equal(propertyAccessFor('Part', 'Anchored').deprecated, false);
});

test('deprecated enum items are marked', () => {
  assert.equal(isDeprecatedEnumItem('AlignType', 'Parallel'), true);
  assert.equal(isDeprecatedEnumItem('AlignType', 'AllAxes'), false);
  assert.equal(isDeprecatedEnumItem('Material', 'Concrete'), false);
});

test('an unknown property reports recorded:false rather than inventing flags', () => {
  const access = propertyAccessFor('Part', 'NotAPropertyAtAll');
  assert.equal(access.recorded, false);
  assert.equal(access.writableFromGame, true);
});

test('the validator warns about a deprecated property but not about its default', () => {
  const model = new Instance('Model', 'M');
  const part = new Instance('Part', 'P');
  part.set('BackParamA', 5); // deprecated, set to a real value
  part.set('BackParamB', 0); // deprecated, but this is the default
  model.addChild(part);

  const codes = validateModel([model]).diagnostics.map((d) => d.code);
  assert.equal(codes.filter((c) => c === 'deprecated-property').length, 1, codes.join(', '));
});

test('a restricted property set to a real value is reported as write-restricted', () => {
  const model = new Instance('Model', 'M');
  const service = new Instance('HttpService', 'HttpService');
  service.set('HttpEnabled', true);
  model.addChild(service);

  const found = validateModel([model]).diagnostics.find((d) => d.code === 'write-restricted');
  assert.ok(found, 'expected write-restricted');
  assert.equal(found.severity, 'warning');
  assert.match(found.message, /LocalUserSecurity/);
  assert.ok(found.note.includes('plugin') || found.note.includes('model'));
});

test('the validator warns about a deprecated class and still validates it', () => {
  const model = new Instance('Model', 'M');
  model.addChild(new Instance('Hat', 'H'));
  const result = validateModel([model]);
  const found = result.diagnostics.find((d) => d.code === 'deprecated-class');
  assert.ok(found, 'expected deprecated-class');
  assert.equal(found.severity, 'warning', 'an existing file full of Hat must still open');
  assert.ok(!result.diagnostics.some((d) => d.severity === 'error'));
});
