// What a check knows about a DAO's past, read from its stored proposals: the payment history that
// NEW_RECIPIENT and LARGE_AMOUNT compare against (guide section 8, as eval/real/SAMPLING.md built
// it), and the policy in force before a proposal that is no longer open (guide section 7).
//
// The payment rule is the census rule: Transfer proposals, and function calls that send tokens,
// minus Trezu asset-exchange and public-to-confidential proposals. USD uses today's prices, so a
// median is an estimate. The policy rule is stricter than the guide's archival read: it names a
// policy only when the order of execution proves it, and says "unknown" otherwise.

import { z } from 'zod';

import { MAX_HISTORY_PAGES, MAX_PAGE_BODY_BYTES, PAGE_SIZE } from './caps.js';
import type { Core, History, Prices, ProposalRead } from './core.js';
import { type Provider, RpcError } from './rpc.js';

const storedSchema = z.looseObject({
  id: z.number().int().nonnegative(),
  status: z.string(),
  description: z.string(),
  kind: z.unknown(),
  submission_time: z.string().regex(/^\d{1,20}$/),
  votes: z.record(z.string(), z.unknown()).optional(),
  last_actions_log: z.array(z.looseObject({ block_height: z.union([z.string().regex(/^\d{1,20}$/), z.number().int().nonnegative()]) })).optional(),
});
export type Stored = z.output<typeof storedSchema>;

/** One range of `get_proposals`, split into smaller ranges when the node refuses it or it is too
 *  large. `gap` is true when some proposal in the range could not be read even alone: the caller
 *  then knows its history is incomplete. */
export async function page(provider: Provider, dao: string, from: number, limit: number, height: number): Promise<{ proposals: Stored[]; gap: boolean }> {
  try {
    const view = await provider.view(dao, 'get_proposals', { from_index: from, limit }, height, MAX_PAGE_BODY_BYTES);
    const parsed = z.array(storedSchema).safeParse(JSON.parse(view.text));
    if (!parsed.success) throw new RpcError(provider.name, 'shape', 'a proposals page does not read');
    return { proposals: parsed.data, gap: false };
  } catch (e) {
    const unreadable = e instanceof SyntaxError || (e instanceof RpcError && (e.failure === 'refused' || e.failure === 'too_large' || e.failure === 'shape'));
    if (!unreadable) throw e;
    if (limit === 1) return { proposals: [], gap: true };
    const part = Math.ceil(limit / 4);
    const out: { proposals: Stored[]; gap: boolean } = { proposals: [], gap: false };
    for (let f = from; f < from + limit; f += part) {
      const got = await page(provider, dao, f, Math.min(part, from + limit - f), height);
      out.proposals.push(...got.proposals);
      out.gap ||= got.gap;
    }
    return out;
  }
}

export interface Proposals {
  proposals: Stored[];
  /** False when a proposal could not be read or the DAO has more ids than `MAX_HISTORY_PAGES`
   *  pages. */
  complete: boolean;
}

/** Every stored proposal with an id below `lastId`, in id order. */
export async function readAll(provider: Provider, dao: string, lastId: number, height: number): Promise<Proposals> {
  if (Math.ceil(lastId / PAGE_SIZE) > MAX_HISTORY_PAGES) return { proposals: [], complete: false };
  const byId = new Map<number, Stored>();
  let complete = true;
  for (let from = 0; from < lastId; from += PAGE_SIZE) {
    const got = await page(provider, dao, from, PAGE_SIZE, height);
    if (got.gap) complete = false;
    for (const p of got.proposals) byId.set(p.id, p);
  }
  return { proposals: [...byId.values()].sort((a, b) => a.id - b.id), complete };
}

export function variant(kind: unknown): string {
  if (typeof kind === 'string') return kind;
  if (kind && typeof kind === 'object' && !Array.isArray(kind)) {
    const keys = Object.keys(kind);
    if (keys.length === 1 && keys[0] !== undefined) return keys[0];
  }
  return '';
}

const SEND_METHODS = new Set(['ft_transfer', 'ft_transfer_call', 'mt_transfer', 'mt_transfer_call', 'near_withdraw']);
const INTENTS_MOVES = /^(ft_withdraw|mt_withdraw|mt_transfer|mt_transfer_call|mt_batch_transfer|mt_batch_transfer_call|ft_force_withdraw|mt_force_transfer|native_withdraw|nft_withdraw)$/;

function args(b64: unknown): Record<string, unknown> {
  if (typeof b64 !== 'string' || b64 === '') return {};
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(b64, 'base64')));
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export type UsdOf = (token: string, raw: unknown) => number | null;

/** USD of `raw` base units of `token` (the guide's id; "" is native NEAR), or null when unpriced. */
export function usdOf(prices: Prices): UsdOf {
  return (token, raw) => {
    const key = token === '' ? 'near' : token;
    const entry = Object.hasOwn(prices.usd_by_token, key) ? prices.usd_by_token[key] : undefined;
    if (!entry || (typeof raw !== 'string' && typeof raw !== 'number')) return null;
    try {
      return (Number(BigInt(raw)) / 10 ** entry[0]) * entry[1];
    } catch {
      return null;
    }
  };
}

const record = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The census payment rule, as eval/real/SAMPLING.md describes it under `history`: the payment's
 *  USD (null when any part is unpriced) and its receivers, or null when the proposal is not a
 *  payment. */
export function paymentOf(p: Stored, usd: UsdOf): { usd: number | null; receivers: string[] } | null {
  const k = variant(p.kind);
  const body = record(record(p.kind)[k]);
  if (k === 'Transfer') {
    return { usd: usd(String(body['token_id'] ?? ''), body['amount']), receivers: [String(body['receiver_id'] ?? '')] };
  }
  if (k !== 'FunctionCall') return null;
  const contract = String(body['receiver_id'] ?? '');
  const isIntents = contract === 'intents.near';
  let anyMove = false;
  let sum = 0;
  let known = true;
  const receivers: string[] = [];
  for (const action of Array.isArray(body['actions']) ? body['actions'] : []) {
    const a = record(action);
    const m = String(a['method_name'] ?? '');
    if (!SEND_METHODS.has(m) && !isIntents) continue;
    const v = args(a['args']);
    let token: string | null = null;
    let raw: unknown = null;
    let receiver: unknown = v['receiver_id'] ?? v['to'] ?? null;
    const tokenId = typeof v['token_id'] === 'string' && v['token_id'].startsWith('nep141:') ? v['token_id'].slice(7) : null;
    if (m === 'ft_transfer' || m === 'ft_transfer_call') [token, raw] = [contract, v['amount']];
    else if (m === 'mt_transfer' || m === 'mt_transfer_call') [token, raw] = [tokenId, v['amount']];
    else if (m === 'near_withdraw') [token, raw, receiver] = ['', v['amount'], null];
    else if (isIntents) [token, raw] = [typeof v['token'] === 'string' ? v['token'] : tokenId, v['amount']];
    const moves = !(isIntents && !INTENTS_MOVES.test(m));
    if (moves) anyMove = true;
    if (moves && typeof receiver === 'string' && receiver !== '') receivers.push(receiver);
    const value = token !== null && raw ? usd(token, raw) : null;
    if (value === null) known = false;
    else sum += value;
  }
  const action = /\* Proposal Action:\s*([a-z-]+)/.exec(p.description)?.[1];
  if (!anyMove || action === 'asset-exchange' || action === 'public-to-confidential') return null;
  return { usd: known ? sum : null, receivers };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

/** The DAO's approved payments submitted strictly before `submissionTime`. */
export function historyBefore(all: Stored[], submissionTime: string, prices: Prices): History {
  const t = BigInt(submissionTime);
  const usd = usdOf(prices);
  const earlier = all.filter((p) => p.status === 'Approved' && BigInt(p.submission_time) < t).flatMap((p) => paymentOf(p, usd) ?? []);
  const med = median(earlier.flatMap((x) => (x.usd === null ? [] : [x.usd])));
  return {
    approved_payments_before: earlier.length,
    median_payment_usd_before: med === null ? null : Math.round(med * 100) / 100,
    recipients_paid_before: [...new Set(earlier.flatMap((x) => x.receivers))].sort(),
  };
}

/** Kinds that change the policy when approved. UpgradeSelf is counted too, since new code can
 *  rewrite stored state, so an upgrade between two moments blocks a rebuild. */
const CHANGES = new Set([
  'ChangePolicy',
  'AddMemberToRole',
  'RemoveMemberFromRole',
  'ChangePolicyAddOrUpdateRole',
  'ChangePolicyRemoveRole',
  'ChangePolicyUpdateDefaultVotePolicy',
  'ChangePolicyUpdateParameters',
  'UpgradeSelf',
]);

/** The block of a proposal's last logged action (Sputnik 3.2 keeps the last 20), or null. */
function lastActionBlock(p: Stored | undefined): bigint | null {
  const log = p?.last_actions_log;
  if (!log || log.length === 0) return null;
  return log.reduce((max, entry) => (BigInt(entry.block_height) > max ? BigInt(entry.block_height) : max), 0n);
}

export type PolicyBefore =
  | { known: true; text: string; source: string }
  | { known: false; source: string };

/** The policy in force before proposal `read` (guide section 7), as kaap-core's canonical text.
 *
 *  - InProgress: the policy now, which is what the proposal would run against.
 *  - Otherwise the policy now, when no other approved proposal ever changed the policy, or (for an
 *    Approved or Rejected proposal, whose last logged action is the vote that decided it) when
 *    every approved policy change executed in an earlier block. A proposal that itself changed the
 *    policy never gets the policy now, since that already holds its own change.
 *  - Otherwise, for an Approved or Rejected proposal, the full policy of the last approved
 *    ChangePolicy that executed before it, when nothing else changed the policy after that one.
 *  - Otherwise unknown. Shortcut edits are never replayed here: that would copy Sputnik's rules
 *    into TypeScript, and they live only in kaap-core. */
export function policyBefore(core: Core, read: ProposalRead, policyNow: string, history: Proposals): PolicyBefore {
  if (read.status === 'InProgress') return { known: true, text: policyNow, source: 'the DAO\'s policy now, since the proposal is still open' };
  const unknown = (why: string): PolicyBefore => ({ known: false, source: `unknown: ${why}` });
  if (!history.complete) return unknown('the DAO\'s earlier proposals could not all be read');
  const self = history.proposals.find((p) => p.id === read.id);
  const changes = history.proposals.filter((p) => p.id !== read.id && p.status === 'Approved' && CHANGES.has(variant(p.kind)));
  const selfChanged = read.status === 'Approved' && CHANGES.has(variant(self?.kind));
  const decided = read.status === 'Approved' || read.status === 'Rejected';
  const at = decided ? lastActionBlock(self) : null;

  if (!selfChanged && changes.length === 0) {
    return { known: true, text: policyNow, source: 'the DAO\'s policy now: no other approved proposal of this DAO ever changed its policy' };
  }
  const blocks = changes.map((p) => ({ p, block: lastActionBlock(p) }));
  if (at === null || blocks.some((b) => b.block === null || b.block === at)) {
    return unknown('this proposal is no longer open, and the order in which the DAO\'s policy changes ran cannot be read');
  }
  const before = blocks.filter((b) => (b.block as bigint) < at);
  if (!selfChanged && before.length === blocks.length) {
    return { known: true, text: policyNow, source: `the DAO's policy now: every approved policy change ran before this proposal was decided (block ${at})` };
  }
  const last = before.reduce<(typeof before)[number] | null>((best, b) => (best === null || (b.block as bigint) > (best.block as bigint) ? b : best), null);
  if (last && before.filter((b) => b.block === last.block).length > 1) {
    return unknown(`two policy changes ran in block ${last.block}, so which ran last cannot be read`);
  }
  const full = last && variant(last.p.kind) === 'ChangePolicy' ? record(record(last.p.kind)['ChangePolicy'])['policy'] : undefined;
  if (last && full && typeof full === 'object' && !Array.isArray(full) && Array.isArray(record(full)['roles'])) {
    try {
      return { known: true, text: core.canonicalPolicy(JSON.stringify(full)), source: `rebuilt: the full policy set by approved proposal #${last.p.id}, the last policy change that ran before this proposal was decided` };
    } catch {
      return unknown(`the policy set by proposal #${last.p.id} cannot be read by kaap-core`);
    }
  }
  return unknown('this proposal is no longer open, and the last policy change before it was not a full policy');
}
