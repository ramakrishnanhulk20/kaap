#!/usr/bin/env node
import { main, realEnv } from './main.js';

try {
  process.exitCode = await main(process.argv.slice(2), realEnv(), {
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
  });
} catch (e) {
  process.stderr.write(`kaap stopped on an unexpected error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
}
