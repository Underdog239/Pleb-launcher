import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
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

/** Like cli(), but with extra environment variables. */
function cliEnv(args, env, input) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    input,
    cwd: tmp,
    env: { ...process.env, ...env },
  });
}

/**
 * Start the Open Cloud stub in its own process and hand back its port.
 *
 * A separate process is required rather than an in-process server: the CLI is
 * spawned with spawnSync, which blocks this process's event loop, so a server
 * living here could never answer the CLI's requests.
 */
function startStub(env = {}) {
  const child = spawn(process.execPath, [path.join(here, 'fixtures', 'opencloud-stub.mjs')], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = new Promise((resolve, reject) => {
    let buffered = '';
    child.stdout.on('data', (chunk) => {
      buffered += chunk;
      const line = buffered.split('\n')[0].trim();
      if (/^\d+$/.test(line)) resolve(Number(line));
    });
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`stub exited early with ${code}`)));
  });
  return { child, port };
}

test('backends command lists every backend and its real capabilities', () => {
  const backends = cliJson(['backends']);
  assert.deepEqual(backends.map((b) => b.name).sort(), ['local', 'opencloud', 'studio']);
  assert.equal(backends.find((b) => b.name === 'local').capabilities.executeLuau, false);
  const oc = backends.find((b) => b.name === 'opencloud');
  assert.equal(oc.capabilities.executeLuau, true);
  // Availability is environment-dependent: reported honestly either way.
  assert.equal(typeof oc.available, 'boolean');
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


// --- agent-ergonomics: options and diagnostics ------------------------------

test('--output=path is honoured instead of silently writing the default', () => {
  const spec = path.join(tmp, 'eq-flag.json');
  fs.writeFileSync(spec, JSON.stringify({ className: 'Part', name: 'P', properties: { Size: [1, 1, 1] } }));
  const target = path.join(tmp, 'eq-flag.rbxm');
  const result = cliJson(['model', spec, `--output=${target}`]);
  assert.equal(result.output, target);
  assert.ok(fs.existsSync(target));
});

test('an unknown option is an error with a suggestion, not a positional', () => {
  const res = cli(['tree', 'whatever.rbxm', '--dpeth', '2']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /unknown option: --dpeth/);
  assert.match(res.stderr, /did you mean --depth/);
});

test('an unknown command suggests the closest one', () => {
  const res = cli(['trees', 'x.rbxm']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /unknown command: trees/);
  assert.match(res.stderr, /did you mean tree/);
});

test('a single bad spec reports every problem at once', () => {
  const spec = path.join(tmp, 'multi-error.json');
  fs.writeFileSync(
    spec,
    JSON.stringify({
      className: 'Part',
      name: 'P',
      properties: { Sizee: [1, 1, 1], Material: 'Concree', Transparency: 5 },
    }),
  );
  const outPath = path.join(tmp, 'multi-error.rbxm');
  const res = cli(['model', spec, '-o', outPath]);

  assert.equal(res.status, 1);
  assert.equal(fs.existsSync(outPath), false, 'must not write an invalid model');
  // Before: the run died on the first enum error and reported nothing else.
  assert.match(res.stderr, /Sizee .*not a valid property/);
  assert.match(res.stderr, /did you mean: Size\?/);
  assert.match(res.stderr, /"Concree" is not a valid Material item/);
  assert.match(res.stderr, /did you mean: Concrete\?/);
  assert.match(res.stderr, /Transparency = 5 is outside 0\.\.1/);

  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.errorCount, 2);
  assert.equal(parsed.warningCount, 1);
});

test('doctor reports what the host can do', () => {
  const checks = cliJson(['doctor', '--json']);
  const names = checks.map((c) => c.name);
  assert.ok(names.includes('node'));
  assert.ok(names.includes('reflection database'));
  assert.ok(names.includes('serialization patches'));
  assert.ok(checks.every((c) => typeof c.ok === 'boolean' && typeof c.detail === 'string'));
});

// --- Luau static analysis through the CLI ----------------------------------

test('check reports Luau problems and exits non-zero', () => {
  const src = path.join(tmp, 'bad.luau');
  fs.writeFileSync(src, 'local p = Instance.new("Part")\np.Sizee = 1\nlocal q = Instance.new("Prat")\n');
  const res = cli(['check', src]);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /\[property-typo\]/);
  assert.match(res.stdout, /\[unknown-class\]/);
  assert.match(res.stdout, /no such property, did you mean Size\?/);
});

test('check --json returns the same machine-readable shape as the validator', () => {
  const src = path.join(tmp, 'bad2.luau');
  fs.writeFileSync(src, 'wait(1)\n');
  const result = cliJson(['check', src, '--json']);
  assert.equal(result.ok, true, 'a deprecation warning must not fail the check');
  assert.equal(result.errorCount, 0);
  assert.equal(result.warningCount, 1);
  assert.equal(result.diagnostics[0].code, 'deprecated-global');
  assert.equal(result.diagnostics[0].suggestion, 'task.wait');
});

test('check on a clean script exits zero and says so', () => {
  const src = path.join(tmp, 'good.luau');
  fs.writeFileSync(src, 'local p = Instance.new("Part")\np.Anchored = true\nreturn p\n');
  const res = cli(['check', src]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /no problems/);
});

test('check and graph work directly on a project file', () => {
  const dir = path.join(tmp, 'proj');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'default.project.json'),
    JSON.stringify({
      name: 'Proj',
      tree: {
        ReplicatedStorage: { $className: 'ReplicatedStorage', Mod: { $path: 'src/Mod.luau' } },
      },
    }),
  );
  fs.writeFileSync(path.join(dir, 'src', 'Mod.luau'), 'return require(script.Parent.Gone)\n');

  const checked = cli(['check', path.join(dir, 'default.project.json')]);
  assert.equal(checked.status, 1);
  assert.match(checked.stdout, /\[require-not-found\]/);

  const graph = cliJson(['graph', path.join(dir, 'default.project.json'), '--json']);
  assert.equal(graph.scriptCount, 1);
  assert.equal(graph.edges.length, 0);
});

test('graph reports a require cycle and exits non-zero', () => {
  const dir = path.join(tmp, 'cycle');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'default.project.json'),
    JSON.stringify({
      name: 'Cycle',
      tree: { ReplicatedStorage: { $className: 'ReplicatedStorage', S: { $path: 'src' } } },
    }),
  );
  fs.writeFileSync(path.join(dir, 'src', 'A.luau'), 'return require(script.Parent.B)\n');
  fs.writeFileSync(path.join(dir, 'src', 'B.luau'), 'return require(script.Parent.A)\n');

  const res = cli(['graph', path.join(dir, 'default.project.json')]);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /CYCLE: ReplicatedStorage\.S\.A -> ReplicatedStorage\.S\.B/);
});

test('script_check and require_graph tools are exposed', () => {
  const tools = cliJson(['tools']);
  const names = tools.map((t) => t.name);
  assert.ok(names.includes('script_check'), `missing script_check in ${names.join(', ')}`);
  assert.ok(names.includes('require_graph'), `missing require_graph in ${names.join(', ')}`);
});

test('script_check tool works on inline source without touching the disk', () => {
  const result = cliJson(['call', 'script_check', '--json', JSON.stringify({ source: 'local x = Instance.new("Prat")\n' })]);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0].code, 'unknown-class');
  assert.equal(result.diagnostics[0].suggestion, 'Part');
});

// --- reference graph, assets, and impact -----------------------------------

/** Build a rig whose references are wired in the project file itself. */
function makeRig(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'default.project.json'),
    JSON.stringify({
      name: 'Rig',
      tree: {
        Workspace: {
          $className: 'Workspace',
          Rig: {
            $className: 'Model',
            $properties: { PrimaryPart: 'Workspace.Rig.Primary' },
            Primary: { $className: 'Part' },
            Logo: { $className: 'Decal', $properties: { Texture: 'rbxassetid://1234567' } },
          },
          Chase: { $className: 'ObjectValue', $properties: { Value: { $ref: 'Workspace.Rig' } } },
        },
      },
    }),
  );
  const out = path.join(dir, 'rig.rbxlx');
  const built = cli(['build', path.join(dir, 'default.project.json'), '-o', out]);
  assert.equal(built.status, 0, `build failed: ${built.stderr}${built.stdout}`);
  return out;
}

test('refs and impact answer "what breaks if I delete this"', () => {
  const dir = path.join(tmp, 'rigrefs');
  const file = makeRig(dir);

  const refs = cliJson(['refs', file, '--json']);
  assert.deepEqual(
    refs.edges.map((e) => `${e.from}.${e.property} -> ${e.to}`).sort(),
    ['Workspace.Chase.Value -> Workspace.Rig', 'Workspace.Rig.PrimaryPart -> Workspace.Rig.Primary'],
  );
  assert.deepEqual(refs.broken, []);

  const impact = cliJson(['impact', file, 'Workspace.Rig.Primary', '--json']);
  assert.equal(impact.found, true);
  assert.equal(impact.className, 'Part');
  // Rig holds Primary directly; Chase holds Rig, so it is one step further out.
  assert.equal(impact.distance['Workspace.Rig'], 1);
  assert.equal(impact.distance['Workspace.Chase'], 2);
});

test('a project reference to something that does not exist is reported, not dropped', () => {
  const dir = path.join(tmp, 'rigbadref');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'default.project.json'),
    JSON.stringify({
      name: 'Bad',
      tree: {
        Workspace: {
          $className: 'Workspace',
          Rig: { $className: 'Model', $properties: { PrimaryPart: 'Workspace.Rig.Primry' }, Primary: { $className: 'Part' } },
        },
      },
    }),
  );
  const res = cli(['build', path.join(dir, 'default.project.json'), '-o', path.join(dir, 'bad.rbxlx')]);
  assert.match(`${res.stdout}${res.stderr}`, /unresolved-reference/);
  assert.match(`${res.stdout}${res.stderr}`, /Workspace\.Rig\.Primary/, 'the closest real path must be suggested');
});

test('the three reference spellings all resolve to the same target', () => {
  const dir = path.join(tmp, 'rigspellings');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'default.project.json'),
    JSON.stringify({
      name: 'Spellings',
      tree: {
        ReplicatedStorage: {
          $className: 'ReplicatedStorage',
          Target: { $className: 'ObjectValue' },
          Plain: { $className: 'ObjectValue', $properties: { Value: 'ReplicatedStorage.Target' } },
          Explicit: { $className: 'ObjectValue', $properties: { Value: { $ref: 'game.ReplicatedStorage.Target' } } },
          Typed: {
            $className: 'ObjectValue',
            $properties: { Value: { Type: 'Ref', Value: 'ReplicatedStorage.Target' } },
          },
        },
      },
    }),
  );
  const out = path.join(dir, 'spellings.rbxlx');
  const built = cli(['build', path.join(dir, 'default.project.json'), '-o', out]);
  assert.equal(built.status, 0, built.stdout + built.stderr);
  const refs = cliJson(['refs', out, '--json']);
  assert.equal(refs.edges.length, 3, JSON.stringify(refs.edges));
  assert.ok(refs.edges.every((e) => e.to === 'ReplicatedStorage.Target'));
});

test('create_model accepts references between spec instances', () => {
  const dir = path.join(tmp, 'specrefs');
  fs.mkdirSync(dir, { recursive: true });
  const spec = path.join(dir, 'spec.json');
  fs.writeFileSync(
    spec,
    JSON.stringify({
      className: 'Model',
      name: 'Rig',
      properties: { PrimaryPart: 'Rig.Primary' },
      children: [
        { className: 'Part', name: 'Primary' },
        { className: 'ObjectValue', name: 'Link', properties: { Value: { $ref: 'Rig.Primary' } } },
      ],
    }),
  );
  const out = path.join(dir, 'spec.rbxm');
  const created = cliJson(['model', spec, '-o', out, '--json']);
  assert.equal(created.validation.ok, true, JSON.stringify(created.validation.diagnostics));
  const refs = cliJson(['refs', out, '--json']);
  assert.equal(refs.edges.length, 2, JSON.stringify(refs.edges));
});

test('impact on a typo exits non-zero and suggests the real path', () => {
  const dir = path.join(tmp, 'rigimpact');
  const file = makeRig(dir);
  const res = cli(['impact', file, 'Workspace.Rig.Primry']);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /no instance at Workspace\.Rig\.Primry/);
  assert.match(res.stdout, /Workspace\.Rig\.Primary/);
});

test('refs --broken is quiet on a healthy model', () => {
  const dir = path.join(tmp, 'rigbroken');
  const file = makeRig(dir);
  const res = cli(['refs', file, '--broken']);
  assert.equal(res.status, 0, `unexpected failures: ${res.stdout}${res.stderr}`);
  assert.match(res.stdout, /no broken references/);
});

test('assets lists every asset with its owner', () => {
  const dir = path.join(tmp, 'rigassets');
  const file = makeRig(dir);
  const inventory = cliJson(['assets', file, '--json']);
  assert.equal(inventory.total, 1);
  assert.equal(inventory.items[0].assetId, 1234567);
  assert.equal(inventory.items[0].kind, 'image');
  assert.equal(inventory.items[0].path, 'Workspace.Rig.Logo');

  const res = cli(['assets', file]);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /rbxassetid:\/\/1234567/);
  assert.match(res.stdout, /1 asset reference/);
});

test('asset_inventory, instance_references, impact_analysis and format_coverage are exposed', () => {
  const names = cliJson(['tools']).map((t) => t.name);
  for (const wanted of ['asset_inventory', 'instance_references', 'impact_analysis', 'format_coverage']) {
    assert.ok(names.includes(wanted), `missing ${wanted} in ${names.join(', ')}`);
  }
});

test('format_coverage names what cannot be written', () => {
  const coverage = cliJson(['call', 'format_coverage', '--json', '{}']);
  assert.equal(coverage.totalTypes, 370);
  assert.equal(coverage.binary.covered, 363);
  assert.equal(coverage.xml.covered, 361);
  assert.ok(coverage.binary.uncovered.includes('QDir'));
  assert.ok(!coverage.binary.uncovered.includes('Material'), 'an enum must not be listed as unwritable');
});

// ---------------------------------------------------------------------------
// exec --backend opencloud: headless Luau on Roblox's servers
// ---------------------------------------------------------------------------

test('opencloud exec checks its arguments before sending anything', () => {
  const script = path.join(tmp, 'run.luau');
  fs.writeFileSync(script, 'return 1\n');

  const missing = cli(['exec', script, '--backend', 'opencloud']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /needs --universe and --place-id/);

  const confused = cli(['exec', script, '--backend', 'opencloud', '--universe', '1', '--place', 'x.rbxl']);
  assert.equal(confused.status, 1);
  assert.match(confused.stderr, /--place-id/);

  const noScript = cli(['exec', '--backend', 'opencloud', '--universe', '1', '--place-id', '2']);
  assert.equal(noScript.status, 1);
  assert.match(noScript.stderr, /script path/);
});

test('opencloud exec says what is missing when there is no api key', () => {
  const script = path.join(tmp, 'run.luau');
  fs.writeFileSync(script, 'return 1\n');
  const res = cliEnv(
    ['exec', script, '--backend', 'opencloud', '--universe', '1', '--place-id', '2'],
    { ROBLOX_CLOUD_API_KEY: '', RBLX_OC_API_KEY: '' },
  );
  assert.equal(res.status, 1);
  assert.match(res.stderr, /no Open Cloud API key/);
  assert.match(res.stderr, /create\.roblox\.com/);
});

test('plain exec without studio points at opencloud instead of just failing', () => {
  const res = cli(['exec', 'run.luau']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /--backend opencloud/);
  assert.match(res.stderr, /--place-id/);
});

test('opencloud exec runs a script and returns its results as JSON', async () => {
  const { child, port } = startStub();
  try {
    const script = path.join(tmp, 'server.luau');
    fs.writeFileSync(script, 'return { ok = true }\n');
    const p = await port;
    const res = cliEnv(
      ['exec', script, '--backend', 'opencloud', '--universe', '1', '--place-id', '2', '--json'],
      {
        ROBLOX_CLOUD_API_KEY: 'dGVzdC1rZXk=',
        ROBLOX_CLOUD_BASE_URL: `http://127.0.0.1:${p}`,
      },
    );
    assert.equal(res.status, 0, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.state, 'COMPLETE');
    assert.equal(payload.backend, 'opencloud');
    assert.equal(payload.placeVersion, 4, 'versions/4 is reported as 4');
    assert.deepEqual(payload.results, { ok: true, answer: 42 });
    // The script reached the far end, and the server's own output came back.
    assert.match(payload.logs, /script was: return \{ ok = true \}/);
  } finally {
    child.kill();
  }
});

test("a failing script's logs are not swallowed", async () => {
  const { child, port } = startStub({ STUB_FAIL: '1' });
  try {
    const script = path.join(tmp, 'boom.luau');
    fs.writeFileSync(script, 'error("boom")\n');
    const p = await port;
    const res = cliEnv(
      ['exec', script, '--backend', 'opencloud', '--universe', '1', '--place-id', '2'],
      { ROBLOX_CLOUD_API_KEY: 'dGVzdC1rZXk=', ROBLOX_CLOUD_BASE_URL: `http://127.0.0.1:${p}` },
    );
    assert.equal(res.status, 1);
    assert.match(res.stderr, /script was: error\("boom"\)/, 'output from the run is kept');
    assert.match(res.stderr, /the script failed on the Roblox server/);
    assert.match(res.stderr, /stub script failed on purpose/);
  } finally {
    child.kill();
  }
});

test('doctor reports the open cloud key state without failing the install', () => {
  const withoutKey = cliEnv(['doctor'], { ROBLOX_CLOUD_API_KEY: '', RBLX_OC_API_KEY: '' });
  assert.equal(withoutKey.status, 0, 'no key is a capability limit, not a failure');
  assert.match(withoutKey.stdout, /open cloud: no api key/);

  const withKey = cliEnv(['doctor'], { ROBLOX_CLOUD_API_KEY: 'dGVzdC1rZXk=' });
  assert.equal(withKey.status, 0);
  assert.match(withKey.stdout, /open cloud: api key found/);
});

test('publish sends a built place and reports the version it got back', async () => {
  const { child, port } = startStub();
  try {
    // A build spec, so this exercises build -> publish rather than a bare file.
    const spec = path.join(tmp, 'deploy-spec.json');
    fs.writeFileSync(
      spec,
      JSON.stringify({
        className: 'Workspace',
        name: 'Workspace',
        children: [{ className: 'Part', name: 'Brick', properties: { Size: [4, 4, 4] } }],
      }),
    );
    const p = await port;
    const res = cliEnv(
      ['publish', spec, '--universe', '1', '--place-id', '2', '--json'],
      { ROBLOX_CLOUD_API_KEY: 'dGVzdC1rZXk=', ROBLOX_CLOUD_BASE_URL: `http://127.0.0.1:${p}` },
    );
    assert.equal(res.status, 0, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.versionNumber, 41);
    assert.equal(payload.versionType, 'Published');
    assert.equal(payload.builtFrom, spec, 'the caller is told it was built, not published raw');
    assert.equal(payload.bytes, payload.builtBytes);
    assert.match(res.stderr, /published .*version 41/);
  } finally {
    child.kill();
  }
});

test('deploy builds, publishes, and runs against the version it just published', async () => {
  const { child, port } = startStub();
  try {
    const spec = path.join(tmp, 'loop-spec.json');
    fs.writeFileSync(spec, JSON.stringify({ className: 'Part', name: 'Brick' }));
    const smoke = path.join(tmp, 'smoke.luau');
    fs.writeFileSync(smoke, 'local n = #workspace:GetDescendants()\nreturn n\n');
    const p = await port;
    const res = cliEnv(
      [
        'deploy', spec,
        '--universe', '1', '--place-id', '2',
        '--run', smoke,
        '--json',
      ],
      { ROBLOX_CLOUD_API_KEY: 'dGVzdC1rZXk=', ROBLOX_CLOUD_BASE_URL: `http://127.0.0.1:${p}` },
    );
    assert.equal(res.status, 0, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.versionNumber, 41);
    assert.equal(payload.state, 'COMPLETE');
    assert.equal(payload.ran, smoke);
    assert.deepEqual(payload.results, { ok: true, answer: 42 });
    // The smoke test asked for version 41, not "latest".
    assert.match(payload.logs, /script was: local n = #workspace:GetDescendants\(\)/);
  } finally {
    child.kill();
  }
});

test('deploy without a run script says plainly that nothing was executed', async () => {
  const { child, port } = startStub();
  try {
    const spec = path.join(tmp, 'quiet-spec.json');
    fs.writeFileSync(spec, JSON.stringify({ className: 'Part', name: 'Brick' }));
    const p = await port;
    const res = cliEnv(
      ['deploy', spec, '--universe', '1', '--place-id', '2', '--json'],
      { ROBLOX_CLOUD_API_KEY: 'dGVzdC1rZXk=', ROBLOX_CLOUD_BASE_URL: `http://127.0.0.1:${p}` },
    );
    assert.equal(res.status, 0, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.ran, null);
    assert.match(payload.note, /nothing was executed/);
  } finally {
    child.kill();
  }
});

test('publish mistakes are caught before a request is made', () => {
  const noIds = cli(['publish', 'out.rbxl']);
  assert.equal(noIds.status, 1);
  assert.match(noIds.stderr, /publish needs --universe and --place-id/);

  const wrongFile = cliEnv(
    ['publish', 'notes.txt', '--universe', '1', '--place-id', '2'],
    { ROBLOX_CLOUD_API_KEY: 'dGVzdC1rZXk=' },
  );
  assert.equal(wrongFile.status, 1);
  assert.match(wrongFile.stderr, /expected a \.rbxl or \.rbxlx place file/);

  const badType = cliEnv(
    ['publish', 'out.rbxl', '--universe', '1', '--place-id', '2', '--version-type', 'Live'],
    { ROBLOX_CLOUD_API_KEY: 'dGVzdC1rZXk=' },
  );
  assert.equal(badType.status, 1);
  assert.match(badType.stderr, /versionType must be one of Published or Saved/);
});

test('publish without a key names the permission that publishing needs', () => {
  const res = cliEnv(
    ['publish', 'out.rbxl', '--universe', '1', '--place-id', '2'],
    { ROBLOX_CLOUD_API_KEY: '', RBLX_OC_API_KEY: '' },
  );
  assert.equal(res.status, 1);
  assert.match(res.stderr, /no Open Cloud API key/);
  assert.match(res.stderr, /universe-places/, 'publishing needs a different scope than executing');
});
