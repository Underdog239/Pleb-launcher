// Publish a built place to Roblox, without Studio.
//
// This is the other half of the headless story. Running a script on Open Cloud
// is only useful if the place being loaded is the one you just built, and
// publishing is what puts it there:
//
//   POST https://apis.roblox.com/universes/v1/{universeId}/places/{placeId}/versions?versionType=Published
//   x-api-key: ...      Content-Type: application/xml | application/octet-stream
//   body: the raw place file
//   -> { "versionNumber": 7 }
//
// Note the version: this endpoint is v1 under /universes, not under /cloud/v2
// like Luau Execution, and the place file is the raw request body rather than a
// multipart form. Roblox's own publishing guide uses curl with --data-binary for
// exactly that reason.
//
// Together with the local backend's project builder, this closes a loop that
// nothing else in this space closes in one tool: build a place from a project
// or a spec, publish it, and run a script against that published version, all
// from a Linux box with no Studio and no GUI.
//
// `versionType` is the difference between a deploy and a draft:
//   Published - saved and live; this is what a player's server loads next
//   Saved     - saved as a version that is not the current live one

import fs from 'node:fs';
import path from 'node:path';
import { ApiError, requestTask, baseUrl } from './http.js';

export const VERSION_TYPES = ['Published', 'Saved'];
const MAX_PLACE_BYTES = 100 * 1024 * 1024;

/** The content type Roblox expects for each place file format. */
export function contentTypeFor(file) {
  const ext = path.extname(String(file)).toLowerCase();
  if (ext === '.rbxlx') return 'application/xml';
  if (ext === '.rbxl') return 'application/octet-stream';
  throw new Error(
    `cannot publish ${file}: expected a .rbxl or .rbxlx place file, got "${ext || 'no extension'}"`,
  );
}

/**
 * Publish or save a place file.
 *
 * @param {object} options
 * @param {string} options.placeFile           path to a .rbxl or .rbxlx
 * @param {string|number} options.universeId
 * @param {string|number} options.placeId
 * @param {'Published'|'Saved'} [options.versionType]
 * @param {string} [options.apiKey]
 * @param {string} [options.baseUrl]
 * @returns {Promise<{versionNumber: number|null, versionType: string, bytes: number, placeFile: string}>}
 */
export async function publishPlace({
  placeFile,
  universeId,
  placeId,
  versionType = 'Published',
  apiKey,
  baseUrl: baseUrlOption = baseUrl(),
  fetchImpl = globalThis.fetch,
  timeoutMs = 5 * 60 * 1000,
} = {}) {
  if (!placeFile) throw new Error('publishPlace needs a place file');
  if (!universeId) throw new Error('publishPlace needs a universeId (the experience id)');
  if (!placeId) throw new Error('publishPlace needs a placeId');
  if (!VERSION_TYPES.includes(versionType)) {
    throw new Error(`versionType must be one of ${VERSION_TYPES.join(' or ')}, not "${versionType}"`);
  }

  // Read before checking the extension, so a missing file reports that rather
  // than a confusing complaint about its name.
  let bytes;
  try {
    bytes = fs.readFileSync(placeFile);
  } catch (err) {
    throw new Error(`cannot read the place file ${placeFile}: ${err.message}`);
  }
  const contentType = contentTypeFor(placeFile);
  if (bytes.length === 0) throw new Error(`${placeFile} is empty; nothing to publish`);
  if (bytes.length > MAX_PLACE_BYTES) {
    throw new Error(`${placeFile} is ${bytes.length} bytes, over the 100 MB limit`);
  }

  const endpoint =
    `/universes/v1/${encodeURIComponent(universeId)}/places/${encodeURIComponent(placeId)}/versions` +
    `?versionType=${versionType}`;

  const response = await requestTask(endpoint, {
    method: 'POST',
    apiKey: apiKey ?? undefined,
    baseUrl: baseUrlOption,
    bytes,
    contentType,
    fetchImpl,
    timeoutMs,
  });

  const versionNumber =
    typeof response?.versionNumber === 'number' ? response.versionNumber : null;

  return { versionNumber, versionType, bytes: bytes.length, placeFile };
}

/** The publishing errors are their own set, so they get their own words. */
export function explainPublishError(err) {
  if (!(err instanceof ApiError)) return err?.message || String(err);
  switch (err.status) {
    case 400:
      return (
        `${err.message} — the place file was rejected. A file that Studio cannot ` +
        'open will not publish, so check the build first (studio validate).'
      );
    case 401:
      return (
        `${err.message} — the key needs the "universe-places" permission with the ` +
        'Write operation on this experience, which is a different scope from Luau Execution.'
      );
    case 403:
      return `${err.message} — publishing is not allowed on this place for this key.`;
    case 404:
      return `${err.message} — the place or universe id does not exist, or the key cannot see it.`;
    case 409:
      return `${err.message} — the place is not part of that universe.`;
    case 413:
      return `${err.message} — place files are limited to 100 MB.`;
    case 500:
      return `${err.message} — Roblox reports an internal error; retry usually works.`;
    default:
      return err.message;
  }
}
