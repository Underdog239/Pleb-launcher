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

/**
 * Write root instances to a model or place file.
 *
 * @param {string} filePath
 * @param {import('./instance.js').Instance[]} roots
 * @param {{onUnsupported?: (dropped: string[]) => void, strictUnsupported?: boolean}} [options]
 */
export function saveModel(filePath, roots, options = {}) {
  const format = formatFor(filePath);
  if (!format) throw new Error(`unsupported model extension: ${path.extname(filePath)}`);
  // `format` is informational for the codecs; both already know their own.
  const out = format === 'xml' ? serializeXml(roots, options) : serializeModel(roots, options);
  fs.writeFileSync(filePath, out);
  return out.length;
}

/**
 * Which properties a write to this path would drop, without writing anything.
 *
 * Callers that validate before writing already catch this; this is for the
 * paths that do not (a `--force` write, or a direct codec call).
 */
export function dryRunUnsupported(filePath, roots) {
  const format = formatFor(filePath);
  const dropped = [];
  const onUnsupported = (list) => dropped.push(...list);
  if (format === 'xml') serializeXml(roots, { onUnsupported });
  else if (format === 'binary') serializeModel(roots, { onUnsupported });
  else throw new Error(`unsupported model extension: ${path.extname(filePath)}`);
  return dropped.sort();
}

export { serializeModel, deserializeModel, serializeXml, deserializeXml };
