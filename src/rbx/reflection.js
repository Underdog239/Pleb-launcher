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

/**
 * Superclass chain from `className` up to (and including) Root.
 *
 * Memoized: it is the inner loop of `isA`, `allPropertiesFor` and
 * `serializationFor`, and it walks the same 935-class table every time. The
 * returned array is shared, so treat it as read-only.
 */
const _chainCache = new Map();

export function superChain(className) {
  const cached = _chainCache.get(className);
  if (cached) return cached;
  const out = [];
  let cur = className;
  const seen = new Set();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    out.push(cur);
    const info = classInfo(cur);
    cur = info ? info.super : null;
  }
  _chainCache.set(className, out);
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
const _allPropsCache = new Map();

export function allPropertiesFor(className) {
  const cached = _allPropsCache.get(className);
  if (cached) return cached;
  const merged = new Map();
  // Walk base -> derived so derived declarations win. `.toReversed()` rather
  // than `.reverse()`: the chain is a shared cached array, and reversing it in
  // place would corrupt the cache for every later caller.
  for (const name of superChain(className).toReversed()) {
    const info = classInfo(name);
    if (!info) continue;
    for (const [prop, entry] of Object.entries(info.props)) {
      const [type, canLoad, canSave, refClass] = entry;
      // `category` is the API dump's own kind for the value type. Newer
      // reflection.json files record it as a 5th slot; older ones do not.
      const category = entry[4] || null;
      merged.set(prop, {
        type,
        canLoad: canLoad === 1,
        canSave: canSave === 1,
        refClass: refClass || null,
        category,
        declaredOn: name,
      });
    }
  }
  // Memoized because it is called per instance during validation and codec
  // work; the map is shared, so treat it as read-only.
  _allPropsCache.set(className, merged);
  return merged;
}

/**
 * Properties typed `Font` that are the *datatype* (family/weight/style), not the
 * legacy `Font` enum.
 *
 * The API dump gives both the same name, so a refactor of the reflection
 * database could conflate them and the codec would silently write `0` for a
 * font. The dump's `Category` is the real discriminator and is recorded when
 * present (`scripts/gen-reflection.mjs`); this list is the fallback for
 * reflection.json files generated before that, pinned by a test.
 */
const FONT_DATATYPE_PROPERTIES = new Set([
  'GetTextBoundsParams.Font',
  'ScreenshotHud.OverlayFont',
]);

function isFontDatatype(className, propName) {
  return (
    propName.endsWith('FontFace') ||
    propName === 'OverlayFont' ||
    className === 'GetTextBoundsParams' ||
    FONT_DATATYPE_PROPERTIES.has(`${className}.${propName}`)
  );
}

/**
 * Is this property an enum on the wire, or a structured datatype?
 *
 * `isEnumValueType` alone is wrong whenever a datatype shares a name with an
 * enum, which is exactly the `Font` case: `TextLabel.Font` is the enum while
 * `TextLabel.FontFace` is the datatype.
 *
 * @param {string[]} chain superclass chain, base first
 * @param {string} propName
 * @param {string} typeName
 */
export function resolveIsEnum(chain, propName, typeName) {
  if (!isEnumValueType(typeName)) return false;
  if (typeName !== 'Font') return true;
  for (const cls of chain) {
    if (isFontDatatype(cls, propName)) return false;
  }
  return true;
}

/**
 * Properties a model file can actually hold for this class.
 *
 * This is deliberately derived from `serializationFor` rather than from the
 * dump's `CanSave` flag, because the two disagree and the codec is right: the
 * engine writes `BasePart.Size` under the legacy name `size`, marks
 * `Instance.Archivable` as unsavable and persists it as `archivable`, and does
 * the same for `Sandboxed`/`DefinesCapabilities`. A `CanSave`-only list misses
 * all of those, so it did not describe the files this project writes.
 */
export function propertiesFor(className) {
  const all = allPropertiesFor(className);
  const merged = new Map();
  for (const name of serializationFor(className).forward.keys()) {
    const info = all.get(name);
    if (!info) continue;
    merged.set(name, {
      type: info.type,
      canLoad: info.canLoad,
      refClass: info.refClass,
      declaredOn: info.declaredOn,
    });
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

  const chain = superChain(className);
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
    // The dump's Category, when the reflection file records it, settles the
    // enum/datatype question outright; otherwise fall back to the name rule.
    const isEnum =
      info.category === 'Enum'
        ? true
        : info.category
          ? false
          : resolveIsEnum(chain, name, valueType);
    forward.set(name, {
      serializedName,
      valueType,
      canonicalType,
      refClass: info.refClass,
      canLoad: info.canLoad,
      isEnum,
    });
    reverse.set(serializedName, { canonicalName: name, valueType, canonicalType, isEnum });
  }

  const result = { forward, reverse };
  _serCache.set(className, result);
  return result;
}

