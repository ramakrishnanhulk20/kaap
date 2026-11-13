// The engine folder, loaded the way a host loads it: copied by itself under a folder whose
// package.json says commonjs, with nothing of this package beside it. Run with `npm test` in
// packages/web. Found on the first deploy: the check route answered "could not run" because the
// folder's wasm glue is a module in a .js file and nothing shipped with it said so.
// Not covered: a real check, which needs the network, and the host's own packaging; both are
// checked against the running site.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ENGINE = fileURLToPath(new URL('../engine/', import.meta.url));

test('the engine folder loads by itself under a host root that says commonjs', () => {
  const root = mkdtempSync(join(tmpdir(), 'kaap-host-'));
  writeFileSync(join(root, 'package.json'), '{"type":"commonjs"}\n');
  cpSync(ENGINE, join(root, 'packages', 'web', 'engine'), { recursive: true });
  const load = [
    "import path from 'node:path';",
    "import { pathToFileURL } from 'node:url';",
    "const dir = path.join(process.cwd(), 'packages', 'web', 'engine');",
    "const kaap = await import(pathToFileURL(path.join(dir, 'kaap-check.mjs')).href);",
    "const core = await kaap.Core.load(dir);",
    "console.log(typeof core, typeof kaap.check);",
  ].join('\n');
  writeFileSync(join(root, 'load.mjs'), load);
  const out = execFileSync(process.execPath, ['load.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(out.trim(), 'object function');
});
