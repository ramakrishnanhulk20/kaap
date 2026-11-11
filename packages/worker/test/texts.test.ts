// A member's sealed text (WO-06d): GET /text-key serves the stored key, POST /texts answers every
// fault with a fixed word and echoes nothing, a judged text goes down the same veto path as any
// verdict without the answer waiting for the veto, a text waits for a judgement of its proposal
// already running, the rate limit counts each client address, texts have a daily cap of their own
// and may not spend the NEAR kept for the DAO's own proposal checks (C29), and neither the
// ciphertext nor the reply key reaches a log line or a stored row (C26). Not covered: the sealed
// program opening the text and hashing it, which packages/sealed/tests/texts.rs and
// scripts/text-roundtrip.mjs prove, and OutLayer's own behaviour, which the live testnet
// run shows.

import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { test } from 'node:test';

import type { KeyPair } from 'near-api-js';

import { Actor } from '../src/act.ts';
import type { VerdictFields } from '../src/bridge.ts';
import { CapGuard, PER_STOPPED_ATTACK } from '../src/caps.ts';
import type { Signed } from '../src/chain.ts';
import { Health } from '../src/health.ts';
import { Judge, RUN_DEPOSIT, RUN_GAS } from '../src/judge.ts';
import { worstCase } from '../src/near.ts';
import { Reads } from '../src/reads.ts';
import { RejudgeWatch } from '../src/rejudge.ts';
import type { At, ViewResult } from '../src/rpc.ts';
import { StatusServer, textKeySchema, textKeySigned } from '../src/status.ts';
import { Submitter } from '../src/submit.ts';
import { Subscriptions } from '../src/subscriptions.ts';
import { Worker } from '../src/worker.ts';
import { DAO, FakeChain, FakeProvider, GUARD, NETWORK, REGISTRY, T0, bothSet, bridge, events, memoryLog, memoryStore, noSleep, okOutcome, proposalText, runOutcome, sealedOutput, testKey, verdictFields } from './helpers.ts';

const ID = 2;
const NEAR = 10n ** 24n;
const VETO_CAST = 'EVENT_JSON:{"standard":"kaap-guard","version":"1.0.0","event":"veto_cast","data":[]}';

/** Real signed bytes carry the call's arguments, so a store that kept them would hold the text. */
class ArgsChain extends FakeChain {
  /** An outcome read for `heldTx` waits for this, so a run can be kept in flight. */
  hold: Promise<void> | null = null;
  heldTx = '';

  override async sign(receiverId: string, method: string, args: object, gas: bigint, deposit: bigint): Promise<Signed> {
    const s = await super.sign(receiverId, method, args, gas, deposit);
    const signedB64 = Buffer.from(JSON.stringify({ receiverId, method, args, nonce: Number(s.nonce) })).toString('base64');
    this.signed.at(-1)!.signedB64 = signedB64;
    return { ...s, signedB64 };
  }

  override async outcome(hash: string) {
    if (hash === this.heldTx && this.hold) await this.hold;
    return super.outcome(hash);
  }
}

/** A provider whose veto_result read can be held, so a veto can be kept from landing. */
class GatedProvider extends FakeProvider {
  gate: Promise<void> | null = null;

  override async callFunction(account: string, method: string, args: Record<string, unknown>, at: At): Promise<ViewResult> {
    if (method === 'veto_result' && this.gate) await this.gate;
    return super.callFunction(account, method, args, at);
  }
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const opened = () => {
  let open!: () => void;
  const shut = new Promise<void>((resolve) => (open = resolve));
  return { shut, open };
};

/** What the sealed program prints for a text: a verdict whose hash covers an explanation sealed
 *  to the member. Vetoable unless `over` says otherwise. */
function textAnswer(key: KeyPair, over: Partial<VerdictFields> = {}, explanation = `sealed:${randomBytes(120).toString('base64')}`) {
  const fields = verdictFields(ID, { risk: 'critical', floor: 'critical', findings: ['HASH_TEXT_DANGEROUS'], explanation_hash: sha256(explanation), ...over });
  return { ...sealedOutput(fields, key), explanation };
}

function textKeyFor(signer: KeyPair) {
  const key = randomBytes(32);
  const signature = Buffer.from(signer.sign(Buffer.concat([Buffer.from('kaap-text-key-v1\n'), key])).signature).toString('base64');
  return textKeySchema.parse({ key: key.toString('hex'), signature, public_key: signer.getPublicKey().toString(), run_tx: '4EoaigPGidMBU8FqeDJ5SHMZVJapHjXph88AFNM9pKgn', build: 'e1192b2806dd088541a87794808949fbe35ee5b3422405f07c224f4c02130527' });
}

const replyKeyHex = () => Buffer.from(generateKeyPairSync('x25519').publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('hex');

async function started(opts: { runsPerDaoDay?: number; textRunsPerDaoDay?: number; perHour?: number } = {}) {
  const a = new GatedProvider('primary.test');
  const b = new FakeProvider('secondary.test');
  const key = testKey();
  bothSet([a, b], (p) => {
    p.acceptedKey = key.getPublicKey().toString();
    p.proposals.set(ID, proposalText(ID));
  });
  const store = memoryStore();
  const { log, lines, text } = memoryLog();
  const health = new Health(log);
  const chain = new ArgsChain();
  const caps = new CapGuard(store, { runsPerDaoDay: opts.runsPerDaoDay ?? 50, textRunsPerDaoDay: opts.textRunsPerDaoDay ?? 50, recordsPerDaoDay: 50, nearPerDay: 10n * NEAR }, NETWORK);
  const submitter = new Submitter(store, chain, NETWORK, log, { pollMs: 1, sendTries: 2, sleep: noSleep, explorer: (h) => h });
  const reads = new Reads(a, b, bridge, 0, noSleep);
  const accepted = { value: null as string | null };
  const judge = new Judge({ store, submitter, caps, bridge, health, log, acceptedKey: () => accepted.value, now: () => T0 }, { network: NETWORK, guard: GUARD, outlayer: 'outlayer.testnet', project: 'o.testnet/p', verdictTtlMs: 600_000, windowBlocks: 220 });
  const actor = new Actor({ store, submitter, caps, reads, health, log, now: () => T0, sleep: noSleep }, { network: NETWORK, guard: GUARD, registry: REGISTRY, gateTries: 1, gateRetryMs: 0 });
  const rejudge = new RejudgeWatch({ reads, store, bridge, health, log, enqueue: () => {} }, NETWORK);
  const worker = new Worker(
    { store, reads, judge, actor, rejudge, health, log, now: () => T0, acceptedKey: accepted, bridge },
    { network: NETWORK, guard: GUARD, pollMs: 60_000, watchMs: 60_000, enrolledMs: 60_000, holdAlertMs: 30_000, backfillWindow: 100, maxConcurrentRuns: 2, sweepMs: 60_000 },
  );
  await worker.start();
  const textKey = textKeyFor(key);
  const subs = new Subscriptions(store, NETWORK, log);
  const http = new StatusServer(
    { health, subs, log, now: () => T0, watching: () => worker.watching(), texts: worker },
    { host: '127.0.0.1', port: 0, network: NETWORK, guard: GUARD, botUsername: 'kaap_test_bot', tokensPerAddressHour: 10, textsPerAddressHour: opts.perHour ?? 100, textKey },
  );
  const base = `http://127.0.0.1:${await http.start()}`;

  // The sealed program, as the fake chain answers each run's input; null never answers.
  const s = {
    a, b, key, store, health, chain, worker, http, base, textKey, accepted, lines: () => lines, logText: text,
    job: (_input: Record<string, unknown>): unknown => textAnswer(key),
    ciphertext: randomBytes(600).toString('base64'),
    replyKey: replyKeyHex(),
    body(over: Record<string, unknown> = {}): Record<string, unknown> {
      return { dao: DAO, proposal_id: ID, text_ciphertext: s.ciphertext, reply_key: s.replyKey, ...over };
    },
    async post(body: unknown, client = '203.0.113.7') {
      const res = await fetch(`${base}/texts`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': client }, body: typeof body === 'string' ? body : JSON.stringify(body) });
      return { status: res.status, text: await res.text(), retryAfter: res.headers.get('retry-after') };
    },
    async close() {
      await http.stop();
      await worker.stop();
    },
  };
  chain.respond = (call) => {
    if (call.method === 'request_execution') {
      const out = s.job(JSON.parse(String(call.args.input_data)) as Record<string, unknown>);
      return out === null ? null : runOutcome(out);
    }
    return call.method === 'veto' ? okOutcome(undefined, [VETO_CAST]) : okOutcome();
  };
  return s;
}

type Started = Awaited<ReturnType<typeof started>>;

const vetoLands = (s: Started, out: { verdict: string }) => {
  const hash = bridge.decodeVerdict(Buffer.from(out.verdict, 'base64')).verdict_hash;
  bothSet([s.a, s.b], (p) => p.vetoResults.set(hash, 'Ok'));
  return hash;
};

/** A text verdict that calls for no veto, so a text is judged and recorded and nothing waits. */
const CALM: Partial<VerdictFields> = { risk: 'high', floor: 'high', findings: ['UNKNOWN_VALUE'], ai_status: 'verified', model_id: 'deepseek-ai/DeepSeek-V3.1' };

/** The DAO's own check of a new proposal `id`, queued and run by the worker as any new proposal
 *  is, with a verdict that calls for no veto. Texts keep the answer they had. Resolves with the
 *  stored row once the worker is idle. */
async function proposalCheck(s: Started, id: number) {
  bothSet([s.a, s.b], (p) => p.proposals.set(id, proposalText(id)));
  const texts = s.job;
  s.job = (input) => ('text_ciphertext' in input ? texts(input) : sealedOutput(verdictFields(id, { risk: 'high', floor: 'high', findings: ['HASH_UNVERIFIED'] }), s.key));
  s.store.queueNew(NETWORK, DAO, id, 'new');
  s.worker.enqueue(DAO, id);
  await s.worker.idle();
  return s.store.judged(NETWORK, DAO, id);
}

test('GET /text-key serves the stored key with the headers of /status, and only the accepted key signed it', async () => {
  const s = await started();
  const [key, status] = await Promise.all([fetch(`${s.base}/text-key`), fetch(`${s.base}/status`)]);
  assert.equal(key.status, 200);
  assert.deepEqual(await key.json(), s.textKey);
  for (const header of ['content-type', 'cache-control', 'x-content-type-options', 'access-control-allow-origin']) assert.equal(key.headers.get(header), status.headers.get(header), header);
  assert.equal((await fetch(`${s.base}/text-key`, { method: 'POST' })).status, 405);
  assert.equal(textKeySigned(s.textKey, s.key.getPublicKey().toString()), true);
  assert.equal(textKeySigned(s.textKey, testKey().getPublicKey().toString()), false, 'another key');
  assert.equal(textKeySigned({ ...s.textKey, key: randomBytes(32).toString('hex') }, s.key.getPublicKey().toString()), false, 'the signature covers one key only');
  await s.close();
});

test('every shape fault is 400 bad_request, with nothing of the request echoed and no run paid for', async () => {
  const s = await started();
  const faults: Array<[string, unknown]> = [
    ['not JSON', 'not json'],
    ['an unknown field', s.body({ note: 'hello' })],
    ['a missing field', { dao: DAO, proposal_id: ID, text_ciphertext: s.ciphertext }],
    ['a negative id', s.body({ proposal_id: -1 })],
    ['a fractional id', s.body({ proposal_id: 1.5 })],
    ['an id as text', s.body({ proposal_id: '2' })],
    ['a DAO that is not an account id', s.body({ dao: 'Not A Dao' })],
    ['a reply key of 31 bytes', s.body({ reply_key: s.replyKey.slice(2) })],
    ['a reply key of 33 bytes', s.body({ reply_key: `${s.replyKey}00` })],
    ['a reply key that is not hex', s.body({ reply_key: 'zz'.repeat(32) })],
    ['a low-order reply key anyone could read replies to', s.body({ reply_key: '00'.repeat(32) })],
    ['an empty ciphertext', s.body({ text_ciphertext: '' })],
    ['a ciphertext that is not base64', s.body({ text_ciphertext: 'not base64!' })],
    ['base64 without its padding', s.body({ text_ciphertext: 'QQ' })],
    ['base64 with stray trailing bits', s.body({ text_ciphertext: 'QR==' })],
    ['a ciphertext over 48 KiB once decoded', s.body({ text_ciphertext: randomBytes(48 * 1_024 + 1).toString('base64') })],
    ['a body over 64 KiB', JSON.stringify(s.body()) + ' '.repeat(64 * 1_024)],
    ["an input over the sealed program's 32 KiB", s.body({ text_ciphertext: randomBytes(25 * 1_024).toString('base64') })],
  ];
  for (const [name, body] of faults) {
    const got = await s.post(body);
    assert.deepEqual([got.status, got.text], [400, '{"error":"bad_request"}'], name);
  }
  assert.equal(s.chain.signed.length, 0, 'no run was signed');
  await s.close();
});

test('a DAO the worker does not watch is 404 and a proposal that is not open is 409, with no run paid for', async () => {
  const s = await started();
  bothSet([s.a, s.b], (p) => p.proposals.set(4, proposalText(4, { status: 'Approved' })));
  s.a.proposals.set(5, proposalText(5));
  s.b.proposals.set(5, proposalText(5, { status: 'Rejected' }));
  const cases: Array<[string, Record<string, unknown>, number, string]> = [
    ['a DAO not watched', { dao: 'other.sputnik.testnet' }, 404, '{"error":"dao_not_watched"}'],
    ['a proposal that does not exist', { proposal_id: 3 }, 409, '{"error":"proposal_not_open"}'],
    ['an approved proposal', { proposal_id: 4 }, 409, '{"error":"proposal_not_open"}'],
    ['providers that disagree on whether it is open (C22)', { proposal_id: 5 }, 409, '{"error":"proposal_not_open"}'],
  ];
  for (const [name, over, status, text] of cases) {
    const got = await s.post(s.body(over));
    assert.deepEqual([got.status, got.text], [status, text], name);
  }
  assert.equal(s.chain.signed.length, 0);
  await s.close();
});

test("texts up to the text cap pass and the next is 503 over_budget, never signed, while the DAO's own check still runs (C29)", async () => {
  // One proposal run a day is all this DAO allows, so a text counted against it would block it.
  const s = await started({ runsPerDaoDay: 1, textRunsPerDaoDay: 2 });
  s.job = () => textAnswer(s.key, CALM);
  assert.deepEqual([(await s.post(s.body())).status, (await s.post(s.body())).status], [200, 200]);
  const over = await s.post(s.body());
  assert.deepEqual([over.status, over.text], [503, '{"error":"over_budget"}']);
  assert.equal(s.chain.calls('request_execution').length, 2, 'the refused text was never signed');
  const refused = events(s.lines(), 'refused').at(-1)!;
  assert.deepEqual([(JSON.parse(String(refused.detail)) as { cap: string }).cap, refused.sealed_text], ['text_runs_per_dao_day', true]);
  assert.equal(s.health.has('cap_reached', DAO), false, 'texts cannot mark the DAO offline');

  assert.equal((await proposalCheck(s, 6))?.state, 'judged');
  assert.equal(s.chain.calls('request_execution').length, 3);
  await s.close();
});

test('a text that would spend the NEAR kept for one stopped attack is 503 over_budget, while a proposal check still runs (C29)', async () => {
  const s = await started();
  s.job = () => textAnswer(s.key, CALM);
  // Earlier spending leaves one stopped attack and half a run under the 10 NEAR cap: room for a
  // text run on its own, but not on top of what is kept for proposal checks.
  const run = worstCase(RUN_GAS, RUN_DEPOSIT);
  s.store.addSpend({ idempotency_key: 'veto:earlier', kind: 'veto', network: NETWORK, dao: 'other.sputnik.testnet', proposal_id: 1, tx_hash: 'h0', signed_b64: 'x', nonce: '1', reserved_yocto: (10n * NEAR - PER_STOPPED_ATTACK - run / 2n).toString() });
  const got = await s.post(s.body());
  assert.deepEqual([got.status, got.text], [503, '{"error":"over_budget"}']);
  assert.equal(s.chain.calls('request_execution').length, 0, 'never signed');
  const refused = events(s.lines(), 'refused').at(-1)!;
  assert.equal((JSON.parse(String(refused.detail)) as { cap: string }).cap, 'near_kept_for_proposals');
  assert.equal(s.health.has('cap_reached', DAO), false);

  const row = await proposalCheck(s, 6);
  assert.deepEqual([row?.state, row?.record_state], ['judged', 'recorded'], 'the run and its record fit in what was kept');
  await s.close();
});

test("a run with no verdict is 502 run_failed with the program's fixed reason, and a refused text raises nothing", async () => {
  const s = await started();
  const runs = () => s.chain.calls('request_execution').length;

  s.job = () => ({ v: 1, status: 'refused', reason: 'text_ciphertext could not be opened' });
  let got = await s.post(s.body());
  assert.equal(got.status, 502);
  assert.equal(got.text, '{"error":"run_failed","reason":"text_ciphertext could not be opened"}', 'exactly the error and the reason');
  assert.equal(runs(), 1, 'a refused input is not paid for twice');
  assert.equal(s.health.has('run_without_verdict', DAO), false, 'a stranger cannot mark the DAO degraded with a text that does not open');

  s.job = () => ({ v: 1, status: 'held', reason: 'the two providers disagree' });
  got = await s.post(s.body());
  assert.deepEqual([got.status, got.text, runs()], [502, '{"error":"run_failed","reason":"the two providers disagree"}', 3]);

  s.job = () => null;
  got = await s.post(s.body());
  assert.deepEqual([got.status, got.text], [502, '{"error":"run_failed","reason":"no_answer"}']);

  // Signed and covered by its hash, but printed in clear: the member could not open it.
  const clear = 'AI unavailable (ai_key_missing).';
  s.job = () => textAnswer(s.key, {}, clear);
  got = await s.post(s.body());
  assert.deepEqual([got.status, got.text], [502, '{"error":"run_failed","reason":"failed"}']);
  assert.equal(s.health.has('verdict_rejected', DAO), true);
  assert.equal(s.chain.calls('veto').length, 0, 'no verdict from a failed text run is acted on');
  assert.equal(s.store.judged(NETWORK, DAO, ID), undefined, 'nor kept');
  await s.close();
});

test('a judged text that calls for a veto starts it, and the answer does not wait for the veto to land', async () => {
  const s = await started();
  const out = textAnswer(s.key);
  s.job = () => out;
  const hash = vetoLands(s, out);
  const landing = opened();
  s.a.gate = landing.shut;

  const got = await s.post(s.body());
  assert.equal(got.status, 200);
  assert.deepEqual(JSON.parse(got.text), { status: 'judged', run_tx: 'tx1', risk: 'critical', floor: 'critical', findings: ['HASH_TEXT_DANGEROUS'], ai_status: 'unavailable', model_id: null, explanation: out.explanation, veto: 'started' });
  assert.notEqual(s.store.judged(NETWORK, DAO, ID)?.veto_state, 'cast', 'answered before the vote landed');
  assert.equal(s.chain.calls('record').length, 0);

  landing.open();
  await s.close();
  const input = JSON.parse(String(s.chain.calls('request_execution')[0]!.args.input_data)) as Record<string, unknown>;
  assert.deepEqual(input, { v: 1, network: NETWORK, guard: GUARD, dao: DAO, proposal_id: ID, expires_in_ms: 600_000, text_ciphertext: s.ciphertext, reply_key: s.replyKey });
  const veto = s.chain.calls('veto');
  assert.equal(veto.length, 1);
  assert.equal(veto[0]!.args.verdict, out.verdict);
  const row = s.store.judged(NETWORK, DAO, ID)!;
  assert.deepEqual([row.state, row.verdict_hash, row.veto_state, row.record_state, row.reason], ['judged', hash, 'cast', 'recorded', 'text']);
});

test('a judged text that does not call for a veto sends none, and is still recorded', async () => {
  const s = await started();
  s.job = () => textAnswer(s.key, { risk: 'high', floor: 'high', findings: ['UNKNOWN_VALUE'], ai_status: 'verified', model_id: 'deepseek-ai/DeepSeek-V3.1' });
  const got = await s.post(s.body());
  const body = JSON.parse(got.text) as Record<string, unknown>;
  assert.deepEqual([got.status, body.veto, body.model_id, body.ai_status], [200, 'not_needed', 'deepseek-ai/DeepSeek-V3.1', 'verified']);
  await s.close();
  assert.equal(s.chain.calls('veto').length, 0);
  assert.equal(s.chain.calls('record').length, 1);
  assert.equal(s.store.judged(NETWORK, DAO, ID)?.veto_state, 'not_needed');
});

test('a text waits for a judgement of its proposal already running, then acts on its own verdict', async () => {
  const s = await started();
  const mine = textAnswer(s.key);
  const theirs = sealedOutput(verdictFields(ID, { risk: 'high', floor: 'high', findings: ['HASH_UNVERIFIED'] }), s.key);
  s.job = (input) => ('text_ciphertext' in input ? mine : theirs);
  vetoLands(s, mine);
  const running = opened();
  s.chain.hold = running.shut;
  s.chain.heldTx = 'tx1';
  s.store.queueNew(NETWORK, DAO, ID, 'new');
  s.worker.enqueue(DAO, ID);

  const answer = s.post(s.body());
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(s.chain.calls('request_execution').length, 1, 'the text has not started its own run');
  running.open();
  const got = await answer;
  assert.deepEqual([got.status, JSON.parse(got.text).veto], [200, 'started']);
  await s.close();
  assert.deepEqual(s.chain.signed.map((c) => c.method), ['request_execution', 'record', 'request_execution', 'veto', 'record']);
  assert.equal(s.chain.calls('veto')[0]!.args.verdict, mine.verdict);
  assert.equal(s.store.judged(NETWORK, DAO, ID)?.verdict_hash, bridge.decodeVerdict(Buffer.from(mine.verdict, 'base64')).verdict_hash);
});

test('neither the ciphertext nor the reply key is in any log line or any stored row (C26)', async () => {
  const s = await started();
  const out = textAnswer(s.key);
  vetoLands(s, out);
  s.job = () => out;
  assert.equal((await s.post(s.body())).status, 200);
  s.job = () => ({ v: 1, status: 'refused', reason: 'text_ciphertext could not be opened' });
  assert.equal((await s.post(s.body())).status, 502);
  s.job = () => null;
  assert.equal((await s.post(s.body())).status, 502);
  assert.equal((await s.post(s.body({ dao: 'other.sputnik.testnet' }))).status, 404);
  assert.equal((await s.post(s.body({ extra: s.ciphertext }))).status, 400);
  await s.close();

  const sent = Buffer.from(s.chain.calls('request_execution')[0]!.signedB64, 'base64').toString('utf8');
  assert.ok(sent.includes(s.ciphertext), 'the signed bytes do carry the ciphertext, so a store that kept them would fail below');
  const needles = [s.ciphertext, s.ciphertext.slice(0, 40), s.ciphertext.slice(300, 340), Buffer.from(s.ciphertext, 'base64').toString('hex').slice(0, 64), s.replyKey, s.replyKey.toUpperCase(), Buffer.from(s.replyKey, 'hex').toString('base64')];
  const holds = (text: string) => needles.some((n) => text.includes(n));

  assert.ok(s.lines().length > 20, 'the runs were logged');
  assert.equal(holds(s.logText()), false, 'no log line');
  const tables = s.store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
  let values = 0;
  for (const { name } of tables) {
    for (const row of s.store.db.prepare(`SELECT * FROM ${name}`).all() as Array<Record<string, unknown>>) {
      for (const value of Object.values(row)) {
        const text = String(value);
        values++;
        assert.equal(holds(text) || holds(Buffer.from(text, 'base64').toString('utf8')), false, `${name} holds it`);
      }
    }
  }
  assert.ok(values > 50, 'every row was read');
  const textRuns = s.store.db.prepare("SELECT signed_b64 FROM spend WHERE idempotency_key LIKE 'text:%'").all() as Array<{ signed_b64: string }>;
  assert.ok(textRuns.length >= 4 && textRuns.every((r) => r.signed_b64 === ''), 'a text run keeps no signed bytes');
});

test('the rate limit counts each client address, only for well-formed texts, and holds against a burst', async () => {
  const s = await started({ perHour: 2 });
  const elsewhere = s.body({ dao: 'other.sputnik.testnet' });
  assert.deepEqual([(await s.post('not json')).status, (await s.post(s.body({ note: 1 }))).status], [400, 400]);
  assert.deepEqual([(await s.post(elsewhere)).status, (await s.post(elsewhere)).status], [404, 404], 'faults are not counted');
  const limited = await s.post(elsewhere);
  assert.deepEqual([limited.status, limited.text, limited.retryAfter], [429, '{"error":"too_many_requests"}', '3600']);
  assert.equal((await s.post(elsewhere, '198.51.100.9')).status, 404, 'another client is not blocked by the first');
  assert.equal((await s.post(elsewhere, '198.51.100.1, 203.0.113.7')).status, 429, 'an address a client writes before the proxy entry changes nothing');
  // Six requests whose headers all arrive before any body, so each passes the first look at the
  // count before one of them is counted.
  const { port } = new URL(s.base);
  const pending = Array.from({ length: 6 }, () => {
    const req = request({ host: '127.0.0.1', port, path: '/texts', method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.44' } });
    const status = new Promise<number>((resolve, reject) => {
      req.on('response', (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
    });
    req.flushHeaders();
    return { req, status };
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const { req } of pending) req.end(JSON.stringify(elsewhere));
  const burst = await Promise.all(pending.map((p) => p.status));
  assert.equal(burst.filter((status) => status !== 429).length, 2, 'requests read at the same time are counted one by one');
  assert.equal(events(s.lines(), 'rate_limited').at(-1)?.route, '/texts');
  await s.close();
});
