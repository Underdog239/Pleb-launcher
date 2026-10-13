// Reflection database access: class hierarchy, serializable properties, enums.
//
// The table is generated from Roblox's API dump by scripts/gen-reflection.mjs.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));

let _db = null;

export function db() {
  if (!_db) {
    _db = JSON.parse(fs.readFileSync(path.join(here, 'reflection.json'), 'utf8'));
  }
  return _db;
}

export function hasClass(className) {
  return Object.prototype.hasOwnProperty.call(db().classes, className);
}

export function classInfo(className) {
  return db().classes[className] || null;
}

/** Superclass chain from `className` up to (and including) Root. */
export function superChain(className) {
  const out = [];
  let cur = className;
  const seen = new Set();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    out.push(cur);
    const info = classInfo(cur);
    cur = info ? info.super : null;
  }
  return out;
}

export function isA(className, base) {
  return superChain(className).includes(base);
}

/**
 * All serializable properties for a class, including inherited ones.
 * Subclass declarations override superclass ones.
 * @returns {Map<string, {type: string, canLoad: boolean}>}
 */
export function allPropertiesFor(className) {
  const merged = new Map();
  // Walk base -> derived so derived declarations win.
  for (const name of superChain(className).reverse()) {
    const info = classInfo(name);
    if (!info) continue;
    for (const [prop, [type, canLoad, canSave]] of Object.entries(info.props)) {
      merged.set(prop, { type, canLoad: canLoad === 1, canSave: canSave === 1 });
    }
  }
  return merged;
}

/** Only properties the engine actually persists to model files. */
export function propertiesFor(className) {
  const merged = new Map();
  for (const [name, info] of allPropertiesFor(className)) {
    if (info.canSave) merged.set(name, { type: info.type, canLoad: info.canLoad });
  }
  return merged;
}

/** Names of every class whose superclass is `className`. */
export function subclassesOf(className) {
  return Object.entries(db().classes)
    .filter(([, info]) => info.super === className)
    .map(([name]) => name);
}

export function isEnumValueType(typeName) {
  return Object.prototype.hasOwnProperty.call(db().enums, typeName);
}

/** enum item name -> numeric value, or undefined. */
export function enumValue(enumName, itemName) {
  const e = db().enums[enumName];
  if (!e) return undefined;
  return e[itemName];
}

/** numeric value -> enum item name, or undefined. */
export function enumItemName(enumName, value) {
  const e = db().enums[enumName];
  if (!e) return undefined;
  for (const [name, v] of Object.entries(e)) {
    if (v === value) return name;
  }
  return undefined;
}

export function enumItems(enumName) {
  return db().enums[enumName] || null;
}

export function classCount() {
  return db().classCount;
}

// --- serialization mapping (reflection + rbx-dom patches) -------------------

let _patches = null;

export function patchDb() {
  if (!_patches) {
    _patches = JSON.parse(fs.readFileSync(path.join(here, 'patches.json'), 'utf8'));
  }
  return _patches;
}

const _serCache = new Map();

/**
 * Resolve how a class's properties are actually persisted.
 *
 * Returns `forward` (canonical name -> serialized name + value type) and
 * `reverse` (serialized name -> canonical name + value type). This accounts for
 * rbx-dom patches such as BasePart.Size -> "size" and
 * BasePart.Color -> "Color" serialized as Color3uint8.
 *
 * @param {string} className
 */
export function serializationFor(className) {
  if (_serCache.has(className)) return _serCache.get(className);

  const patches = patchDb().classes;
  const patch = {};
  for (const c of superChain(className)) {
    if (patches[c]) Object.assign(patch, patches[c]);
  }

  const forward = new Map();
  const reverse = new Map();
  for (const [name, info] of allPropertiesFor(className)) {
    const p = patch[name];
    // A property is persisted if the engine says so, or if a patch maps it to a
    // serialized alias (e.g. Size -> "size").
    if (!info.canSave && !p) continue;
    let serializedName = name;
    let valueType = info.type;
    if (p) {
      if (p.kind === 'name') serializedName = p.as;
      else valueType = p.as;
    }
    const canonicalType = info.type;
    forward.set(name, { serializedName, valueType, canonicalType, canLoad: info.canLoad });
    reverse.set(serializedName, { canonicalName: name, valueType, canonicalType });
  }

  const result = { forward, reverse };
  _serCache.set(className, result);
  return result;
}

