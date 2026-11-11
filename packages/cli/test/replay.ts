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

/** A source file with the two exact expressions C31's source scan allows taken out: the one
 *  variable `kaap seal-text` reads for its worker's address, and the X25519 pair it seals a text
 *  with, which cannot sign a NEAR transaction. Any other environment read or key pair still shows. */
export function withoutAllowedReads(text: string): string {
  return text.replaceAll("process.env['KAAP_WORKER_URL']", '').replaceAll("generateKeyPairSync('x25519')", '');
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
