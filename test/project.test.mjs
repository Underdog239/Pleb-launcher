import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFromProject, resolvePath } from '../src/backends/local/index.js';
import { serializeXml } from '../src/rbx/xml.js';

/** Lay out a throwaway project directory and return its path. */
function project(files, projectJson) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-project-'));
  for (const [name, contents] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }
  const projectPath = path.join(dir, 'default.project.json');
  fs.writeFileSync(projectPath, JSON.stringify(projectJson ?? { name: 'T', tree: {} }, null, 2));
  return { dir, projectPath };
}

function build(files, projectJson) {
  const { projectPath } = project(files, projectJson);
  return buildFromProject(projectPath);
}

const find = (roots, p) => resolvePath(roots, p);

/** Write extra files into an existing project dir, then rebuild it. */
function rebuild(dir, extraFiles) {
  for (const [name, contents] of Object.entries(extraFiles)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }
  return buildFromProject(path.join(dir, 'default.project.json'));
}
const codes = (warnings) => warnings.map((w) => w.code);

// --- class inference --------------------------------------------------------

test('init.lua makes a directory a ModuleScript, not a Folder with Source', () => {
  const { roots } = build(
    { 'src/init.lua': 'return 1\n' },
    { name: 'T', tree: { Shared: { $path: 'src' } } },
  );
  const shared = find(roots, 'Shared');
  assert.equal(shared.className, 'ModuleScript');
  assert.equal(shared.get('Source'), 'return 1\n');
});

test('init.server.luau and init.client.luau pick their script classes', () => {
  const { roots } = build(
    { 'server/init.server.luau': 'print(1)\n', 'client/init.client.luau': 'print(2)\n' },
    {
      name: 'T',
      tree: {
        ServerScriptService: { $path: 'server' },
        StarterPlayerScripts: { $path: 'client' },
      },
    },
  );
  assert.equal(find(roots, 'ServerScriptService').className, 'Script');
  assert.equal(find(roots, 'StarterPlayerScripts').className, 'LocalScript');
});

test('an explicit $className beats the init-script convention', () => {
  const { roots, warnings } = build(
    { 'src/init.lua': 'return 1\n' },
    { name: 'T', tree: { Thing: { $className: 'Folder', $path: 'src' } } },
  );
  assert.equal(find(roots, 'Thing').className, 'Folder');
  assert.equal(find(roots, 'Thing').get('Source'), undefined);
  // The dropped init script is reported, not ignored in silence.
  assert.ok(codes(warnings).includes('init-script-ignored'));
});

test('a className in init.meta.json is honoured', () => {
  const { roots } = build(
    { 'src/init.meta.json': JSON.stringify({ className: 'Model' }) },
    { name: 'T', tree: { Stuff: { $path: 'src' } } },
  );
  assert.equal(find(roots, 'Stuff').className, 'Model');
});

// --- scripts and naming -----------------------------------------------------

test('script suffixes map to the right classes and names', () => {
  const { roots } = build(
    {
      'src/Thing.luau': 'return 1',
      'src/Runner.server.luau': 'print(1)',
      'src/UI.client.luau': 'print(2)',
    },
    { name: 'T', tree: { Root: { $path: 'src' } } },
  );
  assert.equal(find(roots, 'Root.Thing').className, 'ModuleScript');
  assert.equal(find(roots, 'Root.Runner').className, 'Script');
  assert.equal(find(roots, 'Root.UI').className, 'LocalScript');
});

test('a .meta.json next to a script applies its properties', () => {
  const { roots, warnings } = build(
    { 'src/Thing.luau': 'return 1', 'src/Thing.meta.json': JSON.stringify({ Properties: { Enabled: true } }) },
    { name: 'T', tree: { Root: { $path: 'src' } } },
  );
  assert.equal(find(roots, 'Root.Thing').get('Enabled'), true);
  assert.equal(warnings.length, 0, 'a matched meta file must not warn');
});

test('a .meta.json with no matching instance warns', () => {
  const { warnings } = build(
    { 'src/Ghost.meta.json': JSON.stringify({ Properties: {} }) },
    { name: 'T', tree: { Root: { $path: 'src' } } },
  );
  assert.ok(codes(warnings).includes('orphan-meta'));
});

// --- data files -------------------------------------------------------------

test('.txt and .csv become StringValue, unknown extensions warn', () => {
  const { roots, warnings } = build(
    { 'src/Notes.txt': 'hello', 'src/Table.csv': 'a,b', 'src/Blob.xyz': '?' },
    { name: 'T', tree: { Root: { $path: 'src' } } },
  );
  assert.equal(find(roots, 'Root.Notes').className, 'StringValue');
  assert.equal(find(roots, 'Root.Notes').get('Value'), 'hello');
  assert.equal(find(roots, 'Root.Table').className, 'StringValue');
  assert.equal(find(roots, 'Root.Blob'), null, 'an unknown extension creates nothing');
  // The bug this replaces: the file simply vanished from the build.
  assert.ok(codes(warnings).includes('skipped-file'));
});

// --- properties -------------------------------------------------------------

test('Rojo implicit property syntax is coerced to real types', () => {
  const { roots } = build(
    {},
    {
      name: 'T',
      tree: {
        Part: {
          $className: 'Part',
          $properties: { Size: [4, 1, 4], Anchored: true, Material: 'Concrete', Color: [0.5, 0, 0.5] },
        },
      },
    },
  );
  const p = find(roots, 'Part');
  assert.deepEqual(p.get('Size'), { x: 4, y: 1, z: 4 });
  assert.equal(p.get('Anchored'), true);
  assert.equal(typeof p.get('Material'), 'number');
  assert.deepEqual(p.get('Color'), { r: 0.5, g: 0, b: 0.5 });
});

test('rbx-dom explicit {Type, Value} property syntax is accepted', () => {
  const { roots } = build(
    {},
    {
      name: 'T',
      tree: {
        Part: {
          $className: 'Part',
          $properties: { Size: { Type: 'Vector3', Value: [2, 3, 4] } },
        },
      },
    },
  );
  assert.deepEqual(find(roots, 'Part').get('Size'), { x: 2, y: 3, z: 4 });
});

test('nested directories and nested $path both work', () => {
  const { roots } = build(
    { 'src/deep/nested/Leaf.luau': 'return 1' },
    { name: 'T', tree: { A: { $path: 'src' } } },
  );
  // Every directory level becomes a Folder so paths stay addressable.
  assert.equal(find(roots, 'A.deep').className, 'Folder');
  assert.equal(find(roots, 'A.deep.nested.Leaf').className, 'ModuleScript');
  // A directory with no init script and no className is a Folder.
  assert.equal(find(roots, 'A').className, 'Folder');
});

// --- model files ------------------------------------------------------------

test('$path to a model file splices its single root in as the node', () => {
  // Write a real .rbxmx with the real codec, then reference it from a project.
  const { dir } = project(
    {},
    {
      name: 'V',
      tree: { Vendored: { $className: 'Model', Inner: { $className: 'Part', $properties: { Size: [1, 1, 1] } } } },
    },
  );
  const { roots: vendored } = buildFromProject(path.join(dir, 'default.project.json'));
  fs.writeFileSync(path.join(dir, 'Vendor.rbxmx'), serializeXml(vendored));
  fs.writeFileSync(
    path.join(dir, 'consumer.project.json'),
    JSON.stringify({ name: 'T', tree: { Vendor: { $path: 'Vendor.rbxmx' } } }),
  );

  const { roots } = buildFromProject(path.join(dir, 'consumer.project.json'));
  // A single-root model file *is* the node, renamed to the project key...
  assert.equal(find(roots, 'Vendor').className, 'Model');
  // ...with the file's children underneath.
  assert.deepEqual(find(roots, 'Vendor.Inner').get('Size'), { x: 1, y: 1, z: 1 });
});

test('$path to a model file with an explicit $className nests its roots', () => {
  const { dir } = project(
    {},
    { name: 'V', tree: { First: { $className: 'Part' }, Second: { $className: 'Part' } } },
  );
  const { roots: vendored } = buildFromProject(path.join(dir, 'default.project.json'));
  fs.writeFileSync(path.join(dir, 'Pair.rbxmx'), serializeXml(vendored));
  fs.writeFileSync(
    path.join(dir, 'consumer.project.json'),
    JSON.stringify({ name: 'T', tree: { Holder: { $className: 'Folder', $path: 'Pair.rbxmx' } } }),
  );

  const { roots } = buildFromProject(path.join(dir, 'consumer.project.json'));
  assert.equal(find(roots, 'Holder').className, 'Folder');
  assert.equal(find(roots, 'Holder.First').className, 'Part');
  assert.equal(find(roots, 'Holder.Second').className, 'Part');
});

test('a .model.json beside a vendored model applies properties', () => {
  const { dir } = project({}, { name: 'V', tree: { Vendored: { $className: 'Part' } } });
  const { roots: vendored } = buildFromProject(path.join(dir, 'default.project.json'));
  fs.writeFileSync(path.join(dir, 'Vendor.rbxmx'), serializeXml(vendored));
  fs.writeFileSync(path.join(dir, 'Vendor.model.json'), JSON.stringify({ Properties: { Anchored: true } }));
  fs.writeFileSync(
    path.join(dir, 'consumer.project.json'),
    JSON.stringify({ name: 'T', tree: { Vendor: { $path: 'Vendor.rbxmx' } } }),
  );

  const { roots } = buildFromProject(path.join(dir, 'consumer.project.json'));
  assert.equal(find(roots, 'Vendor').get('Anchored'), true);
});

test('$ignoreUnknownInstances is accepted without error', () => {
  const { roots } = build(
    { 'src/A.luau': 'return 1' },
    { name: 'T', tree: { Root: { $path: 'src', $ignoreUnknownInstances: true } } },
  );
  assert.equal(find(roots, 'Root.A').className, 'ModuleScript');
});

test('a $path that does not exist fails loudly', () => {
  const { projectPath } = project({}, { name: 'T', tree: { Root: { $path: 'nope' } } });
  assert.throws(() => buildFromProject(projectPath), /\$path does not exist/);
});

test('a project without a tree block is still built from its top level', () => {
  const { roots } = build({}, { ReplicatedStorage: { $className: 'ReplicatedStorage' } });
  assert.equal(find(roots, 'ReplicatedStorage').className, 'ReplicatedStorage');
});
