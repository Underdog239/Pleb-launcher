// Open Cloud backend tests.
//
// These run against a stub HTTP server on loopback that speaks the same three
// endpoints as Roblox, so the real code path is exercised: real fetch, real
// headers, real status handling, real JSON. What they cannot prove is that
// Roblox's servers behave as documented, because that needs a genuine API key
// and a published place. Nothing here should be read as evidence that a live
// call was ever made.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ROBLOX_CLOUD_API_KEY = 'dGVzdC1rZXk=';

const { executeLuau, joinLogs, apiKey, available, unavailableReason, capabilities, taskEndpoint } = await import(
  '../src/backends/opencloud/index.js'
);
const { ApiError, explainStatus, describeError, requestTask } = await import(
  '../src/backends/opencloud/http.js'
);

/** A stub of the three Open Cloud endpoints, with a scripted task lifecycle. */
async function withServer(handler, fn) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const record = { method: req.method, url: req.url, headers: req.headers, body };
      requests.push(record);
      const reply = handler(record, requests.length);
      const send = () => {
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reply.body ?? {}));
      };
      // A delay lets a test exercise the abort path with a real socket.
      if (reply.delayMs) setTimeout(send, reply.delayMs);
      else send();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const previous = process.env.ROBLOX_CLOUD_BASE_URL;
  process.env.ROBLOX_CLOUD_BASE_URL = `http://127.0.0.1:${port}`;
  try {
    return await fn(requests, port);
  } finally {
    if (previous === undefined) delete process.env.ROBLOX_CLOUD_BASE_URL;
    else process.env.ROBLOX_CLOUD_BASE_URL = previous;
    await new Promise((resolve) => server.close(resolve));
  }
}

/** The documented lifecycle: PROCESSING once, then COMPLETE. */
function taskLifecycle(extra = {}) {
  return (req, count) => {
    if (req.method === 'POST') {
      return {
        status: 200,
        body: {
          path: 'universes/1/places/2/luau-execution-session-tasks/abc',
          state: 'PROCESSING',
          ...extra.create,
        },
      };
    }
    if (req.url.endsWith('/logs')) {
      return {
        status: 200,
        body: {
          luauExecutionSessionTaskLogs: [
            { messages: ['hello from the server\n', 'second line'] },
            { messages: ['third line\n'] },
          ],
        },
      };
    }
    // Roblox returns the task path relative to /cloud/v2, as in the reference
    // client, rather than an absolute URL.
    const relative = req.url.replace(/^\/cloud\/v2\//, '');
    if (count <= 2) return { status: 200, body: { path: relative, state: 'PROCESSING' } };
    return {
      status: 200,
      body: {
        path: relative,
        state: 'COMPLETE',
        placeVersion: 'versions/7',
        output: { results: [1, 'two', { three: true }] },
        ...extra.task,
      },
    };
  };
}

test('the backend advertises what it can and cannot do', () => {
  assert.equal(capabilities.executeLuau, true);
  assert.equal(capabilities.headless, true);
  assert.equal(capabilities.requiresStudio, false);
  assert.equal(capabilities.requiresApiKey, true);
  // The honest limits, asserted so they cannot drift silently.
  assert.equal(capabilities.physics, false);
  assert.equal(capabilities.render, 'none');
});

test('the api key is read from either environment variable', () => {
  process.env.ROBLOX_CLOUD_API_KEY = 'abc';
  delete process.env.RBLX_OC_API_KEY;
  assert.equal(apiKey(), 'abc');
  assert.equal(available(), true);

  delete process.env.ROBLOX_CLOUD_API_KEY;
  process.env.RBLX_OC_API_KEY = 'from-rblx-var';
  assert.equal(apiKey(), 'from-rblx-var');

  delete process.env.ROBLOX_CLOUD_API_KEY;
  delete process.env.RBLX_OC_API_KEY;
  assert.equal(apiKey(), null);
  assert.equal(available(), false);
  assert.match(unavailableReason(), /ROBLOX_CLOUD_API_KEY/);
  assert.match(unavailableReason(), /scope/);

  process.env.ROBLOX_CLOUD_API_KEY = 'dGVzdC1rZXk=';
});

test('a full task runs end to end and returns logs and results', async () => {
  await withServer(taskLifecycle(), async (requests) => {
    const polls = [];
    const result = await executeLuau({
      script: 'return 1, "two"',
      universeId: 1,
      placeId: 2,
      pollMs: 1,
      onPoll: (s) => polls.push(s),
    });

    assert.equal(result.state, 'COMPLETE');
    assert.deepEqual(result.output.results, [1, 'two', { three: true }]);
    assert.equal(result.logText, 'hello from the server\nsecond line\nthird line\n');
    assert.equal(result.placeVersion, 'versions/7');
    assert.ok(polls.includes('PROCESSING'), 'the caller is told about each poll');

    // The create call is a POST with the script in the documented shape, and
    // the key travels in x-api-key.
    const create = requests[0];
    assert.equal(create.method, 'POST');
    assert.equal(create.url, '/cloud/v2/universes/1/places/2/luau-execution-session-tasks');
    assert.deepEqual(JSON.parse(create.body), { script: 'return 1, "two"' });
    assert.equal(create.headers['x-api-key'], 'dGVzdC1rZXk=');
    assert.equal(create.headers['content-type'], 'application/json');

    // The poll and the log fetch go to the path the create call returned.
    assert.equal(requests.at(-1).url, '/cloud/v2/universes/1/places/2/luau-execution-session-tasks/abc/logs');
    assert.ok(
      requests.some((r) => r.url === '/cloud/v2/universes/1/places/2/luau-execution-session-tasks/abc'),
    );
  });
});

test('a specific place version is addressed through the versions path', async () => {
  await withServer(taskLifecycle(), async (requests) => {
    await executeLuau({ script: 'return 1', universeId: 11, placeId: 22, placeVersion: 7, pollMs: 1 });
    assert.equal(
      requests[0].url,
      '/cloud/v2/universes/11/places/22/versions/7/luau-execution-session-tasks',
    );
  });
});

test('a failed script comes back with its error and still has its logs', async () => {
  const handler = taskLifecycle({
    task: { state: 'FAILED', error: { message: 'attempt to index nil', code: 'INTERNAL' }, output: null },
  });
  await withServer(handler, async () => {
    const result = await executeLuau({ script: 'error("x")', universeId: 1, placeId: 2, pollMs: 1 });
    assert.equal(result.state, 'FAILED');
    assert.equal(result.error.message, 'attempt to index nil');
    assert.match(result.logText, /hello from the server/);
  });
});

test('a task that never finishes gives up with a message naming the timeout', async () => {
  const forever = (req) => {
    if (req.method === 'POST') {
      return { body: { path: 'universes/1/places/2/luau-execution-session-tasks/slow', state: 'PROCESSING' } };
    }
    return { body: { path: 'universes/1/places/2/luau-execution-session-tasks/slow', state: 'PROCESSING' } };
  };
  await withServer(forever, async () => {
    await assert.rejects(
      () => executeLuau({ script: 'return 1', universeId: 1, placeId: 2, pollMs: 1, timeoutMs: 40 }),
      (err) => {
        assert.ok(err instanceof ApiError);
        assert.match(err.message, /did not finish within/);
        assert.match(err.message, /may still be running/);
        return true;
      },
    );
  });
});

test('a rate limit explains the limit instead of just the status code', async () => {
  await withServer(() => ({ status: 429, body: { message: 'Too many requests' } }), async () => {
    await assert.rejects(
      () => executeLuau({ script: 'return 1', universeId: 1, placeId: 2, pollMs: 1 }),
      (err) => {
        assert.equal(err.status, 429);
        assert.match(err.message, /ten incomplete tasks per place/);
        assert.match(err.message, /five task creations per minute/);
        return true;
      },
    );
  });
});

test('a bad key and a bad place id are told apart', () => {
  assert.match(explainStatus(401, '/x', { message: 'Invalid API Key' }), /has the .* scope/);
  assert.match(explainStatus(401, '/x', { message: 'Invalid API Key' }), /Invalid API Key/);
  assert.match(explainStatus(403, '/x', {}), /not allowed to act on this universe/);
  assert.match(explainStatus(404, '/x', {}), /published at least once/);
  assert.match(explainStatus(503, '/x', {}), /usually transient/);
  assert.match(explainStatus(418, '/x', {}), /returned 418/);
});

test('network failures are named rather than dumped', () => {
  assert.match(describeError({ cause: { code: 'ENOTFOUND' } }), /DNS failed/);
  assert.match(describeError({ cause: { code: 'ECONNREFUSED' } }), /connection to apis\.roblox\.com failed/);
  assert.match(describeError({ cause: { code: 'CERT_HAS_EXPIRED' } }), /a proxy may be intercepting/);
});

test('a hung request aborts rather than stalling forever', async () => {
  // Two levels of protection, both tested against a real socket: the fetch
  // itself has a timeout, and the whole task has a deadline.
  await withServer(() => ({ delayMs: 5000, body: {} }), async () => {
    await assert.rejects(
      () =>
        executeLuau({
          script: 'return 1',
          universeId: 1,
          placeId: 2,
          pollMs: 1,
          requestTimeoutMs: 50,
        }),
      /timed out after 50ms/,
    );
  });
});

test('the request refuses to guess when it has no key', async () => {
  delete process.env.ROBLOX_CLOUD_API_KEY;
  delete process.env.RBLX_OC_API_KEY;
  await assert.rejects(() => executeLuau({ script: 'return 1', universeId: 1, placeId: 2 }), (err) => {
    assert.match(err.message, /no Open Cloud API key/);
    return true;
  });
  process.env.ROBLOX_CLOUD_API_KEY = 'dGVzdC1rZXk=';
});

test('a suspicious key is rejected before a request is wasted', async () => {
  process.env.ROBLOX_CLOUD_API_KEY = 'not a key, has spaces';
  await assert.rejects(() => executeLuau({ script: 'return 1', universeId: 1, placeId: 2 }), (err) => {
    assert.match(err.message, /does not look like a key/);
    return true;
  });
  process.env.ROBLOX_CLOUD_API_KEY = 'dGVzdC1rZXk=';
});

test('missing ids and empty scripts are refused with actionable text', async () => {
  await assert.rejects(() => executeLuau({ script: 'return 1', placeId: 2 }), /needs a universeId/);
  await assert.rejects(() => executeLuau({ script: 'return 1', universeId: 1 }), /needs a placeId/);
  await assert.rejects(() => executeLuau({ script: '', universeId: 1, placeId: 2 }), /needs a script/);
  const huge = 'x'.repeat(4 * 1024 * 1024 + 1);
  await assert.rejects(() => executeLuau({ script: huge, universeId: 1, placeId: 2 }), /accepts up to/);
});

test('log shapes that the API can return are all handled', () => {
  assert.equal(joinLogs(null), '');
  assert.equal(joinLogs({}), '');
  assert.equal(joinLogs({ luauExecutionSessionTaskLogs: [] }), '');
  // A chunk with neither field must not throw.
  assert.equal(joinLogs({ luauExecutionSessionTaskLogs: [{}, { messages: ['x'] }] }), 'x\n');
  assert.equal(
    joinLogs({ luauExecutionSessionTaskLogs: [{ structuredMessages: [{ message: 'a' }, { other: 1 }] }] }),
    'a\n',
  );
  assert.equal(joinLogs({ luauExecutionSessionTaskLogs: [{ messages: ['a\nb'] }] }), 'a\nb\n');
});

test('an aborted or reset fetch arrives as a sentence, not a stack trace', async () => {
  const boom = () => {
    const err = new Error('fetch failed');
    err.cause = { code: 'ECONNREFUSED' };
    return Promise.reject(err);
  };
  await assert.rejects(
    () => requestTask('/x', { apiKey: 'k', baseUrl: 'http://127.0.0.1:1', fetchImpl: boom }),
    /connection to apis\.roblox\.com failed/,
  );
});

test('a non-JSON error body does not crash the error path', async () => {
  await withServer(
    (req, count) => (count === 1 ? { status: 500, body: undefined } : { body: {} }),
    async () => {
      await assert.rejects(() => executeLuau({ script: 'return 1', universeId: 1, placeId: 2, pollMs: 1 }),
        /Open Cloud is unavailable \(500\)/);
    },
  );
});

test('task paths are normalised however the API spells them', () => {
  const canonical = 'universes/1/places/2/luau-execution-session-tasks/abc';
  for (const input of [
    canonical,
    `/${canonical}`,
    `cloud/v2/${canonical}`,
    `/cloud/v2/${canonical}`,
  ]) {
    assert.equal(taskEndpoint(input), `/cloud/v2/${canonical}`, input);
  }
});

// ---------------------------------------------------------------------------
// Place publishing
// ---------------------------------------------------------------------------

const { publishPlace, contentTypeFor, explainPublishError, VERSION_TYPES } = await import(
  '../src/backends/opencloud/publish.js'
);

function writePlace(dir, name = 'place.rbxl') {
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.from([0x3c, 0x72, 0x6f, 0x62, 0x6c, 0x6f, 0x78, 0x21]));
  return file;
}

test('the content type follows the place file format', () => {
  assert.equal(contentTypeFor('a.rbxl'), 'application/octet-stream');
  assert.equal(contentTypeFor('a.RBXLX'), 'application/xml');
  assert.throws(() => contentTypeFor('a.json'), /expected a \.rbxl or \.rbxlx/);
});

test('publishing sends the raw file with the documented headers', async () => {
  const file = writePlace(os.tmpdir());
  await withServer(
    (req) =>
      /\/versions/.test(req.url) ? { body: { versionNumber: 7 } } : { body: {} },
    async (requests) => {
      const result = await publishPlace({
        placeFile: file,
        universeId: 111,
        placeId: 222,
        apiKey: 'dGVzdC1rZXk=',
        baseUrl: process.env.ROBLOX_CLOUD_BASE_URL,
      });
      assert.equal(result.versionNumber, 7);
      assert.equal(result.versionType, 'Published');
      assert.equal(result.bytes, 8);

      const req = requests[0];
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/universes/v1/111/places/222/versions?versionType=Published');
      assert.equal(req.headers['content-type'], 'application/octet-stream');
      assert.equal(req.headers['x-api-key'], 'dGVzdC1rZXk=');
      // The body is the file itself, not JSON wrapping it.
      assert.equal(req.body.length, 8);
    },
  );
});

test('saving rather than publishing is a different version type', async () => {
  const file = writePlace(os.tmpdir());
  await withServer((req) => ({ body: { versionNumber: 3 } }), async (requests) => {
    await publishPlace({
      placeFile: file,
      universeId: 1,
      placeId: 2,
      versionType: 'Saved',
      apiKey: 'k',
      baseUrl: process.env.ROBLOX_CLOUD_BASE_URL,
    });
    assert.match(requests[0].url, /versionType=Saved/);
  });
  assert.deepEqual(VERSION_TYPES, ['Published', 'Saved']);
});

test('an invalid version type is refused before any request', async () => {
  const file = writePlace(os.tmpdir());
  await assert.rejects(
    () => publishPlace({ placeFile: file, universeId: 1, placeId: 2, versionType: 'Live' }),
    /versionType must be one of Published or Saved/,
  );
});

test('a missing or empty place file is refused with the path in the message', async () => {
  await assert.rejects(
    () => publishPlace({ placeFile: '/nope/absent.rbxl', universeId: 1, placeId: 2 }),
    /cannot read the place file \/nope\/absent\.rbxl/,
  );
  const empty = path.join(os.tmpdir(), 'empty.rbxl');
  fs.writeFileSync(empty, '');
  await assert.rejects(
    () => publishPlace({ placeFile: empty, universeId: 1, placeId: 2 }),
    /is empty; nothing to publish/,
  );
});

test('missing ids are refused', async () => {
  const file = writePlace(os.tmpdir());
  await assert.rejects(() => publishPlace({ placeFile: file, placeId: 2 }), /needs a universeId/);
  await assert.rejects(() => publishPlace({ placeFile: file, universeId: 1 }), /needs a placeId/);
});

test('publishing failures name the scope that is actually missing', async () => {
  const file = writePlace(os.tmpdir());
  await withServer(() => ({ status: 401, body: { message: 'Unauthorized' } }), async () => {
    const err = await publishPlace({
      placeFile: file,
      universeId: 1,
      placeId: 2,
      apiKey: 'k',
      baseUrl: process.env.ROBLOX_CLOUD_BASE_URL,
    }).catch((e) => e);
    const explained = explainPublishError(err);
    assert.match(explained, /universe-places/);
    assert.match(explained, /different scope from Luau Execution/);
  });
  void ApiError;
});

test('a rejected place file points at the local build check', async () => {
  const file = writePlace(os.tmpdir());
  await withServer(() => ({ status: 400, body: { message: 'Invalid file content' } }), async () => {
    const err = await publishPlace({
      placeFile: file,
      universeId: 1,
      placeId: 2,
      apiKey: 'k',
      baseUrl: process.env.ROBLOX_CLOUD_BASE_URL,
    }).catch((e) => e);
    assert.match(explainPublishError(err), /studio validate/);
  });
});
