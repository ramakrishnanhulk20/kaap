// `kaap arming` and `kaap enroll` against recorded testnet runs: the M1 DAO (enrolled, NEAR Business
// roles with two members and Kaap's guard role) and a DAO made through sputnikv2.testnet with the
// NEAR Business roles and one member in each, the shape most NEAR Business treasuries have, not yet
// enrolled. Edited copies of the M1 policy show the guard losing a kind, sharing its role, and a
// Sputnik 2 DAO being refused. It does not file or vote on any draft (the CLI never does), and it
// does not cover a DAO whose guard holds delegated tokens.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Core } from '../src/core.js';
import { main } from '../src/main.js';
import type { HttpRequest } from '../src/net.js';
import { NETWORKS } from '../src/rpc.js';
import { fakeClock, load, replay, REPO_ROOT } from './replay.js';

const GUARD = 'kaap-guard-1029061211.testnet';
const NB_DAO = 'kaap-nb-1102140303.sputnikv2.testnet';
const NB_MEMBER = 'kaap-nb-1102140303.testnet';

async function run(fixture: string, edit?: (r: HttpRequest, text: string) => string) {
  const fx = load(`${fixture}.json`);
  const log: HttpRequest[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(fx.argv, { transport: replay(fx, log, edit), clock: fakeClock(), loadCore: () => Core.load(), repoRoot: REPO_ROOT }, { out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, out: out.join('\n'), err: err.join('\n'), log };
}

const body = (r: HttpRequest) => JSON.parse(r.body ?? '{}') as { method?: string; params?: { request_type?: string; method_name?: string } };

/** Edits the DAO's policy the same way on both providers. */
function editPolicy(change: (policy: { roles: { name: string; kind: { Group?: string[] }; permissions: string[] }[] }) => void) {
  return (r: HttpRequest, text: string) => {
    if (body(r).params?.method_name !== 'get_policy') return text;
    const answer = JSON.parse(text) as { result: { result: number[] } };
    const policy = JSON.parse(Buffer.from(answer.result.result).toString('utf8'));
    change(policy);
    answer.result.result = [...Buffer.from(JSON.stringify(policy), 'utf8')];
    return JSON.stringify(answer);
  };
}

const guardRole = (p: { roles: { name: string; kind: { Group?: string[] }; permissions: string[] }[] }) => p.roles.find((r) => r.name === 'guard');

test('arming: the M1 DAO is armed on every kind but its own removal, with no extra rights (C16)', async () => {
  const { code, out } = await run('arming-m1');
  assert.equal(code, 0, out);
  assert.match(out, /^guard: kaap-guard-1029061211\.testnet; enrolled in the guard: yes$/m);
  assert.match(out, /^armed: yes\. The guard's one reject decides every kind except remove_member_from_role/m);
  assert.match(out, /^kinds the guard cannot reject: remove_member_from_role \(left out by design\)$/m);
  assert.match(out, /^rights beyond rejecting: none$/m);
  assert.match(out, /^ {2}2 votes: add_bounty, .*\btransfer\b/m);
  assert.match(out, /^race: Every kind that can pass needs at least 2 approvals/m);
});

test('arming: a guard role without transfer:VoteReject, or shared with another account, is not armed', async () => {
  const noTransfer = await run('arming-m1', editPolicy((p) => {
    const role = guardRole(p);
    if (role) role.permissions = role.permissions.filter((x) => x !== 'transfer:VoteReject');
  }));
  assert.equal(noTransfer.code, 0);
  assert.match(noTransfer.out, /^armed: no\. The guard's one reject does not decide: transfer\.$/m);
  assert.match(noTransfer.out, /^kinds the guard cannot reject: remove_member_from_role \(left out by design\), transfer$/m);

  // The template's threshold of one vote still lets the guard reject alone, so C16's formulas say
  // it decides; the template check is what catches a second account holding the same veto.
  const shared = await run('arming-m1', editPolicy((p) => {
    guardRole(p)?.kind.Group?.push('kaap-intruder.testnet');
  }));
  assert.match(shared.out, /^armed: no\. The guard shares a role with other accounts, which Kaap's template never does: guard \(kaap-intruder\.testnet\)\.$/m);
  assert.match(shared.out, /^ {2}kaap-intruder\.testnet: add_bounty, add_member_to_role, bounty_done, call, /m);
});

test('arming: the NEAR Business test DAO is not armed and one approval passes every kind', async () => {
  const { code, out } = await run('arming-nb');
  assert.equal(code, 0, out);
  assert.match(out, /^DAO: Sputnik 3\.31 /m);
  assert.match(out, /^armed: no\. The DAO has not enrolled itself in the guard \(no approved call to enroll\)\. The guard holds no deciding reject vote in this policy\.$/m);
  assert.match(out, /^ {2}1 vote: add_bounty, /m);
  assert.match(out, /^race: One approval passes .*so the guard can only alert after the fact\.$/m);
});

test('enroll: a NEAR Business treasury gets two drafts, the role filed by Admin and the call by Requestor (C30)', async () => {
  const { code, out } = await run('enroll-nb');
  assert.equal(code, 0, out);
  assert.match(out, /roles: Requestor \(1 member\), Admin \(1 member\), Approver \(1 member\)$/m);
  assert.match(out, /^Kaap's enrolment, from its one template: 2 proposals$/m);
  const sections = out.split(/^proposal \d of 2: /m);
  const [role, call] = [sections[1] ?? '', sections[2] ?? ''];
  assert.match(role, /^add Kaap's reject-only guard role \(kind policy_add_or_update_role\)/);
  assert.match(role, new RegExp(`who may file it: ${NB_MEMBER} \\(Admin\\)\n {2}who approves it: ${NB_MEMBER} \\(Admin\\); 1 approval passes it`));
  assert.match(call, /^enrol the DAO in Kaap's guard \(kind call\)/);
  assert.match(call, new RegExp(`who may file it: ${NB_MEMBER} \\(Requestor\\)\n {2}who approves it: ${NB_MEMBER} \\(Approver\\); 1 approval passes it`));
  assert.match(role, /attaching exactly 0 NEAR \(the DAO's proposal bond\) and 30 Tgas/);

  const args = (section: string) => JSON.parse(section.split('\n').find((l) => l.trim().startsWith('{"proposal"'))?.trim() ?? '{}') as { proposal: { description: string; kind: Record<string, Record<string, unknown>> } };
  const added = args(role).proposal.kind['ChangePolicyAddOrUpdateRole']?.['role'] as { name: string; kind: unknown; permissions: string[]; vote_policy: Record<string, unknown> };
  assert.deepEqual([added.name, added.kind], ['guard', { Group: [GUARD] }]);
  assert.equal(added.permissions.length, 16);
  assert.ok(added.permissions.every((x) => x.endsWith(':VoteReject')) && !added.permissions.includes('remove_member_from_role:VoteReject'));
  assert.deepEqual(added.vote_policy['transfer'], { quorum: '0', threshold: '1', weight_kind: 'RoleWeight' });
  const enrol = args(call).proposal.kind['FunctionCall'] as { receiver_id: string; actions: { method_name: string; deposit: string; gas: string; args: string }[] };
  assert.deepEqual([enrol.receiver_id, enrol.actions], [GUARD, [{ args: 'e30=', deposit: '10000000000000000000000', gas: '10000000000000', method_name: 'enroll' }]]);

  // Kaap's own decoding of each draft, by the decoder that judges every proposal.
  assert.match(role, /policy_change: .*"members_added":\[\{"approver":false,"member":"kaap-guard-1029061211\.testnet","role":"guard"\}\].*"roles_added":\["guard"\]/);
  assert.match(role, /findings: GUARD_WEAKENED high\n.*must_veto false\n {4}note: kaap-core flags every change to a role that holds the guard/);
  assert.match(call, /unknown_call: .*"method":"enroll","receiver":"kaap-guard-1029061211\.testnet"/);
  assert.match(call, /must_veto false/);

  assert.match(out, /^after these pass \(Sputnik's rules on the policy they leave\):\n {2}armed: yes\./m);
  assert.match(out, /^ {2}each proposal: the DAO's proposal bond, 0 NEAR/m);
  assert.match(out, /^ {2}the enrolment call: the DAO attaches 0\.01 NEAR to enroll/m);
  assert.match(out, new RegExp(`^when they have passed, check it on chain: kaap arming ${NB_DAO} --network testnet$`, 'm'));
});

test('enroll: the M1 DAO has nothing to file', async () => {
  const { code, out } = await run('enroll-m1');
  assert.equal(code, 0, out);
  assert.match(out, /^nothing to file: the DAO is enrolled and its policy already matches Kaap's template\n\nnow:\n {2}armed: yes\./m);
  assert.doesNotMatch(out, /add_proposal|^cost$/m);
});

test('enroll refuses a DAO on Sputnik 2, whose kinds Kaap has not tested', async () => {
  const sputnik20 = (r: HttpRequest, text: string) => {
    if (body(r).params?.request_type !== 'view_account') return text;
    const answer = JSON.parse(text) as { result: { code_hash: string } };
    answer.result.code_hash = '8RMeZ5cXDap6TENxaJKtigRYf3n139iHmTRe8ZUNey6N';
    return JSON.stringify(answer);
  };
  const { code, out, err } = await run('enroll-nb', sputnik20);
  assert.equal(code, 3);
  assert.equal(out, '');
  assert.match(err, /runs Sputnik 2\.0; Kaap's enrolment drafts use the ChangePolicyAddOrUpdateRole kind and are tested only on Sputnik 3$/);
});

test('arming and enroll only read: the two testnet providers, view_account and four views', async () => {
  const views = new Set(['get_contracts_metadata', 'get_policy', 'is_enrolled', 'get_last_proposal_id']);
  for (const fixture of ['arming-m1', 'arming-nb', 'enroll-m1', 'enroll-nb']) {
    const { log } = await run(fixture);
    for (const r of log) {
      assert.ok(r.url === NETWORKS.testnet.primary || r.url === NETWORKS.testnet.secondary, r.url);
      const { method, params } = body(r);
      assert.ok(method === 'block' || (method === 'query' && (params?.request_type === 'view_account' || views.has(params?.method_name ?? ''))), r.body);
    }
  }
});
