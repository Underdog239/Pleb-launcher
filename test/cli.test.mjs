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

test('model refuses to write an unknown property and suggests a fix', () => {
  const spec = path.join(tmp, 'bad-prop.json');
  fs.writeFileSync(spec, JSON.stringify({ className: 'Part', name: 'P', properties: { Sizee: [1, 1, 1] } }));
  const outPath = path.join(tmp, 'bad-prop.rbxm');

  const res = cli(['model', spec, '-o', outPath]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /not a valid property/);
  assert.match(res.stderr, /did you mean: Size/);
  assert.equal(fs.existsSync(outPath), false, 'must not write an invalid model');

  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.diagnostics[0].suggestion, 'Size');
});

test('model refuses a wrong value type', () => {
  const spec = path.join(tmp, 'bad-type.json');
  fs.writeFileSync(spec, JSON.stringify({ className: 'Part', name: 'P', properties: { Size: 'oops' } }));
  const res = cli(['model', spec, '-o', path.join(tmp, 'bad-type.rbxm')]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /expected \{x, y, z\}/);
});

test('--force writes despite validation errors', () => {
  const spec = path.join(tmp, 'bad-force.json');
  fs.writeFileSync(spec, JSON.stringify({ className: 'Part', name: 'P', properties: { Sizee: [1, 1, 1] } }));
  const outPath = path.join(tmp, 'forced.rbxm');
  const res = cli(['model', spec, '-o', outPath, '--force']);
  assert.equal(res.status, 0);
  assert.ok(fs.existsSync(outPath));
});

test('validate reports problems and exits non-zero', () => {
  const spec = path.join(tmp, 'valid.json');
  fs.writeFileSync(spec, JSON.stringify({ className: 'Part', name: 'P', properties: { Size: [1, 1, 1] } }));
  const good = path.join(tmp, 'valid.rbxm');
  cliJson(['model', spec, '-o', good]);

  const ok = cli(['validate', good]);
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /ok: 1 instances, no problems/);

  const okJson = cliJson(['validate', good, '--json']);
  assert.equal(okJson.ok, true);

  // Now validate a file that was forced out with a bad property.
  const badSpec = path.join(tmp, 'badv.json');
  fs.writeFileSync(badSpec, JSON.stringify({ className: 'Part', name: 'P', properties: { Material: 999999 } }));
  const badFile = path.join(tmp, 'badv.rbxm');
  cli(['model', badSpec, '-o', badFile, '--force']);

  const bad = cli(['validate', badFile]);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /FAILED/);
});

test('mcp create_model reports validation failures as an error result', () => {
  const input = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'create_model',
        arguments: {
          spec: { className: 'Part', name: 'P', properties: { Sizee: [1, 1, 1] } },
          output: path.join(tmp, 'mcp-bad.rbxm'),
        },
      },
    }),
    '',
  ].join('\n');

  const res = cli(['serve'], input);
  const lines = res.stdout.trim().split('\n').map((l) => JSON.parse(l));
  const call = lines.find((m) => m.id === 2);
  assert.equal(call.result.isError, true);
  assert.match(call.result.content[0].text, /did you mean: Size/);
  assert.equal(fs.existsSync(path.join(tmp, 'mcp-bad.rbxm')), false);
});

test('validate_model tool is exposed', () => {
  const input = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    '',
  ].join('\n');
  const res = cli(['serve'], input);
  const list = JSON.parse(res.stdout.trim().split('\n')[0]);
  const names = list.result.tools.map((t) => t.name);
  assert.ok(names.includes('validate_model'));
});

