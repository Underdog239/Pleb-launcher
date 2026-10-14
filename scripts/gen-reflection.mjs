#!/usr/bin/env node
// Generates src/rbx/reflection.json from Roblox's official API dump.
//
// The API dump is the same data Studio emits via `--api` / `--fullApi`, so the
// generated table stays in sync with the engine. It carries a lot more than the
// serializer strictly needs, and most of the rest is exactly what an agent
// needs to avoid writing code the engine will not accept:
//
//   * Deprecated classes, properties and enum items (45 classes, 471 members,
//     150 enum items) — the linter and the validator report these by name.
//   * Per-property read/write security (691 persisted properties cannot be
//     written by a game script; 250 need plugin security). This is the
//     difference between "the property is set" and "the property silently does
//     nothing at runtime".
//   * ReadOnly, NotScriptable, Hidden, NotBrowsable, NotReplicated.
//
// All of that is packed into one integer per class and one per property so the
// file stays small; see FLAG BITS below, which `src/rbx/reflection.js` decodes.
//
// Usage:
//   node scripts/gen-reflection.mjs [path | URL | github:owner/repo:path]
//
// Sources, in order of what is reachable from a restricted environment:
//   github:MaximumADHD/Roblox-Client-Tracker:API-Dump.json
//     Fetches through the GitHub blob API, which works where
//     raw.githubusercontent.com is blocked. This is the default.
//   https://.../API-Dump.json   a plain URL
//   ./API-Dump.json             a local file, e.g. one downloaded by hand

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const DEFAULT_SOURCE = 'github:MaximumADHD/Roblox-Client-Tracker:API-Dump.json';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const outPath = path.join(here, '..', 'src', 'rbx', 'reflection.json');

// --- FLAG BITS -------------------------------------------------------------
// Property flags, packed into one integer at slot 5 of a property entry:
//
//   bits 0-2  write security  0 None, 1 LocalUser, 2 Plugin, 3 RobloxScript,
//                             4 Roblox, 5 NotAccessible
//   bits 3-5  read security   same scale
//   bit 6     ReadOnly
//   bit 7     Deprecated
//   bit 8     NotScriptable
//   bit 9     Hidden
//   bit 10    NotBrowsable
//   bit 11    NotReplicated
//
// Class flags, packed into `flags` on a class entry:
//
//   bit 0     Deprecated
//   bit 1     NotBrowsable
//   bit 2     NotReplicated
//   bit 3     PlayerReplicated
//
// A property entry is [valueType, canLoad, canSave, refClass, category, flags]
// and flags is omitted entirely when zero, so an ordinary property costs
// nothing.

const SECURITY_LEVELS = [
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

function securityIndex(value) {
  if (!value || value === 'None') return 0;
  const i = SECURITY_LEVELS.indexOf(value);
  if (i === -1) throw new Error(`unknown security level: ${value}`);
  return i;
}

// --- loading ---------------------------------------------------------------

/**
 * Fetch a file through the GitHub contents/blob API.
 *
 * The contents API refuses anything over 1 MiB and returns `encoding: none`
 * with a blob sha instead, so the blob API is used to get the bytes. That
 * round-trip is what makes this work in environments that cannot reach
 * raw.githubusercontent.com.
 */
async function fetchFromGithub(spec) {
  const [, owner, repo, file] = /^github:([^/:]+)\/([^/:]+):(.+)$/.exec(spec);
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'studio-cli-gen-reflection',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  const lookup = `https://api.github.com/repos/${owner}/${repo}/contents/${file}`;
  const meta = await fetchJson(lookup, headers);
  if (!meta || !meta.sha) throw new Error(`could not resolve ${owner}/${repo}/${file}`);

  if (meta.encoding === 'base64' && meta.content) {
    return JSON.parse(Buffer.from(meta.content, 'base64').toString('utf8'));
  }

  const blob = await fetchJson(`https://api.github.com/repos/${owner}/${repo}/git/blobs/${meta.sha}`, headers);
  if (!blob || blob.encoding !== 'base64') {
    throw new Error(`unexpected blob response for ${owner}/${repo}/${file}`);
  }
  const raw = Buffer.from(blob.content, 'base64').toString('utf8');
  return JSON.parse(raw);
}

async function fetchJson(target, headers = {}) {
  const res = await fetch(target, { headers });
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText} for ${target}`);
  return res.json();
}

async function load(source) {
  if (source.startsWith('github:')) return fetchFromGithub(source);
  if (/^https?:\/\//.test(source)) return fetchJson(source, { 'User-Agent': 'studio-cli-gen-reflection' });
  return JSON.parse(fs.readFileSync(source, 'utf8'));
}

// --- building --------------------------------------------------------------

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
  let annotated = 0;

  for (const cls of dump.Classes) {
    const props = {};
    for (const m of cls.Members) {
      if (m.MemberType !== 'Property') continue;
      const serialization = m.Serialization || {};
      const vt = valueTypeOf(m);
      if (!vt) continue;

      const tags = m.Tags || [];
      const security = m.Security || {};
      let flags = securityIndex(security.Write) | (securityIndex(security.Read) << 3);
      for (const [tag, bit] of Object.entries(PROPERTY_BITS)) {
        if (tags.includes(tag)) flags |= bit;
      }

      // [valueType, canLoad, canSave, refClass, category, flags]
      // The 5th slot records the dump's own Category. It is what distinguishes a
      // property typed as the legacy `Font` *enum* from one typed as the `Font`
      // *datatype* -- the two share a name, and without this the codec cannot
      // tell them apart and writes one of them as 0.
      // The 6th is omitted when zero so ordinary properties cost nothing.
      const entry = [
        vt.type,
        serialization.CanLoad === false ? 0 : 1,
        serialization.CanSave ? 1 : 0,
        vt.refClass,
        vt.category || null,
      ];
      if (flags !== 0) {
        entry.push(flags);
        annotated += 1;
      }
      props[m.Name] = entry;
    }

    const tags = cls.Tags || [];
    let classFlags = 0;
    for (const [tag, bit] of Object.entries(CLASS_BITS)) {
      if (tags.includes(tag)) classFlags |= bit;
    }

    classes[cls.Name] = {
      super: cls.Superclass || null,
      service: tags.includes('Service') ? 1 : 0,
      notCreatable: tags.includes('NotCreatable') ? 1 : 0,
      ...(classFlags ? { flags: classFlags } : {}),
      props,
    };
  }

  const enums = {};
  const deprecatedItems = {};
  for (const e of dump.Enums || []) {
    const items = {};
    for (const item of e.Items || []) items[item.Name] = item.Value;
    enums[e.Name] = items;

    // 150 items across 15 enums, so a side table costs nothing and keeps the
    // common shape `{ itemName: value }` untouched for every other reader.
    const deprecated = (e.Items || [])
      .filter((item) => (item.Tags || []).includes('Deprecated'))
      .map((item) => item.Name);
    if (deprecated.length > 0) deprecatedItems[e.Name] = deprecated;
  }

  return {
    source: 'Roblox API Dump (Roblox-Client-Tracker mirror)',
    ...(dump.Version !== undefined ? { dumpVersion: dump.Version } : {}),
    classCount: Object.keys(classes).length,
    enumCount: Object.keys(enums).length,
    annotatedProperties: annotated,
    ...(Object.keys(deprecatedItems).length > 0 ? { deprecatedItems } : {}),
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
  `wrote ${outPath} (${result.classCount} classes, ${result.enumCount} enums, ` +
    `${result.annotatedProperties} properties annotated, ${(bytes / 1024).toFixed(1)} KiB)`,
);
