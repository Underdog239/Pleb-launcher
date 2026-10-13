// The require graph of a place.
//
// `require` is how a Roblox project wires itself together, and a broken one is
// invisible until the game runs. Given a model file, every static require chain
// can be resolved against the real instance tree, which makes three whole
// classes of bug checkable before anything executes:
//
//   * a require that points at something that does not exist;
//   * a require that points at something that is not a ModuleScript;
//   * a cycle, which Roblox reports as a stack overflow at load time.
//
// Only chains that are fully static are resolved. A computed argument
// (`require(modules[i])`) is reported as dynamic rather than guessed at.

import { codeTokens } from './lexer.js';
import { Instance } from '../rbx/instance.js';
import { closestName } from '../rbx/validate.js';

/** A DataModel-shaped view over the model's root instances. */
class RootView {
  constructor(roots) {
    this.roots = roots;
    this.className = 'DataModel';
    this.name = 'game';
    this.isRoot = true;
  }
  findChild(name) {
    return this.roots.find((r) => r.name === name) || null;
  }
}

/**
 * Resolve one chain step.
 *
 * A finder call with a literal argument (`:FindFirstChild("Util")`,
 * `:FindFirstChildWhichIsA("ModuleScript")`) is a real, checkable lookup — but
 * only the ones whose semantics we actually model. Anything else returns
 * `undefined` so the caller reports "dynamic" instead of a made-up name.
 */
function findChildByMethod(inst, part) {
  if (part.arg === undefined) {
    return inst.findFirstChild ? inst.findFirstChild(part.name) : inst.findChild(part.name);
  }
  const children = inst.isRoot ? inst.roots : inst.children;
  // Each finder is modelled exactly, and separately: matching a class name when
  // the caller asked for a *name* would be a wrong resolution presented as a
  // right one.
  switch (part.name) {
    case 'FindFirstChild':
    case 'WaitForChild':
      return children.find((c) => c.name === part.arg) || null;
    case 'FindFirstChildOfClass':
      return children.find((c) => c.className === part.arg) || null;
    case 'FindFirstChildWhichIsA':
      return children.find((c) => typeof c.isA === 'function' && c.isA(part.arg)) || null;
    default:
      return undefined;
  }
}

/** How a failed lookup should read in a diagnostic. */
function describeLookup(part) {
  return part.arg === undefined ? part.name : `${part.name}("${part.arg}")`;
}

function childNamed(inst, name) {
  if (!inst) return null;
  if (inst.isRoot) return inst.findChild(name);
  return inst.findFirstChild(name) || null;
}

/** Read a call's argument list as a static chain, or report it as dynamic. */
function readStaticChain(tokens, openParenIndex) {
  // tokens[openParenIndex] === '('
  const start = openParenIndex + 1;
  const first = tokens[start];
  if (!first || (first.type !== 'ident' && first.type !== 'keyword')) return { dynamic: true };

  const parts = [{ name: first.value, token: first }];
  let i = start + 1;

  for (let guard = 0; guard < 16; guard++) {
    const t = tokens[i];
    if (!t) return { dynamic: true };
    if (t.type === 'op' && t.value === ')') return { parts, end: i, closeFound: true };

    if (t.type === 'op' && (t.value === '.' || t.value === ':')) {
      const nameTok = tokens[i + 1];
      if (!nameTok || (nameTok.type !== 'ident' && nameTok.type !== 'keyword')) return { dynamic: true };
      if (t.value === ':') {
        const open = tokens[i + 2];
        if (open?.value !== '(') return { dynamic: true };
        const arg = tokens[i + 3];
        if (arg?.type === 'string' && tokens[i + 4]?.value === ')') {
          parts.push({ name: nameTok.value, arg: arg.value, token: nameTok });
          i += 5;
          continue;
        }
        // `:FindFirstChild()` with no literal, or a computed name.
        return { dynamic: true };
      }
      parts.push({ name: nameTok.value, token: nameTok });
      i += 2;
      continue;
    }
    return { dynamic: true };
  }
  return { dynamic: true };
}

/**
 * Resolve a chain against the tree.
 *
 * @returns {{kind:'resolved', instance: Instance}|{kind:'missing', missingAt: string, parent: any, name: string}|{kind:'dynamic'}}
 */
export function resolveChain(parts, { root, scriptInst }) {
  const head = parts[0].name;
  let current;
  if (head === 'game') current = root;
  else if (head === 'script') current = scriptInst;
  else return { kind: 'dynamic' }; // a local alias we do not track

  for (const part of parts.slice(1)) {
    if (part.name === 'Parent' && part.arg === undefined) {
      if (current instanceof Instance) current = current.parent;
      else return { kind: 'dynamic' };
      continue;
    }
    if (current === null) {
      // Walked off the top of the tree.
      return { kind: 'missing', parent: null, name: part.name };
    }
    if (current?.isRoot) {
      const next = findChildByMethod(current, part);
      if (next === undefined) return { kind: 'dynamic' }; // unknown method
      if (!next) return { kind: 'missing', parent: current, name: describeLookup(part) };
      current = next;
      continue;
    }
    if (current instanceof Instance) {
      const next = findChildByMethod(current, part);
      if (next === undefined) return { kind: 'dynamic' };
      if (!next) return { kind: 'missing', parent: current, name: describeLookup(part) };
      current = next;
      continue;
    }
    return { kind: 'dynamic' };
  }

  if (current && current !== root && !(current instanceof Instance)) return { kind: 'dynamic' };
  if (current === root) return { kind: 'dynamic' }; // `require(game)` is not a module
  return { kind: 'resolved', instance: current };
}

/** Every `require(...)` call site in a token stream. */
export function findRequires(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'ident' || t.value !== 'require') continue;
    const prev = tokens[i - 1];
    if (prev && prev.type === 'op' && (prev.value === '.' || prev.value === ':')) continue;
    const open = tokens[i + 1];
    if (!open || open.value !== '(') continue;
    out.push({ index: i, openIndex: i + 1, token: t });
  }
  return out;
}

/**
 * Build the require graph for a set of scripts.
 *
 * @param {{inst: Instance, path: string, className: string, source: string}[]} scripts
 * @param {Instance[]} roots
 */
export function buildRequireGraph(scripts, roots) {
  const root = new RootView(roots);
  const nodes = new Map(); // path -> {path, className, requires: [...]}
  const diagnostics = [];
  const edges = [];

  for (const script of scripts) {
    const { tokens } = codeTokens(script.source);
    const node = { path: script.path, className: script.className, requires: [] };
    nodes.set(script.path, node);

    for (const call of findRequires(tokens)) {
      const chain = readStaticChain(tokens, call.openIndex);
      const where = { file: script.path, line: call.token.line, col: call.token.col };

      if (chain.dynamic || !chain.parts) {
        diagnostics.push({
          severity: 'info',
          code: 'dynamic-require',
          message: `require(...) at ${script.path}:${call.token.line} is not a static path; not checked`,
          ...where,
        });
        continue;
      }

      const resolved = resolveChain(chain.parts, { root, scriptInst: script.inst });
      const sourceText = renderChain(chain.parts);

      if (resolved.kind === 'dynamic') {
        diagnostics.push({
          severity: 'info',
          code: 'dynamic-require',
          message: `require(${sourceText}) at ${script.path}:${call.token.line} starts at an alias; not checked`,
          ...where,
        });
        node.requires.push({ to: null, kind: 'dynamic', source: sourceText, line: call.token.line });
        continue;
      }

      if (resolved.kind === 'missing') {
        const parentPath = pathOf(resolved.parent, root);
        const suggestion = suggestChild(resolved.parent, resolved.name);
        diagnostics.push({
          severity: 'error',
          code: 'require-not-found',
          message: `require(${sourceText}): ${resolved.name} was not found`,
          ...where,
          actual: resolved.name,
          ...(parentPath ? { path: parentPath } : {}),
          ...(suggestion ? { suggestion } : {}),
          hint: 'the required instance must exist in this place at load time',
        });
        node.requires.push({ to: null, kind: 'missing', source: sourceText, line: call.token.line });
        continue;
      }

      const target = resolved.instance;
      const targetPath = target.getFullName();
      const link = { to: targetPath, kind: 'resolved', source: sourceText, line: call.token.line };
      node.requires.push(link);
      edges.push({ from: script.path, to: targetPath });

      if (!target.isA('ModuleScript')) {
        diagnostics.push({
          severity: 'error',
          code: 'require-not-module',
          message: `require(${sourceText}): ${targetPath} is a ${target.className}, not a ModuleScript`,
          ...where,
          actual: target.className,
          path: targetPath,
          suggestion: 'ModuleScript',
        });
      }
    }
  }

  const cycles = findCycles(nodes);
  for (const cycle of cycles) {
    // Point at the require call that closes the loop, so the line means something.
    const from = cycle[cycle.length - 2];
    const to = cycle[cycle.length - 1];
    const edge = nodes.get(from)?.requires.find((r) => r.to === to);
    diagnostics.push({
      severity: 'error',
      code: 'require-cycle',
      message: `require cycle: ${cycle.join(' -> ')}`,
      file: cycle[0],
      line: edge ? edge.line : null,
      path: cycle[0],
      hint: 'Roblox raises a stack overflow when this loads',
    });
  }

  diagnostics.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  return {
    nodes: [...nodes.values()],
    edges,
    cycles,
    scriptCount: scripts.length,
    diagnostics,
  };
}

function pathOf(inst, root) {
  if (!inst) return null;
  if (inst === root || inst.isRoot) return 'game';
  return inst.getFullName();
}

function suggestChild(parent, name) {
  if (!parent) return null;
  const children = parent.isRoot ? parent.roots : parent.children;
  if (!children) return null;
  const names = children.map((c) => c.name);
  return closestName(name, names);
}

function renderChain(parts) {
  let out = parts[0].name;
  for (const part of parts.slice(1)) {
    out += part.arg !== undefined ? `:${part.name}("${part.arg}")` : `.${part.name}`;
  }
  return out;
}

/** Tarjan-free cycle search: small graphs, clarity wins over asymptotics. */
function findCycles(nodes) {
  const cycles = [];
  const seen = new Set();

  for (const start of nodes.keys()) {
    const stack = [];
    const onPath = new Set();

    const visit = (path) => {
      if (onPath.has(path)) {
        const at = stack.indexOf(path);
        const cycle = [...stack.slice(at), path];
        // A cycle reached from a different starting point is the same cycle:
        // dedupe on the set of members, not on the order it was walked in.
        const key = [...new Set(cycle)].sort().join('|');
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(cycle);
        }
        return;
      }
      const node = nodes.get(path);
      if (!node) return;
      stack.push(path);
      onPath.add(path);
      for (const req of node.requires) {
        if (req.to) visit(req.to);
      }
      onPath.delete(path);
      stack.pop();
    };

    visit(start);
  }
  return cycles;
}

/** Collect every script in a model, with its path and source. */
export function scriptsInModel(roots) {
  const out = [];
  const visit = (inst) => {
    if (inst.isA('LuaSourceContainer') && typeof inst.get('Source') === 'string') {
      out.push({
        inst,
        path: inst.getFullName(),
        className: inst.className,
        source: inst.get('Source'),
      });
    }
    for (const child of inst.children) visit(child);
  };
  for (const r of roots) visit(r);
  return out;
}

export { RootView };
