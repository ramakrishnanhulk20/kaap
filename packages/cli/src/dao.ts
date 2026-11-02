// C23: a pasted account is decoded only when it is a valid NEAR account id on the named network
// and its code hash is a Sputnik release. Anything else is "not a recognised DAO", whatever its
// name or its views claim to be, because a fake DAO can answer get_proposal with anything.
//
// The check is a code-hash predicate. It covers fakes and DAOs whose code was replaced. It does not
// cover a DAO that upgrades after the read (the sealed job's verdict pins the code for that, C4),
// and it says nothing about whether the DAO's members are honest.

import type { Block } from './rpc.js';
import { type AccountState, RpcError } from './rpc.js';
import type { Core } from './core.js';
import type { Reader } from './chain.js';

/** The code hashes `sputnik-dao.near` lists in `get_contracts_metadata` (read 2 Nov 2026). They
 *  are kept here as well as read live because a testnet DAO can run a mainnet release (Kaap's own
 *  testnet DAO runs 3.2), and the testnet factory lists only its own builds. */
export const MAINNET_RELEASES: ReadonlyMap<string, string> = new Map([
  ['8RMeZ5cXDap6TENxaJKtigRYf3n139iHmTRe8ZUNey6N', '2.0'],
  ['8jmhwSkNeAWCRqsr2KoD7d8BzDYorEz3a3iHuM9Gykrg', '2.1'],
  ['2Zof1Tyy4pMeJM48mDSi5ww2QQhTz97b9S8h6W6r4HnK', '3.0'],
  ['4zSoHkLjJWZm34Psd4Eq2WUXHELt6LxtKmUXpsZWAECp', '3.1'],
  ['DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF', '3.2'],
]);

/** NEAR's code hash of an account with no contract. */
const NO_CODE = '11111111111111111111111111111111';

export class NotADao extends Error {
  constructor(why: string) {
    super(`not a recognised DAO: ${why}`);
    this.name = 'NotADao';
  }
}

export interface Recognised {
  version: string;
  codeHash: string;
  account: AccountState;
}

/** The code an account runs: its own, or a global contract fixed by hash. Code fixed by another
 *  account's global contract can change under it, so it is never treated as known code. */
export function codeOf(account: AccountState): string | null {
  if (account.globalContractAccount !== null) return null;
  if (account.globalContractHash !== null) return account.globalContractHash;
  return account.codeHash === NO_CODE ? null : account.codeHash;
}

/** The factory's `get_contracts_metadata` as a map from code hash to "major.minor". Entries that do
 *  not read are skipped, which can only make fewer hashes known. */
export function versionsOf(metadataText: string): Map<string, string> {
  const out = new Map<string, string>();
  let list: unknown;
  try {
    list = JSON.parse(metadataText);
  } catch {
    return out;
  }
  if (!Array.isArray(list)) return out;
  for (const entry of list) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue;
    const version = (entry[1] as { version?: unknown } | undefined)?.version;
    if (Array.isArray(version) && version.length === 2 && version.every((n) => Number.isInteger(n))) out.set(entry[0], version.join('.'));
  }
  return out;
}

/** Checks `dao` against C23 at `block`, through both providers. Throws `NotADao` for an invalid
 *  id, a missing account, an account with no code or code that is no Sputnik release, and `Held`
 *  when the providers disagree. */
export async function recognise(core: Core, reader: Reader, factory: string, dao: string, block: Block): Promise<Recognised> {
  if (!core.isAccountId(dao)) throw new NotADao('this is not a valid NEAR account id');
  let account: AccountState;
  try {
    account = await reader.account(dao, block);
  } catch (e) {
    if (e instanceof RpcError && e.failure === 'missing_account') throw new NotADao('no account by this name exists on this network');
    throw e;
  }
  const code = codeOf(account);
  if (code === null) throw new NotADao('this account runs no fixed contract code');
  const metadata = await reader.sameView('the factory\'s Sputnik versions', factory, 'get_contracts_metadata', {}, block);
  const known = new Map([...MAINNET_RELEASES, ...versionsOf(metadata.text)]);
  const version = known.get(code);
  if (version === undefined) throw new NotADao(`its code hash ${code} is not a Sputnik release`);
  return { version, codeHash: code, account };
}

