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
import type { Store } from './store.ts';
import type { Submitter } from './submit.ts';

/** The guard's NatSpec asks for 300 Tgas: big kinds need it and what is not burnt comes back. */
export const VETO_GAS = 300n * TGAS;
export const RECORD_GAS = 30n * TGAS;
/** kaap-registry's README: 0.02 NEAR always covers a record; the registry refunds the rest. */
export const RECORD_DEPOSIT = 20n * 10n ** 21n;
/** A veto is not sent on a verdict this close to its expiry: it could expire on the way. */
export const EXPIRY_MARGIN_MS = 30_000;
/** Record and veto outcomes are final within a few blocks; this is generous. */
const SHORT_WINDOW_BLOCKS = 60;

/** The per-DAO signals one proposal's veto or record raises, each with the stored state that
 *  keeps it true. */
const HELD_BY_PROPOSAL: ReadonlyArray<readonly [Signal, 'veto_state' | 'record_state', string]> = [
  ['veto_held', 'veto_state', 'held'],
  ['veto_refused', 'veto_state', 'refused'],
  ['record_refused', 'record_state', 'refused'],
];

/** Clears each of those signals for `dao` once no proposal the worker still sees open (the rule
 *  of `Store.open`) is in the state that raised it. Called whenever a proposal of `dao` is seen
 *  leaving InProgress, whatever it moved to: a held or refused action stops mattering once its
 *  proposal can no longer pass. */
export function clearClosed(store: Store, health: Health, network: string, dao: string): void {
  const open = store.open(network, dao);
  for (const [signal, column, state] of HELD_BY_PROPOSAL) if (!open.some((r) => r[column] === state)) health.clear(signal, dao);
}

export type Decision =
  | { act: 'veto' }
  | { act: 'none'; why: 'not_vetoable' }
  | { act: 'none'; why: 'not_open'; status: string }
  | { act: 'rejudge'; why: 'stale_policy' | 'stale_receivers' | 'kind_changed' | 'expired' };

/** The veto decision for `verdict` against the state read at final just before sending. The
 *  veto rule itself is kaap-core's, mirrored from the guard inside the bridge (`vetoable`). */
export function decide(verdict: DecodedVerdict, live: LiveProposal, now: number): Decision {
  if (!verdict.vetoable) return { act: 'none', why: 'not_vetoable' };
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

  /** Decides on and, when the rule says so, sends the veto for one verdict. */
  async veto(dao: string, id: number, signed: Signed): Promise<VetoOutcome> {
    const { verdict } = signed;
    const before = this.#store.judged(this.#s.network, dao, id)?.veto_state;
    const key = `veto:${this.#s.network}:${dao}:${id}:${verdict.verdict_hash}`;
    if (!verdict.vetoable) {
      this.#store.setVetoState(this.#s.network, dao, id, 'not_needed');
      this.#log.info('no_veto', { dao, proposal_id: id, why: 'the guard rule does not allow a veto', risk: verdict.risk, floor: verdict.floor, ai_status: verdict.ai_status });
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
        this.#settleClosed(dao);
        return { kind: 'not_needed', why: 'not_open' };
      }
      this.#store.setVetoState(this.#s.network, dao, id, 'held');
      this.#log.error('refused', { what: 'veto', dao, proposal_id: id, reason: 'live state not agreed', problem: live });
      this.#health.raise('veto_held', dao, { proposal_id: id, problem: live.kind, item: live.item });
      return { kind: 'held', why: `${live.kind}: ${live.item}` };
    }
    this.#store.setProposalStatus(this.#s.network, dao, id, live.status);
    const d = decide(verdict, live, this.#now());
    if (d.act === 'none') {
      this.#store.setVetoState(this.#s.network, dao, id, d.why === 'not_open' ? 'not_open' : 'not_needed');
      this.#log.info('no_veto', { dao, proposal_id: id, why: d.why, status: live.status });
      if (d.why === 'not_open') {
        this.#settleClosed(dao);
        // A sent veto that never got an answer on a proposal that then passed is the worst
        // outcome Kaap has, so it gets its own critical alert, not a quiet "not needed".
        if (live.status === 'Approved' && (before === 'no_outcome' || before === 'sent')) {
          this.#health.notice('veto_lost', dao, { proposal_id: id, tx: this.#store.spend(key)?.tx_hash ?? null, verdict_hash: verdict.verdict_hash });
        }
      }
      return { kind: 'not_needed', why: d.why };
    }
    if (d.act === 'rejudge') {
      this.#log.warn('refused', { what: 'veto', dao, proposal_id: id, reason: d.why, verdict_block: verdict.block_height, live_block: live.height });
      return { kind: 'rejudge', why: d.why };
    }

    const reserved = worstCase(VETO_GAS, 0n);
    const capped = this.#alreadySigned(key) ? null : this.#caps.near(reserved);
    if (capped) {
      this.#store.setVetoState(this.#s.network, dao, id, 'capped');
      this.#log.error('refused', { what: 'veto', dao, proposal_id: id, reason: 'cap', cap: capped.cap });
      this.#health.raise('cap_reached', dao, { cap: capped.cap });
      return { kind: 'held', why: 'near_per_day cap' };
    }
    this.#store.setVetoState(this.#s.network, dao, id, 'sent');
    const res = await this.#submitter.submit({
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
    if (res.kind === 'no_outcome') {
      // The vote may still land, or may never have reached the chain: the worker re-sends the same
      // bytes on its next pass until the outcome is final or the veto is no longer needed.
      this.#store.setVetoState(this.#s.network, dao, id, 'no_outcome');
      this.#health.raise('veto_no_outcome', dao, { proposal_id: id, tx: res.hash });
      return { kind: 'held', why: 'no_outcome' };
    }
    if (res.kind === 'not_sent') {
      this.#store.setVetoState(this.#s.network, dao, id, 'held');
      this.#health.raise('veto_held', dao, { proposal_id: id, problem: res.kind });
      return { kind: 'held', why: res.kind };
    }
    // Every path below ends cast or refused, so this outcome is no longer missing.
    this.#clearNoOutcome('veto_no_outcome', dao);
    const code = refusal(res.outcome);
    // ERR_REPLAY means this verdict was already spent, for instance by a send whose answer was
    // lost; the guard's own record then says whether that vote landed.
    if (code === 'ERR_REPLAY' && (await this.#vetoResult(verdict.verdict_hash)) === 'Ok') {
      this.#store.setVetoState(this.#s.network, dao, id, 'cast');
      this.#log.info('veto_cast', { dao, proposal_id: id, tx: res.hash, note: 'an earlier send of this verdict had already cast the vote' });
      return { kind: 'cast', tx: res.hash, seconds: null };
    }
    if (code) {
      this.#store.setVetoState(this.#s.network, dao, id, 'refused');
      this.#log.error('veto_refused_by_guard', { dao, proposal_id: id, code, tx: res.hash });
      if (code === 'ERR_EXPIRED') return { kind: 'rejudge', why: 'expired' };
      this.#health.raise('veto_refused', dao, { proposal_id: id, code });
      return { kind: 'refused_by_guard', tx: res.hash, code };
    }

    const result = await this.#vetoResult(verdict.verdict_hash);
    const evented = events(res.outcome).find((e) => e.by === this.#s.guard && (e.event === 'veto_cast' || e.event === 'veto_refused'))?.event;
    if (result !== 'Ok') {
      this.#store.setVetoState(this.#s.network, dao, id, 'refused');
      this.#log.error('veto_refused', { dao, proposal_id: id, veto_result: result, guard_event: evented ?? null, tx: res.hash });
      this.#health.raise('veto_refused', dao, { proposal_id: id, veto_result: result });
      return { kind: 'refused_by_dao', tx: res.hash };
    }
    this.#store.setVetoState(this.#s.network, dao, id, 'cast');
    const seconds = await this.#secondsSinceFiled(res.outcome, dao, live.submissionTime);
    this.#log.info('veto_cast', { dao, proposal_id: id, tx: res.hash, guard_event: evented ?? null, veto_result: result, seconds_from_add_proposal: seconds });
    return { kind: 'cast', tx: res.hash, seconds };
  }

  /** A resend of bytes already signed costs nothing new: the caps counted it when it was signed,
   *  and counting it twice would park a lost send as capped. */
  #alreadySigned(key: string): boolean {
    const row = this.#store.spend(key);
    return row !== undefined && row.state !== 'rejected';
  }

  /** For a proposal this actor just saw closed. Its status already left InProgress in the store,
   *  so the re-judge watch will not see it close; the signals it held are settled here. A missing
   *  veto outcome stops mattering too, however the proposal closed. */
  #settleClosed(dao: string): void {
    this.#clearNoOutcome('veto_no_outcome', dao);
    clearClosed(this.#store, this.#health, this.#s.network, dao);
  }

  /** Whether both providers agree, at one block, that proposal `id` of `dao` no longer exists.
   *  False when that could not be read, so a provider failure still holds the veto. */
  async #deleted(dao: string, id: number): Promise<boolean> {
    const state = await this.#reads.watchState(dao, [id]);
    return state.kind === 'live' && state.asked.includes(id) && !state.proposals.some((p) => p.id === id);
  }

  /** Signals are kept per DAO, so one is cleared only once no proposal of that DAO is still
   *  waiting for a missing outcome. */
  #clearNoOutcome(signal: 'veto_no_outcome' | 'record_no_outcome', dao: string): void {
    const waiting = this.#store.pendingActions(this.#s.network).some((r) => r.dao === dao && (signal === 'veto_no_outcome' ? r.veto_state : r.record_state) === 'no_outcome');
    if (!waiting) this.#health.clear(signal, dao);
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
    const reserved = worstCase(RECORD_GAS, RECORD_DEPOSIT);
    const capped = this.#alreadySigned(key) ? null : this.#caps.record(dao, reserved);
    if (capped) {
      this.#store.setRecordState(this.#s.network, dao, id, 'capped');
      this.#log.warn('refused', { what: 'record', dao, proposal_id: id, reason: 'cap', cap: capped.cap });
      this.#health.raise('cap_reached', dao, { cap: capped.cap });
      return 'capped';
    }
    this.#store.setRecordState(this.#s.network, dao, id, 'sent');
    const res = await this.#submitter.submit({
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
    if (res.kind === 'no_outcome') {
      // Re-sent with the same bytes on the worker's next pass, until its outcome is final.
      this.#store.setRecordState(this.#s.network, dao, id, 'no_outcome');
      this.#health.raise('record_no_outcome', dao, { proposal_id: id, tx: res.hash });
      return 'no_outcome';
    }
    if (res.kind === 'not_sent') {
      this.#store.setRecordState(this.#s.network, dao, id, 'refused');
      this.#log.error('record_refused', { dao, proposal_id: id, reason: 'not_sent', detail: res.detail });
      this.#health.raise('record_refused', dao, { proposal_id: id, detail: res.detail });
      return 'refused';
    }
    const code = refusal(res.outcome);
    if (code) {
      this.#store.setRecordState(this.#s.network, dao, id, 'refused');
      this.#log.error('record_refused', { dao, proposal_id: id, code, tx: res.hash });
      this.#health.raise('record_refused', dao, { proposal_id: id, code });
      return 'refused';
    }
    const entry = events(res.outcome).find((e) => e.by === this.#s.registry && e.event === 'verdict_recorded')?.data[0] as { index?: unknown; storage_cost?: unknown } | undefined;
    this.#store.setRecordState(this.#s.network, dao, id, 'recorded');
    this.#clearNoOutcome('record_no_outcome', dao);
    this.#log.info('recorded', { dao, proposal_id: id, tx: res.hash, registry_index: entry?.index ?? null, storage_near: typeof entry?.storage_cost === 'string' ? formatNear(BigInt(entry.storage_cost)) : null });
    return 'recorded';
  }
}
