#!/usr/bin/env node
import { run } from '../src/cli.js';

run().catch((err) => {
  process.stderr.write(`fatal: ${err?.stack || err}\n`);
  process.exit(1);
});
