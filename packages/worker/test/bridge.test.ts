// The kaap-core bridge agrees with the sealed job: on live testnet data recorded from the DAO of
// the first testnet proof (29 Oct), every hash the bridge computes equals the one the sealed job
// signed, and the ported readers give the sealed job's own test answers. Not covered: kinds the
// sealed job has never signed a verdict for; for those a disagreement fails closed (the veto is
// held, never sent).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { TxOutcome } from '../src/outcome.ts';
import { bridge, daoReads, fixture } from './helpers.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const okRun = () => {
  const o = fixture<TxOutcome>('run-ok');
  const out = JSON.parse(Buffer.from((o.status as { SuccessValue: string }).SuccessValue, 'base64').toString('utf8')) as { verdict: string };
  return { b64: out.verdict, v: bridge.decodeVerdict(Buffer.from(out.verdict, 'base64')) };
};

test("the 29 Oct attack verdict's kind, policy and receivers hashes recompute from the chain through the bridge", () => {
  const { v } = okRun();
  const p2 = bridge.readProposal(enc(daoReads.get_proposal_2));
  assert.equal(p2.id, 2);
  assert.equal(bridge.kindHash(p2.kind), v.kind_hash);
  assert.equal(bridge.policyHash(enc(daoReads.get_policy)), v.policy_hash);
  assert.equal(bridge.receiversHash([[daoReads.dao, daoReads.code_hash]]), v.receivers_hash);
  assert.deepEqual(bridge.calledAccounts(daoReads.dao, p2.kind), [daoReads.dao]);
});

test('a verdict decodes and encodes back to the same bytes, and anything else is refused', () => {
  const { b64, v } = okRun();
  const { verdict_hash, signed_b64, vetoable, vetoable_strict, ...fields } = v;
  assert.equal(bridge.encodeVerdict(fields), b64);
  assert.ok(verdict_hash.length === 64 && signed_b64.length > b64.length && vetoable && vetoable_strict);
  const bytes = Buffer.from(b64, 'base64');
  assert.throws(() => bridge.decodeVerdict(Buffer.concat([bytes, Buffer.from([0])])), /not a kaap-core Verdict/, 'trailing bytes');
  assert.throws(() => bridge.decodeVerdict(bytes.subarray(0, bytes.length - 1)), /not a kaap-core Verdict/, 'cut short');
  const v2 = Buffer.from(bytes);
  v2[0] = 2;
  assert.throws(() => bridge.decodeVerdict(v2), /version is not 1/);
});

test("called accounts follow what Sputnik executes, the sealed job's own cases", () => {
  const dao = 'd.sputnikv2.testnet';
  const cases: Array<[string, string[]]> = [
    ['{"Transfer":{"token_id":"","receiver_id":"new.testnet","amount":"1","msg":null}}', [dao]],
    ['{"Transfer":{"token_id":"usdc.testnet","receiver_id":"a.testnet","amount":"1","msg":null}}', [dao, 'usdc.testnet']],
    ['{"Transfer":{"token_id":"usdc.testnet","receiver_id":"a.testnet","amount":"1","msg":"x"}}', [dao, 'usdc.testnet', 'a.testnet']],
    ['{"FunctionCall":{"receiver_id":"app.testnet","actions":[]}}', [dao, 'app.testnet']],
    ['{"UpgradeRemote":{"receiver_id":"app.testnet","method_name":"up","hash":"x"}}', [dao, 'app.testnet']],
    ['{"FunctionCall":{"receiver_id":"d.sputnikv2.testnet","actions":[]}}', [dao]],
    ['"Vote"', [dao]],
  ];
  for (const [kind, want] of cases) assert.deepEqual(bridge.calledAccounts(dao, kind), want, kind);
  assert.throws(() => bridge.calledAccounts(dao, '{"FunctionCall":{"receiver_id":"Not An Account","actions":[]}}'), /invalid account id/);
});

test('proposals are read by one strict reader that keeps the kind byte for byte', () => {
  const text = '{"id":3,"proposer":"p.testnet","description":"pay","kind":{"Transfer":{"token_id":"","receiver_id":"a.testnet","amount":"1","msg":null}},"status":"InProgress"}';
  const p = bridge.readProposal(enc(text));
  assert.deepEqual([p.id, p.status, p.kind, p.submission_time], [3, 'InProgress', '{"Transfer":{"token_id":"","receiver_id":"a.testnet","amount":"1","msg":null}}', null]);
  for (const bad of ['{"id":3,"id":3,"description":"pay","kind":"Vote"}', '{"id":-3,"description":"pay","kind":"Vote"}', '{"id":3,"description":1,"kind":"Vote"}', `{"id":${2 ** 53},"description":"x","kind":"Vote"}`]) {
    assert.throws(() => bridge.readProposal(enc(bad)), Error, bad);
  }
  const page = bridge.readProposals(enc(daoReads.get_proposals_0_10));
  assert.deepEqual(page.map((x) => [x.id, x.status]), [[0, 'Approved'], [1, 'Rejected'], [2, 'Rejected'], [3, 'InProgress'], [4, 'Rejected'], [5, 'InProgress']]);
});

test('two answers are the same proposal when only the kind is reordered, and differ on any other byte', () => {
  const a = daoReads.get_proposal_3;
  const p = JSON.parse(a);
  const reordered = a.replace(JSON.stringify(p.kind), JSON.stringify({ Transfer: { msg: null, amount: p.kind.Transfer.amount, receiver_id: p.kind.Transfer.receiver_id, token_id: '' } }));
  assert.notEqual(reordered, a);
  assert.equal(bridge.sameProposal(a, reordered), true);
  assert.equal(bridge.sameProposal(a, a.replace('"description":"', '"description":"~')), false);
});
