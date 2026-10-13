// A Luau tokenizer.
//
// This is not a toy splitter: it handles Luau's actual lexical grammar —
// long-bracket strings and comments, all escape forms, hex/binary/exponent
// numbers with underscore separators, and interpolated backtick strings.
// Everything downstream (the analyser, the require graph) depends on positions
// being exact, because a diagnostic that points at the wrong line is worse than
// no diagnostic.
//
// Reference: the Luau lexer (luau/src/lexer.cpp) and the Lua 5.1 manual for the
// forms Luau inherits.

const KEYWORDS = new Set([
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function',
  'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true',
  'until', 'while',
  // Luau additions
  'continue', 'type', 'export',
]);

/** Longest first, so `...` is not read as `.` `.` `.`. */
const OPERATORS = [
  '...', '..=', '::',
  '..', '==', '~=', '<=', '>=', '+=', '-=', '*=', '/=', '%=', '^=', '//=',
  '->', '<<', '>>', '//',
  '+', '-', '*', '/', '%', '^', '#', '=', '<', '>', '(', ')', '{', '}', '[', ']',
  ';', ':', ',', '.', '&', '|', '~',
];

const ESCAPES = {
  a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v',
  '\\': '\\', '"': '"', "'": "'", '\n': '\n',
};

function isDigit(ch) {
  return ch >= '0' && ch <= '9';
}

function isHexDigit(ch) {
  return isDigit(ch) || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
}

function isIdentStart(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}

function isIdentPart(ch) {
  return isIdentStart(ch) || isDigit(ch);
}

/**
 * Try to read a long bracket opener at `i` (`[[`, `[=[`, `[==[`, ...).
 * @returns {{level: number, length: number}|null}
 */
function longBracketAt(src, i) {
  if (src[i] !== '[') return null;
  let level = 0;
  let j = i + 1;
  while (src[j] === '=') {
    level++;
    j++;
  }
  if (src[j] !== '[') return null;
  return { level, length: j - i + 1 };
}

/** Find the close of a long bracket of `level`, or -1. */
function findLongClose(src, from, level) {
  const close = `]${'='.repeat(level)}]`;
  const idx = src.indexOf(close, from);
  return idx === -1 ? -1 : idx + close.length;
}

/**
 * Tokenize Luau source.
 *
 * @param {string} source
 * @returns {{tokens: Array<object>, errors: Array<object>}}
 */
export function tokenize(source) {
  const src = String(source);
  const tokens = [];
  const errors = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;

  const col = (pos) => pos - lineStart + 1;
  const push = (type, value, start, end, extra = {}) =>
    tokens.push({ type, value, start, end, line, col: col(start), ...extra });

  // Line/column must be captured *before* consuming a token: consuming can
  // cross newlines, and a token is reported where it starts.
  const here = () => ({ line, col: col(i) });

  const consumeTo = (end) => {
    const text = src.slice(i, end);
    const newlines = text.split('\n').length - 1;
    if (newlines > 0) {
      line += newlines;
      lineStart = i + text.lastIndexOf('\n') + 1;
    }
    i = end;
  };

  while (i < src.length) {
    const ch = src[i];

    // --- whitespace
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      if (ch === '\n') {
        line++;
        lineStart = i + 1;
      }
      i++;
      continue;
    }

    // --- comments
    if (ch === '-' && src[i + 1] === '-') {
      const start = i;
      const { line: startLine, col: startCol } = here();
      const bracket = longBracketAt(src, i + 2);
      if (bracket) {
        const close = findLongClose(src, i + 2 + bracket.length, bracket.level);
        if (close === -1) {
          errors.push({ message: 'unterminated block comment', line: startLine, col: startCol });
          consumeTo(src.length);
        } else {
          consumeTo(close);
        }
      } else {
        const end = src.indexOf('\n', i);
        consumeTo(end === -1 ? src.length : end);
      }
      tokens.push({
        type: 'comment',
        value: src.slice(start, i),
        start,
        end: i,
        line: startLine,
        col: startCol,
      });
      continue;
    }

    // --- long strings
    const bracket = longBracketAt(src, i);
    if (bracket) {
      const start = i;
      const { line: startLine, col: startCol } = here();
      const bodyStart = i + bracket.length;
      const close = findLongClose(src, bodyStart, bracket.level);
      if (close === -1) {
        errors.push({ message: 'unterminated long string', line: startLine, col: startCol });
        consumeTo(src.length);
        tokens.push({ type: 'string', value: src.slice(bodyStart), start, end: i, line: startLine, col: startCol });
      } else {
        const value = src.slice(bodyStart, close - (bracket.level + 2));
        consumeTo(close);
        tokens.push({ type: 'string', value, start, end: i, line: startLine, col: startCol, long: true });
      }
      continue;
    }

    // --- quoted strings
    if (ch === '"' || ch === "'") {
      const start = i;
      const { line: startLine, col: startCol } = here();
      const quote = ch;
      let j = i + 1;
      let value = '';
      let closed = false;
      while (j < src.length) {
        const c = src[j];
        if (c === '\\') {
          const next = src[j + 1];
          if (next === undefined) break;
          if (next === 'x' && isHexDigit(src[j + 2]) && isHexDigit(src[j + 3])) {
            value += String.fromCharCode(parseInt(src.slice(j + 2, j + 4), 16));
            j += 4;
            continue;
          }
          if (next === 'z') {
            // \z skips following whitespace, newlines included.
            j += 2;
            while (j < src.length && /\s/.test(src[j])) j++;
            continue;
          }
          if (next === 'u' && src[j + 2] === '{') {
            const close = src.indexOf('}', j + 3);
            if (close !== -1) {
              value += String.fromCodePoint(parseInt(src.slice(j + 3, close), 16) || 0);
              j = close + 1;
              continue;
            }
          }
          if (isDigit(next)) {
            // \ddd decimal escape, up to three digits.
            let k = j + 1;
            let digits = '';
            while (k < src.length && digits.length < 3 && isDigit(src[k])) digits += src[k++];
            value += String.fromCharCode(parseInt(digits, 10) & 0xff);
            j = k;
            continue;
          }
          value += ESCAPES[next] ?? next;
          j += 2;
          continue;
        }
        if (c === quote) {
          closed = true;
          j++;
          break;
        }
        if (c === '\n') break; // an unescaped newline ends it (and it is an error)
        value += c;
        j++;
      }
      if (!closed) {
        errors.push({ message: 'unterminated string', line: startLine, col: startCol });
      }
      consumeTo(j);
      tokens.push({ type: 'string', value, start, end: j, line: startLine, col: startCol });
      continue;
    }

    // --- interpolated strings (`...{expr}...`)
    if (ch === '`') {
      const start = i;
      const { line: startLine, col: startCol } = here();
      let j = i + 1;
      let pieces = 0;
      let closed = false;
      while (j < src.length) {
        const c = src[j];
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === '{') pieces++;
        if (c === '}') pieces--;
        if (c === '`') {
          closed = true;
          j++;
          break;
        }
        if (c === '\n') {
          // A literal newline is allowed in an interpolated string.
        }
        j++;
      }
      if (!closed) errors.push({ message: 'unterminated interpolated string', line: startLine, col: startCol });
      const raw = src.slice(start + 1, closed ? j - 1 : j);
      consumeTo(j);
      tokens.push({
        type: 'interpolated',
        value: raw,
        start,
        end: j,
        line: startLine,
        col: startCol,
        pieces,
      });
      continue;
    }

    // --- numbers
    if (isDigit(ch) || (ch === '.' && isDigit(src[i + 1]))) {
      const start = i;
      const { line: startLine, col: startCol } = here();
      let j = i;
      if (src[j] === '0' && (src[j + 1] === 'x' || src[j + 1] === 'X')) {
        j += 2;
        while (j < src.length && (isHexDigit(src[j]) || src[j] === '_')) j++;
        if (src[j] === '.') {
          j++;
          while (j < src.length && (isHexDigit(src[j]) || src[j] === '_')) j++;
        }
        if (src[j] === 'p' || src[j] === 'P') {
          j++;
          if (src[j] === '+' || src[j] === '-') j++;
          while (j < src.length && isDigit(src[j])) j++;
        }
      } else if (src[j] === '0' && (src[j + 1] === 'b' || src[j + 1] === 'B')) {
        j += 2;
        while (j < src.length && (src[j] === '0' || src[j] === '1' || src[j] === '_')) j++;
      } else {
        while (j < src.length && (isDigit(src[j]) || src[j] === '_')) j++;
        if (src[j] === '.') {
          j++;
          while (j < src.length && (isDigit(src[j]) || src[j] === '_')) j++;
        }
        if (src[j] === 'e' || src[j] === 'E') {
          const save = j;
          j++;
          if (src[j] === '+' || src[j] === '-') j++;
          if (isDigit(src[j])) {
            while (j < src.length && isDigit(src[j])) j++;
          } else {
            j = save;
          }
        }
      }
      // Luau allows a type suffix after a numeric literal (e.g. `1u8`).
      if (isIdentStart(src[j])) {
        while (j < src.length && isIdentPart(src[j])) j++;
      }
      const text = src.slice(start, j);
      const value = Number(text.replace(/_/g, '').replace(/[ui](8|16|32|64)?$/i, ''));
      consumeTo(j);
      tokens.push({
        type: 'number',
        value: Number.isNaN(value) ? 0 : value,
        text,
        start,
        end: j,
        line: startLine,
        col: startCol,
      });
      continue;
    }

    // --- identifiers and keywords
    if (isIdentStart(ch)) {
      const start = i;
      const { line: startLine, col: startCol } = here();
      let j = i;
      while (j < src.length && isIdentPart(src[j])) j++;
      const text = src.slice(start, j);
      consumeTo(j);
      tokens.push({
        type: KEYWORDS.has(text) ? 'keyword' : 'ident',
        value: text,
        start,
        end: j,
        line: startLine,
        col: startCol,
      });
      continue;
    }

    // --- operators
    let matched = null;
    for (const op of OPERATORS) {
      if (src.startsWith(op, i)) {
        matched = op;
        break;
      }
    }
    if (matched) {
      const start = i;
      const { line: startLine, col: startCol } = here();
      tokens.push({ type: 'op', value: matched, start, end: i + matched.length, line: startLine, col: startCol });
      i += matched.length;
      continue;
    }

    // --- anything else
    errors.push({ message: `unexpected character ${JSON.stringify(ch)}`, line, col: col(i) });
    i++;
  }

  tokens.push({ type: 'eof', value: '', start: i, end: i, line, col: col(i) });
  return { tokens, errors };
}

/** Tokens with comments removed — what every analysis pass actually wants. */
export function codeTokens(source) {
  const { tokens, errors } = tokenize(source);
  return { tokens: tokens.filter((t) => t.type !== 'comment'), errors };
}

export { KEYWORDS, OPERATORS };
