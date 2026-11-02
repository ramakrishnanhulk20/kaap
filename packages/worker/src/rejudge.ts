// Re-judging (C4). A verdict is tied to the state it was computed on, so when that state moves
// while a proposal is open, every open verdict of the DAO is recomputed before the guard may act:
//   - a policy change (compared through kaap-core's canonical_policy, so Sputnik listing the same
//     sets in another order is not a change);
//   - a code-hash change on any contract an open proposal calls, the DAO itself included;
//   - an open proposal moving to Failed (Sputnik can run a Failed proposal again).
// The last values seen are kept in the store, so a change made while the worker was down is still
// caught on the next pass. On a DAO's first pass the open verdicts' own pins stand in for them.
//
// The same pass is where the worker sees a tracked proposal close, so it also settles the signals
// a held or refused action raised for it (C18: a signal clears once its cause is gone).

import { clearClosed } from './act.ts';
import type { Bridge } from './bridge.ts';
import type { Health } from './health.ts';
import type { Logger } from './log.ts';
import type { Reads } from './reads.ts';
import type { Store } from './store.ts';

export type Trigger = 'policy' | 'code' | 'failed';

export class RejudgeWatch {
  readonly #reads: Reads;
  readonly #store: Store;
  readonly #bridge: Bridge;
  readonly #health: Health;
  readonly #log: Logger;
  readonly #network: string;
  readonly #enqueue: (dao: string, id: number) => void;
  readonly #busy = new Set<string>();

  constructor(deps: { reads: Reads; store: Store; bridge: Bridge; health: Health; log: Logger; enqueue: (dao: string, id: number) => void }, network: string) {
    this.#reads = deps.reads;
    this.#store = deps.store;
    this.#bridge = deps.bridge;
    this.#health = deps.health;
    this.#log = deps.log;
    this.#enqueue = deps.enqueue;
    this.#network = network;
  }

  /** One pass over `dao`. Returns the triggers that fired, for the log and the tests. */
  async pass(dao: string): Promise<Trigger[]> {
    if (this.#busy.has(dao)) return [];
    this.#busy.add(dao);
    try {
      return await this.#pass(dao);
    } finally {
      this.#busy.delete(dao);
    }
  }

  async #pass(dao: string): Promise<Trigger[]> {
    const tracked = this.#store.open(this.#network, dao);
    const row = this.#store.dao(this.#network, dao);
    if (tracked.length === 0 || !row) return [];
    const live = await this.#reads.watchState(dao, tracked.map((t) => t.proposal_id));
    if (live.kind !== 'live') {
      this.#log.warn('rejudge_watch_held', { dao, problem: live });
      if (live.kind === 'disagree') this.#health.raise('providers_disagree', dao, { item: live.item });
      return [];
    }

    const fired = new Set<Trigger>();
    const firstPass = row.policy_hash === null;
    if (firstPass) {
      if (tracked.some((t) => t.policy_hash !== null && t.policy_hash !== live.policyHash)) fired.add('policy');
    } else if (row.policy_hash !== live.policyHash) {
      fired.add('policy');
    }
    this.#store.setPolicyHash(this.#network, dao, live.policyHash);

    const known = this.#store.codeHashes(this.#network, dao);
    for (const [account, codeHash] of live.codeHashes) {
      const before = known.get(account);
      if (before !== undefined && before !== codeHash) fired.add('code');
      if (before !== codeHash) this.#store.setCodeHash(this.#network, dao, account, codeHash);
    }

    const statuses = new Map(live.proposals.map((p) => [p.id, p]));
    const asked = new Set(live.asked);
    let closed = false;
    for (const t of tracked) {
      const p = statuses.get(t.proposal_id);
      if (!p) {
        // Both providers agree, at one block, that a proposal they were asked for is gone. Only
        // a removal deletes one, so it is recorded as Removed and is never read again.
        if (asked.has(t.proposal_id)) {
          this.#store.setProposalStatus(this.#network, dao, t.proposal_id, 'Removed');
          this.#log.info('proposal_gone', { dao, proposal_id: t.proposal_id, why: 'neither provider returns it: Sputnik deletes a removed proposal' });
          closed = true;
        }
        continue;
      }
      if (p.status !== 'InProgress') closed = true;
      if (firstPass && p.status === 'InProgress' && t.receivers_hash !== null) {
        let accounts: string[] = [];
        try {
          accounts = this.#bridge.calledAccounts(dao, p.kind);
        } catch {
          accounts = [];
        }
        const pairs = accounts.map((a): [string, string] => [a, live.codeHashes.get(a) ?? '']);
        if (pairs.every(([, h]) => h !== '') && this.#bridge.receiversHash(pairs) !== t.receivers_hash) fired.add('code');
      }
      if (p.status === 'Failed' && t.proposal_status !== 'Failed') fired.add('failed');
      if (p.status !== t.proposal_status) this.#store.setProposalStatus(this.#network, dao, t.proposal_id, p.status);
    }
    if (closed) clearClosed(this.#store, this.#health, this.#network, dao);

    if (fired.size === 0) return [];
    const why = [...fired].sort();
    const open = live.proposals.filter((p) => p.status === 'InProgress').map((p) => p.id);
    this.#log.warn('rejudge', { dao, triggers: why, proposals: open, at_block: live.height });
    for (const id of open) {
      if (!this.#store.judged(this.#network, dao, id)) continue;
      this.#store.queueAgain(this.#network, dao, id, `rejudge:${why.join('+')}`);
      this.#enqueue(dao, id);
    }
    return why;
  }
}
