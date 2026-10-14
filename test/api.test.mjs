import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeClass,
  describeEnum,
  classesWithProperty,
  searchApi,
  kindOf,
  apiDataInfo,
} from '../src/rbx/api.js';
import { db, serializationFor, allPropertiesFor } from '../src/rbx/reflection.js';

test('a class reports its chain, whether it is creatable, and whether it is a service', () => {
  const sound = describeClass('Sound');
  assert.equal(sound.found, true);
  assert.equal(sound.superclass, 'Instance');
  assert.equal(sound.creatable, true);
  assert.equal(sound.isService, false);
  assert.deepEqual(sound.superchain, ['Sound', 'Instance', 'Object', '<<<ROOT>>>']);

  assert.equal(describeClass('Workspace').isService, true);
  assert.equal(describeClass('Workspace').creatable, false, 'the engine provides services');
  assert.equal(describeClass('DataModel').superclass, 'ServiceProvider');
});

test('a class that does not exist says so and suggests the closest one', () => {
  const missing = describeClass('Sund');
  assert.equal(missing.found, false);
  assert.deepEqual(missing.suggestions, ['Sound']);
  assert.equal(describeClass('ZzzzzzNotAClass').suggestions.length, 0);
});

test('a class listing separates what is saved from what is only at runtime', () => {
  const sound = describeClass('Sound');
  const saved = sound.properties.map((p) => p.name);
  const runtime = sound.runtimeProperties.map((p) => p.name);

  assert.ok(saved.includes('SoundId'));
  assert.ok(saved.includes('Volume'));
  assert.ok(saved.includes('RollOffMode'));
  // Deprecated aliases exist at runtime but are never written.
  assert.ok(runtime.includes('Pitch'));
  assert.ok(runtime.includes('MinDistance'));
  assert.ok(!saved.includes('Pitch'));

  // Every entry in the saved list really is persisted, and vice versa: the list
  // is generated from the same data the codec uses, so it cannot drift.
  const forward = serializationFor('Sound').forward;
  for (const prop of sound.properties) {
    assert.ok(forward.has(prop.name), `${prop.name} is listed as saved but is not serializable`);
    assert.equal(prop.saved, true);
  }
  assert.equal(sound.savedCount, sound.properties.length);
  for (const prop of sound.runtimeProperties) {
    assert.ok(!forward.has(prop.name), `${prop.name} is listed as runtime-only but is serializable`);
  }
});

test('dump-internal entries are counted, and only listed when asked for', () => {
  const without = describeClass('Object');
  assert.equal(without.hiddenProperties, undefined);
  assert.ok(without.hiddenCount > 0, 'Object carries dump-internal names');
  assert.deepEqual(without.properties, []);

  const withAll = describeClass('Object', { all: true });
  assert.equal(withAll.hiddenProperties.length, withAll.hiddenCount);
  const hidden = withAll.hiddenProperties.map((p) => p.name);
  assert.ok(hidden.includes('ClassName'));
});

test('serialized aliases are folded into the property they belong to', () => {
  const sound = describeClass('Sound');
  // The dump has a lowercase `archivable`; the property an agent writes is
  // Archivable, and the lowercase spelling must not appear as a separate entry.
  const names = [...sound.properties, ...sound.runtimeProperties].map((p) => p.name);
  assert.ok(!names.includes('archivable'));

  const part = describeClass('Part');
  const size = part.properties.find((p) => p.name === 'Size');
  assert.equal(size.type, 'Vector3');
  assert.equal(size.serializedName, 'size', 'the real serialized spelling is reported');
  const color = part.properties.find((p) => p.name === 'Color');
  assert.equal(color.serializedName, 'Color');
});

test('enum-ness is resolved per property, not per type name', () => {
  // `Font` is both a legacy enum and a datatype; the answer depends on the
  // property, and reporting it wrong would send an agent to write the wrong
  // value shape.
  const label = describeClass('TextLabel');
  const all = [...label.properties, ...label.runtimeProperties];
  const font = all.find((p) => p.name === 'Font');
  const fontFace = all.find((p) => p.name === 'FontFace');
  assert.equal(font.enum, true);
  assert.equal(fontFace.enum, false);

  assert.equal(describeClass('Sound').properties.find((p) => p.name === 'RollOffMode').enum, true);
  assert.equal(describeClass('Sound').properties.find((p) => p.name === 'SoundId').enum, false);
});

test('references are reported with the class they must point at', () => {
  const ov = describeClass('ObjectValue').properties.find((p) => p.name === 'Value');
  assert.equal(ov.referenceTo, 'Instance');

  const model = describeClass('Model').properties.find((p) => p.name === 'PrimaryPart');
  assert.equal(model.referenceTo, 'BasePart');
});

test('an enum reports every item in numeric order', () => {
  const material = describeEnum('Material');
  assert.equal(material.found, true);
  assert.equal(material.count, Object.keys(db().enums.Material).length);
  assert.equal(material.items[0].name, 'Plastic');
  assert.equal(material.items[0].value, 256);
  for (let i = 1; i < material.items.length; i++) {
    assert.ok(material.items[i].value >= material.items[i - 1].value, 'items must be in numeric order');
  }

  const partType = describeEnum('PartType');
  assert.deepEqual(partType.items.map((i) => `${i.name}=${i.value}`), [
    'Ball=0',
    'Block=1',
    'Cylinder=2',
    'Wedge=3',
    'CornerWedge=4',
  ]);
});

test('a missing enum suggests the closest one', () => {
  const missing = describeEnum('Materail');
  assert.equal(missing.found, false);
  assert.deepEqual(missing.suggestions, ['Material']);
});

test('classesWithProperty finds the declaring class first', () => {
  const health = classesWithProperty('Health');
  assert.equal(health.found, true);
  assert.equal(health.declaringClass, 'Humanoid');
  assert.equal(health.type, 'float');
  assert.equal(health.classes[0].className, 'Humanoid');

  // A property declared on a base class: the declarer is BasePart, and the
  // subclasses that merely inherit it follow.
  const anchored = classesWithProperty('Anchored');
  assert.equal(anchored.declaringClass, 'BasePart');
  assert.equal(anchored.classes[0].className, 'BasePart');
  assert.ok(anchored.classes.length > 1);
  assert.ok(anchored.classes.some((c) => c.className === 'Part' && c.declaringClass === 'BasePart'));
});

test('classesWithProperty suggests a real property when the name is wrong', () => {
  const missing = classesWithProperty('Sizee');
  assert.equal(missing.found, false);
  assert.deepEqual(missing.suggestions, ['Size']);
  assert.deepEqual(classesWithProperty('Zzzzzzz').suggestions, []);
});

test('every property it reports is really on the class it names', () => {
  // Guards the index against an off-by-one or a stale cache.
  const result = classesWithProperty('SoundId');
  for (const entry of result.classes) {
    assert.ok(
      allPropertiesFor(entry.className).has('SoundId'),
      `${entry.className} does not have SoundId`,
    );
  }
  assert.ok(result.classes.some((c) => c.className === 'Sound'));
});

test('search covers classes, enums, enum items and properties', () => {
  const spawn = searchApi('spawn');
  assert.ok(spawn.classes.some((c) => c.name === 'SpawnLocation'));
  assert.ok(spawn.classes.every((c) => c.name.toLowerCase().includes('spawn')), 'every class must match');

  const anchor = searchApi('anchor');
  assert.ok(anchor.properties.some((p) => p.name === 'Anchored'), 'properties are searched too');

  const concrete = searchApi('Concrete');
  assert.ok(concrete.enumItems.some((i) => i.enum === 'Material' && i.name === 'Concrete'));

  const material = searchApi('Material');
  assert.ok(material.enums.some((e) => e.name === 'Material'));
});

test('search results honour the limit and say when they were cut', () => {
  const limited = searchApi('a', { limit: 3 });
  assert.ok(limited.classes.length <= 3);
  assert.ok(limited.properties.length <= 3);
  assert.equal(limited.truncated, true);

  const empty = searchApi('');
  assert.deepEqual(empty.classes, []);
  assert.deepEqual(empty.properties, []);
  assert.equal(empty.truncated, false);

  const nothing = searchApi('zzzzzzzzzz');
  assert.deepEqual(nothing.classes, []);
  assert.deepEqual(nothing.properties, []);
  assert.equal(nothing.truncated, false);
});

test('kindOf reports whether a name is a class, an enum, or both', () => {
  assert.equal(kindOf('Part'), 'class');
  assert.equal(kindOf('Material'), 'enum');
  assert.equal(kindOf('Font'), 'both', 'Font is both an enum and a datatype');
  assert.equal(kindOf('Vector3'), 'datatype');
  assert.equal(kindOf('CFrame'), 'datatype');
  assert.equal(kindOf('NotAThing'), null);
});

test('a class listing is stable under a shared cache', () => {
  // These functions run on a memoized reflection layer, so calling them twice
  // must not mutate what was returned the first time.
  const first = describeClass('Part');
  const snapshot = JSON.stringify(first.properties);
  describeClass('Part');
  assert.equal(JSON.stringify(first.properties), snapshot);
  assert.equal(describeClass('Part').savedCount, first.savedCount);
});

test('a class listing says which properties a game script cannot write', () => {
  const http = describeClass('HttpService');
  const enabled = http.properties.find((p) => p.name === 'HttpEnabled');
  assert.equal(enabled.writableFromGame, false);
  assert.equal(enabled.writeSecurity, 'LocalUserSecurity');
  // A normal property on the same class reports the opposite.
  const name = http.properties.find((p) => p.name === 'Name');
  assert.equal(name.writableFromGame, true);
});

test('deprecation is reported for classes, properties and enum items', () => {
  assert.equal(describeClass('Hat').deprecated, true);
  assert.equal(describeClass('Part').deprecated, false);
  assert.equal(describeClass('Part').properties.find((p) => p.name === 'BackParamA').deprecated, true);

  const align = describeEnum('AlignType');
  assert.equal(align.deprecatedCount, 2);
  assert.deepEqual(
    align.items.filter((i) => i.deprecated).map((i) => i.name),
    ['Parallel', 'Perpendicular'],
  );
  assert.equal(describeEnum('Material').deprecatedCount, 0);
});

test('apiDataInfo reports what the dataset actually contains', () => {
  const info = apiDataInfo();
  assert.equal(info.classCount, 935);
  assert.equal(info.enumCount, 648);
  assert.equal(info.hasAccessFlags, true);
  assert.equal(info.hasDeprecatedEnumItems, true);
  assert.ok(info.enumItemCount > 3000);
  assert.match(info.source, /API Dump/);
});
