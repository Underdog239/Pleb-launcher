#!/usr/bin/env node
// Generates src/rbx/patches.json from rbx-dom's patch database.
//
// The Roblox API dump does not describe every serialization detail. Some
// properties are persisted under a different *serialized name* or type, e.g.
// BasePart.Size -> "size" and BasePart.Color -> "Color" as Color3uint8.
// rbx-dom tracks these in patches/*.yml; we fold them into a compact table.
//
// Usage: node scripts/gen-patches.mjs

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const REPO = 'rojo-rbx/rbx-dom';
const here = path.dirname(url.fileURLToPath(import.meta.url));
const outPath = path.join(here, '..', 'src', 'rbx', 'patches.json');

async function api(p) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/${p}`, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub API ${p}: ${res.status}`);
  return res.json();
}

async function raw(p) {
  const res = await fetch(`https://raw.githubusercontent.com/${REPO}/master/${p}`);
  if (!res.ok) throw new Error(`raw ${p}: ${res.status}`);
  return res.text();
}

/**
 * Minimal indentation-based parser for the subset of YAML these patches use:
 * nested `key:` mappings and `key: value` scalars.
 */
function parseYaml(text) {
  const root = {};
  const stack = [{ indent: -1, node: root }];
  for (const rawLine of text.split('\n')) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].node;
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim().replace(/^["']|["']$/g, '');
    const value = m[2].trim();
    if (value === '') {
      const child = {};
      parent[key] = child;
      stack.push({ indent, node: child });
    } else {
      parent[key] = value.replace(/^["']|["']$/g, '');
    }
  }
  return root;
}

const tree = await api('git/trees/master?recursive=1');
const files = tree.tree.map((t) => t.path).filter((p) => /^patches\/.*\.yml$/.test(p));

// SerializesAs values are ambiguous in the patch files: they name either a
// sibling property (e.g. "size") or a datatype (e.g. "Color3uint8"). rbx-dom
// resolves against the class's properties; we classify by datatype name.
const DATATYPES = new Set([
  'bool', 'int', 'int64', 'float', 'double', 'string', 'BinaryString',
  'ContentId', 'ProtectedString', 'Content', 'Vector2', 'Vector3',
  'Vector3int16', 'CFrame', 'Color3', 'Color3uint8', 'UDim', 'UDim2', 'Ray',
  'Faces', 'Axes', 'BrickColor', 'NumberSequence', 'ColorSequence',
  'NumberRange', 'Rect', 'PhysicalProperties', 'Font',
  'SecurityCapabilities', 'UniqueId', 'SharedString', 'Instance',
]);


const classes = {};
const migrations = {};

for (const file of files) {
  const parsed = parseYaml(await raw(file));
  const change = parsed.Change || {};
  for (const [className, props] of Object.entries(change)) {
    if (!props || typeof props !== 'object') continue;
    for (const [propName, spec] of Object.entries(props)) {
      if (!spec || typeof spec !== 'object') continue;
      const ser = spec.Serialization;
      if (!ser || typeof ser !== 'object') continue;
      if (ser.Type === 'SerializesAs') {
        classes[className] ||= {};
        classes[className][propName] = DATATYPES.has(ser.As) ? { as: ser.As, kind: 'type' } : { as: ser.As, kind: 'name' };
      } else if (ser.Type === 'Migrate') {
        migrations[className] ||= {};
        migrations[className][propName] = { to: ser.To, migration: ser.Migration };
      }
    }
  }
}

const out = {
  source: `${REPO} patches/*.yml`,
  classCount: Object.keys(classes).length,
  classes,
  migrations,
};
fs.writeFileSync(outPath, JSON.stringify(out));
console.log(
  `wrote ${outPath} (${Object.keys(classes).length} classes with serialized names, ${Object.keys(migrations).length} with migrations)`,
);
