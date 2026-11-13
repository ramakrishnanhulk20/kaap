// Builds packages/web/engine: what the site needs to run Kaap's keyless check on a host that has
// only this folder, with no Rust toolchain and none of the other packages.
//
//   kaap-check.mjs            the command line's check, bundled from packages/cli/src
//   kaap_core_wasm.js, .wasm  kaap-core as wasm, copied from packages/cli/wasm
//   repo/                     the deployment records the check reads, at their paths in the repo
//   BUILD.json                which commit and which wasm this is
//
// Run from packages/web:  npm run engine
// Build the wasm first (npm run build:wasm -w packages/cli). The folder is committed so a deploy
// needs nothing else; run this again whenever kaap-core, the command line or a record changes.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const web = fileURLToPath(new URL('../', import.meta.url));
const repo = join(web, '..', '..');
const out = join(web, 'engine');

const wasmDir = join(repo, 'packages', 'cli', 'wasm');
const wasmFiles = ['kaap_core_wasm.js', 'kaap_core_wasm_bg.wasm'];
for (const file of wasmFiles) {
  if (!existsSync(join(wasmDir, file))) throw new Error(`packages/cli/wasm/${file} is missing: build the wasm first`);
}

// The records `check` follows to find Kaap's guard on a network. A record names the one before
// it and its own list of sealed builds, so every record in the chain goes along with its list.
const records = [];
for (let record = 'deployments/testnet.json'; record; ) {
  records.push(record);
  const read = JSON.parse(readFileSync(join(repo, record), 'utf8'));
  const builds = typeof read.sealed?.builds === 'string' ? read.sealed.builds : 'packages/sealed/testnet.json';
  if (!/^packages\/sealed\/[a-z0-9.-]+\.json$/.test(builds)) throw new Error(`${record} names a list of sealed builds outside packages/sealed: ${builds}`);
  if (!records.includes(builds)) records.push(builds);
  record = typeof read.previous === 'string' && !records.includes(read.previous) ? read.previous : null;
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [join(web, 'scripts', 'engine-entry.ts')],
  outfile: join(out, 'kaap-check.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  // Comments are left out, the libraries' own included: the file is built, not read.
  minifyWhitespace: true,
  legalComments: 'none',
  logLevel: 'warning',
});

for (const file of wasmFiles) copyFileSync(join(wasmDir, file), join(out, file));
for (const record of records) {
  mkdirSync(dirname(join(out, 'repo', record)), { recursive: true });
  copyFileSync(join(repo, record), join(out, 'repo', record));
}

// The wasm glue is a module in a .js file. A host ships this folder with the check route and not
// this package's package.json, and may put one of its own above it that says commonjs, under
// which the glue does not load. So the folder says what its files are.
writeFileSync(join(out, 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`);

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const sources = ['packages/core', 'packages/core-wasm', 'packages/cli/src', 'packages/verdict'];
writeFileSync(
  join(out, 'BUILD.json'),
  `${JSON.stringify(
    {
      note: 'Written by packages/web/scripts/bundle-engine.mjs. Do not edit by hand.',
      commit: git('rev-parse', 'HEAD'),
      // False when the engine or the command line had changes not yet committed when this was built.
      sources_committed: git('status', '--porcelain', '--', ...sources) === '',
      wasm_sha256: sha256(join(out, 'kaap_core_wasm_bg.wasm')),
      check_sha256: sha256(join(out, 'kaap-check.mjs')),
      records,
    },
    null,
    2,
  )}\n`,
);
console.log(`wrote ${out}`);
console.log(readFileSync(join(out, 'BUILD.json'), 'utf8'));
