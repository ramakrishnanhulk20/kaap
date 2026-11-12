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

const RUN = worstCase(RUN_GAS, RUN_DEPOSIT);
const RECORD = worstCase(RECORD_GAS, RECORD_DEPOSIT);
const VETO = worstCase(VETO_GAS, 0n);

/** What the worker spends to stop one attack at worst: the sealed run, the record and the veto. */
export const PER_STOPPED_ATTACK = RUN + RECORD + VETO;

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
   *  their worst case, with the DAO a record is for. Signing waits on the network, so without
   *  these, spends started together would each pass the NEAR check, and records of one DAO its
   *  record count, before any of them was counted. */
  readonly #held = new Map<string, { yocto: bigint; recordOf: string | null }>();

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
    return this.#hold(key, this.#runsFull(dao) ?? this.#nearFull(worstCase, 0n), worstCase, null);
  }

  /** As `run`, for a run that carries a member's text: counted against the text cap only, and
   *  refused when it would leave less than one stopped attack of the NEAR cap for proposal checks. */
  textRun(dao: string, worstCase: bigint, key: string): CapRefusal | null {
    const used = this.#store.textRunsOn(this.#network, dao, this.#today());
    if (used >= this.#caps.textRunsPerDaoDay) return { cap: 'text_runs_per_dao_day', used, limit: this.#caps.textRunsPerDaoDay };
    return this.#hold(key, this.#nearFull(worstCase, PER_STOPPED_ATTACK), worstCase, null);
  }

  /** Null when `dao` may have one more registry write today that can cost up to `worstCase`. The
   *  write is then held under `key`, in the same step as the check, until `settle(key)`, and is
   *  counted against the DAO's records from that step on, as a run is. */
  record(dao: string, worstCase: bigint, key: string): CapRefusal | null {
    return this.#hold(key, this.#recordsFull(dao) ?? this.#nearFull(worstCase, 0n), worstCase, dao);
  }

  /** Null when the whole worker may commit `worstCase` more yoctoNEAR today, for a veto. It is then
   *  held under `key`, in the same step as the check, until `settle(key)`. Nothing is kept back
   *  here: a veto is the proposal check that the reserve is kept for. */
  near(worstCase: bigint, key: string): CapRefusal | null {
    return this.#hold(key, this.#nearFull(worstCase, 0n), worstCase, null);
  }

  /** Whether one more proposal run, veto or registry write of `dao` would pass its caps right
   *  now, at its worst case. Nothing is held: a retry asks this first, so a step its cap still
   *  stops is left alone, not refused and logged again on every pass. The step itself then goes
   *  through the check above like any first try. */
  fits(kind: 'run' | 'veto' | 'record', dao: string): boolean {
    if (kind === 'run') return (this.#runsFull(dao) ?? this.#nearFull(RUN, 0n)) === null;
    if (kind === 'record') return (this.#recordsFull(dao) ?? this.#nearFull(RECORD, 0n)) === null;
    return this.#nearFull(VETO, 0n) === null;
  }

  /** Lets go of the spend held under `key`. Called once its submit is over: by then the spend
   *  table counts it, or it was never signed and costs nothing. A key with nothing held is ignored. */
  settle(key: string): void {
    this.#held.delete(key);
  }

  /** Holds `worstCase` under `key` when no cap refused it, in the same step as the check. */
  #hold(key: string, refused: CapRefusal | null, worstCase: bigint, recordOf: string | null): CapRefusal | null {
    if (!refused) this.#held.set(key, { yocto: worstCase, recordOf });
    return refused;
  }

  /** Whether the spend held under `key` has no live row yet, so the store does not count it. A
   *  rejected row counts nothing there, so a spend re-signing under it is still counted here. */
  #unwritten(key: string): boolean {
    const row = this.#store.spend(key);
    return !row || row.state === 'rejected';
  }

  #runsFull(dao: string): CapRefusal | null {
    const day = this.#today();
    const used = this.#store.runsOn(this.#network, dao, day) - this.#store.textRunsOn(this.#network, dao, day);
    return used >= this.#caps.runsPerDaoDay ? { cap: 'runs_per_dao_day', used, limit: this.#caps.runsPerDaoDay } : null;
  }

  #recordsFull(dao: string): CapRefusal | null {
    let held = 0;
    for (const [key, h] of this.#held) if (h.recordOf === dao && this.#unwritten(key)) held++;
    const used = this.#store.recordsOn(this.#network, dao, this.#today()) + held;
    return used >= this.#caps.recordsPerDaoDay ? { cap: 'records_per_dao_day', used, limit: this.#caps.recordsPerDaoDay } : null;
  }

  #nearFull(worstCase: bigint, kept: bigint): CapRefusal | null {
    const used = this.#committed();
    const limit = this.#caps.nearPerDay;
    if (used + worstCase > limit) return { cap: 'near_per_day', used, limit, asked: worstCase };
    if (used + worstCase + kept > limit) return { cap: 'near_kept_for_proposals', used, limit, asked: worstCase, kept };
    return null;
  }

  /** NEAR committed today: the store's figure, plus every held spend whose row is not live yet. */
  #committed(): bigint {
    let held = 0n;
    for (const [key, h] of this.#held) if (this.#unwritten(key)) held += h.yocto;
    return this.#store.spentOn(this.#today()) + held;
  }
}
