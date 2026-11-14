#!/usr/bin/env node
// The request itself. A verdict is about one exact request, and the guard forwards the request's
// stored form to the treasury with its vote. This file tries to pull the two apart (threat model
// C5, C15): a verdict handed in with another request's content, content respelled or padded,
// content that is not one JSON value, content with a second instruction appended to turn the
// guard's reject into an approve, content too large to carry, and a verdict that was signed over
// content the treasury does not hold.
//
// The guard under attack is the copy lib/test-set.mjs sets up, which runs the live guard's code.
//
//   node packages/attack/attacks/05-kind-mismatch.mjs
//
// What this does NOT cover: a treasury contract other than Sputnik 3.2, which may compare a
// request differently; and a request that changes between the judge's read and the vote, which
// only the watcher can notice (the guard holds no copy of what the judge read beyond its hash).

import {
  accepted, attacker, eventsBy, freshTarget, proposalAt, receiptFailure, refusal, rejectedBy, settledProposal, untouched, veto,
  vetoResult, wasUsed,
} from '../lib/chain.mjs';
import { core } from '../lib/core.mjs';
import { attack, main } from '../lib/report.mjs';
import { testSet } from '../lib/test-set.mjs';
import { TEST_KEY, signVerdict, verdictFor } from '../lib/verdict.mjs';

// kaap-guard's MAX_VETO_KIND_BYTES.
const MAX_KIND_BYTES = 217 * 1024;

/** The same JSON object with every object's keys in the opposite order: another spelling of the
 *  same request, of the same length, as a node may return it on another day. */
function reordered(json) {
  const flip = (v) => (Array.isArray(v) ? v.map(flip) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, flip(x)])) : v);
  return JSON.stringify(flip(JSON.parse(json)));
}

await main('the request itself', async () => {
  const set = await testSet();
  const caller = await attacker({ not: [set.operator], label: 'caller' });
  const target = await freshTarget(caller, set.dao, set.guard, '1');
  const other = await freshTarget(caller, set.dao, set.guard, '2');
  console.log(`test requests: ${set.dao} #${target.proposalId} (1 yoctoNEAR), #${other.proposalId} (2 yoctoNEAR)`);
  const good = signVerdict(verdictFor(target), TEST_KEY);
  const stillOpen = async () => ({
    [`#${target.proposalId} is untouched`]: untouched(await proposalAt(set.dao, target.proposalId)),
    'the verdict is not marked used': (await wasUsed(set.guard, good.hash)) === false,
  });
  const withKind = async (id, what, kindJson, reason) => {
    await attack(id, what, reason, async () => refusal(await veto(caller, set.guard, good, kindJson), reason, await stillOpen()));
  };

  await withKind('5.1', `a correct verdict for #${target.proposalId} handed in with the content of #${other.proposalId}`, other.kindJson, 'ERR_WRONG_KIND_HASH');
  await withKind('5.2', 'the right content with one space added', target.kindJson.replace('{', '{ '), 'ERR_BAD_KIND');
  await withKind('5.3', 'the right content followed by ,"action":"VoteApprove" to turn the guard\'s reject into an approve', `${target.kindJson},"action":"VoteApprove"`, 'ERR_BAD_KIND');
  await withKind('5.4', 'the right content followed by a second JSON value', `${target.kindJson}{}`, 'ERR_BAD_KIND');
  await withKind('5.5', 'content that is not JSON', 'not a request', 'ERR_BAD_KIND');
  await withKind('5.6', `content one byte over the ${MAX_KIND_BYTES}-byte limit`, 'x'.repeat(MAX_KIND_BYTES + 1), 'ERR_KIND_TOO_LARGE');

  // Signed over the other request's content but naming this request: the hash matches what is
  // handed in, so the guard has no way to tell, and the treasury is the one that must refuse.
  const mismatched = signVerdict(verdictFor(target, { kind_hash: core.kindHash(other.kindJson) }), TEST_KEY);
  await attack('5.7', `a verdict naming #${target.proposalId} but signed over the content of #${other.proposalId}`, 'the guard forwards it, the treasury refuses the vote with ERR_WRONG_KIND, and the refusal is recorded', async () => {
    const sent = await veto(caller, set.guard, mismatched, other.kindJson);
    return accepted(sent, {
      'the treasury refused with ERR_WRONG_KIND': receiptFailure(sent.outcome, set.dao) === 'ERR_WRONG_KIND',
      'veto_result is Failed': (await vetoResult(set.guard, mismatched.hash)) === 'Failed',
      'veto_refused was logged': eventsBy(sent.outcome, set.guard).includes('veto_refused'),
      [`#${target.proposalId} is untouched`]: untouched(await proposalAt(set.dao, target.proposalId)),
      [`#${other.proposalId} is untouched`]: untouched(await proposalAt(set.dao, other.proposalId)),
    });
  });
  await attack('5.8', 'that refused verdict sent again', 'ERR_REPLAY', async () =>
    refusal(await veto(caller, set.guard, mismatched, other.kindJson), 'ERR_REPLAY', {
      [`#${target.proposalId} is untouched`]: untouched(await proposalAt(set.dao, target.proposalId)),
    }));

  const respelled = reordered(target.kindJson);
  await attack('5.9', 'CONTROL: the correct verdict with the content\'s keys in another order, as a node may return them', 'accepted, and the request is rejected', async () => {
    if (respelled === target.kindJson || respelled.length !== target.kindJson.length) throw new Error('the respelled content is not a different spelling of the same length');
    return accepted(await veto(caller, set.guard, good, respelled), {
      'the request is Rejected by the guard alone': rejectedBy(await settledProposal(set.dao, target.proposalId), set.guard),
      'veto_result is Ok': (await vetoResult(set.guard, good.hash)) === 'Ok',
    });
  });
});
