// `kaap census [--sample N]`: reruns the DAO census headline numbers from the live mainnet chain
// (a port of the census scan first run on 20 Oct 2026), at most 5 requests a second. With --sample
// it scans N DAOs chosen by the sha256 of their names, so every run of the same N scans the same
// DAOs, and the counts are of that sample, not scaled up.
//
// Every read is made at one final block. A DAO the first provider will not answer for is read
// from the second at that same block, so a refusal part way through a long run costs one DAO's
// requests and not the run, and which provider answered changes no count.
//
// It reads the factory's DAO list, each scanned DAO's proposal counter and its proposals back to a
// year before the block read, and each active DAO's account. It never reads a policy, and it never
// computes, prints or stores anything about how many votes a DAO's roles need.

import { createHash } from 'node:crypto';

import type { Core } from './core.js';
import { codeOf, MAINNET_RELEASES, versionsOf } from './dao.js';
import { page, type Stored, variant } from './history.js';
import type { Clock, RateLimiter } from './limiter.js';
import { MAX_HISTORY_PAGES, MAX_PAGE_BODY_BYTES, PAGE_SIZE, REQUESTS_PER_SECOND } from './caps.js';
import type { Transport } from './net.js';
import { readPrices } from './prices.js';
import { type Block, NETWORKS, Provider, RpcError } from './rpc.js';
import { count, percent, utc } from './text.js';

const DAY_NS = 86_400_000_000_000n;
const POLICY_KINDS = new Set([
  'ChangePolicy',
  'AddMemberToRole',
  'RemoveMemberFromRole',
  'ChangePolicyAddOrUpdateRole',
  'ChangePolicyRemoveRole',
  'ChangePolicyUpdateDefaultVotePolicy',
  'ChangePolicyUpdateParameters',
]);
const PRE_3_2 = new Set(['2.0', '2.1', '3.0', '3.1']);
/** Scanned DAOs worked on at once; the limiter still spaces every request. */
const WORKERS = 5;

export interface Deps {
  core: Core;
  transport: Transport;
  limiter: RateLimiter;
  clock: Clock;
}

export interface CensusReport {
  block: { height: number; timestamp_ns: string };
  provider: string;
  /** The provider asked for a DAO the first would not answer for, and how many DAOs that was. */
  second_provider: string;
  from_second: number;
  factory: string;
  daos: number;
  sample: number | null;
  scanned: number;
  since_365: string;
  since_90: string;
  ever: number;
  active_365: number;
  active_90: number;
  proposals_365: number;
  calls: number;
  transfers: number;
  policy_changes: number;
  sign_requests: number;
  sign_approved: number;
  sign_approved_one_voter: number;
  approved: number;
  approved_one_vote: number;
  pre_3_2: number;
  unmapped: number;
  pre_3_2_near: string;
  near_usd: number | null;
  unreadable: number;
  requests: number;
  retried: number;
  seconds: number;
}

/** The first `n` names by the hex sha256 of each name. */
export function sampleOf(daos: string[], n: number | null): string[] {
  if (n === null || n >= daos.length) return daos;
  const keyed = daos.map((dao) => [createHash('sha256').update(dao).digest('hex'), dao] as const);
  return keyed.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(0, n).map(([, dao]) => dao);
}

interface Scan {
  ever: boolean;
  recent: Stored[];
  gap: boolean;
  version: string | null;
  near: bigint;
}

async function scan(p: Provider, dao: string, head: Block, since: bigint, known: Map<string, string>): Promise<Scan | null> {
  let last: number;
  try {
    const view = await p.view(dao, 'get_last_proposal_id', {}, head.height);
    const parsed: unknown = JSON.parse(view.text);
    if (!Number.isSafeInteger(parsed) || (parsed as number) < 0) return null;
    last = parsed as number;
  } catch (e) {
    if (e instanceof SyntaxError || (e instanceof RpcError && e.failure !== 'unavailable')) return null;
    throw e;
  }
  const out: Scan = { ever: last > 0, recent: [], gap: false, version: null, near: 0n };
  let pages = 0;
  for (let from = Math.floor((last - 1) / PAGE_SIZE) * PAGE_SIZE; last > 0 && from >= 0; from -= PAGE_SIZE) {
    if (++pages > MAX_HISTORY_PAGES) {
      out.gap = true;
      break;
    }
    const got = await page(p, dao, from, PAGE_SIZE, head.height);
    out.gap ||= got.gap;
    const inWindow = got.proposals.filter((x) => BigInt(x.submission_time) >= since);
    out.recent.push(...inWindow);
    if (inWindow.length < got.proposals.length) break;
  }
  if (out.recent.length > 0) {
    try {
      const account = await p.account(dao, head.height);
      const code = codeOf(account);
      out.version = code === null ? null : (known.get(code) ?? null);
      out.near = account.amount;
    } catch (e) {
      if (!(e instanceof RpcError) || e.failure === 'unavailable') throw e;
    }
  }
  return out;
}

const callsSign = (p: Stored) => {
  const call = (p.kind as { FunctionCall?: { receiver_id?: unknown; actions?: unknown } } | null)?.FunctionCall;
  return call?.receiver_id === 'v1.signer' && Array.isArray(call.actions) && call.actions.some((a: { method_name?: unknown }) => a?.method_name === 'sign');
};

export async function census(deps: Deps, sample: number | null): Promise<CensusReport> {
  const started = deps.clock.now();
  const { primary, secondary, factory } = NETWORKS.mainnet;
  const p = new Provider(primary, deps.transport, deps.limiter, deps.clock);
  const q = new Provider(secondary, deps.transport, deps.limiter, deps.clock);
  const head = await p.block('final');
  const list: unknown = JSON.parse((await p.view(factory, 'get_dao_list', {}, head.height, MAX_PAGE_BODY_BYTES)).text);
  if (!Array.isArray(list)) throw new RpcError(p.name, 'shape', 'the factory\'s DAO list is not a list');
  const daos = list.filter((d): d is string => typeof d === 'string' && deps.core.isAccountId(d));
  const known = new Map([...MAINNET_RELEASES, ...versionsOf((await p.view(factory, 'get_contracts_metadata', {}, head.height)).text)]);
  const since365 = BigInt(head.timestampNs) - 365n * DAY_NS;
  const since90 = BigInt(head.timestampNs) - 90n * DAY_NS;

  const chosen = sampleOf(daos, sample);
  const scans: (Scan | null)[] = new Array(chosen.length).fill(null);
  let next = 0;
  let fromSecond = 0;
  const scanEither = async (dao: string): Promise<Scan | null> => {
    try {
      return await scan(p, dao, head, since365, known);
    } catch (e) {
      if (!(e instanceof RpcError) || e.failure !== 'unavailable') throw e;
      fromSecond++;
      return scan(q, dao, head, since365, known);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(WORKERS, chosen.length) }, async () => {
      while (next < chosen.length) {
        const i = next++;
        scans[i] = await scanEither(chosen[i] as string);
      }
    }),
  );

  const read = scans.filter((s): s is Scan => s !== null);
  const recent = read.flatMap((s) => s.recent);
  const approved = recent.filter((x) => x.status === 'Approved');
  const signs = recent.filter(callsSign);
  const signApproved = signs.filter((x) => x.status === 'Approved');
  const oneVote = (x: Stored) => Object.keys(x.votes ?? {}).length === 1;
  const active = read.filter((s) => s.recent.length > 0);
  const old = active.filter((s) => s.version !== null && PRE_3_2.has(s.version));
  const prices = await readPrices('mainnet', deps.core, deps.transport, deps.limiter);
  const near = prices.prices.usd_by_token['near'];

  return {
    block: { height: head.height, timestamp_ns: head.timestampNs },
    provider: p.name,
    second_provider: q.name,
    from_second: fromSecond,
    factory,
    daos: daos.length,
    sample,
    scanned: chosen.length,
    since_365: since365.toString(),
    since_90: since90.toString(),
    ever: read.filter((s) => s.ever).length,
    active_365: active.length,
    active_90: active.filter((s) => s.recent.some((x) => BigInt(x.submission_time) >= since90)).length,
    proposals_365: recent.length,
    calls: recent.filter((x) => variant(x.kind) === 'FunctionCall').length,
    transfers: recent.filter((x) => variant(x.kind) === 'Transfer').length,
    policy_changes: recent.filter((x) => POLICY_KINDS.has(variant(x.kind))).length,
    sign_requests: signs.length,
    sign_approved: signApproved.length,
    sign_approved_one_voter: signApproved.filter(oneVote).length,
    approved: approved.length,
    approved_one_vote: approved.filter(oneVote).length,
    pre_3_2: old.length,
    unmapped: active.filter((s) => s.version === null).length,
    pre_3_2_near: (old.reduce((sum, s) => sum + s.near, 0n) / 10n ** 24n).toString(),
    near_usd: near ? near[1] : null,
    unreadable: scans.filter((s) => s === null || s.gap).length,
    requests: p.sent + q.sent + 1,
    retried: p.retried + q.retried,
    seconds: Math.round((deps.clock.now() - started) / 1000),
  };
}

const day = (ns: string) => utc(ns).slice(0, 10);

export function render(r: CensusReport): string {
  const scope =
    r.sample === null || r.sample >= r.daos
      ? `all ${count(r.daos)} DAOs made by ${r.factory}`
      : `a sample of ${count(r.scanned)} of the ${count(r.daos)} DAOs made by ${r.factory}: the first ${count(r.scanned)} by the sha256 of their names, the same sample on every run`;
  const second = r.from_second === 0 ? '' : `; ${count(r.from_second)} DAOs read from ${r.second_provider} at the same block, after ${r.provider} would not answer`;
  const usd = r.near_usd === null ? 'no NEAR price was available' : `about $${count(Math.round(Number(r.pre_3_2_near) * r.near_usd))} at 1Click's NEAR price of ${r.near_usd} USD`;
  return [
    'kaap census: Sputnik DAOs on NEAR mainnet, read live',
    `read at final block ${r.block.height} (${utc(r.block.timestamp_ns)}) from ${r.provider}, at most ${REQUESTS_PER_SECOND} requests a second`,
    `scope: ${scope}`,
    `windows: the last 365 days (since ${day(r.since_365)}) and the last 90 days (since ${day(r.since_90)}), counted back from that block`,
    '',
    `1. ${count(r.daos)} DAOs exist. Of the ${count(r.scanned)} scanned, ${count(r.ever)} ever got a proposal, ${count(r.active_365)} were active in the last year and ${count(r.active_90)} in the last 90 days.`,
    `2. ${count(r.proposals_365)} proposals in the last year: ${percent(r.calls, r.proposals_365)} contract calls, ${percent(r.transfers, r.proposals_365)} plain transfers, ${percent(r.policy_changes, r.proposals_365)} policy changes.`,
    `3. ${count(r.sign_requests)} of the contract calls (${percent(r.sign_requests, r.calls)}) ask the DAO to sign a hash through Chain Signatures (v1.signer sign), where the chain holds only the hash.`,
    `4. ${count(r.sign_approved)} of those hash-only proposals were approved, ${count(r.sign_approved_one_voter)} of them by a single voter.`,
    `5. ${percent(r.approved_one_vote, r.approved)} of approved proposals (${count(r.approved_one_vote)} of ${count(r.approved)}) carry exactly one vote.`,
    `6. ${count(r.pre_3_2)} of the ${count(r.active_365)} DAOs active in the last year (${percent(r.pre_3_2, r.active_365)}) run Sputnik code older than 3.2, from before the March 2025 act_proposal kind check; they hold ${count(BigInt(r.pre_3_2_near))} NEAR in their own accounts (${usd}; tokens are not counted). ${count(r.unmapped)} run a code hash the factory does not list.`,
    '',
    `requests: ${count(r.requests)} (${count(r.retried)} asked again), ${count(r.seconds)} seconds; DAOs whose proposals could not all be read: ${count(r.unreadable)}${second}`,
  ].join('\n');
}
