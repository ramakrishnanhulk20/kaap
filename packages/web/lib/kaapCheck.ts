// Runs Kaap's keyless check on the server, with the very code the command line uses
// (packages/cli `check`), so the site and `kaap check` can never give two answers. The check reads
// one proposal at one final block from two providers and judges it with kaap-core as wasm. It
// holds no key and sends no transaction.
//
// That code comes from the `engine` folder beside this package, which scripts/bundle-engine.mjs
// builds: the command line's check as one file, kaap-core's wasm, and the deployment records the
// check reads. It is loaded at run time, not bundled into the site, because it finds the wasm
// by a path on disk.

import path from 'node:path';
import { pathToFileURL } from 'node:url';

export type Network = 'mainnet' | 'testnet';

export interface Finding {
  code: string;
  severity: string;
}

export interface CheckReport {
  network: Network;
  dao: string;
  proposal_id: number;
  block: { height: number; hash: string; timestamp_ns: string };
  providers: string[];
  dao_version: string;
  code_hash: string;
  status: string;
  proposer: string;
  description: string;
  kind_hash: string;
  policy_before: { known: boolean; source: string };
  history_source: string;
  prices_source: string;
  guard_account: string | null;
  kind_label: string;
  analysis: {
    effects: Record<string, unknown>[];
    findings: Finding[];
    risk_floor: string;
    description_check: string;
    must_veto: boolean;
    veto_allowed: boolean;
  };
  description_reasons: { agreements: string[]; contradictions: string[]; injection: unknown };
  advisory: string;
}

/** A text offered as the words behind a signed hash: the message, its 32-byte nonce in base64,
 *  the recipient it names and the signing standard it follows. */
export interface SuppliedText {
  message: string;
  nonce: string;
  recipient: string;
  standard: 'nep413' | 'nep461';
}

export interface CheckAsk {
  dao: string;
  id: number | null;
  network: Network;
  text?: SuppliedText;
}

export interface CheckAnswer {
  report: CheckReport;
  /** The decimal places of each token the price table knows, for showing amounts. */
  decimals: Record<string, number>;
}

/** Why a check gave no report, in the command line's own groups. */
export type Refusal = 'not_a_dao' | 'no_proposal' | 'held' | 'chain' | 'engine';

export class CheckRefused extends Error {
  constructor(
    readonly reason: Refusal,
    message: string,
  ) {
    super(message);
    this.name = 'CheckRefused';
  }
}

interface Cli {
  check: (deps: unknown, request: CheckAsk) => Promise<{ report: CheckReport; decimals: Map<string, number> }>;
  deps: unknown;
  refusalOf: (error: unknown) => Refusal | null;
}

const ENGINE = path.join(process.cwd(), 'engine');

let cli: Promise<Cli> | null = null;

async function loadCli(): Promise<Cli> {
  const kaap = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ pathToFileURL(path.join(ENGINE, 'kaap-check.mjs')).href);
  const deps = {
    core: await kaap.Core.load(ENGINE),
    transport: kaap.fetchTransport,
    limiter: new kaap.RateLimiter(kaap.REQUESTS_PER_SECOND, kaap.realClock),
    clock: kaap.realClock,
    // The deployment records sit in the engine folder at their paths in the repository.
    repoRoot: path.join(ENGINE, 'repo'),
  };
  const refusalOf = (error: unknown): Refusal | null => {
    if (error instanceof kaap.NotADao) return 'not_a_dao';
    if (error instanceof kaap.NoProposal) return 'no_proposal';
    if (error instanceof kaap.Held) return 'held';
    if (error instanceof kaap.RpcError || error instanceof kaap.NetError) return 'chain';
    if (error instanceof kaap.CoreError) return 'engine';
    return null;
  };
  return { check: kaap.check, deps, refusalOf };
}

/** Reads and judges one proposal. `id` null means the DAO's latest. With a `text`, kaap-core
 *  checks it against the hash the proposal asks to sign and reads it only if it matches. */
export async function runCheck(request: CheckAsk): Promise<CheckAnswer> {
  cli ??= loadCli();
  let loaded: Cli;
  try {
    loaded = await cli;
  } catch (error) {
    // A failed load is not kept, so the next request tries again.
    cli = null;
    throw error;
  }
  try {
    const { report, decimals } = await loaded.check(loaded.deps, request);
    return { report, decimals: Object.fromEntries(decimals) };
  } catch (error) {
    const reason = loaded.refusalOf(error);
    if (reason !== null && error instanceof Error) throw new CheckRefused(reason, error.message);
    throw error;
  }
}
