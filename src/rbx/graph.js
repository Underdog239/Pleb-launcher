// Who points at what.
//
// A Roblox place is a graph, not a list: ObjectValues, Adornees, PrimaryParts,
// Seat.Occupant, attachments, HumanoidRootParts and 300-odd other properties
// hold real references between instances. Nothing in the toolchain currently
// answers "what breaks if I delete this", "where is this asset used", or
// "which of these references is already broken" — and all three are answerable
// exactly, because the reflection data says which properties are Instance-typed
// and the model carries the target.
//
// Every finding here is read straight off the model. Nothing is inferred.

import { serializationFor } from './reflection.js';
import { closestName } from './validate.js';

/** Content-typed properties hold an asset reference as a string. */
const CONTENT_TYPES = new Set(['Content', 'ContentId']);

/** Instance-typed properties are the edges of the reference graph. */
const REF_TYPE = 'Instance';

/**
 * Content URLs have a fixed shape: `rbxassetid://123`, `rbxasset://...`,
 * `rbxthumb://...`, `http(s)://...`. We extract the number when there is one
 * and keep the raw string either way, so nothing is lost or invented.
 */
const ASSET_PATTERN = /^(rbxassetid|rbxasset|rbxthumb|rbxgameasset|https?):\/\/(.*)$/i;

/** Walk every instance in a set of roots, parents first. */
export function walk(roots) {
  const out = [];
  const visit = (inst) => {
    out.push(inst);
    for (const child of inst.children) visit(child);
  };
  for (const root of roots) visit(root);
  return out;
}

/**
 * Index a tree by full name. A name can legitimately repeat in a place
 * (`game.Workspace.Part` twice under different parents), so duplicates are
 * recorded rather than silently collapsed: a caller that got here by an
 * ambiguous path deserves to know.
 */
export function indexByPath(roots) {
  const index = new Map();
  const duplicates = new Set();
  for (const inst of walk(roots)) {
    const full = inst.getFullName();
    if (index.has(full)) duplicates.add(full);
    else index.set(full, inst);
  }
  return Object.assign(index, { duplicates });
}

/** The value types a class can hold a reference in. */
function refPropertiesFor(className) {
  const { forward } = serializationFor(className);
  const out = [];
  for (const [name, info] of forward) {
    if (info.valueType === REF_TYPE) out.push({ name, refClass: info.refClass || 'Instance' });
  }
  return out;
}

function contentPropertiesFor(className) {
  const { forward } = serializationFor(className);
  const out = [];
  for (const [name, info] of forward) {
    if (CONTENT_TYPES.has(info.valueType)) out.push({ name, valueType: info.valueType });
  }
  return out;
}

/**
 * Every reference edge in the model.
 *
 * @returns {{
 *   nodes: number,
 *   edges: {from: string, property: string, to: string, toClass: string}[],
 *   broken: {from: string, property: string, refClass: string, reason: string}[],
 *   incoming: Map<string, {from: string, property: string}[]>,
 * }}
 */
export function referenceGraph(roots) {
  const all = walk(roots);
  const known = new Set(all);
  const edges = [];
  const broken = [];
  const incoming = new Map();

  const addIncoming = (to, entry) => {
    const list = incoming.get(to);
    if (list) list.push(entry);
    else incoming.set(to, [entry]);
  };

  for (const inst of all) {
    for (const [property, value] of inst.props) {
      // A reference that is `null` is *not* reported as broken. Roblox defaults
      // every reference property to nothing, both decoders store an empty
      // reference as null, and a reference to a referent id that does not
      // resolve also arrives here as null. The three cases are indistinguishable
      // after loading, so claiming any of them is broken would be a guess —
      // and `Workspace.CurrentCamera` being nothing is the normal state of a
      // place, not a fault. Silence is the only honest answer.
      if (value === null || value === undefined) continue;
      if (!(value instanceof Object) || typeof value.getFullName !== 'function') continue;
      const info = serializationFor(inst.className).forward.get(property);
      if (!info || info.valueType !== REF_TYPE) continue;

      const from = inst.getFullName();
      const to = value.getFullName();
      edges.push({ from, property, to, toClass: value.className });
      addIncoming(to, { from, property });

      if (!known.has(value)) {
        // The target is a real instance the caller handed us, but it is not in
        // this tree — a genuine, reportable dangling reference.
        broken.push({
          from,
          property,
          refClass: info.refClass || 'Instance',
          reason: `points at ${to}, which is not part of this model`,
        });
      } else if (typeof value.isA === 'function' && info.refClass && info.refClass !== 'Instance') {
        if (!value.isA(info.refClass)) {
          broken.push({
            from,
            property,
            refClass: info.refClass,
            reason: `points at a ${value.className}, but this property requires ${info.refClass} or a subclass`,
          });
        }
      }
    }
  }

  edges.sort((a, b) => a.from.localeCompare(b.from) || a.property.localeCompare(b.property));
  return { nodes: all.length, edges, broken, incoming };
}

/** Split a content URL into the parts worth knowing about. */
export function parseContentUrl(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const match = ASSET_PATTERN.exec(raw.trim());
  const scheme = match ? match[1].toLowerCase() : 'plain';
  const rest = match ? match[2] : raw.trim();
  const numeric = /^(\d+)/.exec(rest);
  return {
    raw: raw.trim(),
    scheme,
    assetId: numeric ? Number(numeric[1]) : null,
    external: scheme === 'http' || scheme === 'https',
  };
}

/** A short, honest description of what an asset slot is for. */
function assetKind(className, property) {
  const known = {
    'Decal.Texture': 'image',
    'ImageLabel.Image': 'image',
    'ImageButton.Image': 'image',
    'Texture.Texture': 'image',
    'Sky.SkyboxUp': 'skybox',
    'Sound.SoundId': 'sound',
    'MeshPart.MeshId': 'mesh',
    'SpecialMesh.MeshId': 'mesh',
    'SpecialMesh.TextureId': 'image',
    'Animation.AnimationId': 'animation',
    'ParticleEmitter.Texture': 'image',
    'Beam.Texture': 'image',
    'Trail.Texture': 'image',
    'SurfaceAppearance.ColorMap': 'image',
    'SurfaceAppearance.NormalMap': 'image',
    'SurfaceAppearance.RoughnessMap': 'image',
    'SurfaceAppearance.MetalnessMap': 'image',
  };
  return known[`${className}.${property}`] || null;
}

/**
 * Every asset the model references, grouped by asset id.
 *
 * Only properties the reflection database marks as content-typed are scanned,
 * plus string properties whose value actually parses as a content URL — so a
 * `Name` of "rbxassetid://1" is not mistaken for an image.
 */
export function contentInventory(roots) {
  const items = [];
  const loose = [];
  for (const inst of walk(roots)) {
    const contentProps = new Set(contentPropertiesFor(inst.className).map((p) => p.name));
    for (const [property, value] of inst.props) {
      if (typeof value !== 'string' || value.length === 0) continue;
      const parsed = parseContentUrl(value);
      if (!parsed || parsed.scheme === 'plain') continue;

      const entry = {
        path: inst.getFullName(),
        className: inst.className,
        property,
        kind: assetKind(inst.className, property) || (contentProps.has(property) ? 'content' : 'string'),
        ...parsed,
      };

      if (contentProps.has(property)) items.push(entry);
      // A URL sitting in a property the reflection data did *not* mark as
      // content — a StringValue holding a config path, say — is not a declared
      // asset reference, so it is not counted as one. It is also not thrown
      // away, because it is exactly the sort of thing worth a second look.
      else loose.push(entry);
    }
  }
  items.sort((a, b) => a.path.localeCompare(b.path) || a.property.localeCompare(b.property));
  loose.sort((a, b) => a.path.localeCompare(b.path) || a.property.localeCompare(b.property));

  const byId = new Map();
  for (const item of items) {
    if (item.assetId === null) continue;
    const entry = byId.get(item.assetId) || { assetId: item.assetId, count: 0, used: [] };
    entry.count += 1;
    entry.used.push({ path: item.path, property: item.property, kind: item.kind });
    byId.set(item.assetId, entry);
  }

  return {
    total: items.length,
    uniqueAssets: byId.size,
    external: items.filter((i) => i.external).length,
    externalUrls: [...new Set(items.filter((i) => i.external).map((i) => i.raw))].sort(),
    byKind: items.reduce((acc, i) => {
      acc[i.kind] = (acc[i.kind] || 0) + 1;
      return acc;
    }, {}),
    items,
    looseUrls: loose,
    assets: [...byId.values()].sort((a, b) => b.count - a.count || a.assetId - b.assetId),
  };
}

/**
 * What depends on an instance, transitively.
 *
 * Direct referrers first, then whatever depends on those, so the order is also
 * the order of consequence: removing the target orphans the head of the list
 * first. Scripts that name the path in their source are reported separately
 * because a string reference is a real dependency the graph cannot see.
 *
 * @param {Instance[]} roots
 * @param {string} path full name of the instance to analyse
 * @param {{scripts?: boolean}} [options]
 */
export function impactAnalysis(roots, path, options = {}) {
  const index = indexByPath(roots);
  const target = index.get(path);
  if (!target) {
    return { path, found: false, suggestions: closestPaths(path, [...index.keys()]) };
  }

  const { incoming } = referenceGraph(roots);
  const direct = incoming.get(path) || [];

  // Breadth-first over reverse edges, so each layer is one step further from
  // the original damage.
  const layers = [];
  const seen = new Set([path]);
  let frontier = [path];

  while (frontier.length > 0 && layers.length < 12) {
    const next = [];
    const layer = [];
    for (const current of frontier) {
      for (const ref of incoming.get(current) || []) {
        if (seen.has(ref.from)) continue;
        seen.add(ref.from);
        layer.push({ path: ref.from, property: ref.property, via: current });
        next.push(ref.from);
      }
    }
    if (layer.length === 0) break;
    layers.push(layer);
    frontier = next;
  }

  const affected = layers.flat().map((l) => l.path);
  const result = {
    path,
    found: true,
    className: target.className,
    childCount: target.children.length,
    directReferences: direct.length,
    dependsOn: affected,
    distance: Object.fromEntries(
      layers.flatMap((layer, i) => layer.map((l) => [l.path, i + 1])),
    ),
  };

  if (options.scripts !== false) {
    result.scriptMentions = scriptMentions(roots, target);
  }
  return result;
}

/**
 * Scripts whose source mentions the instance.
 *
 * This is deliberately a *mention* report, not a dependency claim: a string in
 * a script is not a proven reference, so it is presented as something to check
 * by hand rather than folded into the dependency set.
 */
export function scriptMentions(roots, target) {
  const name = target.name;
  const full = target.getFullName();
  const lastSegment = full.split('.').pop();
  const mentions = [];

  for (const inst of walk(roots)) {
    if (!inst.isA('LuaSourceContainer')) continue;
    const source = inst.get('Source');
    if (typeof source !== 'string' || source.length === 0) continue;
    const lines = source.split('\n');
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes(full) || line.includes(`"${name}"`) || line.includes(`'${name}'`) || line.includes(`.${lastSegment}`)) {
        hits.push({ line: i + 1, text: line.trim().slice(0, 160) });
      }
      if (hits.length >= 12) break;
    }
    if (hits.length > 0) mentions.push({ script: inst.getFullName(), lines: hits });
  }
  return mentions;
}

function closestPaths(path, candidates) {
  const leaf = path.split('.').pop();
  const leaves = [...new Set(candidates.map((c) => c.split('.').pop()))];
  const suggestion = closestName(leaf, leaves);
  if (!suggestion) return [];
  return candidates.filter((c) => c.split('.').pop() === suggestion).slice(0, 5);
}
