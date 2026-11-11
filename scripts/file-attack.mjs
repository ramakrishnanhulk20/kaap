#!/usr/bin/env node
// Files M1's planted attack #17 on the demo treasury and then only watches: the running worker
// (bash scripts/run-worker-local.sh) must notice it, have it judged, record the verdict and cast the
// veto with no help from here. Exit code 0 only when the proposal ends Rejected by the guard's
// vote alone within the wait.
//
// Testnet only. Inside WSL, with Node 24 and near-api-js 7.4.0 at the repo root, while the worker
// runs in another shell:
//   node scripts/file-attack.mjs
// It signs as the demo member (files the proposal) and one fresh sub-account of the member that
// creates the payees, exactly as scripts/prove.mjs does. Keys are read from
// ~/.near-credentials/testnet and never printed.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MILLI_NEAR, PublicKey, REPO, TGAS, accountFor, actions, blockAt, call, loadState, newSavedKey, refusal, returned, send, sleep,
  stamp, toNear, txLink, viewFinal,
} from './setup-demo-dao.mjs';

const ATTACK = 'planted:17';
const ROOT_FUNDING = 100n * MILLI_NEAR;
const PAYEE_FUNDING = 10n * MILLI_NEAR;
const WAIT_MS = 240_000;

const state = loadState();
const dao = state.dao.account_id;
const memberId = state.dao.member.account_id;
const guard = state.guard.account_id;

/** Planted #17 with its sandbox names moved under `root`: the description names alice, the
 *  payment goes to the one-character lookalike a1ice. */
function attack(root) {
  const line = readFileSync(join(REPO, 'eval', 'planted', 'planted.jsonl'), 'utf8').split('\n').find((l) => l.trim() && JSON.parse(l).id === ATTACK);
  if (!line) throw new Error(`${ATTACK} is not in eval/planted/planted.jsonl`);
  const record = JSON.parse(line);
  const move = (text) => text.replace(/\b([a-z0-9][a-z0-9_-]*)\.sandbox\b/g, `$1.${root}`);
  const transfer = record.kind?.Transfer;
  if (!transfer || transfer.token_id !== '') throw new Error(`${ATTACK} is no longer a native NEAR Transfer`);
  const kind = { Transfer: { ...transfer, receiver_id: move(transfer.receiver_id) } };
  const description = move(record.description);
  const named = [...description.matchAll(new RegExp(`[a-z0-9][a-z0-9_-]*\\.${root.replaceAll('.', '\\.')}`, 'g'))].map((m) => m[0]);
  return { description, kind, payees: [...new Set([kind.Transfer.receiver_id, ...named])] };
}

async function main() {
  console.log(`WO-06 attack filer, ${new Date().toISOString()}: files ${ATTACK} on ${dao}; the worker does the rest`);
  if (!(await viewFinal(guard, 'is_enrolled', { dao }))) throw new Error(`${dao} is not enrolled in ${guard}`);
  const member = accountFor(memberId);

  const rootId = `w6-${stamp()}.${memberId}`;
  const made = await send(member, rootId, [actions.createAccount(), actions.transfer(ROOT_FUNDING), actions.addFullAccessKey(PublicKey.fromString(newSavedKey(rootId)))]);
  if (made.failure) throw new Error(`creating ${rootId} failed in ${made.hash}: ${refusal(made.failure)}`);
  console.log(`payees root: ${rootId}: ${txLink(made.hash)}`);
  const root = accountFor(rootId);
  const c = attack(rootId);
  for (const payee of c.payees) {
    const r = await send(root, payee, [actions.createAccount(), actions.transfer(PAYEE_FUNDING)]);
    if (r.failure) throw new Error(`creating ${payee} failed in ${r.hash}: ${refusal(r.failure)}`);
    console.log(`payee:       ${payee}: ${txLink(r.hash)}`);
  }

  const filed = await call(member, dao, 'add_proposal', { proposal: { description: c.description, kind: c.kind } }, 30n * TGAS);
  if (filed.failure) throw new Error(`add_proposal failed in ${filed.hash}: ${refusal(filed.failure)}`);
  const id = returned(filed.outcome);
  const daoReceipt = filed.outcome.receipts_outcome.find((r) => r.outcome.executor_id === dao);
  const block = await blockAt(daoReceipt.block_hash);
  console.log(`filed:       proposal #${id}, "${c.description}", Transfer of ${toNear(c.kind.Transfer.amount)} NEAR to ${c.kind.Transfer.receiver_id}`);
  console.log(`add_proposal at block ${block.height} (${new Date(block.ms).toISOString()}): ${txLink(filed.hash)}`);
  console.log('now waiting; this script sends nothing more');

  const until = Date.now() + WAIT_MS;
  let p = await viewFinal(dao, 'get_proposal', { id });
  while (p.status === 'InProgress' && Date.now() < until) {
    await sleep(1_000);
    p = await viewFinal(dao, 'get_proposal', { id });
  }
  const votes = Object.entries(p.votes ?? {});
  console.log(`status: ${p.status}, seen at final ${((Date.now() - block.ms) / 1000).toFixed(1)} s after the add_proposal block`);
  console.log(`votes: {${votes.map(([who, v]) => `${who}: ${v}`).join(', ')}}`);
  const byGuardAlone = p.status === 'Rejected' && votes.length === 1 && votes[0][0] === guard && votes[0][1] === 'Reject';
  console.log(byGuardAlone ? 'RESULT: pass, rejected by the guard alone, with no step from this script' : 'RESULT: FAIL, the worker did not get the guard to reject it in time');
  process.exit(byGuardAlone ? 0 : 1);
}

try {
  await main();
} catch (e) {
  console.log(`RESULT: FAIL: ${e?.message ?? e}`);
  process.exit(1);
}
