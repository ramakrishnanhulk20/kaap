#!/usr/bin/env node
// Saves one real sign-request proposal of the demo treasury, the text behind its hash, the engine's
// answers with and without that text, and the registry's record, as lab-fixtures/hash-proposal.json.
// The lab page reads that file, so nothing it shows is typed by hand.
//
//   npm run capture:lab        (from packages/web)
//
// The proposal and its text come from deployments/demo-hash-text.json, which
// scripts/hash-check-testnet.mjs writes when it files the proposal. Read-only calls to NEAR
// testnet, no key. The engine is packages/core-wasm/pkg, as built. Exit code 0 only when the text
// hashes to the payload on chain and to the payload the file recorded; otherwise nothing is written.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '../../core-wasm/pkg/kaap_core_wasm.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const OUT = join(HERE, '..', 'lab-fixtures', 'hash-proposal.json');
const TEXT_FILE = join('deployments', 'demo-hash-text.json');
const RPC = 'https://rpc.testnet.fastnear.com';
const NETWORK = 'testnet';
const DAO = 'kaap-dao-1111072928.testnet';
const REGISTRY = 'kaap-registry-1111072803.testnet';
const SIGNER = 'v1.signer-prod.testnet';

core.initSync({ module: readFileSync(join(HERE, '..', '..', 'core-wasm', 'pkg', 'kaap_core_wasm_bg.wasm')) });

async function rpc(method, params) {
  const response = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

/** A final-block view call. `text` is the answer exactly as the contract returned it. */
async function view(account, method, args = {}) {
  const result = await rpc('query', {
    request_type: 'call_function',
    finality: 'final',
    account_id: account,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
  });
  if (result.error) throw new Error(`${account}.${method}: ${result.error}`);
  return { text: Buffer.from(result.result).toString('utf8'), block_height: result.block_height, block_hash: result.block_hash };
}

/** The 64-character hash a sign request carries, or null when the kind is anything else. */
function signPayload(kind) {
  const call = kind?.FunctionCall;
  if (!call || call.receiver_id !== SIGNER) return null;
  for (const action of call.actions) {
    if (action.method_name !== 'sign') continue;
    const args = JSON.parse(Buffer.from(action.args, 'base64').toString('utf8'));
    const hex = args?.request?.payload_v2?.Eddsa;
    if (typeof hex === 'string' && /^[0-9a-f]{64}$/.test(hex)) return hex;
  }
  return null;
}

async function main() {
  const filed = JSON.parse(readFileSync(join(REPO, TEXT_FILE), 'utf8'));
  if (filed.network !== NETWORK || filed.dao !== DAO) {
    throw new Error(`${TEXT_FILE} is for ${filed.network} ${filed.dao}, not ${NETWORK} ${DAO}`);
  }
  const text = { message: filed.message, nonce: filed.nonce_base64, recipient: filed.recipient, standard: filed.standard };

  const read = await view(DAO, 'get_proposal', { id: filed.proposal_id });
  const block = await rpc('block', { block_id: read.block_hash });
  const readAt = new Date().toISOString();
  const onChain = signPayload(JSON.parse(read.text).kind);
  console.log(`proposal #${filed.proposal_id} of ${DAO}, read at final block ${read.block_height}`);
  console.log(`payload hash on chain  ${onChain}`);
  if (!onChain) throw new Error(`proposal #${filed.proposal_id} is not a sign request to ${SIGNER}`);

  const hashed = core.nep413Hash(text.message, text.nonce, text.recipient, undefined);
  console.log(`hash of the saved text ${hashed}`);
  console.log(`payload hash in the file ${filed.payload_hash}`);
  const matchesChain = hashed === onChain;
  const matchesFile = hashed === filed.payload_hash;
  console.log(`the text hashes to the payload on chain: ${matchesChain ? 'yes' : 'NO'}; to the payload in the file: ${matchesFile ? 'yes' : 'NO'}`);
  if (!matchesChain || !matchesFile) {
    console.log('STOP: the saved text does not stand behind this proposal. Nothing was written.');
    process.exit(1);
  }

  const parsed = JSON.parse(core.readProposal(read.text));
  const input = {
    network: NETWORK,
    dao: DAO,
    proposal_id: filed.proposal_id,
    description: parsed.description,
    kind_json: parsed.kind_json,
    block_timestamp_ns: block.header.timestamp_nanosec,
  };
  const withoutText = JSON.parse(core.analyze(JSON.stringify(input)));
  const withText = JSON.parse(core.analyze(JSON.stringify({ ...input, supplied_text: text })));
  const summary = ({ analysis }) => `floor ${analysis.risk_floor}, findings ${analysis.findings.map((f) => f.code).join(', ') || 'none'}`;
  console.log(`without the text: ${summary(withoutText)}`);
  console.log(`with the text:    ${summary(withText)}`);

  const registry = await view(REGISTRY, 'latest', { network: NETWORK, dao: DAO, proposal_id: filed.proposal_id });
  console.log(`registry latest: ${registry.text === 'null' ? 'null' : 'a record'}`);

  const fixture = {
    source: 'Every value in this file is a saved answer from NEAR testnet or from the Kaap engine, and none was typed by hand.',
    reads: {
      proposal: { network: NETWORK, rpc: RPC, account: DAO, method: `get_proposal {"id":${filed.proposal_id}}`, block_height: read.block_height, block_hash: read.block_hash, block_timestamp_ns: block.header.timestamp_nanosec, date: readAt },
      text: { taken_from: TEXT_FILE, filed_tx: filed.filed_tx, filed_at_block: filed.filed_at_block, checked_with: 'nep413Hash from packages/core-wasm/pkg', hashes_to_payload_on_chain: true, hashes_to_payload_in_file: true, date: readAt },
      analysis: { engine: 'analyze from packages/core-wasm/pkg', decoder_version: core.decoderVersion(), date: readAt },
      registry: { network: NETWORK, rpc: RPC, account: REGISTRY, method: `latest {"network":"${NETWORK}","dao":"${DAO}","proposal_id":${filed.proposal_id}}`, block_height: registry.block_height, block_hash: registry.block_hash, date: readAt },
    },
    proposal: JSON.parse(read.text),
    payload_hash_hex: onChain,
    text,
    analysis_without_text: withoutText,
    analysis_with_text: withText,
    registry_record: JSON.parse(registry.text),
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`wrote ${OUT}`);
}

try {
  await main();
} catch (e) {
  console.log(`FAIL: ${e?.message ?? e}`);
  process.exit(1);
}
