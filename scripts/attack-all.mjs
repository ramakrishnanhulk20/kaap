#!/usr/bin/env node
// Runs every file of the attack suite in order and writes what happened to
// packages/attack/RESULTS.md, newest run on top.
//
//   node scripts/attack-all.mjs
//
// Testnet only, inside WSL with Node 24 and near-api-js at the repo root, after
// node packages/attack/lib/test-set.mjs has set up the copies under attack. Exits non-zero when
// any attack fails or any file cannot run. About nine minutes, and well under 1 NEAR of testnet gas
// from a faucet account.
//
// What this does NOT cover: it adds nothing to the six files; it only runs them and keeps their
// lines. What each file leaves out is in its own first comment.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LIVE, provider } from '../packages/attack/lib/chain.mjs';
import { REPO } from '../packages/attack/lib/core.mjs';
import { TEST_SET_FILE, testSet } from '../packages/attack/lib/test-set.mjs';

const DIR = join(REPO, 'packages', 'attack', 'attacks');
const RESULTS = join(REPO, 'packages', 'attack', 'RESULTS.md');
const LINE = /^ATTACK (\S+): (.*) -> EXPECTED (.*) -> OBSERVED (.*) -> (PASS|FAIL)$/;
const EARLIER = '## Earlier runs';

// A read, so asking again is harmless. It is asked again because the six files take minutes, the
// node closes the connection this process opened before them, and the first use of it then fails.
async function finalBlock() {
  for (let attempt = 1; ; attempt++) {
    try {
      return (await provider.viewBlock({ finality: 'final' })).header.height;
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}
const cell = (text) => text.replace(/\|/g, '\\|').replace(/https:\/\/testnet\.nearblocks\.io\/txns\/([1-9A-HJ-NP-Za-km-z]+)/g, '[transaction](https://testnet.nearblocks.io/txns/$1)');

const set = await testSet();
const record = JSON.parse(readFileSync(TEST_SET_FILE, 'utf8'));
const startedAt = new Date().toISOString();
const firstBlock = await finalBlock();
const files = readdirSync(DIR).filter((f) => /^\d\d-.*\.mjs$/.test(f)).sort();

const sections = [];
let passed = 0;
let failed = 0;
for (const file of files) {
  console.log(`\n== ${file}`);
  const run = spawnSync(process.execPath, [join(DIR, file)], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  process.stdout.write(run.stdout);
  process.stderr.write(run.stderr);
  const rows = run.stdout.split('\n').map((l) => l.match(LINE)).filter(Boolean);
  const pass = rows.filter((r) => r[5] === 'PASS').length;
  // A file that exits non-zero without a failing line did not finish, and that is a failure too.
  const broke = run.status !== 0 && pass === rows.length ? 1 : 0;
  passed += pass;
  failed += rows.length - pass + broke;
  sections.push([
    `### ${file}: ${pass} of ${rows.length} as expected${broke ? ', and the file did not finish' : ''}`,
    '',
    '| # | The attack | Expected | Observed | Result |',
    '|---|---|---|---|---|',
    ...rows.map((r) => `| ${r[1]} | ${cell(r[2])} | ${cell(r[3])} | ${cell(r[4])} | ${r[5]} |`),
  ].join('\n'));
}
const lastBlock = await finalBlock();
const verdict = failed === 0 && passed > 0 ? `all ${passed} as expected` : `${failed} NOT as expected, ${passed} as expected`;
const summary = `${startedAt}: ${verdict}, final blocks ${firstBlock} to ${lastBlock}`;

let earlier = [];
if (existsSync(RESULTS)) {
  const old = readFileSync(RESULTS, 'utf8');
  const last = old.match(/^Newest run: (.*)$/m)?.[1];
  const at = old.indexOf(EARLIER);
  earlier = [...(last ? [`- ${last}`] : []), ...(at < 0 ? [] : old.slice(at + EARLIER.length).split('\n').filter((l) => l.startsWith('- ')))];
}

const text = [
  '# Attack suite results',
  '',
  'Written by `node scripts/attack-all.mjs`. Every row was run on NEAR testnet: a transaction sent by a throwaway faucet account, or a view. A row marked CONTROL shows the honest path still works; a row marked BY DESIGN is a door that is open on purpose, with what walking through it changes. The other rows are the attacks.',
  '',
  `Newest run: ${summary}`,
  '',
  '## What was attacked',
  '',
  '| | Account | Code hash on chain at the start of this run |',
  '|---|---|---|',
  `| Guard under attack | \`${set.guard}\` | \`${set.guardCode}\` |`,
  `| Live guard, read only | \`${LIVE.guard}\` | \`${set.liveGuardCode}\` |`,
  `| Registry under attack | \`${set.registry}\` | \`${set.registryCode}\` |`,
  `| Live registry, read only | \`${LIVE.registry}\` | \`${set.liveRegistryCode}\` |`,
  '',
  `The copies run the same code as the live contracts and trust a public test key, \`${record.test_key.public_key}\`, so the suite can sign any verdict it likes. The treasuries are throwaway Sputnik 3.2 DAOs: \`${set.dao}\`, \`${set.strictDao}\` (strict mode) and \`${set.unenrolledDao}\` (never enrolled). The live deployment is never sent a transaction.`,
  '',
  '## The run',
  '',
  sections.join('\n\n'),
  '',
  EARLIER,
  '',
  ...(earlier.length ? earlier : ['- none']),
  '',
].join('\n');
writeFileSync(RESULTS, text);
console.log(`\nattack suite: ${verdict}; written to packages/attack/RESULTS.md`);
process.exit(failed === 0 && passed > 0 ? 0 : 1);
