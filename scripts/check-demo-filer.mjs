#!/usr/bin/env node
// Attacks the limited key behind the site's "try it yourself" button, then uses it the one way it
// is meant to be used. The key is supposed to be able to call add_proposal on the demo treasury
// and nothing else, so each attack below must be refused:
//
//   1. vote to approve a request on the treasury
//   2. send NEAR out of the member account
//   3. call add_proposal on a different contract
//   4. call add_proposal with a deposit attached
//   5. add another key to the member account
//
// Then it files the planted disguised payment with the key. With --wait it also waits for the
// running watcher to get the guard to reject it, sending nothing more itself.
//
// Testnet only. Inside WSL, with Node 24 and near-api-js 7.4.0 at the repo root, after
// scripts/setup-demo-filer.mjs:
//   node scripts/check-demo-filer.mjs [--wait]
// The key is read from packages/web/.env.local and never printed. Exit code 0 only when every
// attack was refused and the filing went through (and, with --wait, the guard alone rejected it).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  Account, KeyPair, KeyPairSigner, PublicKey, REPO, TGAS, actions, blockAt, call, loadState, provider, refusal, returned, send, sleep, txLink, viewFinal,
} from './setup-demo-dao.mjs';

const ENV_FILE = join(REPO, 'packages', 'web', '.env.local');
const WAIT_MS = 240_000;
const wait = process.argv[2] === '--wait';

function limitedSigner(accountId, expectedPublicKey) {
  const line = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8').split('\n').find((l) => l.startsWith('KAAP_DEMO_FILER_KEY=')) : undefined;
  const secret = line?.slice('KAAP_DEMO_FILER_KEY='.length).trim();
  if (!secret) throw new Error('no KAAP_DEMO_FILER_KEY in packages/web/.env.local: run scripts/setup-demo-filer.mjs first');
  const signer = new KeyPairSigner(KeyPair.fromString(secret));
  return signer.getPublicKey().then((publicKey) => {
    if (publicKey.toString() !== expectedPublicKey) throw new Error('the key in .env.local is not the one in deployments/testnet.json');
    return { account: new Account(accountId, provider, signer), signer };
  });
}

/** Why the network refused, in its own word, from an error or a failed outcome. */
const reasonOf = (text) => text.match(/MethodNameMismatch|ReceiverMismatch|DepositWithFunctionCall|RequiresFullAccess|NotEnoughAllowance|InvalidAccessKey\w*|ERR_[A-Z0-9_]+/)?.[0] ?? text.slice(0, 160);

async function main() {
  const state = loadState();
  const f = state.demo_filer;
  if (!f?.public_key) throw new Error('deployments/testnet.json has no demo_filer key: run scripts/setup-demo-filer.mjs first');
  const dao = state.dao.account_id;
  const guard = state.guard.account_id;
  const limited = await limitedSigner(f.account_id, f.public_key);
  const proposal = { description: f.description, kind: f.kind };
  console.log(`Kaap demo filer check, ${new Date().toISOString()}: key ${f.public_key} of ${f.account_id}`);

  const attacks = [
    ['vote to approve request #2 on the treasury', () => call(limited, dao, 'act_proposal', { id: 2, action: 'VoteApprove' }, 100n * TGAS)],
    ['send 1 yoctoNEAR out of the member account', () => send(limited, state.owner.account_id, [actions.transfer(1n)])],
    ['call add_proposal on a different contract', () => call(limited, guard, 'add_proposal', { proposal }, 30n * TGAS)],
    ['call add_proposal with a deposit attached', () => call(limited, dao, 'add_proposal', { proposal }, 30n * TGAS, 1n)],
    ['add another key to the member account', () => send(limited, f.account_id, [actions.addFullAccessKey(PublicKey.fromString(KeyPair.fromRandom('ed25519').getPublicKey().toString()))])],
  ];
  let refused = 0;
  for (const [what, attempt] of attacks) {
    try {
      const r = await attempt();
      if (r.failure) {
        refused += 1;
        console.log(`PASS  refused on chain: ${what} (${reasonOf(JSON.stringify(r.failure))}): ${txLink(r.hash)}`);
      } else {
        console.log(`FAIL  went through: ${what}: ${txLink(r.hash)}`);
      }
    } catch (e) {
      refused += 1;
      console.log(`PASS  refused before it ran: ${what} (${reasonOf(String(e?.message ?? e))})`);
    }
  }

  const filed = await call(limited, dao, 'add_proposal', { proposal }, 30n * TGAS);
  if (filed.failure) throw new Error(`the one allowed call failed in ${filed.hash}: ${refusal(filed.failure)}`);
  const id = returned(filed.outcome);
  const daoReceipt = filed.outcome.receipts_outcome.find((r) => r.outcome.executor_id === dao);
  const block = await blockAt(daoReceipt.block_hash);
  console.log(`PASS  the one allowed call: filed request #${id} at block ${block.height} (${new Date(block.ms).toISOString()}): ${txLink(filed.hash)}`);

  let rejected = true;
  if (wait) {
    console.log('now waiting for the watcher; this script sends nothing more');
    const until = Date.now() + WAIT_MS;
    let p = await viewFinal(dao, 'get_proposal', { id });
    while (p.status === 'InProgress' && Date.now() < until) {
      await sleep(1_000);
      p = await viewFinal(dao, 'get_proposal', { id });
    }
    const votes = Object.entries(p.votes ?? {});
    rejected = p.status === 'Rejected' && votes.length === 1 && votes[0][0] === guard && votes[0][1] === 'Reject';
    console.log(`status: ${p.status}, seen at final ${((Date.now() - block.ms) / 1000).toFixed(1)} s after the filing block; votes: {${votes.map(([who, v]) => `${who}: ${v}`).join(', ')}}`);
  }

  const ok = refused === attacks.length && rejected;
  console.log(ok ? `RESULT: pass, ${refused} of ${attacks.length} attacks refused${wait ? ', and the guard alone rejected the filed request' : ''}` : 'RESULT: FAIL');
  process.exit(ok ? 0 : 1);
}

try {
  await main();
} catch (e) {
  console.log(`RESULT: FAIL: ${e?.message ?? e}`);
  process.exit(1);
}
