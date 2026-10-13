import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeXml, deserializeXml } from '../src/rbx/xml.js';
import { Instance } from '../src/rbx/instance.js';
import { v3, cframe } from '../src/rbx/datatypes.js';
import { parseXml, serializeXml as toXmlString, XmlElement } from '../src/util/xml.js';

function roundTrip(roots) {
  return deserializeXml(serializeXml(roots));
}

test('xml parser handles attributes, text, entities and nesting', () => {
  const doc = '<?xml version="1.0"?><a x="1"><b>hi &amp; bye</b><c/></a>';
  const root = parseXml(doc);
  assert.equal(root.name, 'a');
  assert.equal(root.attr('x'), '1');
  assert.equal(root.find('b').text, 'hi & bye');
  assert.equal(root.find('c').children.length, 0);
});

test('xml serializer escapes text and attributes', () => {
  const el = new XmlElement('a', { q: 'x"y' });
  el.text = '<b>';
  const out = toXmlString(el);
  assert.match(out, /q="x&quot;y"/);
  assert.match(out, /&lt;b&gt;/);
});

test('round-trips a folder tree through xml', () => {
  const folder = new Instance('Folder', 'Root');
  const child = new Instance('Part', 'P');
  child.set('Size', v3(2, 3, 4));
  child.set('Anchored', true);
  folder.addChild(child);

  const [root] = roundTrip([folder]);
  assert.equal(root.name, 'Root');
  assert.equal(root.children[0].name, 'P');
  assert.deepEqual(root.children[0].get('Size'), { x: 2, y: 3, z: 4 });
  assert.equal(root.children[0].get('Anchored'), true);
});

test('xml writes patched serialized names', () => {
  const part = new Instance('Part', 'P');
  part.set('Size', v3(1, 1, 1));
  const xml = serializeXml([part]);
  assert.match(xml, /<Vector3 name="size">/);
  assert.match(xml, /<Color3uint8 name="Color">/);
});

test('xml round-trips CFrame and Color', () => {
  const part = new Instance('Part', 'P');
  part.set('CFrame', cframe(v3(1, 2, 3), [0, 1, 0, -1, 0, 0, 0, 0, 1]));
  part.set('Color', { r: 1, g: 0, b: 0 });
  const [p] = roundTrip([part]);
  assert.deepEqual(p.get('CFrame').position, { x: 1, y: 2, z: 3 });
  assert.deepEqual(p.get('CFrame').rotation, [0, 1, 0, -1, 0, 0, 0, 0, 1]);
  assert.ok(Math.abs(p.get('Color').r - 1) < 1e-6);
});

test('xml round-trips refs and enums', () => {
  const model = new Instance('Model', 'M');
  const part = new Instance('Part', 'Primary');
  part.set('Material', 256);
  model.addChild(part);
  model.set('PrimaryPart', part);

  const [m] = roundTrip([model]);
  assert.equal(m.get('PrimaryPart'), m.children[0]);
  assert.equal(m.children[0].get('Material'), 256);
});
