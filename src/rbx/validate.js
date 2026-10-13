// Model validation and structured diagnostics.
//
// The point of this module is to make agent mistakes loud. Without it, an
// unknown property or a wrong value type is silently dropped and the agent
// ships a file that looks fine and is wrong. Everything here reports a machine-
// readable diagnostic with a path, an expectation, and (where possible) a fix.

import {
  allPropertiesFor,
  serializationFor,
  isEnumValueType,
  enumItems,
  hasClass,
  db,
} from './reflection.js';
import { Instance } from './instance.js';

export const ERROR = 'error';
export const WARNING = 'warning';

function diag(severity, code, message, extra = {}) {
  return { severity, code, message, ...extra };
}

// --- suggestions ------------------------------------------------------------

/** Levenshtein distance with an early exit once it cannot be a good match. */
function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 3) return 99;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

/** Best matching candidate for a misspelled name, or null. */
export function closestName(name, candidates) {
  let best = null;
  let bestScore = 3;
  for (const candidate of candidates) {
    const d = editDistance(String(name), candidate);
    if (d < bestScore) {
      bestScore = d;
      best = candidate;
    }
  }
  return best;
}

/** Every property name that could legally appear on this class. */
export function knownPropertyNames(className) {
  const names = new Set();
  for (const name of allPropertiesFor(className).keys()) names.add(name);
  for (const name of serializationFor(className).reverse.keys()) names.add(name);
  return [...names];
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

export { describe };

// --- value validation -------------------------------------------------------

/**
 * Validate a single value against the property info from the reflection DB.
 * @returns {Array<object>} diagnostics
 */
export function validateValue(value, info, path) {
  const out = [];
  const type = info.valueType;
  const bad = (expected) =>
    out.push(
      diag(ERROR, 'invalid-value', `${path} expected ${expected}, got ${describe(value)}`, {
        path,
        expected,
        actual: describe(value),
      }),
    );

  if (value === null || value === undefined) return out;

  if (isEnumValueType(type)) {
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
    case 'Color3':
      if (isVec(value, ['r', 'g', 'b'])) {
        for (const k of ['r', 'g', 'b']) {
          if (value[k] < 0 || value[k] > 1) {
            out.push(
              diag(WARNING, 'color-out-of-range', `${path}.${k} = ${value[k]} is outside 0..1`, {
                path: `${path}.${k}`,
                expected: '0..1',
                actual: value[k],
              }),
            );
          }
        }
      } else if (!isArr(value, 3)) bad('{r, g, b} or [r, g, b] in 0..1');
      break;
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


// --- instance / model validation -------------------------------------------

const RANGES = {
  Transparency: [0, 1, 'Transparency is a 0..1 fraction, not a percentage'],
  Reflectance: [0, 1, 'Reflectance is a 0..1 fraction'],
};

/** Validate every property and structural rule of one instance. */
export function validateInstance(inst) {
  const out = [];
  const path = inst.getFullName();

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

  for (const [prop, value] of inst.props) {
    const info = ser.forward.get(prop);
    if (!info) {
      out.push(
        diag(ERROR, 'unknown-property', `${inst.className}.${prop} is not a valid property of ${inst.className}`, {
          path: `${path}.${prop}`,
          actual: prop,
          suggestion: closestName(prop, known),
        }),
      );
      continue;
    }

    out.push(...validateValue(value, info, `${path}.${prop}`));

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
    diagnostics.push(...validateInstance(inst));
    for (const child of inst.children) visit(child);
  };
  for (const root of roots) visit(root);

  const errors = diagnostics.filter((d) => d.severity === ERROR);
  const warnings = diagnostics.filter((d) => d.severity === WARNING);
  const ok = options.strict ? errors.length === 0 && warnings.length === 0 : errors.length === 0;

  return {
    ok,
    strict: !!options.strict,
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

