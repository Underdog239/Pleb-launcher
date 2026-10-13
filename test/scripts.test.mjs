import test from 'node:test';
import assert from 'node:assert/strict';
import { Instance } from '../src/rbx/instance.js';
import { modelFromSpec, collectScripts, scriptGrep, diffModels, applyScriptEdits } from '../src/backends/local/index.js';

function place() {
  return modelFromSpec({
    className: 'Folder',
    name: 'Root',
    children: [
      {
        className: 'Script',
        name: 'Main',
        properties: { Source: 'local x = 1\nprint(x)\nprint(x + 1)\n' },
      },
      { className: 'ModuleScript', name: 'Util', properties: { Source: 'return { ok = true }\n' } },
      { className: 'Folder', name: 'Nested' },
    ],
  });
}

// --- collectScripts ---------------------------------------------------------

test('collectScripts finds script descendants and skips other classes', () => {
  const scripts = collectScripts(place());
  assert.deepEqual(scripts.map((s) => s.getFullName()).sort(), ['Root.Main', 'Root.Util']);
});

test('collectScripts includes a script root', () => {
  const root = new Instance('Script', 'Lone');
  root.set('Source', 'print(1)\n');
  assert.deepEqual(collectScripts([root]).map((s) => s.name), ['Lone']);
});

// --- scriptGrep -------------------------------------------------------------

test('scriptGrep reports path, line and column', () => {
  const result = scriptGrep(place(), 'print');
  assert.equal(result.matchCount, 2);
  assert.deepEqual(
    result.matches.map((m) => [m.path, m.line, m.column]),
    [
      ['Root.Main', 2, 1],
      ['Root.Main', 3, 1],
    ],
  );
});

test('scriptGrep counts matches in files and scripts separately', () => {
  // One match per matching line, like `grep -n`.
  const result = scriptGrep(place(), 'x');
  assert.equal(result.scriptCount, 2);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].matches, 3);
  assert.equal(result.files[0].lines, 4);
});

test('scriptGrep --fixed treats the pattern literally', () => {
  const result = scriptGrep(place(), 'print(x +', { fixed: true });
  assert.equal(result.matchCount, 1);
  // As a regex, "print(x +" is invalid and must not silently match nothing.
  assert.throws(() => scriptGrep(place(), 'print(x +'), /invalid regular expression/);
});

test('scriptGrep honours a subtree scope', () => {
  const result = scriptGrep(place(), 'return', { path: 'Root.Util' });
  assert.equal(result.matchCount, 1);
  assert.equal(result.scriptCount, 1);
  assert.throws(() => scriptGrep(place(), 'x', { path: 'Root.Nope' }), /path not found/);
});

test('scriptGrep honours ignoreCase and limit', () => {
  assert.equal(scriptGrep(place(), 'PRINT', { ignoreCase: true }).matchCount, 2);
  const limited = scriptGrep(place(), 'print', { limit: 1 });
  assert.equal(limited.matchCount, 2);
  assert.equal(limited.matches.length, 1);
  assert.equal(limited.truncated, true);
  assert.equal(limited.limit, 1);
});

test('scriptGrep rejects an empty pattern', () => {
  assert.throws(() => scriptGrep(place(), ''), /non-empty pattern/);
});

// --- diffModels -------------------------------------------------------------

test('diffModels reports no changes for identical models', () => {
  const result = diffModels(place(), place());
  // Root + Main + Util + Nested.
  assert.deepEqual(result.summary, { added: 0, removed: 0, changed: 0, unchanged: 4 });
});

test('diffModels reports added, removed and changed instances', () => {
  const before = place();
  const after = place();
  after[0].removeChild(after[0].findFirstChild('Nested'));
  after[0].findFirstChild('Util').set('Source', 'return { ok = false }\n');
  after[0].addChild(new Instance('Part', 'Extra'));

  const result = diffModels(before, after);
  // Root and Main survive untouched; Nested is gone, Util changed, Extra is new.
  assert.deepEqual(result.summary, { added: 1, removed: 1, changed: 1, unchanged: 2 });
  assert.equal(result.added[0].path, 'Root.Extra');
  assert.equal(result.removed[0].path, 'Root.Nested');
  assert.equal(result.changed[0].path, 'Root.Util');
  assert.deepEqual(result.changed[0].changes[0], {
    kind: 'property',
    property: 'Source',
    from: 'return { ok = true }\n',
    to: 'return { ok = false }\n',
  });
});

test('diffModels detects a class change on the same path', () => {
  const before = modelFromSpec({ className: 'Folder', name: 'Root', children: [{ className: 'Script', name: 'Thing' }] });
  const after = modelFromSpec({
    className: 'Folder',
    name: 'Root',
    children: [{ className: 'LocalScript', name: 'Thing' }],
  });
  const result = diffModels(before, after);
  assert.equal(result.changed[0].changes[0].kind, 'class');
});

test('diffModels compares instance references by path, not identity', () => {
  const make = () => {
    const model = new Instance('Model', 'M');
    const part = new Instance('Part', 'Primary');
    model.addChild(part);
    model.set('PrimaryPart', part);
    return [model];
  };
  assert.equal(diffModels(make(), make()).summary.changed, 0);
});

// --- applyScriptEdits -------------------------------------------------------

test('applyScriptEdits replaces a whole script with source', () => {
  const roots = place();
  const result = applyScriptEdits(roots, [{ path: 'Root.Util', source: 'return 42\n' }]);
  assert.equal(result.applied, 1);
  assert.equal(result.files[0].mode, 'replace');
  assert.equal(roots[0].findFirstChild('Util').get('Source'), 'return 42\n');
});

test('applyScriptEdits replaces a unique snippet', () => {
  const roots = place();
  const result = applyScriptEdits(roots, [{ path: 'Root.Main', find: 'print(x)', replace: 'warn(x)' }]);
  assert.equal(result.files[0].occurrences, 1);
  assert.equal(roots[0].findFirstChild('Main').get('Source'), 'local x = 1\nwarn(x)\nprint(x + 1)\n');
});

test('applyScriptEdits refuses an ambiguous snippet unless all is set', () => {
  const roots = place();
  const ambiguous = applyScriptEdits(roots, [{ path: 'Root.Main', find: 'print(', replace: 'warn(' }]);
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.diagnostics[0].code, 'ambiguous-edit');
  assert.equal(ambiguous.applied, 0);

  const all = applyScriptEdits(roots, [{ path: 'Root.Main', find: 'print(', replace: 'warn(', all: true }]);
  assert.equal(all.files[0].occurrences, 2);
});

test('applyScriptEdits suggests the closest path on a typo', () => {
  const result = applyScriptEdits(place(), [{ path: 'Root.Mian', source: 'x' }]);
  assert.equal(result.diagnostics[0].code, 'path-not-found');
  assert.equal(result.diagnostics[0].suggestion, 'Root.Main');
});

test('applyScriptEdits refuses an instance that is not a script', () => {
  const result = applyScriptEdits(place(), [{ path: 'Root.Nested', source: 'x' }]);
  assert.equal(result.diagnostics[0].code, 'not-a-script');
  assert.match(result.diagnostics[0].message, /Folder has no Source/);
});

test('applyScriptEdits applies nothing when any edit is invalid', () => {
  const roots = place();
  const before = roots[0].findFirstChild('Main').get('Source');
  const result = applyScriptEdits(roots, [
    { path: 'Root.Main', find: 'local x = 1', replace: 'local y = 1' },
    { path: 'Root.Missing', source: 'x' },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.applied, 0);
  assert.equal(roots[0].findFirstChild('Main').get('Source'), before, 'no partial application');
});

test('applyScriptEdits reports all bad edits together', () => {
  const result = applyScriptEdits(place(), [
    { path: 'Root.Nope', source: 'x' },
    { path: 'Root.Main', find: 'not-in-there', replace: 'x' },
    { path: 'Root.Util' },
  ]);
  assert.deepEqual(result.diagnostics.map((d) => d.code), ['path-not-found', 'no-match', 'invalid-edit']);
});

test('applyScriptEdits with force applies the valid edits and reports the rest', () => {
  const roots = place();
  const result = applyScriptEdits(
    roots,
    [
      { path: 'Root.Util', source: 'return 2\n' },
      { path: 'Root.Nope', source: 'x' },
    ],
    { force: true },
  );
  assert.equal(result.applied, 1);
  assert.equal(result.ok, false);
  assert.equal(roots[0].findFirstChild('Util').get('Source'), 'return 2\n');
});

test('applyScriptEdits rejects an empty or malformed edit list', () => {
  assert.throws(() => applyScriptEdits(place(), []), /non-empty array/);
  const result = applyScriptEdits(place(), [{ source: 'x' }]);
  assert.equal(result.diagnostics[0].code, 'invalid-edit');
  assert.match(result.diagnostics[0].message, /missing "path"/);
});
