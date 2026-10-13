import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tokenize, codeTokens } from '../src/luau/lexer.js';
import { analyzeSource, summarizeScripts } from '../src/luau/analyze.js';
import { buildRequireGraph, scriptsInModel, resolveChain, findRequires } from '../src/luau/requires.js';
import { Instance } from '../src/rbx/instance.js';
import { local } from '../src/backends/index.js';

function check(source) {
  return analyzeSource(source, { file: 'test.luau' }).diagnostics;
}

function codes(source) {
  return check(source).map((d) => d.code);
}

function find(source, code) {
  return check(source).find((d) => d.code === code) || null;
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

test('lexer records exact line and column for tokens', () => {
  const { tokens } = tokenize('local a = 1\n-- a comment\nlocal bb = 22\n');
  const bb = tokens.find((t) => t.value === 'bb');
  assert.equal(bb.line, 3);
  assert.equal(bb.col, 7);
});

test('lexer handles long bracket strings and comments, including levels', () => {
  const src = 'local s = [==[\nnot a comment -- nope\n]==]\nlocal t = 2\n';
  const { tokens, errors } = tokenize(src);
  assert.equal(errors.length, 0);
  assert.equal(tokens.find((t) => t.value === 't').line, 4);
  assert.ok(tokens.some((t) => t.type === 'string' && t.value.includes('nope')));
});

test('lexer handles escapes, separators, and numeric forms', () => {
  const src = 'local s = "a\\x41b\\65c\\u{1F600}\\z\n  d"\nlocal n = {0xFF, 0b1010, 1.5e-3, .5, 1_000, 1e6}\n';
  const { tokens, errors } = tokenize(src);
  assert.equal(errors.length, 0);
  const numbers = tokens.filter((t) => t.type === 'number');
  // `text` keeps the source form (underscores, hex, suffixes); `value` is the
  // parsed number, so an analyser never has to re-parse a literal.
  assert.deepEqual(numbers.map((t) => t.text), ['0xFF', '0b1010', '1.5e-3', '.5', '1_000', '1e6']);
  assert.deepEqual(numbers.map((t) => t.value), [255, 10, 0.0015, 0.5, 1000, 1000000]);
});

test('lexer handles interpolated strings without breaking positions', () => {
  const src = 'local msg = `hi {x + 1}`\nlocal after = 3\n';
  const { tokens, errors } = tokenize(src);
  assert.equal(errors.length, 0);
  assert.equal(tokens.find((t) => t.value === 'after').line, 2);
});

test('lexer handles Luau syntax: continue, type, export, compound assignment', () => {
  const src = [
    'export type Point = { x: number, y: number }',
    'type Handler = (Point) -> ()',
    'local n = 0',
    'n += 1',
    'n -= 1',
    'n *= 2',
    'n //= 2',
    'for i = 1, 10 do',
    '  if i == 2 then continue end',
    'end',
  ].join('\n');
  const { errors } = tokenize(src);
  assert.equal(errors.length, 0);
});

test('lexer reports unterminated constructs instead of guessing', () => {
  const { errors } = tokenize('local s = "unterminated\n');
  assert.ok(errors.length > 0);
});

test('codeTokens strips comments but keeps code', () => {
  const { tokens } = codeTokens('local x = 1 -- trailing\n--[==[ block ]==]\nlocal y = 2\n');
  const values = tokens.map((t) => t.value);
  assert.ok(values.includes('y'));
  assert.ok(!values.includes('trailing'));
  assert.ok(!values.includes('block'));
});

test('lexer never hangs on adversarial input', () => {
  const nasty = ['[====[', '"\\', "'''", '0x', '..', '`{', '--[[', '::', '\u0000'];
  for (const s of nasty) {
    const { errors } = tokenize(s);
    assert.ok(Array.isArray(errors));
  }
});

// ---------------------------------------------------------------------------
// Static analysis: the checks must fire on the mistakes
// ---------------------------------------------------------------------------

test('Instance.new with a misspelled class is an error with a suggestion', () => {
  const d = find('local p = Instance.new("Prat")', 'unknown-class');
  assert.ok(d, 'expected unknown-class');
  assert.equal(d.severity, 'error');
  assert.equal(d.suggestion, 'Part');
  assert.equal(d.line, 1);
});

test('Instance.new with a service class is reported as not creatable', () => {
  const d = find('local w = Instance.new("Workspace")', 'not-creatable');
  assert.ok(d, 'expected not-creatable');
  assert.equal(d.severity, 'error');
  assert.match(d.suggestion, /GetService/);
});

test('a creatable class passes untouched', () => {
  assert.deepEqual(codes('local p = Instance.new("Part")\nlocal f = Instance.new("Folder")\nlocal g = Instance.new("Part")\n'), []);
});

test('unknown enum item is an error with the real item suggested', () => {
  const d = find('local m = Enum.Material.Concree', 'unknown-enum-item');
  assert.ok(d, 'expected unknown-enum-item');
  assert.equal(d.suggestion, 'Concrete');
  assert.equal(d.line, 1);
});

test('unknown enum is an error', () => {
  assert.ok(codes('local x = Enum.NotARealEnum.Value').includes('unknown-enum'));
});

test('real enum paths are silent', () => {
  assert.deepEqual(codes('local a = Enum.Material.Concrete\nlocal b = Enum.KeyCode.Space\nlocal c = Enum.PartType.Ball\n'), []);
});

test('enum item lookup through a variable is not guessed at', () => {
  // `material` is dynamic; we must not claim to know it.
  assert.deepEqual(codes('local material = Enum.Material.Concrete\nlocal x = Enum.Material[something]'), []);
});

test('GetService with an unknown class is an error, a non-service is a warning', () => {
  const unknown = find('local x = game:GetService("ReplicatedStorge")', 'unknown-service');
  assert.ok(unknown);
  assert.equal(unknown.suggestion, 'ReplicatedStorage');

  const notService = find('local x = game:GetService("Part")', 'not-a-service');
  assert.ok(notService);
  assert.equal(notService.severity, 'warning');
});

test('real services are silent, however they are spelled', () => {
  assert.deepEqual(
    codes([
      'local Players = game:GetService("Players")',
      'local RS = game:GetService("ReplicatedStorage")',
      'local SSS = game:GetService("ServerScriptService")',
      'local Lighting = game:GetService("Lighting")',
    ].join('\n')),
    [],
  );
});

test('property typos on constructed instances are caught, with the line', () => {
  const src = 'local p = Instance.new("Part")\np.Name = "x"\np.Sizee = Vector3.new(1, 1, 1)\n';
  const d = find(src, 'property-typo');
  assert.ok(d, 'expected property-typo');
  assert.equal(d.suggestion, 'Size');
  assert.equal(d.line, 3);
});

test('a real class gets every check it deserves, each with a fix', () => {
  const src = [
    'local part = Instance.new("Part")',
    'part.Anchord = true',
    'part.Material = Enum.Material.Gras',
    'part.Parent = game:GetService("Wrokspace")',
  ].join('\n');
  const found = check(src);
  const byCode = Object.fromEntries(found.map((d) => [d.code, d]));
  assert.ok(byCode['property-typo'], 'expected property-typo');
  assert.ok(byCode['unknown-enum-item'], 'expected unknown-enum-item');
  assert.ok(byCode['unknown-service'], 'expected unknown-service');
  for (const d of found) {
    assert.ok(d.line > 0 && d.col > 0, `${d.code} must carry a position`);
    assert.ok(d.message.length > 0);
  }
});

test('deprecated globals are warnings pointing at task.*', () => {
  const src = 'wait(1)\nspawn(function() end)\ndelay(1, function() end)\nelapsedTime()\n';
  const found = check(src).filter((d) => d.code === 'deprecated-global');
  assert.equal(found.length, 4);
  assert.deepEqual(found.map((d) => d.actual), ['wait', 'spawn', 'delay', 'elapsedTime']);
  assert.equal(found[0].suggestion, 'task.wait');
  assert.equal(found[3].suggestion, 'os.clock');
});

test('modern task library calls are silent', () => {
  assert.deepEqual(codes('task.wait(1)\ntask.spawn(function() end)\ntask.defer(function() end)\ntask.delay(1, function() end)\n'), []);
});

test('a dotted method named like a deprecated global is not flagged', () => {
  assert.deepEqual(codes('local t = {}\nt.wait(1)\nobj:spawn()\n'), []);
});

test('deprecated methods are warnings with a replacement', () => {
  const d = find('local p = Instance.new("Part")\np:Remove()', 'deprecated-method');
  assert.ok(d, 'expected deprecated-method');
  assert.equal(d.suggestion, 'Destroy');
  assert.equal(d.line, 2);
});

test(':Destroy() and other modern methods are silent', () => {
  assert.deepEqual(codes('local p = Instance.new("Part")\np:Destroy()\np:Clone()\np:IsA("BasePart")\n'), []);
});

// ---------------------------------------------------------------------------
// False positives: valid, idiomatic Luau must produce nothing at all.
// This is the discipline that makes the analyser trustworthy for agents.
// ---------------------------------------------------------------------------

test('an idiomatic service script produces zero diagnostics', () => {
  const src = `--!strict
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

local Config = require(ReplicatedStorage.Shared.Config)

local module = {}

export type Payload = { name: string, count: number }

function module.onPlayerAdded(payload: Payload)
  local player = Players:FindFirstChild(payload.name)
  if not player then
    return
  end
  local character = player.Character
  if character then
    local humanoid = character:FindFirstChildWhichIsA("Humanoid")
    if humanoid and humanoid.Health > 0 then
      humanoid.Health = humanoid.Health - Config.damage
    end
  end
end

function module.track(dt: number)
  if not RunService:IsServer() then
    return
  end
  local part = Instance.new("Part")
  part.Name = "Tracker"
  part.Size = Vector3.new(1, 1, 1)
  part.Anchored = true
  part.CanCollide = false
  part.Material = Enum.Material.Neon
  part.Color = Color3.fromRGB(255, 255, 255)
  part.CFrame = CFrame.new(0, 10, 0) * CFrame.Angles(0, math.rad(45), 0)
  part.Transparency = 0.5
  part.Parent = workspace

  local folder = Instance.new("Folder")
  folder.Name = "Trackers"
  folder.Parent = workspace

  local connection
  connection = RunService.Heartbeat:Connect(function(step)
    part.CFrame = part.CFrame * CFrame.new(0, step, 0)
    local _, elapsed = os.clock(), tick()
    task.wait()
    connection:Disconnect()
  end)

  return part
end

for _, child in ipairs(ReplicatedStorage:GetChildren()) do
  if child:IsA("ModuleScript") and child.Name ~= "Config" then
    local ok, err = pcall(function()
      return require(child)
    end)
    if not ok then
      warn(string.format("failed to load %s: %s", child.Name, tostring(err)))
    end
  end
end

return module
`;
  assert.deepEqual(check(src), []);
});

test('tables and dynamic values are never treated as instances', () => {
  const src = [
    'local config = { Sizee = 4, Anchord = true, Material = "Grass" }',
    'config.Speedd = 10',
    'local inst = someFactory()',
    'inst.Sizee = 1',
    'inst.Anchord = false',
    'local t = config["Anchord"]',
    'local list = {}',
    'table.insert(list, { Nanme = "x" })',
  ].join('\n');
  assert.deepEqual(check(src), []);
});

test('a near-miss that is not close enough is left alone', () => {
  // `Bouncinesss` is close to Bounciness, but `Zzz` and `Foo` are not close to
  // anything, and inventing a suggestion there would be worse than silence.
  assert.deepEqual(codes('local p = Instance.new("Part")\np.Zzz = 1\np.Foo = 2\n'), []);
});

test('string contents are never analysed as code', () => {
  const src = [
    'local message = "Instance.new(\\"Parts\\") and Enum.Material.Concree and wait(1)"',
    'local long = [[game:GetService("NotAService")]]',
    'local interp = `also not code: {1}`',
  ].join('\n');
  assert.deepEqual(check(src), []);
});

test('comments are never analysed as code', () => {
  const src = '-- Instance.new("Parts")\n--[[ Enum.Material.Concree ]]\nlocal x = 1\n';
  assert.deepEqual(check(src), []);
});

test('Instance.new on a variable class is skipped, not guessed', () => {
  assert.deepEqual(codes('local cls = "Parts"\nlocal x = Instance.new(cls)\nlocal y = Instance.new(parts[i])\n'), []);
});

test('a local shadowing Instance is respected', () => {
  // Here `Instance` is a table the scripter made; its `.new` takes anything.
  const src = 'local Instance = { new = function(name) return { name = name } end }\nlocal x = Instance.new("TotallyMadeUp")\n';
  assert.deepEqual(codes(src), []);
});

test('rebinding a global silences checks about it rather than guessing', () => {
  // Each of these makes a claim about the global impossible, so we make none.
  const rebinds = [
    'local Instance = { new = function(n) return { name = n } end }\nlocal x = Instance.new("TotallyMadeUp")',
    'function Instance() end\nlocal x = Instance.new("TotallyMadeUp")',
    'local function f(Instance)\n  return Instance.new("TotallyMadeUp")\nend',
    'Instance = {}\nlocal x = Instance.new("TotallyMadeUp")',
    'local Enum = {}\nlocal x = Enum.Material.NotReal',
    'local game = { GetService = function() end }\nlocal x = game:GetService("NotAService")',
  ];
  for (const src of rebinds) {
    assert.deepEqual(codes(src), [], `should stay silent for: ${src.split('\\n')[0]}`);
  }
});

test('using a global as an argument does not silence its checks', () => {
  // `Instance` here is still the real global: the rebind rule must not misfire.
  assert.deepEqual(codes('local ok = assert(Instance.new("Parts"))'), ['unknown-class']);
});

test('empty and comment-only files analyse clean', () => {
  assert.deepEqual(check(''), []);
  assert.deepEqual(check('-- just a comment\n'), []);
  assert.deepEqual(check('\n\n\n'), []);
});

test('unparseable source yields no crash and no invented diagnostics', () => {
  const broken = ['local x = ', 'function(', 'end end end', 'local = = =', '((((', '"]"'];
  for (const src of broken) {
    const result = analyzeSource(src, { file: 'broken.luau' });
    assert.ok(Array.isArray(result.diagnostics), `threw on: ${src}`);
    assert.ok(Array.isArray(result.errors));
  }
});

test('summarizeScripts counts severities and decides ok correctly', () => {
  const clean = summarizeScripts([], { scripts: 2 });
  assert.equal(clean.ok, true);
  assert.equal(clean.errorCount, 0);
  assert.equal(clean.scriptCount, 2);

  const dirty = summarizeScripts(analyzeSource('wait(1)').diagnostics, { scripts: 1 });
  assert.equal(dirty.ok, true, 'warnings alone must not fail a check');
  assert.equal(dirty.warningCount, 1);

  const failing = summarizeScripts(analyzeSource('local x = Instance.new("Prat")').diagnostics, { scripts: 1 });
  assert.equal(failing.ok, false);
  assert.equal(failing.errorCount, 1);
});

// ---------------------------------------------------------------------------
// Require graph
// ---------------------------------------------------------------------------

function tree(spec, parent = null) {
  const inst = new Instance(spec.className, spec.name);
  for (const child of spec.children || []) {
    const c = tree(child, inst);
    inst.addChild(c);
  }
  void parent;
  return inst;
}

/** A place with a real shape: Shared modules, a cycle, a broken require. */
function place() {
  const rs = tree({
    className: 'ReplicatedStorage',
    name: 'ReplicatedStorage',
    children: [
      { className: 'Folder', name: 'Shared', children: [
        { className: 'ModuleScript', name: 'Util' },
        { className: 'ModuleScript', name: 'Config' },
        { className: 'ModuleScript', name: 'LoopsA' },
        { className: 'ModuleScript', name: 'LoopsB' },
        { className: 'ModuleScript', name: 'Broken' },
      ] },
    ],
  });
  const sss = tree({
    className: 'ServerScriptService',
    name: 'ServerScriptService',
    children: [{ className: 'Script', name: 'Main' }],
  });
  const set = (inst, source) => inst.set('Source', source);
  const shared = rs.children[0];
  set(shared.children.find((c) => c.name === 'Util'), 'return { add = function(a, b) return a + b end }\n');
  set(shared.children.find((c) => c.name === 'Config'), 'return { damage = 10 }\n');
  set(shared.children.find((c) => c.name === 'LoopsA'), 'return require(script.Parent.LoopsB)\n');
  set(shared.children.find((c) => c.name === 'LoopsB'), 'return require(script.Parent.LoopsA)\n');
  set(
    shared.children.find((c) => c.name === 'Broken'),
    'local Util = require(script.Parent.Util)\nlocal Nope = require(script.Parent.Missing)\nlocal Wrong = require(game.ServerScriptService.Main)\nreturn Util\n',
  );
  set(
    sss.children.find((c) => c.name === 'Main'),
    'local Util = require(game.ReplicatedStorage.Shared.Util)\nlocal Config = require(script.Parent.Util)\nprint(Util.add(1, Config.damage))\n',
  );
  return [rs, sss];
}

test('require chains are resolved to real instance paths', () => {
  const roots = place();
  const graph = buildRequireGraph(scriptsInModel(roots), roots);
  assert.equal(graph.scriptCount, 6);
  assert.deepEqual(
    graph.edges.map((e) => `${e.from} -> ${e.to}`).sort(),
    [
      'ReplicatedStorage.Shared.Broken -> ReplicatedStorage.Shared.Util',
      'ReplicatedStorage.Shared.Broken -> ServerScriptService.Main',
      'ReplicatedStorage.Shared.LoopsA -> ReplicatedStorage.Shared.LoopsB',
      'ReplicatedStorage.Shared.LoopsB -> ReplicatedStorage.Shared.LoopsA',
      'ServerScriptService.Main -> ReplicatedStorage.Shared.Util',
    ],
  );
});

test('a require of something missing names the missing instance and its parent', () => {
  const roots = place();
  const graph = buildRequireGraph(scriptsInModel(roots), roots);
  const d = graph.diagnostics.find((x) => x.code === 'require-not-found');
  assert.ok(d, 'expected require-not-found');
  assert.equal(d.line, 2);
  assert.equal(d.file, 'ReplicatedStorage.Shared.Broken');
  assert.equal(d.actual, 'Missing');
  assert.equal(d.path, 'ReplicatedStorage.Shared');
});

test('a require of a non-ModuleScript is an error', () => {
  const roots = place();
  const graph = buildRequireGraph(scriptsInModel(roots), roots);
  const d = graph.diagnostics.find((x) => x.code === 'require-not-module');
  assert.ok(d, 'expected require-not-module');
  assert.match(d.message, /is a Script, not a ModuleScript/);
});

test('a require of a missing sibling suggests a real sibling name', () => {
  const roots = place();
  const broken = roots[0].children[0].children.find((c) => c.name === 'Broken');
  broken.set('Source', 'return require(script.Parent.Utli)\n');
  const graph = buildRequireGraph(scriptsInModel(roots), roots);
  const d = graph.diagnostics.find((x) => x.code === 'require-not-found');
  assert.ok(d);
  assert.equal(d.suggestion, 'Util');
});

test('cycles are found, reported once, and carry a line', () => {
  const roots = place();
  const graph = buildRequireGraph(scriptsInModel(roots), roots);
  assert.equal(graph.cycles.length, 1);
  const d = graph.diagnostics.find((x) => x.code === 'require-cycle');
  assert.ok(d);
  assert.match(d.message, /LoopsA -> ReplicatedStorage.Shared.LoopsB/);
  assert.equal(typeof d.line, 'number');
});

test('computed requires are reported as dynamic, never as errors', () => {
  const roots = place();
  roots[0].children[0].children.find((c) => c.name === 'Util').set(
    'Source',
    'local mods = {}\nreturn require(mods[1])\n',
  );
  const graph = buildRequireGraph(scriptsInModel(roots), roots);
  const dyn = graph.diagnostics.filter((x) => x.code === 'dynamic-require');
  assert.equal(dyn.length, 1);
  assert.equal(dyn[0].severity, 'info');
  // The computed require belongs to Util; it must not be blamed on any other file.
  assert.equal(dyn[0].file, 'ReplicatedStorage.Shared.Util');
  assert.ok(
    !graph.diagnostics.some(
      (x) => x.severity === 'error' && x.code === 'require-not-found' && x.file === 'ReplicatedStorage.Shared.Util',
    ),
  );
});

test('script.Parent, nested paths, and FindFirstChild chains all resolve', () => {
  const roots = place();
  const shared = roots[0].children[0];
  shared.children.find((c) => c.name === 'Broken').set('Source', 'return require(script.Parent.Util)\n');
  shared.children.find((c) => c.name === 'Config').set(
    'Source',
    [
      'local a = require(script.Parent.Util)',
      'local b = require(script.Parent:FindFirstChild("Util"))',
      'local c = require(game.ReplicatedStorage.Shared.Util)',
      'return { a, b, c }',
    ].join('\n'),
  );
  const graph = buildRequireGraph(scriptsInModel(roots), roots);
  // Scoped to the file under test: the rest of the fixture holds other cases.
  const errors = graph.diagnostics.filter(
    (x) => x.severity === 'error' && x.file === 'ReplicatedStorage.Shared.Config',
  );
  assert.deepEqual(errors, []);
  const edges = graph.edges.filter((e) => e.from === 'ReplicatedStorage.Shared.Config');
  assert.equal(edges.length, 3, 'all three spellings of the same require must resolve');
  assert.ok(edges.every((e) => e.to === 'ReplicatedStorage.Shared.Util'));
});

test('require of an aliased local is dynamic, not a fabricated error', () => {
  const src = 'local Util = game.ReplicatedStorage.Shared.Util\nreturn require(Util)\n';
  const { tokens } = codeTokens(src);
  const calls = findRequires(tokens);
  assert.equal(calls.length, 1);
  const roots = place();
  // `Util` is not `game` or `script`, so the chain is dynamic.
  const resolved = resolveChain([{ name: 'Util' }], { root: roots[0], scriptInst: roots[0] });
  assert.equal(resolved.kind, 'dynamic');
});

test('scriptsInModel finds every script kind with its full path and source', () => {
  const roots = place();
  roots[1].addChild(new Instance('LocalScript', 'Client'));
  roots[1].children.find((c) => c.name === 'Client').set('Source', '-- client\n');
  const scripts = scriptsInModel(roots);
  assert.equal(scripts.length, 7);
  assert.ok(scripts.some((s) => s.className === 'LocalScript' && s.path === 'ServerScriptService.Client'));
  for (const s of scripts) {
    assert.equal(typeof s.source, 'string');
    assert.match(s.path, /^[A-Za-z]+\.[A-Za-z]/);
  }
});

test('a script containing itself in a cycle terminates', () => {
  const roots = place();
  roots[0].children[0].children.find((c) => c.name === 'Util').set('Source', 'return require(script)\n');
  const graph = buildRequireGraph(scriptsInModel(roots), roots);
  assert.ok(graph.cycles.some((c) => c[0] === 'ReplicatedStorage.Shared.Util'));
});

// ---------------------------------------------------------------------------
// End to end through the project builder
// ---------------------------------------------------------------------------

test('analysis runs on a built project, scripts and all', () => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-luau-'));
  mkdirSync(join(dir, 'src', 'shared'), { recursive: true });
  writeFileSync(
    join(dir, 'default.project.json'),
    JSON.stringify({
      name: 'LuauTest',
      tree: {
        ReplicatedStorage: { $className: 'ReplicatedStorage', Shared: { $path: 'src/shared' } },
      },
    }),
  );
  writeFileSync(join(dir, 'src', 'shared', 'Util.luau'), 'return { ok = true }\n');
  writeFileSync(join(dir, 'src', 'shared', 'Bad.luau'), 'local p = Instance.new("Prat")\nreturn require(script.Parent.Nope)\n');

  const { roots } = local.buildFromProject(join(dir, 'default.project.json'));
  const scripts = scriptsInModel(roots);
  assert.equal(scripts.length, 2);

  const diagnostics = [];
  for (const s of scripts) {
    diagnostics.push(...analyzeSource(s.source, { file: s.path }).diagnostics);
  }
  diagnostics.push(...buildRequireGraph(scripts, roots).diagnostics);

  const summary = summarizeScripts(diagnostics, { scripts: scripts.length });
  assert.equal(summary.ok, false);
  assert.equal(summary.errorCount, 2, 'one unknown class plus one missing require');
  assert.ok(diagnostics.every((d) => typeof d.file === 'string' && d.file.length > 0));
});
