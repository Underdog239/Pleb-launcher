// Answering questions about the API itself.
//
// An agent writing Roblox code needs to know what a class can hold, what the
// members of an enum are, and which class has the property it is reaching for.
// Studio's own MCP server answers that with `api_dump`, which needs Studio
// running. The same answers are already in this project's reflection database,
// so they are available here with no Studio, no network, and no guessing.
//
// Every answer comes straight from the database. Nothing is inferred from
// naming, and a name that does not exist is reported as such, with the closest
// real one.

import {
  db,
  serializationFor,
  allPropertiesFor,
  propertiesFor,
  superChain,
  classInfo,
  hasClass,
  resolveIsEnum,
} from './reflection.js';
import { closestName } from './validate.js';

const MAX_SUGGESTIONS = 5;

/**
 * What kind of thing is this name: a class, an enum, a datatype, or several?
 *
 * `Font` is the reason this returns more than "class or enum": it is both a
 * legacy enum and a datatype, and the two take different values. Callers that
 * only care about classes should use `hasClass`.
 */
export function kindOf(name) {
  const classes = hasClass(name);
  const enums = Object.prototype.hasOwnProperty.call(db().enums, name);
  const datatypes = datatypeNames().has(name);
  const kinds = [classes && 'class', enums && 'enum', datatypes && 'datatype'].filter(Boolean);
  if (kinds.length === 0) return null;
  return kinds.length > 1 ? 'both' : kinds[0];
}

let _datatypeNames = null;

/**
 * Every value type that is a *datatype* rather than a class or an enum.
 *
 * A name in a property's type slot is not enough to decide: `Font` is the type
 * of both `TextLabel.Font` (the legacy enum) and `TextLabel.FontFace` (the
 * datatype), so the question is answered per property by the same reflection
 * rule the codecs use.
 */
function datatypeNames() {
  if (_datatypeNames) return _datatypeNames;
  const classes = db().classes;
  const names = new Set();
  for (const [className, cls] of Object.entries(classes)) {
    for (const [propName, entry] of Object.entries(cls.props || {})) {
      const type = entry[0];
      if (!type || Object.prototype.hasOwnProperty.call(classes, type)) continue;
      if (resolveIsEnum(superChain(className), propName, type)) continue;
      names.add(type);
    }
  }
  _datatypeNames = names;
  return names;
}

/**
 * Everything worth knowing about one class.
 *
 * The API dump carries more than the API: `Object` declares both `ClassName`
 * and `className` with both flags zeroed, `Instance` carries a lowercase
 * `archivable` that is really the serialized spelling of `Archivable`, and a
 * long tail of properties exist at runtime but are never saved. Dumping all of
 * it is technically complete and practically useless, so the list is split the
 * way the codec sees the world: what a model file persists, what only exists at
 * runtime, and what is pure dump plumbing (`--all` shows that too).
 */
export function describeClass(name, { all = false } = {}) {
  if (!hasClass(name)) {
    return { found: false, name, suggestions: suggestNames(name, 'class') };
  }
  const info = classInfo(name);
  const chain = superChain(name);
  const ser = serializationFor(name);
  const persisted = propertiesFor(name);

  // Names the codec writes: an entry whose key is one of these is the serialized
  // spelling of another property, not a property in its own right.
  const serializedNames = new Set(ser.reverse.keys());

  const describe = (propName, prop, saved) => {
    const entry = ser.forward.get(propName);
    return {
      name: propName,
      type: prop.type,
      saved,
      loadable: prop.canLoad,
      serializedName: entry ? entry.serializedName : null,
      enum: resolveIsEnum(chain, propName, prop.type),
      declaringClass: prop.declaredOn || name,
      referenceTo: prop.refClass || null,
    };
  };

  const properties = [...persisted.keys()].map((propName) =>
    describe(propName, persisted.get(propName), true),
  );

  const runtimeProperties = [];
  const hidden = [];
  for (const [propName, prop] of allPropertiesFor(name)) {
    if (persisted.has(propName)) continue;
    const alias = serializedNames.has(propName) && ser.reverse.get(propName).canonicalName !== propName;
    if (alias || (!prop.canLoad && !prop.canSave)) {
      hidden.push(describe(propName, prop, false));
      continue;
    }
    runtimeProperties.push(describe(propName, prop, false));
  }

  properties.sort((a, b) => a.name.localeCompare(b.name));
  runtimeProperties.sort((a, b) => a.name.localeCompare(b.name));

  return {
    found: true,
    name,
    superclass: info.super || null,
    superchain: chain,
    isService: info.service === 1,
    creatable: info.notCreatable !== 1,
    savedCount: properties.length,
    runtimeOnlyCount: runtimeProperties.length,
    hiddenCount: hidden.length,
    properties,
    runtimeProperties,
    ...(all ? { hiddenProperties: hidden } : {}),
  };
}

/** The members of one enum, with their numeric values. */
export function describeEnum(name) {
  const enums = db().enums;
  if (!Object.prototype.hasOwnProperty.call(enums, name)) {
    return { found: false, name, suggestions: suggestNames(name, 'enum') };
  }
  const items = enums[name];
  const list = Object.entries(items).map(([itemName, value]) => ({ name: itemName, value }));
  // The database stores them by name; the numeric order is the useful one.
  list.sort((a, b) => a.value - b.value || a.name.localeCompare(b.name));
  return { found: true, name, count: list.length, items: list };
}

/**
 * Which classes can hold a property with this name, and of what type.
 *
 * This is the question an agent asks when it knows the property but not the
 * class ("something has a Health property -- what?"), and it is answerable
 * exactly because the database is a complete index of every class.
 */
export function classesWithProperty(propName) {
  const matches = [];
  for (const className of Object.keys(db().classes)) {
    const props = allPropertiesFor(className);
    const prop = props.get(propName);
    if (!prop) continue;
    const ser = serializationFor(className).forward.get(propName);
    matches.push({
      className,
      type: prop.type,
      serializable: prop.canSave,
      declaringClass: prop.declaredOn || className,
      enum: resolveIsEnum(superChain(className), propName, prop.type),
      referenceTo: prop.refClass || null,
      serializedName: ser ? ser.serializedName : null,
    });
  }
  // The class that *declares* the property is the interesting answer, so it
  // sorts first; the subclasses that merely inherit it follow.
  const declares = (m) => (m.declaringClass === m.className ? 0 : 1);
  matches.sort((a, b) => declares(a) - declares(b) || a.className.localeCompare(b.className));
  if (matches.length === 0) {
    return { found: false, name: propName, suggestions: suggestPropertyNames(propName) };
  }
  return {
    found: true,
    name: propName,
    count: matches.length,
    declaringClass: matches[0].declaringClass,
    type: matches[0].type,
    classes: matches,
  };
}

/** Free-text search across class names, enum names, enum items and properties. */
export function searchApi(term, { limit = 40 } = {}) {
  const needle = String(term).toLowerCase();
  if (needle.length === 0) {
    return { term, classes: [], enums: [], enumItems: [], properties: [], truncated: false };
  }

  const classes = [];
  for (const [name, info] of Object.entries(db().classes)) {
    if (name.toLowerCase().includes(needle)) {
      classes.push({ name, isService: info.service === 1, creatable: info.notCreatable !== 1 });
    }
  }
  classes.sort((a, b) => {
    // A prefix match is a better answer than a match in the middle.
    const ap = a.name.toLowerCase().startsWith(needle) ? 0 : 1;
    const bp = b.name.toLowerCase().startsWith(needle) ? 0 : 1;
    return ap - bp || a.name.localeCompare(b.name);
  });

  const enums = [];
  const enumItems = [];
  for (const [enumName, items] of Object.entries(db().enums)) {
    if (enumName.toLowerCase().includes(needle)) {
      enums.push({ name: enumName, count: Object.keys(items).length });
    }
    for (const itemName of Object.keys(items)) {
      if (itemName.toLowerCase().includes(needle)) {
        enumItems.push({ enum: enumName, name: itemName, value: items[itemName] });
      }
    }
  }
  enums.sort((a, b) => a.name.localeCompare(b.name));
  enumItems.sort((a, b) => a.enum.localeCompare(b.enum) || a.name.localeCompare(b.name));

  // Properties are searched too, because "anchor" should find `Anchored` and
  // not only the class names that happen to contain the word.
  const properties = [];
  for (const name of allPropertyNames()) {
    if (!name.toLowerCase().includes(needle)) continue;
    properties.push({ name, ...describePropertyOrigin(name) });
  }
  properties.sort((a, b) => {
    const ap = a.name.toLowerCase().startsWith(needle) ? 0 : 1;
    const bp = b.name.toLowerCase().startsWith(needle) ? 0 : 1;
    return ap - bp || a.name.localeCompare(b.name);
  });

  const truncated = classes.length + enums.length + enumItems.length + properties.length > limit * 2;
  return {
    term,
    classes: classes.slice(0, limit),
    enums: enums.slice(0, limit),
    enumItems: enumItems.slice(0, limit),
    properties: properties.slice(0, limit),
    truncated,
  };
}

/** Where a property name is declared, and of what type. */
function describePropertyOrigin(propName) {
  for (const className of Object.keys(db().classes)) {
    const prop = allPropertiesFor(className).get(propName);
    if (prop && prop.declaredOn === className) {
      return { type: prop.type, declaringClass: className };
    }
  }
  return { type: null, declaringClass: null };
}

// --- internals -------------------------------------------------------------

function suggestNames(name, kind) {
  const pool =
    kind === 'enum' ? Object.keys(db().enums) : Object.keys(db().classes);
  const one = closestName(name, pool);
  if (!one) return [];
  return [one];
}

/** Properties are spread across 935 classes, so collect the full set once. */
let _propertyNames = null;
function allPropertyNames() {
  if (_propertyNames) return _propertyNames;
  const names = new Set();
  for (const className of Object.keys(db().classes)) {
    for (const name of allPropertiesFor(className).keys()) names.add(name);
  }
  _propertyNames = [...names];
  return _propertyNames;
}

function suggestPropertyNames(name) {
  const one = closestName(name, allPropertyNames());
  return one ? [one] : [];
}

export { MAX_SUGGESTIONS };
