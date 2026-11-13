// Two-provider reads (C22). Anything that can lead to a vote is read at one final block, pinned
// from the primary's final head, from both providers, and used only when the two agree: kinds
// and policies compared in kaap-core's canonical form through the bridge, everything else byte
// for byte. Two honest providers at one block run the same code on the same state, so a
// difference is a fault or a lie, never a race.
//
// Not covered: both providers lying the same way (a named non-goal of the threat model).

import type { Bridge, GuardArming, ProposalRead } from './bridge.ts';
import { ACCOUNT_ID } from './config.ts';
import { STORAGE_PRICE_PER_BYTE } from './near.ts';
import type { At, ViewProvider, ViewResult } from './rpc.ts';

export type Item = 'block' | 'counter' | 'get_proposal' | 'get_proposals' | 'get_policy' | 'code_hash' | 'enrolled_daos' | 'veto_unreadable' | 'pending_key';

export type Problem = { kind: 'disagree'; item: Item; detail?: string } | { kind: 'failed'; item: Item; provider: string; detail: string };

export interface LiveProposal {
  kind: 'live';
  height: number;
  status: string;
  /** The kind exactly as get_proposal returned it: what the guard must forward (C5). */
  kindText: string;
  kindHash: string;
  /** add_proposal's block time, in nanoseconds, as Sputnik stores it. */
  submissionTime: string | null;
  policyHash: string;
  receivers: Array<[string, string]>;
  receiversHash: string;
}

export interface WatchState {
  kind: 'live';
  height: number;
  policyHash: string;
  /** The ids this read covered. One of them missing from `proposals` no longer exists: Sputnik
   *  deletes a proposal that is removed. */
  asked: number[];
  proposals: ProposalRead[];
  codeHashes: Map<string, string>;
}

/** The largest page the worker asks of `get_proposals`, so one answer stays a few hundred KB. */
export const PROPOSALS_PAGE = 100;
/** The most open proposals of one DAO the watch re-reads per pass (about seven days of a busy DAO). */
export const MAX_WATCHED = 300;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

/** The contract answered `get_last_proposal_id`, with something no proposal counter could be.
 *  That is the contract's doing, not a provider's failure to answer. */
export class ImplausibleCounter extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImplausibleCounter';
  }
}

export function parseCounter(r: ViewResult): number {
  if (!/^\d{1,16}$/.test(r.text)) throw new ImplausibleCounter('get_last_proposal_id did not return a whole number');
  const n = Number(r.text);
  if (!Number.isSafeInteger(n)) throw new ImplausibleCounter('get_last_proposal_id is above 2^53 - 1');
  return n;
}

export class Reads {
  readonly primary: ViewProvider;
  readonly secondary: ViewProvider;
  readonly #bridge: Bridge;
  readonly #catchUpMs: number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(primary: ViewProvider, secondary: ViewProvider, bridge: Bridge, catchUpMs: number, sleep: (ms: number) => Promise<void>) {
    this.primary = primary;
    this.secondary = secondary;
    this.#bridge = bridge;
    this.#catchUpMs = catchUpMs;
    this.#sleep = sleep;
  }

  /** Sputnik's counter: the id the next proposal will get, so every id below it exists. */
  async counter(p: ViewProvider, dao: string, finality: 'optimistic' | 'final'): Promise<number> {
    return parseCounter(await p.callFunction(dao, 'get_last_proposal_id', {}, { finality }));
  }

  /** Runs `read` on both providers at the primary's final block. The secondary gets one short
   *  wait if it does not have that block yet. */
  async #pinned<T>(item: Item, read: (p: ViewProvider, at: At) => Promise<T>): Promise<{ height: number; hash: string; a: T; b: T } | Problem> {
    let head;
    try {
      head = await this.primary.block({ finality: 'final' });
    } catch (e) {
      return { kind: 'failed', item: 'block', provider: this.primary.name, detail: errorText(e) };
    }
    const at = { blockId: head.height };
    let a: T;
    try {
      a = await read(this.primary, at);
    } catch (e) {
      return { kind: 'failed', item, provider: this.primary.name, detail: errorText(e) };
    }
    let b: T;
    try {
      b = await read(this.secondary, at);
    } catch {
      await this.#sleep(this.#catchUpMs);
      try {
        b = await read(this.secondary, at);
      } catch (e) {
        return { kind: 'failed', item, provider: this.secondary.name, detail: errorText(e) };
      }
    }
    return { height: head.height, hash: head.hash, a, b };
  }

  /** Both providers' final counters for `dao`, null for one that did not answer. `implausible`
   *  when both answered and neither answer is a whole number below 2^53: the contract's own
   *  answer, on which the two agree, is no counter. One such answer alone is that provider's
   *  word against the other's, and reads as a provider that did not answer. */
  async finalCounters(dao: string): Promise<{ a: number | null; b: number | null; implausible: boolean }> {
    const [a, b] = await Promise.allSettled([this.counter(this.primary, dao, 'final'), this.counter(this.secondary, dao, 'final')]);
    const odd = (r: PromiseSettledResult<number>) => r.status === 'rejected' && r.reason instanceof ImplausibleCounter;
    return { a: a.status === 'fulfilled' ? a.value : null, b: b.status === 'fulfilled' ? b.value : null, implausible: odd(a) && odd(b) };
  }

  /** The code hash of `account` at one final block, as both providers give it. */
  async codeHash(account: string): Promise<{ codeHash: string } | Problem> {
    let head;
    try {
      head = await this.primary.block({ finality: 'final' });
    } catch (e) {
      return { kind: 'failed', item: 'block', provider: this.primary.name, detail: errorText(e) };
    }
    return this.#codeHashAt(account, head.height, head.hash);
  }

  /** One view of the guard at final on both providers, used only when the two answers are the
   *  same (C22). `absent` when both say the guard has no such method: a guard built before the
   *  method existed, which is an answer, not a failed read. */
  async #guardView(guard: string, method: 'veto_unreadable' | 'pending_key', args: object): Promise<{ value: unknown } | 'absent' | Problem> {
    const read = async (p: ViewProvider) => JSON.parse((await p.callFunction(guard, method, args, { finality: 'final' })).text) as unknown;
    const [a, b] = await Promise.allSettled([read(this.primary), read(this.secondary)]);
    const missing = (r: PromiseSettledResult<unknown>) => r.status === 'rejected' && /MethodNotFound/.test(String((r.reason as Error | undefined)?.message ?? r.reason));
    if (missing(a) && missing(b)) return 'absent';
    if (a.status !== 'fulfilled') return { kind: 'failed', item: method, provider: this.primary.name, detail: errorText(a.reason) };
    if (b.status !== 'fulfilled') return { kind: 'failed', item: method, provider: this.secondary.name, detail: errorText(b.reason) };
    if (JSON.stringify(a.value) !== JSON.stringify(b.value)) return { kind: 'disagree', item: method };
    return { value: a.value };
  }

  /** Whether `dao` has the guard reject every request Kaap cannot read (its `veto_unreadable`
   *  setting). Anything but a plain true or false from both providers is a problem, never a yes. */
  async strictMode(guard: string, dao: string): Promise<boolean | 'absent' | Problem> {
    const r = await this.#guardView(guard, 'veto_unreadable', { dao });
    if (r === 'absent' || 'kind' in r) return r;
    return typeof r.value === 'boolean' ? r.value : { kind: 'failed', item: 'veto_unreadable', provider: this.primary.name, detail: 'the answer is not true or false' };
  }

  /** The key change the guard's owner has announced and not yet applied or cancelled, or null. */
  async pendingKey(guard: string): Promise<{ key: string; effectiveAtMs: number } | null | 'absent' | Problem> {
    const r = await this.#guardView(guard, 'pending_key', {});
    if (r === 'absent' || 'kind' in r) return r;
    if (r.value === null) return null;
    const v = r.value as { key?: unknown; effective_at_ms?: unknown };
    if (typeof v !== 'object' || typeof v.key !== 'string' || !/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v.key) || typeof v.effective_at_ms !== 'number' || !Number.isSafeInteger(v.effective_at_ms) || v.effective_at_ms < 0) {
      return { kind: 'failed', item: 'pending_key', provider: this.primary.name, detail: 'the answer is not a key and a time' };
    }
    return { key: v.key, effectiveAtMs: v.effective_at_ms };
  }

  /** What `dao`'s policy gives `guard`, read at one final block on both providers, whose two
   *  policies must be the same in canonical form (C16, C22). */
  async arming(dao: string, guard: string): Promise<({ kind: 'arming' } & GuardArming) | Problem> {
    const pinned = await this.#pinned('get_policy', (p, at) => p.callFunction(dao, 'get_policy', {}, at));
    if ('kind' in pinned) return pinned;
    const { a, b, height, hash } = pinned;
    for (const r of [a, b]) if (r.blockHeight !== height || r.blockHash !== hash) return { kind: 'disagree', item: 'block' };
    try {
      if (this.#bridge.policyHash(a.bytes) !== this.#bridge.policyHash(b.bytes)) return { kind: 'disagree', item: 'get_policy' };
      return { kind: 'arming', ...this.#bridge.guardArming(a.text, guard) };
    } catch (e) {
      return { kind: 'failed', item: 'get_policy', provider: this.primary.name, detail: errorText(e) };
    }
  }

  /** The state a veto must match, read just before it is sent: the proposal, the policy and the
   *  code of every contract the kind calls (C4, C22). */
  async liveProposal(dao: string, id: number): Promise<LiveProposal | Problem> {
    const pinned = await this.#pinned('get_proposal', async (p, at) => {
      const [proposal, policy] = await Promise.all([p.callFunction(dao, 'get_proposal', { id }, at), p.callFunction(dao, 'get_policy', {}, at)]);
      return { proposal, policy };
    });
    if ('kind' in pinned) return pinned;
    const { a, b, height, hash } = pinned;
    for (const r of [a.proposal, a.policy, b.proposal, b.policy]) if (r.blockHeight !== height || r.blockHash !== hash) return { kind: 'disagree', item: 'block' };
    if (!this.#bridge.sameProposal(a.proposal.text, b.proposal.text)) return { kind: 'disagree', item: 'get_proposal' };
    let policyHash: string;
    let proposal: ProposalRead;
    let accounts: string[];
    try {
      policyHash = this.#bridge.policyHash(a.policy.bytes);
      if (this.#bridge.policyHash(b.policy.bytes) !== policyHash) return { kind: 'disagree', item: 'get_policy' };
      proposal = this.#bridge.readProposal(a.proposal.bytes);
      accounts = this.#bridge.calledAccounts(dao, proposal.kind);
    } catch (e) {
      return { kind: 'failed', item: 'get_proposal', provider: this.primary.name, detail: errorText(e) };
    }
    if (proposal.id !== id) return { kind: 'failed', item: 'get_proposal', provider: this.primary.name, detail: 'the DAO returned another proposal id' };
    const receivers: Array<[string, string]> = [];
    for (const account of accounts) {
      const codes = await this.#codeHashAt(account, height, hash);
      if ('kind' in codes) return codes;
      receivers.push([account, codes.codeHash]);
    }
    return {
      kind: 'live',
      height,
      status: proposal.status,
      kindText: proposal.kind,
      kindHash: this.#bridge.kindHash(proposal.kind),
      submissionTime: proposal.submission_time,
      policyHash,
      receivers,
      receiversHash: this.#bridge.receiversHash(receivers),
    };
  }

  async #codeHashAt(account: string, height: number, hash: string): Promise<{ codeHash: string } | Problem> {
    const read = async (p: ViewProvider) => {
      const v = await p.viewAccount(account, { blockId: height });
      if (v.blockHeight !== height || v.blockHash !== hash) throw new Error('view_account is not at the block asked for');
      return v.codeHash;
    };
    const [a, b] = await Promise.allSettled([read(this.primary), read(this.secondary)]);
    if (a.status === 'rejected') return { kind: 'failed', item: 'code_hash', provider: this.primary.name, detail: errorText(a.reason) };
    if (b.status === 'rejected') return { kind: 'failed', item: 'code_hash', provider: this.secondary.name, detail: errorText(b.reason) };
    if (a.value !== b.value) return { kind: 'disagree', item: 'code_hash', detail: account };
    return { codeHash: a.value };
  }

  /** What the re-judge watch compares (C4): the policy, the proposals with ids in `ids`, and the
   *  code of every contract those proposals call, all at one block on both providers. */
  async watchState(dao: string, ids: number[]): Promise<WatchState | Problem> {
    // The newest are kept when there are too many: a new proposal is the one still open to stop.
    const wanted = [...new Set(ids)].sort((x, y) => x - y).slice(-MAX_WATCHED);
    const pages: Array<{ from: number; limit: number }> = [];
    for (const id of wanted) {
      const last = pages.at(-1);
      if (last && id < last.from + PROPOSALS_PAGE) last.limit = id - last.from + 1;
      else pages.push({ from: id, limit: 1 });
    }
    const pinned = await this.#pinned('get_proposals', async (p, at) => {
      const policy = await p.callFunction(dao, 'get_policy', {}, at);
      const answers = [];
      for (const page of pages) answers.push(await p.callFunction(dao, 'get_proposals', { from_index: page.from, limit: page.limit }, at));
      return { policy, answers };
    });
    if ('kind' in pinned) return pinned;
    const { a, b, height, hash } = pinned;
    for (const r of [a.policy, b.policy, ...a.answers, ...b.answers]) if (r.blockHeight !== height || r.blockHash !== hash) return { kind: 'disagree', item: 'block' };
    let policyHash: string;
    let proposals: ProposalRead[];
    try {
      policyHash = this.#bridge.policyHash(a.policy.bytes);
      if (this.#bridge.policyHash(b.policy.bytes) !== policyHash) return { kind: 'disagree', item: 'get_policy' };
      proposals = a.answers.flatMap((r) => this.#bridge.readProposals(r.bytes));
      const other = b.answers.flatMap((r) => this.#bridge.readProposals(r.bytes));
      const same = proposals.length === other.length && proposals.every((p, i) => p.id === other[i]?.id && p.status === other[i]?.status && this.#bridge.kindHash(p.kind) === this.#bridge.kindHash(other[i]?.kind ?? ''));
      if (!same) return { kind: 'disagree', item: 'get_proposals' };
    } catch (e) {
      return { kind: 'failed', item: 'get_proposals', provider: this.primary.name, detail: errorText(e) };
    }
    const want = new Set(wanted);
    proposals = proposals.filter((p) => want.has(p.id));
    const accounts = new Set<string>([dao]);
    for (const p of proposals) {
      if (p.status !== 'InProgress') continue;
      try {
        for (const account of this.#bridge.calledAccounts(dao, p.kind)) accounts.add(account);
      } catch {
        // A kind naming an invalid account holds the sealed job too; there is no code to watch.
      }
    }
    const codeHashes = new Map<string, string>();
    for (const account of accounts) {
      const codes = await this.#codeHashAt(account, height, hash);
      if ('kind' in codes) return codes;
      codeHashes.set(account, codes.codeHash);
    }
    return { kind: 'live', height, policyHash, asked: wanted, proposals, codeHashes };
  }

  /** Who filed proposal `id`, used only to group alerts. It never leads to a vote, so one
   *  provider's answer is enough; anything that is not an account id gives null. */
  async proposer(dao: string, id: number): Promise<string | null> {
    for (const p of [this.primary, this.secondary]) {
      try {
        const r = await p.callFunction(dao, 'get_proposal', { id }, { finality: 'final' });
        const v = (JSON.parse(r.text) as { proposer?: unknown } | null)?.proposer;
        return typeof v === 'string' && ACCOUNT_ID.test(v) ? v : null;
      } catch {
        // The other provider is asked next.
      }
    }
    return null;
  }

  /** What `account` can spend beyond the storage it must keep, the lower of the two providers'
   *  answers; null when neither answered. */
  async spendable(account: string): Promise<bigint | null> {
    const answers = await Promise.allSettled([this.primary, this.secondary].map((p) => p.viewAccount(account, { finality: 'final' })));
    let low: bigint | null = null;
    for (const a of answers) {
      if (a.status !== 'fulfilled') continue;
      const free = a.value.amount - BigInt(a.value.storageUsage) * STORAGE_PRICE_PER_BYTE;
      low = low === null || free < low ? free : low;
    }
    return low;
  }

  /** The accounts enrolled in the guard, as each provider lists them. `both` holds the ones both
   *  list, in the first provider's order: only those may be taken up, since enrolling is what
   *  makes the worker spend (C22). `either` holds the ones at least one lists: a DAO already
   *  watched stays watched while it is in there, so one provider leaving it out can never end
   *  its protection. With a problem on either side `both` is empty and nothing new is taken up. */
  async enrolled(guard: string, pageSize = 100, maxPages = 50): Promise<{ both: string[]; either: string[]; problems: Problem[] }> {
    const lists: string[][] = [];
    const problems: Problem[] = [];
    for (const p of [this.primary, this.secondary]) {
      const daos: string[] = [];
      try {
        for (let page = 0; page < maxPages; page++) {
          const r = await p.callFunction(guard, 'enrolled_daos', { from_index: page * pageSize, limit: pageSize }, { finality: 'final' });
          const list: unknown = JSON.parse(r.text);
          if (!Array.isArray(list) || !list.every((d) => typeof d === 'string')) throw new Error('enrolled_daos is not a list of account ids');
          daos.push(...(list as string[]));
          if (list.length < pageSize) break;
        }
        lists.push(daos);
      } catch (e) {
        problems.push({ kind: 'failed', item: 'enrolled_daos', provider: p.name, detail: errorText(e) });
      }
    }
    const either = [...new Set(lists.flat())];
    const [first, second] = lists;
    const both = first && second ? [...new Set(first)].filter((d) => second.includes(d)) : [];
    return { both, either, problems };
  }
}
