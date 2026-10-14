// Sourcemaps: the file that tells tooling which source file backs which
// instance.
//
// Rojo emits `sourcemap.json` and it has become the de-facto contract for Luau
// tooling — language servers read it to turn `require(script.Parent.Foo)` into a
// path on disk, and so does anything else that needs to connect a line of code
// to the instance tree it runs in. Any project aiming at "the gold standard for
// agents" has to speak it, because an agent that cannot resolve a require cannot
// safely edit one.
//
// The shape is Rojo's:
//
//   { "name": "Game", "className": "DataModel", "filePaths": ["default.project.json"],
//     "children": [ { "name": "ReplicatedStorage", "className": "ReplicatedStorage",
//                     "filePaths": [], "children": [...] } ] }
//
// with two additions, both additive so an existing consumer ignores them:
//
//   * `instancePath`  — the full `game.`-rooted path, which is what a runtime
//     error prints, so an error message can be traced to a file.
//   * `scriptFile`    — the exact script file when it differs from `filePaths`
//     (a directory holding `init.luau` is one instance backed by two paths).
//   * `sourceHash`    — model-based maps only: a hash of the script source, so a
//     script inside a built place can be matched to a file on disk without
//     opening either.
//
// The project-based map is generated *by the build walk itself*
// (`buildFromProject({ sources })`), not by a second reading of the project
// file. Two implementations of Rojo's path rules would eventually disagree, and
// a sourcemap that disagrees with the build is worse than no sourcemap: it
// points tooling at the wrong file with no indication anything is wrong.

import path from 'node:path';
import crypto from 'node:crypto';
import { buildFromProject } from '../backends/local/index.js';

/** Rojo writes forward slashes even on Windows, and so do we. */
function toPosix(p) {
  return String(p).split(path.sep).join('/');
}

/** True for the classes that hold source: Script, LocalScript, ModuleScript. */
function isScript(inst) {
  try {
    return inst.isA('LuaSourceContainer');
  } catch {
    return false;
  }
}

/**
 * Drop everything that is neither a script nor an ancestor of one.
 *
 * A map with the full tree in it is noise for the tooling that reads it — what
 * a language server needs is the chain from a script up to `game`, because that
 * is the chain `require(script.Parent.X)` walks.
 */
function pruneToScripts(nodes) {
  const kept = [];
  for (const node of nodes) {
    const children = node.children ? pruneToScripts(node.children) : [];
    if (node.isScript || children.length > 0) {
      kept.push(children.length > 0 ? { ...node, children } : { ...node, children: [] });
    }
  }
  return kept;
}

/** Drop the internal bookkeeping once pruning is done. */
function strip(nodes) {
  return nodes.map(({ isScript, ...node }) => ({
    ...node,
    ...(node.children ? { children: strip(node.children) } : {}),
  }));
}

/**
 * A sourcemap for a Rojo project.
 *
 * Paths are relative to the project file, which is where they are resolved
 * from. Warnings from the build (files that map to no instance, orphaned meta
 * files) are passed through rather than swallowed: a sourcemap built over a
 * project with a problem inherits that problem.
 */
export function sourceMapFromProject(projectPath, { includeNonScripts = false } = {}) {
  const abs = path.resolve(projectPath);
  const baseDir = path.dirname(abs);
  const sources = new Map();
  const { roots, projectName, warnings } = buildFromProject(abs, { sources });

  const relative = (absPath) => toPosix(path.relative(baseDir, absPath));

  const nodeFor = (inst) => {
    const record = sources.get(inst);
    const is = isScript(inst);
    const node = {
      name: inst.name,
      className: inst.className,
      filePaths: record ? record.filePaths.map(relative) : [],
      instancePath: `game.${inst.getFullName()}`,
      isScript: is,
      children: inst.children.map(nodeFor),
    };
    if (record && record.scriptFile) {
      const scriptFile = relative(record.scriptFile);
      // Only worth saying when it is not already the single filePath.
      if (!(node.filePaths.length === 1 && node.filePaths[0] === scriptFile)) {
        node.scriptFile = scriptFile;
      }
    }
    return node;
  };

  const tree = roots.map(nodeFor);
  const map = {
    name: projectName || path.basename(baseDir),
    className: 'DataModel',
    filePaths: [toPosix(path.relative(baseDir, abs))],
    // The DataModel has no instance behind it, but `game` is the path every
    // other node hangs off, so it is stated for consistency.
    instancePath: 'game',
    children: includeNonScripts ? strip(tree) : strip(pruneToScripts(tree)),
  };
  return { sourcemap: map, warnings, baseDir };
}

/**
 * A sourcemap for a place that already exists, with or without its sources on
 * disk.
 *
 * This is the case Rojo does not cover at all: you were handed a `.rbxl`, there
 * is no project anywhere, and you still need to know what is inside it and which
 * script is which. `filePaths` is empty — nothing on disk produced these
 * instances — and each script carries a `sourceHash` so it can be matched
 * against a file by content.
 */
export function sourceMapFromModel(roots, { includeNonScripts = false, name = 'Game' } = {}) {
  const list = Array.isArray(roots) ? roots : [roots];
  const nodeFor = (inst) => {
    const is = isScript(inst);
    const node = {
      name: inst.name,
      className: inst.className,
      filePaths: [],
      instancePath: `game.${inst.getFullName()}`,
      isScript: is,
      children: inst.children.map(nodeFor),
    };
    if (is) {
      const source = inst.get('Source');
      if (typeof source === 'string') {
        node.sourceHash = crypto.createHash('sha256').update(source, 'utf8').digest('hex').slice(0, 32);
        node.sourceLines = source.split('\n').length;
      }
    }
    return node;
  };

  const tree = list.map(nodeFor);
  return {
    sourcemap: {
      name,
      className: 'DataModel',
      filePaths: [],
      instancePath: 'game',
      children: includeNonScripts ? strip(tree) : strip(pruneToScripts(tree)),
    },
    warnings: [],
  };
}

/** Count every node in a sourcemap, for reporting. */
export function countNodes(node) {
  let total = 1;
  for (const child of node.children || []) total += countNodes(child);
  return total;
}
