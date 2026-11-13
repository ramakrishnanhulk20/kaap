// What the worker does with a verdict: the veto decision, the last check against live state, the
// guard's veto, and the registry record. The guard re-checks everything on chain; the worker's
// checks only save the gas of a veto the guard would refuse, and stop the worker sending a
// verdict whose pinned state no longer holds (C4).

import type { DecodedVerdict } from './bridge.ts';
import type { CapGuard } from './caps.ts';
import type { Health, Signal } from './health.ts';
import type { Logger } from './log.ts';
import { TGAS, formatNear, worstCase } from './near.ts';
import { events, receiptBlock, refusal } from './outcome.ts';
import type { LiveProposal, Problem, Reads } from './reads.ts';
import type { ViewProvider } from './rpc.ts';
import type { JudgedRow, Store, VetoState } from './store.ts';
import type { SubmitResult, Submitter } from './submit.ts';

/** The guard refuses a veto that attaches under 900 Tgas (ERR_NOT_ENOUGH_GAS), since a large kind
 *  needs that much to reach the DAO, and one transaction carries at most 1,000. Every veto attaches
 *  the whole 1,000: what is not burnt comes back, and the caps reserve it all, 0.1 NEAR a veto. */
export const VETO_GAS = 1_000n * TGAS;
export const RECORD_GAS = 30n * TGAS;
/** kaap-registry's README: 0.02 NEAR always covers a record; the registry refunds the rest. */
export const RECORD_DEPOSIT = 20n * 10n ** 21n;
/** A veto is not sent on a verdict this close to its expiry: it could expire on the way. */
export const EXPIRY_MARGIN_MS = 30_000;
/** Record and veto outcomes are final within a few blocks; this is generous. */
const SHORT_WINDOW_BLOCKS = 60;
/** kaap-registry's MAX_HISTORY_PAGE: one `history` page never holds more. */
const HISTORY_PAGE = 50;
/** 500 records of one proposal is far past what its judgements produce, and every record is a
 *  verdict the sealed program signed, so a longer history is read no further. */
const HISTORY_PAGES = 10;

/** A proposal's own signals that stop mattering once it can no longer pass. A record with no
 *  outcome is not one of them: it is sent again until final, whatever the proposal did. */
const MOOT_WHEN_CLOSED: readonly Signal[] = ['run_no_answer', 'run_without_verdict', 'verdict_rejected', 'veto_held', 'veto_no_outcome', 'veto_refused', 'record_refused'];
const VETO_SIGNALS: readonly Signal[] = ['veto_held', 'veto_no_outcome', 'veto_refused'];
/** Veto states in which a proposal that passed means Kaap's veto was lost: held, capped,
 *  refused, or sent with no outcome. */
const LOST_FROM: ReadonlySet<VetoState> = new Set<VetoState>(['held', 'capped', 'refused', 'no_outcome', 'sent']);

/** As `LOST_FROM`, for the actor itself, which only checks a verdict that calls for a veto: a
 *  proposal that passed before that veto was ever sent is lost too. */
const LOST_BEFORE_SENT: ReadonlySet<VetoState> = new Set<VetoState>([...LOST_FROM, 'none']);

/** Settles proposal `row`, seen leaving InProgress for `status` (`row` as it was before the close
 *  changed it). Whatever it moved to, every signal raised for it clears, since nothing it held up
 *  can matter once it cannot pass. The exception is a proposal that passed while its veto was in
 *  `lostFrom`: that veto was lost. Members hear so at once, the veto is marked not open so it is
 *  never sent, and its veto signals are retired, never reported as recovered. */
export function settleClosed(store: Store, health: Health, network: string, row: JudgedRow, status: string, lostFrom: ReadonlySet<VetoState> = LOST_FROM): void {
  const { dao, proposal_id: id } = row;
  const proposal = { dao, proposal: id };
  if (status === 'Approved' && lostFrom.has(row.veto_state)) {
    store.setVetoState(network, dao, id, 'not_open');
    health.notice('veto_lost', dao, { proposal_id: id, was: row.veto_state, tx: store.spend(`veto:${network}:${dao}:${id}:${row.verdict_hash}`)?.tx_hash ?? null, verdict_hash: row.verdict_hash });
    for (const signal of VETO_SIGNALS) health.retire(signal, proposal, 'veto_lost');
  }
  for (const signal of MOOT_WHEN_CLOSED) health.clear(signal, proposal);
}

export type Decision =
  | { act: 'veto' }
  | { act: 'none'; why: 'not_vetoable' }
  | { act: 'none'; why: 'not_open'; status: string }
  | { act: 'rejudge'; why: 'stale_policy' | 'stale_receivers' | 'kind_changed' | 'expired' };

/** Whether the guard's rule lets `verdict` veto at a treasury whose strict setting is `strict`:
 *  the rule is the guard's own, mirrored inside the bridge for both settings. */
export function vetoes(verdict: Pick<DecodedVerdict, 'vetoable' | 'vetoable_strict'>, strict: boolean): boolean {
  return strict ? verdict.vetoable_strict : verdict.vetoable;
}

/** The veto decision for `verdict` against the state read at final just before sending, at a
 *  treasury whose strict setting is `strict`. */
export function decide(verdict: DecodedVerdict, live: LiveProposal, now: number, strict = false): Decision {
  if (!vetoes(verdict, strict)) return { act: 'none', why: 'not_vetoable' };
  if (live.status !== 'InProgress') return { act: 'none', why: 'not_open', status: live.status };
  if (live.kindHash !== verdict.kind_hash) return { act: 'rejudge', why: 'kind_changed' };
  if (live.policyHash !== verdict.policy_hash) return { act: 'rejudge', why: 'stale_policy' };
  if (live.receiversHash !== verdict.receivers_hash) return { act: 'rejudge', why: 'stale_receivers' };
  if (now + EXPIRY_MARGIN_MS >= verdict.expires_at_ms) return { act: 'rejudge', why: 'expired' };
  return { act: 'veto' };
}

export interface Signed {
  verdict: DecodedVerdict;
  verdictB64: string;
  signatureB64: string;
}

export type VetoOutcome =
  | { kind: 'cast'; tx: string; seconds: number | null }
  | { kind: 'refused_by_dao'; tx: string }
  | { kind: 'refused_by_guard'; tx: string; code: string }
  | { kind: 'not_needed'; why: string }
  | { kind: 'rejudge'; why: string }
  | { kind: 'held'; why: string };

export interface ActSettings {
  network: string;
  guard: string;
  registry: string;
  gateTries: number;
  gateRetryMs: number;
}

export class Actor {
  readonly #store: Store;
  readonly #submitter: Submitter;
  readonly #caps: CapGuard;
  readonly #reads: Reads;
  readonly #health: Health;
  readonly #log: Logger;
  readonly #s: ActSettings;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(deps: { store: Store; submitter: Submitter; caps: CapGuard; reads: Reads; health: Health; log: Logger; now: () => number; sleep: (ms: number) => Promise<void> }, settings: ActSettings) {
    this.#store = deps.store;
    this.#submitter = deps.submitter;
    this.#caps = deps.caps;
    this.#reads = deps.reads;
    this.#health = deps.health;
    this.#log = deps.log;
    this.#now = deps.now;
    this.#sleep = deps.sleep;
    this.#s = settings;
  }

  /** Reads the live state on both providers, retrying a disagreement or a failed read a few
   *  times, since a provider a block behind catches up within seconds. */
  async #gate(dao: string, id: number): Promise<LiveProposal | Problem> {
    let last: LiveProposal | Problem = { kind: 'failed', item: 'block', provider: 'none', detail: 'not read' };
    for (let i = 0; i < this.#s.gateTries; i++) {
      last = await this.#reads.liveProposal(dao, id);
      if (last.kind === 'live') return last;
      await this.#sleep(this.#s.gateRetryMs);
    }
    return last;
  }

  /** Decides on and, when the rule says so, sends the veto for one verdict. `strict` is the
   *  treasury's setting in the guard as the worker last read it on both providers; the guard
   *  reads its own copy when the veto arrives, so a stale `true` costs one refused call. */
  async veto(dao: string, id: number, signed: Signed, strict = false): Promise<VetoOutcome> {
    const { verdict } = signed;
    const before = this.#store.judged(this.#s.network, dao, id);
    const key = `veto:${this.#s.network}:${dao}:${id}:${verdict.verdict_hash}`;
    const proposal = { dao, proposal: id };
    if (!vetoes(verdict, strict)) {
      this.#store.setVetoState(this.#s.network, dao, id, 'not_needed');
      this.#log.info('no_veto', { dao, proposal_id: id, why: 'the guard rule does not allow a veto', risk: verdict.risk, floor: verdict.floor, ai_status: verdict.ai_status, strict });
      // The current verdict asks for no veto, so what an earlier verdict's veto raised is moot.
      for (const signal of VETO_SIGNALS) this.#health.clear(signal, proposal);
      return { kind: 'not_needed', why: 'not_vetoable' };
    }
    const live = await this.#gate(dao, id);
    if (live.kind !== 'live') {
      // Sputnik deletes a removed proposal, so its live read fails on both providers. That is a
      // closed proposal, not a held veto, once both agree the id is gone.
      if (await this.#deleted(dao, id)) {
        this.#store.setProposalStatus(this.#s.network, dao, id, 'Removed');
        this.#store.setVetoState(this.#s.network, dao, id, 'not_open');
        this.#log.info('no_veto', { dao, proposal_id: id, why: 'not_open', status: 'Removed' });
        if (before) this.#closed(before, 'Removed');
        return { kind: 'not_needed', why: 'not_open' };
      }
      this.#store.setVetoState(this.#s.network, dao, id, 'held');
      this.#log.error('refused', { what: 'veto', dao, proposal_id: id, reason: 'live state not agreed', problem: live });
      this.#health.raise('veto_held', proposal, { problem: live.kind, item: live.item });
      return { kind: 'held', why: `${live.kind}: ${live.item}` };
    }
    this.#store.setProposalStatus(this.#s.network, dao, id, live.status);
    const d = decide(verdict, live, this.#now(), strict);
    if (d.act === 'none') {
      this.#store.setVetoState(this.#s.network, dao, id, d.why === 'not_open' ? 'not_open' : 'not_needed');
      this.#log.info('no_veto', { dao, proposal_id: id, why: d.why, status: live.status });
      // A veto that a proposal passing beat is the worst outcome Kaap has, so it gets its own
      // urgent alert, never a quiet "not needed".
      if (d.why === 'not_open' && before) this.#closed(before, live.status);
      return { kind: 'not_needed', why: d.why };
    }
    if (d.act === 'rejudge') {
      this.#log.warn('refused', { what: 'veto', dao, proposal_id: id, reason: d.why, verdict_block: verdict.block_height, live_block: live.height });
      return { kind: 'rejudge', why: d.why };
    }

    const reserved = worstCase(VETO_GAS, 0n);
    const capped = this.#alreadySigned(key) ? null : this.#caps.near(reserved, key);
    if (capped) {
      this.#store.setVetoState(this.#s.network, dao, id, 'capped');
      this.#log.error('refused', { what: 'veto', dao, proposal_id: id, reason: 'cap', cap: capped.cap });
      this.#health.raise('cap_reached', dao, { cap: capped.cap });
      return { kind: 'held', why: 'near_per_day cap' };
    }
    let res: SubmitResult;
    try {
      this.#store.setVetoState(this.#s.network, dao, id, 'sent');
      res = await this.#submitter.submit({
        key,
        kind: 'veto',
        dao,
        proposalId: id,
        receiver: this.#s.guard,
        method: 'veto',
        // The kind exactly as get_proposal returned it; the guard hashes it canonically (C5).
        args: { verdict: signed.verdictB64, signature: signed.signatureB64, kind_json: live.kindText },
        gas: VETO_GAS,
        deposit: 0n,
        reserved,
        windowBlocks: SHORT_WINDOW_BLOCKS,
        kept: () => 0n,
      });
    } catch (e) {
      // An error while signing or sending holds the veto, which the worker looks at again on its
      // next pass; any bytes already signed are sent again under the same key.
      this.#store.setVetoState(this.#s.network, dao, id, 'held');
      this.#log.error('refused', { what: 'veto', dao, proposal_id: id, reason: 'error while signing or sending', error: e });
      this.#health.raise('veto_held', proposal, { problem: 'error' });
      return { kind: 'held', why: 'error' };
    } finally {
      this.#caps.settle(key);
    }
    if (res.kind === 'no_outcome') {
      // The vote may still land, or may never have reached the chain: the worker re-sends the same
      // bytes on its next pass until the outcome is final or the veto is no longer needed.
      this.#store.setVetoState(this.#s.network, dao, id, 'no_outcome');
      this.#health.raise('veto_no_outcome', proposal, { tx: res.hash });
      return { kind: 'held', why: 'no_outcome' };
    }
    if (res.kind === 'not_sent') {
      this.#store.setVetoState(this.#s.network, dao, id, 'held');
      this.#health.raise('veto_held', proposal, { problem: res.kind });
      return { kind: 'held', why: res.kind };
    }
    // Every path below ends cast or refused, so this veto is no longer held or missing an outcome.
    this.#health.clear('veto_no_outcome', proposal);
    this.#health.clear('veto_held', proposal);
    const code = refusal(res.outcome);
    // ERR_REPLAY means this verdict was already spent, for instance by a send whose answer was
    // lost; the guard's own record then says whether that vote landed.
    if (code === 'ERR_REPLAY' && (await this.#vetoResult(verdict.verdict_hash)) === 'Ok') {
      this.#store.setVetoState(this.#s.network, dao, id, 'cast');
      this.#health.clear('veto_refused', proposal);
      this.#log.info('veto_cast', { dao, proposal_id: id, tx: res.hash, note: 'an earlier send of this verdict had already cast the vote' });
      return { kind: 'cast', tx: res.hash, seconds: null };
    }
    if (code) {
      this.#store.setVetoState(this.#s.network, dao, id, 'refused');
      this.#log.error('veto_refused_by_guard', { dao, proposal_id: id, code, tx: res.hash });
      if (code === 'ERR_EXPIRED') return { kind: 'rejudge', why: 'expired' };
      this.#health.raise('veto_refused', proposal, { code });
      return { kind: 'refused_by_guard', tx: res.hash, code };
    }

    const result = await this.#vetoResult(verdict.verdict_hash);
    const evented = events(res.outcome).find((e) => e.by === this.#s.guard && (e.event === 'veto_cast' || e.event === 'veto_refused'))?.event;
    if (result !== 'Ok') {
      this.#store.setVetoState(this.#s.network, dao, id, 'refused');
      this.#log.error('veto_refused', { dao, proposal_id: id, veto_result: result, guard_event: evented ?? null, tx: res.hash });
      this.#health.raise('veto_refused', proposal, { veto_result: result });
      return { kind: 'refused_by_dao', tx: res.hash };
    }
    this.#store.setVetoState(this.#s.network, dao, id, 'cast');
    this.#health.clear('veto_refused', proposal);
    const seconds = await this.#secondsSinceFiled(res.outcome, dao, live.submissionTime);
    this.#log.info('veto_cast', { dao, proposal_id: id, tx: res.hash, guard_event: evented ?? null, veto_result: result, seconds_from_add_proposal: seconds });
    return { kind: 'cast', tx: res.hash, seconds };
  }

  /** This proposal's record step succeeded, so what its earlier sends raised is over. */
  #recorded(proposal: { dao: string; proposal: number }): void {
    this.#health.clear('record_no_outcome', proposal);
    this.#health.clear('record_refused', proposal);
  }

  /** Whether one more veto, or registry write of `dao`, would pass the caps now; holds nothing. */
  hasRoom(kind: 'veto' | 'record', dao: string): boolean {
    return this.#caps.fits(kind, dao);
  }

  /** A resend of bytes already signed costs nothing new: the caps counted it when it was signed,
   *  and counting it twice would park a lost send as capped. */
  #alreadySigned(key: string): boolean {
    const row = this.#store.spend(key);
    return row !== undefined && row.state !== 'rejected';
  }

  /** For a proposal this actor just saw closed, `row` as it was before this veto. Its status
   *  already left InProgress in the store, so the re-judge watch will not see it close; it is
   *  settled here. The actor only gets this far with a verdict that calls for a veto, so a
   *  proposal that passed before its first veto went out is a lost veto too. */
  #closed(row: JudgedRow, status: string): void {
    settleClosed(this.#store, this.#health, this.#s.network, row, status, LOST_BEFORE_SENT);
  }

  /** Whether both providers agree, at one block, that proposal `id` of `dao` no longer exists.
   *  False when that could not be read, so a provider failure still holds the veto. */
  async #deleted(dao: string, id: number): Promise<boolean> {
    const state = await this.#reads.watchState(dao, [id]);
    return state.kind === 'live' && state.asked.includes(id) && !state.proposals.some((p) => p.id === id);
  }

  async #vetoResult(verdictHash: string): Promise<string | null> {
    for (let i = 0; i < 5; i++) {
      try {
        const r = await this.#reads.primary.callFunction(this.#s.guard, 'veto_result', { verdict_hash_hex: verdictHash }, { finality: 'final' });
        const value: unknown = JSON.parse(r.text);
        if (typeof value === 'string') return value;
      } catch {
        // Read again below; the callback's result reaches final a block or two after the vote.
      }
      await this.#sleep(1_000);
    }
    return null;
  }

  /** Whether the registry's history for this proposal, read at final, holds a record of
   *  `verdictHash`. A read that fails, or does not show the hash, is tried again a second later,
   *  five tries in all; false after that, and never a throw. */
  async #registryHolds(dao: string, id: number, verdictHash: string): Promise<boolean> {
    for (let i = 0; i < 5; i++) {
      if (i > 0) await this.#sleep(1_000);
      try {
        for (let page = 0; page < HISTORY_PAGES; page++) {
          const args = { network: this.#s.network, dao, proposal_id: id, from: page * HISTORY_PAGE, limit: HISTORY_PAGE };
          const r = await this.#reads.primary.callFunction(this.#s.registry, 'history', args, { finality: 'final' });
          const records: unknown = JSON.parse(r.text);
          if (!Array.isArray(records)) break;
          if (records.some((rec: unknown) => typeof rec === 'object' && rec !== null && (rec as { verdict_hash?: unknown }).verdict_hash === verdictHash)) return true;
          if (records.length < HISTORY_PAGE) break;
        }
      } catch {
        // Read again on the next try; a provider a block behind catches up within seconds.
      }
    }
    return false;
  }

  /** From the proposal's own submission time (the add_proposal block) to the block of the DAO's
   *  act_proposal receipt that carried the guard's vote. */
  async #secondsSinceFiled(outcome: Parameters<typeof receiptBlock>[0], dao: string, submissionTime: string | null): Promise<number | null> {
    const blockHash = receiptBlock(outcome, dao);
    if (!blockHash || !submissionTime) return null;
    try {
      const b = await (this.#reads.primary as ViewProvider).block({ blockId: blockHash });
      return Math.round((b.timestampMs - Number(BigInt(submissionTime) / 1_000_000n)) / 100) / 10;
    } catch {
      return null;
    }
  }

  /** Records a verdict in the registry, attaching the storage it needs (C29: storage is never
   *  drained from the contract). Every verdict is recorded, vetoed or not. */
  async record(dao: string, id: number, signed: Signed): Promise<'recorded' | 'refused' | 'capped' | 'no_outcome'> {
    const key = `record:${this.#s.network}:${dao}:${id}:${signed.verdict.verdict_hash}`;
    const proposal = { dao, proposal: id };
    const reserved = worstCase(RECORD_GAS, RECORD_DEPOSIT);
    const capped = this.#alreadySigned(key) ? null : this.#caps.record(dao, reserved, key);
    if (capped) {
      this.#store.setRecordState(this.#s.network, dao, id, 'capped');
      this.#log.warn('refused', { what: 'record', dao, proposal_id: id, reason: 'cap', cap: capped.cap });
      this.#health.raise('cap_reached', dao, { cap: capped.cap });
      return 'capped';
    }
    let res: SubmitResult;
    try {
      this.#store.setRecordState(this.#s.network, dao, id, 'sent');
      res = await this.#submitter.submit({
        key,
        kind: 'record',
        dao,
        proposalId: id,
        receiver: this.#s.registry,
        method: 'record',
        args: { verdict: signed.verdictB64, signature: signed.signatureB64 },
        gas: RECORD_GAS,
        deposit: RECORD_DEPOSIT,
        reserved,
        windowBlocks: SHORT_WINDOW_BLOCKS,
        kept: (o) => {
          const entry = events(o).find((e) => e.by === this.#s.registry && e.event === 'verdict_recorded')?.data[0] as { storage_cost?: unknown } | undefined;
          return typeof entry?.storage_cost === 'string' && /^\d+$/.test(entry.storage_cost) ? BigInt(entry.storage_cost) : 0n;
        },
      });
    } catch (e) {
      // Its outcome is not known: bytes signed before the error may still land. The worker's
      // next pass sends it again by its idempotency key, as for any record with no outcome.
      this.#store.setRecordState(this.#s.network, dao, id, 'no_outcome');
      this.#log.error('record_not_sent', { dao, proposal_id: id, error: e });
      this.#health.raise('record_no_outcome', proposal, { problem: 'error' });
      return 'no_outcome';
    } finally {
      this.#caps.settle(key);
    }
    if (res.kind === 'no_outcome') {
      // Re-sent with the same bytes on the worker's next pass, until its outcome is final.
      this.#store.setRecordState(this.#s.network, dao, id, 'no_outcome');
      this.#health.raise('record_no_outcome', proposal, { tx: res.hash });
      return 'no_outcome';
    }
    if (res.kind === 'not_sent') {
      this.#store.setRecordState(this.#s.network, dao, id, 'refused');
      this.#log.error('record_refused', { dao, proposal_id: id, reason: 'not_sent', detail: res.detail });
      this.#health.clear('record_no_outcome', proposal);
      this.#health.raise('record_refused', proposal, { detail: res.detail });
      return 'refused';
    }
    const code = refusal(res.outcome);
    // The registry refuses a verdict it already stores, and anyone may send one the sealed program
    // signed, so a stranger who relayed ours first, or our own send landing twice, leaves it
    // recorded. The refusal alone is not taken for that: the registry's history must show it.
    if (code === 'ERR_DUPLICATE' && (await this.#registryHolds(dao, id, signed.verdict.verdict_hash))) {
      this.#store.setRecordState(this.#s.network, dao, id, 'recorded');
      this.#recorded(proposal);
      this.#log.info('recorded', { dao, proposal_id: id, tx: res.hash, note: 'the registry already held this verdict' });
      return 'recorded';
    }
    if (code) {
      this.#store.setRecordState(this.#s.network, dao, id, 'refused');
      this.#log.error('record_refused', { dao, proposal_id: id, code, tx: res.hash });
      this.#health.clear('record_no_outcome', proposal);
      this.#health.raise('record_refused', proposal, { code });
      return 'refused';
    }
    const entry = events(res.outcome).find((e) => e.by === this.#s.registry && e.event === 'verdict_recorded')?.data[0] as { index?: unknown; storage_cost?: unknown } | undefined;
    this.#store.setRecordState(this.#s.network, dao, id, 'recorded');
    this.#recorded(proposal);
    this.#log.info('recorded', { dao, proposal_id: id, tx: res.hash, registry_index: entry?.index ?? null, storage_near: typeof entry?.storage_cost === 'string' ? formatNear(BigInt(entry.storage_cost)) : null });
    return 'recorded';
  }
}
