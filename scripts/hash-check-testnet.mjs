#!/usr/bin/env node
// Files a disguised "Authenticate DAO" sign proposal on the demo treasury and has kaap-core judge
// it twice, natively, from the proposal as the chain stores it: once with no text, where it must
// say HASH_UNVERIFIED, and once with the text behind the hash, where it must say
// HASH_TEXT_DANGEROUS, because the text adds a key to the DAO's intents account.
//
// The proposal is a `v1.signer-prod.testnet` `sign` with the DAO as path, payload_v2 Eddsa,
// domain_id 1 and 1 yoctoNEAR, the exact shape NEAR Business files. Nothing here votes; no worker
// runs, so the proposal is left to expire. The MPC contract is never called, and
// `latest_key_version`, gone from testnet since 3.18.0, is never used.
//
// Testnet only. Inside WSL, with Node 22 or later, near-api-js 7.4.0 at the repo root and cargo
// on PATH (CARGO_TARGET_DIR is passed through):
//   node scripts/hash-check-testnet.mjs
// It signs as the demo member, whose key is read from ~/.near-credentials/testnet and never
// printed. Exit code 0 only when both judgements come out as stated above.

import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  REPO, TGAS, accountFor, baseEncode, blockAt, call, loadState, provider, refusal, returned, txLink, viewFinal, viewFinalRaw,
} from './setup-demo-dao.mjs';

const MPC = 'v1.signer-prod.testnet';
const DESCRIPTION = 'Authenticate DAO for confidential intents';
const NEP413_TAG = 2 ** 31 + 413;

const state = loadState();
const dao = state.dao.account_id;
const memberId = state.dao.member.account_id;

const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const borshString = (s) => {
  const bytes = Buffer.from(s, 'utf8');
  return Buffer.concat([u32(bytes.length), bytes]);
};

/** NEP-413 hash written here independently of kaap-core, so the two implementations must agree
 *  for the text to count: sha256(u32 tag, message, 32-byte nonce, recipient, no callback url). */
function nep413Hash(message, nonce, recipient) {
  const payload = Buffer.concat([u32(NEP413_TAG), borshString(message), nonce, borshString(recipient), Buffer.from([0])]);
  return createHash('sha256').update(payload).digest('hex');
}

/** The exact bytes of `kind` inside a get_proposal answer, found by matching brackets, so the
 *  input kaap-core sees is what the chain returned and not a re-encoding of it (C5). */
function kindBytes(text) {
  const start = text.indexOf('"kind":') + '"kind":'.length;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return Buffer.from(text.slice(start, i + 1), 'utf8');
    }
  }
  throw new Error('get_proposal returned no complete kind');
}

/** kaap-core's analysis of `input`, from `cargo run --example hash_check`. The block timestamp
 *  is written into the JSON as digits, since it does not fit a JavaScript number exactly. */
function judge(input, blockTimestampNs) {
  const json = JSON.stringify({ ...input, block_timestamp_ns: '__BLOCK_TS__' }).replace('"__BLOCK_TS__"', blockTimestampNs);
  const run = spawnSync('cargo', ['run', '-q', '-p', 'kaap-core', '--example', 'hash_check'], { cwd: REPO, input: json, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`hash_check exited ${run.status}: ${(run.stderr || '').slice(0, 400)}`);
  return JSON.parse(run.stdout);
}

function show(label, analysis) {
  const codes = analysis.findings.map((f) => `${f.code} (${f.severity})`).join(', ') || 'none';
  console.log(`${label}: findings ${codes}; floor ${analysis.risk_floor}; must_veto ${analysis.must_veto}; veto_allowed ${analysis.veto_allowed}`);
  for (const e of analysis.effects) console.log(`    effect ${JSON.stringify(e)}`);
}

async function main() {
  console.log(`WO-04 testnet hash check, ${new Date().toISOString()}: ${memberId} files a sign proposal on ${dao}`);
  const member = accountFor(memberId);

  const plantedKey = `ed25519:${baseEncode(randomBytes(32))}`;
  const deadline = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  const message = JSON.stringify({ signer_id: dao, deadline, intents: [{ intent: 'add_public_key', public_key: plantedKey }] });
  const nonce = randomBytes(32);
  const recipient = 'intents.near';
  const payloadHash = nep413Hash(message, nonce, recipient);
  console.log(`text behind the hash (kept off chain): ${message}`);
  console.log(`recipient ${recipient}, nonce ${nonce.toString('base64')}, NEP-413 hash ${payloadHash}`);

  const args = { request: { path: dao, payload_v2: { Eddsa: payloadHash }, domain_id: 1 } };
  const kind = {
    FunctionCall: {
      receiver_id: MPC,
      actions: [{ method_name: 'sign', args: Buffer.from(JSON.stringify(args)).toString('base64'), deposit: '1', gas: (15n * TGAS).toString() }],
    },
  };
  const bond = BigInt((await viewFinal(dao, 'get_policy')).proposal_bond);
  const filed = await call(member, dao, 'add_proposal', { proposal: { description: DESCRIPTION, kind } }, 30n * TGAS, bond);
  if (filed.failure) throw new Error(`add_proposal failed in ${filed.hash}: ${refusal(filed.failure)}`);
  const id = returned(filed.outcome);
  const daoReceipt = filed.outcome.receipts_outcome.find((r) => r.outcome.executor_id === dao);
  const filedAt = await blockAt(daoReceipt.block_hash);
  console.log(`filed: proposal #${id} "${DESCRIPTION}", bond ${bond} yocto, at block ${filedAt.height}: ${txLink(filed.hash)}`);

  const read = await viewFinalRaw(dao, 'get_proposal', { id });
  const block = await provider.viewBlock({ blockId: read.blockHeight });
  const proposal = JSON.parse(read.text);
  const kindJson = kindBytes(read.text);
  if (JSON.stringify(JSON.parse(kindJson)) !== JSON.stringify(kind)) throw new Error('the stored kind is not the kind filed');
  console.log(`read:  #${id} at final block ${read.blockHeight} (timestamp ${block.header.timestamp_nanosec}), status ${proposal.status}, kind ${kindJson.length} bytes`);

  const input = {
    network: 'testnet',
    dao,
    proposal_id: id,
    description: proposal.description,
    kind_json: [...kindJson],
    policy_before: null,
    history: null,
    prices: { usd_by_token: {} },
    dao_version: null,
    supplied_text: null,
  };
  const blind = judge(input, block.header.timestamp_nanosec);
  show('without the text', blind);
  const withText = judge(
    { ...input, supplied_text: { message, nonce: [...nonce], recipient, standard: 'nep413', quotes: [] } },
    block.header.timestamp_nanosec,
  );
  show('with the text   ', withText);

  const codes = (a) => a.findings.map((f) => f.code);
  const sign = (a) => a.effects.find((e) => e.type === 'sign_request');
  const blindOk = codes(blind).includes('HASH_UNVERIFIED') && sign(blind)?.text_supplied === false && blind.risk_floor !== 'low' && !blind.must_veto;
  const keyAdded = withText.effects.some((e) => e.type === 'intents_key_change' && e.op === 'add' && e.public_key === plantedKey);
  const dangerousOk = codes(withText).includes('HASH_TEXT_DANGEROUS') && sign(withText)?.text_supplied === true && keyAdded && withText.must_veto;
  console.log(`check 1, no text: HASH_UNVERIFIED, text_supplied false, floor not low, no veto: ${blindOk ? 'pass' : 'FAIL'}`);
  console.log(`check 2, with text: HASH_TEXT_DANGEROUS, the planted key as an intents_key_change, must_veto: ${dangerousOk ? 'pass' : 'FAIL'}`);
  console.log(blindOk && dangerousOk ? 'RESULT: pass' : 'RESULT: FAIL');
  console.log(`the proposal is left to expire; nothing votes on it: https://testnet.nearblocks.io/address/${dao}`);
  process.exit(blindOk && dangerousOk ? 0 : 1);
}

try {
  await main();
} catch (e) {
  console.log(`RESULT: FAIL: ${e?.message ?? e}`);
  process.exit(1);
}
