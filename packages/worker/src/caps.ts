// Hard daily ceilings on what the worker may spend (C29). They are counted from the store, so a
// restart never resets them, and checked before a transaction is signed, so a refused one is
// never sent. A cap that is reached is a loud refusal, never a silent skip.
//
// Runs that carry a member's text are counted apart from a DAO's own proposal runs, and may not
// spend the last stopped attack's worth of the NEAR cap, so anyone sending texts can never use up
// what the DAO's own proposal checks need that day.

import { RECORD_DEPOSIT, RECORD_GAS, VETO_GAS } from './act.ts';
import { RUN_DEPOSIT, RUN_GAS } from './judge.ts';
import { worstCase } from './near.ts';
import { dayOf, type Store } from './store.ts';

/** What the worker spends to stop one attack at worst: the sealed run, the record and the veto. */
export const PER_STOPPED_ATTACK = worstCase(RUN_GAS, RUN_DEPOSIT) + worstCase(RECORD_GAS, RECORD_DEPOSIT) + worstCase(VETO_GAS, 0n);

export interface Caps {
  runsPerDaoDay: number;
  /** Runs that carry a member's text, counted apart from `runsPerDaoDay`. */
  textRunsPerDaoDay: number;
  recordsPerDaoDay: number;
  nearPerDay: bigint;
}

export type CapRefusal =
  | { cap: 'runs_per_dao_day'; used: number; limit: number }
  | { cap: 'text_runs_per_dao_day'; used: number; limit: number }
  | { cap: 'records_per_dao_day'; used: number; limit: number }
  | { cap: 'near_per_day'; used: bigint; limit: bigint; asked: bigint }
  | { cap: 'near_kept_for_proposals'; used: bigint; limit: bigint; asked: bigint; kept: bigint };

export class CapGuard {
  readonly #store: Store;
  readonly #caps: Caps;
  readonly #network: string;
  /** Runs, records and vetoes let through but not yet in the spend table, by idempotency key, at
   *  their worst case. Signing waits on the network, so without these, spends started together
   *  would each pass the NEAR check before any of them was counted. */
  readonly #held = new Map<string, bigint>();

  constructor(store: Store, caps: Caps, network: string) {
    this.#store = store;
    this.#caps = caps;
    this.#network = network;
  }

  #today(): string {
    return dayOf(this.#store.now());
  }

  /** Null when `dao` may start one more proposal run today that can cost up to `worstCase`. The
   *  run is then held under `key`, in the same step as the check, until `settle(key)`. Runs that
   *  carried a text do not count here. */
  run(dao: string, worstCase: bigint, key: string): CapRefusal | null {
    const day = this.#today();
    const used = this.#store.runsOn(this.#network, dao, day) - this.#store.textRunsOn(this.#network, dao, day);
    if (used >= this.#caps.runsPerDaoDay) return { cap: 'runs_per_dao_day', used, limit: this.#caps.runsPerDaoDay };
    return this.#hold(key, worstCase, 0n);
  }

  /** As `run`, for a run that carries a member's text: counted against the text cap only, and
   *  refused when it would leave less than one stopped attack of the NEAR cap for proposal checks. */
  textRun(dao: string, worstCase: bigint, key: string): CapRefusal | null {
    const used = this.#store.textRunsOn(this.#network, dao, this.#today());
    if (used >= this.#caps.textRunsPerDaoDay) return { cap: 'text_runs_per_dao_day', used, limit: this.#caps.textRunsPerDaoDay };
    return this.#hold(key, worstCase, PER_STOPPED_ATTACK);
  }

  /** Null when `dao` may have one more registry write today that can cost up to `worstCase`. The
   *  write is then held under `key`, in the same step as the check, until `settle(key)`. */
  record(dao: string, worstCase: bigint, key: string): CapRefusal | null {
    const used = this.#store.recordsOn(this.#network, dao, this.#today());
    if (used >= this.#caps.recordsPerDaoDay) return { cap: 'records_per_dao_day', used, limit: this.#caps.recordsPerDaoDay };
    return this.#hold(key, worstCase, 0n);
  }

  /** Null when the whole worker may commit `worstCase` more yoctoNEAR today, for a veto. It is then
   *  held under `key`, in the same step as the check, until `settle(key)`. Nothing is kept back
   *  here: a veto is the proposal check that the reserve is kept for. */
  near(worstCase: bigint, key: string): CapRefusal | null {
    return this.#hold(key, worstCase, 0n);
  }

  /** Lets go of the spend held under `key`. Called once its submit is over: by then the spend
   *  table counts it, or it was never signed and costs nothing. A key with nothing held is ignored. */
  settle(key: string): void {
    this.#held.delete(key);
  }

  #hold(key: string, worstCase: bigint, kept: bigint): CapRefusal | null {
    const used = this.#committed();
    const limit = this.#caps.nearPerDay;
    if (used + worstCase > limit) return { cap: 'near_per_day', used, limit, asked: worstCase };
    if (used + worstCase + kept > limit) return { cap: 'near_kept_for_proposals', used, limit, asked: worstCase, kept };
    this.#held.set(key, worstCase);
    return null;
  }

  /** NEAR committed today: the store's figure, plus every held spend whose row is not live yet. A
   *  rejected row counts nothing in the store, so a spend re-signing under it stays held. */
  #committed(): bigint {
    let held = 0n;
    for (const [key, yocto] of this.#held) {
      const row = this.#store.spend(key);
      if (!row || row.state === 'rejected') held += yocto;
    }
    return this.#store.spentOn(this.#today()) + held;
  }
}
