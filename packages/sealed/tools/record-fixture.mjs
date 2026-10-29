// Records, at one final block, every JSON-RPC answer the sealed job asks for, from the job's
// HTTPS provider (dRPC) and from FastNEAR, which stands in for OutLayer's own FastNEAR-powered
// host RPC in tests and in the local wasmtime build.
//
// Usage: node record-fixture.mjs <testnet|mainnet> <dao> <proposal id> <out.json> [receiver ...]
// The receivers are the contracts the proposal's kind calls; the DAO is always read.
import { writeFileSync } from 'node:fs';

const [network, dao, idText, out, ...receivers] = process.argv.slice(2);
if (!['testnet', 'mainnet'].includes(network) || !dao || !/^\d+$/.test(idText ?? '') || !out) {
  console.error('usage: node record-fixture.mjs <testnet|mainnet> <dao> <proposal id> <out.json> [receiver ...]');
  process.exit(2);
}
const HTTPS = network === 'testnet' ? 'near-testnet.drpc.org' : 'near.drpc.org';
const HOST = network === 'testnet' ? 'rpc.testnet.fastnear.com' : 'rpc.mainnet.fastnear.com';
// The repo's sweep refuses this character in any committed file.
const LONG_DASH = String.fromCodePoint(0x2014);
const exchanges = [];

async function rpc(authority, method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 'kaap', method, params });
  const res = await fetch(`https://${authority}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (text.includes(LONG_DASH)) throw new Error(`the answer from ${authority} holds a long dash; pick another proposal`);
  exchanges.push({ authority, method, params, status: res.status, body: text });
  return JSON.parse(text);
}

const args = (value) => Buffer.from(JSON.stringify(value)).toString('base64');
const call = (method, value, at) => ({ request_type: 'call_function', account_id: dao, method_name: method, args_base64: args(value), ...at });
const account = (id, at) => ({ request_type: 'view_account', account_id: id, ...at });

const head = await rpc(HTTPS, 'block', { finality: 'final' });
const height = head.result.header.height;
const at = { block_id: height };
for (const authority of [HTTPS, HOST]) {
  if (authority === HOST) await rpc(HOST, 'block', at);
  await rpc(authority, 'query', call('get_proposal', { id: Number(idText) }, at));
  await rpc(authority, 'query', call('get_policy', {}, at));
  for (const id of [dao, ...receivers]) await rpc(authority, 'query', account(id, at));
}

const fixture = {
  recorded_at: new Date().toISOString(),
  network,
  dao,
  proposal_id: Number(idText),
  block_height: height,
  https: HTTPS,
  host_stand_in: HOST,
  exchanges,
};
writeFileSync(out, JSON.stringify(fixture, null, 1) + '\n');
console.log(`recorded ${exchanges.length} answers at block ${height} into ${out}`);
