#!/usr/bin/env node
// Generates src/rbx/reflection.json from Roblox's official API dump.
//
// The API dump is the same data Studio emits via `--api` / `--fullApi`, so the
// generated table stays in sync with the engine. We keep only what the
// serializer needs: class hierarchy, serializable properties + their value
// types, and enum item values.
//
// Usage:
//   node scripts/gen-reflection.mjs [path-or-url-to-API-Dump.json]
//
// Defaults to the Roblox-Client-Tracker mirror, which tracks the live client.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const DEFAULT_SOURCE =
  'https://raw.githubusercontent.com/MaximumADHD/Roblox-Client-Tracker/roblox/API-Dump.json';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const outPath = path.join(here, '..', 'src', 'rbx', 'reflection.json');

async function load(source) {
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
    return res.json();
  }
  return JSON.parse(fs.readFileSync(source, 'utf8'));
}

function valueTypeOf(member) {
  const vt = member.ValueType || member.DataType;
  if (!vt) return null;
  // Properties typed as a specific class (e.g. Model.PrimaryPart: BasePart)
  // serialize as instance references, but we keep the class name so validation
  // can check that a reference actually points at a legal target.
  if (vt.Category === 'Class') return { type: 'Instance', refClass: vt.Name, category: 'Class' };
  return { type: vt.Name, refClass: null, category: vt.Category || null };
}

function build(dump) {
  const classes = {};
  for (const cls of dump.Classes) {
    const props = {};
    for (const m of cls.Members) {
      if (m.MemberType !== 'Property') continue;
      const serialization = m.Serialization || {};
      const vt = valueTypeOf(m);
      if (!vt) continue;
      // [valueType, canLoad, canSave, refClass]
      // The 5th slot records the dump's own Category. It is what distinguishes a
      // property typed as the legacy `Font` *enum* from one typed as the `Font`
      // *datatype* -- the two share a name, and without this the codec cannot
      // tell them apart and writes one of them as 0.
      props[m.Name] = [
        vt.type,
        serialization.CanLoad === false ? 0 : 1,
        serialization.CanSave ? 1 : 0,
        vt.refClass,
        vt.category || null,
      ];
    }
    const tags = cls.Tags || [];
    classes[cls.Name] = {
      super: cls.Superclass || null,
      service: tags.includes('Service') ? 1 : 0,
      notCreatable: tags.includes('NotCreatable') ? 1 : 0,
      props,
    };
  }

  const enums = {};
  for (const e of dump.Enums || []) {
    const items = {};
    for (const item of e.Items || []) items[item.Name] = item.Value;
    enums[e.Name] = items;
  }

  return {
    source: 'Roblox API Dump (Roblox-Client-Tracker mirror)',
    classCount: Object.keys(classes).length,
    enumCount: Object.keys(enums).length,
    classes,
    enums,
  };
}

const source = process.argv[2] || DEFAULT_SOURCE;
const dump = await load(source);
const result = build(dump);
fs.writeFileSync(outPath, JSON.stringify(result));
const bytes = fs.statSync(outPath).size;
console.log(
  `wrote ${outPath} (${result.classCount} classes, ${result.enumCount} enums, ${(bytes / 1024).toFixed(1)} KiB)`,
);
