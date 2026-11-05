// What is wrong right now, per DAO, so a failure is loud instead of silent (C18). A raised signal
// stays until the condition behind it clears, and every change is logged and handed to the
// listeners, which turn it into member alerts; GET /status shows the same state to the public.
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
  | 'worker_balance_low'
  | 'guard_balance_low'
  | 'alerts_failing'
  | 'ai_key_missing';

export type Notice = 'counter_gap' | 'veto_lost';

export type Level = 'offline' | 'degraded';

/** The scope of a signal that concerns every DAO the worker watches. Never a valid account id. */
export const ALL = '*';

const OFFLINE: ReadonlySet<Signal> = new Set<Signal>(['watcher_lag', 'cap_reached']);

export const levelOf = (signal: Signal): Level => (OFFLINE.has(signal) ? 'offline' : 'degraded');

/** The fixed text members and the status page see for each signal. No field of a signal ever
 *  reaches them, so nothing a provider or a contract wrote can either. */
export const SAYS: Record<Signal, string> = {
  watcher_lag: "Kaap cannot read this DAO's proposal counter from either RPC provider, so new proposals are not being checked.",
  provider_silent: "One of Kaap's two RPC providers is not answering. New proposals wait until both agree, so a veto may come late.",
  run_no_answer: 'The sealed judge did not answer a run. Kaap tries once more.',
  run_without_verdict: 'A proposal could not be judged, so the guard cannot act on it.',
  providers_disagree: "Kaap's two RPC providers disagree about this DAO. Kaap holds any vote until they agree.",
  provider_unavailable: 'A new proposal is waiting because one RPC provider could not confirm it.',
  cap_reached: 'Kaap reached a daily spending limit and stops judging and vetoing until it resets at 00:00 UTC.',
  veto_held: "Kaap held a veto because it could not confirm the proposal's live state on both providers.",
  veto_no_outcome: 'A veto was sent but no result has come back yet. Kaap keeps sending the same vote.',
  veto_refused: 'A veto was refused by the guard or the DAO.',
  record_no_outcome: 'A verdict was sent to the registry but no result has come back yet. Kaap keeps sending it.',
  record_refused: 'The registry refused to record a verdict.',
  verdict_rejected: 'Kaap refused a verdict from the sealed judge that did not check out.',
  accepted_key_changed: "The guard's accepted signing key changed. Until a verdict signed with the new key checks out, Kaap cannot confirm the guard still accepts its verdicts.",
  worker_balance_low: "Kaap's worker account holds less NEAR than it needs to judge, record and veto 20 more attacks.",
  guard_balance_low: 'The guard contract holds less NEAR than the storage for 20 more vetoes.',
  alerts_failing: 'Kaap cannot deliver Telegram alerts right now.',
  ai_key_missing: "The sealed judge ran without its NEAR AI key, so new verdicts carry no AI second opinion until the key reaches it again. Kaap's plain-code checks and vetoes still work.",
};

export interface Raised {
  signal: Signal;
  dao: string;
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

  raise(signal: Signal, dao: string, fields: Record<string, unknown> = {}): void {
    const key = `${signal}|${dao}`;
    const open = this.#raised.get(key);
    if (open) {
      open.fields = fields;
      return;
    }
    const raised = { signal, dao, since: this.#now(), fields };
    this.#raised.set(key, raised);
    this.#log.error(levelOf(signal) === 'offline' ? 'guard_offline' : 'guard_degraded', { signal, dao, ...fields });
    this.#emit({ kind: 'raised', raised });
  }

  clear(signal: Signal, dao: string): void {
    const key = `${signal}|${dao}`;
    const raised = this.#raised.get(key);
    if (!raised) return;
    this.#raised.delete(key);
    this.#log.info('guard_recovered', { signal, dao });
    this.#emit({ kind: 'cleared', raised });
  }

  notice(notice: Notice, dao: string, fields: Record<string, unknown> = {}): void {
    if (notice === 'veto_lost') this.#log.error('veto_lost', { dao, ...fields });
    else this.#log.warn('notice', { notice, dao, ...fields });
    this.#emit({ kind: 'notice', notice, dao, fields });
  }

  current(): Raised[] {
    return [...this.#raised.values()];
  }

  has(signal: Signal, dao: string): boolean {
    return this.#raised.has(`${signal}|${dao}`);
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
