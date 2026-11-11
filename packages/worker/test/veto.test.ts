// The veto decision: the worker's mirror of the guard's ERR_NOT_VETOABLE rule (WO-02a2, with its
// ai_status rule), the last check against live state on both providers (C4, C22), and the veto
// itself: the kind sent exactly as read (C5), veto_result read after the callback, a refusal
// raised. Not covered: the guard's own checks, which its sandbox tests and M1 prove on chain.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Actor, EXPIRY_MARGIN_MS, decide } from '../src/act.ts';
import { CapGuard } from '../src/caps.ts';
import { Health } from '../src/health.ts';
import { Reads, type LiveProposal } from '../src/reads.ts';
import { Submitter } from '../src/submit.ts';
import { DAO, FakeChain, GUARD, NETWORK, REGISTRY, T0, bothSet, bridge, events, failedOutcome, memoryLog, memoryStore, noSleep, okOutcome, proposalText, sealedOutput, testKey, twoProviders, verdictFields } from './helpers.ts';

const vetoable = (over: Parameters<typeof verdictFields>[1]) => bridge.decodeVerdict(Buffer.from(bridge.encodeVerdict(verdictFields(2, over)), 'base64')).vetoable;

test('the mirror of the guard rule: critical risk on a high or critical floor backed by a high finding', () => {
  // Each row is a case from the guard's own tests (WO-02a and WO-02a2).
  const cases: Array<[string, Parameters<typeof verdictFields>[1], boolean]> = [
    ['M1: a description that contradicts a payment, AI unavailable', { risk: 'critical', floor: 'critical', findings: ['DESC_CONTRADICTS', 'UNKNOWN_VALUE'], ai_status: 'unavailable' }, true],
    ['an honest payment: high on a high floor', { risk: 'high', floor: 'high', findings: ['UNKNOWN_VALUE'], ai_status: 'unavailable' }, false],
    ['an AI-only critical on a medium floor', { risk: 'critical', floor: 'medium', findings: ['NEW_RECIPIENT'], ai_status: 'verified' }, false],
    ['critical on a high floor with the AI unverified', { risk: 'critical', floor: 'high', findings: ['UNKNOWN_VALUE'], ai_status: 'unverified' }, false],
    ['critical on a high floor with the AI unavailable', { risk: 'critical', floor: 'high', findings: ['UNKNOWN_VALUE'], ai_status: 'unavailable' }, false],
    ['critical on a high floor with a verified AI answer', { risk: 'critical', floor: 'high', findings: ['UNKNOWN_VALUE'], ai_status: 'verified' }, true],
    ['an unexplained hash alone', { risk: 'critical', floor: 'high', findings: ['HASH_UNVERIFIED'], ai_status: 'verified' }, false],
    ['an unexplained hash beside a medium code', { risk: 'critical', floor: 'high', findings: ['HASH_UNVERIFIED', 'NEW_RECIPIENT'], ai_status: 'verified' }, false],
    ['an unexplained hash beside a new approver', { risk: 'critical', floor: 'high', findings: ['HASH_UNVERIFIED', 'POLICY_ADDS_APPROVER'], ai_status: 'verified' }, true],
    ['an Unknown floor (an unverifiable sign request)', { risk: 'critical', floor: 'unknown', findings: ['HASH_UNVERIFIED', 'UNKNOWN_CALL'], ai_status: 'verified' }, false],
    ['a critical floor with no high finding', { risk: 'critical', floor: 'critical', findings: ['NEW_RECIPIENT'], ai_status: 'unavailable' }, false],
  ];
  for (const [name, over, want] of cases) assert.equal(vetoable(over), want, name);
});

const verdict = (over: Parameters<typeof verdictFields>[1] = {}) => bridge.decodeVerdict(Buffer.from(bridge.encodeVerdict(verdictFields(2, over)), 'base64'));

function live(over: Partial<LiveProposal> = {}): LiveProposal {
  const v = verdict();
  return { kind: 'live', height: 5_000, status: 'InProgress', kindText: '{}', kindHash: v.kind_hash, submissionTime: null, policyHash: v.policy_hash, receivers: [], receiversHash: v.receivers_hash, ...over };
}

test('no veto is sent on a verdict whose pinned state differs from the state read just before', () => {
  const v = verdict();
  assert.deepEqual(decide(v, live(), T0), { act: 'veto' });
  assert.deepEqual(decide(v, live({ policyHash: 'f'.repeat(64) }), T0), { act: 'rejudge', why: 'stale_policy' });
  assert.deepEqual(decide(v, live({ receiversHash: 'f'.repeat(64) }), T0), { act: 'rejudge', why: 'stale_receivers' });
  assert.deepEqual(decide(v, live({ kindHash: 'f'.repeat(64) }), T0), { act: 'rejudge', why: 'kind_changed' });
  assert.deepEqual(decide(v, live({ status: 'Approved' }), T0), { act: 'none', why: 'not_open', status: 'Approved' });
  assert.deepEqual(decide(v, live(), v.expires_at_ms - EXPIRY_MARGIN_MS), { act: 'rejudge', why: 'expired' });
  assert.deepEqual(decide(verdict({ risk: 'high', floor: 'high', findings: ['UNKNOWN_VALUE'] }), live(), T0), { act: 'none', why: 'not_vetoable' });
});

function setup() {
  const [a, b] = twoProviders();
  bothSet([a, b], (p) => p.proposals.set(2, proposalText(2)));
  const chain = new FakeChain();
  const store = memoryStore();
  store.queueNew(NETWORK, DAO, 2, 'new');
  const { log, lines } = memoryLog();
  const health = new Health(log);
  const caps = new CapGuard(store, { runsPerDaoDay: 50, textRunsPerDaoDay: 5, recordsPerDaoDay: 50, nearPerDay: 10n ** 24n }, NETWORK);
  const submitter = new Submitter(store, chain, NETWORK, log, { pollMs: 1, sendTries: 3, sleep: noSleep, explorer: (h) => h });
  const reads = new Reads(a, b, bridge, 0, noSleep);
  const actor = new Actor({ store, submitter, caps, reads, health, log, now: () => T0, sleep: noSleep }, { network: NETWORK, guard: GUARD, registry: REGISTRY, gateTries: 2, gateRetryMs: 0 });
  const key = testKey();
  const out = sealedOutput(verdictFields(2), key);
  const signed = { verdict: bridge.decodeVerdict(Buffer.from(out.verdict, 'base64')), verdictB64: out.verdict, signatureB64: out.signature };
  return { a, b, chain, store, health, actor, signed, lines: () => lines };
}

test('the veto carries the kind exactly as get_proposal returned it, and a cast vote is read back', async () => {
  const s = setup();
  // Keys in another order than kaap-core's canonical form: the guard hashes it canonically, the
  // DAO compares by value, and the worker must forward these bytes unchanged.
  const kind = '{"Transfer":{"receiver_id":"bob.testnet","token_id":"","msg":null,"amount":"5000000000000000000000000"}}';
  bothSet([s.a, s.b], (p) => p.proposals.set(2, proposalText(2, { kind })));
  const fields = verdictFields(2, { kind_hash: bridge.kindHash(kind) });
  const out = sealedOutput(fields, testKey());
  const signed = { verdict: bridge.decodeVerdict(Buffer.from(out.verdict, 'base64')), verdictB64: out.verdict, signatureB64: out.signature };
  bothSet([s.a, s.b], (p) => p.vetoResults.set(signed.verdict.verdict_hash, 'Ok'));
  s.chain.respond = () => okOutcome(undefined, [`EVENT_JSON:{"standard":"kaap-guard","version":"1.0.0","event":"veto_cast","data":[]}`]);

  const got = await s.actor.veto(DAO, 2, signed);
  assert.equal(got.kind, 'cast');
  const sent = s.chain.calls('veto')[0]!;
  assert.equal(sent.receiverId, GUARD);
  assert.deepEqual([sent.gas, sent.deposit], [300n * 10n ** 12n, 0n]);
  assert.equal(sent.args.kind_json, kind);
  assert.equal(sent.args.verdict, signed.verdictB64);
  assert.equal(s.store.judged(NETWORK, DAO, 2)?.veto_state, 'cast');
  assert.equal(got.kind === 'cast' && got.seconds, 21.8, 'seconds from add_proposal to the vote block');
});

test('a vote the DAO refuses is read from veto_result and raised, never left silent (C18)', async () => {
  const s = setup();
  bothSet([s.a, s.b], (p) => p.vetoResults.set(s.signed.verdict.verdict_hash, 'Failed'));
  const got = await s.actor.veto(DAO, 2, s.signed);
  assert.equal(got.kind, 'refused_by_dao');
  assert.equal(s.health.has('veto_refused', DAO), true);
  assert.equal(events(s.lines(), 'veto_refused').length, 1);
});

test('a veto the guard refuses is logged with its code', async () => {
  const s = setup();
  s.chain.respond = () => failedOutcome('ERR_NOT_ENROLLED');
  const got = await s.actor.veto(DAO, 2, s.signed);
  assert.deepEqual([got.kind, got.kind === 'refused_by_guard' && got.code], ['refused_by_guard', 'ERR_NOT_ENROLLED']);
  assert.equal(events(s.lines(), 'tx_refused')[0]?.refusal, 'ERR_NOT_ENROLLED');
});

test('when the live state moved after the verdict, nothing is sent and a re-judge is asked for (C4)', async () => {
  const s = setup();
  const moved = JSON.parse(s.a.policy) as { proposal_bond: string };
  moved.proposal_bond = '1';
  bothSet([s.a, s.b], (p) => (p.policy = JSON.stringify(moved)));
  const got = await s.actor.veto(DAO, 2, s.signed);
  assert.deepEqual(got, { kind: 'rejudge', why: 'stale_policy' });
  assert.equal(s.chain.calls('veto').length, 0);
});

test('a policy that only lists its sets in another order is not a change', async () => {
  const s = setup();
  const reordered = JSON.parse(s.a.policy) as { roles: Array<{ permissions: string[]; kind: { Group?: string[] } }> };
  for (const role of reordered.roles) {
    role.permissions.reverse();
    role.kind.Group?.reverse();
  }
  bothSet([s.a, s.b], (p) => {
    p.policy = JSON.stringify(reordered);
    p.vetoResults.set(s.signed.verdict.verdict_hash, 'Ok');
  });
  const got = await s.actor.veto(DAO, 2, s.signed);
  assert.equal(got.kind, 'cast');
});

test('providers that disagree at the pinned block hold the veto and raise it (C22)', async () => {
  const s = setup();
  s.b.proposals.set(2, proposalText(2, { receiver: 'mallory.testnet' }));
  const got = await s.actor.veto(DAO, 2, s.signed);
  assert.equal(got.kind, 'held');
  assert.equal(s.chain.calls('veto').length, 0);
  assert.equal(s.health.has('veto_held', DAO), true);
});

test('a verdict the rule does not allow is never sent to the guard', async () => {
  const s = setup();
  const out = sealedOutput(verdictFields(2, { risk: 'high', floor: 'high', findings: ['UNKNOWN_VALUE'] }), testKey());
  const got = await s.actor.veto(DAO, 2, { verdict: bridge.decodeVerdict(Buffer.from(out.verdict, 'base64')), verdictB64: out.verdict, signatureB64: out.signature });
  assert.equal(got.kind, 'not_needed');
  assert.equal(s.chain.signed.length, 0);
  assert.equal(s.a.calls.length + s.b.calls.length, 0, 'not even a read is spent on it');
});

test('every verdict is recorded with 0.02 NEAR attached, and the storage kept is logged', async () => {
  const s = setup();
  s.chain.respond = () => {
    const o = okOutcome(undefined, ['EVENT_JSON:{"standard":"kaap-registry","version":"1.0.0","event":"verdict_recorded","data":[{"index":0,"storage_cost":"6380000000000000000000"}]}']);
    o.receipts_outcome![0]!.outcome!.executor_id = REGISTRY;
    return o;
  };
  assert.equal(await s.actor.record(DAO, 2, s.signed), 'recorded');
  const call = s.chain.calls('record')[0]!;
  assert.deepEqual([call.receiverId, call.deposit, call.args.verdict, call.args.signature], [REGISTRY, 20n * 10n ** 21n, s.signed.verdictB64, s.signed.signatureB64]);
  const rec = events(s.lines(), 'recorded')[0];
  assert.equal(rec?.storage_near, '0.006380');
  assert.equal(events(s.lines(), 'tx_final')[0]?.kept_near, '0.006380');
});
