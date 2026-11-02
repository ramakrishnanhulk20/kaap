// The one way the CLI reaches the network. Every request names a fixed host from this package
// (rpc.ts, prices.ts, outlayer.ts), never one built from input, carries a timeout and a body cap,
// follows no redirect, and sends no key or cookie. The one exception is `kaap subscribe`, which asks
// the worker the user names with --worker, held to https by args.ts. Tests swap `fetchTransport`
// for recorded answers.

export interface HttpRequest {
  url: string;
  method: 'GET' | 'POST';
  body?: string;
  timeoutMs: number;
  maxBytes: number;
}

export interface HttpResponse {
  status: number;
  text: string;
  /** From a Retry-After header in seconds, when the provider sent one. */
  retryAfterMs?: number;
}

export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

export type NetFailure = 'timeout' | 'unreachable' | 'too_large';

export class NetError extends Error {
  readonly failure: NetFailure;
  constructor(failure: NetFailure, host: string) {
    super(failure === 'timeout' ? `${host} did not answer in time` : failure === 'too_large' ? `${host} sent more than the CLI reads` : `${host} could not be reached`);
    this.name = 'NetError';
    this.failure = failure;
  }
}

export const fetchTransport: Transport = async (request) => {
  const host = new URL(request.url).host;
  let response: Response;
  try {
    response = await fetch(request.url, {
      method: request.method,
      headers: request.body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      ...(request.body === undefined ? {} : { body: request.body }),
      redirect: 'error',
      signal: AbortSignal.timeout(request.timeoutMs),
    });
  } catch (e) {
    throw new NetError(e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'unreachable', host);
  }
  const text = await readCapped(response, request.maxBytes, host);
  const retryAfter = Number(response.headers.get('retry-after'));
  return { status: response.status, text, ...(retryAfter > 0 ? { retryAfterMs: retryAfter * 1000 } : {}) };
};

async function readCapped(response: Response, maxBytes: number, host: string): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new NetError('too_large', host);
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof NetError) throw e;
    throw new NetError(e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'unreachable', host);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
