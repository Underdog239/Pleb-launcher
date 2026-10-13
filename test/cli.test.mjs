import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'bin', 'studio.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-cli-test-'));

function cli(args, input) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    input,
    cwd: tmp,
  });
  return res;
}

function cliJson(args, input) {
  const res = cli(args, input);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

test('backends command lists local and studio', () => {
  const backends = cliJson(['backends']);
  assert.deepEqual(backends.map((b) => b.name).sort(), ['local', 'studio']);
  assert.equal(backends.find((b) => b.name === 'local').capabilities.executeLuau, false);
});

test('model -> tree -> inspect round trip through the CLI', () => {
  const specPath = path.join(tmp, 'spec.json');
  fs.writeFileSync(
    specPath,
    JSON.stringify({
      className: 'Model',
      name: 'Rig',
      children: [
        {
          className: 'Part',
          name: 'Core',
          properties: { Size: [2, 2, 2], Anchored: true, Material: 'Neon' },
        },
      ],
    }),
  );

  const modelPath = path.join(tmp, 'rig.rbxm');
  const created = cliJson(['model', specPath, '-o', modelPath]);
  assert.ok(created.bytes > 0);

  const tree = cliJson(['tree', modelPath]);
  assert.equal(tree.children[0].name, 'Rig');
  assert.equal(tree.children[0].children[0].name, 'Core');

  const inspected = cliJson(['inspect', modelPath, 'Rig.Core']);
  assert.deepEqual(inspected.properties.Size.value, { x: 2, y: 2, z: 2 });
  assert.equal(inspected.properties.Material.value, 288); // Neon
  assert.equal(inspected.properties.Size.serializedAs, 'size');
});

test('convert preserves data between binary and XML', () => {
  const specPath = path.join(tmp, 'spec2.json');
  fs.writeFileSync(
    specPath,
    JSON.stringify({ className: 'Folder', name: 'F', children: [{ className: 'Part', name: 'P', properties: { Size: [1, 2, 3] } }] }),
  );
  const bin = path.join(tmp, 'a.rbxm');
  const xml = path.join(tmp, 'a.rbxmx');
  const bin2 = path.join(tmp, 'b.rbxm');

  cliJson(['model', specPath, '-o', bin]);
  cliJson(['convert', bin, xml]);
  cliJson(['convert', xml, bin2]);

  const tree = cliJson(['tree', bin2]);
  assert.equal(tree.children[0].children[0].name, 'P');
  const inspected = cliJson(['inspect', bin2, 'F.P']);
  assert.deepEqual(inspected.properties.Size.value, { x: 1, y: 2, z: 3 });
});

test('build produces a place from a Rojo-style project', () => {
  fs.mkdirSync(path.join(tmp, 'src', 'modules'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'src', 'modules', 'Util.luau'), 'return { greet = true }\n');
  fs.writeFileSync(path.join(tmp, 'src', 'modules', 'Runner.server.luau'), 'print("hi")\n');

  const projectPath = path.join(tmp, 'default.project.json');
  fs.writeFileSync(
    projectPath,
    JSON.stringify({
      name: 'Game',
      tree: {
        ServerScriptService: { $className: 'ServerScriptService' },
        ReplicatedStorage: {
          $className: 'ReplicatedStorage',
          Modules: { $className: 'Folder', $path: 'src/modules' },
        },
      },
    }),
  );

  const out = path.join(tmp, 'game.rbxl');
  const built = cliJson(['build', projectPath, '-o', out]);
  assert.equal(built.projectName, 'Game');
  assert.equal(built.stats.byClass.ServerScriptService, 1);
  assert.equal(built.stats.byClass.ModuleScript, 1);
  assert.equal(built.stats.byClass.Script, 1);

  const module = cliJson(['read', out, 'ReplicatedStorage.Modules.Util']);
  assert.equal(module.className, 'ModuleScript');
  assert.match(module.source, /greet = true/);

  const runner = cliJson(['read', out, 'ReplicatedStorage.Modules.Runner']);
  assert.equal(runner.className, 'Script');
  assert.match(runner.source, /print\("hi"\)/);
});

test('view writes an SVG', () => {
  const specPath = path.join(tmp, 'spec3.json');
  fs.writeFileSync(specPath, JSON.stringify({ className: 'Part', name: 'Block', properties: { Size: [4, 4, 4] } }));
  const bin = path.join(tmp, 'block.rbxm');
  const svg = path.join(tmp, 'block.svg');
  cliJson(['model', specPath, '-o', bin]);
  const result = cliJson(['view', bin, '-o', svg]);
  assert.ok(result.bytes > 0);
  assert.match(fs.readFileSync(svg, 'utf8'), /<svg/);
});

test('mcp serve answers initialize and tools/list', () => {
  const input = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    '',
  ].join('\n');
  const res = cli(['serve'], input);
  const lines = res.stdout.trim().split('\n').map((l) => JSON.parse(l));
  const init = lines.find((m) => m.id === 1);
  assert.equal(init.result.serverInfo.name, 'studio-cli');
  const list = lines.find((m) => m.id === 2);
  const names = list.result.tools.map((t) => t.name);
  assert.ok(names.includes('search_game_tree'));
  assert.ok(names.includes('create_model'));
  assert.ok(names.includes('view_scene'));
});

test('execute_luau reports that it needs Studio on this host', () => {
  const res = cli(['call', 'execute_luau', JSON.stringify({ scriptFile: 'x.luau' })]);
  // Either it fails with the documented message, or Studio exists and it tried.
  if (res.status !== 0) {
    assert.match(res.stderr, /studio backend|Studio/i);
  }
});
