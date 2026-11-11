// Sends that got no answer: a veto or record whose outcome never came back, or that a restart cut
// off, is sent again by its idempotency key (the same signed bytes, never a second signing) until
// it is final or, for a veto, no longer needed, and a health signal stays raised meanwhile.
// A lost veto on a proposal that then passes raises its own critical alert, the missing-outcome,
// held and refused signals clear when the proposal closes (a deleted, removed one included), and
// a watch tick never overlaps a resume pass.
// Not covered: a transaction whose signed bytes expire before the chain takes them, which the
// Submitter's own re-sign path handles and its tests prove.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Actor, type Signed } from '../src/act.ts';
import { Alerts } from '../src/alerts.ts';
import { Subscriptions } from '../src/subscriptions.ts';
import { CapGuard } from '../src/caps.ts';
import { Health, type Signal } from '../src/health.ts';
import { Judge } from '../src/judge.ts';
import type { TxOutcome } from '../src/outcome.ts';
import { Reads } from '../src/reads.ts';
import { RejudgeWatch } from '../src/rejudge.ts';
import { Submitter } from '../src/submit.ts';
import { Worker } from '../src/worker.ts';
import { DAO, FakeChain, FakeTelegram, GUARD, NETWORK, REGISTRY, T0, bothSet, bridge, events, failedOutcome, memoryLog, memoryStore, noSleep, okOutcome, proposalText, sealedOutput, testKey, twoProviders, verdictFields } from './helpers.ts';

const recordedOutcome = (): TxOutcome => {
  const o = okOutcome(undefined, ['EVENT_JSON:{"standard":"kaap-registry","version":"1.0.0","event":"verdict_recorded","data":[{"index":0,"storage_cost":"6380000000000000000000"}]}']);
  o.receipts_outcome![0]!.outcome!.executor_id = REGISTRY;
  return o;
};
const castOutcome = (): TxOutcome => okOutcome(undefined, ['EVENT_JSON:{"standard":"kaap-guard","version":"1.0.0","event":"veto_cast","data":[]}']);

function setup(opts: { watchMs?: number; recordsPerDaoDay?: number } = {}) {
  const [a, b] = twoProviders();
  const key = testKey();
  bothSet([a, b], (p) => {
    p.proposals.set(2, proposalText(2));
    p.acceptedKey = key.getPublicKey().toString();
  });
  const chain = new FakeChain();
  const store = memoryStore();
  store.addDao(NETWORK, DAO, 3);
  store.queueNew(NETWORK, DAO, 2, 'new', 'InProgress');
  const out = sealedOutput(verdictFields(2), key);
  const v = bridge.decodeVerdict(Buffer.from(out.verdict, 'base64'));
  const signed: Signed = { verdict: v, verdictB64: out.verdict, signatureB64: out.signature };
  store.setVerdict(NETWORK, DAO, 2, { verdict_b64: out.verdict, signature_b64: out.signature, verdict_hash: v.verdict_hash, risk: v.risk, floor: v.floor, findings: v.findings.join(','), ai_status: v.ai_status, kind_hash: v.kind_hash, policy_hash: v.policy_hash, receivers_hash: v.receivers_hash, block_height: v.block_height, expires_at_ms: v.expires_at_ms, vetoable: 1 });

  const { log, lines } = memoryLog();
  const health = new Health(log);
  const caps = new CapGuard(store, { runsPerDaoDay: 50, textRunsPerDaoDay: 5, recordsPerDaoDay: opts.recordsPerDaoDay ?? 50, nearPerDay: 10n ** 24n }, NETWORK);
  const submitter = new Submitter(store, chain, NETWORK, log, { pollMs: 1, sendTries: 3, sleep: noSleep, explorer: (h) => h });
  const reads = new Reads(a, b, bridge, 0, noSleep);
  const actor = new Actor({ store, submitter, caps, reads, health, log, now: () => T0, sleep: noSleep }, { network: NETWORK, guard: GUARD, registry: REGISTRY, gateTries: 1, gateRetryMs: 0 });
  const accepted = { value: null as string | null };
  const judge = new Judge({ store, submitter, caps, bridge, health, log, acceptedKey: () => accepted.value, now: () => T0 }, { network: NETWORK, guard: GUARD, outlayer: 'outlayer.testnet', project: 'o.testnet/p', verdictTtlMs: 600_000, windowBlocks: 220 });
  const rejudge = new RejudgeWatch({ reads, store, bridge, health, log, enqueue: () => {} }, NETWORK);
  const worker = new Worker(
    { store, reads, judge, actor, rejudge, health, log, now: () => T0, acceptedKey: accepted, bridge },
    { network: NETWORK, guard: GUARD, pollMs: 60_000, watchMs: opts.watchMs ?? 60_000, enrolledMs: 60_000, holdAlertMs: 30_000, backfillWindow: 100, maxConcurrentRuns: 2 },
  );
  const row = () => store.judged(NETWORK, DAO, 2)!;
  return { a, b, chain, store, health, actor, worker, rejudge, signed, row, lines, log };
}

async function until(done: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('a record with no outcome is resumed on the watch tick and lands under the same transaction', async () => {
  const s = setup({ watchMs: 5 });
  s.chain.respond = () => null;
  assert.equal(await s.actor.record(DAO, 2, s.signed), 'no_outcome');
  assert.equal(s.row().record_state, 'no_outcome');
  assert.equal(s.health.has('record_no_outcome', DAO), true);
  const tx = s.chain.calls('record')[0]!.hash;

  // start() sends it again at once; the chain still has no answer, so it stays raised.
  await s.worker.start();
  assert.equal(s.row().record_state, 'no_outcome');
  assert.equal(s.health.has('record_no_outcome', DAO), true);
  // The lost transaction lands late, and the next watch tick picks it up.
  s.chain.outcomes.set(tx, recordedOutcome());
  await until(() => s.row().record_state === 'recorded');
  await s.worker.stop();
  assert.equal(s.chain.calls('record').length, 1, 'never signed twice');
  assert.equal(events(s.lines, 'tx_signed').filter((l) => l.kind === 'record').length, 1);
  assert.equal(events(s.lines, 'recorded')[0]?.tx, tx);
  assert.equal(s.health.has('record_no_outcome', DAO), false);
  assert.equal(events(s.lines, 'guard_recovered').filter((l) => l.signal === 'record_no_outcome').length, 1);
});

test('a veto with no outcome while the proposal is open is resumed and cast with one signature', async () => {
  const s = setup();
  s.chain.respond = () => null;
  assert.deepEqual(await s.actor.veto(DAO, 2, s.signed), { kind: 'held', why: 'no_outcome' });
  assert.equal(s.row().veto_state, 'no_outcome');
  assert.equal(s.health.has('veto_no_outcome', DAO), true);
  const tx = s.chain.calls('veto')[0]!.hash;

  s.chain.respond = castOutcome;
  bothSet([s.a, s.b], (p) => p.vetoResults.set(s.signed.verdict.verdict_hash, 'Ok'));
  await s.worker.start();
  await s.worker.stop();
  assert.equal(s.row().veto_state, 'cast');
  assert.equal(s.chain.calls('veto').length, 1, 'the same signed bytes went out again');
  assert.equal(events(s.lines, 'veto_cast')[0]?.tx, tx);
  assert.equal(s.health.has('veto_no_outcome', DAO), false);
});

test('a resumed veto whose proposal is now Rejected sends nothing', async () => {
  const s = setup();
  s.chain.respond = () => null;
  await s.actor.veto(DAO, 2, s.signed);
  const sends = s.chain.broadcasts.length;

  bothSet([s.a, s.b], (p) => p.proposals.set(2, proposalText(2, { status: 'Rejected' })));
  await s.worker.start();
  await s.worker.stop();
  assert.equal(s.chain.broadcasts.length, sends, 'not even the stored bytes are sent again');
  assert.equal(s.chain.calls('veto').length, 1);
  assert.equal(s.row().veto_state, 'not_open');
  assert.equal(events(s.lines, 'no_veto').at(-1)?.why, 'not_open');
  assert.deepEqual(s.store.pendingActions(NETWORK), []);
});

test('start() resumes a record a restart cut off after its bytes were signed', async () => {
  const s = setup();
  // What a crash between signing and the answer leaves behind.
  const bytes = await s.chain.sign(REGISTRY, 'record', { verdict: s.signed.verdictB64, signature: s.signed.signatureB64 }, 30n * 10n ** 12n, 20n * 10n ** 21n);
  s.store.addSpend({ idempotency_key: `record:${NETWORK}:${DAO}:2:${s.signed.verdict.verdict_hash}`, kind: 'record', network: NETWORK, dao: DAO, proposal_id: 2, tx_hash: bytes.hash, signed_b64: bytes.signedB64, nonce: bytes.nonce.toString(), reserved_yocto: '0' });
  s.store.setRecordState(NETWORK, DAO, 2, 'sent');
  s.chain.respond = recordedOutcome;

  await s.worker.start();
  await s.worker.stop();
  assert.equal(s.row().record_state, 'recorded');
  assert.equal(s.chain.signed.length, 1, 'the stored bytes were sent, nothing was signed again');
  assert.deepEqual(s.chain.broadcasts, [bytes.signedB64]);
  assert.equal(events(s.lines, 'tx_resumed').length, 1);
});

test('start() resumes a veto a restart cut off while it was being sent', async () => {
  const s = setup();
  const bytes = await s.chain.sign(GUARD, 'veto', {}, 300n * 10n ** 12n, 0n);
  s.store.addSpend({ idempotency_key: `veto:${NETWORK}:${DAO}:2:${s.signed.verdict.verdict_hash}`, kind: 'veto', network: NETWORK, dao: DAO, proposal_id: 2, tx_hash: bytes.hash, signed_b64: bytes.signedB64, nonce: bytes.nonce.toString(), reserved_yocto: '0' });
  s.store.setVetoState(NETWORK, DAO, 2, 'sent');
  s.chain.respond = castOutcome;
  bothSet([s.a, s.b], (p) => p.vetoResults.set(s.signed.verdict.verdict_hash, 'Ok'));

  await s.worker.start();
  await s.worker.stop();
  assert.equal(s.row().veto_state, 'cast');
  assert.equal(s.chain.signed.length, 1);
});

test('a resumed record already counted against the daily cap is still sent, not parked as capped', async () => {
  const s = setup({ recordsPerDaoDay: 1 });
  s.chain.respond = () => null;
  assert.equal(await s.actor.record(DAO, 2, s.signed), 'no_outcome');
  s.chain.respond = recordedOutcome;
  await s.worker.start();
  await s.worker.stop();
  assert.equal(s.row().record_state, 'recorded');
  assert.equal(s.chain.calls('record').length, 1);
});

test('a veto with no outcome on a proposal that then passes raises its own critical alert: veto lost', async () => {
  const s = setup();
  const telegram = new FakeTelegram();
  const alerts = new Alerts({ store: s.store, telegram, log: s.log, now: () => T0, sleep: noSleep }, { network: NETWORK, siteUrl: null, batchMs: 60_000, capPerHour: 30 });
  s.health.on((e) => alerts.health(e));
  const subs = new Subscriptions(s.store, NETWORK, s.log);
  subs.redeem(subs.issue(DAO).token, '5550001234');
  s.chain.respond = () => null;
  await s.actor.veto(DAO, 2, s.signed);
  const tx = s.chain.calls('veto')[0]!.hash;
  assert.equal(s.health.has('veto_no_outcome', DAO), true);

  bothSet([s.a, s.b], (p) => p.proposals.set(2, proposalText(2, { status: 'Approved' })));
  await s.worker.start();
  await s.worker.stop();
  await alerts.flush();
  const lost = events(s.lines, 'veto_lost');
  assert.equal(lost.length, 1);
  assert.deepEqual([lost[0]?.level, lost[0]?.proposal_id, lost[0]?.tx], ['error', 2, tx]);
  assert.equal(telegram.sent.length, 1, 'sent at once, not batched');
  assert.match(telegram.sent[0]!.text, /^Kaap: veto lost on proposal 2 of treasury\[\.\]sputnik\[\.\]testnet\. Kaap's reject vote got no result and the proposal has now passed\./);
  assert.equal(s.health.has('veto_no_outcome', DAO), false, 'the missing outcome itself is no longer the news');
  assert.equal(s.row().veto_state, 'not_open');
  assert.equal(s.chain.calls('veto').length, 1);
});

test('veto_no_outcome clears when the proposal closes, whatever the closing status', async () => {
  for (const status of ['Rejected', 'Removed', 'Expired', 'Moved', 'Failed']) {
    const s = setup();
    s.chain.respond = () => null;
    await s.actor.veto(DAO, 2, s.signed);
    assert.equal(s.health.has('veto_no_outcome', DAO), true, status);
    // Sputnik deletes a removed proposal, so Removed is never read back: it just disappears.
    bothSet([s.a, s.b], (p) => (status === 'Removed' ? p.proposals.delete(2) : p.proposals.set(2, proposalText(2, { status }))));
    await s.worker.start();
    await s.worker.stop();
    assert.equal(s.health.has('veto_no_outcome', DAO), false, status);
    assert.equal(s.row().proposal_status, status);
    assert.equal(events(s.lines, 'veto_lost').length, 0, `${status} is not a lost veto`);
    assert.equal(events(s.lines, 'guard_recovered').filter((l) => l.signal === 'veto_no_outcome').length, 1, status);
  }
});

test('a resumed veto whose proposal was deleted counts it closed: nothing sent, nothing held, veto_no_outcome cleared', async () => {
  const s = setup();
  s.chain.respond = () => null;
  await s.actor.veto(DAO, 2, s.signed);
  const sends = s.chain.broadcasts.length;
  bothSet([s.a, s.b], (p) => p.proposals.delete(2));

  await s.worker.start();
  await s.worker.stop();
  assert.deepEqual([s.row().veto_state, s.row().proposal_status], ['not_open', 'Removed'], 'both providers agree the id is gone');
  assert.deepEqual([s.health.has('veto_no_outcome', DAO), s.health.has('veto_held', DAO)], [false, false]);
  assert.equal(events(s.lines, 'guard_degraded').filter((l) => l.signal === 'veto_held').length, 0, 'a deleted proposal is never reported as a held veto');
  assert.equal(s.chain.broadcasts.length, sends, 'the stored bytes are not sent again');
  assert.deepEqual(s.store.pendingActions(NETWORK), []);

  // One provider still showing it is not agreement: the veto is held, as before.
  const h = setup();
  h.chain.respond = () => null;
  await h.actor.veto(DAO, 2, h.signed);
  h.a.proposals.delete(2);
  await h.worker.start();
  await h.worker.stop();
  assert.deepEqual([h.row().veto_state, h.health.has('veto_held', DAO)], ['held', true]);
});

/** Each signal raised for proposal 2 the way the worker really raises it. */
const raisedBy: Array<[Signal, (s: ReturnType<typeof setup>) => Promise<void>]> = [
  [
    'veto_held',
    async (s) => {
      s.b.proposals.set(2, proposalText(2, { receiver: 'mallory.testnet' }));
      assert.equal((await s.actor.veto(DAO, 2, s.signed)).kind, 'held');
      s.b.proposals.set(2, proposalText(2));
    },
  ],
  [
    'veto_refused',
    async (s) => {
      bothSet([s.a, s.b], (p) => p.vetoResults.set(s.signed.verdict.verdict_hash, 'Failed'));
      assert.equal((await s.actor.veto(DAO, 2, s.signed)).kind, 'refused_by_dao');
    },
  ],
  [
    'record_refused',
    async (s) => {
      s.chain.respond = () => failedOutcome('ERR_TOO_LARGE');
      assert.equal(await s.actor.record(DAO, 2, s.signed), 'refused');
    },
  ],
];

for (const [signal, raise] of raisedBy) {
  test(`${signal} stays raised while the proposal is open and clears when it leaves InProgress, whatever the status`, async () => {
    for (const status of ['Approved', 'Rejected', 'Expired', 'Moved', 'Failed', 'Removed']) {
      const s = setup();
      await raise(s);
      await s.worker.start();
      await s.worker.watchTick();
      assert.equal(s.health.has(signal, DAO), true, `${status}: raised while the proposal is open`);
      // Sputnik deletes a removed proposal, so Removed is never read back: it just disappears.
      bothSet([s.a, s.b], (p) => (status === 'Removed' ? p.proposals.delete(2) : p.proposals.set(2, proposalText(2, { status }))));
      await s.worker.watchTick();
      await s.worker.stop();
      assert.equal(s.health.has(signal, DAO), false, status);
      assert.equal(events(s.lines, 'guard_recovered').filter((l) => l.signal === signal).length, 1, status);
      assert.equal(s.row().proposal_status, status);
    }
  });
}

test('the watch tick waits for the resume pass to finish; the two never overlap', async () => {
  const s = setup();
  s.chain.respond = () => null;
  await s.actor.veto(DAO, 2, s.signed);
  s.chain.respond = castOutcome;
  bothSet([s.a, s.b], (p) => p.vetoResults.set(s.signed.verdict.verdict_hash, 'Ok'));

  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const send = s.chain.broadcast.bind(s.chain);
  s.chain.broadcast = async (bytes) => {
    order.push('resume sends');
    await gate;
    order.push('resume sent');
    return send(bytes);
  };
  s.rejudge.pass = async () => {
    order.push('re-judge');
    return [];
  };

  const starting = s.worker.start();
  await until(() => order.length > 0);
  const ticks = [s.worker.watchTick(), s.worker.watchTick()];
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(order, ['resume sends'], 'no re-judge and no second resume while a resume pass runs');
  release();
  await starting;
  await Promise.all(ticks);
  await s.worker.stop();
  assert.deepEqual(order, ['resume sends', 'resume sent', 're-judge', 're-judge']);
  assert.equal(s.row().veto_state, 'cast');
  assert.equal(s.chain.calls('veto').length, 1);
});
