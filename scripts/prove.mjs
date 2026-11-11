#!/usr/bin/env node
// Kaap's whole promise once, end to end on the live testnet, from one command. A disguised
// payment (planted attack #17: the description names alice, the payment goes to the lookalike
// a1ice) is filed on the demo treasury, a Sputnik DAO 3.2 with a NEAR Business policy. Kaap's
// sealed job on OutLayer judges it and signs a verdict, the verdict is recorded in kaap-registry,
// and kaap-guard's VoteReject kills the proposal. The same verdict is then handed to the guard a
// second time and must be refused. Last, an honest payment (planted control #57) goes the same
// way and must be recorded, refused by the guard and left InProgress.
//
// Exit code 0 only when the attack ends Rejected by the guard's vote alone, the replay is
// refused with ERR_REPLAY, and the control is recorded with no critical finding and no vote.
//
// Testnet only. Run inside WSL after scripts/setup-demo-dao.mjs, with Node 24 and
// near-api-js 7.4.0 at the repo root:
//   node scripts/prove.mjs
// It signs as the demo member (files the proposals), the worker kaap-worker-1029053612.testnet
// (the only caller whose verdicts the guard accepts, because OutLayer binds the signing key to
// the caller) and one fresh sub-account of the member per run that creates the payees. Their keys are read
// from ~/.near-credentials/testnet and never printed.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GUARD_ROLE, MILLI_NEAR, NETWORK, PublicKey, REPO, SPUTNIK_CODE_HASH, TGAS, accountFor, accountState, actions,
  blockAt, burnt, call, events, loadState, newSavedKey, refusal, returned, send, sleep, stamp, toNear, txLink,
  viewFinal, viewFinalRaw,
} from './setup-demo-dao.mjs';

const PLANTED = join(REPO, 'eval', 'planted', 'planted.jsonl');
const CHECK_OUTPUT = join(REPO, 'packages', 'sealed', 'tools', 'check-output.mjs');
const ATTACK = 'planted:17';
// An honest Transfer whose description states the same amount and recipient it pays.
const CONTROL = 'planted:57';
const OUTLAYER = 'outlayer.testnet';
const DOMAIN = Buffer.from('kaap-verdict-v1\n');
// Ten minutes, as scripts/run-sealed-testnet.sh asks: the guard's vote lands well inside it.
const EXPIRES_IN_MS = 600_000;
// A payee account holds no key and no code; 0.01 NEAR keeps it well above its own storage cost.
const PAYEE_FUNDING = 10n * MILLI_NEAR;
// The run's payee parent pays for three payees and their gas out of this. Each account creation
// must show about 0.0175 NEAR up front (0.01 deposit plus fees at the node's worst-case gas
// price), so 0.05 NEAR ran out on the third; what is left stays ours and is counted back.
const ROOT_FUNDING = 100n * MILLI_NEAR;
// kaap-registry's README: 0.02 NEAR always covers a record; the registry keeps what it measures
// and refunds the rest in the same transaction.
const RECORD_DEPOSIT = 20n * MILLI_NEAR;

const state = loadState();
const guard = state.guard.account_id;
const registry = state.registry.account_id;
const dao = state.dao?.account_id;
const memberId = state.dao?.member?.account_id;
const workerId = state.sealed.worker_account;
const failures = [];
const spent = { gas: 0n, outlayer: 0n, registryStorage: 0n, payees: 0n };
const fail = (why) => {
  failures.push(why);
  console.log(`  FAIL: ${why}`);
};
const votesText = (votes) => `{${Object.entries(votes ?? {}).map(([who, vote]) => `${who}: ${vote}`).join(', ')}}`;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const ledger = [];
function tally(outcome) {
  const gas = burnt(outcome);
  spent.gas += gas;
  const fc = outcome.transaction.actions?.find((a) => a.FunctionCall)?.FunctionCall;
  const units = [outcome.transaction_outcome, ...outcome.receipts_outcome].reduce((sum, o) => sum + BigInt(o.outcome.gas_burnt), 0n);
  ledger.push({ what: fc ? `${outcome.transaction.receiver_id}.${fc.method_name}` : `create ${outcome.transaction.receiver_id}`, gas, units, ok: !outcome.status?.Failure });
}

/** A planted record with its sandbox accounts moved under `root`, so `alice.sandbox` and
 *  `a1ice.sandbox` become `alice.<root>` and `a1ice.<root>` and still differ in one character. */
function planted(id, root) {
  const line = readFileSync(PLANTED, 'utf8').split('\n').find((l) => l.trim() && JSON.parse(l).id === id);
  if (!line) throw new Error(`${id} is not in eval/planted/planted.jsonl`);
  const record = JSON.parse(line);
  const transfer = record.kind?.Transfer;
  if (!transfer || transfer.token_id !== '' || transfer.msg !== null) throw new Error(`${id} is no longer a native NEAR Transfer`);
  const move = (text) => text.replace(/\b([a-z0-9][a-z0-9_-]*)\.sandbox\b/g, `$1.${root}`);
  const description = move(record.description);
  const kind = { Transfer: { ...transfer, receiver_id: move(transfer.receiver_id) } };
  const named = [...description.matchAll(new RegExp(`[a-z0-9][a-z0-9_-]*\\.${root.replaceAll('.', '\\.')}`, 'g'))].map((m) => m[0]);
  return { id, attack: record.attack, description, kind, named, payee: kind.Transfer.receiver_id };
}

/** The kind exactly as get_proposal returned it (C5). JSON.stringify of the parsed kind is only
 *  accepted when that exact text sits in the raw answer as the kind's value, so what the guard
 *  forwards is the bytes read, never a re-encoding. */
function kindAsRead(text) {
  const kindJson = JSON.stringify(JSON.parse(text).kind);
  if (!text.includes(`"kind":${kindJson}`)) throw new Error('could not take the kind out of get_proposal byte for byte');
  return kindJson;
}

async function readAtFinal(id, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      const { text, blockHeight } = await viewFinalRaw(dao, 'get_proposal', { id });
      return { text, proposal: JSON.parse(text), blockHeight };
    } catch (e) {
      if (Date.now() > until) throw new Error(`proposal #${id} was not readable at final finality: ${e?.message ?? e}`);
      await sleep(1000);
    }
  }
}

async function runSealedJob(worker, id) {
  const input = JSON.stringify({ v: 1, network: NETWORK, guard, dao, proposal_id: id, expires_in_ms: EXPIRES_IN_MS });
  // All three limits written out on every run: an empty resource_limits object is never picked
  // up (OutLayer issue #31). The same values as scripts/run-sealed-testnet.sh.
  const args = {
    source: { Project: { project_id: state.sealed.project_id, version_key: null } },
    input_data: input,
    response_format: 'Json',
    resource_limits: { max_instructions: 10_000_000_000, max_memory_mb: 128, max_execution_seconds: 60 },
  };
  const { hash, outcome, failure } = await call(worker, OUTLAYER, 'request_execution', args, 300n * TGAS, 20n * MILLI_NEAR);
  tally(outcome);
  if (failure) throw new Error(`request_execution failed in ${hash}: ${refusal(failure)}`);
  const text = Buffer.from(outcome.status.SuccessValue, 'base64').toString('utf8');
  const completed = events(outcome).find((e) => e.event === 'execution_completed')?.data?.[0];
  const charge = BigInt(completed?.payment_charged ?? 0);
  spent.outlayer += charge;
  return { hash, text, output: JSON.parse(text), charge, workerMs: completed?.resources_used?.time_ms ?? null };
}

/** Checks the output twice: packages/sealed/tools/check-output.mjs verifies the signature under
 *  the printed key, decodes the verdict and requires the printed key to be the guard's
 *  accepted_key(); near-api-js then verifies the same bytes under accepted_key() directly. */
function checkVerdict(job, id, acceptedKey, dir) {
  const file = join(dir, `${id}.output.json`);
  writeFileSync(file, job.text);
  const run = spawnSync(process.execPath, [CHECK_OUTPUT, file, '--dao', dao, '--id', String(id), '--network', NETWORK, '--guard', guard, '--key', acceptedKey], { encoding: 'utf8' });
  let result;
  try {
    result = JSON.parse(run.stdout.trim().split('\n').pop());
  } catch {
    throw new Error(`check-output printed nothing readable: ${run.stderr.slice(0, 300)}`);
  }
  if (run.status !== 0 || result.check !== 'passed') throw new Error(`check-output refused the verdict: ${result.why ?? result.check}`);
  const signed = Buffer.concat([DOMAIN, Buffer.from(job.output.verdict, 'base64')]);
  if (!PublicKey.fromString(acceptedKey).verify(signed, Buffer.from(job.output.signature, 'base64'))) {
    throw new Error(`the signature does not verify under ${acceptedKey}`);
  }
  return { verdict: result.verdict, verdictHash: sha256(signed) };
}

async function fileProposal(member, c) {
  const { hash, outcome, failure } = await call(member, dao, 'add_proposal', { proposal: { description: c.description, kind: c.kind } }, 30n * TGAS);
  tally(outcome);
  if (failure) throw new Error(`add_proposal failed in ${hash}: ${refusal(failure)}`);
  const daoReceipt = outcome.receipts_outcome.find((r) => r.outcome.executor_id === dao);
  return { id: returned(outcome), hash, block: await blockAt(daoReceipt.block_hash) };
}

async function record(worker, job) {
  const { hash, outcome, failure } = await call(worker, registry, 'record', { verdict: job.output.verdict, signature: job.output.signature }, 30n * TGAS, RECORD_DEPOSIT);
  tally(outcome);
  if (failure) throw new Error(`registry.record failed in ${hash}: ${refusal(failure)}`);
  const entry = events(outcome).find((e) => e.by === registry && e.event === 'verdict_recorded')?.data?.[0];
  spent.registryStorage += BigInt(entry?.storage_cost ?? 0);
  return { hash, entry, block: await blockAt(outcome.receipts_outcome.find((r) => r.outcome.executor_id === registry).block_hash) };
}

async function veto(worker, job, kindJson) {
  const { hash, outcome, failure } = await call(worker, guard, 'veto', { verdict: job.output.verdict, signature: job.output.signature, kind_json: kindJson }, 300n * TGAS);
  tally(outcome);
  return { hash, outcome, failure };
}

/** Every receipt the guard created in a veto transaction, with the arguments it sent. */
function guardCalls(outcome) {
  return outcome.receipts
    .filter((r) => r.predecessor_id === guard)
    .flatMap((r) =>
      (r.receipt?.Action?.actions ?? []).map((a) => ({
        receiptId: r.receipt_id,
        to: r.receiver_id,
        kind: Object.keys(a)[0],
        method: a.FunctionCall?.method_name,
        args: a.FunctionCall ? Buffer.from(a.FunctionCall.args, 'base64').toString('utf8') : null,
      })),
    );
}

/** A case's planted record, refused unless it still has the shape this proof is about: the
 *  attack names one account and pays a one-character lookalike of it, the control names the
 *  account it pays. */
function caseFor(which, root) {
  const c = planted(which === 'attack' ? ATTACK : CONTROL, root);
  const [named] = c.named;
  const lookalike = c.named.length === 1 && named !== c.payee && named.length === c.payee.length
    && [...named].filter((ch, i) => ch !== c.payee[i]).length === 1;
  const honest = c.named.length === 1 && named === c.payee;
  if (which === 'attack' ? !lookalike : !honest) throw new Error(`${c.id} no longer has the shape this proof files`);
  return { ...c, which };
}

async function settled(id, wantChange) {
  let after = (await readAtFinal(id)).proposal;
  for (let i = 0; wantChange && i < 10 && after.status === 'InProgress'; i++) {
    await sleep(1000);
    after = (await readAtFinal(id)).proposal;
  }
  return after;
}

async function runCase(c, member, worker, acceptedKey, dir) {
  console.log(`\n== ${c.which}: ${c.id}, ${c.attack}`);
  console.log(`description: "${c.description}"`);
  console.log(`kind:        Transfer of ${toNear(c.kind.Transfer.amount)} NEAR to ${c.payee}`);

  const filed = await fileProposal(member, c);
  console.log(`filed:       proposal #${filed.id} by ${memberId}, add_proposal at block ${filed.block.height}: ${txLink(filed.hash)}`);
  const read = await readAtFinal(filed.id);
  const kindJson = kindAsRead(read.text);
  console.log(`final:       #${filed.id} readable at final block ${read.blockHeight}, status ${read.proposal.status}, kind ${Buffer.byteLength(kindJson)} bytes`);

  const job = await runSealedJob(worker, filed.id);
  console.log(`sealed job:  status ${job.output.status}, OutLayer charge ${toNear(job.charge)} NEAR, worker ${job.workerMs} ms: ${txLink(job.hash)}`);
  if (job.output.status !== 'ok') {
    fail(`C22: the sealed job held #${filed.id} (${job.output.reason}); nothing was signed, so nothing is vetoed`);
    return null;
  }
  const { verdict, verdictHash } = checkVerdict(job, filed.id, acceptedKey, dir);
  console.log(`verdict risk: ${verdict.risk}, floor: ${verdict.floor}, findings: [${verdict.findings.join(', ')}], ai_status: ${verdict.ai_status}`);
  console.log(`explanation: ${job.output.explanation}`);
  console.log(`sealed signature: valid for key ${acceptedKey} (accepted by guard)`);
  console.log(`verdict:     names guard ${verdict.guard}, ${verdict.network}, ${verdict.dao}, #${verdict.proposal_id}, kind_hash ${verdict.kind_hash.slice(0, 16)}..., read at block ${verdict.block_height}, expires ${new Date(Number(verdict.expires_at_ms)).toISOString()}`);

  const rec = await record(worker, job);
  console.log(`recorded:    registry index ${rec.entry?.index}, storage kept ${toNear(rec.entry?.storage_cost ?? 0)} NEAR, refunded ${toNear(rec.entry?.refund ?? 0)} NEAR, block ${rec.block.height}: ${txLink(rec.hash)}`);
  const latest = await viewFinal(registry, 'latest', { network: NETWORK, dao, proposal_id: filed.id });
  if (latest?.verdict_hash !== verdictHash) fail(`registry.latest for #${filed.id} is ${latest?.verdict_hash}, not the verdict just recorded`);
  console.log(`registry:    latest(${NETWORK}, ${dao}, ${filed.id}) = risk ${latest?.risk}, floor ${latest?.floor}, findings [${latest?.findings?.join(', ')}], recorded by ${latest?.recorded_by}`);

  // The control's verdict goes to the guard too: a validly signed verdict that is not critical
  // must be refused by the guard itself, not just left unsent by Kaap's worker.
  const v = await veto(worker, job, kindJson);
  if (c.which === 'control') {
    const why = v.failure ? refusal(v.failure) : null;
    console.log(`veto try:    ${why ? `refused by the guard with ${why}` : 'ACCEPTED by the guard'}: ${txLink(v.hash)}`);
    const after = await settled(filed.id, false);
    const noVotes = Object.keys(after.votes ?? {}).length === 0;
    console.log(`status: ${after.status}`);
    console.log(noVotes ? 'no veto' : `VETOED: votes ${votesText(after.votes)}`);
    console.log(`votes: ${votesText(after.votes)}`);
    if (why !== 'ERR_NOT_VETOABLE') fail(`the guard answered the control's verdict with ${why ?? 'a vote'}, not ERR_NOT_VETOABLE`);
    if (after.status !== 'InProgress' || !noVotes) fail(`control #${filed.id} is ${after.status} with votes ${votesText(after.votes)}`);
    const critical = verdict.risk === 'critical' || verdict.floor === 'critical';
    if (critical) fail(`the control's verdict is ${verdict.risk} on a ${verdict.floor} floor`);
    console.log(`C9  ${critical ? 'BROKEN' : 'held'}: an honest payment gets ${verdict.risk} on a ${verdict.floor} floor, no critical finding, and the guard refuses to vote on it (${why})`);
    console.log(`C22 held: the job signed only because both providers agreed at final block ${verdict.block_height}`);
    return { filed, verdict, after };
  }

  if (v.failure) {
    fail(`the guard refused the veto: ${refusal(v.failure)} (${txLink(v.hash)})`);
    return null;
  }
  const calls = guardCalls(v.outcome);
  const vote = calls.find((x) => x.to === dao);
  const voteOutcome = v.outcome.receipts_outcome.find((o) => o.id === vote?.receiptId);
  const voteBlock = voteOutcome ? await blockAt(voteOutcome.block_hash) : null;
  console.log(`veto:        ${guard} -> ${dao}.act_proposal ${vote?.args?.slice(0, 40)}... at block ${voteBlock?.height}: ${txLink(v.hash)}`);
  const cast = events(v.outcome).find((e) => e.by === guard && e.event === 'veto_cast');
  const result = await viewFinal(guard, 'veto_result', { verdict_hash_hex: verdictHash });
  console.log(`guard:       veto_cast ${cast ? 'emitted' : 'missing'}, veto_result(${verdictHash.slice(0, 12)}...) = ${JSON.stringify(result)}`);

  const after = await settled(filed.id, true);
  console.log(`status: ${after.status}`);
  console.log(`votes: ${votesText(after.votes)}`);
  const onlyGuard = Object.keys(after.votes ?? {}).length === 1 && after.votes[guard] === 'Reject';
  if (after.status !== 'Rejected' || !onlyGuard) fail(`#${filed.id} is ${after.status} with votes ${votesText(after.votes)}, not Rejected by the guard's vote alone`);
  if (result !== 'Ok' || !cast) fail(`the guard did not record its vote as cast`);

  const replay = await veto(worker, job, kindJson);
  const replayWhy = replay.failure ? refusal(replay.failure) : null;
  console.log(`replay:      the same verdict and kind again: ${replayWhy ? `refused with ${replayWhy}` : 'ACCEPTED'}: ${txLink(replay.hash)}`);
  if (replayWhy !== 'ERR_REPLAY') fail(`C19: the replay was answered with ${replayWhy ?? 'a second vote'}, not ERR_REPLAY`);

  const c5 = vote?.method === 'act_proposal' && vote.args === `{"id":${filed.id},"action":"VoteReject","proposal":${kindJson}}`;
  const others = calls.filter((x) => x !== vote);
  const c15 = c5 && others.length === 1 && others[0].to === guard && others[0].method === 'on_veto_result' && onlyGuard;
  const c9 = verdict.risk === 'critical' && verdict.floor === 'critical' && verdict.findings.includes('DESC_CONTRADICTS') && verdict.ai_status !== 'verified';
  if (!c5) fail('C5: the vote did not carry the kind byte for byte as get_proposal returned it');
  if (!c15) fail(`C15: the guard made calls other than one VoteReject: ${JSON.stringify(calls.map((x) => [x.to, x.kind, x.method]))}`);
  if (!c9) fail(`C9: the veto rested on ${verdict.risk}/${verdict.floor} [${verdict.findings}] with AI ${verdict.ai_status}`);
  console.log(`C5  ${c5 ? 'held' : 'BROKEN'}: the vote's proposal is the ${Buffer.byteLength(kindJson)} bytes get_proposal returned at final block ${read.blockHeight}, unchanged; the guard matched their canonical hash to the verdict's kind_hash and Sputnik matched them to the stored kind (else ERR_WRONG_KIND_HASH or ERR_WRONG_KIND)`);
  console.log(`C9  ${c9 ? 'held' : 'BROKEN'}: critical on a critical plain-code floor (DESC_CONTRADICTS) with ai_status ${verdict.ai_status}, so plain code alone carried the veto`);
  console.log(`C15 ${c15 ? 'held' : 'BROKEN'}: the guard's only receipts were ${dao}.act_proposal with action VoteReject and its own on_veto_result; the votes map holds only the guard's Reject`);
  console.log(`C19 ${replayWhy === 'ERR_REPLAY' ? 'held' : 'BROKEN'}: the verdict names this guard, network, DAO, proposal and kind with an expiry, and its second use was refused with ${replayWhy ?? 'nothing'}`);
  console.log(`C22 held: the job signed only because both providers agreed at final block ${verdict.block_height}; a disagreement prints held, signs nothing, and fails this case`);

  const seconds = voteBlock ? (voteBlock.ms - filed.block.ms) / 1000 : null;
  console.log(`time:        ${seconds?.toFixed(1)} s from the add_proposal block ${filed.block.height} to the guard's vote at block ${voteBlock?.height} (${voteBlock ? voteBlock.height - filed.block.height : '?'} blocks)`);
  return { filed, verdict, after, seconds };
}

async function main() {
  console.log(`Kaap end-to-end proof on ${NETWORK}, ${new Date().toISOString()}`);
  if (!dao || !memberId) throw new Error('no demo DAO in deployments/testnet.json: run scripts/setup-demo-dao.mjs first');
  const daoState = await accountState(dao);
  if (daoState?.code_hash !== SPUTNIK_CODE_HASH) throw new Error(`${dao} runs ${daoState?.code_hash}, not Sputnik 3.2`);
  if (!(await viewFinal(guard, 'is_enrolled', { dao }))) throw new Error(`${dao} is not enrolled in ${guard}: run scripts/setup-demo-dao.mjs`);
  const policy = await viewFinal(dao, 'get_policy');
  const guardRole = policy.roles.find((r) => r.name === GUARD_ROLE);
  if (JSON.stringify(guardRole?.kind) !== JSON.stringify({ Group: [guard] })) throw new Error(`${dao} has no guard role held by ${guard} alone`);
  const acceptedKey = await viewFinal(guard, 'accepted_key');
  if (acceptedKey !== state.accepted_key) throw new Error(`the guard now accepts ${acceptedKey}, not the recorded ${state.accepted_key}`);
  console.log(`DAO ${dao} (Sputnik ${SPUTNIK_CODE_HASH}), enrolled in ${guard}, guard accepts ${acceptedKey}`);

  const member = accountFor(memberId);
  const worker = accountFor(workerId);
  const before = await Promise.all([member, worker].map(async (s) => (await accountState(s.account.accountId)).amount));
  // The faucet gives one account per machine every few hours, so each run's payees live under a
  // fresh sub-account of the demo member: alice.sandbox becomes alice.<that account>.
  const rootId = `m1-${stamp()}.${memberId}`;
  const rootKey = newSavedKey(rootId);
  const made = await send(member, rootId, [actions.createAccount(), actions.transfer(ROOT_FUNDING), actions.addFullAccessKey(PublicKey.fromString(rootKey))]);
  tally(made.outcome);
  if (made.failure) throw new Error(`creating ${rootId} failed in ${made.hash}: ${refusal(made.failure)}`);
  const root = accountFor(rootId);
  console.log(`payees root: ${rootId}, made by ${memberId} with ${toNear(ROOT_FUNDING)} NEAR: ${txLink(made.hash)}`);
  const signers = [member, worker, root];
  const dir = mkdtempSync(join(tmpdir(), 'kaap-m1-'));

  const cases = [caseFor('attack', rootId), caseFor('control', rootId)];
  const payees = new Set(cases.flatMap((c) => [c.payee, ...c.named]));
  for (const payee of payees) {
    const { hash, outcome, failure } = await send(root, payee, [actions.createAccount(), actions.transfer(PAYEE_FUNDING)]);
    tally(outcome);
    if (failure) throw new Error(`creating ${payee} failed in ${hash}: ${refusal(failure)}`);
    spent.payees += PAYEE_FUNDING;
    console.log(`payee:       ${payee} created with ${toNear(PAYEE_FUNDING)} NEAR and no key: ${txLink(hash)}`);
  }

  const attack = await runCase(cases[0], member, worker, acceptedKey, dir);
  await runCase(cases[1], member, worker, acceptedKey, dir);

  const after = await Promise.all(signers.map(async (s) => (await accountState(s.account.accountId)).amount));
  // What is left in the payee parent is still ours, so it counts against what was paid.
  const paid = before.reduce((sum, b) => sum + BigInt(b), 0n) - after.reduce((sum, a) => sum + BigInt(a), 0n);
  console.log(`\n== testnet NEAR spent by this run (${ledger.length} transactions)`);
  console.log(`paid by ${signers.map((s) => s.account.accountId).join(', ')}: ${toNear(paid)} NEAR (balances before and after)`);
  console.log(`  gas burnt ${toNear(spent.gas)}, OutLayer ${toNear(spent.outlayer)}, registry storage ${toNear(spent.registryStorage)}, moved to the new payees ${toNear(spent.payees)}`);
  for (const t of ledger) console.log(`  ${t.what}${t.ok ? '' : ' (refused)'}: ${(Number(t.units) / 1e12).toFixed(2)} Tgas burnt, ${toNear(t.gas)} NEAR`);
  console.log(`attack: ${attack?.seconds?.toFixed(1) ?? '?'} s from add_proposal to the guard's vote, proposal #${attack?.filed?.id} ${attack?.after?.status ?? 'not reached'}`);

  if (failures.length) {
    console.log(`\nRESULT: FAIL (${failures.length}): ${failures.join('; ')}`);
    process.exit(1);
  }
  console.log('\nRESULT: pass');
}

try {
  await main();
} catch (e) {
  console.log(`\nRESULT: FAIL: ${e?.message ?? e}`);
  process.exit(1);
}
