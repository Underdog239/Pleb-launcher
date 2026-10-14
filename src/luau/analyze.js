// Static analysis of Luau against the Roblox reflection database.
//
// The point is to catch, before anything runs, the mistakes an agent makes most
// often when writing Roblox code: a class name that does not exist, an enum item
// that does not exist, a `require` that will not resolve, a property typo. Each
// of those otherwise fails at runtime — or worse, silently does nothing.
//
// This is a token-level analyser, not a type checker, and it is honest about
// that. Every check here is deliberately one that cannot produce a false
// positive on working code:
//
//   * a literal argument to `Instance.new` is either a real class or it is not;
//   * `Enum.X.Y` either exists in the API dump or it does not;
//   * a property name that is *almost* a real property is a typo, and one that
//     shares nothing with any property (an event, a method, a user field) is
//     left alone rather than guessed at.
//
// Reference: Roblox API dump via src/rbx/reflection.json, Luau syntax via
// src/luau/lexer.js.

import { codeTokens } from './lexer.js';
import {
  db,
  hasClass,
  classInfo,
  isEnumValueType,
  enumValue,
  enumItems,
  propertyAccessFor,
  isDeprecatedEnumItem,
} from '../rbx/reflection.js';
import { closestName } from '../rbx/validate.js';

export const ERROR = 'error';
export const WARNING = 'warning';

/**
 * Globals Luau and the Roblox engine provide (or that agents legitimately use).
 * Anything else assigned or called is suspicious, but not reported: a large
 * script may legitimately define globals, and guessing here would be noise.
 */
export const KNOWN_GLOBALS = new Set([
  // Luau
  '_G', '_VERSION', 'assert', 'error', 'getfenv', 'getmetatable', 'ipairs',
  'next', 'pairs', 'pcall', 'print', 'rawequal', 'rawget', 'rawlen', 'rawset',
  'require', 'select', 'setfenv', 'setmetatable', 'tonumber', 'tostring',
  'type', 'typeof', 'unpack', 'xpcall', 'newproxy', 'collectgarbage',
  // Luau libraries
  'bit32', 'buffer', 'coroutine', 'debug', 'math', 'os', 'string', 'table',
  'utf8', 'task', 'vector',
  // Roblox
  'game', 'workspace', 'script', 'plugin', 'shared', 'Enum', 'Instance',
  'Vector2', 'Vector3', 'Vector2int16', 'Vector3int16', 'CFrame', 'Color3',
  'BrickColor', 'UDim', 'UDim2', 'Ray', 'Rect', 'Region3', 'Region3int16',
  'NumberRange', 'NumberSequence', 'ColorSequence', 'NumberSequenceKeypoint',
  'ColorSequenceKeypoint', 'PhysicalProperties', 'TweenInfo', 'Font', 'Axes',
  'Faces', 'Random', 'DateTime', 'DockWidgetPluginGuiInfo', 'PathWaypoint',
  'OverlapParams', 'RaycastParams', 'CatalogSearchParams', 'Content',
  'FloatCurveKey', 'RotationCurveKey', 'Secret', 'SecurityCapabilities',
  'settings', 'stats', 'time', 'tick', 'typeof', 'UserSettings', 'version',
  'warn', 'ypcall', 'delay', 'spawn', 'wait', 'elapsedTime', 'loadstring',
  'Delay', 'Wait', 'Spawn', 'printidentity', 'PluginManager', 'gcinfo',
  'DebuggerManager', 'require',
]);

/**
 * Globals that are deprecated in favour of a specific replacement.
 * These are documented engine deprecations, not style opinions.
 */
const DEPRECATED_GLOBALS = new Map([
  ['wait', { replacement: 'task.wait', why: 'wait is deprecated and throttles differently' }],
  ['spawn', { replacement: 'task.spawn', why: 'spawn is deprecated and does not return the thread' }],
  ['delay', { replacement: 'task.delay', why: 'delay is deprecated and cannot be cancelled' }],
  ['elapsedTime', { replacement: 'os.clock', why: 'elapsedTime is deprecated' }],
  ['ypcall', { replacement: 'pcall', why: 'ypcall is removed from modern Luau' }],
]);

/** Methods that are deprecated in favour of a specific replacement. */
const DEPRECATED_METHODS = new Map([
  [
    'Remove',
    {
      replacement: 'Destroy',
      why: 'Remove only unparents the instance and leaves connections alive',
    },
  ],
  [
    'GetChildren',
    {
      replacement: null,
      why: null,
    },
  ],
]);

/** Depth of `.`/`:` chains we are willing to resolve statically. */
const MAX_CHAIN = 12;

function diag(severity, code, message, extra) {
  return { severity, code, message, ...extra };
}

// --- literal + chain helpers ------------------------------------------------

/** Read a dotted/indexed chain starting at `i`. Returns null when not static. */
function readChain(tokens, i) {
  let j = i;
  const parts = [];
  if (tokens[j]?.type !== 'ident' && tokens[j]?.type !== 'keyword') return null;
  parts.push({ kind: 'name', name: tokens[j].value, token: tokens[j] });
  j++;

  for (let guard = 0; guard < MAX_CHAIN; guard++) {
    const t = tokens[j];
    if (!t) break;
    if (t.type === 'op' && (t.value === '.' || t.value === ':')) {
      const name = tokens[j + 1];
      if (!name || (name.type !== 'ident' && name.type !== 'keyword')) return null;
      const isCall = t.value === ':';
      if (isCall) {
        // A method call: only useful as a path step if the argument is a literal
        // string (`game:GetService("X")`, `script:WaitForChild("X")`).
        let k = j + 2;
        let arg = null;
        if (tokens[k]?.type === 'op' && tokens[k].value === '(') {
          const inner = tokens[k + 1];
          if (inner?.type === 'string' && tokens[k + 2]?.type === 'op' && tokens[k + 2].value === ')') {
            arg = inner;
            k = k + 3;
          } else if (tokens[k + 1]?.type === 'op' && tokens[k + 1].value === ')') {
            k = k + 2;
          } else {
            return null; // dynamic argument: cannot resolve
          }
        } else {
          return null;
        }
        parts.push({ kind: 'method', name: name.value, arg, token: name });
        j = k;
        continue;
      }
      parts.push({ kind: 'name', name: name.value, token: name });
      j++;
      continue;
    }
    if (t.type === 'op' && t.value === '[') {
      const inner = tokens[j + 1];
      if (inner?.type === 'string' && tokens[j + 2]?.type === 'op' && tokens[j + 2].value === ']') {
        parts.push({ kind: 'name', name: inner.value, token: inner });
        j += 3;
        continue;
      }
      return null; // dynamic index
    }
    break;
  }
  return { parts, end: j };
}

/** Is the token at `i` a call of a plain global function `name(`? */
function isGlobalCall(tokens, i, name) {
  const t = tokens[i];
  if (!t || t.value !== name) return false;
  const prev = tokens[i - 1];
  if (prev && prev.type === 'op' && (prev.value === '.' || prev.value === ':')) return false;
  const next = tokens[i + 1];
  return next?.type === 'op' && next.value === '(';
}

// --- individual checks ------------------------------------------------------

function checkInstanceNew(tokens, out, file) {
  for (let i = 2; i < tokens.length - 3; i++) {
    // Exactly `Instance.new(`. The dotted guard in isGlobalCall is for bare
    // globals like `task.wait`, so it must not be used here.
    if (tokens[i]?.value !== 'new') continue;
    if (tokens[i - 2]?.value !== 'Instance' || tokens[i - 1]?.value !== '.') continue;
    if (tokens[i + 1]?.value !== '(') continue;
    const arg = tokens[i + 2];
    if (!arg || arg.type !== 'string') continue; // dynamic: nothing to check
    const className = arg.value;
    const at = { file, line: arg.line, col: arg.col };

    if (!hasClass(className)) {
      out.push(
        diag(ERROR, 'unknown-class', `Instance.new(${JSON.stringify(className)}): no such class`, {
          ...at,
          actual: className,
          suggestion: closestName(className, Object.keys(db().classes)),
          hint: 'the class name must match the API dump exactly, including capitalisation',
        }),
      );
      continue;
    }
    const info = classInfo(className);
    if (info.notCreatable === 1) {
      out.push(
        diag(
          ERROR,
          'not-creatable',
          `Instance.new(${JSON.stringify(className)}): this class cannot be created; the engine provides it`,
          {
            ...at,
            actual: className,
            ...(info.service === 1
              ? {
                  suggestion: `game:GetService(${JSON.stringify(className)})`,
                  hint: `use game:GetService(${JSON.stringify(className)}) instead`,
                }
              : { hint: 'this class only appears as a child of something else' }),
          },
        ),
      );
    }
  }
}

function checkEnumItems(tokens, out, file) {
  for (let i = 0; i < tokens.length - 4; i++) {
    if (tokens[i]?.value !== 'Enum' || tokens[i + 1]?.value !== '.') continue;
    const category = tokens[i + 2];
    if (!category || category.type !== 'ident') continue;
    if (tokens[i + 3]?.value !== '.') continue;
    const item = tokens[i + 4];
    if (!item || item.type !== 'ident') continue;
    const at = { file, line: category.line, col: category.col };

    if (!isEnumValueType(category.value)) {
      out.push(
        diag(ERROR, 'unknown-enum', `Enum.${category.value}: no such enum`, {
          ...at,
          actual: category.value,
          suggestion: closestName(category.value, Object.keys(db().enums)),
        }),
      );
      continue;
    }
    const items = enumItems(category.value);
    if (!(item.value in items)) {
      out.push(
        diag(
          ERROR,
          'unknown-enum-item',
          `Enum.${category.value}.${item.value}: no such item`,
          {
            file,
            line: item.line,
            col: item.col,
            actual: item.value,
            suggestion: closestName(item.value, Object.keys(items)),
          },
        ),
      );
    } else if (isDeprecatedEnumItem(category.value, item.value)) {
      out.push(
        diag(
          WARNING,
          'deprecated-enum-item',
          `Enum.${category.value}.${item.value} is deprecated by the engine`,
          {
            file,
            line: item.line,
            col: item.col,
            actual: item.value,
            path: `Enum.${category.value}.${item.value}`,
            hint: 'the item still works, but new code should not use it',
          },
        ),
      );
    }
  }
}

function checkGetService(tokens, out, file) {
  for (let i = 0; i < tokens.length - 5; i++) {
    if (tokens[i]?.value !== 'game' || tokens[i + 1]?.value !== ':') continue;
    if (tokens[i + 2]?.value !== 'GetService') continue;
    if (tokens[i + 3]?.value !== '(') continue;
    const arg = tokens[i + 4];
    if (!arg || arg.type !== 'string') continue;
    const name = arg.value;
    const at = { file, line: arg.line, col: arg.col };
    if (!hasClass(name)) {
      out.push(
        diag(ERROR, 'unknown-service', `game:GetService(${JSON.stringify(name)}): no such class`, {
          ...at,
          actual: name,
          suggestion: closestName(name, Object.keys(db().classes)),
        }),
      );
      continue;
    }
    const info = classInfo(name);
    if (info.service !== 1) {
      out.push(
        diag(
          WARNING,
          'not-a-service',
          `game:GetService(${JSON.stringify(name)}): ${name} is not a service`,
          { ...at, actual: name, hint: `use game.${name} or Instance.new(${JSON.stringify(name)})` },
        ),
      );
    }
  }
}

function checkDeprecated(tokens, out, file) {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    // Deprecated method call: `part:Remove()`. Checked before the identifier
    // guard below, because the leading token here is the `:` operator.
    if (t.type === 'op' && t.value === ':' && tokens[i + 1]?.type === 'ident' && tokens[i + 2]?.value === '(') {
      const method = tokens[i + 1].value;
      const info = DEPRECATED_METHODS.get(method);
      if (info?.replacement) {
        out.push(
          diag(WARNING, 'deprecated-method', `:${method}() is deprecated`, {
            file,
            line: tokens[i + 1].line,
            col: tokens[i + 1].col,
            actual: method,
            suggestion: info.replacement,
            hint: info.why,
          }),
        );
      }
      continue;
    }

    if (t.type !== 'ident') continue;

    // Bare deprecated global: `wait(1)`, but not `task.wait(1)` or `foo.wait(1)`.
    const prev = tokens[i - 1];
    const dotted = prev && prev.type === 'op' && (prev.value === '.' || prev.value === ':');
    if (DEPRECATED_GLOBALS.has(t.value) && !dotted && tokens[i + 1]?.value === '(') {
      const info = DEPRECATED_GLOBALS.get(t.value);
      out.push(
        diag(WARNING, 'deprecated-global', `${t.value}() is deprecated`, {
          file,
          line: t.line,
          col: t.col,
          actual: t.value,
          suggestion: info.replacement,
          hint: info.why,
        }),
      );
    }
  }
}

/**
 * A property name that is not a property but is one or two edits away from one
 * is a typo. Anything with no near neighbour — an event, a method, a field the
 * script invented — is left alone.
 *
 * This only fires for variables whose class was established by a literal
 * `Instance.new("Class")`, so the check never guesses at a type.
 */
function checkPropertyTypos(tokens, out, file) {
  /** local name -> class name, for bindings we are certain about. */
  const known = new Map();

  // `local p = Instance.new("Part")` and `local http = game:GetService("HttpService")`
  // are both literal class bindings, so both are certain. Services matter a lot
  // here: HttpService.HttpEnabled, Players.MaxPlayersInternal and the other
  // local-user settings are exactly the properties a game script cannot write,
  // and they are reached through a service, not through Instance.new.
  for (let i = 0; i < tokens.length - 7; i++) {
    if (tokens[i]?.value !== 'local' || tokens[i + 1]?.type !== 'ident') continue;
    if (tokens[i + 2]?.value !== '=') continue;

    // Instance.new("Class")
    if (
      tokens[i + 3]?.value === 'Instance' &&
      tokens[i + 4]?.value === '.' &&
      tokens[i + 5]?.value === 'new' &&
      tokens[i + 6]?.value === '('
    ) {
      const arg = tokens[i + 7];
      if (arg?.type === 'string' && hasClass(arg.value)) known.set(tokens[i + 1].value, arg.value);
      continue;
    }

    // game:GetService("Class")
    if (
      tokens[i + 3]?.value === 'game' &&
      tokens[i + 4]?.value === ':' &&
      tokens[i + 5]?.value === 'GetService' &&
      tokens[i + 6]?.value === '('
    ) {
      const arg = tokens[i + 7];
      if (arg?.type === 'string' && hasClass(arg.value)) known.set(tokens[i + 1].value, arg.value);
    }
  }
  if (known.size === 0) return;

  for (let i = 0; i < tokens.length - 2; i++) {
    const name = tokens[i];
    if (name.type !== 'ident' || !known.has(name.value)) continue;
    const dot = tokens[i + 1];
    if (!dot || dot.type !== 'op' || dot.value !== '.') continue;
    const prop = tokens[i + 2];
    if (!prop || (prop.type !== 'ident' && prop.type !== 'keyword')) continue;

    const className = known.get(name.value);
    const ser = propertyNamesFor(className);

    if (ser.has(prop.value)) {
      // The property is real, so the only thing left to say about it is what
      // the API says: whether it is deprecated, and who may write it.
      const access = propertyAccessFor(className, prop.value);
      if (access.recorded) {
        if (access.deprecated) {
          out.push(
            diag(WARNING, 'deprecated-property', `${className}.${prop.value} is deprecated by the engine`, {
              file,
              line: prop.line,
              col: prop.col,
              actual: prop.value,
              path: `${className}.${prop.value}`,
              hint: 'the property still works, but new code should not set it',
            }),
          );
        }
        if (access.readOnly) {
          out.push(
            diag(WARNING, 'read-only-property', `${className}.${prop.value} is read-only; this assignment has no effect`, {
              file,
              line: prop.line,
              col: prop.col,
              actual: prop.value,
              path: `${className}.${prop.value}`,
            }),
          );
        } else if (!access.writableFromGame) {
          out.push(
            diag(
              WARNING,
              'write-restricted',
              `${className}.${prop.value} cannot be written from a game script ` +
                `(write security: ${access.writeSecurity})`,
              {
                file,
                line: prop.line,
                col: prop.col,
                actual: access.writeSecurity,
                expected: 'None',
                path: `${className}.${prop.value}`,
                hint: 'the engine ignores the assignment; set it in the model or from a plugin',
              },
            ),
          );
        }
      }
      continue;
    }

    const suggestion = closestName(prop.value, [...ser]);
    if (!suggestion) continue; // nothing close: not a typo we can name
    out.push(
      diag(WARNING, 'property-typo', `${className}.${prop.value}: no such property, did you mean ${suggestion}?`, {
        file,
        line: prop.line,
        col: prop.col,
        actual: prop.value,
        expected: suggestion,
        suggestion,
        path: `${className}.${prop.value}`,
      }),
    );
  }
}

let _propCache = null;
function propertyNamesFor(className) {
  if (!_propCache) {
    _propCache = new Map();
    for (const [name, info] of Object.entries(db().classes)) {
      _propCache.set(name, Object.keys(info.props));
    }
  }
  const chain = new Set();
  let cur = className;
  const seen = new Set();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    for (const p of _propCache.get(cur) || []) chain.add(p);
    cur = classInfo(cur)?.super;
    if (cur === '<<<ROOT>>>') break;
  }
  return chain;
}

// --- top-level --------------------------------------------------------------

/**
 * Analyse one script.
 *
 * @param {string} source
 * @param {{file?: string}} [options]
 * @returns {{diagnostics: Array<object>, tokens: Array<object>, errors: Array<object>}}
 */
/**
 * Has `name` been rebound as a local, parameter, or function anywhere in this
 * source? If so, every claim about the global of that name becomes a guess, and
 * a guess is worse than silence — so we say nothing.
 *
 * This is deliberately file-wide rather than scope-accurate: shadowing
 * `Instance` in real Roblox code is vanishingly rare, and being quiet in that
 * rare file costs nothing, while a wrong diagnostic costs trust.
 */
export function isGlobalShadowed(tokens, name) {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'ident' || t.value !== name) continue;
    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    // `local`/`function` are keyword tokens, not identifiers, so compare values.
    if (prev && (prev.value === 'local' || prev.value === 'function')) return true;
    if (prev && prev.type === 'op' && prev.value === ':' && next?.value === '(') return true;
    // A parameter or binding target: `function f(Instance)`, `local f, Instance`.
    // Excluded when the name is being *used* as the global (`f(Instance.new(...))`).
    if (
      prev &&
      prev.type === 'op' &&
      (prev.value === '(' || prev.value === ',') &&
      !(next && next.type === 'op' && (next.value === '.' || next.value === ':'))
    ) {
      return true;
    }
    // Plain reassignment: `Instance = ...` but not `Instance == ...`.
    if (next && next.type === 'op' && next.value === '=') return true;
  }
  return false;
}

export function analyzeSource(source, options = {}) {
  const file = options.file || '<script>';
  const { tokens, errors } = codeTokens(source);
  const diagnostics = [];

  for (const e of errors) {
    diagnostics.push(
      diag(ERROR, 'syntax-error', `${file}:${e.line}:${e.col}: ${e.message}`, {
        file,
        line: e.line,
        col: e.col,
      }),
    );
  }

  if (tokens.length > 1) {
    if (!isGlobalShadowed(tokens, 'Instance')) {
      checkInstanceNew(tokens, diagnostics, file);
      checkPropertyTypos(tokens, diagnostics, file);
    }
    if (!isGlobalShadowed(tokens, 'Enum')) checkEnumItems(tokens, diagnostics, file);
    if (!isGlobalShadowed(tokens, 'game')) checkGetService(tokens, diagnostics, file);
    checkDeprecated(tokens, diagnostics, file);
  }

  diagnostics.sort((a, b) => a.line - b.line || a.col - b.col);
  return { diagnostics, tokens, errors };
}

/**
 * Count and summarise diagnostics the same way the model validator does, so a
 * caller parses one shape everywhere.
 *
 * @param {Array<object>} diagnostics
 * @param {{scripts?: number}} [context]
 */
export function summarizeScripts(diagnostics, context = {}) {
  const errors = diagnostics.filter((d) => d.severity === ERROR);
  const warnings = diagnostics.filter((d) => d.severity === WARNING);
  return {
    ok: errors.length === 0,
    instanceCount: 0,
    scriptCount: context.scripts ?? 0,
    errorCount: errors.length,
    warningCount: warnings.length,
    diagnostics,
  };
}

export { KNOWN_GLOBALS as knownGlobals, DEPRECATED_GLOBALS as deprecatedGlobals, DEPRECATED_METHODS as deprecatedMethods };
export { readChain, isGlobalCall, propertyNamesFor };
