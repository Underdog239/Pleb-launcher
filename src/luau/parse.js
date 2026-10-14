// A Luau parser, producing an AST with source positions.
//
// The existing analyser works at the token level, which is the right call for
// "is this property name spelled correctly" — it never needs to know the shape
// of the program. Deobfuscation cannot work that way. Renaming a variable
// requires knowing which scope a name belongs to, whether it is a local or a
// global, whether a nested function captures it; folding requires knowing
// operator precedence and where a sub-expression ends; removing a dead branch
// requires knowing where the branch ends. All of that is the parser's job.
//
// Two rules shape the design:
//
//   * **Conservative over clever.** Anything outside the grammar it implements
//     is a loud ParseError with a position, never a guess. A deobfuscator that
//     silently mangles a script is worse than one that refuses to run.
//   * **Faithful round-trip.** Literals keep their original spelling (`0x1F`
//     stays hex, `'a'` stays single-quoted), explicit parentheses are preserved
//     as nodes, and Luau type annotations are captured verbatim rather than
//     re-printed from a model. `parse` then `print` reproduces the input token
//     stream for any file this parser accepts, which is asserted in the tests.

import { tokenize } from './lexer.js';

export class ParseError extends Error {
  constructor(message, token) {
    const where = token ? ` at line ${token.line}, column ${token.col}` : '';
    super(`${message}${where}`);
    this.name = 'ParseError';
    this.line = token ? token.line : null;
    this.col = token ? token.col : null;
  }
}

// Lua's binary operator priorities, as (left, right). Right-bound operators
// have a smaller right value, which is what makes `a .. b .. c` group to the
// right and `a - b - c` group to the left.
const BINARY = {
  or: [1, 1],
  and: [2, 2],
  '<': [3, 3],
  '>': [3, 3],
  '<=': [3, 3],
  '>=': [3, 3],
  '~=': [3, 3],
  '==': [3, 3],
  '|': [4, 4],
  '~': [5, 5],
  '&': [6, 6],
  '<<': [7, 7],
  '>>': [7, 7],
  '..': [9, 8],
  '+': [10, 10],
  '-': [10, 10],
  '*': [11, 11],
  '/': [11, 11],
  '//': [11, 11],
  '%': [11, 11],
  '^': [14, 13],
};

/** Priority of a unary operator's operand. */
export const UNARY_PRIORITY = 12;

const COMPOUND_OPS = new Set(['+=', '-=', '*=', '/=', '%=', '^=', '..=']);
const BLOCK_ENDERS = new Set(['end', 'else', 'elseif', 'until']);

/**
 * Parse Luau source.
 *
 * @param {string} source
 * @returns {{body: Array<object>, tokens: Array<object>}}
 */
export function parse(source) {
  const { tokens, errors } = tokenize(source);
  if (errors.length > 0) {
    const first = errors[0];
    throw new ParseError(`the source does not tokenize: ${first.message}`, {
      line: first.line,
      col: first.col,
    });
  }

  // Comments are trivia to the grammar, but they are content to a reader, and a
  // tool that silently deletes every comment in a file is losing data. They are
  // lifted out here and put back as statements in their original positions.
  const comments = [];
  const code = [];
  for (const token of tokens) {
    if (token.type === 'comment') comments.push(token);
    else code.push(token);
  }

  const p = new Parser(code);
  const body = p.parseBlock(new Set());
  p.skipSemis();
  if (!p.at('eof')) throw p.error(`unexpected ${p.describe()}, expected end of file`);
  attachComments(body, comments);
  return { body, tokens };
}

/** The nested statement blocks of a statement, in source order. */
function childBlocks(stat) {
  switch (stat.type) {
    case 'IfStat': {
      const blocks = stat.clauses.map((c) => c.body);
      if (stat.elseBody) blocks.push(stat.elseBody);
      return blocks;
    }
    case 'WhileStat':
    case 'DoStat':
    case 'RepeatStat':
    case 'NumericFor':
    case 'GenericFor':
      return [stat.body];
    case 'LocalFunction':
    case 'FunctionStat':
      return [stat.func.body];
    case 'AssignStat':
      return stat.exprs.filter((e) => e && e.type === 'FunctionExpr').map((e) => e.body);
    default:
      return [];
  }
}

/**
 * Put comments back into the tree, in source order.
 *
 * Each comment is inserted before the first statement that begins after it,
 * searching the whole tree depth-first. A comment sitting at the end of a block
 * therefore lands before the next statement outside that block rather than
 * inside it — the text is kept either way, and the alternative is tracking the
 * line each block ends on.
 */
function attachComments(body, comments) {
  if (comments.length === 0) return;

  const entries = [];
  const collect = (block) => {
    for (let i = 0; i < block.length; i += 1) {
      const stat = block[i];
      entries.push({ block, index: i, line: stat.line });
      for (const nested of childBlocks(stat)) collect(nested);
    }
  };
  collect(body);

  const insertions = new Map();
  const trailing = [];
  for (const comment of comments) {
    const target = entries.find((e) => e.line > comment.line);
    const node = { type: 'CommentStat', text: comment.value, line: comment.line, col: comment.col };
    if (!target) {
      trailing.push(node);
      continue;
    }
    if (!insertions.has(target.block)) insertions.set(target.block, new Map());
    const byIndex = insertions.get(target.block);
    if (!byIndex.has(target.index)) byIndex.set(target.index, []);
    byIndex.get(target.index).push(node);
  }

  for (const [block, byIndex] of insertions) {
    const rebuilt = [];
    for (let i = 0; i < block.length; i += 1) {
      const before = byIndex.get(i);
      if (before) rebuilt.push(...before);
      rebuilt.push(block[i]);
    }
    block.length = 0;
    block.push(...rebuilt);
  }
  if (trailing.length > 0) body.push(...trailing);
}

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.i = 0;
  }

  // --- primitives -----------------------------------------------------------

  peek(offset = 0) {
    return this.tokens[Math.min(this.i + offset, this.tokens.length - 1)];
  }

  next() {
    return this.tokens[this.i++];
  }

  at(type, value = null) {
    const t = this.peek();
    return t.type === type && (value === null || t.value === value);
  }

  atOp(value) {
    return this.at('op', value);
  }

  atKw(value) {
    return this.at('keyword', value);
  }

  describe(offset = 0) {
    const t = this.peek(offset);
    if (t.type === 'eof') return 'end of file';
    return `${JSON.stringify(t.value)}`;
  }

  error(message) {
    return new ParseError(message, this.peek());
  }

  acceptOp(value) {
    if (this.atOp(value)) {
      this.next();
      return true;
    }
    return false;
  }

  acceptKw(value) {
    if (this.atKw(value)) {
      this.next();
      return true;
    }
    return false;
  }

  expectOp(value) {
    if (!this.atOp(value)) throw this.error(`expected ${JSON.stringify(value)}, found ${this.describe()}`);
    return this.next();
  }

  expectKw(value) {
    if (!this.atKw(value)) throw this.error(`expected ${JSON.stringify(value)}, found ${this.describe()}`);
    return this.next();
  }

  expectName() {
    if (!this.at('ident')) throw this.error(`expected a name, found ${this.describe()}`);
    return this.next();
  }

  skipSemis() {
    while (this.atOp(';')) this.next();
  }

  // --- blocks and statements ------------------------------------------------

  /**
   * Statements until one of `enders` or a block keyword (`end`, `else`, ...).
   * An empty set means "until end of file".
   */
  parseBlock(enders) {
    const body = [];
    for (;;) {
      this.skipSemis();
      const t = this.peek();
      if (t.type === 'eof') break;
      if (t.type === 'keyword' && BLOCK_ENDERS.has(t.value)) break;
      if (enders.has(t.value)) break;
      body.push(this.parseStatement());
    }
    return body;
  }

  parseStatement() {
    const t = this.peek();

    if (t.type === 'keyword') {
      switch (t.value) {
        case 'if':
          return this.parseIf();
        case 'while':
          return this.parseWhile();
        case 'repeat':
          return this.parseRepeat();
        case 'for':
          return this.parseFor();
        case 'do':
          return this.parseDo();
        case 'function':
          return this.parseNamedFunction();
        case 'local':
          return this.parseLocal();
        case 'return':
          return this.parseReturn();
        case 'break':
          this.next();
          return { type: 'BreakStat', line: t.line, col: t.col };
        case 'continue':
          this.next();
          return { type: 'ContinueStat', line: t.line, col: t.col };
        case 'type':
          return this.parseTypeDeclaration(false);
        case 'export':
          // `export type X = ...`. Anything else beginning with `export` is an
          // error in this grammar, and saying so beats guessing.
          if (this.atKw('type', 1)) return this.parseTypeDeclaration(true);
          throw this.error(`unsupported statement: ${this.describe()}`);
        default:
          throw this.error(`unexpected keyword ${t.value} at the start of a statement`);
      }
    }

    // Luau attributes: `@native`, `@checked`, and whatever comes next.
    if (t.type === 'op' && t.value === '@') return this.parseAttributed();

    return this.parseExpressionStatement();
  }

  /** `@attribute` lines, kept verbatim and attached to the following statement. */
  parseAttributed() {
    const attributes = [];
    while (this.atOp('@')) {
      this.next();
      const name = this.expectName();
      attributes.push(`@${name.value}`);
    }
    const statement = this.parseStatement();
    statement.attributes = [...attributes, ...(statement.attributes || [])];
    return statement;
  }

  parseIf() {
    const start = this.expectKw('if');
    const clauses = [];
    const cond = this.parseExpression();
    this.expectKw('then');
    const body = this.parseBlock(new Set());
    clauses.push({ cond, body, line: start.line });
    while (this.atKw('elseif')) {
      const kw = this.next();
      const c = this.parseExpression();
      this.expectKw('then');
      clauses.push({ cond: c, body: this.parseBlock(new Set()), line: kw.line });
    }
    let elseBody = null;
    if (this.acceptKw('else')) elseBody = this.parseBlock(new Set());
    this.expectKw('end');
    return { type: 'IfStat', clauses, elseBody, line: start.line, col: start.col };
  }

  parseWhile() {
    const start = this.expectKw('while');
    const cond = this.parseExpression();
    this.expectKw('do');
    const body = this.parseBlock(new Set());
    this.expectKw('end');
    return { type: 'WhileStat', cond, body, line: start.line, col: start.col };
  }

  parseRepeat() {
    const start = this.expectKw('repeat');
    const body = this.parseBlock(new Set(['until']));
    this.expectKw('until');
    const cond = this.parseExpression();
    return { type: 'RepeatStat', body, cond, line: start.line, col: start.col };
  }

  parseFor() {
    const start = this.expectKw('for');
    const first = this.expectName();
    if (this.atOp('=')) {
      this.next();
      const from = this.parseExpression();
      this.expectOp(',');
      const to = this.parseExpression();
      let step = null;
      if (this.acceptOp(',')) step = this.parseExpression();
      this.expectKw('do');
      const body = this.parseBlock(new Set());
      this.expectKw('end');
      return {
        type: 'NumericFor',
        name: { name: first.value, line: first.line, col: first.col },
        from,
        to,
        step,
        body,
        line: start.line,
        col: start.col,
      };
    }

    const names = [{ name: first.value, line: first.line, col: first.col }];
    while (this.acceptOp(',')) {
      const n = this.expectName();
      names.push({ name: n.value, line: n.line, col: n.col });
    }
    this.expectKw('in');
    const exprs = this.parseExpressionList();
    this.expectKw('do');
    const body = this.parseBlock(new Set());
    this.expectKw('end');
    return { type: 'GenericFor', names, exprs, body, line: start.line, col: start.col };
  }

  parseDo() {
    const start = this.expectKw('do');
    const body = this.parseBlock(new Set());
    this.expectKw('end');
    return { type: 'DoStat', body, line: start.line, col: start.col };
  }

  parseNamedFunction() {
    const start = this.expectKw('function');
    // `function a.b.c:m()` is sugar for an assignment; the target is kept as a
    // normal LVALUE chain so renaming treats it exactly like `a.b.c.m = ...`.
    let target = { type: 'Name', name: this.expectName().value, line: start.line, col: start.col };
    let isMethod = false;
    for (;;) {
      if (this.acceptOp('.')) {
        const key = this.expectName();
        target = { type: 'Index', obj: target, key: { type: 'Str', value: key.value, raw: null }, keyIsName: true, line: key.line, col: key.col };
        continue;
      }
      if (this.acceptOp(':')) {
        const key = this.expectName();
        target = { type: 'Index', obj: target, key: { type: 'Str', value: key.value, raw: null }, keyIsName: true, line: key.line, col: key.col };
        isMethod = true;
        break;
      }
      break;
    }
    const fn = this.parseFunctionBody(start, isMethod);
    // Kept as its own node rather than desugared to `target = function ...`,
    // so that printing reproduces the declaration form the file was written in.
    return { type: 'FunctionStat', target, func: fn, isMethod, line: start.line, col: start.col };
  }

  parseLocal() {
    const start = this.expectKw('local');
    if (this.atKw('function')) {
      this.next();
      const name = this.expectName();
      const fn = this.parseFunctionBody(name, false);
      return {
        type: 'LocalFunction',
        name: { name: name.value, line: name.line, col: name.col },
        func: fn,
        line: start.line,
        col: start.col,
      };
    }

    const names = [];
    for (;;) {
      const n = this.expectName();
      const entry = { name: n.value, line: n.line, col: n.col, typeRaw: null };
      if (this.atOp(':')) {
        this.next();
        entry.typeRaw = this.scanType(this.TYPE_END_STAT);
      }
      names.push(entry);
      if (!this.acceptOp(',')) break;
    }
    let exprs = [];
    if (this.acceptOp('=')) exprs = this.parseExpressionList();
    return { type: 'LocalStat', names, exprs, line: start.line, col: start.col };
  }

  parseReturn() {
    const start = this.expectKw('return');
    // `return` may be followed by the end of the block, a `;`, or nothing.
    const t = this.peek();
    const naked =
      t.type === 'eof' ||
      t.type === 'op' === true && false ||
      (t.type === 'keyword' && BLOCK_ENDERS.has(t.value)) ||
      this.atOp(';');
    if (naked) return { type: 'ReturnStat', exprs: [], line: start.line, col: start.col };
    const exprs = this.parseExpressionList();
    this.acceptOp(';');
    return { type: 'ReturnStat', exprs, line: start.line, col: start.col };
  }

  parseTypeDeclaration(isExport) {
    const start = this.expectKw('type');
    // Type declarations are preserved exactly as written. Re-printing a type
    // from a model would be a second implementation of Luau's type grammar,
    // with its own bugs, for no benefit: nothing here rewrites types.
    const raw = this.captureUntilStatementEnd();
    return {
      type: 'TypeStat',
      raw: `${isExport ? 'export ' : ''}type ${raw}`,
      line: start.line,
      col: start.col,
    };
  }

  parseExpressionStatement() {
    const start = this.peek();
    const first = this.parsePrefixExpression();

    if (this.atOp(',') || this.atOp('=')) {
      const targets = [first];
      while (this.acceptOp(',')) targets.push(this.parsePrefixExpression());
      for (const t of targets) {
        if (t.type !== 'Name' && t.type !== 'Index') {
          throw new ParseError('cannot assign to this expression', this.peek());
        }
      }
      this.expectOp('=');
      const exprs = this.parseExpressionList();
      return { type: 'AssignStat', targets, exprs, line: start.line, col: start.col };
    }

    if (this.peek().type === 'op' && COMPOUND_OPS.has(this.peek().value)) {
      const op = this.next().value;
      if (first.type !== 'Name' && first.type !== 'Index') {
        throw new ParseError('cannot assign to this expression', start);
      }
      const expr = this.parseExpression();
      return { type: 'CompoundStat', target: first, op, expr, line: start.line, col: start.col };
    }

    if (first.type === 'Call' || first.type === 'MethodCall') {
      return { type: 'CallStat', call: first, line: start.line, col: start.col };
    }

    throw new ParseError(
      'this expression is not a statement (only calls and assignments are)',
      start,
    );
  }

  // --- functions ------------------------------------------------------------

  parseFunctionBody(startToken, isMethod) {
    const generics = this.scanGenerics();
    this.expectOp('(');
    const params = [];
    let vararg = false;
    if (!this.atOp(')')) {
      for (;;) {
        if (this.atOp('...')) {
          this.next();
          vararg = true;
          break;
        }
        const n = this.expectName();
        const param = { name: n.value, line: n.line, col: n.col, typeRaw: null };
        if (this.atOp(':')) {
          this.next();
          param.typeRaw = this.scanType(this.TYPE_END_PARAM);
        }
        params.push(param);
        if (!this.acceptOp(',')) break;
      }
    }
    this.expectOp(')');
    let returnTypeRaw = null;
    if (this.atOp(':')) {
      this.next();
      returnTypeRaw = this.scanType(this.TYPE_END_RETURN);
    }
    const body = this.parseBlock(new Set());
    this.expectKw('end');
    return {
      type: 'FunctionExpr',
      params,
      vararg,
      body,
      generics,
      returnTypeRaw,
      isMethod,
      line: startToken.line,
      col: startToken.col,
    };
  }

  /** `<T, U>` on a function declaration; kept verbatim. */
  scanGenerics() {
    if (!this.atOp('<')) return null;
    const save = this.i;
    const text = this.captureBalanced('<', '>');
    if (text === null) {
      this.i = save;
      return null;
    }
    return text;
  }

  // --- expressions ----------------------------------------------------------

  parseExpressionList() {
    const exprs = [this.parseExpression()];
    while (this.acceptOp(',')) exprs.push(this.parseExpression());
    return exprs;
  }

  /** `subexpr(limit)` from Lua's grammar, plus Luau's if-else and casts. */
  parseSubExpression(limit) {
    let left;
    const t = this.peek();

    const unaryOp =
      t.type === 'op' && (t.value === '-' || t.value === '#' || t.value === '~')
        ? t.value
        : t.type === 'keyword' && t.value === 'not'
          ? 'not'
          : null;

    if (unaryOp) {
      this.next();
      const operand = this.parseSubExpression(UNARY_PRIORITY);
      // Lua folds a minus on a numeric constant into the constant itself, and
      // this has to match for printing to round-trip: `-2` printed from
      // Un('-', 2) would re-parse as Un('-', 2), but a folded `7 % -3` is a
      // negative number and printing it as `-2` would come back as a unary
      // expression instead. `-a ^ 2` is unaffected, because there the operand
      // is a Bin, not a literal.
      if (unaryOp === '-' && operand.type === 'Number') {
        left = {
          type: 'Number',
          value: -operand.value,
          raw: operand.raw != null ? `-${operand.raw}` : null,
          line: t.line,
          col: t.col,
        };
      } else {
        left = { type: 'Un', op: unaryOp, operand, line: t.line, col: t.col };
      }
    } else if (t.type === 'keyword' && t.value === 'if') {
      left = this.parseIfExpression();
    } else {
      left = this.parseSimpleExpression();
    }

    for (;;) {
      const op = this.next();
      const token = op;
      if (op.type === 'op' && op.value === '::') {
        const typeRaw = this.scanType(this.TYPE_END_CAST);
        left = { type: 'Cast', expr: left, typeRaw, line: token.line, col: token.col };
        continue;
      }
      const key = token.type === 'op' || token.type === 'keyword' ? token.value : null;
      const pri = key && Object.prototype.hasOwnProperty.call(BINARY, key) ? BINARY[key] : null;
      if (!pri || pri[0] <= limit) {
        this.i -= 1;
        break;
      }
      // `this.next()` above already consumed the operator; the cursor is on
      // the first token of the right operand. Advancing again here skipped it.
      const right = this.parseSubExpression(pri[1]);
      left = { type: 'Bin', op: key, left, right, line: token.line, col: token.col };
    }
    return left;
  }

  parseExpression() {
    return this.parseSubExpression(0);
  }

  parseIfExpression() {
    const start = this.expectKw('if');
    const cond = this.parseExpression();
    this.expectKw('then');
    const thenExpr = this.parseExpression();
    let elseExpr = null;
    if (this.acceptKw('elseif')) {
      // `if a then b elseif c then d else e` — re-parse the elseif tail.
      this.i -= 1;
      elseExpr = this.parseIfExpression();
    } else {
      this.expectKw('else');
      elseExpr = this.parseExpression();
    }
    return { type: 'IfExpr', cond, thenExpr, elseExpr, line: start.line, col: start.col };
  }

  parseSimpleExpression() {
    const t = this.peek();
    switch (t.type) {
      case 'number':
        this.next();
        return { type: 'Number', value: t.value, raw: t.text ?? String(t.value), line: t.line, col: t.col };
      case 'string':
        this.next();
        return { type: 'Str', value: t.value, raw: null, line: t.line, col: t.col };
      case 'interpolated':
        this.next();
        return { type: 'Interp', raw: t.value, line: t.line, col: t.col };
      case 'keyword':
        if (t.value === 'nil') {
          this.next();
          return { type: 'Nil', line: t.line, col: t.col };
        }
        if (t.value === 'true' || t.value === 'false') {
          this.next();
          return { type: 'Bool', value: t.value === 'true', line: t.line, col: t.col };
        }
        if (t.value === 'function') {
          this.next();
          return this.parseFunctionBody(t, false);
        }
        break;
      default:
        break;
    }
    if (t.type === 'op') {
      if (t.value === '...') {
        this.next();
        return { type: 'Vararg', line: t.line, col: t.col };
      }
      if (t.value === '{') return this.parseTable();
    }
    return this.parsePrefixExpression();
  }

  parseTable() {
    const start = this.expectOp('{');
    const fields = [];
    let trailingSep = null;
    while (!this.atOp('}')) {
      const t = this.peek();

      if (t.type === 'op' && t.value === '[') {
        this.next();
        const key = this.parseExpression();
        this.expectOp(']');
        this.expectOp('=');
        fields.push({ kind: 'index', key, value: this.parseExpression(), line: t.line });
      } else if (t.type === 'ident' && this.peek(1).type === 'op' && this.peek(1).value === '=') {
        const name = this.next();
        this.next();
        fields.push({
          kind: 'name',
          key: name.value,
          value: this.parseExpression(),
          line: name.line,
        });
      } else {
        fields.push({ kind: 'array', value: this.parseExpression(), line: t.line });
      }

      const sep = this.peek();
      if (sep.type === 'op' && (sep.value === ',' || sep.value === ';')) {
        trailingSep = sep.value;
        this.next();
      } else {
        trailingSep = null;
        break;
      }
    }
    this.expectOp('}');
    return { type: 'Table', fields, trailingSep, line: start.line, col: start.col };
  }

  /**
   * A prefix expression: a name, `(expr)`, or one of those with suffixes
   * (`.name`, `[expr]`, `(args)`, `"str"`, `{table}`, `:name(args)`).
   */
  parsePrefixExpression() {
    let expr;
    const t = this.peek();

    if (t.type === 'ident') {
      this.next();
      expr = { type: 'Name', name: t.value, line: t.line, col: t.col };
    } else if (t.type === 'op' && t.value === '(') {
      this.next();
      const inner = this.parseExpression();
      this.expectOp(')');
      expr = { type: 'Paren', expr: inner, line: t.line, col: t.col };
    } else {
      throw this.error(`expected an expression, found ${this.describe()}`);
    }

    for (;;) {
      const s = this.peek();
      if (s.type === 'op' && s.value === '.') {
        this.next();
        const key = this.expectName();
        expr = {
          type: 'Index',
          obj: expr,
          key: { type: 'Str', value: key.value, raw: null, line: key.line, col: key.col },
          keyIsName: true,
          line: s.line,
          col: s.col,
        };
        continue;
      }
      if (s.type === 'op' && s.value === '[') {
        this.next();
        const key = this.parseExpression();
        this.expectOp(']');
        expr = { type: 'Index', obj: expr, key, keyIsName: false, line: s.line, col: s.col };
        continue;
      }
      if (s.type === 'op' && s.value === ':') {
        this.next();
        const key = this.expectName();
        const args = this.parseCallArguments();
        expr = {
          type: 'MethodCall',
          obj: expr,
          method: key.value,
          args,
          line: s.line,
          col: s.col,
        };
        continue;
      }
      if (s.type === 'string' || s.type === 'interpolated' || (s.type === 'op' && s.value === '{')) {
        // `f"str"` and `f{...}` are calls with one argument.
        const args = this.parseCallArguments();
        expr = { type: 'Call', func: expr, args, line: s.line, col: s.col };
        continue;
      }
      if (s.type === 'op' && s.value === '(') {
        const args = this.parseCallArguments();
        expr = { type: 'Call', func: expr, args, line: s.line, col: s.col };
        continue;
      }
      break;
    }

    return expr;
  }

  /** `(a, b)`, `"str"`, `{...}` — the three argument forms. */
  parseCallArguments() {
    const t = this.peek();
    if (t.type === 'op' && t.value === '(') {
      this.next();
      const args = [];
      if (!this.atOp(')')) args.push(...this.parseExpressionList());
      this.expectOp(')');
      return args;
    }
    if (t.type === 'string') {
      this.next();
      return [{ type: 'Str', value: t.value, raw: null, line: t.line, col: t.col }];
    }
    if (t.type === 'interpolated') {
      this.next();
      return [{ type: 'Interp', raw: t.value, line: t.line, col: t.col }];
    }
    if (t.type === 'op' && t.value === '{') return [this.parseTable()];
    throw this.error(`expected call arguments, found ${this.describe()}`);
  }

  // --- verbatim type capture ------------------------------------------------

  /**
   * Consume tokens making up a type annotation and return the source text.
   *
   * Types are captured, never rebuilt. The scanner tracks bracket nesting and
   * stops at a token that cannot continue a type at depth zero for the position
   * it is in, which is why there is one end-set per syntactic position rather
   * than a single rule.
   */
  scanType(endSet) {
    const parts = [];
    let depth = 0;
    const startIndex = this.i;
    while (!this.at('eof')) {
      const t = this.peek();
      const isOpen = t.type === 'op' && (t.value === '(' || t.value === '{' || t.value === '[' || t.value === '<');
      const isClose = t.type === 'op' && (t.value === ')' || t.value === '}' || t.value === ']' || t.value === '>');
      if (depth === 0 && endSet.has(`${t.type}:${t.value}`)) break;
      if (isOpen) depth += 1;
      else if (isClose) {
        if (depth === 0) break;
        depth -= 1;
      }
      parts.push(t.value);
      this.next();
    }
    if (parts.length === 0) throw this.error('expected a type annotation');
    void startIndex;
    return joinTypeTokens(parts);
  }

  /** Tokens up to the end of the current statement, for verbatim capture. */
  captureUntilStatementEnd() {
    const parts = [];
    while (!this.at('eof')) {
      const t = this.peek();
      if (t.type === 'keyword' && BLOCK_ENDERS.has(t.value)) break;
      if (t.type === 'op' && t.value === ';') break;
      parts.push(t.value);
      this.next();
    }
    return joinTypeTokens(parts);
  }

  /** Capture a balanced `<...>` run, or null if it does not balance. */
  captureBalanced(open, close) {
    if (!this.atOp(open)) return null;
    const parts = [];
    let depth = 0;
    while (!this.at('eof')) {
      const t = this.next();
      if (t.type === 'op' && t.value === open) depth += 1;
      if (t.type === 'op' && t.value === close) {
        depth -= 1;
        parts.push(t.value);
        if (depth === 0) return joinTypeTokens(parts);
        continue;
      }
      if (t.type === 'keyword' || t.type === 'eof') return null;
      parts.push(t.value);
    }
    return null;
  }

  // End-sets, one per position a type can appear in.
  get TYPE_END_STAT() {
    return new Set(['op:=', 'op:,', 'keyword:do', 'keyword:then', 'op:;', 'keyword:end']);
  }

  get TYPE_END_PARAM() {
    return new Set(['op:,', 'op:)']);
  }

  get TYPE_END_RETURN() {
    // A return type runs until the function body actually starts.
    return new Set(['keyword:end']);
  }

  get TYPE_END_CAST() {
    // A cast binds tighter than any binary operator, so it ends at one.
    return new Set([
      'op:,', 'op:)', 'op:]', 'op:}', 'op:;', 'op:..', 'op:+', 'op:-', 'op:*', 'op:/',
      'op:%', 'op:^', 'op://', 'op:==', 'op:~=', 'op:<', 'op:>', 'op:<=', 'op:>=',
      'keyword:then', 'keyword:do', 'keyword:end', 'keyword:else',
    ]);
  }
}

/** Re-join token text the way Luau would spell it, with sensible spacing. */
function joinTypeTokens(parts) {
  let out = '';
  for (const part of parts) {
    if (out.length === 0) {
      out = part;
      continue;
    }
    const last = out[out.length - 1];
    const needsSpace =
      /[A-Za-z0-9_]$/.test(last) && /^[A-Za-z0-9_]/.test(part) && !/^[?(]/.test(part);
    out += needsSpace ? ` ${part}` : part;
  }
  // Normalise the spacing of the punctuation that always reads better tight.
  return out
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s*:\s*/g, ': ')
    .replace(/\(\s*/g, '(')
    .replace(/\s*\)/g, ')')
    .replace(/\s*\?\s*/g, '?')
    .replace(/\s*\.\s*\.\s*\.\s*/g, '...');
}
