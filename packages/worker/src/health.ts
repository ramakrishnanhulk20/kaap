// What is wrong right now, per DAO and, for a proposal's own steps, per proposal, so a failure is
// loud instead of silent (C18). A raised signal stays until the condition behind it clears, and
// every change is logged and handed to the listeners, which turn it into member alerts; GET
// /status shows the same state to the public. The signals whose cause lives in the store are kept
// there too, so a restart starts from them instead of from nothing.
//
// "Guard offline" means Kaap cannot stop an attack on that DAO at the moment; "guard degraded"
// means it still can, but something needs attention. Notices are one-off events with no state.

import type { Logger } from './log.ts';

export type Signal =
  | 'watcher_lag'
  | 'provider_silent'
  | 'run_no_answer'
  | 'run_without_verdict'
  | 'providers_disagree'
  | 'provider_unavailable'
  | 'cap_reached'
  | 'veto_held'
  | 'veto_no_outcome'
  | 'veto_refused'
  | 'record_no_outcome'
  | 'record_refused'
  | 'verdict_rejected'
  | 'accepted_key_changed'
  | 'accepted_key_change_pending'
  | 'guard_mode_unread'
  | 'worker_balance_low'
  | 'guard_balance_low'
  | 'alerts_failing'
  | 'ai_key_missing'
  | 'guard_not_armed'
  | 'proposals_skipped'
  | 'counter_implausible'
  | 'watch_limit_reached';

export type Notice = 'counter_gap' | 'veto_lost';

export type Level = 'offline' | 'degraded';

/** The scope of a signal that concerns every DAO the worker watches. Never a valid account id. */
export const ALL = '*';

const OFFLINE: ReadonlySet<Signal> = new Set<Signal>(['watcher_lag', 'cap_reached']);

export const levelOf = (signal: Signal): Level => (OFFLINE.has(signal) ? 'offline' : 'degraded');

/** Where a signal is raised: a DAO (or `ALL`), or one proposal of a DAO. */
export type Scope = string | { dao: string; proposal: number };

/** Signals about one proposal's own judgement, veto or record. Each is kept per proposal, so it
 *  clears only when that proposal's step succeeds or the proposal closes, never because another
 *  proposal of the DAO moved. */
const PER_PROPOSAL: ReadonlySet<Signal> = new Set<Signal>(['run_no_answer', 'run_without_verdict', 'verdict_rejected', 'veto_held', 'veto_no_outcome', 'veto_refused', 'record_no_outcome', 'record_refused']);

/** Signals whose cause the store keeps (a proposal's step, a capped row, the last verdict read),
 *  so a restart takes them up again as they were. The rest come from live reads (lag, a silent or
 *  disagreeing provider, balances, Telegram), which the restarted worker makes again within its
 *  first checks; a copy carried over would only clear falsely before those checks ran. */
const KEPT: ReadonlySet<Signal> = new Set<Signal>([...PER_PROPOSAL, 'cap_reached', 'accepted_key_changed', 'accepted_key_change_pending', 'ai_key_missing']);

/** Where the kept signals live across a restart: the worker's store. */
export interface SignalBook {
  keptSignals(network: string): Array<{ signal: string; dao: string; proposal: number | null; since_ms: number }>;
  keepSignal(network: string, signal: Signal, dao: string, proposal: number | null, sinceMs: number): void;
  dropSignal(network: string, signal: Signal, dao: string, proposal: number | null): void;
}

const scoped = (scope: Scope): { dao: string; proposal: number | null } => (typeof scope === 'string' ? { dao: scope, proposal: null } : scope);
const keyOf = (signal: Signal, dao: string, proposal: number | null) => `${signal}|${dao}|${proposal ?? ''}`;
/** The proposal, for log lines, when the signal has one. */
const named = (proposal: number | null) => (proposal === null ? {} : { proposal_id: proposal });

/** The fixed text members and the status page see for each signal. No field of a signal ever
 *  reaches them, so nothing a provider or a contract wrote can either. */
export const SAYS: Record<Signal, string> = {
  watcher_lag: "Kaap cannot read this DAO's proposal counter from either RPC provider, so new proposals are not being checked.",
  provider_silent: "One of Kaap's two RPC providers is not answering. New proposals wait until both agree, so a veto may come late.",
  run_no_answer: 'The sealed judge did not answer a run. Kaap tries once more.',
  run_without_verdict: 'A proposal could not be judged, so the guard cannot act on it.',
  providers_disagree: "Kaap's two RPC providers disagree about this DAO. Kaap holds any vote until they agree.",
  provider_unavailable: 'A new proposal is waiting because one RPC provider could not confirm it.',
  cap_reached: 'Kaap reached a daily spending limit. What it stopped is tried again once the limit has room, at 00:00 UTC at the latest.',
  veto_held: "Kaap held a veto: it could not confirm the proposal's live state on both providers, or could not send the vote. It tries again on every pass.",
  veto_no_outcome: 'A veto was sent but no result has come back yet. Kaap keeps sending the same vote.',
  veto_refused: 'A veto was refused by the guard or the DAO.',
  record_no_outcome: 'A verdict for the registry has no result yet: no answer came back, or the send failed. Kaap keeps sending it.',
  record_refused: 'The registry refused to record a verdict.',
  verdict_rejected: 'Kaap refused a verdict from the sealed judge that did not check out.',
  accepted_key_changed: "The guard's accepted signing key changed. Until a verdict signed with the new key checks out, Kaap cannot confirm the guard still accepts its verdicts.",
  accepted_key_change_pending: "The guard's owner announced a change of the key the guard trusts. It takes effect 24 hours after it was announced unless the owner cancels it. Until then verdicts are still checked against the current key. The commands kaap verify and kaap arming show the new key and the time.",
  guard_mode_unread: 'Kaap could not read from both RPC providers whether this treasury wants requests Kaap cannot read rejected. It goes by the last setting both agreed on until they agree again.',
  worker_balance_low: "Kaap's worker account holds less NEAR than it needs to judge, record and veto 20 more attacks.",
  guard_balance_low: 'The guard contract holds less NEAR than the storage for 20 more vetoes.',
  alerts_failing: 'Kaap cannot deliver Telegram alerts right now.',
  ai_key_missing: "The sealed judge ran without its NEAR AI key, so new verdicts carry no AI second opinion until the key reaches it again. Kaap's plain-code checks and vetoes still work.",
  guard_not_armed: "This treasury's rules give Kaap's guard no deciding reject vote, so the guard cannot stop any request here. Kaap judges none of its requests until the guard is armed again.",
  proposals_skipped: 'More requests were new at once than Kaap takes up in one pass. It took the newest and skipped the older ones, which members must check themselves.',
  counter_implausible: "This account's request counter gave a number no treasury could reach, so Kaap took up nothing from it on that pass.",
  watch_limit_reached: 'Kaap is watching as many treasuries as it is set to watch, and at least one more enrolled treasury is waiting for room.',
};

export interface Raised {
  signal: Signal;
  dao: string;
  /** The proposal it was raised for, or null for one about the whole DAO. */
  proposal: number | null;
  since: number;
  fields: Record<string, unknown>;
}

export type HealthEvent =
  | { kind: 'raised'; raised: Raised }
  | { kind: 'cleared'; raised: Raised }
  | { kind: 'notice'; notice: Notice; dao: string; fields: Record<string, unknown> };

export class Health {
  readonly #log: Logger;
  readonly #now: () => number;
  readonly #raised = new Map<string, Raised>();
  readonly #listeners: Array<(event: HealthEvent) => void> = [];
  #book: { book: SignalBook; network: string } | null = null;

  constructor(log: Logger, now: () => number = Date.now) {
    this.#log = log;
    this.#now = now;
  }

  on(listener: (event: HealthEvent) => void): void {
    this.#listeners.push(listener);
  }

  #emit(event: HealthEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (e) {
        // A listener that throws must never stop the signal itself being kept and logged.
        this.#log.error('health_listener_failed', { error: e });
      }
    }
  }

  /** Raises `signal` for `scope`. Raising one already raised only updates its fields: one cause is
   *  one change, logged and alerted once. */
  raise(signal: Signal, scope: Scope, fields: Record<string, unknown> = {}): void {
    const { dao, proposal } = scoped(scope);
    const key = keyOf(signal, dao, proposal);
    const open = this.#raised.get(key);
    if (open) {
      open.fields = fields;
      return;
    }
    const raised: Raised = { signal, dao, proposal, since: this.#now(), fields };
    this.#raised.set(key, raised);
    if (this.#book && KEPT.has(signal)) this.#book.book.keepSignal(this.#book.network, signal, dao, proposal, raised.since);
    this.#log.error(levelOf(signal) === 'offline' ? 'guard_offline' : 'guard_degraded', { signal, dao, ...named(proposal), ...fields });
    this.#emit({ kind: 'raised', raised });
  }

  /** Clears `signal` for exactly `scope`: a DAO's own signal, or one proposal's. */
  clear(signal: Signal, scope: Scope): void {
    const raised = this.#take(signal, scope);
    if (!raised) return;
    this.#log.info('guard_recovered', { signal, dao: raised.dao, ...named(raised.proposal) });
    this.#emit({ kind: 'cleared', raised });
  }

  /** Ends a signal whose cause never recovered but became other news: a held or refused veto on a
   *  proposal that then passed is a lost veto, which members hear as that. Nobody is told this
   *  signal cleared, since nothing about it got better. */
  retire(signal: Signal, scope: Scope, why: string): void {
    const raised = this.#take(signal, scope);
    if (raised) this.#log.warn('signal_retired', { signal, dao: raised.dao, ...named(raised.proposal), why });
  }

  #take(signal: Signal, scope: Scope): Raised | undefined {
    const { dao, proposal } = scoped(scope);
    const key = keyOf(signal, dao, proposal);
    const raised = this.#raised.get(key);
    if (!raised) return undefined;
    this.#raised.delete(key);
    if (this.#book && KEPT.has(signal)) this.#book.book.dropSignal(this.#book.network, signal, dao, proposal);
    return raised;
  }

  /** Keeps every signal whose cause the store holds in `book` from now on, and takes up the ones
   *  an earlier process left there, each with the time it was first raised. Listeners hear
   *  nothing about those: members were told when each was raised, and an alert about one that
   *  the earlier process had not sent yet is still in the queue. Run once, at boot. */
  keepIn(book: SignalBook, network: string): void {
    this.#book = { book, network };
    for (const r of this.#raised.values()) if (KEPT.has(r.signal)) book.keepSignal(network, r.signal, r.dao, r.proposal, r.since);
    let restored = 0;
    for (const k of book.keptSignals(network)) {
      if (!KEPT.has(k.signal as Signal)) continue;
      const signal = k.signal as Signal;
      const key = keyOf(signal, k.dao, k.proposal);
      if (this.#raised.has(key)) continue;
      this.#raised.set(key, { signal, dao: k.dao, proposal: k.proposal, since: k.since_ms, fields: {} });
      restored++;
    }
    if (restored > 0) this.#log.info('signals_restored', { count: restored });
  }

  notice(notice: Notice, dao: string, fields: Record<string, unknown> = {}): void {
    if (notice === 'veto_lost') this.#log.error('veto_lost', { dao, ...fields });
    else this.#log.warn('notice', { notice, dao, ...fields });
    this.#emit({ kind: 'notice', notice, dao, fields });
  }

  current(): Raised[] {
    return [...this.#raised.values()];
  }

  /** Whether `signal` is raised for `dao`, for one proposal of it when `proposal` is given, or for
   *  the DAO or any of its proposals when it is not. */
  has(signal: Signal, dao: string, proposal?: number): boolean {
    if (proposal !== undefined) return this.#raised.has(keyOf(signal, dao, proposal));
    for (const r of this.#raised.values()) if (r.signal === signal && r.dao === dao) return true;
    return false;
  }

  /** The worst level raised for `dao`, counting signals raised for every DAO. */
  levelFor(dao: string): 'healthy' | Level {
    let worst: 'healthy' | Level = 'healthy';
    for (const r of this.#raised.values()) {
      if (r.dao !== dao && r.dao !== ALL) continue;
      if (levelOf(r.signal) === 'offline') return 'offline';
      worst = 'degraded';
    }
    return worst;
  }
}
