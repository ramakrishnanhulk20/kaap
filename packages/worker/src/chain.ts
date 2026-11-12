// The worker account on chain: its key, its nonces, and sending. The key is read once from the
// near-cli credentials file named in the settings, registered with the logger's redactor before
// anything else touches it, and held only inside a near-api-js signer.

import { readFileSync, statSync } from 'node:fs';

import { KeyPair, KeyPairSigner, actions, baseDecode, baseEncode, createTransaction, type KeyPairString } from 'near-api-js';
import { z } from 'zod';

import { addSecret, type Logger } from './log.ts';
import { isFinal, type TxOutcome } from './outcome.ts';
import { RpcClient, RpcError } from './rpc.ts';

export interface Signed {
  hash: string;
  signedB64: string;
  nonce: bigint;
}

export type Broadcast =
  | { kind: 'included' }
  /** The send timed out or the provider failed: the transaction may still land. */
  | { kind: 'unknown'; detail: string }
  /** The receiver's shard is congested or stuck. The node turned the bytes away before checking
   *  their key, nonce or balance, so the same bytes may still land once it is quieter. */
  | { kind: 'retry'; detail: string }
  /** The chain refused it outright (bad nonce, expired block hash): it can never land. */
  | { kind: 'rejected'; detail: string };

/** The two INVALID_TRANSACTION reasons NEAR's docs (28 Oct 2026) say to answer by waiting and
 *  sending the same signed bytes again. Every other reason stays a refusal, so a reason this
 *  set does not know falls back to signing again, which is what the worker did before. */
const SHARD_BUSY = new Set(['ShardCongested', 'ShardStuck']);

/** What the worker needs from the chain to send. The live one is `NearChain`; tests use a fake. */
export interface Chain {
  readonly accountId: string;
  sign(receiverId: string, method: string, args: object, gas: bigint, deposit: bigint): Promise<Signed>;
  broadcast(signedB64: string): Promise<Broadcast>;
  /** The final outcome, or null while it is not final or not yet known to the provider. */
  outcome(hash: string): Promise<TxOutcome | null>;
  /** The final head's height. */
  head(): Promise<number>;
  /** Forget the local nonce, so the next signing reads it from the chain again. */
  resetNonce(): void;
}

export class CredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialsError';
  }
}

// near-cli-rs writes no account_id and keeps the seed phrase next to the key. Without an
// account_id, ownership is proven at boot by `checkKey`, which finds the key on the account itself.
const credentialsFile = z.object({ account_id: z.string().optional(), public_key: z.string(), private_key: z.string(), master_seed_phrase: z.string().optional() });

/** Loads the key for `accountId` from a near-cli credentials file. Every failure is a fixed
 *  message naming the file, never its content. Warns when other users can read the file. */
export function loadKey(path: string, accountId: string, log: Logger): KeyPair {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new CredentialsError(`cannot read the worker credentials file ${path}`);
  }
  let saved: z.output<typeof credentialsFile>;
  try {
    saved = credentialsFile.parse(JSON.parse(raw));
  } catch {
    throw new CredentialsError(`${path} is not a near-cli credentials file ({public_key, private_key})`);
  }
  if (saved.private_key.length >= 16) {
    addSecret(saved.private_key);
    const body = saved.private_key.split(':')[1];
    if (body && body.length >= 16) addSecret(body);
  }
  if (saved.master_seed_phrase && saved.master_seed_phrase.length >= 16) addSecret(saved.master_seed_phrase);
  if (saved.account_id !== undefined && saved.account_id !== accountId) throw new CredentialsError(`${path} holds the key of another account, not ${accountId}`);
  let keyPair: KeyPair;
  try {
    keyPair = KeyPair.fromString(saved.private_key as KeyPairString);
  } catch {
    throw new CredentialsError(`${path} does not hold a readable key pair`);
  }
  if (keyPair.getPublicKey().toString() !== saved.public_key) throw new CredentialsError(`${path}: its private key does not match its public key`);
  if ((statSync(path).mode & 0o077) !== 0) log.warn('credentials_file_readable_by_others', { path, fix: `chmod 600 ${path}` });
  return keyPair;
}

/** Sends through one provider. Signing and sending are separate jobs on one serial queue, so no
 *  two signings ever hand out the same nonce, but a signing can run before the transaction signed
 *  just before it has been sent: one signed later can reach a block first. The chain then refuses
 *  the earlier one as a stale nonce, and the Submitter's re-sign path signs it again once under a
 *  fresh nonce, so it still lands. */
export class NearChain implements Chain {
  readonly accountId: string;
  readonly #signer: KeyPairSigner;
  readonly #publicKey: string;
  readonly #rpc: RpcClient;
  #nonce: bigint | null = null;
  #lock: Promise<unknown> = Promise.resolve();

  constructor(accountId: string, keyPair: KeyPair, rpc: RpcClient) {
    this.accountId = accountId;
    this.#signer = new KeyPairSigner(keyPair);
    this.#publicKey = keyPair.getPublicKey().toString();
    this.#rpc = rpc;
  }

  /** Confirms the key is a full-access key of the account on chain right now. */
  async checkKey(): Promise<void> {
    const ak = (await this.#rpc.call('query', { request_type: 'view_access_key', finality: 'final', account_id: this.accountId, public_key: this.#publicKey })) as { permission?: unknown };
    if (ak?.permission !== 'FullAccess') throw new CredentialsError(`the key in the credentials file is not a full-access key of ${this.accountId}`);
  }

  resetNonce(): void {
    this.#nonce = null;
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#lock.then(work, work);
    this.#lock = next.catch(() => undefined);
    return next;
  }

  sign(receiverId: string, method: string, args: object, gas: bigint, deposit: bigint): Promise<Signed> {
    return this.#serial(async () => {
      if (this.#nonce === null) {
        // Optimistic, so a transaction just included but not yet final is already counted.
        const ak = (await this.#rpc.call('query', { request_type: 'view_access_key', finality: 'optimistic', account_id: this.accountId, public_key: this.#publicKey })) as { nonce?: unknown };
        if (typeof ak?.nonce !== 'number' && typeof ak?.nonce !== 'string') throw new RpcError(this.#rpc.name, 'shape', 'view_access_key has no nonce');
        this.#nonce = BigInt(ak.nonce);
      }
      const block = await this.#rpc.block({ finality: 'final' });
      const nonce = this.#nonce + 1n;
      const tx = createTransaction(this.accountId, (await this.#signer.getPublicKey()), receiverId, nonce, [actions.functionCall(method, args, gas, deposit)], baseDecode(block.hash));
      const { txHash, signedTransaction } = await this.#signer.signTransaction(tx);
      this.#nonce = nonce;
      return { hash: baseEncode(txHash), signedB64: Buffer.from(signedTransaction.encode()).toString('base64'), nonce };
    });
  }

  broadcast(signedB64: string): Promise<Broadcast> {
    return this.#serial(async () => {
      try {
        await this.#rpc.sendTx(signedB64, 'INCLUDED');
        return { kind: 'included' } as const;
      } catch (e) {
        if (e instanceof RpcError && e.failure === 'rpc' && e.cause_name === 'INVALID_TRANSACTION') {
          // A busy shard never looked at the nonce, so the local count still holds.
          if (e.reason !== undefined && SHARD_BUSY.has(e.reason)) return { kind: 'retry', detail: e.message } as const;
          this.#nonce = null;
          return { kind: 'rejected', detail: e.message } as const;
        }
        return { kind: 'unknown', detail: e instanceof Error ? e.message : String(e) } as const;
      }
    });
  }

  async outcome(hash: string): Promise<TxOutcome | null> {
    try {
      const o = await this.#rpc.txStatus(hash, this.accountId);
      return isFinal(o) ? o : null;
    } catch {
      return null;
    }
  }

  async head(): Promise<number> {
    return (await this.#rpc.block({ finality: 'final' })).height;
  }
}
