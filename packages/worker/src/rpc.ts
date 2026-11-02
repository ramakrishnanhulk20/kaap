// A small NEAR JSON-RPC client for one provider. Every call has a deadline and a cap on the
// answer's size (threat model standard 4), and an error carries only fixed text plus a short,
// cleaned excerpt of the provider's own message, never a whole answer.

/** A read at a finality, or at one block given by height or hash. */
export type At = { finality: 'optimistic' | 'final' } | { blockId: number | string };

export interface ViewResult {
  bytes: Uint8Array;
  text: string;
  blockHeight: number;
  blockHash: string;
}

export interface AccountView {
  codeHash: string;
  amount: bigint;
  storageUsage: number;
  blockHeight: number;
  blockHash: string;
}

export interface BlockView {
  height: number;
  hash: string;
  timestampMs: number;
}

/** What the worker reads from a provider. Tests give the worker fakes of this. */
export interface ViewProvider {
  readonly name: string;
  callFunction(account: string, method: string, args: object, at: At): Promise<ViewResult>;
  viewAccount(account: string, at: At): Promise<AccountView>;
  block(at: At): Promise<BlockView>;
}

/** What the worker sends and polls through its primary provider. */
export interface TxProvider {
  sendTx(signedB64: string, waitUntil: 'INCLUDED' | 'NONE'): Promise<unknown>;
  txStatus(hash: string, sender: string): Promise<unknown>;
}

export type RpcFailure = 'http' | 'timeout' | 'too_large' | 'not_json' | 'rpc' | 'shape';

export class RpcError extends Error {
  readonly provider: string;
  readonly failure: RpcFailure;
  /** NEAR's error name (`cause.name`), such as UNKNOWN_TRANSACTION or INVALID_TRANSACTION. */
  readonly cause_name: string | undefined;
  /** For INVALID_TRANSACTION, why the node refused it, such as Expired or ShardCongested. */
  readonly reason: string | undefined;
  constructor(provider: string, failure: RpcFailure, detail: string, causeName?: string, reason?: string) {
    super(`${provider}: ${failure}: ${detail}${reason ? ` (${reason})` : ''}`);
    this.name = 'RpcError';
    this.provider = provider;
    this.failure = failure;
    this.cause_name = causeName;
    this.reason = reason;
  }
}

/** The variant of an INVALID_TRANSACTION, read from `data.TxExecutionError.InvalidTxError` (NEAR
 *  RPC docs, 28 Oct 2026; `cause.info` is empty for this error): a bare name such as "Expired", or
 *  the single key of an object such as {"ShardCongested": {...}}. Any other shape gives undefined,
 *  and the caller then treats the error as a plain refusal. */
export function invalidTxReason(error: unknown): string | undefined {
  const data = error && typeof error === 'object' ? (error as { data?: unknown }).data : undefined;
  const tx = data && typeof data === 'object' ? (data as { TxExecutionError?: unknown }).TxExecutionError : undefined;
  const r = tx && typeof tx === 'object' ? (tx as { InvalidTxError?: unknown }).InvalidTxError : undefined;
  const named = typeof r === 'string' ? r : r && typeof r === 'object' && !Array.isArray(r) && Object.keys(r).length === 1 ? Object.keys(r)[0] : undefined;
  return named !== undefined && /^[A-Za-z]{1,64}$/.test(named) ? named : undefined;
}

// Provider and contract messages can carry text an attacker wrote (a DAO's panic message), so
// only a short run of printable characters ever reaches an error.
const clean = (text: unknown) => String(text ?? '').replace(/[^\x20-\x7e]/g, '?').slice(0, 200);

const MAX_ANSWER_BYTES = 4 * 1024 * 1024;

export interface RpcOptions {
  timeoutMs?: number;
  maxBytes?: number;
}

export class RpcClient implements ViewProvider, TxProvider {
  readonly name: string;
  readonly #url: string;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;

  constructor(url: string, options: RpcOptions = {}) {
    this.#url = url;
    this.name = new URL(url).host;
    this.#timeoutMs = options.timeoutMs ?? 8_000;
    this.#maxBytes = options.maxBytes ?? MAX_ANSWER_BYTES;
  }

  async call(method: string, params: unknown, timeoutMs = this.#timeoutMs): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(this.#url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'kaap', method, params }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
      throw new RpcError(this.name, timedOut ? 'timeout' : 'http', timedOut ? `no answer within ${timeoutMs} ms` : clean(e instanceof Error ? e.message : e));
    }
    const text = await readCapped(res, this.#maxBytes, this.name);
    let body: { result?: unknown; error?: { name?: unknown; cause?: { name?: unknown; info?: unknown }; message?: unknown; data?: unknown } };
    try {
      body = JSON.parse(text);
    } catch {
      throw new RpcError(this.name, res.ok ? 'not_json' : 'http', `HTTP ${res.status}`);
    }
    if (body.error) {
      const causeName = typeof body.error.cause?.name === 'string' ? body.error.cause.name : undefined;
      const reason = causeName === 'INVALID_TRANSACTION' ? invalidTxReason(body.error) : undefined;
      throw new RpcError(this.name, 'rpc', clean(causeName ?? body.error.name ?? body.error.message), causeName, reason);
    }
    if (!res.ok) throw new RpcError(this.name, 'http', `HTTP ${res.status}`);
    return body.result;
  }

  async callFunction(account: string, method: string, args: object, at: At): Promise<ViewResult> {
    const r = (await this.call('query', {
      request_type: 'call_function',
      ...atParams(at),
      account_id: account,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
    })) as { result?: unknown; block_height?: unknown; block_hash?: unknown; error?: unknown };
    // A contract panic comes back as a successful RPC answer with an `error` text in it.
    if (r && typeof r === 'object' && 'error' in r && r.error !== undefined) throw new RpcError(this.name, 'rpc', `view failed: ${clean(r.error)}`, 'VIEW_FAILED');
    if (!Array.isArray(r?.result) || !r.result.every((b) => Number.isInteger(b) && b >= 0 && b < 256)) throw new RpcError(this.name, 'shape', 'call_function result is not bytes');
    const bytes = Uint8Array.from(r.result as number[]);
    return { bytes, text: new TextDecoder().decode(bytes), blockHeight: blockHeightOf(r, this.name), blockHash: blockHashOf(r, this.name) };
  }

  async viewAccount(account: string, at: At): Promise<AccountView> {
    const r = (await this.call('query', { request_type: 'view_account', ...atParams(at), account_id: account })) as Record<string, unknown>;
    if (typeof r?.code_hash !== 'string' || typeof r.amount !== 'string' || !/^\d+$/.test(r.amount)) throw new RpcError(this.name, 'shape', 'view_account answer has no code_hash or amount');
    return { codeHash: r.code_hash, amount: BigInt(r.amount), storageUsage: Number(r.storage_usage ?? 0), blockHeight: blockHeightOf(r, this.name), blockHash: blockHashOf(r, this.name) };
  }

  async block(at: At): Promise<BlockView> {
    const r = (await this.call('block', 'blockId' in at ? { block_id: at.blockId } : { finality: at.finality })) as { header?: Record<string, unknown> };
    const h = r?.header;
    if (!h || !Number.isSafeInteger(h.height) || typeof h.hash !== 'string' || typeof h.timestamp_nanosec !== 'string') throw new RpcError(this.name, 'shape', 'block answer has no header');
    return { height: h.height as number, hash: h.hash, timestampMs: Number(BigInt(h.timestamp_nanosec) / 1_000_000n) };
  }

  sendTx(signedB64: string, waitUntil: 'INCLUDED' | 'NONE'): Promise<unknown> {
    return this.call('send_tx', { signed_tx_base64: signedB64, wait_until: waitUntil }, 20_000);
  }

  txStatus(hash: string, sender: string): Promise<unknown> {
    return this.call('EXPERIMENTAL_tx_status', { tx_hash: hash, sender_account_id: sender, wait_until: 'FINAL' }, 15_000);
  }
}

function atParams(at: At): Record<string, unknown> {
  return 'blockId' in at ? { block_id: at.blockId } : { finality: at.finality };
}

function blockHeightOf(r: Record<string, unknown> | { block_height?: unknown }, provider: string): number {
  const h = (r as { block_height?: unknown }).block_height;
  if (!Number.isSafeInteger(h)) throw new RpcError(provider, 'shape', 'answer has no block_height');
  return h as number;
}

function blockHashOf(r: Record<string, unknown> | { block_hash?: unknown }, provider: string): string {
  const h = (r as { block_hash?: unknown }).block_hash;
  if (typeof h !== 'string') throw new RpcError(provider, 'shape', 'answer has no block_hash');
  return h;
}

export async function readCapped(res: Response, maxBytes: number, provider: string): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new RpcError(provider, 'too_large', `answer of ${declared} bytes`);
  if (!res.body) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > maxBytes) throw new RpcError(provider, 'too_large', `answer over ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
