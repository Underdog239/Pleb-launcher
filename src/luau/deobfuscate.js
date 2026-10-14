// Deobfuscation: recover what is recoverable, name what is not.
//
// ## What this can and cannot do
//
// It cannot recover original variable names. No tool can: an obfuscator renames
// a local to `_0x4f2a` and the connection to `currentPlayerCounter` is gone
// from the file. Anything claiming otherwise is guessing and presenting the
// guess as fact. What this does instead is **infer** names from how a variable
// is used, mark every inference with its evidence, and never claim an inference
// is a recovery.
//
// It cannot un-virtualize a VM obfuscator. When a script ships its own bytecode
// interpreter, the original program is a data structure interpreted by that
// loop, and "deobfuscating" it means writing a decompiler for an unknown VM
// whose semantics were chosen by the obfuscator's author. That is not a
// hard problem with a long solution; it is an unsolved one in general. This
// detects the pattern, reports it plainly, and leaves it alone.
//
// It *can* do a great deal on the majority of real obfuscated scripts, which
// are not VM-protected but obfuscated by layers that are mechanically
// reversible:
//
//   * string escaping: `"\x48\x65\x6c\x6c\x6f"` -> `"Hello"`
//   * constant folding: `1 + 2 * 3` -> `7`, `"a" .. "b"` -> `"ab"`, `#({})` -> `0`
//   * pure-stdlib evaluation: `string.char(72, 105)` -> `"Hi"`, `bit32.bxor(5, 3)` -> `6`
//   * string tables: `local a = {"x", "y"}; return a[1 + 1]` -> `return "y"`
//   * dead branches: `if false then real() end` -> removed; `if true then a() end` -> kept
//   * trivial loops: `while true do body end` -> `body`
//   * constant conditions: `if 1 == 1 then a() else b() end` -> `a()`
//
// ## Why the passes are conservative
//
// Every transformation here is one that cannot change what the program does,
// under rules that are written down and tested:
//
//   * Folding evaluates only whitelisted pure functions with constant
//     arguments. Anything that can call out, error, or read mutable state is
//     left alone.
//   * A local is only inlined when it is assigned exactly once, is initialised
//     from a literal, and is never captured by a nested function (a closure
//     could mutate what the value points at).
//   * A table literal is only inlined when *every* use of the name is a
//     constant-key index or a `#`, which is the string-table shape. Using it any
//     other way would duplicate the table and change identity.
//   * Dead-branch removal requires the condition to fold to a boolean.
//   * Nothing is removed if it has side effects.
//
// ## The safety net
//
// The transformed AST is printed and re-parsed, and the two trees are compared.
// If they differ, the output is refused rather than written: a printer bug must
// be a loud failure, not a corrupted script. This is the same principle as the
// rest of the project — never produce an answer that looks fine and is wrong.

import { parse } from './parse.js';
import { print, formatNumber, isPrintableNumber } from './print.js';
import {
  foldTree,
  inlineConstants,
  simplifyBlock,
  dropDeadDeclarations,
  localNames,
  foldDecodeLoops,
} from './transform.js';

const MAX_PASSES = 12;

// ---------------------------------------------------------------------------
// Obfuscation detection
// ---------------------------------------------------------------------------

/**
 * Names that are almost certainly machine-generated.
 *
 * Deliberately not a single-letter rule: `i`, `j`, `n`, `x`, `t`, `v` and `a`
 * are what people write, and a tool that renames them is damaging readable code
 * while pretending to deobfuscate it. `_0x4f2a`, `l_17`, `_13` and `v0042` are
 * what tools write, and those are what this matches.
 */
const GENERATED_NAME = [
  /^_0x[0-9a-f]+$/i,
  /^_+0x[0-9a-f]+$/i,
  /^l_?\d+$/i,
  /^v\d{1,4}$/i,
  /^_\d+$/,
];

/** A name long and uniform enough to be random rather than chosen. */
function looksRandom(name) {
  // `aaaa` and `zzzzzz` are padding, not names.
  if (name.length >= 4 && new Set(name).size <= 2) return true;
  if (name.length < 12) return false;
  if (/[aeiou]{2}/i.test(name)) return false; // real words have vowels
  const distinct = new Set(name).size;
  return distinct >= 5 && /^[a-z0-9_]+$/i.test(name);
}

export function isGeneratedName(name) {
  if (GENERATED_NAME.some((re) => re.test(name))) return true;
  return looksRandom(name);
}

/**
 * Escape density, measured on the literal as it is *written*.
 *
 * This has to look at the source spelling rather than the decoded value: the
 * whole point of `"\x48\x65\x6c\x6c\x6f"` is that it decodes to something
 * innocuous, so a detector reading decoded strings sees "Hello" and learns
 * nothing.
 */
function escapeDensity(raw) {
  if (!raw || raw.length === 0) return 0;
  const escapes = raw.match(/\\x[0-9a-fA-F]{2}|\\\d{1,3}/g);
  if (!escapes) return 0;
  return (escapes.length * 4) / raw.length;
}

/**
 * Look at a script and say what obfuscation it seems to carry.
 *
 * Every finding carries evidence, and the ones that cannot be undone say so in
 * the finding itself rather than in a footnote someone will not read.
 */
export function detectObfuscation(ast, source = '', tokens = null) {
  const findings = [];
  const names = [];
  const strings = [];
  let numbers = 0;
  const calls = [];

  const walkExpr = (node) => {
    if (!node || typeof node !== 'object') return;
    switch (node.type) {
      case 'Str':
        strings.push(node);
        break;
      case 'Number':
        numbers += 1;
        break;
      case 'Name':
        names.push(node);
        break;
      case 'Call':
        if (node.func && node.func.type === 'Name') calls.push(node.func.name);
        if (node.func && node.func.type === 'Index' && node.func.keyIsName) {
          calls.push(`${node.func.obj.type === 'Name' ? node.func.obj.name : '?'}.${node.func.key.value}`);
        }
        break;
      default:
        break;
    }
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'line' || key === 'col') continue;
      const value = node[key];
      if (Array.isArray(value)) value.forEach(walkExpr);
      else if (value && typeof value === 'object') walkExpr(value);
    }
  };

  const walkStat = (stat) => {
    walkExpr(stat);
    for (const key of Object.keys(stat)) {
      const value = stat[key];
      if (Array.isArray(value) && value.length > 0 && value[0] && value[0].type && value[0].type.endsWith('Stat')) {
        value.forEach(walkStat);
      }
    }
  };
  ast.body.forEach(walkStat);

  const generated = names.filter((n) => isGeneratedName(n.name));
  if (generated.length > 0) {
    const share = generated.length / Math.max(1, names.length);
    findings.push({
      technique: 'generated-identifier-names',
      severity: share > 0.5 ? 'high' : 'medium',
      detail: `${generated.length} of ${names.length} name references look machine-written`,
      evidence: [...new Set(generated.map((n) => n.name))].slice(0, 8).join(', '),
      reversible: 'partly',
      note:
        'Names can be replaced with inferred or neutral ones, but the originals are gone: ' +
        'a rename is not recoverable from the file.',
    });
  }

  // Escape-encoded strings are found from the token spans, not the values.
  const stringTokens = (tokens || []).filter((t) => t.type === 'string' && t.value !== undefined);
  const escapedTokens = stringTokens.filter((t) => {
    const raw = source.slice(t.start, t.end);
    return escapeDensity(raw) > 0.3;
  });
  if (escapedTokens.length >= 3) {
    findings.push({
      technique: 'escape-encoded-strings',
      severity: 'high',
      detail: `${escapedTokens.length} of ${stringTokens.length} string literals are mostly escape sequences`,
      evidence: source.slice(escapedTokens[0].start, escapedTokens[0].end).slice(0, 48),
      reversible: 'yes',
      note: 'These decode to their literal values, which is lossless.',
    });
  }

  const b64ish = strings.filter((s) => /^[A-Za-z0-9+/=]{24,}$/.test(s.value) && s.value.length % 4 === 0);
  if (b64ish.length > 0) {
    findings.push({
      technique: 'base64-looking-strings',
      severity: 'medium',
      detail: `${b64ish.length} string literals look like base64`,
      evidence: describeString(b64ish[0].value),
      reversible: 'yes',
      note: 'Decoded where the payload is printable text.',
    });
  }

  if (calls.includes('loadstring') || calls.includes('getfenv') || calls.includes('setfenv')) {
    findings.push({
      technique: 'dynamic-code-loading',
      severity: 'high',
      detail: 'the script builds and runs code at runtime (loadstring/getfenv)',
      evidence: [...new Set(calls.filter((c) => ['loadstring', 'getfenv', 'setfenv'].includes(c)))].join(', '),
      reversible: 'partly',
      note:
        'A loadstring call whose argument folds to a constant is inlined here. One whose ' +
        'argument depends on runtime state cannot be: the code does not exist until it runs.',
    });
  }

  if (detectVmPattern(ast)) {
    findings.push({
      technique: 'vm-interpreter',
      severity: 'critical',
      detail: 'a dispatch loop over a numeric array, with a state variable, looks like a VM',
      evidence: 'loop body indexes a large numeric table and switches on a directive number',
      reversible: 'no',
      note:
        'This is bytecode for a custom virtual machine. Recovering the original program would ' +
        'mean decompiling that VM, whose semantics were chosen by the obfuscator. This tool ' +
        'does not attempt it and will not pretend to.',
    });
  }

  if (numbers > 400 && strings.length < numbers / 10) {
    findings.push({
      technique: 'numeric-payload',
      severity: 'medium',
      detail: `${numbers} numeric literals against ${strings.length} strings`,
      evidence: 'a large numeric array is a common way to store either bytecode or an encoded blob',
      reversible: 'partly',
    });
  }

  const techniques = findings.map((f) => f.technique);
  const score = Math.min(
    100,
    findings.reduce((total, f) => total + (f.severity === 'critical' ? 60 : f.severity === 'high' ? 25 : 12), 0),
  );
  return {
    obfuscated: findings.length > 0,
    score,
    techniques,
    findings,
    irreversible: findings.filter((f) => f.reversible === 'no').map((f) => f.technique),
    ...(source ? {} : {}),
  };
}

function describeString(value) {
  const sample = value.slice(0, 40);
  return `${JSON.stringify(sample)}${value.length > 40 ? '…' : ''}`;
}

/**
 * A state machine dispatch loop reading from a numeric table.
 *
 * The signature is: a local bound to a large array of numbers, and a
 * `while true` loop that reads that array at a running index and advances the
 * index. That is what an obfuscator emits when it ships bytecode and an
 * interpreter for it.
 *
 * This is a heuristic and it is reported as one. Its job is not to be certain
 * but to stop the tool from claiming a file was deobfuscated when the program
 * is still sitting there encoded in a table.
 */
function detectVmPattern(ast) {
  const isNumericTable = (node) =>
    node &&
    node.type === 'Table' &&
    node.fields.length >= 16 &&
    node.fields.every((f) => f.kind === 'array' && f.value && f.value.type === 'Number');

  // Names bound to a numeric array long enough to be a program.
  const programTables = new Set();
  const findTables = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'LocalStat') {
      node.names.forEach((name, index) => {
        const init = node.exprs[index];
        if (isNumericTable(init)) programTables.add(name.name);
      });
    }
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'line' || key === 'col') continue;
      const value = node[key];
      if (Array.isArray(value)) value.forEach(findTables);
      else if (value && typeof value === 'object') findTables(value);
    }
  };
  findTables(ast);

  let found = false;
  const visit = (node) => {
    if (found || !node || typeof node !== 'object') return;
    if (node.type === 'WhileStat' && node.cond && node.cond.type === 'Bool' && node.cond.value === true) {
      let readsProgram = false;
      let advancesIndex = false;
      const scan = (child) => {
        if (!child || typeof child !== 'object') return;
        if (child.type === 'Index' && child.obj.type === 'Name' && programTables.has(child.obj.name)) {
          readsProgram = true;
        }
        // `i = i + 1` or `i += 1`, the loop's own program counter.
        if (child.type === 'AssignStat') {
          for (let i = 0; i < child.targets.length; i += 1) {
            const target = child.targets[i];
            const expr = child.exprs[i];
            if (
              target.type === 'Name' &&
              expr &&
              expr.type === 'Bin' &&
              expr.op === '+' &&
              expr.left.type === 'Name' &&
              expr.left.name === target.name
            ) {
              advancesIndex = true;
            }
          }
        }
        if (child.type === 'CompoundStat' && child.target.type === 'Name' && child.op === '+=') {
          advancesIndex = true;
        }
        for (const key of Object.keys(child)) {
          if (key === 'type' || key === 'line' || key === 'col') continue;
          const value = child[key];
          if (Array.isArray(value)) value.forEach(scan);
          else if (value && typeof value === 'object') scan(value);
        }
      };
      node.body.forEach(scan);
      if (readsProgram && advancesIndex) found = true;
    }
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'line' || key === 'col') continue;
      const value = node[key];
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  ast.body.forEach(visit);
  return found;
}

// ---------------------------------------------------------------------------
// Scope analysis
// ---------------------------------------------------------------------------

/**
 * Resolve every `Name` to a binding or mark it global.
 *
 * A binding is a declaration site. Locals, function parameters, loop variables
 * and `local function` names all create one. Anything that resolves to nothing
 * is a global read or write, which is never renamed: assigning to a global is
 * observable from outside, and a global's name is part of the program's
 * interface to its environment.
 */
export function analyzeScope(ast) {
  const bindings = [];
  const scopes = [];

  const pushScope = () => {
    const scope = { parent: scopes[scopes.length - 1] || null, names: new Map() };
    scopes.push(scope);
    return scope;
  };
  const popScope = () => scopes.pop();
  const current = () => scopes[scopes.length - 1];

  const declare = (nameNode, kind, initNode, depth) => {
    const scope = current();
    const binding = {
      name: nameNode.name,
      kind,
      line: nameNode.line,
      col: nameNode.col,
      depth,
      scope,
      declarations: [nameNode],
      reads: [],
      writes: [],
      captured: false,
      init: initNode || null,
    };
    bindings.push(binding);
    // A redeclaration shadows; the inner one wins for everything after it.
    scope.names.set(nameNode.name, binding);
    return binding;
  };

  const resolve = (name) => {
    for (let scope = current(); scope; scope = scope.parent) {
      const binding = scope.names.get(name);
      if (binding) return binding;
    }
    return null;
  };

  // `walk` visits expressions; `walkTarget` visits assignment targets, where
  // the final `Name` is a write rather than a read.
  const walk = (node, functionDepth = 0) => {
    if (!node || typeof node !== 'object') return;
    switch (node.type) {
      case 'Name': {
        const binding = resolve(node.name);
        if (binding) {
          binding.reads.push(node);
          if (functionDepth > binding.depth) binding.captured = true;
          node.binding = binding;
        } else {
          node.global = true;
        }
        return;
      }
      case 'FunctionExpr': {
        pushScope();
        const depth = functionDepth + 1;
        for (const param of node.params) declare(param, 'parameter', null, depth);
        for (const child of node.body) walkStat(child, depth);
        popScope();
        return;
      }
      case 'Table':
        for (const field of node.fields) {
          if (field.kind === 'index') walk(field.key, functionDepth);
          walk(field.value, functionDepth);
        }
        return;
      default:
        break;
    }
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'line' || key === 'col' || key === 'binding') continue;
      const value = node[key];
      if (Array.isArray(value)) value.forEach((v) => walk(v, functionDepth));
      else if (value && typeof value === 'object') walk(value, functionDepth);
    }
  };

  const walkStat = (stat, functionDepth = 0) => {
    switch (stat.type) {
      case 'LocalStat': {
        // The initialisers are evaluated before the names come into scope, so
        // `local x = x` refers to the outer x.
        for (const expr of stat.exprs) walk(expr, functionDepth);
        stat.names.forEach((nameNode, index) => {
          // The initialiser that belongs to *this* name: `local a, b = 1, 2`.
          const binding = declare(nameNode, 'local', stat.exprs[index] || null, functionDepth);
          binding.declIndex = index;
          binding.declCount = stat.names.length;
          binding.initExprs = stat.exprs;
          nameNode.binding = binding;
        });
        return;
      }
      case 'LocalFunction': {
        const binding = declare(stat.name, 'local-function', null, functionDepth);
        stat.name.binding = binding;
        // The name is in scope inside its own body, which is what makes
        // recursion work.
        walk(stat.func, functionDepth);
        return;
      }
      case 'FunctionStat': {
        walkTarget(stat.target, functionDepth);
        walk(stat.func, functionDepth);
        return;
      }
      case 'AssignStat': {
        for (const target of stat.targets) walkTarget(target, functionDepth);
        for (const expr of stat.exprs) walk(expr, functionDepth);
        return;
      }
      case 'CompoundStat': {
        walkTarget(stat.target, functionDepth);
        walk(stat.expr, functionDepth);
        return;
      }
      case 'IfStat': {
        for (const clause of stat.clauses) {
          walk(clause.cond, functionDepth);
          pushScope();
          for (const child of clause.body) walkStat(child, functionDepth);
          popScope();
        }
        if (stat.elseBody) {
          pushScope();
          for (const child of stat.elseBody) walkStat(child, functionDepth);
          popScope();
        }
        return;
      }
      case 'WhileStat': {
        walk(stat.cond, functionDepth);
        pushScope();
        for (const child of stat.body) walkStat(child, functionDepth);
        popScope();
        return;
      }
      case 'RepeatStat': {
        // `until` can see the body's locals.
        pushScope();
        for (const child of stat.body) walkStat(child, functionDepth);
        walk(stat.cond, functionDepth);
        popScope();
        return;
      }
      case 'NumericFor': {
        walk(stat.from, functionDepth);
        walk(stat.to, functionDepth);
        if (stat.step) walk(stat.step, functionDepth);
        pushScope();
        declare(stat.name, 'loop', null, functionDepth + 1);
        for (const child of stat.body) walkStat(child, functionDepth);
        popScope();
        return;
      }
      case 'GenericFor': {
        for (const expr of stat.exprs) walk(expr, functionDepth);
        pushScope();
        for (const nameNode of stat.names) declare(nameNode, 'loop', null, functionDepth + 1);
        for (const child of stat.body) walkStat(child, functionDepth);
        popScope();
        return;
      }
      case 'DoStat': {
        pushScope();
        for (const child of stat.body) walkStat(child, functionDepth);
        popScope();
        return;
      }
      case 'CallStat': {
        walk(stat.call, functionDepth);
        return;
      }
      case 'ReturnStat':
        for (const expr of stat.exprs) walk(expr, functionDepth);
        return;
      case 'TypeStat':
      case 'CommentStat':
      case 'BreakStat':
      case 'ContinueStat':
        return;
      default:
        // Anything with sub-statements that this switch does not know about:
        // walk the expressions, then the statements, so nothing is missed.
        walk(stat, functionDepth);
        for (const key of Object.keys(stat)) {
          const value = stat[key];
          if (Array.isArray(value)) {
            for (const child of value) {
              if (child && typeof child === 'object' && child.type && child.type.endsWith('Stat')) {
                walkStat(child, functionDepth);
              }
            }
          }
        }
        return;
    }
  };

  /** An assignment target: `x`, `t.k`, `t[k]` — only a bare name is a write. */
  const walkTarget = (node, functionDepth) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Name') {
      const binding = resolve(node.name);
      if (binding) {
        binding.writes.push(node);
        if (functionDepth > binding.depth) binding.captured = true;
        node.binding = binding;
      } else {
        node.global = true;
      }
      return;
    }
    if (node.type === 'Index') {
      walk(node.obj, functionDepth);
      walk(node.key, functionDepth);
      return;
    }
    walk(node, functionDepth);
  };

  pushScope();
  for (const stat of ast.body) walkStat(stat, 0);
  popScope();

  // A name is "assigned once" when the declaration is its only binding of a
  // value; writes after that are what make inlining unsound.
  for (const binding of bindings) {
    binding.writeCount = binding.writes.length;
    binding.readCount = binding.reads.length;
    binding.singleAssignment = binding.writes.length === 0;
  }

  return { bindings, scopes };
}

// ---------------------------------------------------------------------------
// Constant evaluation
// ---------------------------------------------------------------------------

const STRING_LIB = new Set([
  'char', 'byte', 'sub', 'rep', 'reverse', 'lower', 'upper', 'len', 'format', 'find', 'gsub', 'match', 'gmatch',
]);

const BIT_LIB = new Set(['band', 'bor', 'bxor', 'bnot', 'lshift', 'rshift', 'arshift', 'btest', 'extract', 'replace', 'countlz', 'countrz', 'byteswap']);

const MATH_LIB = new Set(['floor', 'ceil', 'abs', 'max', 'min', 'sqrt', 'floor', 'round', 'sign', 'clamp']);

/** Global functions with no side effects and no interest in identity. */
const PURE_GLOBALS = new Set(['tostring', 'tonumber', 'type', 'typeof', 'select']);

/** Lua's `%`: the result takes the sign of the divisor. */
function luaMod(a, b) {
  if (b === 0) return null;
  return a - Math.floor(a / b) * b;
}

/** Lua's `//`: floor division, not truncation. */
function luaFloorDiv(a, b) {
  if (b === 0) return null;
  return Math.floor(a / b);
}

const to32 = (n) => n >>> 0;

/** Evaluate a pure expression to a constant, or return null. */
export function evaluateConstant(node) {
  if (!node || typeof node !== 'object') return null;
  switch (node.type) {
    case 'Nil':
      return { kind: 'nil', value: null };
    case 'Bool':
      return { kind: 'bool', value: node.value };
    case 'Number':
      return isPrintableNumber(node.value) ? { kind: 'number', value: node.value } : null;
    case 'Str':
      return { kind: 'string', value: node.value };
    case 'Paren': {
      const inner = evaluateConstant(node.expr);
      return inner ? { ...inner, paren: true } : null;
    }
    case 'Un': {
      const operand = evaluateConstant(node.operand);
      if (!operand) return null;
      if (node.op === '-') return operand.kind === 'number' ? { kind: 'number', value: -operand.value } : null;
      if (node.op === 'not') return { kind: 'bool', value: !truthy(operand) };
      if (node.op === '#') {
        if (operand.kind === 'string') return { kind: 'number', value: operand.value.length };
        if (operand.kind === 'table') return { kind: 'number', value: arrayLength(operand.value) };
        return null;
      }
      return null;
    }
    case 'Bin': {
      const left = evaluateConstant(node.left);
      const right = evaluateConstant(node.right);
      if (!left || !right) return null;
      return evaluateBinary(node.op, left, right);
    }
    case 'Table': {
      // Only a pure array of constants, so that `#` and constant indexing are
      // well defined and nothing has to be evaluated lazily.
      const items = [];
      for (const field of node.fields) {
        if (field.kind !== 'array') return null;
        const value = evaluateConstant(field.value);
        if (!value) return null;
        items.push(value);
      }
      return { kind: 'table', value: items };
    }
    case 'Call':
      return evaluateCall(node);
    case 'IfExpr': {
      const cond = evaluateConstant(node.cond);
      if (!cond) return null;
      return evaluateConstant(truthy(cond) ? node.thenExpr : node.elseExpr);
    }
    case 'Cast':
      return evaluateConstant(node.expr);
    case 'Index': {
      // A constant index into a constant table: the string-table shape.
      const obj = evaluateConstant(node.obj);
      if (!obj || obj.kind !== 'table') return null;
      if (node.keyIsName) return null; // `t.k` on a table constant is not modelled
      const key = evaluateConstant(node.key);
      if (!key || key.kind !== 'number' || !Number.isInteger(key.value)) return null;
      const index = key.value;
      if (index < 1 || index > obj.value.length) return null;
      return obj.value[index - 1];
    }
    default:
      return null;
  }
}

function truthy(constant) {
  if (constant.kind === 'nil') return false;
  if (constant.kind === 'bool') return constant.value;
  return true;
}

function arrayLength(items) {
  // `#` on a table with no holes is its length; the evaluator only builds
  // hole-free arrays.
  return items.length;
}

function constantToNode(constant) {
  switch (constant.kind) {
    case 'nil':
      return { type: 'Nil' };
    case 'bool':
      return { type: 'Bool', value: constant.value };
    case 'number':
      return { type: 'Number', value: constant.value, raw: null };
    case 'string':
      return { type: 'Str', value: constant.value, raw: null };
    default:
      return null;
  }
}

function evaluateBinary(op, left, right) {
  const ln = left.kind === 'number' ? left.value : null;
  const rn = right.kind === 'number' ? right.value : null;
  const ls = left.kind === 'string' ? left.value : null;
  const rs = right.kind === 'string' ? right.value : null;

  switch (op) {
    case 'and':
      return truthy(left) ? right : left;
    case 'or':
      return truthy(left) ? left : right;
    case '==': {
      if (left.kind === 'nil' || right.kind === 'nil') return { kind: 'bool', value: left.kind === right.kind };
      if (left.kind !== right.kind) return { kind: 'bool', value: false };
      return { kind: 'bool', value: left.value === right.value };
    }
    case '~=': {
      const eq = evaluateBinary('==', left, right);
      return eq ? { kind: 'bool', value: !eq.value } : null;
    }
    case '..': {
      const l = ls !== null ? ls : ln !== null ? numberToConcat(ln) : null;
      const r = rs !== null ? rs : rn !== null ? numberToConcat(rn) : null;
      if (l === null || r === null) return null;
      return { kind: 'string', value: l + r };
    }
    case '+':
      return ln !== null && rn !== null ? { kind: 'number', value: ln + rn } : null;
    case '-':
      return ln !== null && rn !== null ? { kind: 'number', value: ln - rn } : null;
    case '*':
      return ln !== null && rn !== null ? { kind: 'number', value: ln * rn } : null;
    case '/':
      return ln !== null && rn !== null && rn !== 0 ? { kind: 'number', value: ln / rn } : null;
    case '%': {
      const value = ln !== null && rn !== null ? luaMod(ln, rn) : null;
      return value === null ? null : { kind: 'number', value };
    }
    case '//': {
      const value = ln !== null && rn !== null ? luaFloorDiv(ln, rn) : null;
      return value === null ? null : { kind: 'number', value };
    }
    case '^': {
      const value = ln !== null && rn !== null ? ln ** rn : null;
      if (value === null || !Number.isFinite(value)) return null;
      return { kind: 'number', value };
    }
    case '<':
      return compare(ln, rn, ls, rs, (a, b) => a < b);
    case '>':
      return compare(ln, rn, ls, rs, (a, b) => a > b);
    case '<=':
      return compare(ln, rn, ls, rs, (a, b) => a <= b);
    case '>=':
      return compare(ln, rn, ls, rs, (a, b) => a >= b);
    case '&':
      return ln !== null && rn !== null ? { kind: 'number', value: to32(ln & rn) } : null;
    case '|':
      return ln !== null && rn !== null ? { kind: 'number', value: to32(ln | rn) } : null;
    case '~':
      return ln !== null && rn !== null ? { kind: 'number', value: to32(ln ^ rn) } : null;
    case '<<':
      return ln !== null && rn !== null ? { kind: 'number', value: to32(ln << (rn & 31)) } : null;
    case '>>':
      return ln !== null && rn !== null ? { kind: 'number', value: to32(ln >>> (rn & 31)) } : null;
    default:
      return null;
  }
}

function compare(ln, rn, ls, rs, fn) {
  if (ln !== null && rn !== null) return { kind: 'bool', value: fn(ln, rn) };
  if (ls !== null && rs !== null) return { kind: 'bool', value: fn(ls, rs) };
  return null;
}

/** How Lua renders a number inside `..`. */
function numberToConcat(n) {
  if (Number.isInteger(n)) return String(n);
  return formatNumber(n);
}

/**
 * Names that are locals somewhere in the file.
 *
 * `string.char(72)` is only the standard library if `string` is not a local.
 * Shadowing is rare, but folding a call to a user's own function is not a
 * transformation the safety net can catch — the output parses and has the same
 * shape, it just calls a different function. So the evaluator asks this set
 * before it treats any name as the standard library.
 *
 * It is deliberately over-broad, in the same way the loadstring check is: a
 * local named `string` anywhere in the file disables library folding for the
 * whole file. The cost is a missed fold, and a missed fold is not a bug.
 */
let SHADOWED_NAMES = new Set();

/** Point the evaluator at the set of names that are locals in this file. */
export function setShadowedNames(names) {
  SHADOWED_NAMES = names || new Set();
}

/** Is this name a local somewhere, so that using it as a library is wrong? */
function isShadowed(name) {
  return SHADOWED_NAMES.has(name);
}

/**
 * Is this a call to a standard-library function the evaluator knows?
 *
 * Used by the inline pass to decide whether a table may be copied to its use
 * site. It answers a narrower question than `evaluateCall`: the argument might
 * not fold, but the callee must be a function with no side effects and no
 * interest in a table's identity — `table.concat` reads a table, it never
 * keeps a reference to it, so handing it a copy is the same call.
 */
export function isPureStdlibCall(node) {
  if (!node || node.type !== 'Call') return false;
  const func = node.func;
  if (func.type === 'Index' && func.keyIsName && func.obj.type === 'Name') {
    const lib = func.obj.name;
    const fn = func.key.value;
    if (isShadowed(lib)) return false;
    if (lib === 'string') return STRING_LIB.has(fn);
    if (lib === 'bit32') return BIT_LIB.has(fn);
    if (lib === 'math') return MATH_LIB.has(fn);
    if (lib === 'table') return fn === 'concat';
    return false;
  }
  if (func.type === 'Name') {
    if (isShadowed(func.name)) return false;
    return PURE_GLOBALS.has(func.name);
  }
  return false;
}

function evaluateCall(node) {
  const args = [];
  for (const arg of node.args) {
    const value = evaluateConstant(arg);
    if (!value) return null;
    args.push(value);
  }

  // string.char / string.byte / ...
  if (node.func.type === 'Index' && node.func.keyIsName && node.func.obj.type === 'Name') {
    const lib = node.func.obj.name;
    const fn = node.func.key.value;
    if (isShadowed(lib)) return null;
    if (lib === 'string' && STRING_LIB.has(fn)) return evaluateStringLib(fn, args);
    if (lib === 'bit32' && BIT_LIB.has(fn)) return evaluateBitLib(fn, args);
    if (lib === 'math' && MATH_LIB.has(fn)) return evaluateMathLib(fn, args);
    if (lib === 'table' && fn === 'concat') return evaluateTableConcat(args);
    return null;
  }

  if (node.func.type === 'Name') {
    const name = node.func.name;
    if (isShadowed(name)) return null;
    if (name === 'tostring') {
      const arg = args[0];
      if (!arg) return null;
      if (arg.kind === 'string') return arg;
      if (arg.kind === 'number') return { kind: 'string', value: numberToConcat(arg.value) };
      if (arg.kind === 'bool') return { kind: 'string', value: String(arg.value) };
      return null;
    }
    if (name === 'tonumber') {
      const arg = args[0];
      if (!arg) return null;
      if (arg.kind === 'number') return arg;
      if (arg.kind === 'string') {
        const parsed = Number(arg.value);
        return Number.isFinite(parsed) ? { kind: 'number', value: parsed } : null;
      }
      return null;
    }
    if (name === 'type' || name === 'typeof') {
      const arg = args[0];
      if (!arg) return null;
      const map = { nil: 'nil', bool: 'boolean', number: 'number', string: 'string', table: 'table' };
      return map[arg.kind] ? { kind: 'string', value: map[arg.kind] } : null;
    }
    if (name === 'select' && args[0] && args[0].kind === 'number' && args[0].value === 1) {
      return args[1] || null;
    }
  }
  return null;
}

function evaluateStringLib(fn, args) {
  const str = (i) => (args[i] && args[i].kind === 'string' ? args[i].value : null);
  const num = (i) => (args[i] && args[i].kind === 'number' ? args[i].value : null);

  switch (fn) {
    case 'char': {
      let out = '';
      for (const arg of args) {
        if (arg.kind !== 'number' || !Number.isInteger(arg.value) || arg.value < 0 || arg.value > 255) return null;
        out += String.fromCharCode(arg.value);
      }
      return { kind: 'string', value: out };
    }
    case 'byte': {
      const s = str(0);
      if (s === null) return null;
      const i = num(1) ?? 1;
      const j = num(2) ?? i;
      if (i < 1 || j > s.length) return null;
      const bytes = [];
      for (let k = i - 1; k < j; k += 1) bytes.push(s.codePointAt(k));
      return { kind: 'string', value: bytes.join(',') };
    }
    case 'sub': {
      const s = str(0);
      if (s === null) return null;
      const i = num(1);
      if (i === null) return null;
      const j = num(2) ?? -1;
      const start = i < 0 ? Math.max(s.length + i + 1, 1) : Math.min(i, s.length + 1);
      const end = j < 0 ? s.length + j + 1 : Math.min(j, s.length);
      if (start > end) return { kind: 'string', value: '' };
      return { kind: 'string', value: s.slice(start - 1, end) };
    }
    case 'rep': {
      const s = str(0);
      const n = num(1);
      const sep = str(2) ?? '';
      if (s === null || n === null || !Number.isInteger(n) || n < 0 || n > 100000) return null;
      return { kind: 'string', value: Array(n).fill(s).join(sep) };
    }
    case 'reverse': {
      const s = str(0);
      return s === null ? null : { kind: 'string', value: [...s].reverse().join('') };
    }
    case 'lower': {
      const s = str(0);
      return s === null ? null : { kind: 'string', value: s.toLowerCase() };
    }
    case 'upper': {
      const s = str(0);
      return s === null ? null : { kind: 'string', value: s.toUpperCase() };
    }
    case 'len': {
      const s = str(0);
      return s === null ? null : { kind: 'number', value: s.length };
    }
    default:
      return null;
  }
}

function evaluateBitLib(fn, args) {
  const nums = args.map((a) => (a.kind === 'number' ? a.value : null));
  if (nums.some((n) => n === null)) return null;
  const raw = nums.map((n) => n | 0);
  const shift = (n) => n & 31;
  switch (fn) {
    case 'band':
      return { kind: 'number', value: to32(raw.reduce((a, b) => a & b, -1)) };
    case 'bor':
      return { kind: 'number', value: to32(raw.reduce((a, b) => a | b, 0)) };
    case 'bxor':
      return { kind: 'number', value: to32(raw.reduce((a, b) => a ^ b, 0)) };
    case 'bnot':
      return { kind: 'number', value: to32(~raw[0]) };
    case 'lshift':
      return { kind: 'number', value: to32(raw[0] << shift(raw[1])) };
    case 'rshift':
      return { kind: 'number', value: to32(raw[0] >>> shift(raw[1])) };
    case 'arshift':
      return { kind: 'number', value: to32(raw[0] >> shift(raw[1])) };
    case 'btest':
      return { kind: 'bool', value: raw.reduce((a, b) => a & b, -1) !== 0 };
    default:
      return null;
  }
}

function evaluateMathLib(fn, args) {
  const nums = args.map((a) => (a.kind === 'number' ? a.value : null));
  if (nums.some((n) => n === null)) return null;
  const ok = (v) => (Number.isFinite(v) ? { kind: 'number', value: v } : null);
  switch (fn) {
    case 'floor':
      return ok(Math.floor(nums[0]));
    case 'ceil':
      return ok(Math.ceil(nums[0]));
    case 'abs':
      return ok(Math.abs(nums[0]));
    case 'max':
      return ok(Math.max(...nums));
    case 'min':
      return ok(Math.min(...nums));
    case 'sqrt':
      return nums[0] < 0 ? null : ok(Math.sqrt(nums[0]));
    case 'round':
      return ok(Math.round(nums[0]));
    case 'sign':
      return ok(Math.sign(nums[0]));
    case 'clamp':
      return ok(Math.min(Math.max(nums[0], nums[1]), nums[2]));
    default:
      return null;
  }
}

function evaluateTableConcat(args) {
  const table = args[0];
  if (!table || table.kind !== 'table') return null;
  const sep = args[1] && args[1].kind === 'string' ? args[1].value : '';
  const parts = [];
  for (const item of table.value) {
    if (item.kind === 'string') parts.push(item.value);
    else if (item.kind === 'number') parts.push(numberToConcat(item.value));
    else return null;
  }
  return { kind: 'string', value: parts.join(sep) };
}

// ---------------------------------------------------------------------------
// Renaming
// ---------------------------------------------------------------------------

const LUA_KEYWORDS = new Set([
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'if', 'in',
  'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while',
  'continue', 'type', 'export', 'self',
]);

function lowerFirst(name) {
  if (!name) return name;
  return name[0].toLowerCase() + name.slice(1);
}

/** Every identifier mentioned anywhere in the source, so renames cannot collide. */
function allIdentifiers(ast) {
  const names = new Set();
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Name' && typeof node.name === 'string') names.add(node.name);
    if (node.type === 'LocalStat') for (const n of node.names) names.add(n.name);
    if (node.type === 'LocalFunction') names.add(node.name.name);
    if (node.type === 'FunctionExpr') for (const p of node.params) names.add(p.name);
    if (node.type === 'NumericFor') names.add(node.name.name);
    if (node.type === 'GenericFor') for (const n of node.names) names.add(n.name);
    if (node.type === 'Index' && node.keyIsName) names.add(node.key.value);
    for (const key of Object.keys(node)) {
      if (SKIP_KEYS.has(key)) continue;
      const value = node[key];
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  ast.body.forEach(visit);
  return names;
}

const SKIP_KEYS = new Set(['type', 'line', 'col', 'raw', 'binding', 'scope', '__parent', 'folded', 'inlinedFrom', 'global']);

/**
 * Guess a name from how a variable is used.
 *
 * These are inferences, not recoveries, and the evidence is returned with each
 * one so the report can say what it was based on. Where there is no evidence,
 * this returns null and the caller uses a neutral name instead of inventing a
 * meaning.
 */
function inferName(binding) {
  const init = binding.init;

  // `local part = Instance.new("Part")`
  const fromNew = matchLibraryCall(init, 'Instance', 'new');
  if (fromNew) return { to: lowerFirst(fromNew), evidence: `assigned from Instance.new("${fromNew}")` };

  // `local http = game:GetService("HttpService")`, and the bracketed spelling
  // `game["GetService"]("HttpService")` that obfuscators prefer.
  if (init && init.type === 'MethodCall' && init.method === 'GetService') {
    const service = firstStringArg(init);
    if (service) return { to: lowerFirst(service), evidence: `assigned from :GetService("${service}")` };
  }
  const fromService = matchLibraryCall(init, 'game', 'GetService');
  if (fromService) {
    return { to: lowerFirst(fromService), evidence: `assigned from game["GetService"]("${fromService}")` };
  }

  // `local module = require(...)`
  if (init && init.type === 'Call' && init.func.type === 'Name' && init.func.name === 'require') {
    return { to: 'module', evidence: 'assigned from require()' };
  }

  // `local success, result = pcall(f)`
  if (init && init.type === 'Call' && init.func.type === 'Name' && ['pcall', 'xpcall'].includes(init.func.name)) {
    if (binding.declIndex === 0) return { to: 'success', evidence: `first result of ${init.func.name}()` };
    if (binding.declIndex === 1) return { to: 'result', evidence: `second result of ${init.func.name}()` };
  }

  // A generic-for variable: `for index, value in pairs(t)`
  if (binding.kind === 'loop') {
    if (binding.loopKind === 'generic') {
      const iter = binding.loopIterator;
      if (iter && ['pairs', 'ipairs', 'next'].includes(iter)) {
        if (binding.loopIndex === 0) return { to: 'index', evidence: `first name of for ... in ${iter}()` };
        if (binding.loopIndex === 1) return { to: 'value', evidence: `second name of for ... in ${iter}()` };
      }
      return null;
    }
    if (binding.loopKind === 'numeric') return { to: 'i', evidence: 'numeric for counter' };
  }

  // `#item` is used, so it is a collection.
  if (binding.reads.some((r) => r.__parent && r.__parent.type === 'Un' && r.__parent.op === '#')) {
    return { to: 'items', evidence: 'used with the length operator' };
  }

  // Built by concatenation.
  if (
    init && init.type === 'Str' &&
    binding.reads.some((r) => r.__parent && r.__parent.type === 'Bin' && r.__parent.op === '..')
  ) {
    return { to: 'text', evidence: 'a string literal used in concatenation' };
  }

  if (init && init.type === 'Bool') return { to: 'flag', evidence: 'assigned a boolean literal' };

  if (binding.kind === 'local-function' || (init && init.type === 'FunctionExpr')) {
    return { to: 'fn', evidence: 'a function value' };
  }

  // Touching `.Parent` or `.Name` means it holds an instance.
  if (binding.reads.some((r) => r.__parent && r.__parent.type === 'Index' && r.__parent.obj === r && r.__parent.keyIsName && ['Parent', 'Name', 'ClassName'].includes(r.__parent.key.value))) {
    return { to: 'instance', evidence: 'used as an instance (.Parent/.Name)' };
  }

  return null;
}

/**
 * `game:GetService("X")` or `game.GetService("X")`, as a name hint.
 *
 * `game["GetService"]("Players")` counts too: obfuscators write the bracketed
 * form precisely because it is harder to read, and a name is no less inferable
 * through a string index than through a dot.
 */
function matchLibraryCall(init, lib, method) {
  if (!init || init.type !== 'Call') return null;
  const target = init.func;
  if (!target || target.type !== 'Index') return null;
  if (target.obj.type !== 'Name' || target.obj.name !== lib) return null;
  const key = target.keyIsName
    ? target.key.value
    : target.key && target.key.type === 'Str'
      ? target.key.value
      : null;
  if (key !== method) return null;
  return firstStringArg(init);
}

function firstStringArg(call) {
  const first = call.args && call.args[0];
  return first && first.type === 'Str' ? first.value : null;
}

/**
 * Rename machine-generated locals.
 *
 * Three things this deliberately does not do:
 *
 *   * it does not touch globals, because a global's name is part of the
 *     program's interface to its environment;
 *   * it does not guess at names it has no evidence for, and says so by using a
 *     neutral `v1`, `v2` instead of inventing something plausible;
 *   * it does not claim the result is the original name. The evidence is in the
 *     report next to every rename, and the header comment of the output says
 *     these names are inferred.
 */
function renameBindings(ast, bindings, report, { renameAll = false } = {}) {
  const taken = allIdentifiers(ast);
  const renames = [];
  let counter = 0;

  // Declarations come first in the binding list, so numbering follows the
  // order they appear in the file, which reads better than declaration order.
  const ordered = [...bindings].sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || (a.col ?? 0) - (b.col ?? 0));

  for (const binding of ordered) {
    if (binding.renamed) continue;
    const eligible = renameAll
      ? binding.kind !== 'global'
      : isGeneratedName(binding.name);
    if (!eligible) continue;
    if (binding.name.startsWith('self')) continue;

    const inference = inferName(binding);
    let target;
    let evidence;
    if (inference) {
      target = inference.to;
      evidence = inference.evidence;
    } else {
      counter += 1;
      target = `v${counter}`;
      evidence = 'no evidence in the code: named neutrally rather than guessed at';
    }

    // Unique across the file: shadowing is legal Lua but makes the output
    // harder to read, and a collision would be a real bug.
    let candidate = target;
    let suffix = 2;
    // A binding keeping its own name is not a collision with itself, which is
    // also what makes running this twice a no-op the second time.
    while ((taken.has(candidate) && candidate !== binding.name) || LUA_KEYWORDS.has(candidate)) {
      candidate = `${target}${suffix}`;
      suffix += 1;
    }
    if (candidate === binding.name) {
      binding.renamed = true;
      continue;
    }
    taken.add(candidate);

    for (const node of [...binding.declarations, ...binding.reads, ...binding.writes]) {
      node.name = candidate;
    }
    binding.renamed = true;
    renames.push({
      from: binding.name,
      to: candidate,
      inferred: Boolean(inference),
      evidence,
      line: binding.line,
    });
  }

  report.renames = renames;
  void ast;
  return renames.length;
}

// ---------------------------------------------------------------------------
// Tree comparison (the safety net)
// ---------------------------------------------------------------------------

/**
 * Compare two trees structurally, ignoring everything that is not the program.
 *
 * Positions change when statements are removed, spellings change when a literal
 * is folded, and binding information is rebuilt each round. None of that is
 * behaviour; everything else is.
 */
function sameTree(a, b, path = '') {
  if (a === b) return null;
  if (a === null || a === undefined || b === null || b === undefined) {
    return `${path || '<root>'}: ${describeValue(a)} vs ${describeValue(b)}`;
  }
  if (typeof a !== 'object' || typeof b !== 'object') {
    return a === b ? null : `${path || '<root>'}: ${describeValue(a)} vs ${describeValue(b)}`;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return `${path}: array vs non-array`;
    // Comments are content, but they are not behaviour, and the generated
    // header adds some. They are compared by nothing here.
    const clean = (list) => list.filter((item) => !(item && item.type === 'CommentStat'));
    const left = clean(a);
    const right = clean(b);
    if (left.length !== right.length) return `${path}: ${left.length} items vs ${right.length}`;
    for (let i = 0; i < left.length; i += 1) {
      const diff = sameTree(left[i], right[i], `${path}[${i}]`);
      if (diff) return diff;
    }
    return null;
  }
  if (a.type !== b.type) return `${path}.type: ${a.type} vs ${b.type}`;

  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (SKIP_KEYS.has(key)) continue;
    const diff = sameTree(a[key], b[key], path ? `${path}.${key}` : key);
    if (diff) return diff;
  }
  return null;
}

function describeValue(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'object') return value.type ? `<${value.type}>` : '<object>';
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export class DeobfuscationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DeobfuscationError';
  }
}

/** A walker that applies `fn` to every statement array in the tree. */
function eachBlock(ast, fn) {
  const visit = (body) => {
    const rewritten = fn(body);
    const list = rewritten || body;
    for (const stat of list) {
      switch (stat.type) {
        case 'IfStat':
          stat.clauses.forEach((c) => visit(c.body));
          if (stat.elseBody) visit(stat.elseBody);
          break;
        case 'WhileStat':
        case 'RepeatStat':
        case 'NumericFor':
        case 'GenericFor':
        case 'DoStat':
          visit(stat.body);
          break;
        case 'LocalFunction':
        case 'FunctionStat':
          visit(stat.func.body);
          break;
        case 'AssignStat':
          stat.exprs.forEach((e) => {
            if (e && e.type === 'FunctionExpr') visit(e.body);
          });
          break;
        default:
          break;
      }
    }
  };
  visit(ast.body);
}

function replaceBlock(body, next) {
  body.length = 0;
  body.push(...next);
  return body;
}

/**
 * Deobfuscate a Luau script.
 *
 * @param {string} source
 * @param {{rename?: boolean, renameAll?: boolean, fold?: boolean, simplify?: boolean, maxPasses?: number}} [options]
 * @returns {{code: string, report: object, detection: object, verification: object}}
 */
export function deobfuscate(source, options = {}) {
  const {
    rename = true,
    renameAll = false,
    fold = true,
    simplify = true,
    maxPasses = MAX_PASSES,
  } = options;

  const parsed = parse(source);
  const ast = { body: parsed.body };
  const detection = detectObfuscation(ast, source, parsed.tokens);

  // The evaluator may only treat `string.char` as the library when `string` is
  // not a local. Computed once, over-broad on purpose: see setShadowedNames.
  setShadowedNames(localNames(ast));

  const stats = {
    folded: 0,
    inlined: 0,
    deadBranches: 0,
    liveBranches: 0,
    deadLoops: 0,
    unwrappedLoops: 0,
    deadDeclarations: 0,
    loadstringsInlined: 0,
    decodedLoops: 0,
    decodedStrings: 0,
    skippedCaptured: 0,
  };
  const report = {
    warnings: [],
    inlinedNames: [],
    loadstrings: [],
    decoded: [],
    renames: [],
    passes: 0,
  };

  const key = () => `${stats.folded}|${stats.inlined}|${stats.deadBranches}|${stats.liveBranches}|${stats.deadLoops}|${stats.unwrappedLoops}|${stats.deadDeclarations}|${stats.loadstringsInlined}|${stats.decodedLoops}`;

  for (let pass = 0; pass < maxPasses; pass += 1) {
    report.passes = pass + 1;
    const before = key();

    if (fold) {
      // Tag parents so a use site can be judged in context, then fold.
      eachBlock(ast, (body) => {
        body.forEach((stat) => foldTree(stat, stats));
        return body;
      });
    }

    if (fold) {
      const scope = analyzeScope(ast);
      // Decode loops first: folding one turns the accumulator into a constant,
      // which is what lets the inline pass collapse `table.concat(out)`.
      eachBlock(ast, (body) => {
        foldDecodeLoops({ body }, scope.bindings, stats, report);
        return body;
      });
      inlineConstants(ast, scope.bindings, stats, report);
      eachBlock(ast, (body) => {
        body.forEach((stat) => foldTree(stat, stats));
        return body;
      });
    }

    if (simplify) {
      const locals = localNames(ast);
      eachBlock(ast, (body) => replaceBlock(body, simplifyBlock(body, stats, report, locals)));
      const scope = analyzeScope(ast);
      eachBlock(ast, (body) => replaceBlock(body, dropDeadDeclarations(body, stats, scope)));
    }

    if (key() === before) break;
  }

  if (rename) renameBindings(ast, analyzeScope(ast).bindings, report, { renameAll });

  // Nothing to do: hand the source back as written.
  //
  // Reprinting an untouched file would still rewrite its layout — tabs to two
  // spaces, short tables onto one line — and a tool whose answer for clean code
  // is "here is your file, reformatted" is a tool people stop running over
  // their repository. The output is byte-identical apart from the header.
  // The one thing the shortcut would lose is escape decoding: `"\x48\x65\x6c"`
  // is `"Hel"` in the tree, so printing is what makes a reader able to read it,
  // and returning the source as written would keep the escapes. A literal only
  // counts as encoded when it is *mostly* escapes — the same measure the
  // detector uses — so `"\n%s.%s:"` in a format string and `' "'` in a message
  // do not force a reprint of an otherwise untouched file.
  // The one thing the shortcut would lose is escape decoding: `"\x48\x65\x6c"`
  // is `"Hel"` in the tree, so printing is what makes a reader able to read it,
  // and returning the source as written would keep the escapes. A literal only
  // counts as encoded when it is *mostly* escapes — the same measure the
  // detector uses — so `"\n%s.%s:"` in a format string and `' "'` in a message
  // do not force a reprint of an otherwise untouched file.
  const escapedLiterals = parsed.tokens.filter(
    (token) => token.type === 'string' && escapeDensity(source.slice(token.start, token.end)) > 0.3,
  ).length;
  stats.decodedStrings = escapedLiterals;
  const respelled = escapedLiterals > 0;

  const changed =
    Object.entries(stats).some(([k, v]) => v > 0 && k !== 'skippedCaptured') ||
    report.renames.length > 0;

  if (!changed) {
    const head = buildHeader(detection, report, stats);
    return {
      code: `${head}\n${source.replace(/^\uFEFF/, '')}`,
      report: {
        ...report,
        transformations: stats,
        changed: false,
      },
      detection,
      verification: {
        outputReparses: true,
        treeMatchesOutput: true,
        unchanged: true,
        note: 'No transformation applied, so the source was returned as written. It was ' +
          'parsed (the analysis ran on the real tree) and is byte-identical apart from the header.',
      },
    };
  }

  const header = buildHeader(detection, report, stats);
  const code = print(ast, { header });

  // --- the safety net ------------------------------------------------------
  let reparsed;
  try {
    reparsed = parse(code);
  } catch (err) {
    const failure = new DeobfuscationError(
      `the deobfuscated output does not parse (${err.message}). The transform is ` +
        'buggy; refusing to emit code that will not run. Please report this with the input.',
    );
    failure.code = code;
    throw failure;
  }
  const difference = sameTree(ast.body, reparsed.body, 'body');
  if (difference) {
    const failure = new DeobfuscationError(
      `the deobfuscated output does not mean the same thing as the code that produced it ` +
        `(${difference}). Refusing to emit it. Please report this with the input.`,
    );
    failure.code = code;
    throw failure;
  }

  return {
    code,
    report: {
      ...report,
      transformations: stats,
      changed,
    },
    detection,
    verification: {
      outputReparses: true,
      treeMatchesOutput: true,
      note:
        'The output was re-parsed and compared with the tree it was printed from. That catches ' +
        'a broken transform; it does not prove the transform preserved behaviour, which rests ' +
        'on the per-pass rules documented in this file.',
    },
  };
}

/** The header written above generated output, so the provenance travels with it. */
function buildHeader(detection, report, stats) {
  const touched =
    Object.entries(stats).some(([k, v]) => v > 0 && k !== 'skippedCaptured') || report.renames.length > 0;
  if (!touched) {
    return detection.obfuscated
      ? '-- Checked by studio-cli (studio deobfuscate): obfuscation found, but nothing here\n' +
          '-- could be reversed automatically. See studio deobfuscate --detect.'
      : '-- Checked by studio-cli (studio deobfuscate): nothing to change.';
  }
  const lines = [
    '-- Deobfuscated by studio-cli (studio deobfuscate).',
    '--',
    '-- Constants were folded, dead branches removed, and machine-generated local names',
    '-- replaced. Renamed variables are INFERRED from how they are used, not recovered:',
    '-- an obfuscator discards the original names and nothing can bring them back.',
  ];
  if (detection.irreversible.length > 0) {
    lines.push('--');
    lines.push(`-- NOT undone: ${detection.irreversible.join(', ')}.`);
    lines.push('-- See the report for what that means; this file was not fully reversed.');
  }
  const summary = [];
  if (stats.decodedStrings) summary.push(`${stats.decodedStrings} escape-encoded string(s) decoded`);
  if (stats.folded) summary.push(`${stats.folded} constant fold(s)`);
  if (stats.inlined) summary.push(`${stats.inlined} inlined value(s)`);
  if (stats.deadBranches + stats.liveBranches) {
    summary.push(`${stats.deadBranches + stats.liveBranches} branch(es) resolved`);
  }
  if (stats.loadstringsInlined) summary.push(`${stats.loadstringsInlined} loadstring inline(s)`);
  if (stats.decodedLoops) summary.push(`${stats.decodedLoops} decode loop(s) run and folded`);
  if (report.renames.length) summary.push(`${report.renames.length} rename(s)`);
  if (summary.length > 0) {
    lines.push('--');
    lines.push(`-- ${summary.join(', ')}.`);
  }
  return lines.join('\n');
}


