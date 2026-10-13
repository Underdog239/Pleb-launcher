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
      valueType: info ? info.valueType : null,
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

/** Coerce a JSON value into the representation a property expects. */
export function coerce(value, valueType) {
  if (value === null || value === undefined) return value;
  if (isEnumValueType(valueType)) {
    if (typeof value === 'number') return value;
    const v = enumValue(valueType, String(value));
    if (v === undefined) throw new Error(`unknown ${valueType} item: ${value}`);
    return v;
  }
  const arr = Array.isArray(value);
  switch (valueType) {
    case 'Vector3':
      return arr ? v3(value[0], value[1], value[2]) : v3(value.x, value.y, value.z);
    case 'Vector2':
      return arr ? v2(value[0], value[1]) : v2(value.x, value.y);
    case 'Color3':
      return arr ? color3(value[0], value[1], value[2]) : color3(value.r, value.g, value.b);
    case 'Color3uint8':
      return arr ? { r: value[0], g: value[1], b: value[2] } : value;
    case 'UDim':
      return arr ? udim(value[0], value[1]) : udim(value.scale, value.offset);
    case 'UDim2':
      return arr ? udim2(udim(value[0], value[1]), udim(value[2], value[3])) : value;
    case 'CFrame':
      if (arr) {
        return cframe(
          v3(value[0], value[1], value[2]),
          value.length > 3 ? value.slice(3) : IDENTITY_ROTATION,
        );
      }
      return cframe(
        v3(value.position.x, value.position.y, value.position.z),
        value.rotation || IDENTITY_ROTATION,
      );
    case 'NumberRange':
      return arr ? { min: value[0], max: value[1] } : value;
    case 'Rect':
      return arr ? { min: v2(value[0], value[1]), max: v2(value[2], value[3]) } : value;
    default:
      return value;
  }
}

// --- model spec -> instances ------------------------------------------------

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
    const info = ser.forward.get(prop);
    inst.set(prop, coerce(raw, info ? info.valueType : null));
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
  const className = spec.$className || 'Folder';
  const inst = new Instance(className, nodeName);
  const ser = serializationFor(className);

  for (const [prop, raw] of Object.entries(spec.$properties || {})) {
    const info = ser.forward.get(prop);
    inst.set(prop, coerce(raw, info ? info.valueType : null));
  }

  if (spec.$path) {
    const target = path.resolve(baseDir, spec.$path);
    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
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
      if (cls) {
        const child = new Instance(cls, scriptNameFor(path.basename(target)));
        child.set('Source', fs.readFileSync(target, 'utf8'));
        inst.addChild(child);
      }
    }
  }

  for (const [key, child] of Object.entries(spec)) {
    if (key.startsWith('$')) continue;
    inst.addChild(buildProjectNode(key, child, baseDir));
  }

  return inst;
}

