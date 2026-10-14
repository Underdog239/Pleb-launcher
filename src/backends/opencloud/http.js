// The HTTP half of the Open Cloud backend.
//
// Kept separate from the task logic so the network calls can be swapped out in
// a test without a real API key, and so every failure mode is handled in one
// place: a rate limit, an expired key, a bad place id and a network timeout all
// need to arrive at the caller as a sentence, not as an unhandled rejection.

const DEFAULT_BASE = 'https://apis.roblox.com';

/**
 * Where the API lives.
 *
 * The environment override exists for tests and for anyone pointed at a
 * compatible endpoint; without it the real API is used.
 */
export function baseUrl() {
  return (process.env.ROBLOX_CLOUD_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '');
}

export class ApiError extends Error {
  constructor(message, { status = null, path = null, body = null, state = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.path = path;
    this.body = body;
    this.state = state;
  }
}

/** Roblox's error envelope: `{ code, message, details }`, sometimes as a string. */
function messageFromBody(body, fallback) {
  if (!body) return fallback;
  if (typeof body === 'string') return body.slice(0, 400);
  if (typeof body.message === 'string') return body.message;
  if (body.error && typeof body.error.message === 'string') return body.error.message;
  return fallback;
}

/**
 * One request against Open Cloud.
 *
 * @param {string} endpoint   path beginning with `/`, relative to the base URL
 * @param {{method?: string, apiKey?: string, baseUrl?: string, body?: object, bytes?: Uint8Array,
 *          contentType?: string, fetchImpl?: Function, timeoutMs?: number}} options
 */
export async function requestTask(endpoint, options = {}) {
  const {
    method = 'GET',
    apiKey,
    baseUrl,
    body = null,
    bytes = null,
    contentType = null,
    fetchImpl = globalThis.fetch,
    timeoutMs = 60_000,
  } = options;

  if (typeof fetchImpl !== 'function') {
    throw new ApiError('no fetch implementation available (node 18+ required)');
  }
  // Without this, a missing base URL fails as "Failed to parse URL from
  // undefined/..." several frames away from the actual mistake.
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    throw new ApiError(`requestTask needs a baseUrl; got ${JSON.stringify(baseUrl)}`);
  }

  const url = `${baseUrl}${endpoint}`;
  const headers = { Accept: 'application/json', 'User-Agent': 'studio-cli' };
  if (apiKey) headers['x-api-key'] = apiKey;
  // A place file goes up as raw bytes rather than JSON, which is why the
  // content type is a parameter instead of a constant.
  if (contentType) headers['Content-Type'] = contentType;
  else if (body !== null) headers['Content-Type'] = 'application/json';

  // A hung request would otherwise stall a CI job with no explanation.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const payload =
    bytes !== null ? bytes : body !== null ? JSON.stringify(body) : undefined;

  let res;
  try {
    res = await fetchImpl(url, {
      method,
      headers,
      ...(payload !== undefined ? { body: payload } : {}),
      signal: controller.signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new ApiError(`request to ${endpoint} timed out after ${timeoutMs}ms`, { path: endpoint });
    }
    throw new ApiError(describeError(err), { path: endpoint });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let parsed = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) {
    throw new ApiError(explainStatus(res.status, endpoint, parsed), {
      status: res.status,
      path: endpoint,
      body: parsed,
    });
  }
  return parsed;
}

/**
 * Turn an HTTP status into something a person can act on.
 *
 * A bare "429" is useless; "the place already has ten tasks running" is not.
 */
export function explainStatus(status, endpoint, body) {
  const detail = messageFromBody(body, '');
  const suffix = detail ? `: ${detail}` : '';
  switch (status) {
    case 400:
      return `Open Cloud rejected the request (400)${suffix}`;
    case 401:
      return (
        `Open Cloud rejected the API key (401)${suffix}. Check that the key is current ` +
        'and has the "universe.place.luau-execution-session:write" scope.'
      );
    case 403:
      return (
        `Open Cloud refused the request (403)${suffix}. The key is valid but is not ` +
        'allowed to act on this universe or place, or is missing the luau-execution scope.'
      );
    case 404:
      return (
        `not found (404)${suffix}. Check the universe id, the place id, and that the ` +
        'place has been published at least once — a place with no version cannot be loaded.'
      );
    case 409:
      return `conflict (409)${suffix}`;
    case 413:
      return `the file is too large (413)${suffix}`;
    case 422:
      return `Open Cloud could not process the request (422)${suffix}`;
    case 429:
      return (
        `rate limited (429)${suffix}. Open Cloud allows ten incomplete tasks per place and ` +
        'five task creations per minute; wait and retry.'
      );
    case 500:
    case 502:
    case 503:
    case 504:
      return `Open Cloud is unavailable (${status})${suffix}; this is usually transient`;
    default:
      return `Open Cloud returned ${status} for ${endpoint}${suffix}`;
  }
}

/** A network-level failure, phrased in terms of what probably caused it. */
export function describeError(err) {
  const code = err?.cause?.code || err?.code || '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return `cannot reach apis.roblox.com (${code}): DNS failed`;
  }
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET') {
    return `the connection to apis.roblox.com failed (${code})`;
  }
  if (code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
    return `TLS verification failed (${code}); a proxy may be intercepting the connection`;
  }
  return err?.message || String(err);
}
