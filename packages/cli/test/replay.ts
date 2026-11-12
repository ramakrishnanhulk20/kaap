// Recorded network answers for the tests, and a clock that never waits. A fixture holds every
// exchange one live run made (tools/record-fixtures.ts); the replay transport answers each request
// with the recorded answer to the same request and refuses anything that was not recorded. View
// results are stored as their UTF-8 text instead of JSON-RPC's list of byte values, and turned back
// into that list on replay, which is lossless and keeps the files about four times smaller. A block
// is stored as its header and its chunks' hashes, heights and transaction roots, the only parts the
// CLI reads.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Clock } from '../src/limiter.js';
import { type HttpRequest, type HttpResponse, NetError, type Transport } from '../src/net.js';

export interface Exchange {
  url: string;
  method: 'GET' | 'POST';
  body: string | null;
  status: number;
  text: string;
}

export interface Fixture {
  argv: string[];
  recorded_at: string;
  exit: number;
  exchanges: Exchange[];
}

export const FIXTURES = fileURLToPath(new URL('../../test/fixtures/', import.meta.url));
export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

export function load(name: string): Fixture {
  return JSON.parse(readFileSync(`${FIXTURES}${name}`, 'utf8')) as Fixture;
}

/** A view a recording lacks because the CLI did not ask it when the recording was made, with the
 *  JSON the chain answers for it. Without `args`, any arguments match. With `absent`, the chain's
 *  answer for a method the contract does not have, and `value` is not used. */
export interface MissingView {
  account: string;
  method: string;
  args?: object;
  value?: unknown;
  absent?: true;
}

/** Every guard in these recordings was deployed before strict mode and the key delay. Asked for
 *  the two views those added, each answers that it has no such method, as both testnet providers
 *  did live on 12 Nov. A test that needs a later guard lists the view itself, which comes first. */
export const BEFORE_STRICT_MODE: MissingView[] = ['kaap-guard-1029061211.testnet', 'kaap-guard-1111072803.testnet'].flatMap((account) => [
  { account, method: 'veto_unreadable', absent: true as const },
  { account, method: 'pending_key', absent: true as const },
]);

/** What NEAR answers for a view of a method the contract does not have. */
export const NO_SUCH_METHOD = 'wasm execution failed with error: MethodResolveError(MethodNotFound)';

/** What the 11 Nov guard and registry answer for the DAOs recorded before them, as both answered
 *  live on 11 Nov: none of those DAOs is enrolled with that guard, and its registry holds no verdict
 *  for any of their proposals. With these, a 29 Oct recording replays through the real chain of
 *  deployment records, today's first. */
export const UNKNOWN_TODAY: MissingView[] = [
  { account: 'kaap-guard-1111072803.testnet', method: 'is_enrolled', value: false },
  { account: 'kaap-registry-1111072803.testnet', method: 'latest', value: null },
];

/** `t`, with each view in `views` that the recording does not hold answered by either provider
 *  with its `value`, pinned to the block the request names as the recording knows that block. */
export function answering(t: Transport, fixture: Fixture, views: readonly MissingView[]): Transport {
  const hashes = new Map<number, string>();
  for (const e of fixture.exchanges) {
    try {
      const header = (JSON.parse(e.text) as { result?: { header?: { height?: unknown; hash?: unknown } } }).result?.header;
      if (typeof header?.height === 'number' && typeof header.hash === 'string') hashes.set(header.height, header.hash);
    } catch {
      continue;
    }
  }
  return async (r) => {
    try {
      return await t(r);
    } catch (e) {
      if (!(e instanceof NetError)) throw e;
      const p = (JSON.parse(r.body ?? '{}') as { params?: { request_type?: string; account_id?: string; method_name?: string; args_base64?: string; block_id?: unknown } }).params;
      const args = Buffer.from(p?.args_base64 ?? '', 'base64').toString('utf8');
      const matches = (v: MissingView) => v.account === p?.account_id && v.method === p?.method_name && (v.args === undefined || JSON.stringify(v.args) === args);
      const view = p?.request_type === 'call_function' ? (views.find(matches) ?? BEFORE_STRICT_MODE.find(matches)) : undefined;
      const hash = typeof p?.block_id === 'number' ? hashes.get(p.block_id) : undefined;
      if (view === undefined || hash === undefined) throw e;
      if (view.absent) return { status: 200, text: JSON.stringify({ jsonrpc: '2.0', id: 'kaap', result: { block_hash: hash, block_height: p?.block_id, error: NO_SUCH_METHOD, logs: [] } }) };
      return { status: 200, text: JSON.stringify({ jsonrpc: '2.0', id: 'kaap', result: { result: [...Buffer.from(JSON.stringify(view.value), 'utf8')], logs: [], block_height: p?.block_id, block_hash: hash } }) };
    }
  };
}

const key = (r: { method: string; url: string; body?: string | null | undefined }) => `${r.method} ${r.url} ${r.body ?? ''}`;

/** Stores a view result as text when its bytes are UTF-8, and a block as its header and the three
 *  fields of each chunk `kaap verify` reads (the CLI reads nothing else of a block). */
export function compact(text: string): string {
  try {
    const answer = JSON.parse(text) as { result?: { result?: unknown; header?: unknown; chunks?: unknown } };
    if (answer.result?.header !== undefined && Array.isArray(answer.result.chunks)) {
      const chunks = (answer.result.chunks as Record<string, unknown>[]).map((c) => ({ chunk_hash: c['chunk_hash'], height_included: c['height_included'], tx_root: c['tx_root'] }));
      return JSON.stringify({ ...answer, result: { header: answer.result.header, chunks } });
    }
    const bytes = answer.result?.result;
    if (!Array.isArray(bytes)) return text;
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes as number[]));
    const { result: _bytes, ...rest } = answer.result as Record<string, unknown>;
    return JSON.stringify({ ...answer, result: { ...rest, result_text: decoded } });
  } catch {
    return text;
  }
}

function expand(text: string): string {
  const answer = JSON.parse(text) as { result?: Record<string, unknown> };
  const inner = answer.result;
  if (!inner || typeof inner['result_text'] !== 'string') return text;
  const { result_text: decoded, ...rest } = inner;
  return JSON.stringify({ ...answer, result: { ...rest, result: [...Buffer.from(decoded as string, 'utf8')] } });
}

/** A transport that answers from `fixture` and logs every request it is asked. `edit` may change
 *  an answer before it is returned, for tests that need a provider to lie. */
export function replay(fixture: Fixture, log: HttpRequest[] = [], edit?: (request: HttpRequest, text: string) => string): Transport {
  const answers = new Map<string, Exchange>();
  for (const exchange of fixture.exchanges) {
    const seen = answers.get(key(exchange));
    if (!seen || seen.status !== 200) answers.set(key(exchange), exchange);
  }
  return async (request): Promise<HttpResponse> => {
    log.push(request);
    const found = answers.get(key(request));
    if (!found) throw new NetError('unreachable', new URL(request.url).host);
    const text = found.text.startsWith('{') ? expand(found.text) : found.text;
    return { status: found.status, text: edit ? edit(request, text) : text };
  };
}

/** A source file with the exact expressions C31's source scan allows taken out: the variable
 *  `kaap seal-text` reads for its worker's address, the one `kaap verify` reads for an archival
 *  node, and the X25519 pair `seal-text` seals a text with, which cannot sign a NEAR transaction.
 *  Any other environment read or key pair still shows. */
export function withoutAllowedReads(text: string): string {
  return text.replaceAll("process.env['KAAP_WORKER_URL']", '').replaceAll("process.env['KAAP_ARCHIVAL_RPC']", '').replaceAll("generateKeyPairSync('x25519')", '');
}

/** A clock whose sleep moves time on at once, so rate limits cost no real time in tests. */
export function fakeClock(start = 1_800_000_000_000): Clock & { slept: number } {
  let now = start;
  const clock = {
    slept: 0,
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
      clock.slept += ms;
    },
  };
  return clock;
}
