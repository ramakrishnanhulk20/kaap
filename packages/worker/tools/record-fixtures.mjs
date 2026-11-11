#!/usr/bin/env node
// Records the real testnet answers the worker's tests parse, into test/fixtures/. Read-only: no
// key is loaded and nothing is signed. Rerun it to refresh the DAO reads; the transactions are
// final and never change.
//   node packages/worker/tools/record-fixtures.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');
const ARCHIVAL = 'https://archival-rpc.testnet.fastnear.com';
const RPC = 'https://rpc.testnet.fastnear.com';
const DAO = 'kaap-dao-1029064008.testnet';

const TXS = {
  // The 29 Oct testnet proof, run 1: the sealed job's signed verdict on attack proposal #2
  // (PROOF.md).
  'run-ok': ['7vT7uwgwggGUc3CpNgLApgyjFS4s65KTfZTbMF2enx6T', 'kaap-worker-1029053612.testnet'],
  // A testnet run of the sealed job that held because its two providers were made to disagree.
  'run-held': ['ACQcwBVxwAKDQZSf7p8oi8ZWTotrLVNAhb89vp4wWFfW', 'kaap-worker-1029053612.testnet'],
  // The early OutLayer trial, 26 Oct, request 5598: OutLayer never answered and the yield timed
  // out after 204 blocks.
  'run-no-answer': ['9o9Nstg26v4QC4hPk7aJMixyEZjQtcimA1AWhPuGrZib', 'kaap-ol-spike-10200854.testnet'],
  // The 29 Oct testnet proof, run 1: the record of #2's verdict, the guard's vote on #2, and its
  // refusal of #3's.
  'record-ok': ['F6HUKKH9tdnwu2FhKqK3vGpokMHZcNaKGSp5DPUL94QQ', 'kaap-worker-1029053612.testnet'],
  'veto-ok': ['GGCGBiiHRpBPcEfqUgxAnQCAYyFJGZHGVver3mhCNdGq', 'kaap-worker-1029053612.testnet'],
  'veto-refused': ['6DScqQ3g7NqGcnpNsa2tYF6u5J5Z59T81reCRberwvrd', 'kaap-worker-1029053612.testnet'],
};

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'kaap', method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error).slice(0, 300)}`);
  return body.result;
}

const view = async (blockId, method, args) => {
  const r = await rpc(RPC, 'query', { request_type: 'call_function', block_id: blockId, account_id: DAO, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
  return Buffer.from(r.result).toString('utf8');
};

mkdirSync(OUT, { recursive: true });
for (const [name, [hash, sender]] of Object.entries(TXS)) {
  const result = await rpc(ARCHIVAL, 'EXPERIMENTAL_tx_status', { tx_hash: hash, sender_account_id: sender, wait_until: 'FINAL' });
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(result, null, 1) + '\n');
  console.log(`${name}: ${hash}`);
}

const block = await rpc(RPC, 'block', { finality: 'final' });
const height = block.header.height;
const account = await rpc(RPC, 'query', { request_type: 'view_account', block_id: height, account_id: DAO });
const reads = {
  recorded_at: new Date().toISOString(),
  dao: DAO,
  block_height: height,
  code_hash: account.code_hash,
  get_policy: await view(height, 'get_policy', {}),
  get_last_proposal_id: await view(height, 'get_last_proposal_id', {}),
  get_proposal_2: await view(height, 'get_proposal', { id: 2 }),
  get_proposal_3: await view(height, 'get_proposal', { id: 3 }),
  get_proposals_0_10: await view(height, 'get_proposals', { from_index: 0, limit: 10 }),
};
writeFileSync(join(OUT, 'dao-reads.json'), JSON.stringify(reads, null, 1) + '\n');
console.log(`dao-reads: ${DAO} at final block ${height}`);
