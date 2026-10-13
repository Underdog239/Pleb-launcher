// Model file I/O: dispatch on extension between binary and XML codecs.

import fs from 'node:fs';
import path from 'node:path';
import { serializeModel, deserializeModel } from './binary.js';
import { serializeXml, deserializeXml } from './xml.js';

const BINARY_EXT = new Set(['.rbxm', '.rbxl']);
const XML_EXT = new Set(['.rbxmx', '.rbxlx']);

export function formatFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (XML_EXT.has(ext)) return 'xml';
  if (BINARY_EXT.has(ext)) return 'binary';
  return null;
}

/** Load a model or place file into root instances. */
export function loadModel(filePath) {
  const format = formatFor(filePath);
  if (!format) throw new Error(`unsupported model extension: ${path.extname(filePath)}`);
  const data = fs.readFileSync(filePath);
  return format === 'xml' ? deserializeXml(data.toString('utf8')) : deserializeModel(data);
}

/** Write root instances to a model or place file. */
export function saveModel(filePath, roots, options = {}) {
  const format = formatFor(filePath);
  if (!format) throw new Error(`unsupported model extension: ${path.extname(filePath)}`);
  const out = format === 'xml' ? serializeXml(roots, options) : serializeModel(roots, options);
  fs.writeFileSync(filePath, out);
  return out.length;
}

export { serializeModel, deserializeModel, serializeXml, deserializeXml };
