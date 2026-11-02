// `kaap eval`: runs kaap-core over the public answer key and prints the agreement tables. No key and
// no network: it reads three files from a clone of the repository. It reads only the public sets
// (eval/real and eval/planted); the private second set is never opened.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Core, Scoreboards } from './core.js';

export const REAL = 'eval/real/labels.jsonl';
export const PLANTED = 'eval/planted/labels.jsonl';
/** The census token list kaap-core's own tests price with, so the numbers match theirs. */
export const TOKENS = 'packages/core/tests/fixtures/tokens.json';

export class MissingFiles extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingFiles';
  }
}

export function evaluate(core: Core, repoRoot: string): Scoreboards {
  const missing = [REAL, PLANTED, TOKENS].filter((f) => !existsSync(join(repoRoot, f)));
  if (missing.length) throw new MissingFiles(`kaap eval runs from a clone of the Kaap repository; not found under ${repoRoot}: ${missing.join(', ')}`);
  const read = (f: string) => readFileSync(join(repoRoot, f), 'utf8');
  return core.evalScoreboards(read(REAL), read(PLANTED), read(TOKENS));
}

export function render(boards: Scoreboards): string {
  const pct = (agree: number, of: number) => (of === 0 ? '-' : `${((100 * agree) / of).toFixed(1)}%`);
  const lines = [
    `kaap eval: kaap-core on the public answer key (${REAL}: ${boards.records.real} records, ${PLANTED}: ${boards.records.planted} records)`,
    `no keys, no network; prices from ${TOKENS}, the census token list kaap-core's own tests use`,
    `records run: ${boards.records.run}, not readable: ${boards.records.unreadable}`,
  ];
  for (const board of boards.boards) {
    lines.push('', board.title, `  ${'measure'.padEnd(48)} ${'agree'.padStart(6)} ${'of'.padStart(6)} ${'percent'.padStart(8)}`);
    for (const row of board.rows) {
      lines.push(`  ${row.measure.padEnd(48)} ${String(row.agree).padStart(6)} ${String(row.of).padStart(6)} ${pct(row.agree, row.of).padStart(8)}`);
    }
  }
  lines.push(
    '',
    'The same scoreboards as cargo test -p kaap-core --test eval, value_eval, policy_eval, describe_eval and hash_eval.',
    'A measure marked "no desc/hash code" counts only records whose label has no description or hash finding.',
  );
  return lines.join('\n');
}
