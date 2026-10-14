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

// --- access flags ----------------------------------------------------------
//
// The API dump records, for every property, who is allowed to read and write it,
// and whether it is read-only, deprecated, scriptable, browsable or replicated.
// That is the difference between "the assignment compiles" and "the assignment
// does nothing", and it is packed into one integer per property by
// scripts/gen-reflection.mjs (see FLAG BITS there) so the table stays small.
//
// Reflection files generated before the flags existed simply have no slot 5.
// Everything here degrades to "not recorded" rather than guessing.

/** Security levels, weakest first. Index is what the flag bits store. */
export const SECURITY_LEVELS = [
  'None',
  'LocalUserSecurity',
  'PluginSecurity',
  'RobloxScriptSecurity',
  'RobloxSecurity',
  'NotAccessibleSecurity',
];

const PROPERTY_BITS = {
  ReadOnly: 1 << 6,
  Deprecated: 1 << 7,
  NotScriptable: 1 << 8,
  Hidden: 1 << 9,
  NotBrowsable: 1 << 10,
  NotReplicated: 1 << 11,
};

const CLASS_BITS = {
  Deprecated: 1 << 0,
  NotBrowsable: 1 << 1,
  NotReplicated: 1 << 2,
  PlayerReplicated: 1 << 3,
};

/**
 * Which classes of writer each security level admits.
 *
 * `game` is a normal script running in a place — the case an agent is almost
 * always writing for. `plugin` is a Studio plugin, which the engine grants
 * PluginSecurity. `studio` is the command bar and other local-user surfaces.
 *
 * RobloxScriptSecurity and RobloxSecurity belong to the engine's own core
 * scripts; no user code, including plugins, is granted them. NotAccessible
 * grants nothing at all. None of this is inferred — it is read from the dump.
 */
const SECURITY_ACCESS = {
  None: { game: true, plugin: true, studio: true },
  LocalUserSecurity: { game: false, plugin: false, studio: true },
  PluginSecurity: { game: false, plugin: true, studio: true },
  RobloxScriptSecurity: { game: false, plugin: false, studio: false },
  RobloxSecurity: { game: false, plugin: false, studio: false },
  NotAccessibleSecurity: { game: false, plugin: false, studio: false },
};

let _hasAccessFlags = null;

/** Does the loaded table carry per-property access flags at all? */
export function hasAccessFlags() {
  if (_hasAccessFlags === null) {
    _hasAccessFlags = (db().annotatedProperties ?? 0) > 0;
  }
  return _hasAccessFlags;
}

/**
 * Does it carry class-level flags? Checked separately because a dump can have
 * property flags before class flags (or the reverse), and each should degrade
 * on its own rather than pretending the other is absent.
 */
let _hasClassAccessFlags = null;

export function hasClassAccessFlags() {
  if (_hasClassAccessFlags === null) {
    _hasClassAccessFlags = Object.values(db().classes).some((c) => c.flags !== undefined);
  }
  return _hasClassAccessFlags;
}

/**
 * Decode what the API says about reading and writing one property.
 *
 * @returns {{
 *   recorded: boolean, writeSecurity: string, readSecurity: string,
 *   readOnly: boolean, deprecated: boolean, notScriptable: boolean,
 *   hidden: boolean, notBrowsable: boolean, notReplicated: boolean,
 *   writableFromGame: boolean, writableFromPlugin: boolean, writableFromStudio: boolean,
 * }}
 */
export function propertyAccessFor(className, propName) {
  // Read from the merged table, not the class's own declarations: `Part.Anchored`
  // is declared on BasePart, and looking only at Part would report it as
  // unflagged. Inheriting the flags is the correct answer.
  const merged = allPropertiesFor(className).get(propName);
  const flags = merged?.flags || 0;
  if (!merged) {
    return {
      recorded: false,
      writeSecurity: 'None',
      readSecurity: 'None',
      readOnly: false,
      deprecated: false,
      notScriptable: false,
      hidden: false,
      notBrowsable: false,
      notReplicated: false,
      writableFromGame: true,
      writableFromPlugin: true,
      writableFromStudio: true,
    };
  }
  const writeSecurity = SECURITY_LEVELS[flags & 7];
  const readSecurity = SECURITY_LEVELS[(flags >> 3) & 7];
  const readOnly = (flags & PROPERTY_BITS.ReadOnly) !== 0;
  const access = { ...SECURITY_ACCESS[writeSecurity] };
  return {
    // Per-property flags are only meaningful if the file carries them at all;
    // a zero flag means "nothing to record", so the file is the signal.
    recorded: hasAccessFlags(),
    writeSecurity,
    readSecurity,
    readOnly,
    deprecated: (flags & PROPERTY_BITS.Deprecated) !== 0,
    notScriptable: (flags & PROPERTY_BITS.NotScriptable) !== 0,
    hidden: (flags & PROPERTY_BITS.Hidden) !== 0,
    notBrowsable: (flags & PROPERTY_BITS.NotBrowsable) !== 0,
    notReplicated: (flags & PROPERTY_BITS.NotReplicated) !== 0,
    // A read-only property cannot be written by anyone, whatever the security
    // level says, so the two are combined into the answer callers want.
    writableFromGame: access.game && !readOnly,
    writableFromPlugin: access.plugin && !readOnly,
    writableFromStudio: access.studio && !readOnly,
  };
}

/** What the dump says about a class itself. */
export function classAccessFor(className) {
  const flags = classInfo(className)?.flags || 0;
  return {
    recorded: hasClassAccessFlags(),
    deprecated: (flags & CLASS_BITS.Deprecated) !== 0,
    notBrowsable: (flags & CLASS_BITS.NotBrowsable) !== 0,
    notReplicated: (flags & CLASS_BITS.NotReplicated) !== 0,
    playerReplicated: (flags & CLASS_BITS.PlayerReplicated) !== 0,
  };
}

/** Was this enum item deprecated by the engine? */
export function isDeprecatedEnumItem(enumName, itemName) {
  const list = db().deprecatedItems?.[enumName];
  return Array.isArray(list) && list.includes(itemName);
}

/**
 * What the loaded reflection table says about itself, so `doctor` can report
 * how fresh the data is and whether it carries the access flags at all.
 */
export function dataVersion() {
  const d = db();
  const annotated = d.annotatedProperties ?? null;
  return {
    source: d.source || null,
    dumpVersion: d.dumpVersion ?? null,
    classCount: d.classCount ?? Object.keys(d.classes).length,
    enumCount: d.enumCount ?? Object.keys(d.enums).length,
    // null means the file predates the flags; false means it has them but none
    // needed recording, which cannot happen with a real dump.
    annotatedProperties: annotated,
    hasAccessFlags: typeof annotated === 'number' && annotated > 0,
    hasDeprecatedEnumItems: !!d.deprecatedItems,
  };
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
        // Kept raw here; `propertyAccessFor` decodes it, and anything that
        // wants the bits without the decode can read this.
        flags: entry[5] || 0,
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

