// The Open Cloud stub as a standalone process, for the CLI tests.
//
// The CLI is driven through spawnSync, which blocks the test process's event
// loop, so an in-process server could never answer it. This entry point starts
// the same server (test/fixtures/stub-server.mjs) and prints its port on stdout,
// which is how the test learns where to point ROBLOX_CLOUD_BASE_URL.
//
// STUB_FAIL=1 makes the task end FAILED, for the failure path.

import { createStubServer } from './stub-server.mjs';

const stub = await createStubServer({ shouldFail: process.env.STUB_FAIL === '1' });
process.stdout.write(`${stub.port}\n`);

const shutdown = () => stub.close().then(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
