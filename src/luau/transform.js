// The transformation passes behind `studio deobfuscate`.
//
// Every pass here has one obligation: it may not change what the program does.
// Where a transformation cannot be shown to be safe under a stated rule, it is
// not done, and the reason is recorded. The rules are in the header of
// deobfuscate.js; this file implements them.
//
// Passes run to a fixed point because they feed each other. Inlining a local
// exposes a foldable expression; folding a condition exposes a dead branch;
// removing a dead branch exposes an unused declaration. Each round re-analyses
// scope, because replacing a node invalidates the binding information attached
// to the previous tree.

import { evaluateConstant } from './deobfuscate.js';
import { parse } from './parse.js';

/**
 * Fields that live on AST nodes but are not part of the tree: positions, and
 * the binding information the analyser attaches, which contains back-references
 * (`binding.reads` holds the very nodes that read it) and would make any naive
 * walk recurse forever.
 */
const SKIP = new Set([
  'type', 'line', 'col', 'raw', 'binding', 'scope', 'declarations', 'reads', 'writes',
  '__parent', '__root', 'folded', 'inlinedFrom', 'global',
]);

/** Replace `node` with a literal node for `constant`, or return null. */
function literal(constant) {
  if (!constant) return null;
  switch (constant.kind) {
    case 'nil':
      return { type: 'Nil' };
    case 'bool':
      return { type: 'Bool', value: constant.value };
    case 'number':
      return Number.isFinite(constant.value) ? { type: 'Number', value: constant.value, raw: null } : null;
    case 'string':
      return { type: 'Str', value: constant.value, raw: null };
    default:
      return null;
  }
}

/** A structural copy, so the same source node is not shared between use sites. */
function cloneNode(node) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(cloneNode);
  const out = {};
  for (const key of Object.keys(node)) {
    // `type` must survive the copy. Dropping it here is how a table ended up
    // inlined into a node that still claimed to be a name, which printed as the
    // literal text `undefined` — caught by the re-parse check, which is exactly
    // what that check is for.
    if (SKIP.has(key) && key !== 'type') continue;
    out[key] = cloneNode(node[key]);
  }
  return out;
}

/** Would replacing this node with `constant` change anything visible? */
function alreadyIs(node, constant) {
  if (node.type === 'Str') return constant.kind === 'string' && node.value === constant.value;
  if (node.type === 'Number') return constant.kind === 'number' && node.value === constant.value;
  if (node.type === 'Bool') return constant.kind === 'bool' && node.value === constant.value;
  if (node.type === 'Nil') return constant.kind === 'nil';
  return false;
}

// ---------------------------------------------------------------------------
// Folding
// ---------------------------------------------------------------------------

/**
 * Fold every sub-expression that evaluates to a constant.
 *
 * Bottom-up, and rewriting in place: children are folded first, so
 * `("a" .. "b") .. "c"` folds to `"a" .. "c"` and then to `"abc"` in one walk.
 *
 * @returns {number} how many nodes were replaced
 */
export function foldTree(node, stats) {
  if (!node || typeof node !== 'object') return 0;
  let count = 0;

  // Children first.
  for (const key of Object.keys(node)) {
    if (SKIP.has(key)) continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) count += foldTree(child, stats);
    } else if (value && typeof value === 'object') {
      count += foldTree(value, stats);
    }
  }

  // A statement's fields are walked as expressions above; the node itself is
  // only foldable if it is an expression.
  if (!/^[A-Z]/.test(node.type) || node.type.endsWith('Stat')) return count;

  const constant = evaluateConstant(node);
  if (!constant) return count;
  if (alreadyIs(node, constant)) return count;
  const replacement = literal(constant);
  if (!replacement) return count;

  // Keep the position so a later report can still point at the source line.
  replacement.line = node.line;
  replacement.col = node.col;
  replacement.folded = true;

  // Replace this node's contents in place: the parent holds a reference, so
  // mutating the object keeps the tree consistent.
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'line' || key === 'col') continue;
    delete node[key];
  }
  Object.assign(node, replacement);
  if (stats) stats.folded += 1;
  return count + 1;
}

// ---------------------------------------------------------------------------
// Constant propagation
// ---------------------------------------------------------------------------

/**
 * Decide whether a binding can be replaced by its initialiser everywhere.
 *
 * The rules, and why each one is needed:
 *
 *  - `local` only. Parameters and loop variables are assigned by the runtime,
 *    never by the source, so there is no initialiser to inline.
 *  - never written after declaration. A later `x = 2` would make the inlined
 *    value wrong for everything after it.
 *  - never captured by a nested function. A closure can be called at any time,
 *    can see the variable after the program has moved on, and can mutate what
 *    it points at.
 *  - the initialiser must be a constant (string, number, boolean, nil) or a
 *    table of constants, so replacing it cannot reorder or duplicate work.
 */
function inlineable(binding) {
  if (binding.kind !== 'local') return false;
  if (!binding.singleAssignment) return false;
  if (binding.captured) return false;
  if (binding.readCount === 0) return false;
  const init = binding.init;
  if (!init) return false;
  const constant = evaluateConstant(init);
  if (!constant) return false;
  if (constant.kind === 'table') {
    // A table literal copied into every use site changes identity. It is only
    // safe when the table is a read-only array that is never compared, never
    // passed anywhere, and never grows — which is exactly the string-table
    // case, so that is the only case allowed: every use is a constant index or
    // a length.
    return binding.reads.every(isConstantIndexOrLength);
  }
  return true;
}

function isConstantIndexOrLength(node) {
  const parent = node.__parent;
  if (!parent) return false;
  if (parent.type === 'Un' && parent.op === '#') return true;
  if (parent.type === 'Index' && parent.obj === node && parent.keyIsName) return true;
  if (parent.type === 'Index' && parent.obj === node) {
    const constant = evaluateConstant(parent.key);
    return constant !== null && (constant.kind === 'number' || constant.kind === 'string');
  }
  return false;
}

/** Tag every node with its parent, so a use site can be examined in context. */
function linkParents(node, parent = null) {
  if (!node || typeof node !== 'object') return;
  node.__parent = parent;
  for (const key of Object.keys(node)) {
    if (SKIP.has(key)) continue;
    const value = node[key];
    if (Array.isArray(value)) value.forEach((v) => linkParents(v, node));
    else if (value && typeof value === 'object') linkParents(value, node);
  }
}

function unlinkParents(node) {
  if (!node || typeof node !== 'object') return;
  delete node.__parent;
  for (const key of Object.keys(node)) {
    if (SKIP.has(key)) continue;
    const value = node[key];
    if (Array.isArray(value)) value.forEach(unlinkParents);
    else if (value && typeof value === 'object') unlinkParents(value);
  }
}

/**
 * Replace reads of inlineable locals with their values.
 *
 * @returns {number} how many reads were replaced
 */
export function inlineConstants(ast, bindings, stats, report) {
  linkParents(ast);
  let replaced = 0;
  for (const binding of bindings) {
    if (!inlineable(binding)) {
      if (binding.kind === 'local' && binding.readCount > 0 && binding.captured && stats) {
        stats.skippedCaptured += 1;
      }
      continue;
    }
    const constant = evaluateConstant(binding.init);
    if (!constant) continue;

    // A scalar becomes a literal node. A table keeps the table node itself,
    // which is safe here and only here: `inlineable` has already established
    // that every use is a constant index or a `#`, so the table is never passed
    // anywhere, never compared, and never grown. Splicing it lets the very next
    // fold turn `t[1 + 1]` into the element.
    const scalar = literal(constant);
    const replacement = scalar || (constant.kind === 'table' ? cloneNode(binding.init) : null);
    if (!replacement) continue;
    for (const read of binding.reads) {
      for (const key of Object.keys(read)) {
        if (key === 'type' || key === 'line' || key === 'col') continue;
        delete read[key];
      }
      Object.assign(read, {
        ...replacement,
        line: read.line,
        col: read.col,
        inlinedFrom: binding.name,
      });
      replaced += 1;
      if (stats) stats.inlined += 1;
      if (report && !report.inlinedNames.includes(binding.name)) report.inlinedNames.push(binding.name);
    }
  }
  unlinkParents(ast);
  return replaced;
}

// ---------------------------------------------------------------------------
// Statement simplification
// ---------------------------------------------------------------------------

/** Break or continue that would attach to the loop being replaced. */
function hasBoundJump(body) {
  let found = false;
  const visit = (stat) => {
    if (found || !stat || typeof stat !== 'object') return;
    if (stat.type === 'BreakStat' || stat.type === 'ContinueStat') {
      found = true;
      return;
    }
    if (stat.type === 'FunctionExpr') return; // a jump inside cannot escape it
    if (stat.type === 'WhileStat' || stat.type === 'NumericFor' || stat.type === 'GenericFor' || stat.type === 'RepeatStat') {
      return; // but a jump inside an inner loop belongs to that loop
    }
    for (const key of Object.keys(stat)) {
      if (SKIP.has(key)) continue;
      const value = stat[key];
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  body.forEach(visit);
  return found;
}

/** True when a statement array contains `return` outside a nested function. */
function hasReturn(body) {
  let found = false;
  const visit = (stat) => {
    if (found || !stat || typeof stat !== 'object') return;
    if (stat.type === 'ReturnStat') {
      found = true;
      return;
    }
    if (stat.type === 'FunctionExpr') return;
    for (const key of Object.keys(stat)) {
      if (SKIP.has(key)) continue;
      const value = stat[key];
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  body.forEach(visit);
  return found;
}

/** Rewrite one block, possibly expanding a statement into several. */
function simplifyBlock(body, stats, report, locals = null) {
  const out = [];
  for (const stat of body) {
    simplifyNested(stat, stats, report, locals);
    const expansion = simplifyStatement(stat, stats, report, locals);
    if (expansion === null) continue; // removed
    out.push(...expansion);
  }
  return out;
}

function simplifyNested(stat, stats, report, locals) {
  if (!stat || typeof stat !== 'object') return;
  switch (stat.type) {
    case 'IfStat':
      for (const clause of stat.clauses) clause.body = simplifyBlock(clause.body, stats, report, locals);
      if (stat.elseBody) stat.elseBody = simplifyBlock(stat.elseBody, stats, report, locals);
      return;
    case 'WhileStat':
    case 'RepeatStat':
    case 'NumericFor':
    case 'GenericFor':
    case 'DoStat':
      stat.body = simplifyBlock(stat.body, stats, report, locals);
      return;
    case 'LocalFunction':
    case 'FunctionStat':
      stat.func.body = simplifyBlock(stat.func.body, stats, report, locals);
      return;
    case 'AssignStat':
      for (const expr of stat.exprs) {
        if (expr && expr.type === 'FunctionExpr') expr.body = simplifyBlock(expr.body, stats, report, locals);
      }
      return;
    default:
      return;
  }
}

/**
 * Simplify one statement.
 *
 * @returns {Array<object>|null} the replacement statements, or null to drop it
 */
function simplifyStatement(stat, stats, report, locals) {
  switch (stat.type) {
    case 'IfStat': {
      const clauses = [];
      for (const clause of stat.clauses) {
        const value = evaluateConstant(clause.cond);
        if (value && value.kind === 'bool' && value.value === false) {
          // A false condition is a constant, so nothing was evaluated and the
          // whole clause can go.
          stats.deadBranches += 1;
          continue;
        }
        if (value && value.kind === 'bool' && value.value === true) {
          // This branch always runs and the rest never do.
          if (clauses.length === 0) {
            stats.liveBranches += 1;
            return clause.body.map((s) => ({ ...s }));
          }
          break;
        }
        clauses.push(clause);
      }
      if (clauses.length === 0) return stat.elseBody ? stat.elseBody : null;
      if (clauses.length === 1 && !stat.elseBody) return [clauses[0].body.length ? { ...stat, clauses } : null].filter(Boolean);
      if (clauses.length === 1 && stat.elseBody && stat.elseBody.length === 0) {
        stat.clauses = clauses;
        delete stat.elseBody;
        return [stat];
      }
      stat.clauses = clauses;
      return [stat];
    }

    case 'WhileStat': {
      const value = evaluateConstant(stat.cond);
      if (value && value.kind === 'bool' && value.value === false) {
        stats.deadLoops += 1;
        return null;
      }
      if (value && value.kind === 'bool' && value.value === true && !hasBoundJump(stat.body)) {
        // `while true do B end` with no break or continue bound to it runs B
        // once and then loops forever; replacing it with B is the same program
        // for any B that terminates, and the same non-termination for one that
        // does not. A `return` inside is fine — it still returns from the same
        // function at the same point.
        stats.unwrappedLoops += 1;
        return stat.body.map((s) => ({ ...s }));
      }
      return [stat];
    }

    case 'RepeatStat': {
      const value = evaluateConstant(stat.cond);
      if (value && truthyConstant(value) && !hasBoundJump(stat.body)) {
        stats.unwrappedLoops += 1;
        return stat.body.map((s) => ({ ...s }));
      }
      return [stat];
    }

    case 'NumericFor': {
      const lo = evaluateConstant(stat.from);
      const hi = evaluateConstant(stat.to);
      const step = stat.step ? evaluateConstant(stat.step) : { kind: 'number', value: 1 };
      if (
        lo && hi && step &&
        lo.kind === 'number' && hi.kind === 'number' && step.kind === 'number' &&
        step.value !== 0
      ) {
        const runs =
          step.value > 0 ? lo.value <= hi.value : lo.value >= hi.value;
        if (!runs && !hasBoundJump(stat.body)) {
          stats.deadLoops += 1;
          return null;
        }
      }
      return [stat];
    }

    case 'CallStat': {
      const inlined = tryInlineLoadstring(stat, stats, report, locals);
      if (inlined) return inlined;
      return [stat];
    }

    default:
      return [stat];
  }
}

function truthyConstant(constant) {
  if (constant.kind === 'nil') return false;
  if (constant.kind === 'bool') return constant.value;
  return true;
}

/**
 * Inline `loadstring(<constant>)(...)`, the commonest way an obfuscator hides
 * code that is already fully present in the file.
 *
 * The one hazard is scope: a chunk compiled by `loadstring` runs with the
 * globals of the environment and *does not see* the locals of the function it
 * was called from. Splicing its statements into that function would let an
 * outer local of the same name be picked up by accident, silently changing
 * which variable the code reads. So the inline only happens when no global the
 * chunk reads is shadowed by a local in scope at the call site.
 */
function tryInlineLoadstring(stat, stats, report, locals) {
  const call = stat.call;
  if (!call || call.type !== 'Call') return null;

  const inner = unwrapParen(call.func);
  if (!inner || inner.type !== 'Call') return null;
  const target = unwrapParen(inner.func);
  if (!target || target.type !== 'Name' || target.name !== 'loadstring') return null;
  if (inner.args.length !== 1) return null;

  const source = evaluateConstant(inner.args[0]);
  if (!source || source.kind !== 'string') return null;

  let parsed;
  try {
    parsed = parse(source.value);
  } catch (err) {
    report.warnings.push({
      code: 'loadstring-unparsed',
      message: `a loadstring argument could not be parsed (${err.message}); left as-is`,
    });
    return null;
  }

  // Only inline when the chunk's globals would not resolve to an outer local.
  //
  // The check is deliberately over-broad: it refuses if the chunk reads a name
  // that is a local *anywhere* in the file, not just one visible at this point.
  // Tracking exact visibility would need a scope chain threaded through every
  // statement; being too strict only means a loadstring is left alone, while
  // being too loose would silently redirect a read.
  const chunkGlobals = collectGlobalReads(parsed.body);
  const shadowed = locals ? [...chunkGlobals].filter((name) => locals.has(name)) : [];
  if (shadowed.length > 0) {
    report.warnings.push({
      code: 'loadstring-shadowed',
      message:
        `a loadstring chunk reads ${shadowed.join(', ')}, which is a local where it is called; ` +
        'inlining would change which variable it reads, so it was left as-is',
    });
    return null;
  }

  stats.loadstringsInlined += 1;
  report.loadstrings.push({ line: stat.line, statements: parsed.body.length });
  return parsed.body;
}

function unwrapParen(node) {
  let current = node;
  while (current && current.type === 'Paren') current = current.expr;
  return current;
}

/** Global names a block reads (anything not declared within it). */
function collectGlobalReads(body) {
  const declared = new Set();
  const reads = new Set();

  const collectDecls = (stat) => {
    if (!stat || typeof stat !== 'object') return;
    if (stat.type === 'LocalStat') for (const n of stat.names) declared.add(n.name);
    if (stat.type === 'LocalFunction') declared.add(stat.name.name);
    if (stat.type === 'NumericFor') declared.add(stat.name.name);
    if (stat.type === 'GenericFor') for (const n of stat.names) declared.add(n.name);
    if (stat.type === 'FunctionExpr') {
      for (const p of stat.params) declared.add(p.name);
      stat.body.forEach(collectDecls);
      return;
    }
    for (const key of Object.keys(stat)) {
      if (SKIP.has(key)) continue;
      const value = stat[key];
      if (Array.isArray(value)) value.forEach(collectDecls);
      else if (value && typeof value === 'object') collectDecls(value);
    }
  };
  body.forEach(collectDecls);

  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Name' && !declared.has(node.name)) reads.add(node.name);
    for (const key of Object.keys(node)) {
      if (SKIP.has(key)) continue;
      const value = node[key];
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  body.forEach(visit);
  return reads;
}

/**
 * Drop declarations that nothing reads any more.
 *
 * Only when every initialiser is pure: a literal, or a function body (defining
 * a function has no effects either). Removing `local x = f()` would remove the
 * call, so it never happens.
 */
function dropDeadDeclarations(body, stats) {
  return body.filter((stat) => {
    if (stat.type === 'LocalStat') {
      const pure = stat.exprs.every(
        (e) => evaluateConstant(e) !== null || e.type === 'FunctionExpr',
      );
      if (!pure) return true;
      const allUnread = stat.names.every((n) => n.binding && n.binding.readCount === 0);
      if (allUnread) {
        stats.deadDeclarations += 1;
        return false;
      }
      return true;
    }
    if (stat.type === 'LocalFunction') {
      if (stat.name.binding && stat.name.binding.readCount === 0 && !stat.name.binding.captured) {
        stats.deadDeclarations += 1;
        return false;
      }
      return true;
    }
    return true;
  });
}

/**
 * Every name declared as a local anywhere in the program.
 *
 * Used by the loadstring inline as its shadowing check: if a chunk reads a name
 * that is a local anywhere, the inline is refused.
 */
export function localNames(ast) {
  const names = new Set();
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'LocalStat') for (const n of node.names) names.add(n.name);
    if (node.type === 'LocalFunction') names.add(node.name.name);
    if (node.type === 'NumericFor') names.add(node.name.name);
    if (node.type === 'GenericFor') for (const n of node.names) names.add(n.name);
    if (node.type === 'FunctionExpr') for (const p of node.params) names.add(p.name);
    for (const key of Object.keys(node)) {
      if (SKIP.has(key)) continue;
      const value = node[key];
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  ast.body.forEach(visit);
  return names;
}

export { simplifyBlock, dropDeadDeclarations, hasReturn };
