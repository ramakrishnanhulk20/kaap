// The two things a check takes from a DAO's past: the payment history (the census payment rule)
// and the policy before a proposal that is no longer open, including which source it came from.
// Built from small hand-made proposal lists, because the recorded DAOs do not show every case. It
// does not cover reading the pages from a provider (check.test.ts does), or what kaap-core then
// decides from the policy (kaap-core's own tests do).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Core } from '../src/core.js';
import { historyBefore, policyBefore, type Stored } from '../src/history.js';

const policy = (member: string) => ({
  roles: [{ name: 'council', kind: { Group: [member] }, permissions: ['*:*'], vote_policy: {} }],
  default_vote_policy: { weight_kind: 'RoleWeight', quorum: '0', threshold: [1, 2] },
  proposal_bond: '1',
  proposal_period: '1',
  bounty_bond: '1',
  bounty_forgiveness_period: '1',
});

const proposal = (id: number, status: string, kind: unknown, blocks: number[] = [], description = ''): Stored => ({
  id,
  status,
  description,
  kind,
  submission_time: String(1_700_000_000_000_000_000n + BigInt(id)),
  votes: {},
  last_actions_log: blocks.map((b) => ({ block_height: String(b) })),
});

const transfer = (to: string, amount: string) => ({ Transfer: { token_id: '', receiver_id: to, amount, msg: null } });
const read = (p: Stored) => ({ id: p.id, proposer: 'p.near', description: p.description, kind_json: JSON.stringify(p.kind), status: p.status, submission_time: p.submission_time });

test('the policy before is named with its source, or unknown with the reason', async () => {
  const core = await Core.load();
  const now = core.canonicalPolicy(JSON.stringify(policy('now.near')));
  const setOld = proposal(1, 'Approved', { ChangePolicy: { policy: policy('old.near') } }, [100]);
  const pay = proposal(2, 'Approved', transfer('bob.near', '1'), [200]);
  const change = proposal(3, 'Approved', { ChangePolicy: { policy: policy('now.near') } }, [300]);
  const all = (...ps: Stored[]) => ({ proposals: ps, complete: true });

  const open = policyBefore(core, { ...read(pay), status: 'InProgress' }, now, all(pay));
  assert.deepEqual([open.known, open.source], [true, "the DAO's policy now, since the proposal is still open"]);

  const never = policyBefore(core, read(pay), now, all(pay));
  assert.ok(never.known && never.text === now && /no other approved proposal of this DAO ever changed its policy/.test(never.source));

  const allEarlier = policyBefore(core, read(pay), now, all(setOld, pay));
  assert.ok(allEarlier.known && allEarlier.text === now && /every approved policy change ran before/.test(allEarlier.source));

  const changedLater = policyBefore(core, read(pay), now, all(setOld, pay, change));
  assert.ok(changedLater.known && /rebuilt: the full policy set by approved proposal #1/.test(changedLater.source));
  assert.equal(changedLater.known && changedLater.text, core.canonicalPolicy(JSON.stringify(policy('old.near'))));

  const itself = policyBefore(core, read(change), now, all(setOld, pay, change));
  assert.ok(itself.known && itself.text !== now && /#1/.test(itself.source), 'a policy change never gets the policy that already holds it');

  const shortcut = proposal(4, 'Approved', { AddMemberToRole: { member_id: 'x.near', role: 'council' } }, [150]);
  const afterShortcut = policyBefore(core, read(pay), now, all(setOld, pay, shortcut, change));
  assert.ok(!afterShortcut.known && /the last policy change before it was not a full policy/.test(afterShortcut.source), 'shortcut edits are never replayed in TypeScript');

  const expired = policyBefore(core, { ...read(pay), status: 'Expired' }, now, all(setOld, pay));
  assert.ok(!expired.known && /^unknown: /.test(expired.source), 'an expired proposal has no exact moment');

  const noLog = proposal(1, 'Approved', { ChangePolicy: { policy: policy('old.near') } });
  assert.ok(!policyBefore(core, read(pay), now, all(noLog, pay)).known, 'Sputnik before 3.2 keeps no action log');

  const gap = policyBefore(core, read(pay), now, { proposals: [pay], complete: false });
  assert.deepEqual([gap.known, gap.source], [false, "unknown: the DAO's earlier proposals could not all be read"]);
});

test('the payment history counts approved payments submitted earlier, by the census rule', () => {
  const prices = { usd_by_token: { near: [24, 4] as [number, number] } };
  const ps = [
    proposal(0, 'Approved', transfer('alice.near', '1000000000000000000000000')),
    proposal(1, 'Rejected', transfer('mallory.near', '1000000000000000000000000')),
    proposal(2, 'Approved', transfer('bob.near', '3000000000000000000000000')),
    proposal(3, 'Approved', { ChangeConfig: { config: {} } }),
    proposal(4, 'Approved', transfer('carol.near', '9000000000000000000000000')),
  ];
  assert.deepEqual(historyBefore(ps, ps[4]?.submission_time as string, prices), {
    approved_payments_before: 2,
    median_payment_usd_before: 8,
    recipients_paid_before: ['alice.near', 'bob.near'],
  });
  assert.deepEqual(historyBefore(ps, ps[0]?.submission_time as string, prices), { approved_payments_before: 0, median_payment_usd_before: null, recipients_paid_before: [] });
});
