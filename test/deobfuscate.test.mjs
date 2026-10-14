// Deobfuscation: the parser, the printer, and the passes.
//
// The parser and printer are tested against a property that matters more than
// formatting: `parse` then `print` must reproduce the token stream, because a
// printer that reassociates an operator has silently changed the program. The
// passes are tested against hand-computed Lua semantics (Lua's `%` and `//` do
// not behave like JavaScript's), against the rules each pass claims to follow,
// and against the negative cases — the code it must NOT touch.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse, ParseError } from '../src/luau/parse.js';
import { print, escapeString, formatNumber } from '../src/luau/print.js';
import { tokenize } from '../src/luau/lexer.js';
import { deobfuscate, detectObfuscation, isGeneratedName, evaluateConstant } from '../src/luau/deobfuscate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');

/** The code part of a deobfuscation result, without the generated header. */
function body(code) {
  return code
    .split('\n')
    .filter((line) => !line.startsWith('--'))
    .join('\n')
    .trim();
}

const tokens = (source) => tokenize(source).tokens.map((t) => `${t.type}:${t.value}`).join('\u0001');

// ---------------------------------------------------------------------------
// Parser and printer
// ---------------------------------------------------------------------------

test('parse then print reproduces the token stream of every example in the repo', () => {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(luau|lua)$/.test(entry.name)) found.push(full);
    }
  };
  walk(path.join(repo, 'examples'));
  walk(path.join(repo, 'scripts'));
  assert.ok(found.length >= 5, `expected a corpus, found ${found.length} files`);

  for (const file of found) {
    const source = fs.readFileSync(file, 'utf8');
    const printed = print(parse(source));
    assert.equal(tokens(printed), tokens(source), `${path.relative(repo, file)} did not round-trip`);
  }
});

test('printing preserves operator grouping', () => {
  const cases = [
    'return a - b - c',
    'return a - (b - c)',
    'return a .. b .. c',
    'return (a .. b) .. c',
    'return a ^ b ^ c',
    'return (a ^ b) ^ c',
    'return -a ^ 2',
    'return 2 ^ -3',
    'return not a == b',
    'return a or b and c',
    'return (a or b) and c',
    'return #({})',
    'return #"abc"',
    'return 1 + 2 * 3',
    'return (1 + 2) * 3',
  ];
  for (const source of cases) {
    const printed = print(parse(source));
    assert.equal(tokens(printed), tokens(source), `grouping changed: ${source} -> ${printed.trim()}`);
  }
});

test('printing preserves comments', () => {
  const source = ['-- a leading comment', 'local x = 1 -- trailing', '', '-- end'].join('\n');
  const printed = print(parse(source));
  assert.match(printed, /-- a leading comment/);
  assert.match(printed, /-- trailing/);
  assert.match(printed, /-- end/);
});

test('the parser rejects what it cannot represent, with a position', () => {
  assert.throws(() => parse('local'), (err) => {
    assert.ok(err instanceof ParseError);
    assert.equal(typeof err.line, 'number');
    return true;
  });
});

// ---------------------------------------------------------------------------
// Constant folding, against hand-computed Lua semantics
// ---------------------------------------------------------------------------

/** The folded source of a one-line script. */
function folded(expr) {
  return body(deobfuscate(`return ${expr}`).code);
}

test('Lua arithmetic semantics are respected, not JavaScript ones', () => {
  // Lua's `%` takes the sign of the divisor and `//` floors; JS's `%` takes the
  // sign of the dividend and has no `//` at all.
  assert.equal(folded('7 % 3'), 'return 1');
  assert.equal(folded('-7 % 3'), 'return 2');
  assert.equal(folded('7 % -3'), 'return -2');
  assert.equal(folded('7 // 2'), 'return 3');
  assert.equal(folded('-7 // 2'), 'return -4');
  assert.equal(folded('2 ^ 10'), 'return 1024');
  assert.equal(folded('1 + 2 * 3'), 'return 7');
  assert.equal(folded('(1 + 2) * 3'), 'return 9');
});

test('string construction folds', () => {
  assert.equal(folded('string.char(72, 105)'), 'return "Hi"');
  assert.equal(folded('"a" .. "b" .. "c"'), 'return "abc"');
  assert.equal(folded('"n=" .. 4'), 'return "n=4"');
  assert.equal(folded('string.rep("ab", 3)'), 'return "ababab"');
  assert.equal(folded('string.sub("hello", 2, 3)'), 'return "el"');
  assert.equal(folded('string.upper("hi")'), 'return "HI"');
  assert.equal(folded('#"abcd"'), 'return 4');
});

test('escape-encoded strings decode losslessly', () => {
  const source = 'return "\\x48\\x65\\x6c\\x6c\\x6f"';
  assert.equal(folded('"\\x48\\x65\\x6c\\x6c\\x6f"'), 'return "Hello"');
  void source;
  // A quote and a backslash re-escape correctly when printed.
  assert.equal(escapeString('a"b\\c'), '"a\\"b\\\\c"');
  assert.equal(escapeString('\n'), '"\\n"');
  assert.equal(folded('"\\34"'), 'return "\\""');
});

test('bit32 folds with 32-bit unsigned semantics', () => {
  assert.equal(folded('bit32.bxor(5, 3)'), 'return 6');
  assert.equal(folded('bit32.band(12, 10)'), 'return 8');
  assert.equal(folded('bit32.bor(12, 10)'), 'return 14');
  assert.equal(folded('bit32.lshift(1, 8)'), 'return 256');
  assert.equal(folded('bit32.rshift(256, 4)'), 'return 16');
  assert.equal(folded('4000000000 + 400000000'), 'return 4400000000');
});

test('truthiness and comparison follow Lua, not JavaScript', () => {
  assert.equal(folded('1 and "yes"'), 'return "yes"');
  assert.equal(folded('nil and "yes"'), 'return nil');
  assert.equal(folded('false or "fallback"'), 'return "fallback"');
  assert.equal(folded('0 and "zero is true"'), 'return "zero is true"');
  assert.equal(folded('"" and "empty is true"'), 'return "empty is true"');
  assert.equal(folded('1 == 1'), 'return true');
  assert.equal(folded('"1" == 1'), 'return false');
  assert.equal(folded('not nil'), 'return true');
});

test('impure calls are never folded', () => {
  for (const expr of [
    'os.time()',
    'os.clock()',
    'math.random()',
    'tick()',
    'workspace:GetChildren()',
    'string.format("%d", os.time())',
    'Instance.new("Part")',
    'game:GetService("Players")',
  ]) {
    assert.equal(folded(expr), `return ${expr}`, `${expr} must be left alone`);
  }
});

test('evaluation refuses to produce values Lua cannot print', () => {
  // 1/0 is inf and 0/0 is nan; neither has a literal form.
  assert.equal(folded('1 / 0'), 'return 1 / 0');
  assert.equal(folded('0 / 0'), 'return 0 / 0');
  assert.ok(Number.isFinite(Number(formatNumber(1.5))));
});

// ---------------------------------------------------------------------------
// Inlining
// ---------------------------------------------------------------------------

test('a literal local is inlined and its declaration removed', () => {
  const out = body(deobfuscate('local a = "x"\nprint(a)\nprint(a)').code);
  assert.equal(out, 'print("x")\nprint("x")');
});

test('a local that is reassigned is not inlined', () => {
  const source = 'local a = 1\nprint(a)\na = 2\nprint(a)';
  const out = body(deobfuscate(source).code);
  assert.match(out, /local a = 1/);
  assert.match(out, /a = 2/);
});

test('a local captured by a closure is not inlined', () => {
  const source = 'local a = 1\nlocal function f() return a end\nprint(f(), a)';
  const out = body(deobfuscate(source).code);
  assert.match(out, /local a = 1/, 'a closure can read it later; inlining would freeze it');
});

test('a local whose initialiser has side effects is never inlined', () => {
  const source = 'local a = os.time()\nprint(a, a)';
  const out = body(deobfuscate(source).code);
  assert.match(out, /local a = os\.time\(\)/);
});

test('a table is inlined only where every use is a constant index or a length', () => {
  // Constant indices: the classic string table, safe to inline and fold.
  const constants = body(deobfuscate('local t = {"a", "b"}\nreturn t[1 + 1], #t').code);
  assert.equal(constants, 'return "b", 2');

  // A variable index means the table is being used as a table, so copying the
  // literal to the use site would build a second table.
  const variable = body(deobfuscate('local t = {"a", "b"}\nfor i = 1, #t do print(t[i]) end').code);
  assert.match(variable, /local t = \{\s*"a",\s*"b"\s*\}/, 'the table stays a table');
  assert.match(variable, /t\[i\]/);
});

// ---------------------------------------------------------------------------
// Decode loops
// ---------------------------------------------------------------------------

const BYTES = [
  'local src = { 72, 101, 108, 108, 111 }',
  'local out = {}',
  'for i = 1, #src do out[i] = string.char(src[i]) end',
  'print(table.concat(out))',
].join('\n');

test('the loop an obfuscator decodes a string with is run and folded away', () => {
  assert.equal(body(deobfuscate(BYTES).code), 'print("Hello")');
});

test('a decode loop with a key applied folds too', () => {
  const source = [
    'local src = { 107, 104, 110, 110, 109 }',
    'local out = {}',
    'for i = 1, #src do out[i] = string.char(bit32.bxor(src[i], 3)) end',
    'print(table.concat(out))',
  ].join('\n');
  assert.equal(body(deobfuscate(source).code), 'print("hkmmn")');
});

test('the accumulator may be built by concatenation instead of an array', () => {
  const source = ['local src = { 72, 105 }', 'local s = ""', 'for i = 1, #src do s = s .. string.char(src[i]) end', 'print(s)'].join('\n');
  assert.equal(body(deobfuscate(source).code), 'print("Hi")');
});

test('a decode loop is left alone when any element will not fold', () => {
  // One element depends on the environment, so the loop cannot be run here.
  const source = ['local src = { 1, 2, 3 }', 'local out = {}', 'for i = 1, #src do out[i] = src[i] * os.time() end', 'print(unpack(out))'].join('\n');
  const out = body(deobfuscate(source).code);
  assert.match(out, /for i = 1, #src do/);
  assert.match(out, /os\.time\(\)/);
});

test('a decode loop over a source that is not constant is left alone', () => {
  const source = ['local src = getBytes()', 'local out = {}', 'for i = 1, #src do out[i] = string.char(src[i]) end', 'print(table.concat(out))'].join('\n');
  assert.match(body(deobfuscate(source).code), /for i = 1, #src do/);
});

test('a decode loop whose source is reassigned is left alone', () => {
  const source = [...BYTES.split('\n').slice(0, 3), 'src = { 1 }', 'print(table.concat(out))'].join('\n');
  const out = body(deobfuscate(source).code);
  assert.match(out, /for i = 1, #src do/);
});

test('a decode loop that does not read every element is left alone', () => {
  const source = [
    'local src = { 72, 101, 108, 108, 111 }',
    'local out = {}',
    'for i = 1, 3 do out[i] = string.char(src[i]) end',
    'print(table.concat(out))',
  ].join('\n');
  assert.match(body(deobfuscate(source).code), /for i = 1, 3 do/);
});

test('a decode loop whose accumulator is written elsewhere is left alone', () => {
  const source = [
    'local src = { 72, 105 }',
    'local out = {}',
    'for i = 1, #src do out[i] = string.char(src[i]) end',
    'out = {}',
    'print(table.concat(out))',
  ].join('\n');
  // The later assignment empties it again, so running the loop would change
  // what the final print sees.
  assert.match(body(deobfuscate(source).code), /out = \{\}/);
});

test('a decode loop is not folded when the declaration is not adjacent', () => {
  const source = [
    'local src = { 72, 105 }',
    'local out = {}',
    'print(#out)',
    'for i = 1, #src do out[i] = string.char(src[i]) end',
    'print(table.concat(out))',
  ].join('\n');
  // `print(#out)` reads the accumulator before the loop, so it must still be
  // empty when it runs.
  const out = body(deobfuscate(source).code);
  assert.match(out, /local out = \{\}/);
  assert.match(out, /print\(#out\)/);
});

// ---------------------------------------------------------------------------
// Shadowing
// ---------------------------------------------------------------------------

test('a library name that is a local is not folded as the library', () => {
  // `string` is the user's own table here. Folding would call a different
  // function, and the output would have exactly the same shape, so nothing
  // downstream could catch it.
  const source = 'local string = { char = function() return "X" end }\nprint(string.char(72))';
  const out = body(deobfuscate(source).code);
  assert.match(out, /string\.char\(72\)/);
  assert.doesNotMatch(out, /"H"/);
});

test('a shadowed global function is not folded either', () => {
  const source = 'local tostring = function() return "Z" end\nprint(tostring(5))';
  assert.match(body(deobfuscate(source).code), /tostring\(5\)/);
});

test('shadowing anywhere in the file disables folding for that name', () => {
  // The local is in a function that never runs; the cost of refusing is a fold
  // not made, and that is the side this deliberately errs on.
  const source = [
    'local function f(math)',
    '  return math.floor(1.5)',
    'end',
    'print(math.floor(1.5), f)',
  ].join('\n');
  const out = body(deobfuscate(source).code);
  assert.match(out, /math\.floor\(1\.5\)/);
});

test('unshadowed library calls still fold', () => {
  assert.equal(folded('string.char(72, 105)'), 'return "Hi"');
  assert.equal(folded('math.floor(1.7)'), 'return 1');
  assert.equal(folded('tostring(5)'), 'return "5"');
});

test('a table is copied into a pure call but not into a function of unknown origin', () => {
  // `table.concat` reads the table and never keeps it, so a copy is the same
  // call — and then it folds.
  assert.equal(body(deobfuscate('local t = {"a", "b"}\nprint(table.concat(t))').code), 'print("ab")');

  // A user function might keep the table or mutate it, so it must not be
  // copied to the use site.
  const user = body(deobfuscate('local t = {1, 2}\nlocal function keep(x) return x end\nprint(keep(t))').code);
  assert.match(user, /local t = \{\s*1,\s*2\s*\}/, 'the table stays a table');
  assert.match(user, /print\(keep\(t\)\)/);

  // ...and neither must a shadowed `table`.
  const shadowed = ['local table = {}', 'local t = {"a"}', 'print(table.concat(t))'].join('\n');
  assert.match(body(deobfuscate(shadowed).code), /table\.concat\(t\)/);
});

test('a name is inferred through a bracketed library call', () => {
  const result = deobfuscate('local _0x1 = game["GetService"]("Players")\nprint(_0x1)');
  assert.match(result.code, /local players = game\["GetService"\]\("Players"\)/);
  const rename = result.report.renames.find((r) => r.to === 'players');
  assert.ok(rename, 'the rename is reported');
  assert.match(rename.evidence, /GetService/);
});

// ---------------------------------------------------------------------------
// Dead code
// ---------------------------------------------------------------------------

test('a false branch is removed and a true one is kept', () => {
  assert.equal(body(deobfuscate('if false then print("dead") end\nprint("live")').code), 'print("live")');
  assert.equal(body(deobfuscate('if true then print("kept") end').code), 'print("kept")');
  assert.equal(
    body(deobfuscate('if 2 > 1 then print("a") else print("b") end').code),
    'print("a")',
  );
});

test('elseif chains keep only what can run', () => {
  const source = [
    'if false then print("a")',
    'elseif 1 == 1 then print("b")',
    'else print("c") end',
  ].join('\n');
  assert.equal(body(deobfuscate(source).code), 'print("b")');
});

test('a while-false loop is removed, a while-true loop is only unwrapped when it is safe', () => {
  assert.equal(body(deobfuscate('while false do print("never") end\nprint(1)').code), 'print(1)');

  // No break bound to the loop: unwrapping is the same program.
  assert.equal(body(deobfuscate('while true do print(1) end').code), 'print(1)');

  // A break belongs to that loop; removing the loop would break the program.
  const withBreak = body(deobfuscate('while true do print(1) break end').code);
  assert.match(withBreak, /while true do/);
  assert.match(withBreak, /break/);

  // A continue bound to the loop is the same hazard.
  assert.match(body(deobfuscate('while true do continue end').code), /while true do/);
});

test('a numeric for that cannot iterate is removed', () => {
  assert.equal(body(deobfuscate('for i = 5, 1 do print(i) end\nprint("after")').code), 'print("after")');
  // ...but not when a break inside means it is not dead in the same way.
  assert.match(body(deobfuscate('for i = 1, 10 do print(i) end').code), /for i = 1, 10 do/);
});

// ---------------------------------------------------------------------------
// loadstring
// ---------------------------------------------------------------------------

test('a loadstring of a constant chunk is inlined', () => {
  const out = body(deobfuscate('loadstring("print(1 + 1)")()').code);
  assert.equal(out, 'print(2)');
});

test('a loadstring of a runtime value is left alone', () => {
  const source = 'local s = getSomething()\nloadstring(s)()';
  assert.match(body(deobfuscate(source).code), /loadstring\(s\)\(\)/);
});

test('a loadstring is refused when inlining would change which variable it reads', () => {
  // The chunk reads the global `count`, but a local `count` is in scope where
  // the loadstring is called. A loadstring chunk does not see that local, so
  // inlining would silently redirect the read.
  const source = 'local count = 5\nlocal function f()\n  loadstring("print(count)")()\nend\nreturn f';
  const result = deobfuscate(source);
  assert.match(result.code, /loadstring/);
  assert.ok(
    result.report.warnings.some((w) => w.code === 'loadstring-shadowed'),
    'the refusal is reported rather than silent',
  );
});

// ---------------------------------------------------------------------------
// Renaming
// ---------------------------------------------------------------------------

test('generated names are recognised and idiomatic ones are not', () => {
  for (const name of ['_0x4f2a', '_0xdeadbeef', 'l_17', 'l13', 'v0042', '_9', 'aaaa', 'abcdefghijklmnopqrst']) {
    assert.equal(isGeneratedName(name), true, `${name} should look generated`);
  }
  for (const name of ['i', 'j', 'x', 'y', 't', 'n', 'count', 'player', 'self', 'config', 'mainController', 'util']) {
    assert.equal(isGeneratedName(name), false, `${name} should not look generated`);
  }
});

test('generated names are renamed from evidence where there is evidence', () => {
  const source = [
    'local _0x1 = Instance.new("Part")',
    'local _0x2 = game:GetService("HttpService")',
    'local _0x3 = 7',
    '_0x1.Name = "x"',
    'print(_0x2, _0x3)',
  ].join('\n');
  const result = deobfuscate(source);
  assert.match(result.code, /local part = Instance\.new\("Part"\)/);
  assert.match(result.code, /local httpService = game:GetService\("HttpService"\)/);
  // The literal was inlined, so its name is gone entirely.
  assert.match(result.code, /print\(httpService, 7\)/);

  const part = result.report.renames.find((r) => r.to === 'part');
  assert.equal(part.inferred, true);
  assert.match(part.evidence, /Instance\.new\("Part"\)/);
});

test('a name with no evidence is given a neutral name and says so', () => {
  const source = 'local _0x9 = {}\n_0x9[1] = 2\nreturn _0x9';
  const result = deobfuscate(source);
  const rename = result.report.renames[0];
  assert.equal(rename.inferred, false);
  assert.match(rename.evidence, /no evidence in the code/);
  assert.match(result.code, /local v1 = \{\}/);
});

test('idiomatic locals are never renamed', () => {
  const source = 'local i = 0\nfor n = 1, 3 do i = i + n end\nreturn i, n';
  const result = deobfuscate(source);
  assert.match(result.code, /for n = 1, 3 do/);
  assert.match(result.code, /i = i \+ n/);
  assert.equal(result.report.renames.length, 0);
});

test('globals are never renamed, even when they look generated', () => {
  // `_0xdead` is an assignment to a global here, and a global is part of the
  // program's interface to its environment.
  const source = '_0xdead = 1\n_0xdead = 2\nreturn _0xdead';
  const out = body(deobfuscate(source).code);
  assert.match(out, /_0xdead = 1/);
  assert.match(out, /_0xdead = 2/);
});

test('renaming is a fixed point: running twice equals running once', () => {
  const source = [
    'local _0x1 = Instance.new("Part")',
    'local _0x2 = {}',
    '_0x2[1] = 1',
    'print(_0x1, _0x2)',
  ].join('\n');
  const once = deobfuscate(source).code;
  const twice = deobfuscate(once).code;
  assert.equal(body(twice), body(once));
});

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

test('obfuscation detection names what it found and what it cannot undo', () => {
  const source = [
    'local _0x1 = "\\x48\\x65\\x6c\\x6c\\x6f\\x21"',
    'local _0x2 = "\\x57\\x6f\\x72\\x6c\\x64\\x21"',
    'local _0x3 = "\\x41\\x42\\x43\\x44\\x45\\x46"',
    'loadstring("print(1)")()',
    'print(_0x1, _0x2, _0x3)',
  ].join('\n');
  const parsed = parse(source);
  const detection = detectObfuscation(parsed, source, parsed.tokens);

  assert.equal(detection.obfuscated, true);
  assert.ok(detection.score > 40, `score was ${detection.score}`);
  assert.ok(detection.techniques.includes('escape-encoded-strings'));
  assert.ok(detection.techniques.includes('generated-identifier-names'));
  assert.ok(detection.techniques.includes('dynamic-code-loading'));

  const escapes = detection.findings.find((f) => f.technique === 'escape-encoded-strings');
  assert.equal(escapes.reversible, 'yes');
  // Evidence is the raw literal, not the decoded value.
  assert.match(escapes.evidence, /\\x48/);
});

test('a VM dispatch loop is reported as not reversible', () => {
  const numbers = Array.from({ length: 40 }, (_, i) => i).join(', ');
  const source = [
    `local prog = {${numbers}}`,
    'local pc = 1',
    'while true do',
    '  local op = prog[pc]',
    '  pc = pc + 1',
    '  if op == 0 then break end',
    'end',
  ].join('\n');
  const parsed = parse(source);
  const detection = detectObfuscation(parsed, source, parsed.tokens);
  const vm = detection.findings.find((f) => f.technique === 'vm-interpreter');
  assert.ok(vm, `expected a vm-interpreter finding, got ${detection.techniques.join(', ')}`);
  assert.equal(vm.reversible, 'no');
  assert.deepEqual(detection.irreversible, ['vm-interpreter']);
  assert.match(vm.note, /does not attempt it/);
});

test('clean code is reported as clean', () => {
  const source = [
    '-- A normal module.',
    'local Util = {}',
    'function Util.add(a, b)',
    '  return a + b',
    'end',
    'return Util',
  ].join('\n');
  const parsed = parse(source);
  const detection = detectObfuscation(parsed, source, parsed.tokens);
  assert.equal(detection.obfuscated, false, JSON.stringify(detection.findings));
  assert.equal(detection.score, 0);
});

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------

test('a realistic obfuscated script comes out readable', () => {
  const source = [
    'local _0x1f = "\\x70\\x72\\x69\\x6e\\x74"',
    'local _0x2a = {"\\x48\\x65\\x6c\\x6c\\x6f", "\\x57\\x6f\\x72\\x6c\\x64"}',
    'local _0x3b = 1 + 2 * 3',
    'if false then print("\\x64\\x65\\x61\\x64") end',
    'if 2 > 1 then print(_0x2a[1]) end',
    'print(_0x1f, _0x3b)',
  ].join('\n');
  const result = deobfuscate(source);
  const out = body(result.code);

  assert.match(out, /print\("Hello"\)/);
  assert.match(out, /print\("print", 7\)/);
  assert.doesNotMatch(out, /\\x/);
  assert.doesNotMatch(out, /_0x/);
  assert.doesNotMatch(out, /"dead"/);
  assert.equal(result.verification.outputReparses, true);
  assert.equal(result.verification.treeMatchesOutput, true);
});

test('the output says what was and was not recovered', () => {
  const source = 'local _0x1 = "\\x41\\x42\\x43\\x44"\nprint(_0x1)';
  const result = deobfuscate(source, { rename: false });
  const header = result.code.split('\n').filter((l) => l.startsWith('--')).join('\n');
  assert.match(header, /INFERRED from how they are used, not recovered/);
  assert.match(header, /nothing can bring them back/);
});

test('a clean file comes back byte-identical apart from the header', () => {
  // Reformatting a file that needed nothing is churn in someone's repository,
  // and this is a tool people should be able to run over all of it.
  const source = [
    '-- A module, written by hand with tabs.',
    'local M = {}',
    '',
    'function M.add(a, b)',
    '\treturn a + b -- keep this comment',
    'end',
    '',
    'return M',
    '',
  ].join('\n');
  const result = deobfuscate(source);
  assert.equal(result.report.changed, false);
  assert.ok(result.code.endsWith(source), 'the source is returned as written');
  assert.match(result.code, /nothing to change/);
  assert.equal(result.verification.unchanged, true);
});

test('an escape-encoded literal is still decoded, and counted', () => {
  // Decoding happens at parse time, but printing is what puts the value in the
  // output — so this cannot take the byte-identical shortcut.
  const source = String.raw`return "\x48\x65\x6c\x6c\x6f"` + '\n';
  const result = deobfuscate(source);
  assert.match(result.code, /return "Hello"/);
  assert.equal(result.report.transformations.decodedStrings, 1);
  assert.equal(result.report.changed, true);
});

test('a backslash in a format string does not force a rewrite', () => {
  // `"\n%s"` is not obfuscation, and a clean file containing one is still
  // returned as written.
  const source = 'print(string.format("%s:\\n", name))\n';
  const result = deobfuscate(source);
  assert.equal(result.report.transformations.decodedStrings, 0);
  assert.ok(result.code.endsWith(source));
});

test('deobfuscating idiomatic code changes nothing that matters', () => {
  const source = [
    'local M = {}',
    'function M.greet(name)',
    '  return "hello " .. name',
    'end',
    'return M',
  ].join('\n');
  const result = deobfuscate(source);
  assert.equal(body(result.code), body(source));
  assert.equal(result.report.changed, false);
  assert.equal(result.report.renames.length, 0);
});

test('fold-only mode leaves names alone', () => {
  const source = 'local _0x1 = 1 + 1\nprint(_0x1)';
  const out = body(deobfuscate(source, { rename: false }).code);
  assert.equal(out, 'print(2)');
  assert.doesNotMatch(out, /_0x/);
  // With renaming off and inlining on, the name disappears through inlining,
  // which is the point: the rename pass is what is disabled.
  const kept = body(deobfuscate('local _0x1 = {}\n_0x1[1] = 2\nreturn _0x1', { rename: false }).code);
  assert.match(kept, /_0x1/);
});

test('every pass can be turned off independently', () => {
  const source = ['local a = 1 + 1', 'if false then print("dead") end', 'print(a)'].join('\n');

  // With every pass off, the output is the same program — the printer may lay it
  // out differently, so compare tokens rather than text.
  const untouched = deobfuscate(source, { fold: false, simplify: false, rename: false }).code;
  assert.equal(tokens(body(untouched)), tokens(source), 'with every pass off the program is unchanged');

  const foldedOnly = body(deobfuscate(source, { simplify: false, rename: false }).code);
  assert.match(foldedOnly, /print\(2\)/, 'folding evaluated the arithmetic');
  assert.match(foldedOnly, /if false then/, 'but the dead branch is simplify\'s job');

  const simplifiedOnly = body(deobfuscate(source, { fold: false, rename: false }).code);
  assert.doesNotMatch(simplifiedOnly, /if false/, 'the literal condition is enough to cut the branch');
  assert.match(simplifiedOnly, /1 \+ 1/, 'but arithmetic is left alone with folding off');
});

test('a temporary that only a dead branch read goes with the branch', () => {
  const source = ['local unused = 1 + 1', 'if false then', '  print(unused)', 'end'].join('\n');
  assert.equal(body(deobfuscate(source).code), '', 'nothing is left to run');
});

test('the evaluator agrees with itself about what it cannot evaluate', () => {
  const parsed = parse('return 1 + 1, os.time(), "a" .. "b"');
  const exprs = parsed.body[0].exprs;
  assert.deepEqual(evaluateConstant(exprs[0]), { kind: 'number', value: 2 });
  assert.equal(evaluateConstant(exprs[1]), null);
  assert.deepEqual(evaluateConstant(exprs[2]), { kind: 'string', value: 'ab' });
});
