// The old-block reads `kaap verify` makes (rpc.ts `Archive`), on a stand-in transport and a clock
// that never waits: an HTTP 429 with a Retry-After waited out on the same node; one with none asked
// again after 2 s and 5 s, then moved to the next node, which starts the run's requests for a
// minute; a request sent once per run however often it is asked; a fresh transaction read from a
// live provider without reaching an archive; a block the live providers dropped read from the
// archive, with older ones sent straight there and a height with no block never doing that; and the
// order of the nodes with KAAP_ARCHIVAL_RPC set, whose gaps the public archives fill. It does not
// cover the real nodes, which only a live `kaap verify` run reaches (PROOF.md records one), or what
// verify prints from these reads (verify.test.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RateLimiter } from '../src/limiter.js';
import type { HttpRequest, HttpResponse, Transport } from '../src/net.js';
import { Archive, archiveHosts, type HostEntry, NETWORKS, RpcError } from '../src/rpc.js';
import { fakeClock } from './replay.js';

const ONE = 'https://one.example.org';
const TWO = 'https://two.example.org';
const PUBLIC_PAIR: HostEntry[] = [
  { url: ONE, role: 'archive' },
  { url: TWO, role: 'archive' },
];
const T = NETWORKS.testnet;

const rpc = (body: object): HttpResponse => ({ status: 200, text: JSON.stringify({ jsonrpc: '2.0', id: 'kaap', ...body }) });
const unknown = (cause: string) => rpc({ error: { name: 'HANDLER_ERROR', cause: { name: cause } } });
const body = (r: HttpRequest) => JSON.parse(r.body ?? '{}') as { method: string; params: Record<string, unknown> };
const height = (r: HttpRequest) => Number(body(r).params['block_id']);
const block = (h: number) => rpc({ result: { header: { height: h, hash: `h${h}`, timestamp_nanosec: '1' }, chunks: [{ chunk_hash: `c${h}`, height_included: h, tx_root: 'r' }] } });
const tx = (status: string) => rpc({ result: { final_execution_status: status, transaction: {}, status: {}, receipts_outcome: [] } });

/** An archive over `hosts` whose transport gives `answer(request, how often this host was asked)`.
 *  The rate limiter keeps its own clock, so `clock.slept` counts only the waits between tries. */
function archive(hosts: readonly HostEntry[], answer: (r: HttpRequest, n: number) => HttpResponse) {
  const clock = fakeClock();
  const asked: HttpRequest[] = [];
  const transport: Transport = async (r) => {
    asked.push(r);
    return answer(r, asked.filter((a) => a.url === r.url).length);
  };
  return { a: new Archive(hosts, transport, new RateLimiter(5, fakeClock()), clock), asked, clock, at: () => asked.map((r) => new URL(r.url).host) };
}

test('an HTTP 429 with a Retry-After is waited out on the same node', async () => {
  const { a, clock, at } = archive(PUBLIC_PAIR, (r, n) => (r.url === ONE && n === 1 ? { status: 429, text: '', retryAfterMs: 3_000 } : block(height(r))));
  assert.equal((await a.block(7)).height, 7);
  assert.deepEqual(at(), ['one.example.org', 'one.example.org']);
  assert.equal(clock.slept, 3_000);
  assert.deepEqual(a.answered, ['one.example.org']);
});

test('an HTTP 429 with no Retry-After is asked again after 2 s and 5 s, then the next node answers and starts the requests for a minute', async () => {
  const { a, clock, at } = archive(PUBLIC_PAIR, (r) => (r.url === ONE ? { status: 429, text: '' } : block(height(r))));
  assert.equal((await a.block(7)).height, 7);
  assert.deepEqual(at(), ['one.example.org', 'one.example.org', 'one.example.org', 'two.example.org']);
  assert.equal(clock.slept, 7_000);
  await a.block(8);
  assert.deepEqual(at().slice(4), ['two.example.org'], 'the node that refused rests');
  await clock.sleep(60_000);
  await a.block(9);
  assert.deepEqual(at().slice(5), ['one.example.org', 'one.example.org', 'one.example.org', 'two.example.org'], 'a minute later it is first again');
  assert.deepEqual(a.answered, ['two.example.org', 'two.example.org', 'two.example.org']);
});

test('a request is sent once per run, a node\'s final word that it has no such thing included, but a failure every node gave is asked again', async () => {
  let down = true;
  const { a, asked } = archive(PUBLIC_PAIR, (r) => {
    if (body(r).method === 'tx') return unknown('UNKNOWN_TRANSACTION');
    if (height(r) === 9 && down) return { status: 503, text: '' };
    return block(height(r));
  });
  await a.block(7);
  await a.block(7);
  assert.equal(asked.length, 1);
  assert.equal(await a.txStatus('9xTx', 'kaap-worker.testnet'), null);
  assert.equal(await a.txStatus('9xTx', 'kaap-worker.testnet'), null);
  assert.equal(asked.length, 2, 'the archive said it has no such transaction, once');
  await a.block(8);
  assert.equal(asked.length, 3, 'another request is sent');
  await assert.rejects(a.block(9), (e) => e instanceof RpcError && e.failure === 'unavailable' && /^no node answered: one\.example\.org: HTTP 503; two\.example\.org: HTTP 503$/.test(e.message));
  const sent = asked.length;
  down = false;
  assert.equal((await a.block(9)).height, 9);
  assert.equal(asked.length, sent + 1, 'asked again, and answered');
});

test('a fresh transaction is read from a live provider, asked not to wait, without reaching an archive; one not final yet moves on', async () => {
  const fresh = archive(archiveHosts('testnet', null), (r) => (r.url === T.primary ? tx('FINAL') : assert.fail(`asked ${r.url}`)));
  assert.notEqual(await fresh.a.txStatus('9xTx', 'kaap-worker.testnet'), null);
  assert.deepEqual(fresh.at(), ['near-testnet.drpc.org']);
  assert.equal(body(fresh.asked[0] as HttpRequest).params['wait_until'], 'NONE');
  assert.deepEqual(fresh.a.answered, ['near-testnet.drpc.org']);

  const pending = archive(archiveHosts('testnet', null), (r) => (r.url === T.primary ? tx('EXECUTED_OPTIMISTIC') : tx('FINAL')));
  await pending.a.txStatus('9xTx', 'kaap-worker.testnet');
  assert.deepEqual(pending.a.answered, ['rpc.testnet.fastnear.com']);
});

test('a block the live providers dropped comes from the archive, older reads go straight there, and a height with no block sends nothing past them', async () => {
  const exists = (h: number) => h !== 200 && h !== 150;
  const { a, at } = archive(archiveHosts('testnet', null), (r) => {
    const live = r.url === T.primary || r.url === T.secondary;
    const { method, params } = body(r);
    if (method === 'chunk') return live ? unknown('UNKNOWN_CHUNK') : rpc({ result: { transactions: [] } });
    if (method === 'query') return live ? rpc({ error: { name: 'HANDLER_ERROR', cause: { name: 'GARBAGE_COLLECTED_BLOCK' } } }) : rpc({ result: { result: [...Buffer.from('{}')], block_height: params['block_id'], block_hash: `h${String(params['block_id'])}`, logs: [] } });
    if (!exists(height(r))) return unknown('UNKNOWN_BLOCK');
    return live && height(r) < 190 ? unknown('UNKNOWN_BLOCK') : block(height(r));
  });
  assert.equal(await a.blockChunks(200), null, 'no block was made at 200');
  assert.deepEqual(at(), ['near-testnet.drpc.org', 'rpc.testnet.fastnear.com', 'archival-rpc.testnet.fastnear.com']);
  await a.blockChunks(199);
  assert.deepEqual(at().slice(3), ['near-testnet.drpc.org'], 'a live provider still holds 199');
  await a.blockChunks(180);
  assert.deepEqual(at().slice(4), ['near-testnet.drpc.org', 'rpc.testnet.fastnear.com', 'archival-rpc.testnet.fastnear.com']);
  await a.chunkTransactions('c180');
  assert.deepEqual(at().slice(7), ['archival-rpc.testnet.fastnear.com'], 'the chunk of a block only the archive held goes straight there');
  await a.view('dao.testnet', 'get_policy', {}, 181);
  assert.deepEqual(at().slice(8), ['near-testnet.drpc.org', 'rpc.testnet.fastnear.com', 'archival-rpc.testnet.fastnear.com'], 'a provider that says it dropped block 181 is passed');
  assert.deepEqual(a.answered.slice(-1), ['archival-rpc.testnet.fastnear.com']);
  assert.equal(await a.blockChunks(150), null);
  assert.deepEqual(at().slice(11), ['archival-rpc.testnet.fastnear.com'], 'at 181 and below only the archive is asked');
  await a.blockChunks(185);
  assert.deepEqual(at().slice(12), ['near-testnet.drpc.org', 'rpc.testnet.fastnear.com', 'archival-rpc.testnet.fastnear.com'], 'above 181 the live providers are asked again');
});

test('KAAP_ARCHIVAL_RPC goes in front of the public archives, after the live providers, is not listed twice, and what it lacks is asked of them', async () => {
  const own = 'https://archive.example.org';
  assert.deepEqual(archiveHosts('testnet', own), [
    { url: T.primary, role: 'live' },
    { url: T.secondary, role: 'live' },
    { url: own, role: 'own' },
    { url: 'https://archival-rpc.testnet.fastnear.com', role: 'archive' },
    { url: 'https://archival-rpc.testnet.near.org', role: 'archive' },
  ]);
  assert.deepEqual(archiveHosts('testnet', 'https://archival-rpc.testnet.fastnear.com').map((h) => h.role), ['live', 'live', 'own', 'archive']);
  assert.deepEqual(archiveHosts('mainnet', null).map((h) => h.url).slice(2), ['https://archival-rpc.mainnet.fastnear.com', 'https://archival-rpc.mainnet.near.org']);

  const { a, at } = archive([{ url: own, role: 'own' }, ...PUBLIC_PAIR], (r) => (r.url === own && height(r) === 3 ? unknown('UNKNOWN_BLOCK') : block(height(r))));
  await a.block(2);
  await a.block(3);
  assert.deepEqual(at(), ['archive.example.org', 'archive.example.org', 'one.example.org']);
  assert.deepEqual(a.answered, ['archive.example.org', 'one.example.org']);
});
