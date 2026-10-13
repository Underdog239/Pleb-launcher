// Minimal, dependency-free XML parser + serializer.
//
// Covers the subset Roblox uses: elements, attributes, text, comments, CDATA,
// processing instructions and the five predefined entities. Not a validating
// parser; intentionally small.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s) {
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

function encodeEntities(s) {
  return String(s)
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

  const skipWs = () => {
    while (i < n && /\s/.test(input[i])) i++;
  };

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
    let j = i;
    while (j < n && /[^\s/>]/.test(input[j])) j++;
    const name = input.slice(i, j);
    i = j;

    const attrs = {};
    for (;;) {
      skipWs();
      if (i >= n) break;
      if (input[i] === '/' || input[i] === '>') break;
      let k = i;
      while (k < n && /[^\s=/>]/.test(input[k])) k++;
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

  const walk = (el, depth) => {
    const pad = indent.repeat(depth);
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
