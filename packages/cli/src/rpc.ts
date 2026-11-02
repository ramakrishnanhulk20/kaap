// NEAR JSON-RPC through one fixed provider. Answers are checked against the shape the CLI uses and
// anything else is a failed read (standard 4). Upstream text never reaches the user beyond a short
// run of printable characters, because a contract's panic message is written by whoever deployed
// it.

import { MAX_RETRY_WAIT_MS, MAX_VIEW_BODY_BYTES, RPC_TIMEOUT_MS, RPC_TRIES } from './caps.js';
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
}

export const NETWORKS: Readonly<Record<Network, NetworkConfig>> = {
  mainnet: { primary: 'https://near.drpc.org', secondary: 'https://rpc.mainnet.fastnear.com', factory: 'sputnik-dao.near' },
  testnet: { primary: 'https://near-testnet.drpc.org', secondary: 'https://rpc.testnet.fastnear.com', factory: 'sputnikv2.testnet' },
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
 *  ERR_NO_PROPOSAL. `missing_account`: no account by that name at that block. */
export type RpcFailure = 'unavailable' | 'shape' | 'too_large' | 'refused' | 'no_proposal' | 'missing_account';

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
   *  `RPC_TRIES` times; an answer the CLI cannot read, or an error the contract gave, is not. */
  async call(method: 'block' | 'query', params: Record<string, unknown>, maxBytes = MAX_VIEW_BODY_BYTES): Promise<Record<string, unknown>> {
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
          return this.#answer(response.status, response.text);
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

  #answer(status: number, text: string): Record<string, unknown> {
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
    const r = await this.call('block', at === 'final' ? { finality: 'final' } : { block_id: at });
    const header = r['header'];
    if (!isRecord(header)) throw new RpcError(this.name, 'shape', 'the block has no header');
    const { height, hash, timestamp_nanosec: ns, timestamp } = header;
    const timestampNs = typeof ns === 'string' && /^\d{1,20}$/.test(ns) ? ns : typeof timestamp === 'number' && Number.isSafeInteger(timestamp) ? String(timestamp) : null;
    if (!Number.isSafeInteger(height) || typeof hash !== 'string' || timestampNs === null) throw new RpcError(this.name, 'shape', 'the block header is not readable');
    return { height: height as number, hash, timestampNs };
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
