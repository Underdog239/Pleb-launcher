// Backend registry. One CLI, pluggable engines.

import * as local from './local/index.js';
import * as studio from './studio/index.js';
import * as opencloud from './opencloud/index.js';

export function listBackends() {
  return [
    { name: 'local', capabilities: local.capabilities, available: true },
    { name: 'studio', capabilities: studio.capabilities, available: studio.available() },
    { name: 'opencloud', capabilities: opencloud.capabilities, available: opencloud.available() },
  ];
}

export function getBackend(name) {
  if (name === 'local') return local;
  if (name === 'studio') return studio;
  if (name === 'opencloud') return opencloud;
  throw new Error(`unknown backend: ${name} (expected "local", "studio", "opencloud" or "auto")`);
}

/**
 * Resolve the backend to use. "auto" prefers the highest fidelity that this
 * host can actually reach: Studio when it is installed, then Open Cloud when a
 * key is present, then the local implementation.
 *
 * Studio before Open Cloud because it is the engine itself, with physics and
 * rendering; Open Cloud is a real server but a constrained one.
 */
export function resolveBackend(requested = 'auto') {
  if (requested && requested !== 'auto') return getBackend(requested);
  if (studio.available()) return studio;
  if (opencloud.available()) return opencloud;
  return local;
}

export { local, studio, opencloud };
