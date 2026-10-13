// Backend registry. One CLI, pluggable engines.

import * as local from './local/index.js';
import * as studio from './studio/index.js';

export function listBackends() {
  return [
    { name: 'local', capabilities: local.capabilities, available: true },
    { name: 'studio', capabilities: studio.capabilities, available: studio.available() },
  ];
}

export function getBackend(name) {
  if (name === 'local') return local;
  if (name === 'studio') return studio;
  throw new Error(`unknown backend: ${name} (expected "local", "studio" or "auto")`);
}

/**
 * Resolve the backend to use. "auto" prefers Studio when installed (full
 * fidelity) and falls back to the local implementation otherwise.
 */
export function resolveBackend(requested = 'auto') {
  if (requested && requested !== 'auto') return getBackend(requested);
  return studio.available() ? studio : local;
}

export { local, studio };
