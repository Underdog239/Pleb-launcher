// Local backend: filesystem + DataModel operations with no Roblox install.
//
// This is the "approximate Studio" side of the CLI. It can read/write model
// files, walk the instance tree, build from a Rojo-style project, create models
// from a JSON spec, and produce an offline visualisation. It cannot execute
// engine Luau or run physics (see docs/backends.md).

import fs from 'node:fs';
import path from 'node:path';
import { Instance, createInstance } from '../../rbx/instance.js';
import { loadModel, saveModel, formatFor } from '../../rbx/io.js';
import { serializationFor, isEnumValueType, enumValue, hasClass } from '../../rbx/reflection.js';
import { closestName } from '../../rbx/validate.js';
import { v3, v2, color3, udim, udim2, cframe, IDENTITY_ROTATION } from '../../rbx/datatypes.js';

export const name = 'local';
export const capabilities = {
  executeLuau: false,
  physics: false,
  render: 'approximate',
  requiresStudio: false,
  platform: 'any',
};

// --- paths ------------------------------------------------------------------

function splitPath(p) {
  return String(p)
    .split('.')
    .filter((s) => s.length > 0 && s !== 'game');
}

/** Resolve a dot path such as "Workspace.Part" or "game.Workspace.Part". */
export function resolvePath(roots, p) {
  const parts = splitPath(p);
  if (parts.length === 0) return null;
  let nodes = roots;
  let found = null;
  for (const part of parts) {
    found = nodes.find((n) => n.name === part) || null;
    if (!found) return null;
    nodes = found.children;
  }
  return found;
}

// --- JSON projection --------------------------------------------------------

export function toJsonValue(v) {
  if (v === undefined || v === null) return null;
  if (v instanceof Instance) return { $ref: v.getFullName() };
  if (v instanceof Uint8Array) return { $binaryBase64: Buffer.from(v).toString('base64') };
  if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
  return v;
}

function treeNode(inst, depth, maxDepth) {
  const node = {
    className: inst.className,
    name: inst.name,
    path: inst.getFullName(),
  };
  if (maxDepth === undefined || maxDepth === null || depth < maxDepth) {
    if (inst.children.length) node.children = inst.children.map((c) => treeNode(c, depth + 1, maxDepth));
  } else if (inst.children.length) {
    node.childCount = inst.children.length;
  }
  return node;
}

export function tree(roots, { path: p = '', depth = null } = {}) {
  if (p) {
    const inst = resolvePath(roots, p);
    if (!inst) throw new Error(`path not found: ${p}`);
    return treeNode(inst, 0, depth);
  }
  return { className: 'DataModel', name: 'game', path: 'game', children: roots.map((r) => treeNode(r, 1, depth)) };
}

export function inspect(roots, p) {
  const inst = resolvePath(roots, p);
  if (!inst) throw new Error(`path not found: ${p}`);
  const ser = serializationFor(inst.className);
  const properties = {};
  for (const [prop, value] of inst.props) {
    const info = ser.forward.get(prop);
    properties[prop] = {
      value: toJsonValue(value),
      serializedAs: info ? info.serializedName : prop,
      // valueType is how the property is stored; canonicalType is how the API
      // names it and how you write it (they differ for Color3 -> Color3uint8).
      valueType: info ? info.valueType : null,
      canonicalType: info ? info.canonicalType || info.valueType : null,
      serializable: !!info,
    };
  }
  return {
    className: inst.className,
    name: inst.name,
    path: inst.getFullName(),
    isService: inst.isService,
    propertyCount: inst.props.size,
    properties,
    children: inst.children.map((c) => ({ className: c.className, name: c.name })),
  };
}

export function readScript(roots, p) {
  const inst = resolvePath(roots, p);
  if (!inst) throw new Error(`path not found: ${p}`);
  const source = inst.props.get('Source');
  return {
    path: inst.getFullName(),
    className: inst.className,
    source: typeof source === 'string' ? source : '',
  };
}

export function stats(roots) {
  const counts = {};
  let total = 0;
  const visit = (i) => {
    total++;
    counts[i.className] = (counts[i.className] || 0) + 1;
    for (const c of i.children) visit(c);
  };
  for (const r of roots) visit(r);
  return { total, byClass: counts };
}

export { loadModel, saveModel, formatFor, createInstance };

// --- value coercion ---------------------------------------------------------

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const nums = (v, n) => Array.isArray(v) && v.length === n && v.every(isNum);

/**
 * Coerce a JSON value into the representation a property expects.
 *
 * Coercion is deliberately *strict about shape*: anything it cannot interpret
 * is returned untouched so the validation layer reports it. Silently defaulting
 * a malformed value (e.g. a string passed where a Vector3 belongs) is how an
 * agent ends up shipping a 0,0,0 part while believing it built a real one.
 *
 * For the same reason it never throws: an unknown enum item is handed to the
 * validator untouched, which reports it once, with the full path and a
 * did-you-mean — instead of aborting on the first problem and hiding the rest.
 */
export function coerce(value, valueType) {
  if (value === null || value === undefined) return value;

  if (isEnumValueType(valueType)) {
    if (typeof value === 'number') return value;
    const v = enumValue(valueType, String(value));
    return v === undefined ? value : v;
  }

  switch (valueType) {
    case 'Vector2':
      if (nums(value, 2)) return v2(value[0], value[1]);
      if (value && isNum(value.x) && isNum(value.y)) return v2(value.x, value.y);
      return value;
    case 'Vector3':
    case 'Vector3int16':
      if (nums(value, 3)) return v3(value[0], value[1], value[2]);
      if (value && isNum(value.x) && isNum(value.y) && isNum(value.z)) {
        return v3(value.x, value.y, value.z);
      }
      return value;
    case 'Color3':
      if (nums(value, 3)) return color3(value[0], value[1], value[2]);
      if (value && isNum(value.r) && isNum(value.g) && isNum(value.b)) {
        return color3(value.r, value.g, value.b);
      }
      return value;
    case 'Color3uint8':
      if (nums(value, 3)) return { r: value[0], g: value[1], b: value[2] };
      if (value && isNum(value.r) && isNum(value.g) && isNum(value.b)) return { ...value };
      return value;
    case 'UDim':
      if (nums(value, 2)) return udim(value[0], value[1]);
      if (value && isNum(value.scale) && isNum(value.offset)) return udim(value.scale, value.offset);
      return value;
    case 'UDim2':
      if (nums(value, 4)) return udim2(udim(value[0], value[1]), udim(value[2], value[3]));
      if (value && value.x && value.y && isNum(value.x.scale) && isNum(value.y.scale)) return value;
      return value;
    case 'CFrame':
      if (nums(value, 3)) return cframe(v3(value[0], value[1], value[2]), IDENTITY_ROTATION);
      if (nums(value, 12)) {
        return cframe(v3(value[0], value[1], value[2]), value.slice(3));
      }
      if (value && value.position && nums(value.rotation, 9)) {
        return cframe(v3(value.position.x, value.position.y, value.position.z), value.rotation);
      }
      return value;
    case 'NumberRange':
      if (nums(value, 2)) return { min: value[0], max: value[1] };
      if (value && isNum(value.min) && isNum(value.max)) return value;
      return value;
    case 'Rect':
      if (nums(value, 4)) return { min: v2(value[0], value[1]), max: v2(value[2], value[3]) };
      return value;
    default:
      return value;
  }
}

// --- model spec -> instances ------------------------------------------------

/**
 * The type an author writes for a property: the API's canonical type, which is
 * not always the type on disk. `BasePart.Color` is a `Color3` (0..1 floats) in
 * the API but is persisted as a `Color3uint8`; the writer scales it, so the
 * spec, the coercion and the validator all speak canonical types.
 */
export function authoringType(info) {
  if (!info) return null;
  return info.canonicalType || info.valueType;
}

/** Build instances from a JSON spec: { className, name, properties, children }. */
export function modelFromSpec(spec) {
  const list = Array.isArray(spec) ? spec : [spec];
  return list.map((node) => buildSpecNode(node));
}

function buildSpecNode(node) {
  const className = node.className || node.$className || 'Folder';
  if (!hasClass(className)) throw new Error(`unknown class: ${className}`);
  const inst = new Instance(className, node.name || className);
  const ser = serializationFor(className);
  for (const [prop, raw] of Object.entries(node.properties || node.$properties || {})) {
    inst.set(prop, coerce(raw, authoringType(ser.forward.get(prop))));
  }
  for (const child of node.children || []) inst.addChild(buildSpecNode(child));
  return inst;
}

// --- Rojo-style project build ----------------------------------------------

const SCRIPT_CLASSES = {
  '.lua': 'ModuleScript',
  '.luau': 'ModuleScript',
  '.server.lua': 'Script',
  '.server.luau': 'Script',
  '.client.lua': 'LocalScript',
  '.client.luau': 'LocalScript',
};

function scriptClassFor(baseName) {
  const lower = baseName.toLowerCase();
  for (const key of ['.server.luau', '.server.lua', '.client.luau', '.client.lua', '.luau', '.lua']) {
    if (lower.endsWith(key)) return SCRIPT_CLASSES[key];
  }
  return null;
}

function scriptNameFor(baseName) {
  return baseName.replace(/\.(server|client)?\.?(lua|luau)$/i, '');
}

/** Build instances from a Rojo-style project tree. */
export function buildFromProject(projectPath) {
  const abs = path.resolve(projectPath);
  const project = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const baseDir = path.dirname(abs);
  const treeSpec = project.tree || project;
  const roots = Object.entries(treeSpec).map(([key, spec]) => buildProjectNode(key, spec, baseDir));
  return { roots, projectName: project.name || null };
}

function buildProjectNode(nodeName, spec, baseDir) {
  if (spec === null || typeof spec !== 'object') {
    throw new Error(`invalid project node: ${nodeName}`);
  }
  let target = null;
  let targetIsDir = false;
  if (spec.$path) {
    target = path.resolve(baseDir, spec.$path);
    targetIsDir = fs.statSync(target).isDirectory();
  }

  let className = spec.$className || 'Folder';
  if (target && !targetIsDir && !spec.$className) {
    const cls = scriptClassFor(path.basename(target));
    if (cls) className = cls;
  }

  const inst = new Instance(className, nodeName);
  const ser = serializationFor(className);

  for (const [prop, raw] of Object.entries(spec.$properties || {})) {
    inst.set(prop, coerce(raw, authoringType(ser.forward.get(prop))));
  }

  if (target) {
    if (targetIsDir) {
      for (const entry of fs.readdirSync(target).sort()) {
        const childPath = path.join(target, entry);
        if (fs.statSync(childPath).isDirectory()) {
          inst.addChild(buildProjectNode(entry, { $className: 'Folder', $path: childPath }, baseDir));
        } else if (entry.startsWith('init.')) {
          inst.set('Source', fs.readFileSync(childPath, 'utf8'));
        } else {
          const cls = scriptClassFor(entry);
          if (cls) {
            const child = new Instance(cls, scriptNameFor(entry));
            child.set('Source', fs.readFileSync(childPath, 'utf8'));
            inst.addChild(child);
          }
        }
      }
    } else {
      const cls = scriptClassFor(path.basename(target));
      if (cls) inst.set('Source', fs.readFileSync(target, 'utf8'));
    }
  }

  for (const [key, child] of Object.entries(spec)) {
    if (key.startsWith('$')) continue;
    inst.addChild(buildProjectNode(key, child, baseDir));
  }

  return inst;
}

// --- script perception ------------------------------------------------------

/** Every descendant (root-inclusive) that carries a readable `Source`. */
export function collectScripts(roots) {
  const out = [];
  const visit = (i) => {
    if (i.isA('LuaSourceContainer') && typeof i.get('Source') === 'string') out.push(i);
    for (const c of i.children) visit(c);
  };
  for (const r of roots) {
    if (r.isA('LuaSourceContainer') && typeof r.get('Source') === 'string') out.push(r);
    for (const c of r.children) visit(c);
  }
  return out;
}

/**
 * Text/regex search across every script's source.
 *
 * Studio's MCP server exposes `script_grep`; this is the local, headless
 * equivalent, and it works on a place file instead of a live DataModel.
 *
 * @param {Instance[]} roots
 * @param {string} pattern
 * @param {{ignoreCase?: boolean, fixed?: boolean, path?: string, limit?: number}} [options]
 */
export function scriptGrep(roots, pattern, options = {}) {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    throw new Error('scriptGrep needs a non-empty pattern');
  }
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 200;

  let test;
  if (options.fixed) {
    const needle = options.ignoreCase ? pattern.toLowerCase() : pattern;
    test = (line) => {
      const hay = options.ignoreCase ? line.toLowerCase() : line;
      const index = hay.indexOf(needle);
      return index === -1 ? null : { index, length: pattern.length };
    };
  } else {
    let re;
    try {
      re = new RegExp(pattern, options.ignoreCase ? 'i' : '');
    } catch (err) {
      // A bad pattern is the caller's mistake; say what to fix, don't guess.
      throw new Error(`scriptGrep: invalid regular expression /${pattern}/ — ${err.message}`);
    }
    test = (line) => {
      const m = re.exec(line);
      return m ? { index: m.index, length: Math.max(m[0].length, 1) } : null;
    };
  }

  const scope = options.path ? resolvePath(roots, options.path) : null;
  if (options.path && !scope) throw new Error(`path not found: ${options.path}`);
  const scripts = collectScripts(scope ? [scope] : roots);

  const matches = [];
  const files = [];
  let matchCount = 0;

  for (const script of scripts) {
    const source = script.get('Source') || '';
    const lines = source.split(/\r\n|\r|\n/);
    let hits = 0;
    for (let i = 0; i < lines.length; i++) {
      const found = test(lines[i]);
      if (!found) continue;
      hits++;
      matchCount++;
      if (matches.length >= limit) continue;
      matches.push({
        path: script.getFullName(),
        className: script.className,
        line: i + 1,
        column: found.index + 1,
        text: lines[i].length > 200 ? `${lines[i].slice(0, 200)}…` : lines[i],
      });
    }
    if (hits > 0) files.push({ path: script.getFullName(), className: script.className, matches: hits, lines: lines.length });
  }

  return {
    pattern,
    fixed: !!options.fixed,
    ignoreCase: !!options.ignoreCase,
    scope: options.path || 'game',
    scriptCount: scripts.length,
    matchCount,
    files,
    matches,
    ...(matchCount > matches.length ? { truncated: true, limit, returned: matches.length } : {}),
  };
}

// --- model diff -------------------------------------------------------------

function normalizeForCompare(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Instance) return { $ref: value.getFullName() };
  if (value instanceof Uint8Array) return { $binaryBase64: Buffer.from(value).toString('base64') };
  if (Array.isArray(value)) return value.map(normalizeForCompare);
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = normalizeForCompare(value[key]);
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  return value;
}

function valuesEqual(a, b) {
  return JSON.stringify(normalizeForCompare(a)) === JSON.stringify(normalizeForCompare(b));
}

function indexByPath(roots) {
  const map = new Map();
  const visit = (inst) => {
    map.set(inst.getFullName(), inst);
    for (const c of inst.children) visit(c);
  };
  for (const r of roots) visit(r);
  return map;
}

/**
 * Structural diff of two models, keyed by instance path.
 *
 * "What changed between these two files?" is the question an agent asks most
 * often after editing, and the answer is not useful as a byte comparison.
 */
export function diffModels(aRoots, bRoots) {
  const a = indexByPath(aRoots);
  const b = indexByPath(bRoots);

  const added = [];
  const removed = [];
  const changed = [];

  for (const [path, inst] of b) {
    if (!a.has(path)) {
      added.push({ path, className: inst.className });
      continue;
    }
    const before = a.get(path);
    const entry = { path, className: inst.className, changes: [] };
    if (before.className !== inst.className) {
      entry.changes.push({ kind: 'class', from: before.className, to: inst.className });
    }
    if (before.name !== inst.name) entry.changes.push({ kind: 'name', from: before.name, to: inst.name });
    const props = new Set([...before.props.keys(), ...inst.props.keys()]);
    for (const prop of [...props].sort()) {
      const from = before.props.get(prop);
      const to = inst.props.get(prop);
      const fromHas = before.props.has(prop);
      const toHas = inst.props.has(prop);
      if (fromHas && toHas && valuesEqual(from, to)) continue;
      if (!fromHas && !toHas) continue;
      entry.changes.push({
        kind: 'property',
        property: prop,
        from: fromHas ? toJsonValue(from) : undefined,
        to: toHas ? toJsonValue(to) : undefined,
      });
    }
    if (entry.changes.length > 0) changed.push(entry);
  }

  for (const [path, inst] of a) {
    if (!b.has(path)) removed.push({ path, className: inst.className });
  }

  return {
    summary: {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      unchanged: [...b.keys()].filter((p) => a.has(p) && !changed.some((c) => c.path === p)).length,
    },
    added,
    removed,
    changed,
  };
}

// --- script editing ---------------------------------------------------------

/**
 * Apply script source edits in memory: replace a whole file, or a substring.
 *
 * Every edit is resolved and checked before any of them is applied, so a typo
 * in one path cannot leave a model half-edited. Errors are reported together
 * with the same diagnostic shape the validator uses.
 *
 * @param {Instance[]} roots
 * @param {Array<{path: string, source?: string, find?: string, replace?: string, all?: boolean}>} edits
 * @param {{force?: boolean}} [options]
 */
export function applyScriptEdits(roots, edits, options = {}) {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new Error('applyScriptEdits needs a non-empty array of edits');
  }
  const known = [...indexByPath(roots).keys()];
  const diagnostics = [];
  const plans = [];

  edits.forEach((edit, i) => {
    const at = edit?.path ? String(edit.path) : `edits[${i}]`;
    if (!edit || typeof edit !== 'object') {
      diagnostics.push({ severity: 'error', code: 'invalid-edit', message: `${at}: an edit must be an object`, path: at });
      return;
    }
    if (!edit.path) {
      diagnostics.push({
        severity: 'error',
        code: 'invalid-edit',
        message: `edits[${i}]: missing "path" (the script instance to edit)`,
        path: `edits[${i}]`,
        suggestion: known.slice(0, 3).join(', '),
      });
      return;
    }
    const inst = resolvePath(roots, edit.path);
    if (!inst) {
      diagnostics.push({
        severity: 'error',
        code: 'path-not-found',
        message: `${at}: no instance at that path`,
        path: at,
        suggestion: closestName(edit.path, known),
      });
      return;
    }
    if (!inst.isA('LuaSourceContainer')) {
      diagnostics.push({
        severity: 'error',
        code: 'not-a-script',
        message: `${at}: ${inst.className} has no Source (expected Script, ModuleScript or LocalScript)`,
        path: at,
        actual: inst.className,
      });
      return;
    }
    const current = typeof inst.get('Source') === 'string' ? inst.get('Source') : '';

    if (typeof edit.source === 'string') {
      plans.push({ inst, path: inst.getFullName(), next: edit.source, mode: 'replace' });
      return;
    }
    if (typeof edit.find === 'string' && typeof edit.replace === 'string') {
      if (edit.find.length === 0) {
        diagnostics.push({
          severity: 'error',
          code: 'invalid-edit',
          message: `${at}: "find" must not be empty`,
          path: at,
        });
        return;
      }
      const count = current.split(edit.find).length - 1;
      if (count === 0) {
        diagnostics.push({
          severity: 'error',
          code: 'no-match',
          message: `${at}: "find" text does not occur in ${inst.getFullName()}`,
          path: at,
          actual: edit.find,
        });
        return;
      }
      if (count > 1 && !edit.all) {
        diagnostics.push({
          severity: 'error',
          code: 'ambiguous-edit',
          message: `${at}: "find" matches ${count} times; pass "all": true or a unique snippet`,
          path: at,
          actual: count,
        });
        return;
      }
      const next = edit.all ? current.split(edit.find).join(edit.replace) : current.replace(edit.find, edit.replace);
      plans.push({ inst, path: inst.getFullName(), next, mode: 'replace-text', occurrences: edit.all ? count : 1 });
      return;
    }
    diagnostics.push({
      severity: 'error',
      code: 'invalid-edit',
      message: `${at}: provide either "source" or both "find" and "replace"`,
      path: at,
    });
  });

  const errors = diagnostics.filter((d) => d.severity === 'error');
  if (errors.length > 0 && !options.force) {
    return { applied: 0, files: [], diagnostics, ok: false };
  }

  const files = [];
  for (const plan of plans) {
    const before = typeof plan.inst.get('Source') === 'string' ? plan.inst.get('Source') : '';
    plan.inst.set('Source', plan.next);
    files.push({
      path: plan.path,
      mode: plan.mode,
      ...(plan.occurrences ? { occurrences: plan.occurrences } : {}),
      bytesBefore: before.length,
      bytesAfter: plan.next.length,
    });
  }

  return { applied: plans.length, files, diagnostics, ok: errors.length === 0 };
}

