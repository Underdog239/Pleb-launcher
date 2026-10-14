// Open Cloud backend: run Luau on Roblox's real servers, headlessly.
//
// The local backend is exact about files and structure but has no engine, and
// the studio backend needs a GUI on Windows or macOS. Neither can answer "does
// this script actually work?" on a Linux CI box. Roblox's Open Cloud Luau
// Execution API can: it starts a server, loads a specific version of a place,
// runs a script in it with full DataModel and engine API access, and gives back
// the script's return values and everything it printed.
//
// This is the third backend, and it is the one that makes the loop complete:
// build a place here, check it statically here, then run it against the real
// engine from here.
//
// What it is not: a replacement for the engine. Tasks run one at a time, for up
// to five minutes, with no physics simulation and with the place's own scripts
// deliberately not started. See docs/backends.md.
//
// API shape follows Roblox's own reference implementation,
// https://github.com/Roblox/place-ci-cd-demo (scripts/python/luau_execution_task.py):
//
//   POST /cloud/v2/universes/{u}/places/{p}/[versions/{v}/]luau-execution-session-tasks
//   GET  /cloud/v2/{task.path}          -> state: PROCESSING until it is not
//   GET  /cloud/v2/{task.path}/logs     -> luauExecutionSessionTaskLogs[].messages
//
// and the completed task carries `output.results` and, on failure, `error`.

import { ApiError, requestTask, describeError, baseUrl } from './http.js';

export const name = 'opencloud';

export const capabilities = {
  executeLuau: true,
  physics: false,
  render: 'none',
  requiresStudio: false,
  requiresApiKey: true,
  headless: true,
  platform: 'any',
};

// Every Open Cloud v2 endpoint lives under /cloud/v2. The task paths Roblox
// returns are relative to it (`universes/1/places/2/...`), so it is added in
// exactly one place, here, on the way out.
const API_PREFIX = '/cloud/v2';
const MAX_SCRIPT_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 6 * 60 * 1000;
const DEFAULT_POLL_MS = 3000;

/** The API key, from the usual environment variables, or null. */
export function apiKey() {
  const key = process.env.ROBLOX_CLOUD_API_KEY || process.env.RBLX_OC_API_KEY || '';
  return key.trim() || null;
}

/** Can this host talk to Open Cloud at all? */
export function available() {
  return apiKey() !== null;
}

/**
 * Why it is not available, for a caller that has to explain itself.
 *
 * Publishing and executing need *different* scopes, so a caller that is about to
 * publish says so and the message names the scope that operation actually needs.
 */
export function unavailableReason(operation = 'execute') {
  if (apiKey()) return null;
  const scope =
    operation === 'publish'
      ? '"universe-places" with the Write operation on the experience'
      : '"universe.place.luau-execution-session:write"';
  return (
    'no Open Cloud API key: set ROBLOX_CLOUD_API_KEY (or RBLX_OC_API_KEY). ' +
    `Create one at https://create.roblox.com/dashboard/credentials with the ${scope} scope.`
  );
}

function requireKey() {
  const key = apiKey();
  if (!key) throw new Error(unavailableReason());
  // The reference implementation checks this, and it is right to: a key that is
  // not valid base64 fails much later with a confusing 401.
  if (!/^[A-Za-z0-9+/=_-]+$/.test(key)) {
    throw new Error('the Open Cloud API key does not look like a key (expected base64)');
  }
  return key;
}

/**
 * Run a Luau script in a place, on Roblox's servers.
 *
 * @param {object} options
 * @param {string} options.script            Luau source to run
 * @param {string|number} options.universeId
 * @param {string|number} options.placeId
 * @param {string|number} [options.placeVersion]  defaults to the latest
 * @param {number} [options.timeoutMs]
 * @param {number} [options.pollMs]
 * @param {(state: string) => void} [options.onPoll]
 * @returns {Promise<object>} the completed task, plus `logs` and `logText`
 */
export async function executeLuau({
  script,
  universeId,
  placeId,
  placeVersion = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollMs = DEFAULT_POLL_MS,
  onPoll = null,
  sleep = defaultSleep,
  requestTimeoutMs = 60_000,
} = {}) {
  requireKey();
  if (!universeId) throw new Error('executeLuau needs a universeId (the experience id)');
  if (!placeId) throw new Error('executeLuau needs a placeId');
  if (typeof script !== 'string' || script.length === 0) throw new Error('executeLuau needs a script');
  const bytes = Buffer.byteLength(script, 'utf8');
  if (bytes > MAX_SCRIPT_BYTES) {
    throw new Error(`script is ${bytes} bytes; Open Cloud accepts up to ${MAX_SCRIPT_BYTES}`);
  }

  const created = await createTask({ universeId, placeId, placeVersion, script, requestTimeoutMs });
  if (!created || typeof created.path !== 'string') {
    throw new Error('Open Cloud did not return a task path');
  }

  const startedAt = Date.now();
  let task = created;
  while (task.state === 'PROCESSING') {
    if (Date.now() - startedAt > timeoutMs) {
      throw new ApiError(
        `the Open Cloud task did not finish within ${Math.round(timeoutMs / 1000)}s ` +
          `(place ${placeId}); it may still be running`,
        { path: task.path, state: task.state },
      );
    }
    if (onPoll) onPoll(task.state);
    await sleep(pollMs);
    task = await getTask(task.path, requestTimeoutMs);
  }

  const logs = await getTaskLogs(task.path, requestTimeoutMs).catch(() => null);
  return {
    ...task,
    logs,
    logText: logs ? joinLogs(logs) : '',
  };
}

async function createTask({ universeId, placeId, placeVersion, script, requestTimeoutMs }) {
  const parts = [`universes/${encodeURIComponent(universeId)}`, `places/${encodeURIComponent(placeId)}`];
  if (placeVersion !== null && placeVersion !== undefined && placeVersion !== '') {
    parts.push(`versions/${encodeURIComponent(placeVersion)}`);
  }
  parts.push('luau-execution-session-tasks');
  return requestTask(`${API_PREFIX}/${parts.join('/')}`, {
    method: 'POST',
    apiKey: requireKey(),
    baseUrl: baseUrl(),
    body: { script },
    timeoutMs: requestTimeoutMs,
  });
}

/**
 * Turn whatever the API called a task path into an endpoint under /cloud/v2.
 *
 * The documented shape is relative (`universes/1/places/2/...`) and the docs
 * build the URL by prefixing it, but a path that already carries the prefix is
 * accepted too rather than producing `/cloud/v2/cloud/v2/...`.
 */
export function taskEndpoint(path) {
  const cleaned = String(path).replace(/^\/+/, '').replace(/^cloud\/v2\//, '');
  return `${API_PREFIX}/${cleaned}`;
}

async function getTask(path, requestTimeoutMs = 60_000) {
  return requestTask(taskEndpoint(path), {
    apiKey: requireKey(),
    baseUrl: baseUrl(),
    timeoutMs: requestTimeoutMs,
  });
}

async function getTaskLogs(path, requestTimeoutMs = 60_000) {
  return requestTask(`${taskEndpoint(path)}/logs`, {
    apiKey: requireKey(),
    baseUrl: baseUrl(),
    timeoutMs: requestTimeoutMs,
  });
}

/**
 * Flatten the log response into text.
 *
 * The response is a list of log chunks, each carrying either `messages` or
 * `structuredMessages`, and a chunk may have neither. Every one of those shapes
 * is handled rather than assumed.
 */
export function joinLogs(response) {
  const chunks = response?.luauExecutionSessionTaskLogs;
  if (!Array.isArray(chunks)) return '';
  const messages = [];
  for (const chunk of chunks) {
    if (Array.isArray(chunk?.messages)) messages.push(...chunk.messages);
    else if (Array.isArray(chunk?.structuredMessages)) {
      for (const m of chunk.structuredMessages) {
        if (m && typeof m.message === 'string') messages.push(m.message);
      }
    }
  }
  return messages.map((m) => (m.endsWith('\n') ? m : `${m}\n`)).join('');
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export {
  publishPlace,
  explainPublishError,
  contentTypeFor,
  VERSION_TYPES,
} from './publish.js';

export { describeError, ApiError, MAX_SCRIPT_BYTES };
