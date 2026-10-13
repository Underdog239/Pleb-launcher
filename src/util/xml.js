// Minimal, dependency-free XML parser + serializer.
//
// Covers the subset Roblox uses: elements, attributes, text, comments, CDATA,
// processing instructions and the five predefined entities. Not a validating
// parser; intentionally small.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s) {
  // Most strings contain no entity at all, and `replace` allocates whether or
  // not it matches. Checking for an ampersand first turns the common case into
  // a single scan and no allocation.
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[body] ?? m;
  });
}

const NEEDS_ENCODING = /[&<>"]/;

function encodeEntities(s) {
  const text = String(s);
  // Same reasoning as decodeEntities: four chained replaces on a string with
  // nothing to replace is four allocations for no reason.
  if (!NEEDS_ENCODING.test(text)) return text;
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export class XmlElement {
  constructor(name, attrs = {}) {
    this.name = name;
    this.attrs = attrs;
    this.children = [];
    this.text = '';
  }

  attr(name, fallback = null) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : fallback;
  }

  /** Direct child elements with the given tag name. */
  find(name) {
    return this.children.find((c) => c.name === name) || null;
  }

  findAll(name) {
    return this.children.filter((c) => c.name === name);
  }

  /** Text of the first child element with the given name. */
  childText(name) {
    const el = this.find(name);
    return el ? el.text : null;
  }
}

/**
 * Parse an XML document string into a root element.
 * @param {string} input
 * @returns {XmlElement}
 */
export function parseXml(input) {
  let i = 0;
  const n = input.length;
  let root = null;
  const stack = [];

  // A regex test per character is expensive across a multi-megabyte document,
  // and this is the hottest of the small loops.
  const skipWs = () => {
    while (i < n) {
      const c = input.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) i++;
      else break;
    }
  };

  // Scan to the next delimiter in one pass instead of testing character by
  // character. `lastIndex` starts the search at the current position.
  const DELIM_NAME = /[\s\/>]/g;
  const scanTo = (re, from) => {
    re.lastIndex = from;
    const m = re.exec(input);
    return m ? m.index : n;
  };
  const DELIM_ATTR = /[\s=\/>]/g;

  while (i < n) {
    const lt = input.indexOf('<', i);
    if (lt === -1) break;

    // Text content for the current element.
    if (lt > i && stack.length) {
      stack[stack.length - 1].text += decodeEntities(input.slice(i, lt));
    }
    i = lt;

    if (input.startsWith('<!--', i)) {
      const end = input.indexOf('-->', i);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (input.startsWith('<![CDATA[', i)) {
      const end = input.indexOf(']]>', i);
      const body = input.slice(i + 9, end === -1 ? n : end);
      if (stack.length) stack[stack.length - 1].text += body;
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (input.startsWith('<?', i) || input.startsWith('<!', i)) {
      const end = input.indexOf('>', i);
      i = end === -1 ? n : end + 1;
      continue;
    }

    // Closing tag.
    if (input[i + 1] === '/') {
      const end = input.indexOf('>', i);
      const name = input.slice(i + 2, end).trim();
      const el = stack.pop();
      if (!el || el.name !== name) {
        throw new Error(`xml: mismatched closing tag </${name}>`);
      }
      i = end + 1;
      continue;
    }

    // Opening tag.
    i++;
    skipWs();
    const j = scanTo(DELIM_NAME, i);
    const name = input.slice(i, j);
    i = j;

    const attrs = {};
    for (;;) {
      skipWs();
      if (i >= n) break;
      if (input[i] === '/' || input[i] === '>') break;
      const k = scanTo(DELIM_ATTR, i);
      const key = input.slice(i, k);
      i = k;
      skipWs();
      if (input[i] !== '=') {
        attrs[key] = '';
        continue;
      }
      i++;
      skipWs();
      const quote = input[i];
      if (quote === '"' || quote === "'") {
        const end = input.indexOf(quote, i + 1);
        attrs[key] = decodeEntities(input.slice(i + 1, end));
        i = end + 1;
      } else {
        let e = i;
        while (e < n && !/[\s/>]/.test(input[e])) e++;
        attrs[key] = decodeEntities(input.slice(i, e));
        i = e;
      }
    }

    const el = new XmlElement(name, attrs);
    if (stack.length) stack[stack.length - 1].children.push(el);
    else if (!root) root = el;
    else throw new Error('xml: multiple root elements');

    const selfClosing = input[i] === '/';
    if (selfClosing) i++;
    if (input[i] === '>') i++;
    if (!selfClosing) stack.push(el);
  }

  if (!root) throw new Error('xml: no root element');
  return root;
}

/** Serialize an element tree to a string. */
export function serializeXml(root, { indent = '  ', declaration = true } = {}) {
  const lines = [];
  if (declaration) lines.push('<?xml version="1.0" encoding="utf-8"?>');

  // `indent.repeat(depth)` allocates a fresh string per element; the depth set
  // is tiny, so the pads are built once.
  const pads = [];
  const padFor = (depth) => {
    while (pads.length <= depth) pads.push(indent.repeat(pads.length));
    return pads[depth];
  };

  const walk = (el, depth) => {
    const pad = padFor(depth);
    const attrs = Object.entries(el.attrs)
      .map(([k, v]) => ` ${k}="${encodeEntities(v)}"`)
      .join('');
    const hasChildren = el.children.length > 0;
    if (!hasChildren && !el.text) {
      lines.push(`${pad}<${el.name}${attrs}></${el.name}>`);
      return;
    }
    if (!hasChildren) {
      lines.push(`${pad}<${el.name}${attrs}>${encodeEntities(el.text)}</${el.name}>`);
      return;
    }
    lines.push(`${pad}<${el.name}${attrs}>`);
    for (const child of el.children) walk(child, depth + 1);
    lines.push(`${pad}</${el.name}>`);
  };

  walk(root, 0);
  return lines.join('\n') + '\n';
}

export { decodeEntities, encodeEntities };
