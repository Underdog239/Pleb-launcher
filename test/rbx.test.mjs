import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeModel, deserializeModel } from '../src/rbx/binary.js';
import { Instance } from '../src/rbx/instance.js';
import { v3, cframe, numberSequence, colorSequence } from '../src/rbx/datatypes.js';
import { propertiesFor, serializationFor, isA } from '../src/rbx/reflection.js';

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
