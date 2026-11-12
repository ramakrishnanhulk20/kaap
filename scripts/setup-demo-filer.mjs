#!/usr/bin/env node
// Sets up, once, what the site's "try it yourself" button needs on testnet:
//
//   1. Two payee accounts under the demo member: alice.tryit.<member> and its one-character
//      lookalike a1ice.tryit.<member>, so every press files the same disguised payment (planted
//      attack #17, the one scripts/prove.mjs files).
//   2. A new access key on the demo member that can call one method, add_proposal, on the demo
//      treasury and nothing else. It cannot vote, cannot pay, cannot attach a deposit and cannot
//      reach any other contract. The treasury's proposal bond is 0, so filing needs no deposit.
//
// The limited key's secret half is written to packages/web/.env.local (git-ignored) as
// KAAP_DEMO_FILER_KEY and is never printed. Everything public goes to deployments/testnet.json
// under `demo_filer`.
//
// Testnet only. Inside WSL, with Node 24 and near-api-js 7.4.0 at the repo root:
//   node scripts/setup-demo-filer.mjs            sets up what is missing, checks what is there
//   node scripts/setup-demo-filer.mjs --rotate   also replaces the limited key with a new one
//   node scripts/setup-demo-filer.mjs --remove   deletes the limited key: the button stops working
// It signs as the demo member, whose key is read from ~/.near-credentials/testnet.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEPLOYMENTS, KeyPair, MILLI_NEAR, PublicKey, REPO, accountFor, accountState, actions, loadState, newSavedKey, refusal, send, sleep, txLink, viewFinal,
} from './setup-demo-dao.mjs';
import { plantedTransfer } from './lib/planted.mjs';

const ATTACK = 'planted:17';
const METHOD = 'add_proposal';
const ENV_NAME = 'KAAP_DEMO_FILER_KEY';
const ENV_FILE = join(REPO, 'packages', 'web', '.env.local');
const RPC = process.env.KAAP_TESTNET_RPC || 'https://rpc.testnet.fastnear.com';
const ROOT_FUNDING = 100n * MILLI_NEAR;
const PAYEE_FUNDING = 10n * MILLI_NEAR;
// What the key may spend on gas in all. One filing burns about 0.0003 NEAR.
const ALLOWANCE = 1000n * MILLI_NEAR;

const mode = process.argv[2] ?? '';
if (!['', '--rotate', '--remove'].includes(mode)) throw new Error('usage: setup-demo-filer.mjs [--rotate | --remove]');

/** The access key `publicKey` of `accountId` as the chain holds it, or null when it has none. */
async function accessKey(accountId, publicKey) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'kaap', method: 'query', params: { request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey } }),
  });
  const body = await res.json();
  if (body.result?.permission) return body.result;
  if (/does not exist|UNKNOWN_ACCESS_KEY/i.test(JSON.stringify(body))) return null;
  throw new Error(`reading the access key failed: ${JSON.stringify(body).slice(0, 200)}`);
}

async function waitForKey(accountId, publicKey, present) {
  for (let i = 0; i < 45; i++) {
    if (((await accessKey(accountId, publicKey)) !== null) === present) return;
    await sleep(2000);
  }
  throw new Error(`the key was ${present ? 'not seen' : 'still seen'} at final finality after 90 s`);
}

/** The secret key saved in .env.local, or null. */
function savedSecret() {
  if (!existsSync(ENV_FILE)) return null;
  const line = readFileSync(ENV_FILE, 'utf8').split('\n').find((l) => l.startsWith(`${ENV_NAME}=`));
  const value = line?.slice(ENV_NAME.length + 1).trim();
  return value ? value : null;
}

function saveSecret(secret) {
  const kept = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith(`${ENV_NAME}=`)) : [];
  const lines = secret === null ? kept : [...kept, `${ENV_NAME}=${secret}`];
  writeFileSync(ENV_FILE, lines.length ? `${lines.join('\n')}\n` : '', { mode: 0o600 });
}

const isLimited = (key, dao) => {
  const call = key?.permission?.FunctionCall;
  return Boolean(call) && call.receiver_id === dao && call.method_names.length === 1 && call.method_names[0] === METHOD;
};

async function main() {
  const state = loadState();
  const dao = state.dao.account_id;
  const memberId = state.dao.member.account_id;
  const member = accountFor(memberId);
  console.log(`Kaap demo filer setup, ${new Date().toISOString()}: ${memberId} on ${dao}`);

  const policy = await viewFinal(dao, 'get_policy');
  if (String(policy.proposal_bond) !== '0') throw new Error(`the treasury's proposal bond is ${policy.proposal_bond}, not 0: a limited key cannot attach a deposit`);

  const record = state.demo_filer ?? { set_up_by: 'scripts/setup-demo-filer.mjs' };

  if (mode === '--remove' || mode === '--rotate') {
    const old = record.public_key;
    if (old && (await accessKey(memberId, old))) {
      const r = await send(member, memberId, [actions.deleteKey(PublicKey.fromString(old))]);
      if (r.failure) throw new Error(`deleting the limited key failed in ${r.hash}: ${refusal(r.failure)}`);
      await waitForKey(memberId, old, false);
      console.log(`limited key removed: ${txLink(r.hash)}`);
      record.removed_key_tx = r.hash;
    }
    saveSecret(null);
    delete record.public_key;
    delete record.add_key_tx;
    if (mode === '--remove') {
      state.demo_filer = record;
      writeFileSync(DEPLOYMENTS, JSON.stringify(state, null, 2) + '\n');
      console.log('RESULT: the limited key is gone; the button cannot file');
      return;
    }
  }

  const rootId = `tryit.${memberId}`;
  const c = plantedTransfer(REPO, ATTACK, rootId);
  if (!(await accountState(rootId))) {
    const made = await send(member, rootId, [actions.createAccount(), actions.transfer(ROOT_FUNDING), actions.addFullAccessKey(PublicKey.fromString(newSavedKey(rootId)))]);
    if (made.failure) throw new Error(`creating ${rootId} failed in ${made.hash}: ${refusal(made.failure)}`);
    console.log(`payees root: ${rootId}: ${txLink(made.hash)}`);
    record.payees_root_tx = made.hash;
  }
  record.payee_txs ??= {};
  for (const payee of c.accounts) {
    if (await accountState(payee)) continue;
    const r = await send(accountFor(rootId), payee, [actions.createAccount(), actions.transfer(PAYEE_FUNDING)]);
    if (r.failure) throw new Error(`creating ${payee} failed in ${r.hash}: ${refusal(r.failure)}`);
    console.log(`payee:       ${payee}: ${txLink(r.hash)}`);
    record.payee_txs[payee] = r.hash;
  }

  // The key in .env.local is kept when the chain still holds its public half with exactly the
  // one permission. Anything else gets a new key, and the old public key is left to --rotate.
  let secret = savedSecret();
  let publicKey = null;
  try {
    publicKey = secret ? KeyPair.fromString(secret).getPublicKey().toString() : null;
  } catch {
    secret = null;
  }
  if (!publicKey || !isLimited(await accessKey(memberId, publicKey), dao)) {
    const keyPair = KeyPair.fromRandom('ed25519');
    publicKey = keyPair.getPublicKey().toString();
    // Saved before the key exists on chain, so a crash never leaves a key nobody holds.
    saveSecret(keyPair.toString());
    const r = await send(member, memberId, [actions.addFunctionCallAccessKey(PublicKey.fromString(publicKey), dao, [METHOD], ALLOWANCE)]);
    if (r.failure) throw new Error(`adding the limited key failed in ${r.hash}: ${refusal(r.failure)}`);
    await waitForKey(memberId, publicKey, true);
    console.log(`limited key added: ${txLink(r.hash)}`);
    record.add_key_tx = r.hash;
  }

  const onChain = await accessKey(memberId, publicKey);
  if (!isLimited(onChain, dao)) throw new Error('the key on chain is not limited to add_proposal on the treasury');
  Object.assign(record, {
    account_id: memberId,
    public_key: publicKey,
    can_call: { contract: dao, methods: [METHOD], allowance_yocto: String(onChain.permission.FunctionCall.allowance) },
    planted: ATTACK,
    payees_root: rootId,
    description: c.description,
    kind: c.kind,
  });
  state.demo_filer = record;
  writeFileSync(DEPLOYMENTS, JSON.stringify(state, null, 2) + '\n');

  console.log(`limited key:  ${publicKey}`);
  console.log(`it can call:  ${METHOD} on ${dao}, and nothing else; gas allowance left ${(Number(BigInt(onChain.permission.FunctionCall.allowance) / MILLI_NEAR) / 1000).toFixed(3)} NEAR`);
  console.log(`it files:     "${c.description}", a Transfer to ${c.kind.Transfer.receiver_id}`);
  console.log(`secret half:  in packages/web/.env.local as ${ENV_NAME}, not printed`);
  console.log('RESULT: pass');
}

try {
  await main();
} catch (e) {
  console.log(`RESULT: FAIL: ${e?.message ?? e}`);
  process.exit(1);
}
