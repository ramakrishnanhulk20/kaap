// Sending one transaction under an idempotency key (6e: retries never double-submit).
//
// The first call signs the transaction and writes its signed bytes to the spend table before
// anything is sent. Every later call with the same key, a retry in this process or after a
// restart, re-sends exactly those bytes, which the chain accepts at most once because they carry
// one nonce. The transaction is signed again only after the chain refused it outright (a stale
// nonce or block hash), which means it can never land, and at most once per call. A busy shard
// (ShardCongested, ShardStuck) is not such a refusal: the same bytes are sent again, on this call
// and on every later pass, until they land or the chain calls their block hash Expired, which
// then takes the re-sign path like any other refusal.

import type { Chain } from './chain.ts';
import type { Logger } from './log.ts';
import { formatNear } from './near.ts';
import { burnt, refusal, type TxOutcome } from './outcome.ts';
import type { SpendKind, SpendRow, Store } from './store.ts';

export interface SubmitRequest {
  key: string;
  kind: SpendKind;
  dao: string;
  proposalId: number;
  receiver: string;
  method: string;
  args: object;
  gas: bigint;
  deposit: bigint;
  /** The most this can cost, what the caps reserved for it. */
  reserved: bigint;
  /** Stop waiting once the final head is this many blocks past the send. */
  windowBlocks: number;
  /** The part of the deposit the receiver keeps, read from the outcome. */
  kept: (outcome: TxOutcome) => bigint;
}

export type SubmitResult =
  | { kind: 'final'; hash: string; outcome: TxOutcome }
  | { kind: 'no_outcome'; hash: string }
  | { kind: 'not_sent'; detail: string };

export interface SubmitOptions {
  pollMs: number;
  sendTries: number;
  sleep: (ms: number) => Promise<void>;
  explorer: (hash: string) => string;
}

export class Submitter {
  readonly #store: Store;
  readonly #chain: Chain;
  readonly #network: string;
  readonly #log: Logger;
  readonly #o: SubmitOptions;

  constructor(store: Store, chain: Chain, network: string, log: Logger, options: SubmitOptions) {
    this.#store = store;
    this.#chain = chain;
    this.#network = network;
    this.#log = log;
    this.#o = options;
  }

  async #sign(req: SubmitRequest): Promise<{ hash: string; signedB64: string; nonce: string }> {
    const s = await this.#chain.sign(req.receiver, req.method, req.args, req.gas, req.deposit);
    return { hash: s.hash, signedB64: s.signedB64, nonce: s.nonce.toString() };
  }

  #final(req: SubmitRequest, row: SpendRow, outcome: TxOutcome): SubmitResult {
    if (row.state !== 'final') {
      const why = refusal(outcome);
      const gas = burnt(outcome);
      const kept = why ? 0n : req.kept(outcome);
      this.#store.markFinal(req.key, why ? 'failed' : 'ok', gas + kept, why);
      const fields = { kind: req.kind, dao: req.dao, proposal_id: req.proposalId, tx: row.tx_hash, link: this.#o.explorer(row.tx_hash), gas_near: formatNear(gas), kept_near: formatNear(kept), total_near: formatNear(gas + kept) };
      if (why) this.#log.warn('tx_refused', { ...fields, refusal: why });
      else this.#log.info('tx_final', fields);
    }
    return { kind: 'final', hash: row.tx_hash, outcome };
  }

  async submit(req: SubmitRequest): Promise<SubmitResult> {
    let row = this.#store.spend(req.key);
    if (!row || row.state === 'rejected') {
      const s = await this.#sign(req);
      if (row) this.#store.resign(req.key, s.hash, s.signedB64, s.nonce);
      else this.#store.addSpend({ idempotency_key: req.key, kind: req.kind, network: this.#network, dao: req.dao, proposal_id: req.proposalId, tx_hash: s.hash, signed_b64: s.signedB64, nonce: s.nonce, reserved_yocto: req.reserved.toString() });
      row = this.#store.spend(req.key)!;
      this.#log.info('tx_signed', { kind: req.kind, key: req.key, dao: req.dao, proposal_id: req.proposalId, tx: row.tx_hash, to: `${req.receiver}.${req.method}`, reserved_near: formatNear(req.reserved) });
    } else {
      this.#log.info('tx_resumed', { kind: req.kind, key: req.key, tx: row.tx_hash, state: row.state });
      const known = await this.#chain.outcome(row.tx_hash);
      if (known) return this.#final(req, row, known);
      // A transaction that was final once is never sent again, even if its outcome is gone.
      if (row.state === 'final') return { kind: 'no_outcome', hash: row.tx_hash };
    }

    let resigned = false;
    let taken = false;
    for (let attempt = 1; attempt <= this.#o.sendTries; attempt++) {
      const sent = await this.#chain.broadcast(row.signed_b64);
      if (sent.kind === 'included') {
        taken = true;
        break;
      }
      if (sent.kind === 'retry') {
        this.#log.warn('tx_shard_busy', { kind: req.kind, key: req.key, tx: row.tx_hash, attempt, detail: sent.detail });
        await this.#o.sleep(this.#o.pollMs * attempt);
        continue;
      }
      if (sent.kind === 'rejected') {
        // A send of bytes that already landed can be refused too; only an unknown hash is re-signed.
        const landed = await this.#chain.outcome(row.tx_hash);
        if (landed) return this.#final(req, row, landed);
        if (resigned) {
          this.#store.markRejected(req.key, 'rejected twice by the chain');
          this.#log.error('tx_not_sent', { kind: req.kind, key: req.key, tx: row.tx_hash, detail: sent.detail });
          return { kind: 'not_sent', detail: sent.detail };
        }
        const s = await this.#sign(req);
        this.#store.resign(req.key, s.hash, s.signedB64, s.nonce);
        this.#log.warn('tx_resigned', { kind: req.kind, key: req.key, old_tx: row.tx_hash, tx: s.hash, why: sent.detail });
        row = this.#store.spend(req.key)!;
        resigned = true;
        attempt--;
        continue;
      }
      // The send may have reached the chain even though the answer did not reach us.
      taken = true;
      const landed = await this.#chain.outcome(row.tx_hash);
      if (landed) return this.#final(req, row, landed);
      this.#log.warn('tx_send_retry', { kind: req.kind, key: req.key, tx: row.tx_hash, attempt, detail: sent.detail });
      await this.#o.sleep(this.#o.pollMs * attempt);
    }

    if (!taken) {
      // Every send was turned away by a busy shard, so no node holds these bytes and waiting out
      // the window for their outcome would only delay the alert. They stay stored unsent, and the
      // caller's next pass sends them again.
      this.#log.warn('tx_not_taken', { kind: req.kind, key: req.key, tx: row.tx_hash, why: 'the receiver shard stayed busy' });
      return { kind: 'no_outcome', hash: row.tx_hash };
    }

    const sentAt = await this.#chain.head().catch(() => null);
    this.#store.markSent(req.key, sentAt);
    row = this.#store.spend(req.key)!;
    this.#log.info('tx_sent', { kind: req.kind, dao: req.dao, proposal_id: req.proposalId, tx: row.tx_hash, link: this.#o.explorer(row.tx_hash) });

    let from = row.include_height ?? sentAt;
    for (;;) {
      const outcome = await this.#chain.outcome(row.tx_hash);
      if (outcome) return this.#final(req, row, outcome);
      const head = await this.#chain.head().catch(() => null);
      from ??= head;
      if (head !== null && from !== null && head > from + req.windowBlocks) {
        this.#log.warn('tx_no_outcome', { kind: req.kind, key: req.key, tx: row.tx_hash, sent_at_block: from, head, window_blocks: req.windowBlocks });
        return { kind: 'no_outcome', hash: row.tx_hash };
      }
      await this.#o.sleep(this.#o.pollMs);
    }
  }
}
