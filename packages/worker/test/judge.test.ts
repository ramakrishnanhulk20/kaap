// The sealed run: recorded testnet outcomes parsed (a signed verdict, a hold, OutLayer never
// answering), the no-answer run treated as a failed run and retried exactly once, and retries that
// re-send the same signed bytes instead of paying twice (6e). Not covered: OutLayer's own
// behaviour beyond the three recorded outcomes, the live send path, which only a live testnet run
// exercises, and whether OutLayer really hands the job the key a run names (the first keyed
// testnet run shows it).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { CapGuard } from '../src/caps.ts';
import { ALL, Health, levelOf } from '../src/health.ts';
import { AI_KEY_MISSING, Judge, RUN_ATTEMPTS, aiSecrets, outlayerCharge, type SecretsRef } from '../src/judge.ts';
import type { TxOutcome } from '../src/outcome.ts';
import { Submitter } from '../src/submit.ts';
import { DAO, FakeChain, GUARD, NETWORK, T0, bridge, events, fixture, memoryLog, memoryStore, noSleep, runOutcome, sealedOutput, testKey, verdictFields } from './helpers.ts';

const SEALED_KEY = 'ed25519:4gaYx4kPxaNDc5grjrucuJfxV97gNiAr8TuCwUAuonuN';

function setup(opts: { acceptedKey?: string; now?: number; guard?: string; secretsRef?: SecretsRef } = {}) {
  const chain = new FakeChain();
  const store = memoryStore(() => opts.now ?? T0);
  const { log, lines } = memoryLog();
  const health = new Health(log);
  const caps = new CapGuard(store, { runsPerDaoDay: 50, textRunsPerDaoDay: 5, recordsPerDaoDay: 50, nearPerDay: 10n ** 24n }, NETWORK);
  const submitter = new Submitter(store, chain, NETWORK, log, { pollMs: 1, sendTries: 3, sleep: noSleep, explorer: (h) => `https://testnet.nearblocks.io/txns/${h}` });
  const key = testKey();
  const judge = new Judge(
    { store, submitter, caps, bridge, health, log, acceptedKey: () => opts.acceptedKey ?? key.getPublicKey().toString(), now: () => opts.now ?? T0 },
    { network: NETWORK, guard: opts.guard ?? GUARD, outlayer: 'outlayer.testnet', project: 'kaap-worker-1029053612.testnet/kaap-sealed', verdictTtlMs: 600_000, windowBlocks: 220, secretsRef: opts.secretsRef ?? null },
  );
  return { chain, store, health, judge, key, lines: () => lines };
}

test('the recorded 29 Oct attack run reads as the verdict the sealed job signed, under its real key', () => {
  const o = fixture<TxOutcome>('run-ok');
  // A moment after the run, before the verdict's ten minutes ran out.
  const s = setup({ acceptedKey: SEALED_KEY, now: Date.parse('2026-10-29T07:12:00Z'), guard: 'kaap-guard-1029061211.testnet' });
  const got = s.judge.read('kaap-dao-1029064008.testnet', 2, o, '7vT7uwgwggGUc3CpNgLApgyjFS4s65KTfZTbMF2enx6T');
  assert.equal(got.state, 'answered');
  if (got.state !== 'answered') return;
  assert.deepEqual([got.verdict.risk, got.verdict.floor, got.verdict.findings, got.verdict.ai_status], ['critical', 'critical', ['DESC_CONTRADICTS', 'UNKNOWN_VALUE'], 'unavailable']);
  assert.equal(got.verdict.vetoable, true);
  assert.equal(got.verdict.block_height, 275266740);
  assert.equal(outlayerCharge(o), 1137801000000000000000n, "the charge comes from OutLayer's own event");
});

test('the same recorded run is refused when anything about it is not what the worker asked for', () => {
  const o = fixture<TxOutcome>('run-ok');
  const at = Date.parse('2026-10-29T07:12:00Z');
  const cases: Array<[string, ReturnType<typeof setup>, string, number]> = [
    ['another accepted key', setup({ acceptedKey: testKey().getPublicKey().toString(), now: at, guard: 'kaap-guard-1029061211.testnet' }), 'kaap-dao-1029064008.testnet', 2],
    ['another proposal', setup({ acceptedKey: SEALED_KEY, now: at, guard: 'kaap-guard-1029061211.testnet' }), 'kaap-dao-1029064008.testnet', 3],
    ['another guard', setup({ acceptedKey: SEALED_KEY, now: at }), 'kaap-dao-1029064008.testnet', 2],
    ['after its expiry', setup({ acceptedKey: SEALED_KEY, now: Date.parse('2026-10-29T08:00:00Z'), guard: 'kaap-guard-1029061211.testnet' }), 'kaap-dao-1029064008.testnet', 2],
  ];
  for (const [name, s, dao, id] of cases) {
    const got = s.judge.read(dao, id, o, 'tx');
    assert.equal(got.state, 'failed', name);
    assert.equal(s.health.has('verdict_rejected', dao), true, name);
  }
});

test('the recorded hold and the recorded no-answer read as runs without a verdict', () => {
  const s = setup();
  const held = s.judge.read(DAO, 1, fixture<TxOutcome>('run-held'), 'tx');
  assert.deepEqual([held.state, 'detail' in held && held.detail], ['held', 'providers disagree: get_proposal']);
  const silent = fixture<TxOutcome>('run-no-answer');
  const none = s.judge.read(DAO, 1, silent, 'tx');
  assert.equal(none.state, 'no_answer');
  assert.equal(outlayerCharge(silent), 10n ** 21n, 'an unanswered run still costs the 0.001 NEAR base fee');
});

test('a run OutLayer never answers is a failed run: guard degraded, then exactly one retry', async () => {
  const s = setup();
  const silent = fixture<TxOutcome>('run-no-answer');
  const answer = sealedOutput(verdictFields(4), s.key);
  let runs = 0;
  s.chain.respond = () => (++runs === 1 ? silent : runOutcome(answer));
  const got = await s.judge.judge(DAO, 4, 1);
  assert.equal(got.kind, 'verdict');
  assert.equal(s.chain.calls('request_execution').length, 2);
  assert.equal(s.store.run(`run:${NETWORK}:${DAO}:4:g1:a1`)?.state, 'no_answer');
  assert.equal(s.store.run(`run:${NETWORK}:${DAO}:4:g1:a2`)?.state, 'answered');
  assert.equal(events(s.lines(), 'guard_degraded')[0]?.signal, 'run_no_answer');
});

test('nothing final within the window counts as no answer too, and two silent runs stop there', async () => {
  const s = setup();
  s.chain.respond = () => null;
  const got = await s.judge.judge(DAO, 5, 1);
  assert.deepEqual([got.kind, got.kind === 'no_verdict' && got.last], ['no_verdict', 'no_answer']);
  assert.equal(s.chain.calls('request_execution').length, RUN_ATTEMPTS, 'one run and one retry, never a third');
  assert.equal(s.health.has('run_without_verdict', DAO), true);
});

test('a refused input is not paid for twice', async () => {
  const s = setup();
  s.chain.respond = () => runOutcome({ v: 1, status: 'refused', reason: 'network is not the network this run is on' });
  const got = await s.judge.judge(DAO, 5, 1);
  assert.equal(got.kind, 'no_verdict');
  assert.equal(s.chain.calls('request_execution').length, 1);
});

test('the run sends exactly the input the sealed job accepts, with every resource limit written out', async () => {
  const s = setup();
  s.chain.respond = () => runOutcome(sealedOutput(verdictFields(4), s.key));
  await s.judge.judge(DAO, 4, 1);
  const args = s.chain.calls('request_execution')[0]!.args as { source: unknown; input_data: string; resource_limits: unknown };
  assert.deepEqual(JSON.parse(args.input_data), { v: 1, network: NETWORK, guard: GUARD, dao: DAO, proposal_id: 4, expires_in_ms: 600_000 });
  assert.deepEqual(args.source, { Project: { project_id: 'kaap-worker-1029053612.testnet/kaap-sealed', version_key: null } });
  assert.deepEqual(args.resource_limits, { max_instructions: 10_000_000_000, max_memory_mb: 128, max_execution_seconds: 60 });
});

test('retries re-send the same signed bytes; a restart resumes the same key; nothing is signed twice (6e)', async () => {
  const s = setup();
  s.chain.plan = ['unknown', 'unknown', 'included'];
  s.chain.respond = () => runOutcome(sealedOutput(verdictFields(4), s.key));
  const first = await s.judge.judge(DAO, 4, 1);
  assert.equal(first.kind, 'verdict');
  assert.equal(s.chain.signed.length, 1, 'one signing');
  assert.equal(s.chain.broadcasts.length, 3, 'three sends');
  assert.equal(new Set(s.chain.broadcasts).size, 1, 'all three are the same bytes');

  // A second worker process over the same store, as after a crash: the attempt is already
  // answered, so it reads that outcome again and signs nothing.
  const again = await s.judge.judge(DAO, 4, 1);
  assert.equal(again.kind, 'verdict');
  assert.equal(s.chain.signed.length, 1);
  assert.equal(s.store.spend(`run:${NETWORK}:${DAO}:4:g1:a1`)?.state, 'final');
});

test('a send the chain refuses outright is signed again once, and only once', async () => {
  const s = setup();
  s.chain.plan = ['rejected', 'rejected'];
  const got = await s.judge.judge(DAO, 4, 1);
  assert.equal(got.kind, 'no_verdict');
  // Attempt 1: signed, refused, signed again, refused, given up. Attempt 2: signed once and sent.
  assert.equal(s.chain.signed.length, 3);
  assert.equal(s.store.spend(`run:${NETWORK}:${DAO}:4:g1:a1`)?.state, 'rejected');
});

test('the worker logs every money movement with its explorer link', async () => {
  const s = setup();
  s.chain.respond = () => runOutcome(sealedOutput(verdictFields(4), s.key));
  await s.judge.judge(DAO, 4, 1);
  const final = events(s.lines(), 'tx_final')[0];
  assert.equal(final?.kind, 'run');
  assert.equal(final?.link, 'https://testnet.nearblocks.io/txns/tx1');
  assert.equal(final?.kept_near, '0.001138');
  assert.equal(events(s.lines(), 'tx_signed')[0]?.reserved_near, '0.050000');
});

const SECRET_ROW: SecretsRef = { profile: 'near-ai', account_id: 'secrets-owner.testnet' };

test('every run names the NEAR AI secret row when one is set, the retry included, and none when unset', async () => {
  const s = setup({ secretsRef: SECRET_ROW });
  const silent = fixture<TxOutcome>('run-no-answer');
  let runs = 0;
  s.chain.respond = () => (++runs === 1 ? silent : runOutcome(sealedOutput(verdictFields(4), s.key)));
  await s.judge.judge(DAO, 4, 1);
  const calls = s.chain.calls('request_execution');
  assert.equal(calls.length, 2);
  for (const call of calls) assert.deepEqual((call.args as { secrets_ref?: unknown }).secrets_ref, SECRET_ROW);

  const none = setup();
  none.chain.respond = () => runOutcome(sealedOutput(verdictFields(4), none.key));
  await none.judge.judge(DAO, 4, 1);
  assert.ok(!('secrets_ref' in (none.chain.calls('request_execution')[0]!.args as object)), 'no row is named rather than an empty one');
});

test('with no secrets account the worker says once at boot that runs carry no AI key', () => {
  const { log, lines } = memoryLog();
  assert.equal(aiSecrets({ KAAP_AI_SECRETS_PROFILE: 'near-ai' }, log), null);
  assert.equal(events(lines, 'ai_off').length, 1);
  const set = memoryLog();
  assert.deepEqual(aiSecrets({ KAAP_AI_SECRETS_ACCOUNT: SECRET_ROW.account_id, KAAP_AI_SECRETS_PROFILE: SECRET_ROW.profile }, set.log), SECRET_ROW);
  assert.equal(events(set.lines, 'ai_off').length, 0);
});

/** A signed sealed output whose explanation is `explanation` and whose verdict commits to it. */
function explained(id: number, explanation: string, key: ReturnType<typeof testKey>, over: Parameters<typeof verdictFields>[1] = {}) {
  const hash = createHash('sha256').update(explanation, 'utf8').digest('hex');
  return { ...sealedOutput(verdictFields(id, { explanation_hash: hash, ...over }), key), explanation };
}

test('a verdict the sealed job signed without its AI key raises ai_key_missing; the next with a key clears it', async () => {
  const s = setup();
  s.chain.respond = () => runOutcome(explained(4, `${AI_KEY_MISSING}: no NEAR AI key reached this run.`, s.key));
  assert.equal((await s.judge.judge(DAO, 4, 1)).kind, 'verdict', 'the verdict itself still counts');
  assert.equal(s.health.has('ai_key_missing', ALL), true);
  assert.equal(levelOf('ai_key_missing'), 'degraded');
  assert.equal(events(s.lines(), 'guard_degraded')[0]?.signal, 'ai_key_missing');

  s.chain.respond = () => runOutcome(explained(5, 'AI unverified (the run had no trusted clock). Pays a lookalike.', s.key, { ai_status: 'unverified', model_id: 'z-ai/glm-5.3-flash' }));
  await s.judge.judge(DAO, 5, 1);
  assert.equal(s.health.has('ai_key_missing', ALL), false);
  assert.equal(events(s.lines(), 'guard_recovered').at(-1)?.signal, 'ai_key_missing');
});

test('only the explanation the signed verdict commits to can raise ai_key_missing', async () => {
  const s = setup();
  const loose = { ...sealedOutput(verdictFields(4), s.key), explanation: `${AI_KEY_MISSING}: no NEAR AI key reached this run.` };
  s.chain.respond = () => runOutcome(loose);
  await s.judge.judge(DAO, 4, 1);
  assert.equal(s.health.has('ai_key_missing', ALL), false, 'the verdict hashes another explanation');
  s.chain.respond = () => runOutcome(explained(5, `${AI_KEY_MISSING}: no NEAR AI key reached this run.`, s.key, { ai_status: 'verified', model_id: 'z-ai/glm-5.3-flash' }));
  await s.judge.judge(DAO, 5, 1);
  assert.equal(s.health.has('ai_key_missing', ALL), false, 'a verdict whose AI ran is not one without a key');
});
