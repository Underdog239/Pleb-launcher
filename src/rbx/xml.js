// Roblox XML model codec (rbxmx / rbxlx).
//
// Property element names follow Roblox's XML schema; enums are written as
// <token> with the numeric value, and refs as <Ref>RBXn</Ref>.

import { XmlElement, parseXml, serializeXml as toXmlString } from '../util/xml.js';
import { Instance } from './instance.js';
import { isEnumValueType, serializationFor, enumValue } from './reflection.js';
import { IDENTITY_ROTATION, isDefaultish } from './datatypes.js';

const ELEM = {
  bool: 'bool',
  int: 'int',
  int64: 'int64',
  float: 'float',
  double: 'double',
  string: 'string',
  BinaryString: 'BinaryString',
  ContentId: 'ContentId',
  ProtectedString: 'ProtectedString',
  Content: 'Content',
  Vector2: 'Vector2',
  Vector3: 'Vector3',
  Vector3int16: 'Vector3int16',
  CFrame: 'CoordinateFrame',
  Color3: 'Color3',
  Color3uint8: 'Color3uint8',
  UDim: 'UDim',
  UDim2: 'UDim2',
  Ray: 'Ray',
  Faces: 'Faces',
  Axes: 'Axes',
  BrickColor: 'BrickColor',
  NumberSequence: 'NumberSequence',
  ColorSequence: 'ColorSequence',
  NumberRange: 'NumberRange',
  Rect: 'Rect',
  PhysicalProperties: 'PhysicalProperties',
  Font: 'Font',
  SecurityCapabilities: 'SecurityCapabilities',
  SharedString: 'SharedString',
  UniqueId: 'UniqueId',
  Instance: 'Ref',
};

const num = (v) => (typeof v === 'number' ? v : 0);

/**
 * Roblox's Faces bitmask, in the enum's declaration order.
 * Right=1, Top=2, Back=4, Left=8, Bottom=16, Front=32.
 */
const FACES = { Right: 1, Top: 2, Back: 4, Left: 8, Bottom: 16, Front: 32 };

/** Axes bitmask: X=1, Y=2, Z=4. */
const AXES = { X: 1, Y: 2, Z: 4 };

const bitOf = (value, bit) => (((num(value) | 0) & bit) !== 0 ? 'true' : 'false');

/**
 * Value types this codec writes faithfully, as `<Tag name="...">`.
 *
 * Anything outside this set is either dropped or written in a form Studio will
 * not read back, so the writer reports it instead of guessing. Keeping the list
 * explicit (rather than inferring it from the switch below) is what lets the
 * validator warn *before* a file is written; `test/xml-types.test.mjs` proves
 * every entry here actually round-trips.
 */
export const xmlValueTypes = new Set([
  'bool', 'int', 'int64', 'float', 'double', 'string',
  'BinaryString', 'ContentId', 'ProtectedString', 'Content',
  'Vector2', 'Vector3', 'Vector3int16', 'CFrame',
  'Color3', 'Color3uint8', 'UDim', 'UDim2',
  'Ray', 'Faces', 'Axes', 'BrickColor',
  'NumberSequence', 'ColorSequence', 'NumberRange', 'Rect',
  'PhysicalProperties', 'Font', 'Instance',
  // SharedString is deliberately absent: rbx_xml stores it in a shared string
  // table we have not verified, so it is reported rather than guessed at.
]);

/** Can this value type be written to .rbxmx/.rbxlx without losing information? */
export function xmlSupports(valueType) {
  return xmlValueTypes.has(valueType);
}

function sub(name, text) {
  const el = new XmlElement(name);
  el.text = text === undefined || text === null ? '' : String(text);
  return el;
}

function packColor3uint8(v) {
  const r = Math.max(0, Math.min(255, Math.round(num(v && v.r) * 255)));
  const g = Math.max(0, Math.min(255, Math.round(num(v && v.g) * 255)));
  const b = Math.max(0, Math.min(255, Math.round(num(v && v.b) * 255)));
  return ((0xff << 24) | (r << 16) | (g << 8) | b) >>> 0;
}

function unpackColor3uint8(value) {
  const v = Number(value) >>> 0;
  return { r: ((v >> 16) & 0xff) / 255, g: ((v >> 8) & 0xff) / 255, b: (v & 0xff) / 255 };
}

function encodeVec3(name, v) {
  const el = new XmlElement(name);
  el.children.push(sub('X', num(v && v.x)), sub('Y', num(v && v.y)), sub('Z', num(v && v.z)));
  return el;
}

/**
 * Build the property element for one property.
 *
 * `record` is false when the property is not set on the instance: the codec
 * still writes a default for it (existing behaviour), but a type it cannot
 * represent is only worth reporting if somebody actually set it.
 */
function encodeProperty(serializedName, valueType, value, ctx, record = true, isEnum = null) {
  const report = (suffix) => {
    if (record) ctx?.unsupported?.add(`${serializedName}:${suffix}`);
  };
  // Prefer the caller's resolved answer; fall back to the name for direct calls.
  const enumType = isEnum === null ? isEnumValueType(valueType) : isEnum;
  const tag = enumType ? 'token' : ELEM[valueType] || 'string';
  const el = new XmlElement(tag, { name: serializedName });

  if (enumType) {
    el.text = String(num(value));
    return el;
  }

  switch (valueType) {
    case 'bool':
      el.text = value ? 'true' : 'false';
      break;
    case 'int':
    case 'int64':
    case 'float':
    case 'double':
      el.text = String(num(value));
      break;
    case 'string':
      el.text = value == null ? '' : String(value);
      break;
    case 'BinaryString':
      el.text = Buffer.from(value || []).toString('base64');
      break;
    case 'Content': {
      const url = new XmlElement('url');
      url.text = value && value.source === 'uri' ? String(value.value) : '';
      el.children.push(url);
      break;
    }
    case 'Vector2':
      el.children.push(sub('X', num(value && value.x)), sub('Y', num(value && value.y)));
      break;
    case 'Vector3':
      el.children.push(
        sub('X', num(value && value.x)),
        sub('Y', num(value && value.y)),
        sub('Z', num(value && value.z)),
      );
      break;
    case 'Vector3int16':
      el.children.push(
        sub('X', Math.round(num(value && value.x))),
        sub('Y', Math.round(num(value && value.y))),
        sub('Z', Math.round(num(value && value.z))),
      );
      break;
    case 'CFrame': {
      const rot = (value && value.rotation) || IDENTITY_ROTATION;
      el.children.push(
        sub('X', num(value && value.position && value.position.x)),
        sub('Y', num(value && value.position && value.position.y)),
        sub('Z', num(value && value.position && value.position.z)),
      );
      for (let i = 0; i < 9; i++) {
        el.children.push(sub(`R${Math.floor(i / 3)}${i % 3}`, num(rot[i])));
      }
      break;
    }
    case 'Color3':
      el.children.push(
        sub('R', num(value && value.r)),
        sub('G', num(value && value.g)),
        sub('B', num(value && value.b)),
      );
      break;
    case 'Color3uint8':
      el.text = String(packColor3uint8(value));
      break;
    case 'UDim':
      el.children.push(
        sub('S', num(value && value.scale)),
        sub('O', Math.round(num(value && value.offset))),
      );
      break;
    case 'UDim2':
      el.children.push(
        sub('XS', num(value && value.x && value.x.scale)),
        sub('XO', Math.round(num(value && value.x && value.x.offset))),
        sub('YS', num(value && value.y && value.y.scale)),
        sub('YO', Math.round(num(value && value.y && value.y.offset))),
      );
      break;
    case 'Rect': {
      const mn = new XmlElement('min');
      mn.children.push(
        sub('X', num(value && value.min && value.min.x)),
        sub('Y', num(value && value.min && value.min.y)),
      );
      const mx = new XmlElement('max');
      mx.children.push(
        sub('X', num(value && value.max && value.max.x)),
        sub('Y', num(value && value.max && value.max.y)),
      );
      el.children.push(mn, mx);
      break;
    }
    case 'Ray':
      el.children.push(
        encodeVec3('origin', value && value.origin),
        encodeVec3('direction', value && value.direction),
      );
      break;
    // Faces and Axes are bitmasks whose bits follow the enum's declaration
    // order. This used to write `false` for every child regardless of the
    // value, so a part with the top face on came back with no faces at all.
    case 'Faces':
      for (const [name, bit] of Object.entries(FACES)) el.children.push(sub(name, bitOf(value, bit)));
      break;
    case 'Axes':
      for (const [name, bit] of Object.entries(AXES)) el.children.push(sub(name, bitOf(value, bit)));
      break;
    case 'BrickColor':
      el.text = String(Math.round(num(value)));
      break;
    case 'Instance':
      el.text = value && ctx.referent.has(value) ? `RBX${ctx.referent.get(value)}` : 'null';
      break;
    case 'NumberSequence':
      for (const kp of (value && value.keypoints) || []) {
        const k = new XmlElement('K');
        k.children.push(
          sub('time', num(kp.time)),
          sub('Value', num(kp.value)),
          sub('envelope', num(kp.envelope)),
        );
        el.children.push(k);
      }
      break;
    case 'ColorSequence':
      for (const kp of (value && value.keypoints) || []) {
        const k = new XmlElement('K');
        const val = new XmlElement('Value');
        val.children.push(
          sub('R', num(kp.color && kp.color.r)),
          sub('G', num(kp.color && kp.color.g)),
          sub('B', num(kp.color && kp.color.b)),
        );
        k.children.push(sub('time', num(kp.time)), val, sub('envelope', 0));
        el.children.push(k);
      }
      break;
    case 'NumberRange':
      el.children.push(sub('Min', num(value && value.min)), sub('Max', num(value && value.max)));
      break;
    case 'PhysicalProperties':
      el.children.push(sub('CustomPhysics', value ? 'true' : 'false'));
      if (value) {
        el.children.push(
          sub('Density', num(value.density)),
          sub('Friction', num(value.friction)),
          sub('Elasticity', num(value.elasticity)),
          sub('FrictionWeight', num(value.frictionWeight)),
          sub('ElasticityWeight', num(value.elasticityWeight)),
        );
      }
      break;
    case 'Font':
      el.children.push(
        sub('Family', (value && value.family) || ''),
        sub('Weight', num(value && value.weight)),
        sub('Style', num(value && value.style)),
        sub('CachedFaceId', (value && value.cachedFaceId) || ''),
      );
      break;
    case 'SecurityCapabilities':
    case 'UniqueId':
      // rbx_xml uses a fixed-width textual form we have not verified, so we
      // refuse rather than invent one. Reporting beats a plausible-looking
      // wrong value, which is the whole point of this project.
      report(valueType);
      return null;

    case 'ContentId':
    case 'ProtectedString':
      el.text = value == null ? '' : String(value);
      break;

    default:
      // An unrecognised type would be stringified into a value Studio cannot
      // read back. Say so instead of writing it.
      report(valueType);
      el.text = value == null ? '' : String(value);
  }
  return el;
}

export { encodeProperty, ELEM, packColor3uint8, unpackColor3uint8, sub, num };

// --- decoding ---------------------------------------------------------------

const textOf = (el) => (el ? el.text.trim() : '');
const numOf = (el) => Number(textOf(el)) || 0;
const boolOf = (el) => textOf(el).toLowerCase() === 'true';

const ELEM_REVERSE = Object.fromEntries(Object.entries(ELEM).map(([k, v]) => [v, k]));

function named(el, name) {
  el.attrs.name = name;
  return el;
}

function decodeProperty(el, valueType, ctx, isEnum = null) {
  const enumType = isEnum === null ? isEnumValueType(valueType) : isEnum;
  if (enumType) {
    const raw = textOf(el);
    const asNumber = raw === '' ? NaN : Number(raw);
    if (Number.isFinite(asNumber)) return asNumber;
    const v = enumValue(valueType, raw);
    return v === undefined ? 0 : v;
  }
  switch (valueType) {
    case 'bool':
      return boolOf(el);
    case 'int':
    case 'int64':
    case 'float':
    case 'double':
      return numOf(el);
    case 'string':
      return el.text;
    case 'BinaryString':
      return Uint8Array.from(Buffer.from(textOf(el), 'base64'));
    case 'Content': {
      const u = el.find('url');
      const uri = u ? u.text : '';
      return { source: uri ? 'uri' : 'none', value: uri };
    }
    case 'Vector2':
      return { x: numOf(el.find('X')), y: numOf(el.find('Y')) };
    case 'Vector3':
    case 'Vector3int16':
      return { x: numOf(el.find('X')), y: numOf(el.find('Y')), z: numOf(el.find('Z')) };
    case 'CFrame': {
      const rotation = [];
      for (let i = 0; i < 9; i++) rotation.push(numOf(el.find(`R${Math.floor(i / 3)}${i % 3}`)));
      return {
        position: { x: numOf(el.find('X')), y: numOf(el.find('Y')), z: numOf(el.find('Z')) },
        rotation,
      };
    }
    case 'Color3':
      return { r: numOf(el.find('R')), g: numOf(el.find('G')), b: numOf(el.find('B')) };
    case 'Color3uint8':
      return unpackColor3uint8(textOf(el));
    case 'UDim':
      return { scale: numOf(el.find('S')), offset: numOf(el.find('O')) };
    case 'UDim2':
      return {
        x: { scale: numOf(el.find('XS')), offset: numOf(el.find('XO')) },
        y: { scale: numOf(el.find('YS')), offset: numOf(el.find('YO')) },
      };
    case 'Rect': {
      const mn = el.find('min');
      const mx = el.find('max');
      return {
        min: { x: numOf(mn && mn.find('X')), y: numOf(mn && mn.find('Y')) },
        max: { x: numOf(mx && mx.find('X')), y: numOf(mx && mx.find('Y')) },
      };
    }
    case 'Ray': {
      const o = el.find('origin');
      const d = el.find('direction');
      return {
        origin: { x: numOf(o && o.find('X')), y: numOf(o && o.find('Y')), z: numOf(o && o.find('Z')) },
        direction: { x: numOf(d && d.find('X')), y: numOf(d && d.find('Y')), z: numOf(d && d.find('Z')) },
      };
    }
    case 'Faces': {
      let bits = 0;
      for (const [name, bit] of Object.entries(FACES)) if (boolOf(el.find(name))) bits |= bit;
      return bits;
    }
    case 'Axes': {
      let bits = 0;
      for (const [name, bit] of Object.entries(AXES)) if (boolOf(el.find(name))) bits |= bit;
      return bits;
    }
    case 'BrickColor':
      return numOf(el);
    case 'NumberSequence':
      return {
        keypoints: el.findAll('K').map((k) => ({
          time: numOf(k.find('time')),
          value: numOf(k.find('Value')),
          envelope: numOf(k.find('envelope')),
        })),
      };
    case 'ColorSequence':
      return {
        keypoints: el.findAll('K').map((k) => {
          const v = k.find('Value');
          return {
            time: numOf(k.find('time')),
            color: {
              r: numOf(v && v.find('R')),
              g: numOf(v && v.find('G')),
              b: numOf(v && v.find('B')),
            },
          };
        }),
      };
    case 'NumberRange':
      return { min: numOf(el.find('Min')), max: numOf(el.find('Max')) };
    case 'PhysicalProperties':
      return boolOf(el.find('CustomPhysics'))
        ? {
            density: numOf(el.find('Density')),
            friction: numOf(el.find('Friction')),
            elasticity: numOf(el.find('Elasticity')),
            frictionWeight: numOf(el.find('FrictionWeight')),
            elasticityWeight: numOf(el.find('ElasticityWeight')),
          }
        : null;
    case 'Font':
      return {
        family: textOf(el.find('Family')),
        weight: numOf(el.find('Weight')),
        style: numOf(el.find('Style')),
        cachedFaceId: textOf(el.find('CachedFaceId')),
      };
    case 'SecurityCapabilities':
      return Number(textOf(el)) || 0;
    case 'UniqueId':
      return { index: Number(textOf(el)) || 0, time: 0, random: 0 };
    case 'Instance':
      return ctx.byReferent.get(textOf(el)) || null;
    default:
      return el.text;
  }
}


/** Parse an rbxmx/rbxlx document into root instances. */
export function deserializeXml(text) {
  const root = parseXml(text);
  const byReferent = new Map();
  const roots = [];
  const nodes = [];

  const walk = (itemEl, parent) => {
    const inst = new Instance(itemEl.attr('class') || 'Folder');
    const ref = itemEl.attr('referent');
    if (ref) byReferent.set(ref, inst);
    if (parent) parent.addChild(inst);
    else roots.push(inst);
    nodes.push({ inst, itemEl });
    for (const child of itemEl.findAll('Item')) walk(child, inst);
  };

  for (const itemEl of root.findAll('Item')) walk(itemEl, null);

  // Second pass: references may point at instances declared later, so all
  // instances must exist before properties are decoded.
  for (const { inst, itemEl } of nodes) {
    const propsEl = itemEl.find('Properties');
    if (!propsEl) continue;
    const ser = serializationFor(inst.className);
    for (const propEl of propsEl.children) {
      const propName = propEl.attr('name');
      if (!propName) continue;
      const rev = ser.reverse.get(propName);
      const canonical = rev ? rev.canonicalName : propName;
      const valueType = rev ? rev.valueType : ELEM_REVERSE[propEl.name] || 'string';
      // The stored name alone cannot tell an enum from a datatype of the same
      // name, so pass the reflection layer's answer through.
      const value = decodeProperty(propEl, valueType, { byReferent }, rev ? rev.isEnum : null);
      if (canonical === 'Name') inst.name = String(value);
      else inst.props.set(canonical, value);
    }
  }

  return roots;
}

/** Serialize root instances to an rbxmx/rbxlx document. */
export function serializeXml(roots, options = {}) {
  const all = [];
  const visit = (i) => {
    all.push(i);
    for (const c of i.children) visit(c);
  };
  for (const r of roots) visit(r);

  const referent = new Map();
  all.forEach((inst, i) => referent.set(inst, i));
  const ctx = { referent, unsupported: new Set() };

  const root = new XmlElement('roblox', {
    'xmlns:xmime': 'http://www.w3.org/2005/05/xmlmime',
    'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
    'xsi:noNamespaceSchemaLocation': 'http://www.roblox.com/roblox.xsd',
    version: '4',
  });

  const build = (inst) => {
    const itemEl = new XmlElement('Item', {
      class: inst.className,
      referent: `RBX${referent.get(inst)}`,
    });
    const propsEl = new XmlElement('Properties');
    propsEl.children.push(named(sub('string', inst.name), 'Name'));

    const ser = serializationFor(inst.className);
    for (const canonical of [...ser.forward.keys()].filter((n) => n !== 'Name').sort()) {
      const { serializedName, valueType, isEnum } = ser.forward.get(canonical);
      const propEl = encodeProperty(
        serializedName,
        valueType,
        inst.props.get(canonical),
        ctx,
        !isDefaultish(inst.props.get(canonical)),
        isEnum,
      );
      if (propEl) propsEl.children.push(propEl);
    }

    itemEl.children.push(propsEl);
    for (const child of inst.children) itemEl.children.push(build(child));
    return itemEl;
  };

  for (const r of roots) root.children.push(build(r));

  // Mirror the binary writer: a property that could not be written faithfully
  // is reported, never lost in silence.
  if (ctx.unsupported.size > 0) {
    const dropped = [...ctx.unsupported].sort();
    if (options.onUnsupported) options.onUnsupported(dropped);
    if (options.strictUnsupported) {
      throw new Error(`rbx: ${dropped.length} property/properties have no faithful XML form: ${dropped.join(', ')}`);
    }
  }

  // rbx_xml (and Rojo) omit the XML declaration; some readers sniff on it.
  return toXmlString(root, { declaration: false, ...options });
}

export { ELEM_REVERSE };

