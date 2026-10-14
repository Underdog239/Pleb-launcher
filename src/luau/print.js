// Print a Luau AST back to source.
//
// The printer has one obligation that outranks style: the text it produces must
// parse back to the same tree. That is the safety property the deobfuscator
// depends on, because a transformation that produces code the parser reads
// differently has silently changed what the program does.
//
// So parentheses are added by priority — a child is wrapped whenever its
// priority is lower than the priority its position demands — rather than by
// trusting the tree's shape. Two operators get special handling: `..` and `^`
// are right-associative, so their left operand must be wrapped at equal
// priority, and unary `-` is spaced when its operand also starts with `-`,
// since `--` begins a comment.
//
// Literals keep the spelling they were parsed with (`0x1F` stays hex, `'a'`
// stays single-quoted) so that re-printing an untouched file is a no-op.

const PRIORITY = {
  or: 1,
  and: 2,
  '<': 3, '>': 3, '<=': 3, '>=': 3, '~=': 3, '==': 3,
  '|': 4,
  '~': 5,
  '&': 6,
  '<<': 7, '>>': 7,
  '..': 9,
  '+': 10, '-': 10,
  '*': 11, '/': 11, '//': 11, '%': 11,
  '^': 14,
};

/** Right-associative operators: the left operand needs a wrapping at equality. */
const RIGHT_ASSOCIATIVE = new Set(['..', '^']);

const UNARY_PRIORITY = 12;

/** Escape a string value as a double-quoted Luau literal. */
export function escapeString(value) {
  let out = '"';
  for (const ch of String(value)) {
    const code = ch.codePointAt(0);
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 32 || code === 127) {
      // Three digits always, so `\1` followed by `2` cannot become `\12`.
      out += `\\${String(code).padStart(3, '0')}`;
    } else out += ch;
  }
  return `${out}"`;
}

/** Format a number so that reading it back yields the same double. */
export function formatNumber(value) {
  if (Object.is(value, -0)) return '-0';
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
  const text = String(value);
  // Lua accepts `1e+30`; it does not accept `Infinity` or `NaN`, and folding
  // must never produce them, so they are reported rather than printed.
  return text;
}

/** True when a value can be printed as a number literal at all. */
export function isPrintableNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Is this expression usable directly as a prefix (`f(...)`, `x.y`, `x[i]`)? */
function isPrefixShaped(node) {
  return (
    node.type === 'Name' ||
    node.type === 'Index' ||
    node.type === 'Call' ||
    node.type === 'MethodCall' ||
    node.type === 'Paren'
  );
}

/** Print an expression, wrapping it if its priority is below `minPriority`. */
function printExpr(node, minPriority = 0, indent = 0) {
  const { text, priority } = render(node, indent);
  if (priority < minPriority) return `(${text})`;
  return text;
}

/** An expression in object position: `(x)` for anything that is not a prefix. */
function printObject(node, indent) {
  if (isPrefixShaped(node)) return printExpr(node, 0, indent);
  return `(${render(node, indent).text})`;
}

function render(node, indent) {
  switch (node.type) {
    case 'Nil':
      return { text: 'nil', priority: 100 };
    case 'Bool':
      return { text: node.value ? 'true' : 'false', priority: 100 };
    case 'Vararg':
      return { text: '...', priority: 100 };
    case 'Number':
      return { text: node.raw != null ? node.raw : formatNumber(node.value), priority: 100 };
    case 'Str':
      return { text: node.raw != null ? node.raw : escapeString(node.value), priority: 100 };
    case 'Interp':
      return { text: `\`${node.raw}\``, priority: 100 };
    case 'Name':
      return { text: node.name, priority: 100 };
    case 'Paren':
      return { text: `(${printExpr(node.expr, 0, indent)})`, priority: 100 };
    case 'FunctionExpr':
      return { text: printFunction(node, indent), priority: 100 };
    case 'Table':
      return { text: printTable(node, indent), priority: 100 };
    case 'Index': {
      const obj = printObject(node.obj, indent);
      if (node.keyIsName) return { text: `${obj}.${node.key.value}`, priority: 100 };
      return { text: `${obj}[${printExpr(node.key, 0, indent)}]`, priority: 100 };
    }
    case 'Call': {
      const func = printObject(node.func, indent);
      return { text: `${func}(${node.args.map((a) => printExpr(a, 0, indent)).join(', ')})`, priority: 100 };
    }
    case 'MethodCall': {
      const obj = printObject(node.obj, indent);
      return {
        text: `${obj}:${node.method}(${node.args.map((a) => printExpr(a, 0, indent)).join(', ')})`,
        priority: 100,
      };
    }
    case 'Cast': {
      const inner = printExpr(node.expr, UNARY_PRIORITY, indent);
      return { text: `${inner} :: ${node.typeRaw}`, priority: 100 };
    }
    case 'IfExpr': {
      // An if-expression is only legal where an expression is expected, so it
      // always prints parenthesised unless it is already the outermost thing.
      const text = printIfExpr(node, indent);
      return { text, priority: 0 };
    }
    case 'Un': {
      // Every unary operator takes a full `exp` (Luau's grammar: `unop exp`),
      // so `#{1, 2}` and `#"abc"` need no parentheses. Only a lower-priority
      // operand does — `#(a + b)` — and the priority argument handles that.
      const operand = printExpr(node.operand, UNARY_PRIORITY, indent);
      // `-` followed by `-` would open a comment; `not` needs its space.
      const sep = node.op === 'not' || (node.op === '-' && operand.startsWith('-')) ? ' ' : '';
      return { text: `${node.op}${sep}${operand}`, priority: UNARY_PRIORITY };
    }
    case 'Bin': {
      const priority = PRIORITY[node.op];
      if (priority === undefined) {
        throw new Error(`cannot print unknown binary operator ${JSON.stringify(node.op)}`);
      }
      const rightAssoc = RIGHT_ASSOCIATIVE.has(node.op);
      const left = printExpr(node.left, rightAssoc ? priority + 1 : priority, indent);
      // A unary expression on the right never needs parentheses: every
      // operator's right operand may begin with one, which is why `2 ^ -3` is
      // valid without them even though `^` binds tighter than unary minus.
      const right =
        node.right.type === 'Un'
          ? printExpr(node.right, 0, indent)
          : printExpr(node.right, rightAssoc ? priority : priority + 1, indent);
      return { text: `${left} ${node.op} ${right}`, priority };
    }
    default:
      throw new Error(`cannot print node of type ${node.type}`);
  }
}

function printIfExpr(node, indent) {
  const cond = printExpr(node.cond, 0, indent);
  const thenExpr = printExpr(node.thenExpr, 0, indent);
  const elseExpr = printExpr(node.elseExpr, 0, indent);
  return `if ${cond} then ${thenExpr} else ${elseExpr}`;
}

function printFunction(node, indent) {
  const generics = node.generics ? `${node.generics}` : '';
  const params = node.params.map((p) => {
    const type = p.typeRaw ? `: ${p.typeRaw}` : '';
    return `${p.name}${type}`;
  });
  if (node.vararg) params.push('...');
  const returnType = node.returnTypeRaw ? `: ${node.returnTypeRaw}` : '';
  const head = `function${generics}(${params.join(', ')})${returnType}`;
  const body = printBlock(node.body, indent + 1);
  if (body === '') return `${head}\n${pad(indent)}end`;
  return `${head}\n${body}\n${pad(indent)}end`;
}

function printTable(node, indent) {
  if (node.fields.length === 0) return '{}';
  const inner = indent + 1;
  const parts = node.fields.map((field) => {
    if (field.kind === 'name') return `${field.key} = ${printExpr(field.value, 0, inner)}`;
    if (field.kind === 'index') {
      return `[${printExpr(field.key, 0, inner)}] = ${printExpr(field.value, 0, inner)}`;
    }
    return printExpr(field.value, 0, inner);
  });
  // A table of scalar literals stays on one line: obfuscated string tables are
  // thousands of entries long and a value per line is unreadable.
  const trail = node.trailingSep === ';' ? ';' : ',';
  const oneLine = parts.every((p) => p.length < 40) && parts.join(', ').length < 80;
  if (oneLine) {
    return node.trailingSep ? `{ ${parts.join(', ')}${trail} }` : `{ ${parts.join(', ')} }`;
  }
  const lines = parts.map((p, i) =>
    i === parts.length - 1 && !node.trailingSep ? `${pad(inner)}${p}` : `${pad(inner)}${p}${trail}`,
  );
  return `{\n${lines.join('\n')}\n${pad(indent)}}`;
}

function pad(level) {
  return '  '.repeat(level);
}

/**
 * Print a block of statements, one per line, indented.
 *
 * @param {Array<object>} body
 * @param {number} indent
 * @returns {string} the statements, without a trailing newline
 */
export function printBlock(body, indent = 0) {
  const lines = [];
  for (const stat of body) {
    const text = printStatement(stat, indent);
    if (text !== '') lines.push(text);
  }
  return lines.join('\n');
}

function printAttributes(stat, indent) {
  if (!stat.attributes || stat.attributes.length === 0) return '';
  return `${stat.attributes.map((a) => `${pad(indent)}${a}\n`).join('')}`;
}

function printBlockBody(body, indent) {
  const inner = printBlock(body, indent + 1);
  return inner === '' ? `${pad(indent)}end` : `${inner}\n${pad(indent)}end`;
}

/** Print one statement, including its attributes. */
export function printStatement(stat, indent = 0) {
  const attrs = printAttributes(stat, indent);
  const text = printStatementInner(stat, indent);
  return attrs ? `${attrs}${text}` : text;
}

function printStatementInner(stat, indent) {
  const ind = pad(indent);
  switch (stat.type) {
    case 'LocalStat': {
      const names = stat.names.map((n) => (n.typeRaw ? `${n.name}: ${n.typeRaw}` : n.name));
      const exprs =
        stat.exprs.length > 0 ? ` = ${stat.exprs.map((e) => printExpr(e, 0, indent)).join(', ')}` : '';
      return `${ind}local ${names.join(', ')}${exprs}`;
    }
    case 'LocalFunction': {
      const fn = printFunction(stat.func, indent);
      return `${ind}local function ${stat.name.name}${fn.slice('function'.length)}`;
    }
    case 'AssignStat': {
      const targets = stat.targets.map((t) => printExpr(t, 0, indent));
      const exprs = stat.exprs.map((e) => printExpr(e, 0, indent));
      return `${ind}${targets.join(', ')} = ${exprs.join(', ')}`;
    }
    case 'CompoundStat': {
      return `${ind}${printExpr(stat.target, 0, indent)} ${stat.op} ${printExpr(stat.expr, 0, indent)}`;
    }
    case 'CallStat':
      return `${ind}${printExpr(stat.call, 0, indent)}`;
    case 'IfStat': {
      const parts = [];
      stat.clauses.forEach((clause, index) => {
        const kw = index === 0 ? 'if' : 'elseif';
        parts.push(`${ind}${kw} ${printExpr(clause.cond, 0, indent)} then`);
        const body = printBlock(clause.body, indent + 1);
        if (body !== '') parts.push(body);
      });
      if (stat.elseBody && stat.elseBody.length > 0) {
        parts.push(`${ind}else`);
        parts.push(printBlock(stat.elseBody, indent + 1));
      }
      parts.push(`${ind}end`);
      return parts.filter((p) => p !== '').join('\n');
    }
    case 'WhileStat': {
      const head = `${ind}while ${printExpr(stat.cond, 0, indent)} do`;
      return `${head}\n${printBlockBody(stat.body, indent)}`;
    }
    case 'RepeatStat': {
      const body = printBlock(stat.body, indent + 1);
      const head = `${ind}repeat`;
      const tail = `${ind}until ${printExpr(stat.cond, 0, indent)}`;
      return body === '' ? `${head}\n${tail}` : `${head}\n${body}\n${tail}`;
    }
    case 'NumericFor': {
      const step = stat.step ? `, ${printExpr(stat.step, 0, indent)}` : '';
      const head =
        `${ind}for ${stat.name.name} = ${printExpr(stat.from, 0, indent)}, ` +
        `${printExpr(stat.to, 0, indent)}${step} do`;
      return `${head}\n${printBlockBody(stat.body, indent)}`;
    }
    case 'GenericFor': {
      const names = stat.names.map((n) => n.name).join(', ');
      const exprs = stat.exprs.map((e) => printExpr(e, 0, indent)).join(', ');
      return `${ind}for ${names} in ${exprs} do\n${printBlockBody(stat.body, indent)}`;
    }
    case 'DoStat':
      return `${ind}do\n${printBlockBody(stat.body, indent)}`;
    case 'ReturnStat': {
      if (stat.exprs.length === 0) return `${ind}return`;
      return `${ind}return ${stat.exprs.map((e) => printExpr(e, 0, indent)).join(', ')}`;
    }
    case 'BreakStat':
      return `${ind}break`;
    case 'ContinueStat':
      return `${ind}continue`;
    case 'CommentStat':
      return `${ind}${stat.text}`;
    case 'FunctionStat': {
      const target = printExpr(stat.target, 0, indent);
      const fn = printFunction(stat.func, indent);
      return `${ind}function ${target}${fn.slice('function'.length)}`;
    }
    case 'TypeStat':
      return `${ind}${stat.raw}`;
    default:
      throw new Error(`cannot print statement of type ${stat.type}`);
  }
}

/**
 * Print a whole chunk.
 *
 * @param {{body: Array<object>}} chunk
 * @param {{header?: string}} [options] a comment to place above the output
 */
export function print(chunk, options = {}) {
  const body = chunk.body || chunk;
  const text = printBlock(body, 0);
  const head = options.header ? `${options.header}\n` : '';
  return `${head}${text}\n`;
}
