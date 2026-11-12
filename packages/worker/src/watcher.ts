// Notices new proposals of one DAO within about a second (C21, C22).
//
// Every tick reads the DAO's own counter, `get_last_proposal_id`, at optimistic finality from
// both providers. That only makes the worker look sooner: an id is taken up for judging once both
// providers show it at final finality, and while they disagree the extra ids are held, with an
// alert if the hold outlasts the hold window. Because the counter is the DAO's own, every id below
// it is judged, however the proposal got there (a batch, a cross-contract call, a gap while the
// worker was down), and a jump of more than one is logged as a gap that was backfilled.
//
// What one account can ask for in a pass is bounded, since anyone can enrol an account (C29):
// at most `MAX_IDS_PER_PASS` new ids are taken up, the newest, and the rest are said as skipped;
// and a counter no treasury could have, one that is not a whole number below 2^53 or that sits
// more than `MAX_COUNTER_JUMP` past the last id taken up, queues nothing at all.

import type { Health } from './health.ts';
import { MAX_COUNTER_JUMP, MAX_IDS_PER_PASS } from './limits.ts';
import type { Logger } from './log.ts';
import { ImplausibleCounter, type Reads } from './reads.ts';
import type { Store } from './store.ts';

export interface WatcherOptions {
  network: string;
  holdAlertMs: number;
  now: () => number;
}

export class CounterWatch {
  readonly dao: string;
  readonly #reads: Reads;
  readonly #store: Store;
  readonly #health: Health;
  readonly #log: Logger;
  readonly #o: WatcherOptions;
  readonly #enqueue: (id: number) => void;
  #holdSince: number | null = null;
  /** The last pass found a counter no treasury could have; kept so the next one looks again. */
  #implausible = false;
  #ticking = false;
  readonly #lastRead: [number, number];

  constructor(dao: string, reads: Reads, store: Store, health: Health, log: Logger, options: WatcherOptions, enqueue: (id: number) => void) {
    this.dao = dao;
    this.#reads = reads;
    this.#store = store;
    this.#health = health;
    this.#log = log;
    this.#o = options;
    this.#enqueue = enqueue;
    // A provider that never answers from the start is late from the start.
    this.#lastRead = [options.now(), options.now()];
  }

  /** When each provider last answered this DAO's counter. Kept outside the tick, so a tick that
   *  hangs shows up as lag rather than hiding it. */
  lastRead(): { primary: number; secondary: number } {
    return { primary: this.#lastRead[0], secondary: this.#lastRead[1] };
  }

  /** One poll. Overlapping calls are dropped, so a slow provider never piles up requests. */
  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      const reads = await Promise.allSettled([this.#reads.counter(this.#reads.primary, this.dao, 'optimistic'), this.#reads.counter(this.#reads.secondary, this.dao, 'optimistic')]);
      const at = this.#o.now();
      let seen = 0;
      let odd = false;
      reads.forEach((r, i) => {
        // An answer that is no counter is still an answer: the provider is not lagging.
        if (r.status === 'fulfilled') seen = Math.max(seen, r.value);
        else if (r.reason instanceof ImplausibleCounter) odd = true;
        else return;
        this.#lastRead[i] = at;
      });
      const row = this.#store.dao(this.#o.network, this.dao);
      if (!row) return;
      if (seen > row.next_id || odd || this.#implausible || this.#holdSince !== null) await this.#settle(row.next_id);
    } finally {
      this.#ticking = false;
    }
  }

  async #settle(nextId: number): Promise<void> {
    const { a, b, implausible } = await this.#reads.finalCounters(this.dao);
    const now = this.#o.now();
    if (implausible) {
      this.#refuse({ why: 'not a whole number below 2^53' });
      return;
    }
    if (a === null || b === null) {
      this.#hold(now, 'provider_unavailable', { primary_final: a, secondary_final: b });
      return;
    }
    const agreed = Math.min(a, b);
    if (agreed - nextId > MAX_COUNTER_JUMP) {
      this.#refuse({ why: 'further past the last id taken up than any treasury could be', primary_final: a, secondary_final: b, next_id: nextId });
      return;
    }
    if (this.#implausible) {
      this.#implausible = false;
      this.#health.clear('counter_implausible', this.dao);
    }
    if (agreed > nextId) {
      const count = agreed - nextId;
      if (count > 1) {
        this.#log.warn('counter_gap', { dao: this.dao, from_id: nextId, to_id: agreed - 1, count });
        this.#health.notice('counter_gap', this.dao, { from_id: nextId, to_id: agreed - 1, count });
      }
      // Never a loop over more ids than one pass takes up, whatever the counter says.
      const from = Math.max(nextId, agreed - MAX_IDS_PER_PASS);
      if (from > nextId) {
        const skipped = { from_id: nextId, to_id: from - 1, count: from - nextId };
        this.#log.warn('proposals_skipped', { dao: this.dao, ...skipped });
        this.#health.raise('proposals_skipped', this.dao, skipped);
      }
      for (let id = from; id < agreed; id++) {
        if (this.#store.queueNew(this.#o.network, this.dao, id, count > 1 ? 'backfill' : 'new')) {
          this.#log.info('proposal_seen', { dao: this.dao, proposal_id: id, final_on_both: true });
        }
        this.#enqueue(id);
      }
      this.#store.advance(this.#o.network, this.dao, agreed);
    }
    if (a !== b) {
      this.#hold(now, 'providers_disagree', { primary_final: a, secondary_final: b, held_from_id: agreed });
      return;
    }
    if (this.#holdSince !== null) {
      this.#holdSince = null;
      this.#health.clear('providers_disagree', this.dao);
      this.#health.clear('provider_unavailable', this.dao);
    }
  }

  /** A counter no treasury could have: nothing is queued and the next id stays where it is, so
   *  a counter that reads as a DAO's again is taken up from there. */
  #refuse(fields: Record<string, unknown>): void {
    this.#implausible = true;
    this.#log.warn('counter_implausible', { dao: this.dao, ...fields });
    this.#health.raise('counter_implausible', this.dao, fields);
  }

  #hold(now: number, signal: 'providers_disagree' | 'provider_unavailable', fields: Record<string, unknown>): void {
    this.#holdSince ??= now;
    this.#log.debug('counter_held', { dao: this.dao, ...fields });
    if (now - this.#holdSince >= this.#o.holdAlertMs) this.#health.raise(signal, this.dao, { ...fields, held_ms: now - this.#holdSince });
  }
}
