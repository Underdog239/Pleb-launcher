// Model validation and structured diagnostics.
//
// The point of this module is to make agent mistakes loud. Without it, an
// unknown property or a wrong value type is silently dropped and the agent
// ships a file that looks fine and is wrong. Everything here reports a machine-
// readable diagnostic with a path, an expectation, and (where possible) a fix.

import {
  allPropertiesFor,
  propertyAccessFor,
  classAccessFor,
  isDeprecatedEnumItem,
  serializationFor,
  isEnumValueType,
  enumItems,
  hasClass,
  db,
} from './reflection.js';
import { Instance } from './instance.js';
import { isBinarySerializable } from './types.js';
import { isDefaultish } from './datatypes.js';
import { xmlSupports } from './xml.js';

export const ERROR = 'error';
export const WARNING = 'warning';

function diag(severity, code, message, extra = {}) {
  return { severity, code, message, ...extra };
}

// --- suggestions ------------------------------------------------------------

/**
 * Damerau-Levenshtein (optimal string alignment) distance, with an early exit
 * once a match cannot be good enough.
 *
 * Transposition counts as one edit, which is what a typed-in-the-wrong-order
 * mistake is: `--dpeth` must suggest `--depth`, not `--path`.
 */
function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 3) return 99;
  let prevPrev = [];
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1) {
        const aSwapped = a[i - 1].toLowerCase() === b[j - 2].toLowerCase();
        const bSwapped = a[i - 2].toLowerCase() === b[j - 1].toLowerCase();
        if (aSwapped && bSwapped) cur[j] = Math.min(cur[j], prevPrev[j - 2] + 1);
      }
    }
    prevPrev = prev;
    prev = cur;
  }
  return prev[n];
}

/** Best matching candidate for a misspelled name, or null. */
export function closestName(name, candidates) {
  const needle = String(name);
  let best = null;
  let bestScore = 3;
  for (const candidate of candidates) {
    // Suggesting the name that was just rejected teaches nothing.
    if (candidate === needle) continue;
    const d = editDistance(needle, candidate);
    if (d < bestScore) {
      bestScore = d;
      best = candidate;
    }
  }
  return best;
}

/** Every property name that could legally appear on this class. */
/** Memoized: called once per instance during validation. Returns a shared array. */
const _knownNamesCache = new Map();

export function knownPropertyNames(className) {
  const cached = _knownNamesCache.get(className);
  if (cached) return cached;
  const names = new Set();
  for (const name of allPropertiesFor(className).keys()) names.add(name);
  for (const name of serializationFor(className).reverse.keys()) names.add(name);
  const out = [...names];
  _knownNamesCache.set(className, out);
  return out;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isVec = (v, keys) => v && typeof v === 'object' && keys.every((k) => isNum(v[k]));
const isArr = (v, n) => Array.isArray(v) && v.length === n && v.every(isNum);

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value instanceof Instance) return value.className;
  if (typeof value === 'object') return `object{${Object.keys(value).slice(0, 4).join(',')}}`;
  return `${typeof value} ${JSON.stringify(value)}`;
}

export { describe, isDefaultish };

// --- value validation -------------------------------------------------------

/**
 * Validate a single value against the property info from the reflection DB.
 * @returns {Array<object>} diagnostics
 */
export function validateValue(value, info, path) {
  const out = [];
  // Validate against the type an author *writes*, not the type the file stores.
  // BasePart.Color is a Color3 in the API but is persisted as a Color3uint8, so
  // checking `valueType` alone would skip the 0..1 range check and let a
  // [255, 0, 0] "red" be silently clamped on write.
  const type = info.canonicalType || info.valueType || info.type;
  const bad = (expected) =>
    out.push(
      diag(ERROR, 'invalid-value', `${path} expected ${expected}, got ${describe(value)}`, {
        path,
        expected,
        actual: describe(value),
      }),
    );

  if (value === null || value === undefined) return out;

  const enumType = info.isEnum === undefined ? isEnumValueType(type) : info.isEnum;
  if (enumType) {
    const items = enumItems(type);
    if (typeof value === 'number') {
      // 0 is the engine default/unset sentinel for enum properties, so it is
      // always legal even when the enum has no explicit zero-valued item.
      if (value !== 0 && items && !Object.values(items).includes(value)) {
        out.push(
          diag(ERROR, 'invalid-enum-value', `${path}: ${value} is not a valid ${type} value`, {
            path,
            expected: `${type} enum value`,
            actual: value,
            suggestion: closestName(String(value), Object.keys(items)),
          }),
        );
      }
    } else if (typeof value === 'string') {
      if (items && !(value in items)) {
        out.push(
          diag(ERROR, 'invalid-enum-item', `${path}: "${value}" is not a valid ${type} item`, {
            path,
            expected: `${type} enum item`,
            actual: value,
            suggestion: closestName(value, Object.keys(items)),
          }),
        );
      }
    } else {
      bad(`${type} enum (number or item name)`);
    }
    return out;
  }

  switch (type) {
    case 'bool':
      if (typeof value !== 'boolean') bad('a boolean');
      break;
    case 'int':
    case 'int64':
      if (!Number.isInteger(value)) bad('an integer');
      break;
    case 'float':
    case 'double':
      if (!isNum(value)) bad('a number');
      break;
    case 'string':
    case 'BinaryString':
    case 'ContentId':
    case 'ProtectedString':
      if (typeof value !== 'string' && !(value instanceof Uint8Array)) bad('a string');
      break;
    case 'Vector2':
      if (!(isVec(value, ['x', 'y']) || isArr(value, 2))) bad('{x, y} or [x, y]');
      break;
    case 'Vector3':
    case 'Vector3int16':
      if (!(isVec(value, ['x', 'y', 'z']) || isArr(value, 3))) bad('{x, y, z} or [x, y, z]');
      break;
    case 'CFrame': {
      const okObj = value && typeof value === 'object' && isVec(value.position, ['x', 'y', 'z']);
      const okArr = isArr(value, 3) || isArr(value, 12);
      if (!okObj && !okArr) {
        bad('{position:{x,y,z}, rotation:[9]} or [x, y, z]');
      } else if (okObj && value.rotation && !isArr(value.rotation, 9)) {
        out.push(
          diag(
            ERROR,
            'invalid-value',
            `${path}.rotation expected 9 numbers, got ${describe(value.rotation)}`,
            {
              path: `${path}.rotation`,
              expected: 'array of 9 numbers (R00..R22)',
              actual: describe(value.rotation),
            },
          ),
        );
      }
      break;
    }
    case 'Color3': {
      // Color3 channels are 0..1 fractions. A 0..255 byte value is a common
      // agent mistake (and the on-disk Color3uint8 representation), so it gets
      // an explicit note rather than a bare range complaint.
      const keys = isVec(value, ['r', 'g', 'b']) ? ['r', 'g', 'b'] : null;
      const indices = !keys && isArr(value, 3) ? [0, 1, 2] : null;
      if (!keys && !indices) {
        bad('{r, g, b} or [r, g, b] in 0..1');
        break;
      }
      for (const k of keys || indices) {
        const channel = value[k];
        if (channel < 0 || channel > 1) {
          const byteLike = channel > 1 && channel <= 255;
          out.push(
            diag(WARNING, 'color-out-of-range', `${path}.${k} = ${channel} is outside 0..1`, {
              path: `${path}.${k}`,
              expected: '0..1',
              actual: channel,
              ...(byteLike
                ? {
                    note: 'Color3 channels are 0..1 fractions; a 0..255 channel is clamped when written',
                    suggestion: `${(channel / 255).toFixed(4)} (${channel}/255)`,
                  }
                : { note: 'Color3 channels are 0..1 fractions' }),
            }),
          );
        }
      }
      break;
    }
    case 'Color3uint8':
      if (!(isVec(value, ['r', 'g', 'b']) || isArr(value, 3))) bad('{r, g, b} or [r, g, b]');
      break;
    case 'UDim':
      if (!isVec(value, ['scale', 'offset'])) bad('{scale, offset}');
      break;
    case 'UDim2':
      if (!(value && isVec(value.x, ['scale', 'offset']) && isVec(value.y, ['scale', 'offset']))) {
        bad('{x:{scale,offset}, y:{scale,offset}}');
      }
      break;
    case 'NumberRange':
      if (!isVec(value, ['min', 'max'])) bad('{min, max}');
      break;
    case 'Rect':
      if (!(value && isVec(value.min, ['x', 'y']) && isVec(value.max, ['x', 'y']))) {
        bad('{min:{x,y}, max:{x,y}}');
      }
      break;
    case 'Ray':
      if (
        !(value && isVec(value.origin, ['x', 'y', 'z']) && isVec(value.direction, ['x', 'y', 'z']))
      ) {
        bad('{origin:{x,y,z}, direction:{x,y,z}}');
      }
      break;
    case 'NumberSequence':
    case 'ColorSequence':
      if (!(value && Array.isArray(value.keypoints))) bad('{keypoints: [...]}');
      break;
    case 'Instance':
      if (!(value instanceof Instance)) {
        bad('an instance reference (or null)');
      } else if (info.refClass && !value.isA(info.refClass)) {
        out.push(
          diag(
            ERROR,
            'invalid-reference',
            `${path} must reference a ${info.refClass}, got ${value.className} ("${value.name}")`,
            { path, expected: info.refClass, actual: value.className },
          ),
        );
      }
      break;
    default:
      break;
  }
  return out;
}


// --- format coverage --------------------------------------------------------

/**
 * Can this property be written to the target format without losing it?
 *
 * The binary writer omits a property whose value type it has no encoding for,
 * and the XML writer stringifies types it does not model. Either way the source
 * of truth is the codec, not this table — so the check is delegated.
 *
 * @param {{valueType: string, canonicalType?: string}} info
 * @param {'binary'|'xml'|null} format
 */
export function formatSupports(info, format) {
  const stored = info.valueType || info.canonicalType;
  if (info.isEnum === undefined ? isEnumValueType(stored) : info.isEnum) return true;
  if (format === 'xml') return xmlSupports(stored);
  // Binary is the strictest and the default output, so it is what an
  // unspecified format is checked against.
  return isBinarySerializable(stored);
}

/** The formats that cannot represent a property, for a diagnostic message. */
function unsupportedFormats(info) {
  const stored = info.valueType || info.canonicalType;
  if (info.isEnum === undefined ? isEnumValueType(stored) : info.isEnum) return [];
  const out = [];
  if (!isBinarySerializable(stored)) out.push('binary');
  if (!xmlSupports(stored)) out.push('xml');
  return out;
}

/**
 * How much of the API this build can actually carry, per format.
 *
 * The denominator is every value type the API mentions anywhere, taken from the
 * full class table rather than from the properties of one instance, so the
 * number is a property of the toolchain and not of whatever was loaded.
 * `uncovered[format]` names the types that would be lost, which is what a
 * caller needs to decide whether a conversion is safe.
 */
export function coverageReport() {
  const used = new Map();
  for (const info of Object.values(db().classes)) {
    for (const entry of Object.values(info.props || {})) {
      const type = entry[0];
      if (!type) continue;
      used.set(type, (used.get(type) || 0) + 1);
    }
  }

  const types = [...used.keys()].sort();
  const perFormat = (format) => {
    const covered = types.filter((t) => formatSupports({ valueType: t }, format));
    return {
      covered: covered.length,
      total: types.length,
      percent: types.length === 0 ? 100 : Math.round((covered.length / types.length) * 1000) / 10,
      // The complement of `covered`, computed the same way: an enum is always
      // representable, so it must not appear here.
      uncovered: types.filter((t) => !formatSupports({ valueType: t }, format)),
    };
  };

  return {
    totalTypes: types.length,
    binary: perFormat('binary'),
    xml: perFormat('xml'),
  };
}

// --- instance / model validation -------------------------------------------

const RANGES = {
  Transparency: [0, 1, 'Transparency is a 0..1 fraction, not a percentage'],
  Reflectance: [0, 1, 'Reflectance is a 0..1 fraction'],
};

/** Validate every property and structural rule of one instance. */
export function validateInstance(inst, options = {}) {
  const out = [];
  const path = inst.getFullName();
  const format = options.format || null;

  if (!hasClass(inst.className)) {
    out.push(
      diag(ERROR, 'unknown-class', `${path}: unknown class "${inst.className}"`, {
        path,
        actual: inst.className,
        suggestion: closestName(inst.className, Object.keys(db().classes)),
      }),
    );
    return out;
  }

  const ser = serializationFor(inst.className);
  const known = knownPropertyNames(inst.className);

  // Deprecated classes are still loadable, so they are a warning, not an error:
  // an existing file full of `Hat` should not refuse to open.
  const classAccess = classAccessFor(inst.className);
  if (classAccess.deprecated) {
    out.push(
      diag(WARNING, 'deprecated-class', `${path}: ${inst.className} is deprecated by the engine`, {
        path,
        actual: inst.className,
        note: 'the class still loads and saves, but new content should not use it',
      }),
    );
  }

  const declared = allPropertiesFor(inst.className);

  for (const [prop, value] of inst.props) {
    const info = ser.forward.get(prop);
    if (!info) {
      // Distinguish a typo from a real property the engine simply never saves.
      // Both are fatal to the write, but they need different fixes: rename the
      // property, or stop expecting it to persist.
      if (declared.has(prop)) {
        out.push(
          diag(
            ERROR,
            'unserializable-property',
            `${inst.className}.${prop} exists but is not saved to model files, so it would be dropped`,
            {
              path: `${path}.${prop}`,
              actual: prop,
              note: 'the API marks this property as runtime-only (canSave = false)',
            },
          ),
        );
      } else {
        out.push(
          diag(ERROR, 'unknown-property', `${inst.className}.${prop} is not a valid property of ${inst.className}`, {
            path: `${path}.${prop}`,
            actual: prop,
            suggestion: closestName(prop, known),
          }),
        );
      }
      continue;
    }

    out.push(...validateValue(value, info, `${path}.${prop}`));

    // Access flags are about what happens at *runtime*, and they are the
    // difference between an assignment that works and one that silently does
    // nothing. The file can hold the value either way, so these are warnings
    // attached to the property rather than errors on the model.
    //
    // Gated on `!isDefaultish`, and that gate is what makes this usable: the
    // binary encoder writes every serializable property including its default,
    // so a round-tripped Part carries `BackParamA = 0` and a dozen other
    // long-deprecated defaults that the engine itself put there. Warning about
    // those would bury the model in noise. "You set a deprecated property to a
    // value" is worth saying; "the serializer round-tripped a zero" is not.
    const access = !isDefaultish(value) ? propertyAccessFor(inst.className, prop) : null;
    if (access && access.recorded) {
      if (access.deprecated) {
        out.push(
          diag(WARNING, 'deprecated-property', `${inst.className}.${prop} is deprecated by the engine`, {
            path: `${path}.${prop}`,
            actual: prop,
            note: 'the property still saves, but new content should not set it',
          }),
        );
      }
      if (access.readOnly) {
        out.push(
          diag(
            WARNING,
            'read-only-property',
            `${inst.className}.${prop} is read-only; the engine sets it and an assignment has no effect`,
            { path: `${path}.${prop}`, actual: prop },
          ),
        );
      } else if (!access.writableFromGame) {
        // The value is in the file and will be loaded, which is the case that
        // matters here: a build can set what a script cannot, and saying so
        // prevents an agent from writing the same assignment into Luau and
        // wondering why it does nothing.
        out.push(
          diag(
            WARNING,
            'write-restricted',
            `${inst.className}.${prop} cannot be written from a game script ` +
              `(write security: ${access.writeSecurity}); a file can still set it`,
            {
              path: `${path}.${prop}`,
              actual: access.writeSecurity,
              expected: 'None',
              note:
                access.notScriptable
                  ? 'the API also marks this property as not scriptable'
                  : 'set it in the model or from a plugin, not from a running game',
            },
          ),
        );
      }
    }

    // A property the writer cannot represent is a silent loss, which is the
    // failure this module exists to prevent: an agent sets it, the write
    // "succeeds", and the file disagrees with the intent.
    if (!isDefaultish(value) && !formatSupports(info, format)) {
      const formats = unsupportedFormats(info);
      out.push(
        diag(
          ERROR,
          'unsupported-type',
          `${path}.${prop} has type ${info.valueType}, which the ` +
            `${format ? `${format} ` : ''}writer cannot represent` +
            `${formats.length ? ` (no ${formats.join(' or ')} encoding)` : ''}` +
            `; it would be dropped from the output`,
          {
            path: `${path}.${prop}`,
            actual: info.valueType,
            expected: 'a value type the target format supports',
            note: 'the property is set but would not survive a write',
          },
        ),
      );
    }

    const range = RANGES[prop];
    if (range && typeof value === 'number' && (value < range[0] || value > range[1])) {
      out.push(
        diag(WARNING, 'out-of-range', `${path}.${prop} = ${value} is outside ${range[0]}..${range[1]}`, {
          path: `${path}.${prop}`,
          expected: `${range[0]}..${range[1]}`,
          actual: value,
          note: range[2],
        }),
      );
    }
  }

  const seen = new Set();
  for (const child of inst.children) {
    if (seen.has(child.name)) {
      out.push(
        diag(
          WARNING,
          'duplicate-name',
          `${path} has two children named "${child.name}"; Roblox will rename one`,
          { path: child.getFullName(), actual: child.name },
        ),
      );
    }
    seen.add(child.name);
  }

  return out;
}

/**
 * Validate a whole model.
 * @param {Instance[]} roots
 * @param {{strict?: boolean}} [options] strict turns warnings into failures
 */
export function validateModel(roots, options = {}) {
  const diagnostics = [];
  let instanceCount = 0;
  const visit = (inst) => {
    instanceCount++;
    diagnostics.push(...validateInstance(inst, options));
    for (const child of inst.children) visit(child);
  };
  for (const root of roots) visit(root);

  const result = summarizeDiagnostics(diagnostics, { instanceCount, strict: options.strict });
  if (options.format) result.format = options.format;
  return result;
}

/**
 * Wrap a diagnostic list in the standard result shape (counts + `ok`).
 *
 * The write path and the script-edit path produce the same diagnostic objects
 * as the validator, so they report the same way — one shape for an agent to
 * parse, wherever the problem came from.
 */
export function summarizeDiagnostics(diagnostics, { instanceCount = 0, strict = false } = {}) {
  const errors = diagnostics.filter((d) => d.severity === ERROR);
  const warnings = diagnostics.filter((d) => d.severity === WARNING);
  return {
    ok: strict ? errors.length === 0 && warnings.length === 0 : errors.length === 0,
    strict: !!strict,
    instanceCount,
    errorCount: errors.length,
    warningCount: warnings.length,
    diagnostics,
  };
}

/** Render diagnostics as human-readable lines. */
export function formatDiagnostics(result) {
  if (result.diagnostics.length === 0) {
    return `ok: ${result.instanceCount} instances, no problems`;
  }
  const lines = result.diagnostics.map((d) => {
    const tag = d.severity === ERROR ? 'error' : 'warning';
    let line = `${tag}: ${d.message}`;
    if (d.suggestion) line += `\n  did you mean: ${d.suggestion}?`;
    return line;
  });
  lines.push(
    `${result.ok ? 'ok' : 'FAILED'}: ${result.instanceCount} instances, ${result.errorCount} error(s), ${result.warningCount} warning(s)`,
  );
  return lines.join('\n');
}

