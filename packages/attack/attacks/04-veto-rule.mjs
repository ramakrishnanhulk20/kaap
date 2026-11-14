#!/usr/bin/env node
// The veto rule, against a signer that has gone wrong. Every verdict in this file is correctly
// signed by the key the guard trusts, as if the sealed program had a bug or its key were stolen.
// The guard still decides for itself whether a verdict may reject a request (threat model C8,
// C9): the risk must be critical, plain code must have rated it high or critical, at least one
// finding other than an unread hash must be serious in its own right, and only an AI answer that
// was verified may lift a high rating to critical. A treasury that chose strict mode adds one
// thing: a verdict that lists an unread signed hash is accepted too.
//
// Each of the four parts of the rule has at least one verdict here that breaks that part alone
// (4.2 and 4.8 the plain-code rating, 4.3, 4.9 and 4.10 the serious finding, 4.4 and 4.5 the
// verified AI answer, 4.6 the critical risk), so a guard missing any one part would let one
// through. Two controls show the rule lets the right verdicts through, and a third shows strict
// mode doing what a strict treasury asked for.
//
// The guard under attack is the copy lib/test-set.mjs sets up, which runs the live guard's code
// and trusts a public test key, which is what lets this file sign verdicts the real key never
// would. The test requests are plain transfers of a few yoctoNEAR: what a verdict says about a
// request is made up here, and only the guard's answer to the verdict is under test.
//
//   node packages/attack/attacks/04-veto-rule.mjs
//
// What this does NOT cover: whether the sealed program rates a request correctly in the first
// place (the evaluation in eval/ measures that); a real request that carries a signed hash, since
// the unread-hash verdicts here are about transfers; and a verdict whose findings are serious
// but false, which the guard cannot tell from a true one: it holds codes, not the request's
// meaning.

import { accepted, attacker, freshTarget, proposalAt, refusal, rejectedBy, settledProposal, untouched, veto, viewFinal, wasUsed } from '../lib/chain.mjs';
import { attack, main } from '../lib/report.mjs';
import { testSet } from '../lib/test-set.mjs';
import { TEST_KEY, signVerdict, verdictFor } from '../lib/verdict.mjs';

await main('veto rule', async () => {
  const set = await testSet();
  const caller = await attacker({ not: [set.operator], label: 'caller' });
  const target = await freshTarget(caller, set.dao, set.guard, '1');
  const second = await freshTarget(caller, set.dao, set.guard, '2');
  const strictTarget = await freshTarget(caller, set.strictDao, set.guard, '1');
  console.log(`test requests: ${set.dao} #${target.proposalId}, #${second.proposalId}; ${set.strictDao} #${strictTarget.proposalId}`);
  if ((await viewFinal(set.guard, 'veto_unreadable', { dao: set.dao })) !== false || (await viewFinal(set.guard, 'veto_unreadable', { dao: set.strictDao })) !== true) {
    throw new Error('the two treasuries are not in the modes this file needs');
  }

  const refusedOn = async (id, what, on, over) => {
    await attack(id, what, 'ERR_NOT_VETOABLE', async () => {
      const signed = signVerdict(verdictFor(on, over), TEST_KEY);
      return refusal(await veto(caller, set.guard, signed, on.kindJson), 'ERR_NOT_VETOABLE', {
        'the request is untouched': untouched(await proposalAt(on.dao, on.proposalId)),
        'the verdict is not marked used': (await wasUsed(set.guard, signed.hash)) === false,
      });
    });
  };
  const acceptedOn = async (id, what, on, over) => {
    await attack(id, what, 'accepted, and the request is rejected by the guard alone', async () =>
      accepted(await veto(caller, set.guard, signVerdict(verdictFor(on, over), TEST_KEY), on.kindJson), {
        'the request is Rejected by the guard alone': rejectedBy(await settledProposal(on.dao, on.proposalId), set.guard),
      }));
  };
  const unreadHashOnly = { risk: 'unknown', floor: 'unknown', findings: ['HASH_UNVERIFIED'], ai_status: 'unavailable' };

  await refusedOn('4.1', 'critical on the AI\'s word alone: plain code rated it medium and found a new recipient and a large amount', target,
    { risk: 'critical', floor: 'medium', findings: ['NEW_RECIPIENT', 'LARGE_AMOUNT'], ai_status: 'verified' });
  await refusedOn('4.2', 'critical with a serious finding and a verified AI answer, but a plain-code rating of medium', target,
    { risk: 'critical', floor: 'medium', findings: ['UNKNOWN_CALL'], ai_status: 'verified' });
  await refusedOn('4.3', 'critical where the only serious finding is a signed hash nobody could read', target,
    { risk: 'critical', floor: 'high', findings: ['HASH_UNVERIFIED', 'NEW_RECIPIENT'], ai_status: 'verified' });
  await refusedOn('4.4', 'lifted from high to critical by an AI answer that was not verified', target,
    { risk: 'critical', floor: 'high', findings: ['UNKNOWN_CALL'], ai_status: 'unverified' });
  await refusedOn('4.5', 'lifted from high to critical with no AI answer at all', target,
    { risk: 'critical', floor: 'high', findings: ['UNKNOWN_CALL'], ai_status: 'unavailable' });
  await refusedOn('4.6', 'a high risk that is not critical', target,
    { risk: 'high', floor: 'high', findings: ['UNKNOWN_CALL'], ai_status: 'verified' });
  await refusedOn('4.7', 'critical over a plain-code rating of unknown, with an unread hash as the only finding', target,
    { risk: 'critical', floor: 'unknown', findings: ['HASH_UNVERIFIED'], ai_status: 'verified' });
  await refusedOn('4.8', 'critical with a serious finding and a verified AI answer, but a plain-code rating of unknown', target,
    { risk: 'critical', floor: 'unknown', findings: ['UNKNOWN_CALL'], ai_status: 'verified' });
  await refusedOn('4.9', 'critical on both counts with no finding at all', target,
    { risk: 'critical', floor: 'critical', findings: [], ai_status: 'verified' });
  await refusedOn('4.10', 'critical on both counts with only minor findings (an empty description, a new recipient)', target,
    { risk: 'critical', floor: 'critical', findings: ['EMPTY_DESCRIPTION', 'NEW_RECIPIENT'], ai_status: 'verified' });
  await refusedOn('4.11', 'a default-mode treasury and a verdict whose only finding is an unread hash', target, unreadHashOnly);
  await refusedOn('4.12', 'a strict-mode treasury and a high risk with no unread hash: strict mode widens nothing else', strictTarget,
    { risk: 'high', floor: 'high', findings: ['UNKNOWN_CALL'], ai_status: 'verified' });

  await acceptedOn('4.13', 'CONTROL: rated high by plain code, lifted to critical by a verified AI answer', second,
    { risk: 'critical', floor: 'high', findings: ['UNKNOWN_CALL'], ai_status: 'verified' });
  await acceptedOn('4.14', 'CONTROL: rated critical by plain code (a hash that does not match its text), no AI answer', target,
    { risk: 'critical', floor: 'critical', findings: ['HASH_MISMATCH'], ai_status: 'unavailable' });
  await acceptedOn('4.15', 'CONTROL: a strict-mode treasury and a verdict rated as in 4.11, whose only finding is an unread hash', strictTarget, unreadHashOnly);
});
