// `kaap eval` over the repository's public answer key: the numbers kaap-core's own Rust scoreboards
// print today (`cargo test -p kaap-core`), through the wasm build. Where a count is short of its
// total, the records behind the gap are named beside it. It does not judge whether the key or
// kaap-core is right where they differ (the packages/core/docs/answer-key-notes files do),
// and it does not cover the private second set, which the CLI never reads.

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Core } from '../src/core.js';
import { evaluate, MissingFiles } from '../src/evaluate.js';
import { main } from '../src/main.js';
import { fakeClock, REPO_ROOT } from './replay.js';

const row = (measure: string, agree: number, of: number) => new RegExp(`\\n  ${measure.replace(/[()/]/g, '\\$&')}\\s+${agree}\\s+${of}\\s`);

test('kaap eval prints the scoreboards cargo test -p kaap-core prints, with no network', async () => {
  const out: string[] = [];
  const env = { transport: async () => assert.fail('kaap eval made a network request'), clock: fakeClock(), loadCore: () => Core.load(), repoRoot: REPO_ROOT };
  assert.equal(await main(['eval'], env, { out: (t) => out.push(t), err: (t) => out.push(t) }), 0);
  const text = out.join('\n');
  const sections = text.split('\n\n');
  const section = (title: RegExp) => sections.find((s) => title.test(s)) ?? assert.fail(`no section ${title}`);

  const policy = section(/^Policy and governance: 129 records/);
  for (const [measure, agree, of] of [
    ['owned codes', 129, 129],
    ['risk floor (no desc/hash code)', 97, 97],
    ['must_veto (no desc/hash code)', 97, 97],
    ['veto_allowed (no desc/hash code)', 97, 97],
  ] as const) {
    assert.match(`\n${policy}\n`, row(measure, agree, of), measure);
  }
  const describe = section(/^Description check: 373 records/);
  for (const [measure, agree, of] of [
    ['description_check', 356, 373],
    ['DESC_CONTRADICTS present', 373, 373],
    ['PROMPT_INJECTION present', 373, 373],
    // Two short of the key on purpose: planted:44 and planted:46 carry only words addressed to a
    // model, which Kaap rates high and never vetoes on (answer-key-notes/engine-stricter-than-key.md).
    ['must_veto, labels with no hash code', 335, 337],
  ] as const) {
    assert.match(`\n${describe}\n`, row(measure, agree, of), measure);
  }
  const value = section(/^Value moves: 205 records/);
  for (const [measure, agree, of] of [
    // Five short of the key on purpose, the same five in each row: burrow.sputnik-dao.near proposals
    // 1395, 1399, 1465, 1499 and 1634 on mainnet, calls Kaap now reads as unknown and high where the
    // key has a known DeFi call and low (answer-key-notes/engine-stricter-than-key.md).
    ['effects multiset', 200, 205],
    ['owned codes', 200, 205],
    ['must_veto and veto_allowed (no desc/hash code)', 142, 147],
  ] as const) {
    assert.match(`\n${value}\n`, row(measure, agree, of), measure);
  }
  const hash = section(/^Hash check: 32 real sign requests and 10 planted/);
  for (const measure of ['finding_codes', 'risk_floor', 'must_veto', 'veto_allowed', 'effects']) {
    assert.match(`\n${hash}\n`, row(measure, 42, 42), measure);
  }
});

test('kaap eval outside a clone names the public files it needs and never the private set', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'kaap-eval-'));
  const core = await Core.load();
  assert.throws(() => evaluate(core, empty), (e: unknown) => e instanceof MissingFiles && /eval\/real\/labels\.jsonl/.test(e.message) && !/eval-nb/.test(e.message));
});
