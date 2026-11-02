// Hard daily ceilings on what the worker may spend (C29). They are counted from the store, so a
// restart never resets them, and checked before a transaction is signed, so a refused one is
// never sent. A cap that is reached is a loud refusal, never a silent skip.

import { dayOf, type Store } from './store.ts';

export interface Caps {
  runsPerDaoDay: number;
  recordsPerDaoDay: number;
  nearPerDay: bigint;
}

export type CapRefusal =
  | { cap: 'runs_per_dao_day'; used: number; limit: number }
  | { cap: 'records_per_dao_day'; used: number; limit: number }
  | { cap: 'near_per_day'; used: bigint; limit: bigint; asked: bigint };

export class CapGuard {
  readonly #store: Store;
  readonly #caps: Caps;
  readonly #network: string;

  constructor(store: Store, caps: Caps, network: string) {
    this.#store = store;
    this.#caps = caps;
    this.#network = network;
  }

  #today(): string {
    return dayOf(this.#store.now());
  }

  /** Null when `dao` may start one more sealed run today that can cost up to `worstCase`. */
  run(dao: string, worstCase: bigint): CapRefusal | null {
    const used = this.#store.runsOn(this.#network, dao, this.#today());
    if (used >= this.#caps.runsPerDaoDay) return { cap: 'runs_per_dao_day', used, limit: this.#caps.runsPerDaoDay };
    return this.near(worstCase);
  }

  /** Null when `dao` may have one more registry write today that can cost up to `worstCase`. */
  record(dao: string, worstCase: bigint): CapRefusal | null {
    const used = this.#store.recordsOn(this.#network, dao, this.#today());
    if (used >= this.#caps.recordsPerDaoDay) return { cap: 'records_per_dao_day', used, limit: this.#caps.recordsPerDaoDay };
    return this.near(worstCase);
  }

  /** Null when the whole worker may commit `worstCase` more yoctoNEAR today. */
  near(worstCase: bigint): CapRefusal | null {
    const used = this.#store.spentOn(this.#today());
    if (used + worstCase > this.#caps.nearPerDay) return { cap: 'near_per_day', used, limit: this.#caps.nearPerDay, asked: worstCase };
    return null;
  }
}
