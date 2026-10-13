import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  walk,
  indexByPath,
  referenceGraph,
  contentInventory,
  parseContentUrl,
  impactAnalysis,
  scriptMentions,
} from '../src/rbx/graph.js';
import { Instance } from '../src/rbx/instance.js';
import { loadModel, saveModel } from '../src/rbx/io.js';
import { local } from '../src/backends/index.js';

/** A rig with a real reference chain: Model.PrimaryPart -> Primary. */
function rig({ withScripts = false } = {}) {
  const ws = new Instance('Workspace', 'Workspace');
  ws.isService = true;
  const model = new Instance('Model', 'Rig');
  ws.addChild(model);

  const primary = new Instance('Part', 'Primary');
  const secondary = new Instance('Part', 'Secondary');
  model.addChild(primary);
  model.addChild(secondary);
  model.set('PrimaryPart', primary);

  // A second-order dependency: something points at the Model, so Primary is
  // two steps from the top of the damage.
  const link = new Instance('ObjectValue', 'Chase');
  link.set('Value', model);
  ws.addChild(link);

  const decal = new Instance('Decal', 'Logo');
  decal.set('Texture', 'rbxassetid://1234567');
  primary.addChild(decal);

  const sound = new Instance('Sound', 'BGM');
  sound.set('SoundId', 'rbxassetid://7654321');
  sound.set('Looped', true);
  ws.addChild(sound);

  const banner = new Instance('ImageLabel', 'Banner');
  banner.set('Image', 'https://cdn.example.com/logo.png');
  // A plain string property that merely *looks* like an asset reference.
  const cfg = new Instance('StringValue', 'AssetPath');
  cfg.set('Value', 'rbxassetid://99999');
  ws.addChild(cfg);
  ws.addChild(banner);

  const mesh = new Instance('SpecialMesh', 'Mesh');
  mesh.set('MeshId', 'rbxassetid://555');
  primary.addChild(mesh);

  if (withScripts) {
    const script = new Instance('Script', 'Handler');
    script.set('Source', 'local rig = game.Workspace.Rig\nlocal p = rig.PrimaryPart\nprint(p.Name)\n');
    ws.addChild(script);
  }

  return { roots: [ws], ws, model, primary, secondary, link, sound, banner, decal, mesh };
}

// ---------------------------------------------------------------------------
// index / walk
// ---------------------------------------------------------------------------

test('walk visits every instance, roots included', () => {
  const { roots } = rig();
  assert.equal(walk(roots).length, 10);
});

test('indexByPath maps full names to instances', () => {
  const { roots, primary } = rig();
  const index = indexByPath(roots);
  assert.equal(index.get('Workspace.Rig.Primary'), primary);
  assert.equal(index.get('Workspace.Rig'), primary.parent);
  assert.equal(index.size, 10);
});

test('a repeated path is recorded as a duplicate, not silently collapsed', () => {
  const a = new Instance('Folder', 'Outer');
  const inner1 = new Instance('Folder', 'Inner');
  const inner2 = new Instance('Folder', 'Inner');
  a.addChild(inner1);
  a.addChild(inner2);
  const index = indexByPath([a]);
  assert.equal(index.get('Outer.Inner'), inner1, 'first occurrence wins deterministically');
  assert.ok(index.duplicates.has('Outer.Inner'), 'the ambiguity is recorded');
});

// ---------------------------------------------------------------------------
// reference graph
// ---------------------------------------------------------------------------

test('reference edges come from Instance-typed properties only', () => {
  const { roots } = rig();
  const graph = referenceGraph(roots);
  assert.deepEqual(
    graph.edges.map((e) => `${e.from}.${e.property} -> ${e.to}`).sort(),
    ['Workspace.Chase.Value -> Workspace.Rig', 'Workspace.Rig.PrimaryPart -> Workspace.Rig.Primary'],
  );
  // SoundId and Texture are content, not references.
  assert.ok(!graph.edges.some((e) => e.property === 'SoundId' || e.property === 'Texture'));
});

test('unset reference properties are not reported as broken', () => {
  // The engine defaults every reference to nothing, and both decoders store an
  // empty reference the same way, so this must stay silent.
  const ws = new Instance('Workspace', 'Workspace');
  ws.addChild(new Instance('Part', 'P'));
  const graph = referenceGraph([ws]);
  assert.deepEqual(graph.broken, []);
  assert.ok(graph.edges.length === 0);
});

test('a reference to the wrong class is reported with the requirement', () => {
  const model = new Instance('Model', 'M');
  const sound = new Instance('Sound', 'S');
  model.addChild(sound);
  model.set('PrimaryPart', sound);
  const graph = referenceGraph([model]);
  assert.equal(graph.broken.length, 1);
  assert.equal(graph.broken[0].refClass, 'BasePart');
  assert.match(graph.broken[0].reason, /requires BasePart/);
});

test('a reference to an instance outside the model is reported', () => {
  const outside = new Instance('Part', 'Elsewhere');
  const holder = new Instance('ObjectValue', 'Link');
  holder.set('Value', outside);
  const graph = referenceGraph([holder]);
  assert.equal(graph.broken.length, 1);
  assert.match(graph.broken[0].reason, /not part of this model/);
});

test('incoming references are indexed by target', () => {
  const { roots } = rig();
  const graph = referenceGraph(roots);
  const incoming = graph.incoming.get('Workspace.Rig.Primary');
  assert.deepEqual(incoming, [{ from: 'Workspace.Rig', property: 'PrimaryPart' }]);
});

// ---------------------------------------------------------------------------
// asset inventory
// ---------------------------------------------------------------------------

test('parseContentUrl extracts the id without losing the raw string', () => {
  assert.deepEqual(parseContentUrl('rbxassetid://1234567'), {
    raw: 'rbxassetid://1234567',
    scheme: 'rbxassetid',
    assetId: 1234567,
    external: false,
  });
  assert.equal(parseContentUrl('https://cdn.example.com/a.png').external, true);
  assert.equal(parseContentUrl('rbxasset://textures/foo.png').assetId, null);
  assert.equal(parseContentUrl(''), null);
  assert.equal(parseContentUrl(null), null);
});

test('the inventory finds every content property and nothing else', () => {
  const { roots } = rig();
  const inventory = contentInventory(roots);
  assert.deepEqual(
    inventory.items.map((i) => `${i.kind}:${i.path}.${i.property}`).sort(),
    [
      'image:Workspace.Banner.Image',
      'image:Workspace.Rig.Primary.Logo.Texture',
      'mesh:Workspace.Rig.Primary.Mesh.MeshId',
      'sound:Workspace.BGM.SoundId',
    ],
  );
  // `AssetPath.Value` holds something that looks like an asset id, but a
  // StringValue is not a content slot, so it is not counted as an asset —
  // and it is not dropped either.
  assert.ok(!inventory.items.some((i) => i.path === 'Workspace.AssetPath'));
  assert.deepEqual(
    inventory.looseUrls.map((i) => `${i.kind}:${i.path}.${i.property}:${i.assetId}`),
    ['string:Workspace.AssetPath.Value:99999'],
  );
});

test('the inventory groups by asset id and counts external urls', () => {
  const { roots, mesh, decal } = rig();
  decal.set('Texture', 'rbxassetid://555'); // now shared with the mesh
  const inventory = contentInventory(roots);
  assert.equal(inventory.total, 4);
  // Distinct Roblox asset ids: 555 (shared) and 7654321. The external URL has
  // no asset id, so it is counted by `external`, not here.
  assert.equal(inventory.uniqueAssets, 2);
  assert.equal(inventory.external, 1);
  assert.deepEqual(inventory.externalUrls, ['https://cdn.example.com/logo.png']);
  const shared = inventory.assets.find((a) => a.assetId === 555);
  assert.equal(shared.count, 2);
  assert.deepEqual(inventory.byKind, { image: 2, sound: 1, mesh: 1 });
  void mesh;
});

test('an empty model yields an empty inventory, not an error', () => {
  const inventory = contentInventory([]);
  assert.equal(inventory.total, 0);
  assert.equal(inventory.uniqueAssets, 0);
  assert.deepEqual(inventory.items, []);
});

// ---------------------------------------------------------------------------
// impact analysis
// ---------------------------------------------------------------------------

test('impact reports direct referrers first and follows the chain outward', () => {
  const { roots } = rig();
  const result = impactAnalysis(roots, 'Workspace.Rig.Primary', { scripts: false });
  assert.equal(result.found, true);
  assert.equal(result.className, 'Part');
  // Rig points at Primary directly; Chase points at Rig, so it is one step further.
  assert.deepEqual(result.dependsOn.sort(), ['Workspace.Chase', 'Workspace.Rig']);
  assert.equal(result.distance['Workspace.Rig'], 1);
  assert.equal(result.distance['Workspace.Chase'], 2);
});

test('impact is honest about an instance nothing references', () => {
  const { roots } = rig();
  const result = impactAnalysis(roots, 'Workspace.Rig.Secondary', { scripts: false });
  assert.equal(result.found, true);
  assert.deepEqual(result.dependsOn, []);
});

test('impact on a missing path suggests the closest real one', () => {
  const { roots } = rig();
  const result = impactAnalysis(roots, 'Workspace.Rig.Primry');
  assert.equal(result.found, false);
  assert.deepEqual(result.suggestions, ['Workspace.Rig.Primary']);
});

test('impact on a completely unrelated path suggests nothing', () => {
  const { roots } = rig();
  const result = impactAnalysis(roots, 'Nowhere.At.All');
  assert.equal(result.found, false);
  assert.deepEqual(result.suggestions, []);
});

test('script mentions are reported as mentions, per line', () => {
  const { roots, primary } = rig({ withScripts: true });
  const mentions = scriptMentions(roots, primary);
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0].script, 'Workspace.Handler');
  assert.equal(mentions[0].lines[0].line, 2);
  assert.match(mentions[0].lines[0].text, /PrimaryPart/);
});

test('impact includes the child count, so deleting is an informed decision', () => {
  const { roots } = rig();
  const result = impactAnalysis(roots, 'Workspace.Rig', { scripts: false });
  assert.equal(result.childCount, 2);
});

test('a reference cycle does not hang the traversal', () => {
  const a = new Instance('ObjectValue', 'A');
  const b = new Instance('ObjectValue', 'B');
  const holder = new Instance('Folder', 'Holder');
  holder.addChild(a);
  holder.addChild(b);
  a.set('Value', b);
  b.set('Value', a);
  const result = impactAnalysis([holder], 'Holder.A', { scripts: false });
  assert.deepEqual(result.dependsOn, ['Holder.B']);
});

// ---------------------------------------------------------------------------
// against a real file, through both codecs
// ---------------------------------------------------------------------------

test('the reference graph survives a save and load in both formats', () => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-graph-'));
  for (const ext of ['rbxmx', 'rbxl']) {
    const file = join(dir, `rig.${ext}`);
    const { roots } = rig();
    saveModel(file, roots);
    const reloaded = loadModel(file);
    const before = referenceGraph(roots);
    const after = referenceGraph(reloaded);
    assert.deepEqual(
      after.edges.map((e) => `${e.from}.${e.property} -> ${e.to}`).sort(),
      before.edges.map((e) => `${e.from}.${e.property} -> ${e.to}`).sort(),
      `edges must survive ${ext}`,
    );
    assert.deepEqual(after.broken, [], `no false breakage after ${ext}`);
    assert.equal(contentInventory(reloaded).total, contentInventory(roots).total, `assets must survive ${ext}`);
    assert.deepEqual(
      impactAnalysis(reloaded, 'Workspace.Rig.Primary', { scripts: false }).dependsOn.sort(),
      ['Workspace.Chase', 'Workspace.Rig'],
      `impact must survive ${ext}`,
    );
  }
});

test('the graph works on a project built from files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-graph-proj-'));
  writeFileSync(
    join(dir, 'default.project.json'),
    JSON.stringify({
      name: 'GraphProj',
      tree: {
        Workspace: {
          $className: 'Workspace',
          Rig: {
            $className: 'Model',
            Primary: { $className: 'Part' },
            Logo: { $className: 'Decal', $properties: { Texture: 'rbxassetid://42' } },
          },
        },
      },
    }),
  );
  const { roots } = local.buildFromProject(join(dir, 'default.project.json'));
  const inventory = contentInventory(roots);
  assert.equal(inventory.total, 1);
  assert.equal(inventory.items[0].assetId, 42);
  assert.equal(inventory.items[0].path, 'Workspace.Rig.Logo');
  assert.equal(referenceGraph(roots).broken.length, 0);
});
