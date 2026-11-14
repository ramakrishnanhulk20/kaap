#!/usr/bin/env node
// Enrolment. The guard votes only in a treasury that enrolled itself, and only when the verdict
// names this guard. This file tries a verdict for a treasury that never enrolled, a verdict that
// names another guard, and a treasury name that is no account at all. Then it uses the one door
// that is open to everybody, `enroll`, to see what a stranger gains by walking through it:
// whether it can enrol for free, change another treasury's settings, or remove another treasury.
//
// The guard under attack is the copy lib/test-set.mjs sets up, which runs the live guard's code.
//
//   node packages/attack/attacks/03-enrolment.mjs
//
// What this does NOT cover: a hostile contract that enrols itself and answers the guard's vote
// with calls of its own. The guard marks a verdict used before it calls out, its call carries no
// deposit and its callback reads only whether the vote landed, but that is an argument: no run
// here or in the contracts' own tests shows it. Nor a treasury whose members vote to unenrol,
// which is their right.

import {
  LIVE, MILLI_NEAR, TGAS, accepted, accountFor, attacker, call, eventsBy, fileProposal, freeBalance, freshTarget, proposalAt,
  receiptFailure, refusal, settledProposal, txLink, untouched, veto, vetoResult, viewFinal,
} from '../lib/chain.mjs';
import { attack, main } from '../lib/report.mjs';
import { testSet } from '../lib/test-set.mjs';
import { TEST_KEY, signVerdict, verdictFor } from '../lib/verdict.mjs';

const ENROL_DEPOSIT = 10n * MILLI_NEAR;

await main('enrolment', async () => {
  const set = await testSet();
  const owner = accountFor(set.operator);
  const caller = await attacker({ not: [set.operator], label: 'caller' });
  const me = caller.account.accountId;
  const enrolled = (dao) => viewFinal(set.guard, 'is_enrolled', { dao });
  const strict = (dao) => viewFinal(set.guard, 'veto_unreadable', { dao });
  if (await enrolled(me)) {
    await call(caller, set.guard, 'unenroll', {});
    console.log('an earlier run left the caller enrolled; it unenrolled itself');
  }

  const outside = await freshTarget(caller, set.unenrolledDao, set.guard, '1');
  const inside = await freshTarget(caller, set.dao, set.guard, '1');
  console.log(`test requests: ${set.unenrolledDao} #${outside.proposalId}; ${set.dao} #${inside.proposalId}`);
  const insideOpen = async () => ({ [`${set.dao} #${inside.proposalId} is untouched`]: untouched(await proposalAt(set.dao, inside.proposalId)) });
  const othersAsBefore = async () => ({
    'the enrolled treasury is still enrolled, strict mode off': (await enrolled(set.dao)) === true && (await strict(set.dao)) === false,
    'the strict treasury is still enrolled, strict mode on': (await enrolled(set.strictDao)) === true && (await strict(set.strictDao)) === true,
  });

  await attack('3.1', 'a correctly signed verdict for a treasury that gives the guard its role but never enrolled', 'ERR_NOT_ENROLLED', async () =>
    refusal(await veto(caller, set.guard, signVerdict(verdictFor(outside), TEST_KEY), outside.kindJson), 'ERR_NOT_ENROLLED', {
      'its request is untouched': untouched(await proposalAt(set.unenrolledDao, outside.proposalId)),
    }));
  await attack('3.2', `a correctly signed verdict that names another guard (${LIVE.guard})`, 'ERR_WRONG_GUARD', async () =>
    refusal(await veto(caller, set.guard, signVerdict(verdictFor(inside, { guard: LIVE.guard }), TEST_KEY), inside.kindJson), 'ERR_WRONG_GUARD', await insideOpen()));
  await attack('3.3', 'a correctly signed verdict whose treasury is not an account name', 'ERR_NOT_ENROLLED', async () =>
    refusal(await veto(caller, set.guard, signVerdict(verdictFor(inside, { dao: 'Not A Treasury' }), TEST_KEY), inside.kindJson), 'ERR_NOT_ENROLLED', await insideOpen()));

  await attack('3.4', 'a stranger enrols its own account without paying for the storage', 'ERR_NOT_ENOUGH_DEPOSIT', async () =>
    refusal(await call(caller, set.guard, 'enroll', {}), 'ERR_NOT_ENOUGH_DEPOSIT', { 'it is not enrolled': (await enrolled(me)) === false }));

  await attack('3.5', 'BY DESIGN: a stranger enrols its own account and pays for it', 'accepted; the guard\'s own balance pays nothing and no other treasury changes', async () => {
    const before = await freeBalance(set.guard);
    const sent = await call(caller, set.guard, 'enroll', {}, undefined, ENROL_DEPOSIT);
    return accepted(sent, {
      'it is listed as enrolled': (await enrolled(me)) === true,
      'what the guard holds beyond its storage did not fall': (await freeBalance(set.guard)) >= before,
      ...(await othersAsBefore()),
    });
  });

  const selfVerdict = signVerdict(verdictFor({ ...inside, dao: me, proposalId: 0 }), TEST_KEY);
  await attack('3.6', 'BY DESIGN: a correctly signed verdict naming that enrolled stranger as the treasury', 'the guard\'s vote goes to the stranger\'s own account and nowhere else, and is recorded as refused', async () => {
    const sent = await veto(caller, set.guard, selfVerdict, inside.kindJson);
    const voteWentTo = sent.outcome.receipts_outcome.map((r) => r.outcome.executor_id).filter((id) => id !== set.guard && id !== 'system');
    return accepted(sent, {
      'every receipt outside the guard ran on the stranger\'s account': voteWentTo.every((id) => id === me),
      'veto_result is Failed': (await vetoResult(set.guard, selfVerdict.hash)) === 'Failed',
      'veto_refused was logged': eventsBy(sent.outcome, set.guard).includes('veto_refused'),
      ...(await insideOpen()),
    });
  });

  await attack('3.7', 'the enrolled stranger enrols a second time', 'ERR_ALREADY_ENROLLED', async () =>
    refusal(await call(caller, set.guard, 'enroll', { veto_unreadable: true }, undefined, ENROL_DEPOSIT), 'ERR_ALREADY_ENROLLED', {
      'its strict mode is still off': (await strict(me)) === false,
    }));

  await attack('3.8', 'BY DESIGN: the enrolled stranger switches strict mode on, hoping to switch it for others', 'accepted for its own entry only', async () =>
    accepted(await call(caller, set.guard, 'set_veto_unreadable', { on: true }), { 'its own strict mode is on': (await strict(me)) === true, ...(await othersAsBefore()) }));

  await attack('3.9', 'BY DESIGN: the stranger calls unenroll, hoping to remove a treasury', 'accepted; it removes only its caller', async () =>
    accepted(await call(caller, set.guard, 'unenroll', {}), { 'the stranger is no longer enrolled': (await enrolled(me)) === false, ...(await othersAsBefore()) }));

  await attack('3.10', 'an account that is not enrolled calls unenroll', 'ERR_NOT_ENROLLED', async () =>
    refusal(await call(caller, set.guard, 'unenroll', {}), 'ERR_NOT_ENROLLED', await othersAsBefore()));
  await attack('3.11', 'an account that is not enrolled switches strict mode on', 'ERR_NOT_ENROLLED', async () =>
    refusal(await call(caller, set.guard, 'set_veto_unreadable', { on: true }), 'ERR_NOT_ENROLLED', { 'it has no strict mode': (await strict(me)) === false, ...(await othersAsBefore()) }));
  await attack('3.12', 'a correctly signed verdict naming the stranger after it unenrolled', 'ERR_NOT_ENROLLED', async () =>
    refusal(await veto(caller, set.guard, signVerdict(verdictFor({ ...inside, dao: me, proposalId: 1 }), TEST_KEY), inside.kindJson), 'ERR_NOT_ENROLLED'));

  await attack('3.13', 'an enrolled treasury votes to enrol again with strict mode on, to change its setting without the method made for it', 'the guard refuses with ERR_ALREADY_ENROLLED and the treasury\'s request ends Failed', async () => {
    const kind = {
      FunctionCall: {
        receiver_id: set.guard,
        actions: [{ method_name: 'enroll', args: Buffer.from('{"veto_unreadable":true}').toString('base64'), deposit: ENROL_DEPOSIT.toString(), gas: (10n * TGAS).toString() }],
      },
    };
    const filed = await fileProposal(owner, set.dao, 'Enrol this DAO a second time.', kind);
    const stored = await viewFinal(set.dao, 'get_proposal', { id: filed.id });
    const sent = await call(owner, set.dao, 'act_proposal', { id: filed.id, action: 'VoteApprove', proposal: stored.kind }, 300n * TGAS);
    const guardSaid = receiptFailure(sent.outcome, set.guard);
    const after = await settledProposal(set.dao, filed.id);
    return {
      observed: `the guard answered ${guardSaid ?? 'without an error'}; request #${filed.id} is ${after.status}; ${txLink(sent.hash)}`,
      pass: guardSaid === 'ERR_ALREADY_ENROLLED' && after.status === 'Failed' && (await enrolled(set.dao)) === true && (await strict(set.dao)) === false,
    };
  });
});
