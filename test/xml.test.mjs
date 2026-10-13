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

test('the entity fast paths do not change what is written', () => {
  // Both encoders skip work when a string has nothing to escape. The output
  // must be identical either way, so the escaping rules are pinned here.
  const withText = (text) => {
    const el = new XmlElement('t');
    el.text = text;
    return toXmlString(el, { declaration: false });
  };
  assert.equal(withText('plain text'), '<t>plain text</t>\n');
  assert.equal(
    withText('a < b & c > d "e" \'f\''),
    '<t>a &lt; b &amp; c &gt; d &quot;e&quot; \'f\'</t>\n',
  );
  assert.equal(parseXml('<t>a &lt; b &amp; c &gt; d &quot;e&quot;</t>').text, 'a < b & c > d "e"');
  assert.equal(parseXml('<t>plain &amp; simple</t>').text, 'plain & simple');
  // An ampersand that is not an entity is left exactly as written.
  assert.equal(parseXml('<t>a & b</t>').text, 'a & b');
  assert.equal(parseXml('<t>&#65;&#x42;</t>').text, 'AB');
});

test('exotic characters survive a round trip through xml', () => {
  // Unicode, quotes, angle brackets and control characters in a name and a
  // script body, which is where an encoder fast path could go wrong.
  const script = new Instance('ModuleScript', 'Esc&<>"\'');
  script.set('Source', 'local s = "a & b < c > d \\"quoted\\""\nlocal uni = "héllo → 日本語 🚀"\nreturn s\n');
  const folder = new Instance('Folder', 'a<b>c&d"e\'f');
  folder.addChild(script);
  const [back] = deserializeXml(serializeXml([folder]));
  assert.equal(back.name, 'a<b>c&d"e\'f');
  assert.equal(back.children[0].name, 'Esc&<>"\'');
  assert.equal(back.children[0].get('Source'), script.get('Source'));
});

test('whitespace outside of tags is skipped, whitespace in text is not', () => {
  const el = parseXml('<a>\n  <b>  spaced  </b>\n  <c />\n</a>');
  assert.equal(el.find('b').text, '  spaced  ');
  assert.equal(el.findAll('c').length, 1);
  assert.equal(parseXml('<a\n  b="1"\n  c = \'2\'\n/>').attr('c'), '2');
});
