// kaap-core as WebAssembly, the build packages/core-wasm makes, so the attack suite reads kinds,
// hashes and verdicts with the same Rust as the sealed job, the guard and the CLI (C14).

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DIR = join(REPO, 'packages', 'core-wasm', 'pkg');

async function load() {
  const glue = join(DIR, 'kaap_core_wasm.js');
  const wasm = join(DIR, 'kaap_core_wasm_bg.wasm');
  if (!existsSync(glue) || !existsSync(wasm)) {
    throw new Error(`kaap-core-wasm is not built: run bash packages/core-wasm/build.sh (expected ${glue})`);
  }
  // The glue is an ES module in a folder with no package.json, which Node loads only after printing
  // a warning. It imports nothing, so it is loaded from its own text instead.
  const core = await import(`data:text/javascript;base64,${readFileSync(glue).toString('base64')}`);
  core.initSync({ module: readFileSync(wasm) });
  return core;
}

export const core = await load();
