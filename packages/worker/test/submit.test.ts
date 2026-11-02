// A busy network (scope addition A): NEAR's INVALID_TRANSACTION with ShardCongested or ShardStuck
// is read from the real RPC error shape as "send the same bytes again", never as a refusal; the
// same stored bytes go out again on this call and on later passes; and a block hash that expires
// during the wait falls back to the existing path, which signs once more. Not covered: how long a
// real shard stays congested, and the validity period itself, which the chain enforces.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

import { NearChain } from '../src/chain.ts';
import { RpcClient, invalidTxReason } from '../src/rpc.ts';
import { Submitter, type SubmitRequest } from '../src/submit.ts';
import { DAO, FakeChain, GUARD, NETWORK, events, memoryLog, memoryStore, noSleep, testKey } from './helpers.ts';

/** NEAR's documented error for a refused transaction, with `reason` as its InvalidTxError. */
const invalidTx = (reason: unknown) => ({ jsonrpc: '2.0', error: { name: 'HANDLER_ERROR', cause: { name: 'INVALID_TRANSACTION', info: {} }, code: -32000, message: 'Server error', data: { TxExecutionError: { InvalidTxError: reason } } }, id: 'kaap' });

function setup() {
  const chain = new FakeChain();
  const store = memoryStore();
  const { log, lines } = memoryLog();
  const submitter = new Submitter(store, chain, NETWORK, log, { pollMs: 1, sendTries: 3, sleep: noSleep, explorer: (h) => h });
  const req: SubmitRequest = { key: `veto:${NETWORK}:${DAO}:2:abc`, kind: 'veto', dao: DAO, proposalId: 2, receiver: GUARD, method: 'veto', args: {}, gas: 300n * 10n ** 12n, deposit: 0n, reserved: 3n * 10n ** 22n, windowBlocks: 60, kept: () => 0n };
  return { chain, store, submitter, req, lines: () => lines };
}

test('the RPC error names ShardCongested and ShardStuck as a busy shard, and every other reason stays a refusal', async () => {
  assert.equal(invalidTxReason(invalidTx({ ShardCongested: { shard_id: 2, congestion_level: 1 } }).error), 'ShardCongested');
  assert.equal(invalidTxReason(invalidTx({ ShardStuck: { shard_id: 2, missed_chunks: 7 } }).error), 'ShardStuck');
  assert.equal(invalidTxReason(invalidTx('Expired').error), 'Expired');
  assert.equal(invalidTxReason(invalidTx({ InvalidNonce: { tx_nonce: 5, ak_nonce: 7 } }).error), 'InvalidNonce');
  for (const odd of [{ ShardCongested: {}, Expired: {} }, ['ShardCongested'], 'Shard Congested', 42, null]) assert.equal(invalidTxReason(invalidTx(odd).error), undefined, JSON.stringify(odd));
  assert.equal(invalidTxReason({ data: 'ShardCongested' }), undefined, 'a bare text is not the documented shape');

  const answers = [invalidTx({ ShardCongested: { shard_id: 2, congestion_level: 1 } }), invalidTx({ ShardStuck: { shard_id: 2, missed_chunks: 7 } }), invalidTx('Expired')];
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(answers.shift()));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const chain = new NearChain('worker.kaap.testnet', testKey(), new RpcClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  const got = [await chain.broadcast('AAAA'), await chain.broadcast('AAAA'), await chain.broadcast('AAAA')];
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  assert.deepEqual(got.map((g) => g.kind), ['retry', 'retry', 'rejected']);
  assert.match(got[0]!.kind === 'retry' ? got[0]!.detail : '', /INVALID_TRANSACTION \(ShardCongested\)/);
});

for (const name of ['ShardCongested', 'ShardStuck']) {
  test(`${name}: the same signed bytes are sent again, and nothing is signed twice`, async () => {
    const s = setup();
    s.chain.plan = ['retry', 'retry', 'included'];
    const got = await s.submitter.submit(s.req);
    assert.equal(got.kind, 'final');
    assert.equal(s.chain.signed.length, 1);
    assert.equal(s.chain.broadcasts.length, 3);
    assert.equal(new Set(s.chain.broadcasts).size, 1, 'three sends of identical bytes');
    assert.equal(events(s.lines(), 'tx_shard_busy').length, 2);
    assert.equal(events(s.lines(), 'tx_resigned').length, 0);
  });
}

test('bytes a busy shard kept turning away stay stored unsent, and the next pass sends the very same bytes', async () => {
  const s = setup();
  s.chain.plan = ['retry', 'retry', 'retry'];
  const first = await s.submitter.submit(s.req);
  assert.equal(first.kind, 'no_outcome', 'no window is waited out for bytes no node took');
  assert.equal(s.store.spend(s.req.key)?.state, 'signed');
  assert.equal(events(s.lines(), 'tx_not_taken').length, 1);

  s.chain.plan = ['included'];
  const second = await s.submitter.submit(s.req);
  assert.equal(second.kind, 'final');
  assert.equal(s.chain.signed.length, 1);
  assert.equal(new Set(s.chain.broadcasts).size, 1, 'four sends, one set of bytes');
});

test('a block hash that expires while the shard is busy falls back to signing again, once', async () => {
  const s = setup();
  s.chain.plan = ['retry', 'rejected', 'included'];
  const got = await s.submitter.submit(s.req);
  assert.equal(got.kind, 'final');
  assert.equal(s.chain.signed.length, 2, 'signed again only after the chain refused the old bytes');
  assert.deepEqual(s.chain.broadcasts, [s.chain.signed[0]!.signedB64, s.chain.signed[0]!.signedB64, s.chain.signed[1]!.signedB64]);
  assert.equal(events(s.lines(), 'tx_resigned').length, 1);
  assert.equal(got.kind === 'final' && got.hash, s.chain.signed[1]!.hash);
});
