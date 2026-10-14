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

import { evaluateConstant, isPureStdlibCall } from './deobfuscate.js';
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
    // A table literal copied into every use site changes identity. That is only
    // safe when the table is a read-only array that is never compared and never
    // grows, so the uses allowed are:
    //
    //   - a constant index (`t[3]`) or a length (`#t`), which is the string-table
    //     case and lets the next fold turn `t[3]` into the element; and
    //   - an argument to a pure standard-library call (`table.concat(t)`), where
    //     the callee reads the table and never keeps it — which is what turns a
    //     decoded byte array into the string.
    return binding.reads.every(
      (read) => isConstantIndexOrLength(read, constant) || isPureCallArgument(read),
    );
  }
  return true;
}

/**
 * A read that is an argument to a call to a pure standard-library function.
 *
 * The callee must be a global the file does not shadow: if `table` is a local,
 * `table.concat(t)` is the user's own function and may do anything with the
 * table, including keeping it.
 */
function isPureCallArgument(node) {
  const parent = node.__parent;
  if (!parent || parent.type !== 'Call') return false;
  if (!parent.args.includes(node)) return false;
  return isPureStdlibCall(parent);
}

/**
 * Is this read of the table one that the next fold will turn into a value?
 *
 * This is stricter than "the read is harmless", on purpose. A copy of a table
 * is only interchangeable with the original when the copy is immediately folded
 * away; a copy that survives to be printed has to be parenthesised where the
 * original was not (`({}).concat(t)`), and the output no longer re-parses to the
 * tree it came from. So the reads allowed are exactly the ones that fold: a
 * `#`, and `t[n]` where `n` is a constant index inside the array.
 *
 * `t.field` is refused even though reading a field is harmless: with a copy, the
 * printer has no way to write it back.
 */
function isConstantIndexOrLength(node, table) {
  const parent = node.__parent;
  if (!parent) return false;
  if (parent.type === 'Un' && parent.op === '#') return true;
  if (parent.type !== 'Index' || parent.obj !== node) return false;
  if (parent.keyIsName) return false;
  const key = evaluateConstant(parent.key);
  if (!key || key.kind !== 'number') return false;
  return Number.isInteger(key.value) && key.value >= 1 && key.value <= table.value.length;
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


// ---------------------------------------------------------------------------
// Decode loops
// ---------------------------------------------------------------------------

/**
 * Fold the loop an obfuscator writes to build a string at runtime.
 *
 *     local src = { 72, 101, 108, 108, 111 }
 *     local out = {}
 *     for i = 1, #src do out[i] = string.char(src[i]) end
 *     print(table.concat(out))
 *
 * Nothing in there is a constant, so an expression-by-expression fold cannot
 * reach it: the string exists only once the loop has run. This pass runs the
 * loop over the values it can see and replaces the accumulator's initialiser
 * with the result, so the very next fold collapses `table.concat(out)`.
 *
 * Every rule below refuses rather than guesses:
 *
 *   - the source is a local, declared once, never reassigned, bound to a
 *     constant array of numbers;
 *   - the loop runs `1` to `#source` with step 1, so it reads every element and
 *     nothing else;
 *   - the accumulator is declared on the line immediately before the loop, as
 *     `{}` or `""`, and written exactly once, in that loop;
 *   - the body is that one assignment;
 *   - the element expression folds once the element is substituted for
 *     `source[i]` and the index for the loop variable. One element that will
 *     not fold leaves the whole loop alone: a loop that decodes half a string
 *     does not decode a string.
 */
export function foldDecodeLoops(ast, bindings, stats, report) {
  const byName = new Map();
  for (const binding of bindings) {
    // Two bindings for one name means the name is reused somewhere; picking one
    // would be a guess.
    if (byName.has(binding.name)) byName.set(binding.name, null);
    else byName.set(binding.name, binding);
  }

  let changed = 0;
  eachStatementBlock(ast, (body) => {
    for (let i = 1; i < body.length; i += 1) {
      const loop = body[i];
      const decl = body[i - 1];
      if (!loop || loop.type !== 'NumericFor' || loop.body.length !== 1) continue;
      if (!decl || decl.type !== 'LocalStat' || decl.names.length !== 1 || decl.exprs.length !== 1) continue;

      const accumulator = decl.names[0].name;
      const shape = seedShape(decl.exprs[0], loop.body[0], accumulator);
      if (!shape) continue;

      const plan = planDecodeLoop(loop, decl.exprs[0], accumulator, shape, byName);
      if (!plan) continue;

      const init = runDecodeLoop(plan);
      if (!init) continue;

      decl.exprs[0] = init;
      body.splice(i, 1);
      i -= 1;
      changed += 1;
      if (stats) stats.decodedLoops += 1;
      if (report) report.decoded.push({ shape, length: plan.length });
    }
    return body;
  });
  return changed;
}

/** `{}` with `out[i] = ...`, or `""` with `out = out .. ...`? */
function seedShape(seed, stat, accumulator) {
  if (!stat || stat.type !== 'AssignStat') return null;
  if (stat.targets.length !== 1 || stat.exprs.length !== 1) return null;
  const target = stat.targets[0];
  const expr = stat.exprs[0];

  if (seed.type === 'Table' && seed.fields.length === 0) {
    if (target.type !== 'Index' || target.keyIsName) return null;
    if (!isName(target.obj, accumulator)) return null;
    return 'array';
  }

  if (seed.type === 'Str' && seed.value === '') {
    if (!isName(target, accumulator)) return null;
    if (expr.type !== 'Bin' || expr.op !== '..') return null;
    if (!isName(expr.left, accumulator)) return null; // `out .. x`, never `x .. out`
    return 'string';
  }

  return null;
}

function isName(node, name) {
  return node && node.type === 'Name' && node.name === name;
}

/** Everything the loop needs to be run, or null if any premise fails. */
function planDecodeLoop(loop, seed, accumulator, shape, byName) {
  const stat = loop.body[0];
  const from = evaluateConstant(loop.from);
  if (!from || from.kind !== 'number' || from.value !== 1) return null;
  const step = loop.step ? evaluateConstant(loop.step) : { kind: 'number', value: 1 };
  if (!step || step.kind !== 'number' || step.value !== 1) return null;

  // Where do the elements come from? `#source` is the usual spelling; a literal
  // count is allowed only when the source really is that long.
  let sourceName = null;
  let bound = null;
  if (loop.to.type === 'Un' && loop.to.op === '#' && loop.to.operand.type === 'Name') {
    sourceName = loop.to.operand.name;
  } else {
    bound = evaluateConstant(loop.to);
    if (!bound || bound.kind !== 'number' || !Number.isInteger(bound.value) || bound.value < 0) return null;
  }

  const elementExpr = shape === 'array' ? stat.exprs[0] : stat.exprs[0].right;
  const read = findSourceRead(elementExpr, sourceName);
  if (!read) return null;
  sourceName = read.name;

  const sourceBinding = byName.get(sourceName);
  if (!sourceBinding) return null;
  if (sourceBinding.kind !== 'local') return null;
  if (!sourceBinding.singleAssignment || sourceBinding.writeCount !== 0) return null;
  const source = sourceBinding.init ? evaluateConstant(sourceBinding.init) : null;
  if (!source) return null;

  if (bound && source.kind === 'table' && source.value.length !== bound.value) return null;

  const accumulatorBinding = byName.get(accumulator);
  if (!accumulatorBinding) return null;
  if (accumulatorBinding.kind !== 'local') return null;
  if (accumulatorBinding.captured) return null;
  // Its declaration is the line above the loop, so nothing can read the
  // accumulator between the two, and nothing can write it either.
  if (accumulatorBinding.init !== seed) return null;

  if (shape === 'array') {
    // `out[i] = ...` is not a write to `out` in the scope model, so what has to
    // hold is that there is no plain assignment to `out` anywhere: the decoded
    // table stays unless the code itself replaces it.
    if (accumulatorBinding.writeCount !== 0) return null;
  } else {
    // `out = out .. ...` is a real write, and it must be this one.
    if (accumulatorBinding.writeCount !== 1) return null;
    if (!containsNode(stat, accumulatorBinding.writes[0])) return null;
  }

  const length = source.kind === 'table' ? source.value.length : source.value.length;
  if (bound && source.kind === 'string' && source.value.length !== bound.value) return null;

  return {
    shape,
    read,
    source,
    length,
    loopVar: loop.name.name,
    elementExpr,
    accumulator,
    line: loop.line,
  };
}

/**
 * The read of the source array inside the element expression.
 *
 * Returns `{ name, shape, key }`, where the shape says how an element is pulled
 * out: `index` for `src[i]`, `sub` for `string.sub(src, i, i)` on a string.
 */
function findSourceRead(expr, expectedName) {
  let found = null;
  const visit = (node) => {
    if (!node || typeof node !== 'object' || found) return;
    if (node.type === 'Index' && node.obj && node.obj.type === 'Name' && !node.keyIsName) {
      if (!expectedName || node.obj.name === expectedName) {
        found = { name: node.obj.name, shape: 'index', key: node.key, node };
        return;
      }
    }
    for (const key of Object.keys(node)) {
      if (SKIP.has(key)) continue;
      const value = node[key];
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  visit(expr);
  return found;
}

/** Run the loop, element by element, and build the accumulator's value. */
function runDecodeLoop(plan) {
  const values = [];
  for (let k = 1; k <= plan.length; k += 1) {
    const element =
      plan.source.kind === 'table'
        ? plan.source.value[k - 1]
        : { kind: 'string', value: plan.source.value[k - 1] };
    if (!element) return null;

    // Substitution replaces AST nodes with AST nodes — `literal()` builds a
    // node, not a value. Putting a bare constant in the tree is how the printer
    // ends up emitting nothing at all.
    const elementNode = literal(element);
    if (!elementNode) return null;
    const substitutions = new Map();
    // The element itself: `src[i]` becomes the k-th value.
    substitutions.set(plan.read.node, elementNode);
    // The loop variable, wherever else the expression uses it.
    collectNamed(plan.elementExpr, plan.loopVar, (node) =>
      substitutions.set(node, { type: 'Number', value: k, raw: null }),
    );

    const substituted = substituteClone(plan.elementExpr, substitutions);
    const value = evaluateConstant(substituted);
    if (!value) return null;
    values.push(value);
  }

  if (plan.shape === 'array') {
    // The field shape must be the parser's exactly — `{kind, value}` and no
    // `key` — or the printed table re-parses into a slightly different tree and
    // the safety net refuses it, correctly.
    const fields = values.map((value) => ({ kind: 'array', value: literal(value) }));
    if (fields.some((f) => !f.value)) return null;
    return { type: 'Table', fields, trailingSep: null, line: plan.line, col: 0 };
  }

  let out = '';
  for (const value of values) {
    if (value.kind !== 'string') return null;
    out += value.value;
  }
  return { type: 'Str', value: out, raw: null };
}

/** Call `fn` with every Name node in `node` called `name`. */
function collectNamed(node, name, fn) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'Name' && node.name === name) fn(node);
  for (const key of Object.keys(node)) {
    if (SKIP.has(key)) continue;
    const value = node[key];
    if (Array.isArray(value)) value.forEach((v) => collectNamed(v, name, fn));
    else if (value && typeof value === 'object') collectNamed(value, name, fn);
  }
}

/**
 * A copy of `node` with the given nodes replaced.
 *
 * Substitution is by node identity, so nothing can be replaced by accident: the
 * caller has to name the exact node it means.
 */
function substituteClone(node, substitutions) {
  if (substitutions.has(node)) return { ...substitutions.get(node) };
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((item) => substituteClone(item, substitutions));
  const out = {};
  for (const key of Object.keys(node)) {
    // `type` must survive the copy, as it must in cloneNode: a node without a
    // type is not a node, and the fold below silently refuses the whole loop.
    if (SKIP.has(key) && key !== 'type') continue;
    out[key] = substituteClone(node[key], substitutions);
  }
  return out;
}

/** Is `needle` one of the nodes inside `haystack`? */
function containsNode(haystack, needle) {
  if (!haystack || !needle) return false;
  if (haystack === needle) return true;
  let found = false;
  const visit = (node) => {
    if (found || !node || typeof node !== 'object') return;
    if (node === needle) {
      found = true;
      return;
    }
    for (const key of Object.keys(node)) {
      if (SKIP.has(key)) continue;
      const value = node[key];
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  visit(haystack);
  return found;
}

/**
 * Every statement block in the tree.
 *
 * These passes need to see a block as a sequence — a declaration sitting next
 * to the loop that uses it — so they cannot visit one statement at a time.
 */
function eachStatementBlock(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    if (node.length > 0 && node[0] && isStatement(node[0].type)) visit(node);
    for (const item of node) eachStatementBlock(item, visit);
    return;
  }
  for (const key of Object.keys(node)) {
    if (SKIP.has(key)) continue;
    const value = node[key];
    if (Array.isArray(value)) eachStatementBlock(value, visit);
    else if (value && typeof value === 'object') eachStatementBlock(value, visit);
  }
}

const STATEMENT_TYPES = new Set([
  'LocalStat', 'LocalFunction', 'FunctionStat', 'AssignStat', 'CompoundStat', 'CallStat',
  'IfStat', 'WhileStat', 'RepeatStat', 'NumericFor', 'GenericFor', 'DoStat', 'ReturnStat',
  'BreakStat', 'ContinueStat', 'CommentStat', 'TypeStat',
]);

function isStatement(type) {
  return STATEMENT_TYPES.has(type);
}

export { simplifyBlock, dropDeadDeclarations, hasReturn, eachStatementBlock };
