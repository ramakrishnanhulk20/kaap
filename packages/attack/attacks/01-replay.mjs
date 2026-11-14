#!/usr/bin/env node
// Replay. A signed verdict is public the moment it is handed in, so anyone can copy it. This file
// tries to make one verdict count more than once: sent again, pointed at another request or
// another treasury, sent after it expired, sent for another network, recorded twice, and spent
// by a stranger with one Tgas less than the guard asks for (threat model C19).
//
// The guard under attack is the copy lib/test-set.mjs sets up, which runs the live guard's code
// and trusts a public test key. One case is a control: the same verdict, used once, does reject.
//
//   node packages/attack/attacks/01-replay.mjs
//
// What this does NOT cover: the live guard itself, which is never sent a transaction here (the
// link to it is the code hash, compared on chain at the start); a verdict replayed against a
// guard at another address, which 03-enrolment.mjs tries; two vetoes racing in one block; and
// the other side of the gas limit, that a vote on the largest request the guard accepts still
// lands with exactly 900 Tgas, which is measured in a sandbox (packages/contracts/GAS.md).

import {
  attacker, chainNowMs, eventsBy, freshTarget, proposalAt, record, refusal, accepted, rejectedBy, settledProposal, sleep,
  untouched, veto, vetoResult, viewFinal, wasUsed, TGAS,
} from '../lib/chain.mjs';
import { attack, main } from '../lib/report.mjs';
import { testSet } from '../lib/test-set.mjs';
import { TEST_KEY, edited, signVerdict, verdictFor } from '../lib/verdict.mjs';

await main('replay', async () => {
  const set = await testSet();
  const caller = await attacker({ not: [set.operator], label: 'caller' });
  const first = await freshTarget(caller, set.dao, set.guard, '1');
  const second = await freshTarget(caller, set.dao, set.guard, '2');
  const brief = await freshTarget(caller, set.dao, set.guard, '3');
  const elsewhere = await freshTarget(caller, set.strictDao, set.guard, '1');
  console.log(`test requests: ${set.dao} #${first.proposalId}, #${second.proposalId}, #${brief.proposalId}; ${set.strictDao} #${elsewhere.proposalId}`);

  const used = signVerdict(verdictFor(first), TEST_KEY);
  const briefExpiry = (await chainNowMs()) + 60_000;
  const shortLived = signVerdict(verdictFor(brief, { expires_at_ms: briefExpiry }), TEST_KEY);

  await attack('1.1', 'a stranger sends a fresh verdict with 899 Tgas, one less than the guard asks for, to spend it on a vote that may run out of gas', 'ERR_NOT_ENOUGH_GAS, and the verdict is still unused', async () =>
    refusal(await veto(caller, set.guard, used, first.kindJson, 899n * TGAS), 'ERR_NOT_ENOUGH_GAS', {
      'the verdict is not marked used': (await wasUsed(set.guard, used.hash)) === false,
      'the request is untouched': untouched(await proposalAt(set.dao, first.proposalId)),
    }));

  await attack('1.2', 'CONTROL: the same verdict, handed in once with enough gas', 'accepted, and the request is rejected by the guard alone', async () => {
    const sent = await veto(caller, set.guard, used, first.kindJson);
    const logged = eventsBy(sent.outcome, set.guard);
    return accepted(sent, {
      'the request is Rejected by the guard alone': rejectedBy(await settledProposal(set.dao, first.proposalId), set.guard),
      'the verdict is marked used': (await wasUsed(set.guard, used.hash)) === true,
      'veto_result is Ok': (await vetoResult(set.guard, used.hash)) === 'Ok',
      'veto_sent and veto_cast were logged': logged.includes('veto_sent') && logged.includes('veto_cast'),
    });
  });

  // Starts the clock for 1.9 while the other cases run.
  const briefSent = await veto(caller, set.guard, shortLived, brief.kindJson);
  if (briefSent.failure) throw new Error('the short-lived verdict was refused on its first use');

  await attack('1.3', 'the verdict that was just used, sent again', 'ERR_REPLAY', async () =>
    refusal(await veto(caller, set.guard, used, first.kindJson), 'ERR_REPLAY', {
      'the request still carries one vote': rejectedBy(await proposalAt(set.dao, first.proposalId), set.guard),
    }));

  await attack('1.4', `the used verdict with its request number rewritten to #${second.proposalId}, signature kept`, 'ERR_BAD_SIGNATURE', async () => {
    const forged = { ...edited(used, { proposal_id: second.proposalId }), signature: used.signature };
    return refusal(await veto(caller, set.guard, forged, second.kindJson), 'ERR_BAD_SIGNATURE', {
      [`#${second.proposalId} is untouched`]: untouched(await proposalAt(set.dao, second.proposalId)),
    });
  });

  await attack('1.5', 'the used verdict with its treasury rewritten to another enrolled treasury, signature kept', 'ERR_BAD_SIGNATURE', async () => {
    const forged = { ...edited(used, { dao: set.strictDao, proposal_id: elsewhere.proposalId }), signature: used.signature };
    return refusal(await veto(caller, set.guard, forged, elsewhere.kindJson), 'ERR_BAD_SIGNATURE', {
      'the other treasury\'s request is untouched': untouched(await proposalAt(set.strictDao, elsewhere.proposalId)),
    });
  });

  await attack('1.6', 'a correctly signed verdict that expired a minute ago', 'ERR_EXPIRED', async () => {
    const late = signVerdict(verdictFor(second, { expires_at_ms: (await chainNowMs()) - 60_000 }), TEST_KEY);
    return refusal(await veto(caller, set.guard, late, second.kindJson), 'ERR_EXPIRED', {
      'the verdict is not marked used': (await wasUsed(set.guard, late.hash)) === false,
      [`#${second.proposalId} is untouched`]: untouched(await proposalAt(set.dao, second.proposalId)),
    });
  });

  for (const [id, network] of [['1.7', 'mainnet'], ['1.8', 'sandbox']]) {
    await attack(id, `a correctly signed verdict written for ${network}, handed to the testnet guard`, 'ERR_WRONG_GUARD', async () => {
      const foreign = signVerdict(verdictFor(second, { network }), TEST_KEY);
      return refusal(await veto(caller, set.guard, foreign, second.kindJson), 'ERR_WRONG_GUARD', {
        [`#${second.proposalId} is untouched`]: untouched(await proposalAt(set.dao, second.proposalId)),
      });
    });
  }

  await attack('1.9', 'a verdict used once, sent again after it expired', 'ERR_EXPIRED', async () => {
    for (let now = await chainNowMs(); now <= briefExpiry; now = await chainNowMs()) {
      console.log(`waiting ${Math.ceil((briefExpiry - now) / 1000)} s for the short-lived verdict to expire`);
      await sleep(Math.min(briefExpiry - now + 2000, 20_000));
    }
    return refusal(await veto(caller, set.guard, shortLived, brief.kindJson), 'ERR_EXPIRED', {
      'its first use did reject the request': rejectedBy(await proposalAt(set.dao, brief.proposalId), set.guard),
    });
  });

  const history = () => viewFinal(set.registry, 'history', { network: 'testnet', dao: set.dao, proposal_id: first.proposalId, from: 0, limit: 50 });
  await attack('1.10', 'CONTROL: the used verdict recorded in the registry', 'accepted as record 0', async () =>
    accepted(await record(caller, set.registry, used), { 'the registry holds one record for the request': (await history()).length === 1 }));
  await attack('1.11', 'the same verdict recorded a second time, to push it back to the top of the history', 'ERR_DUPLICATE', async () =>
    refusal(await record(caller, set.registry, used), 'ERR_DUPLICATE', { 'the registry still holds one record': (await history()).length === 1 }));
});
