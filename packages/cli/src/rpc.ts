// NEAR JSON-RPC through one fixed provider. Answers are checked against the shape the CLI uses and
// anything else is a failed read (standard 4). Upstream text never reaches the user beyond a short
// run of printable characters, because a contract's panic message is written by whoever deployed
// it.

import { MAX_PAGE_BODY_BYTES, MAX_RETRY_WAIT_MS, MAX_VIEW_BODY_BYTES, RPC_TIMEOUT_MS, RPC_TRIES } from './caps.js';
import type { Clock } from './limiter.js';
import type { RateLimiter } from './limiter.js';
import { NetError, type Transport } from './net.js';

export type Network = 'mainnet' | 'testnet';

export interface NetworkConfig {
  /** Two independent providers, read at the same block and compared (C22). */
  primary: string;
  secondary: string;
  /** The Sputnik factory, whose `get_contracts_metadata` lists the code hashes it deploys. */
  factory: string;
  /** A node that keeps old blocks and transactions, which `kaap verify` needs for a verdict's own
   *  block and its sealed run. The two providers above drop state after a few days. There is one
   *  free archival provider, so these reads are never compared with a second one. */
  archival: string;
  /** OutLayer's public API, which serves the attestation of each sealed run. */
  outlayer: string;
}

export const NETWORKS: Readonly<Record<Network, NetworkConfig>> = {
  mainnet: {
    primary: 'https://near.drpc.org',
    secondary: 'https://rpc.mainnet.fastnear.com',
    factory: 'sputnik-dao.near',
    archival: 'https://archival-rpc.mainnet.fastnear.com',
    outlayer: 'https://api.outlayer.ai',
  },
  testnet: {
    primary: 'https://near-testnet.drpc.org',
    secondary: 'https://rpc.testnet.fastnear.com',
    factory: 'sputnikv2.testnet',
    archival: 'https://archival-rpc.testnet.fastnear.com',
    outlayer: 'https://testnet-api.outlayer.ai',
  },
};

export type At = 'final' | number;

export interface Block {
  height: number;
  hash: string;
  /** Nanoseconds since 1970, as the decimal string NEAR writes. */
  timestampNs: string;
}

export interface View {
  text: string;
  blockHeight: number;
  blockHash: string;
}

/** A chunk that carries new transactions in the block it was read from. */
export interface ChunkHeader {
  hash: string;
}

/** The transaction root of a chunk with no transactions: 32 zero bytes in base58. */
const EMPTY_ROOT = '11111111111111111111111111111111';

export interface AccountState {
  codeHash: string;
  globalContractHash: string | null;
  globalContractAccount: string | null;
  /** Liquid balance in yoctoNEAR. */
  amount: bigint;
  blockHeight: number;
  blockHash: string;
}

/** `refused`: the contract ran and panicked, or has no such method. `no_proposal`: Sputnik's
 *  ERR_NO_PROPOSAL. `missing_account`: no account by that name at that block. `missing`: no block
 *  at that height, or no such chunk or transaction, from a call that asked to hear it at once. */
export type RpcFailure = 'unavailable' | 'shape' | 'too_large' | 'refused' | 'no_proposal' | 'missing_account' | 'missing';

/** What NEAR answers for a height no block was produced at, and for an unknown chunk or
 *  transaction. */
const MISSING_CAUSES: ReadonlySet<unknown> = new Set(['UNKNOWN_BLOCK', 'UNKNOWN_CHUNK', 'UNKNOWN_TRANSACTION']);

export class RpcError extends Error {
  readonly failure: RpcFailure;
  readonly provider: string;
  constructor(provider: string, failure: RpcFailure, detail: string) {
    super(`${provider}: ${detail}`);
    this.name = 'RpcError';
    this.failure = failure;
    this.provider = provider;
  }
}

const clean = (text: unknown) => String(text ?? '').replace(/[^\x20-\x7e]/g, '?').slice(0, 160);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export class Provider {
  readonly name: string;
  readonly #url: string;
  readonly #transport: Transport;
  readonly #limiter: RateLimiter;
  readonly #clock: Clock;
  /** Requests sent, retries included. */
  sent = 0;
  retried = 0;

  constructor(url: string, transport: Transport, limiter: RateLimiter, clock: Clock) {
    this.#url = url;
    this.name = new URL(url).host;
    this.#transport = transport;
    this.#limiter = limiter;
    this.#clock = clock;
  }

  /** One JSON-RPC call. Refusals, timeouts and provider-side errors are asked again up to
   *  `RPC_TRIES` times; an answer the CLI cannot read, or an error the contract gave, is not.
   *  With `missingIsFinal`, a missing block, chunk or transaction is a `missing` failure at once:
   *  an archival node that lacks one will not grow it, while a live node that is a block behind
   *  will, which is why `check` keeps asking. */
  async call(method: 'block' | 'query' | 'chunk' | 'tx', params: Record<string, unknown>, maxBytes = MAX_VIEW_BODY_BYTES, missingIsFinal = false): Promise<Record<string, unknown>> {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 'kaap', method, params });
    let last: RpcError = new RpcError(this.name, 'unavailable', 'no answer');
    for (let attempt = 1; attempt <= RPC_TRIES; attempt++) {
      if (attempt > 1) this.retried++;
      await this.#limiter.slot();
      this.sent++;
      let waitMs = 1000 * 2 ** (attempt - 1);
      try {
        const response = await this.#transport({ url: this.#url, method: 'POST', body, timeoutMs: RPC_TIMEOUT_MS, maxBytes });
        if (response.status === 429 || response.status === 503) {
          last = new RpcError(this.name, 'unavailable', `HTTP ${response.status}`);
          if (response.retryAfterMs !== undefined) waitMs = Math.min(response.retryAfterMs, MAX_RETRY_WAIT_MS);
        } else {
          return this.#answer(response.status, response.text, missingIsFinal);
        }
      } catch (e) {
        if (e instanceof RpcError && e.failure !== 'unavailable') throw e;
        if (e instanceof NetError && e.failure === 'too_large') throw new RpcError(this.name, 'too_large', e.message);
        last = e instanceof RpcError ? e : new RpcError(this.name, 'unavailable', e instanceof Error ? clean(e.message) : 'request failed');
      }
      if (attempt < RPC_TRIES) await this.#clock.sleep(waitMs);
    }
    throw last;
  }

  #answer(status: number, text: string, missingIsFinal: boolean): Record<string, unknown> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new RpcError(this.name, status === 200 ? 'shape' : 'unavailable', `HTTP ${status}, not JSON`);
    }
    if (!isRecord(parsed)) throw new RpcError(this.name, 'shape', 'the answer is not a JSON object');
    const error = parsed['error'];
    if (error !== undefined) {
      const cause = isRecord(error) && isRecord(error['cause']) ? error['cause']['name'] : undefined;
      if (cause === 'UNKNOWN_ACCOUNT') throw new RpcError(this.name, 'missing_account', 'no such account');
      if (missingIsFinal && MISSING_CAUSES.has(cause)) throw new RpcError(this.name, 'missing', clean(cause));
      // Both providers report a contract panic inside `result` today; newer nodes may send it as
      // this error instead, and it is the contract's answer, not a fault to ask again about.
      if (cause === 'CONTRACT_EXECUTION_ERROR') {
        throw new RpcError(this.name, JSON.stringify(error).includes('ERR_NO_PROPOSAL') ? 'no_proposal' : 'refused', 'the contract refused the view');
      }
      throw new RpcError(this.name, 'unavailable', clean(cause ?? (isRecord(error) ? error['name'] : error)));
    }
    const result = parsed['result'];
    if (status !== 200 || !isRecord(result)) throw new RpcError(this.name, status === 200 ? 'shape' : 'unavailable', `HTTP ${status}`);
    return result;
  }

  async block(at: At): Promise<Block> {
    return this.#header(await this.call('block', at === 'final' ? { finality: 'final' } : { block_id: at }));
  }

  #header(r: Record<string, unknown>): Block {
    const header = r['header'];
    if (!isRecord(header)) throw new RpcError(this.name, 'shape', 'the block has no header');
    const { height, hash, timestamp_nanosec: ns, timestamp } = header;
    const timestampNs = typeof ns === 'string' && /^\d{1,20}$/.test(ns) ? ns : typeof timestamp === 'number' && Number.isSafeInteger(timestamp) ? String(timestamp) : null;
    if (!Number.isSafeInteger(height) || typeof hash !== 'string' || timestampNs === null) throw new RpcError(this.name, 'shape', 'the block header is not readable');
    return { height: height as number, hash, timestampNs };
  }

  /** The block at `height` with the chunks it carries new transactions in, or null when no block
   *  was produced at that height. A chunk whose transaction root is the empty root holds none. */
  async blockChunks(height: number): Promise<{ block: Block; chunks: ChunkHeader[] } | null> {
    let r: Record<string, unknown>;
    try {
      r = await this.call('block', { block_id: height }, MAX_VIEW_BODY_BYTES, true);
    } catch (e) {
      if (e instanceof RpcError && e.failure === 'missing') return null;
      throw e;
    }
    const block = this.#header(r);
    const chunks = r['chunks'];
    if (!Array.isArray(chunks)) throw new RpcError(this.name, 'shape', 'the block lists no chunks');
    const out: ChunkHeader[] = [];
    for (const c of chunks) {
      if (!isRecord(c) || typeof c['chunk_hash'] !== 'string' || typeof c['tx_root'] !== 'string' || !Number.isSafeInteger(c['height_included'])) {
        throw new RpcError(this.name, 'shape', 'a chunk header is not readable');
      }
      if (c['height_included'] === block.height && c['tx_root'] !== EMPTY_ROOT) out.push({ hash: c['chunk_hash'] });
    }
    return { block, chunks: out };
  }

  /** The transactions of one chunk, as the node returns them. The caller reads each with its own
   *  schema. */
  async chunkTransactions(hash: string): Promise<unknown[]> {
    const r = await this.call('chunk', { chunk_id: hash }, MAX_PAGE_BODY_BYTES, true);
    const txs = r['transactions'];
    if (!Array.isArray(txs)) throw new RpcError(this.name, 'shape', 'the chunk lists no transactions');
    return txs;
  }

  /** A transaction's final outcome with every receipt, or null when the node does not know it. */
  async txStatus(hash: string, sender: string): Promise<Record<string, unknown> | null> {
    try {
      return await this.call('tx', { tx_hash: hash, sender_account_id: sender, wait_until: 'FINAL' }, MAX_PAGE_BODY_BYTES, true);
    } catch (e) {
      if (e instanceof RpcError && e.failure === 'missing') return null;
      throw e;
    }
  }

  /** A view call at a block. `args` is the exact JSON the contract receives. */
  async view(account: string, method: string, args: object, at: At, maxBytes = MAX_VIEW_BODY_BYTES): Promise<View> {
    const r = await this.call(
      'query',
      {
        request_type: 'call_function',
        ...(at === 'final' ? { finality: 'final' } : { block_id: at }),
        account_id: account,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
      },
      maxBytes,
    );
    if (r['error'] !== undefined) {
      const text = String(r['error']);
      throw new RpcError(this.name, text.includes('ERR_NO_PROPOSAL') ? 'no_proposal' : 'refused', `${method} failed: ${clean(text)}`);
    }
    const bytes = r['result'];
    if (!Array.isArray(bytes) || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b < 256)) throw new RpcError(this.name, 'shape', `${method} result is not bytes`);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes as number[]));
    } catch {
      throw new RpcError(this.name, 'shape', `${method} result is not UTF-8`);
    }
    return { text, ...pinned(r, this.name) };
  }

  async account(account: string, at: At): Promise<AccountState> {
    const r = await this.call('query', { request_type: 'view_account', ...(at === 'final' ? { finality: 'final' } : { block_id: at }), account_id: account });
    const { code_hash: codeHash, amount, global_contract_hash: global, global_contract_account_id: globalAccount } = r;
    if (typeof codeHash !== 'string' || typeof amount !== 'string' || !/^\d{1,40}$/.test(amount)) throw new RpcError(this.name, 'shape', 'view_account has no code_hash or amount');
    return {
      codeHash,
      globalContractHash: typeof global === 'string' ? global : null,
      globalContractAccount: typeof globalAccount === 'string' ? globalAccount : null,
      amount: BigInt(amount),
      ...pinned(r, this.name),
    };
  }
}

function pinned(r: Record<string, unknown>, provider: string): { blockHeight: number; blockHash: string } {
  const { block_height: height, block_hash: hash } = r;
  if (!Number.isSafeInteger(height) || typeof hash !== 'string') throw new RpcError(provider, 'shape', 'the answer names no block');
  return { blockHeight: height as number, blockHash: hash };
}
