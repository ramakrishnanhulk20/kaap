// The code hashes of Sputnik DAO's releases (C23). An enrolled account whose code is not one of
// them is not a Sputnik DAO: the worker reads none of its views and pays for nothing on its
// behalf. The list is the data file next to this one, which states where it was read from.
//
// Not covered: a Sputnik release newer than the list. Such a DAO is not watched, and shows as
// not_a_sputnik_dao on /status, until the list gains its hash.

import { readFileSync } from 'node:fs';

const CODE_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

function load(): ReadonlyMap<string, string> {
  const file = JSON.parse(readFileSync(new URL('./sputnik-releases.json', import.meta.url), 'utf8')) as { releases?: unknown };
  const releases = file.releases;
  if (typeof releases !== 'object' || releases === null) throw new Error('sputnik-releases.json has no releases');
  const entries = Object.entries(releases as Record<string, unknown>);
  if (entries.length === 0 || !entries.every(([hash, version]) => CODE_HASH.test(hash) && typeof version === 'string')) throw new Error('sputnik-releases.json is not a list of code hashes');
  return new Map(entries as Array<[string, string]>);
}

/** Code hash, as NEAR writes it in base58, to the Sputnik version it is. */
export const SPUTNIK_RELEASES: ReadonlyMap<string, string> = load();
