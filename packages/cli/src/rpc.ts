// NEAR JSON-RPC. A `Provider` is one fixed host; an `Archive` asks a list of hosts in turn for the
// old blocks and transactions `kaap verify` reads. Answers are checked against the shape the CLI
// uses and anything else is a failed read (standard 4). Upstream text never reaches the user beyond
// a short run of printable characters, because a contract's panic message is written by whoever
// deployed it.

import { MAX_PAGE_BODY_BYTES, MAX_RETRY_WAIT_MS, MAX_VIEW_BODY_BYTES, RATE_LIMIT_REST_MS, RATE_LIMIT_WAITS_MS, RPC_TIMEOUT_MS, RPC_TRIES } from './caps.js';
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
  /** Nodes that keep old blocks and transactions, in the order `kaap verify` asks them once the two
   *  providers above no longer hold a verdict's own block or its sealed run (they drop state after
   *  a few days). Both are free and both rate-limit, so the second is a fallback, not a second
   *  opinion: these reads are never compared. NEAR's mainnet archive answered the final block and
   *  block 9,820,210 on 11 Nov, in about 4 s. */
  archives: readonly string[];
  /** OutLayer's public API, which serves the attestation of each sealed run. */
  outlayer: string;
}

export const NETWORKS: Readonly<Record<Network, NetworkConfig>> = {
  mainnet: {
    primary: 'https://near.drpc.org',
    secondary: 'https://rpc.mainnet.fastnear.com',
    factory: 'sputnik-dao.near',
    archives: ['https://archival-rpc.mainnet.fastnear.com', 'https://archival-rpc.mainnet.near.org'],
    outlayer: 'https://api.outlayer.ai',
  },
  testnet: {
    primary: 'https://near-testnet.drpc.org',
    secondary: 'https://rpc.testnet.fastnear.com',
    factory: 'sputnikv2.testnet',
    archives: ['https://archival-rpc.testnet.fastnear.com', 'https://archival-rpc.testnet.near.org'],
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

/** A code hash as NEAR writes it: base58 of 32 bytes, from 32 characters (all zero bytes, an
 *  account with no code) to 44. */
const CODE_HASH = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface AccountState {
  codeHash: string;
  globalContractHash: string | null;
  globalContractAccount: string | null;
  /** Liquid balance in yoctoNEAR. */
  amount: bigint;
  blockHeight: number;
  blockHash: string;
}

/** One access key of an account: its public key, and its permission as NEAR writes it, as JSON. */
export interface AccessKey {
  publicKey: string;
  permission: string;
}

/** `refused`: the contract ran and panicked, or has no such method. `no_proposal`: Sputnik's
 *  ERR_NO_PROPOSAL. `missing_account`: no account by that name at that block. `missing`: no block
 *  at that height, or no such chunk or transaction, from a call that asked to hear it at once.
 *  `dropped`: the node says it no longer keeps that block, from a call that asked the same. */
export type RpcFailure = 'unavailable' | 'shape' | 'too_large' | 'refused' | 'no_proposal' | 'missing_account' | 'missing' | 'dropped';

/** What NEAR answers for a height no block was produced at, and for an unknown chunk or
 *  transaction. A node that has dropped an old block answers the same for it (both testnet
 *  providers did on 11 Nov), so only an archival node's word on these is final. */
const MISSING_CAUSES: ReadonlySet<unknown> = new Set(['UNKNOWN_BLOCK', 'UNKNOWN_CHUNK', 'UNKNOWN_TRANSACTION']);

export type Method = 'block' | 'query' | 'chunk' | 'tx';

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
  readonly #url: string;
  readonly #host: string;
  readonly #transport: Transport;
  readonly #limiter: RateLimiter;
  readonly #clock: Clock;
  readonly #rateLimitWaits: readonly number[] | null;
  /** Requests sent, retries included. */
  sent = 0;
  retried = 0;
  /** When this host last answered HTTP 429, on the run's clock; null when it never has. */
  refusedAt: number | null = null;

  /** `rateLimitWaitsMs`, when given, replaces the waits after an HTTP 429 that carries no
   *  Retry-After: one wait per new try, and once they run out the call gives up on this host
   *  rather than spend its remaining tries, so a caller with another host can move on. */
  constructor(url: string, transport: Transport, limiter: RateLimiter, clock: Clock, rateLimitWaitsMs: readonly number[] | null = null) {
    this.#url = url;
    this.#host = new URL(url).host;
    this.#transport = transport;
    this.#limiter = limiter;
    this.#clock = clock;
    this.#rateLimitWaits = rateLimitWaitsMs;
  }

  get name(): string {
    return this.#host;
  }

  /** One JSON-RPC call. Refusals, timeouts and provider-side errors are asked again up to
   *  `RPC_TRIES` times; an answer the CLI cannot read, or an error the contract gave, is not.
   *  With `missingIsFinal`, a missing block, chunk or transaction is a `missing` failure at once:
   *  an archival node that lacks one will not grow it, while a live node that is a block behind
   *  will, which is why `check` keeps asking. A block the node says it has dropped is likewise a
   *  `dropped` failure at once. */
  async call(method: Method, params: Record<string, unknown>, maxBytes = MAX_VIEW_BODY_BYTES, missingIsFinal = false): Promise<Record<string, unknown>> {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 'kaap', method, params });
    let last: RpcError = new RpcError(this.name, 'unavailable', 'no answer');
    let refusals = 0;
    for (let attempt = 1; attempt <= RPC_TRIES; attempt++) {
      if (attempt > 1) this.retried++;
      await this.#limiter.slot();
      this.sent++;
      let waitMs = 1000 * 2 ** (attempt - 1);
      try {
        const response = await this.#transport({ url: this.#url, method: 'POST', body, timeoutMs: RPC_TIMEOUT_MS, maxBytes });
        if (response.status === 429 || response.status === 503) {
          last = new RpcError(this.name, 'unavailable', `HTTP ${response.status}`);
          if (response.status === 429) this.refusedAt = this.#clock.now();
          if (response.retryAfterMs !== undefined) waitMs = Math.min(response.retryAfterMs, MAX_RETRY_WAIT_MS);
          else if (response.status === 429 && this.#rateLimitWaits !== null) {
            const next = this.#rateLimitWaits[refusals++];
            if (next === undefined) break;
            waitMs = next;
          }
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
      if (missingIsFinal && cause === 'GARBAGE_COLLECTED_BLOCK') throw new RpcError(this.name, 'dropped', 'the node no longer keeps that block');
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

  /** The account's code and balance. Its code hashes are read only as base58 hashes, the shape every
   *  command that prints one relies on. */
  async account(account: string, at: At): Promise<AccountState> {
    const r = await this.call('query', { request_type: 'view_account', ...(at === 'final' ? { finality: 'final' } : { block_id: at }), account_id: account });
    const { code_hash: codeHash, amount, global_contract_hash: global, global_contract_account_id: globalAccount } = r;
    if (typeof codeHash !== 'string' || !CODE_HASH.test(codeHash) || typeof amount !== 'string' || !/^\d{1,40}$/.test(amount)) throw new RpcError(this.name, 'shape', 'view_account has no code_hash or amount');
    if (global !== undefined && global !== null && (typeof global !== 'string' || !CODE_HASH.test(global))) throw new RpcError(this.name, 'shape', 'view_account names a global contract hash that is not a hash');
    return {
      codeHash,
      globalContractHash: typeof global === 'string' ? global : null,
      globalContractAccount: typeof globalAccount === 'string' ? globalAccount : null,
      amount: BigInt(amount),
      ...pinned(r, this.name),
    };
  }

  /** Every access key of the account: anyone holding one can sign for it. */
  async accessKeys(account: string, at: At): Promise<{ keys: AccessKey[]; blockHeight: number; blockHash: string }> {
    const r = await this.call('query', { request_type: 'view_access_key_list', ...(at === 'final' ? { finality: 'final' } : { block_id: at }), account_id: account });
    const list = r['keys'];
    if (!Array.isArray(list)) throw new RpcError(this.name, 'shape', 'view_access_key_list has no keys');
    const keys: AccessKey[] = [];
    for (const k of list) {
      const access = isRecord(k) ? k['access_key'] : undefined;
      if (!isRecord(k) || typeof k['public_key'] !== 'string' || !isRecord(access)) throw new RpcError(this.name, 'shape', 'an access key is not readable');
      keys.push({ publicKey: k['public_key'], permission: JSON.stringify(access['permission'] ?? null) });
    }
    return { keys, ...pinned(r, this.name) };
  }
}

function pinned(r: Record<string, unknown>, provider: string): { blockHeight: number; blockHash: string } {
  const { block_height: height, block_hash: hash } = r;
  if (!Number.isSafeInteger(height) || typeof hash !== 'string') throw new RpcError(provider, 'shape', 'the answer names no block');
  return { blockHeight: height as number, blockHash: hash };
}

/** Where a host sits in an `Archive`'s list. `live`: one of the two providers, which drop old
 *  blocks after a few days, so anything one lacks is asked of the next host. `own`: the node named
 *  in KAAP_ARCHIVAL_RPC; what it lacks is asked of the public archives too, so a node for the other
 *  network, or one that is not archival, can cost a read but never fail a check. `archive`: a
 *  public archival node, whose word that a block, chunk or transaction does not exist is final. */
export type HostRole = 'live' | 'own' | 'archive';

export interface HostEntry {
  url: string;
  role: HostRole;
}

/** The hosts `kaap verify` reads a verdict's own block and its sealed runs from, in order: the two
 *  providers while they still hold them, KAAP_ARCHIVAL_RPC when set, then the network's archival
 *  nodes. */
export function archiveHosts(network: Network, own: string | null): HostEntry[] {
  const n = NETWORKS[network];
  const archives = n.archives.filter((url) => url !== own);
  return [
    { url: n.primary, role: 'live' },
    { url: n.secondary, role: 'live' },
    ...(own === null ? [] : [{ url: own, role: 'own' as const }]),
    ...archives.map((url) => ({ url, role: 'archive' as const })),
  ];
}

interface Host {
  provider: Provider;
  role: HostRole;
  /** The highest block a live provider lacked that a later host then answered for. It drops blocks
   *  from the oldest up, so it is not asked for that height or an older one again this run. Set
   *  only once another host proved the block exists, so a height no block was made at never sends
   *  later reads past it. */
  goneAt: number;
}

/** The answer a host gave, or the failure that is its final word. */
type Outcome = { host: string; result: Record<string, unknown> } | { host: string; error: RpcError };

/** One read asked of a list of hosts in turn. Each host gets the tries `Provider.call` gives it,
 *  with an HTTP 429 that carries no Retry-After waited out for 2 s, then 5 s, before the request
 *  moves on; it fails only when every host has failed. A host that answered 429 starts no request
 *  for `RATE_LIMIT_REST_MS` and is asked only after the others. Within one run the same request
 *  (method and params) is sent once and its outcome reused, except a failure every host gave. The
 *  reads stay single-node: which host answered is recorded, never compared. */
export class Archive extends Provider {
  readonly #hosts: Host[];
  readonly #clock: Clock;
  readonly #memo = new Map<string, Promise<Outcome>>();
  /** The height of every chunk in a block read by height, so the chunk is asked by that height. */
  readonly #chunkHeights = new Map<string, number>();
  #last: string;
  /** The host behind each read answered, in order, a reused one included. */
  readonly answered: string[] = [];

  constructor(hosts: readonly HostEntry[], transport: Transport, limiter: RateLimiter, clock: Clock) {
    const first = hosts[0];
    if (first === undefined) throw new RangeError('an archive needs at least one host');
    super(first.url, transport, limiter, clock);
    this.#hosts = hosts.map((h) => ({ provider: new Provider(h.url, transport, limiter, clock, RATE_LIMIT_WAITS_MS), role: h.role, goneAt: -1 }));
    this.#clock = clock;
    this.#last = new URL(first.url).host;
  }

  /** The host that gave the latest answer, so a reading error names the node that sent it. */
  override get name(): string {
    return this.#last;
  }

  /** The hosts that answered the reads made since `answered` had `mark` entries, joined for a
   *  line of output. */
  hostsSince(mark: number): string {
    return [...new Set(this.answered.slice(mark))].join(' and ');
  }

  override async call(method: Method, params: Record<string, unknown>, maxBytes = MAX_VIEW_BODY_BYTES): Promise<Record<string, unknown>> {
    const key = JSON.stringify({ method, params });
    let pending = this.#memo.get(key);
    if (pending === undefined) {
      pending = this.#ask(method, params, maxBytes);
      this.#memo.set(key, pending);
    }
    let outcome: Outcome;
    try {
      outcome = await pending;
    } catch (e) {
      if (this.#memo.get(key) === pending) this.#memo.delete(key);
      throw e;
    }
    this.#last = outcome.host;
    this.answered.push(outcome.host);
    if ('error' in outcome) throw outcome.error;
    return outcome.result;
  }

  /** The block height a request is pinned to, where its params say or a block read earlier did. */
  #heightOf(method: Method, params: Record<string, unknown>): number | null {
    if (method === 'chunk') return typeof params['chunk_id'] === 'string' ? (this.#chunkHeights.get(params['chunk_id']) ?? null) : null;
    const id = params['block_id'];
    return (method === 'block' || method === 'query') && Number.isSafeInteger(id) ? (id as number) : null;
  }

  #remember(method: Method, result: Record<string, unknown>): void {
    if (method !== 'block') return;
    const header = result['header'];
    const height = isRecord(header) ? header['height'] : undefined;
    const chunks = result['chunks'];
    if (!Number.isSafeInteger(height) || !Array.isArray(chunks)) return;
    for (const c of chunks) if (isRecord(c) && typeof c['chunk_hash'] === 'string') this.#chunkHeights.set(c['chunk_hash'], height as number);
  }

  async #ask(method: Method, params: Record<string, unknown>, maxBytes: number): Promise<Outcome> {
    const height = this.#heightOf(method, params);
    const now = this.#clock.now();
    const resting = (h: Host) => h.provider.refusedAt !== null && now - h.provider.refusedAt < RATE_LIMIT_REST_MS;
    const order = [...this.#hosts.filter((h) => !resting(h)), ...this.#hosts.filter(resting)];
    const lacked: Host[] = [];
    const failures: string[] = [];
    for (const host of order) {
      const name = host.provider.name;
      if (host.role === 'live' && height !== null && height <= host.goneAt) continue;
      // Asked to wait for finality, a live provider waits on a transaction it does not know (11 Nov:
      // drpc answered HTTP 408 after 2 s, fastnear after 10 s), so it is asked not to wait, and its
      // answer counts only once the transaction is final.
      const liveTx = host.role === 'live' && method === 'tx';
      let result: Record<string, unknown>;
      try {
        result = await host.provider.call(method, liveTx ? { ...params, wait_until: 'NONE' } : params, maxBytes, true);
      } catch (e) {
        if (!(e instanceof RpcError)) throw e;
        if (e.failure === 'missing' && host.role === 'archive') return { host: name, error: e };
        if (e.failure === 'missing' || e.failure === 'dropped') {
          if (host.role === 'live') lacked.push(host);
          failures.push(`${name} does not hold it`);
        } else if (e.failure === 'unavailable' || e.failure === 'shape' || e.failure === 'too_large') {
          failures.push(e.message);
        } else {
          return { host: name, error: e };
        }
        continue;
      }
      if (liveTx && result['final_execution_status'] !== 'FINAL') {
        failures.push(`${name} does not hold it as final yet`);
        continue;
      }
      if (height !== null) for (const h of lacked) h.goneAt = Math.max(h.goneAt, height);
      this.#remember(method, result);
      return { host: name, result };
    }
    throw new RpcError('no node answered', 'unavailable', failures.join('; '));
  }
}
