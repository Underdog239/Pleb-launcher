// An in-process stand-in for Roblox's Open Cloud Luau Execution endpoints.
//
// Used by tests that can await the backend directly. The CLI tests cannot use
// this one — they drive the real binary with spawnSync, which blocks this
// process's event loop — so test/fixtures/opencloud-stub.mjs exposes the same
// server as a standalone process, and both build on createStubServer.

import http from 'node:http';

/**
 * Start the stub.
 *
 * @param {{shouldFail?: boolean}} [options] when shouldFail, the task ends FAILED
 * @returns {Promise<{baseUrl: string, port: number, requests: object[], close: () => Promise<void>}>}
 */
export async function createStubServer({ shouldFail = false } = {}) {
  const requests = [];
  const state = { polls: 0, receivedScript: '', published: [] };
  const path = 'universes/1/places/2/luau-execution-session-tasks/stubtask';

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const send = (payload) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      // Place publishing: v1 under /universes, raw file body, versionNumber back.
      if (req.method === 'POST' && /\/universes\/v1\/.+\/places\/.+\/versions/.test(req.url)) {
        const bytes = Buffer.from(body, 'binary');
        state.published.push({
          url: req.url,
          contentType: req.headers['content-type'],
          bytes: bytes.length,
          apiKey: req.headers['x-api-key'],
        });
        return send({ versionNumber: state.published.length + 40 });
      }
      if (req.method === 'POST') {
        state.receivedScript = JSON.parse(body || '{}').script ?? '';
        // Echo back the version that was addressed, so a caller can prove which
        // one it asked for (a deploy must pin the version it just published).
        const requested = /\/versions\/(\d+)\//.exec(req.url);
        state.requestedVersion = requested ? Number(requested[1]) : null;
        return send({
          path,
          state: 'PROCESSING',
          createTime: 'now',
          ...(requested ? { placeVersion: `versions/${requested[1]}` } : {}),
        });
      }
      if (req.url.endsWith('/logs')) {
        return send({
          luauExecutionSessionTaskLogs: [
            { messages: ['stub: script received\n', `script was: ${state.receivedScript}\n`] },
          ],
        });
      }
      state.polls += 1;
      if (state.polls <= 1) return send({ path, state: 'PROCESSING' });
      if (shouldFail) {
        return send({
          path,
          state: 'FAILED',
          placeVersion: 'versions/4',
          error: { code: 'INTERNAL', message: 'stub script failed on purpose' },
        });
      }
      return send({
        path,
        state: 'COMPLETE',
        placeVersion:
          state.requestedVersion !== null && state.requestedVersion !== undefined
            ? `versions/${state.requestedVersion}`
            : 'versions/4',
        output: { results: { ok: true, answer: 42 } },
      });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    requests,
    state,
    /** Every accepted place file, in order. */
    published: state.published,
    /** The task path the last publish returned, for a deploy-pins-the-version test. */
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Convenience for tests that only need a running stub. */
export async function startOpenCloudStub(options) {
  return createStubServer(options);
}
