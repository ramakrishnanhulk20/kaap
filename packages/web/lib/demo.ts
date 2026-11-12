// The "try it yourself" button, server side. It files one prepared fake theft on the demo
// treasury on NEAR testnet and then only reads: Kaap's watcher is not told, and has to notice the
// request, have it judged in sealed hardware and get the guard to reject it by itself.
//
// The filing is signed with KAAP_DEMO_FILER_KEY, an access key of the demo member that the
// network lets call one method, add_proposal, on the demo treasury and nothing else
// (scripts/setup-demo-filer.mjs makes it, scripts/check-demo-filer.mjs attacks it). If that key
// leaked, the worst its holder could do is file requests on a treasury that holds test money.
//
// Anyone can press the button, and each press costs Kaap a sealed run, so it is bounded three
// ways: a few presses per caller, one filing in flight at a time (a second visitor is shown the
// one already under way), and a daily count read from the chain itself, which holds on any host.
//
// These reads go to one RPC provider at a time. They steer a demo and decide nothing: the
// judgement shown comes from the registry, which stores only verdicts the sealed reader signed.

import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions, baseEncode } from 'near-api-js';
import proof from '@/data/proof.json';

// dRPC first: its free tier held every burst tried on 12 Nov 2026, and Kaap's watcher does not
// lean on fastnear, so this page's reads never compete with the watcher's.
const RPCS = ['https://near-testnet.drpc.org', 'https://rpc.testnet.fastnear.com'];
const RPC_TIMEOUT_MS = 6_000;
const WATCHER_TIMEOUT_MS = 3_000;
const TGAS = 10n ** 12n;

/** A filing younger than this and still open is the one a new visitor is shown. */
const IN_FLIGHT_MS = 4 * 60_000;
/** Filings in any 24 hours. The watcher allows itself 60 sealed runs a day for one treasury. */
const DAILY_CAP = 40;
const DAY_MS = 24 * 3_600_000;
/** How far back the daily count looks: more requests than the cap, with room for other filings. */
const LOOK_BACK = 80;

const SEVERITIES = new Set(['low', 'medium', 'high', 'critical', 'unknown']);
const AI_STATUSES = new Set(['verified', 'unverified', 'unavailable']);
const FINDING = /^[A-Z_]{3,40}$/;
const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** The watcher's words for a vote that has not landed: it is waiting, was refused, or gave up. */
const VETO_WAITS = new Set(['sent', 'no_outcome', 'held', 'refused', 'not_open', 'capped']);

const tryIt = proof.tryIt as { account: string; publicKey: string; description: string; kind: { Transfer: { receiver_id: string } } } | null;
const watcherUrl = (proof as { watcher?: { url: string } | null }).watcher?.url ?? process.env.KAAP_WATCHER_URL ?? null;
const dao = proof.treasury.account;
const guard = proof.guard.account;
const registry = proof.registry.account;

export type Refusal = 'off' | 'daily_cap' | 'chain_unreachable' | 'not_filed';

export class DemoRefused extends Error {
  readonly reason: Refusal;
  constructor(reason: Refusal, message: string) {
    super(message);
    this.name = 'DemoRefused';
    this.reason = reason;
  }
}

/** Whether this host can file: the setup has run and the key is here. */
export const demoIsOn = () => tryIt !== null && Boolean(process.env.KAAP_DEMO_FILER_KEY);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** One contract view at the final block, from the first provider that answers. A contract's own
 *  refusal (no such proposal) is returned as null and not asked again. */
async function view(account: string, method: string, args: unknown): Promise<unknown> {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 'kaap',
    method: 'query',
    params: { request_type: 'call_function', finality: 'final', account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') },
  });
  for (const url of RPCS) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(RPC_TIMEOUT_MS), cache: 'no-store' });
      const answer: unknown = await res.json();
      if (!isRecord(answer)) continue;
      const result = answer.result;
      if (isRecord(result) && Array.isArray(result.result)) return JSON.parse(Buffer.from(result.result as number[]).toString('utf8'));
      if (JSON.stringify(answer).includes('ERR_NO_PROPOSAL')) return null;
    } catch {
      continue;
    }
  }
  throw new DemoRefused('chain_unreachable', 'NEAR testnet did not answer. Nothing was filed.');
}

interface Filing {
  id: number;
  status: string;
  submittedMs: number;
  votes: Record<string, string>;
}

/** The proposal as a demo filing, or null when it is anything else: another proposer, other
 *  words, or another payee. */
function asFiling(raw: unknown): Filing | null {
  if (!isRecord(raw) || tryIt === null) return null;
  const { id, proposer, description, kind, status, submission_time: submitted, votes } = raw;
  const receiver = isRecord(kind) && isRecord(kind.Transfer) ? kind.Transfer.receiver_id : undefined;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || typeof status !== 'string' || typeof submitted !== 'string' || !/^\d{1,20}$/.test(submitted)) return null;
  if (proposer !== tryIt.account || description !== tryIt.description || receiver !== tryIt.kind.Transfer.receiver_id) return null;
  const cast: Record<string, string> = {};
  if (isRecord(votes)) for (const [who, vote] of Object.entries(votes)) if (typeof vote === 'string') cast[who] = vote;
  return { id, status, submittedMs: Number(BigInt(submitted) / 1_000_000n), votes: cast };
}

async function recentFilings(): Promise<Filing[]> {
  const last = await view(dao, 'get_last_proposal_id', {});
  if (typeof last !== 'number' || !Number.isSafeInteger(last) || last < 0) throw new DemoRefused('chain_unreachable', 'The demo treasury gave an answer Kaap could not read.');
  const from = Math.max(0, last - LOOK_BACK);
  const page = await view(dao, 'get_proposals', { from_index: from, limit: LOOK_BACK });
  if (!Array.isArray(page)) throw new DemoRefused('chain_unreachable', 'The demo treasury gave an answer Kaap could not read.');
  return page.map(asFiling).filter((f): f is Filing => f !== null);
}

let filing: Promise<{ id: number; tx: string | null; already: boolean }> | null = null;

async function fileOne(): Promise<{ id: number; tx: string | null; already: boolean }> {
  const secret = process.env.KAAP_DEMO_FILER_KEY;
  if (tryIt === null || !secret) throw new DemoRefused('off', 'The live demo is not switched on here.');

  const now = Date.now();
  const recent = await recentFilings();
  const inFlight = recent.filter((f) => f.status === 'InProgress' && now - f.submittedMs < IN_FLIGHT_MS).at(-1);
  if (inFlight) return { id: inFlight.id, tx: null, already: true };
  if (recent.filter((f) => now - f.submittedMs < DAY_MS).length >= DAILY_CAP) {
    throw new DemoRefused('daily_cap', `The demo has run ${DAILY_CAP} times in the last day, which is its limit. The recorded one below works at any time.`);
  }

  let signer: KeyPairSigner;
  try {
    signer = new KeyPairSigner(KeyPair.fromString(secret as Parameters<typeof KeyPair.fromString>[0]));
  } catch {
    throw new DemoRefused('off', 'The live demo is not switched on here.');
  }
  const publicKey = await signer.getPublicKey();
  // A key other than the one the setup recorded is not used, whatever it could do.
  if (publicKey.toString() !== tryIt.publicKey) throw new DemoRefused('off', 'The live demo is not switched on here.');

  const provider = new JsonRpcProvider({ url: RPCS[0] as string });
  const account = new Account(tryIt.account, provider, signer);
  let tx: string;
  let outcome: unknown;
  try {
    const built = await account.createTransaction({
      receiverId: dao,
      actions: [actions.functionCall('add_proposal', { proposal: { description: tryIt.description, kind: tryIt.kind } }, 30n * TGAS, 0n)],
      publicKey,
    });
    const signed = await signer.signTransaction(built);
    tx = baseEncode(signed.txHash);
    outcome = await provider.sendTransactionUntil(signed.signedTransaction, 'EXECUTED_OPTIMISTIC');
  } catch (error) {
    console.error('demo filing failed', error instanceof Error ? error.name : 'unknown');
    throw new DemoRefused('not_filed', 'The request could not be filed on testnet. Nothing was decided.');
  }
  const value = isRecord(outcome) && isRecord(outcome.status) ? outcome.status.SuccessValue : undefined;
  const id = typeof value === 'string' ? Number(Buffer.from(value, 'base64').toString('utf8')) : Number.NaN;
  if (!Number.isSafeInteger(id) || id < 0) throw new DemoRefused('not_filed', 'The request was sent, but the treasury did not confirm it. Nothing was decided.');
  return { id, tx: TX_HASH.test(tx) ? tx : null, already: false };
}

/** Files the prepared fake theft, or names the one already in flight. One at a time in this
 *  process: a second press while the first is being sent gets the same answer. */
export function fileFakeTheft(): Promise<{ id: number; tx: string | null; already: boolean }> {
  filing ??= fileOne().finally(() => {
    filing = null;
  });
  return filing;
}

export interface DemoStatus {
  id: number;
  /** False when the treasury has no such request, or it is not one of the demo's filings. */
  found: boolean;
  status: string | null;
  submittedMs: number | null;
  rejectedByGuard: boolean;
  verdict: { risk: string; floor: string; findings: string[]; aiStatus: string | null } | null;
  recorded: boolean;
  txs: { run: string | null; veto: string | null; record: string | null };
  /** The watcher's own word for a vote that has not landed yet, such as `held`, or null. */
  vetoWait: string | null;
  /** Whether Kaap's watcher answered when asked for its transactions. */
  watcher: 'answered' | 'silent' | 'none';
}

interface Verdict {
  risk: string;
  floor: string;
  findings: string[];
  aiStatus: string | null;
}

/** A verdict summary from an upstream answer, each field checked against its shape. */
function asVerdict(raw: unknown, findingsAre: 'list' | 'either'): Verdict | null {
  if (!isRecord(raw)) return null;
  const { risk, floor, findings, ai_status: ai } = raw;
  if (typeof risk !== 'string' || !SEVERITIES.has(risk) || typeof floor !== 'string' || !SEVERITIES.has(floor)) return null;
  const list = Array.isArray(findings) ? findings : findingsAre === 'either' && typeof findings === 'string' ? findings.split(',') : [];
  return {
    risk,
    floor,
    findings: list.filter((code): code is string => typeof code === 'string' && FINDING.test(code)).slice(0, 24),
    aiStatus: typeof ai === 'string' && AI_STATUSES.has(ai) ? ai : null,
  };
}

async function fromWatcher(id: number): Promise<{ verdict: Verdict | null; txs: DemoStatus['txs']; vetoWait: string | null } | null> {
  if (watcherUrl === null) return null;
  try {
    const url = new URL('/proposal', watcherUrl);
    url.searchParams.set('dao', dao);
    url.searchParams.set('id', String(id));
    const res = await fetch(url, { signal: AbortSignal.timeout(WATCHER_TIMEOUT_MS), cache: 'no-store' });
    const body: unknown = await res.json();
    if (!res.ok || !isRecord(body) || body.dao !== dao || body.proposal_id !== id) return res.status === 404 ? { verdict: null, txs: { run: null, veto: null, record: null }, vetoWait: null } : null;
    const txs: DemoStatus['txs'] = { run: null, veto: null, record: null };
    if (Array.isArray(body.txs)) {
      for (const entry of body.txs) {
        if (!isRecord(entry) || typeof entry.tx !== 'string' || !TX_HASH.test(entry.tx)) continue;
        // The newest transaction of each kind wins: a run asked again replaces the first.
        if (entry.kind === 'run' || entry.kind === 'veto' || entry.kind === 'record') txs[entry.kind] = entry.tx;
      }
    }
    return { verdict: asVerdict(body.verdict, 'list'), txs, vetoWait: typeof body.veto === 'string' && VETO_WAITS.has(body.veto) ? body.veto : null };
  } catch {
    return null;
  }
}

/** Where one demo filing stands, read fresh: the treasury, the registry and Kaap's watcher. */
export async function demoStatus(id: number): Promise<DemoStatus> {
  const [raw, record, watcher] = await Promise.all([
    view(dao, 'get_proposal', { id }),
    view(registry, 'latest', { network: proof.network, dao, proposal_id: id }).catch(() => null),
    fromWatcher(id),
  ]);
  const found = asFiling(raw);
  const none = { run: null, veto: null, record: null };
  const watcherSays: DemoStatus['watcher'] = watcherUrl === null ? 'none' : watcher === null ? 'silent' : 'answered';
  // Only the demo's own filings are reported on. Any other request is read on the check screen.
  if (found === null) return { id, found: false, status: null, submittedMs: null, rejectedByGuard: false, verdict: null, recorded: false, txs: none, vetoWait: null, watcher: watcherSays };
  const txs = watcher?.txs ?? none;
  const recorded = asVerdict(record, 'list');
  return {
    id,
    found: true,
    status: found.status,
    submittedMs: found.submittedMs,
    rejectedByGuard: found.status === 'Rejected' && found.votes[guard] === 'Reject',
    // The registry's record is the signed one. The watcher's copy shows a few seconds sooner.
    verdict: recorded ?? watcher?.verdict ?? null,
    recorded: recorded !== null,
    txs,
    vetoWait: found.status === 'InProgress' ? (watcher?.vetoWait ?? null) : null,
    watcher: watcherSays,
  };
}
