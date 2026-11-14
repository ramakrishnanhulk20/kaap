#!/usr/bin/env node
// Wrong signer. The guard and the registry obey one key. This file hands them everything else an
// attacker can get hold of: a verdict signed by another key, a real verdict with the real
// signature of a different deployment's key, the AI model's own signature, a signature made
// without the domain prefix, signatures of the wrong length or with one bit flipped, and verdict
// bytes that are not exactly one version 1 verdict. Then it tries to get a new key trusted
// faster than the 24 hours the guard makes every key change wait (threat model C19).
//
// The contracts under attack are the copies lib/test-set.mjs sets up. They trust a public test
// key, so "the real key" of the live deployment is a wrong signer to them, exactly as the test
// key is to the live guard.
//
//   node packages/attack/attacks/02-wrong-signer.mjs
//
// What this does NOT cover: a key change taking effect after its 24 hours, which this file never
// waits for (it cancels the change it announces); theft of the signing key itself; and whether
// the sealed program's key can leave its hardware, which no contract can test.

import {
  CALL_GAS, LIVE, ONE_YOCTO, accepted, accountFor, attacker, call, chainNowMs, eventsBy, freshTarget, proposalAt, record,
  refusal, rejectedBy, settledProposal, untouched, veto, vetoResult, viewFinal,
} from '../lib/chain.mjs';
import { attack, main } from '../lib/report.mjs';
import { AI_RUN, keyBytes, liveRecord, runEvidence } from '../lib/sources.mjs';
import { testSet } from '../lib/test-set.mjs';
import { OTHER_KEY, TEST_KEY, ed25519Valid, signVerdict, signWithoutDomain, verdictFor } from '../lib/verdict.mjs';

const DAY_MS = 86_400_000;

await main('wrong signer', async () => {
  const set = await testSet();
  const owner = accountFor(set.operator);
  const caller = await attacker({ not: [set.operator], label: 'caller' });
  const pendingKey = () => viewFinal(set.guard, 'pending_key');
  const acceptedKey = () => viewFinal(set.guard, 'accepted_key');
  if ((await pendingKey()) !== null) {
    await call(owner, set.guard, 'cancel_key_change', {}, CALL_GAS, ONE_YOCTO);
    console.log('an earlier run left a key change announced; the owner cancelled it');
  }

  const target = await freshTarget(caller, set.dao, set.guard, '1');
  console.log(`test request: ${set.dao} #${target.proposalId}`);
  const stillOpen = async () => ({ [`#${target.proposalId} is untouched`]: untouched(await proposalAt(set.dao, target.proposalId)) });
  const noRecord = async () => ({
    'the registry holds nothing for the request': (await viewFinal(set.registry, 'latest', { network: 'testnet', dao: set.dao, proposal_id: target.proposalId })) === null,
  });
  const good = signVerdict(verdictFor(target), TEST_KEY);
  const withSignature = (bytes) => ({ verdict: good.verdict, signature: Buffer.from(bytes).toString('base64') });
  const goodSignature = Buffer.from(good.signature, 'base64');

  const stranger = signVerdict(verdictFor(target), OTHER_KEY);
  await attack('2.1', 'a verdict signed by a key the guard does not trust', 'ERR_BAD_SIGNATURE', async () =>
    refusal(await veto(caller, set.guard, stranger, target.kindJson), 'ERR_BAD_SIGNATURE', await stillOpen()));
  await attack('2.2', 'the same verdict offered to the registry', 'ERR_BAD_SIGNATURE', async () =>
    refusal(await record(caller, set.registry, stranger), 'ERR_BAD_SIGNATURE', await noRecord()));

  const real = await liveRecord(1);
  await attack('2.3', `a real verdict with its real signature by the live deployment's key, read from ${LIVE.registry}, handed to a guard that trusts another key`, 'ERR_BAD_SIGNATURE', async () =>
    refusal(await veto(caller, set.guard, real, target.kindJson), 'ERR_BAD_SIGNATURE', await stillOpen()));
  await attack('2.4', 'the same real verdict offered to a registry that trusts another key', 'ERR_BAD_SIGNATURE', async () =>
    refusal(await record(caller, set.registry, real), 'ERR_BAD_SIGNATURE'));

  const { evidence } = await runEvidence(AI_RUN);
  const model = evidence.signature;
  const modelSignature = Buffer.from(model.signature, 'hex');
  if (model.algo !== 'ed25519' || !ed25519Valid(Buffer.from(model.signing_address, 'hex'), Buffer.from(model.text, 'utf8'), modelSignature)) {
    throw new Error(`the public evidence of run ${AI_RUN} does not hold a valid signature by the AI model's key`);
  }
  // Paired with the verdict that 2.18 shows this guard accepting under its own signature, so the
  // signature is the only thing wrong with it.
  const modelSigned = withSignature(modelSignature);
  await attack('2.5', `the AI model's own signature, valid under the model's key, from the public evidence of sealed run ${AI_RUN}, in place of a good verdict's signature`, 'ERR_BAD_SIGNATURE', async () =>
    refusal(await veto(caller, set.guard, modelSigned, target.kindJson), 'ERR_BAD_SIGNATURE', {
      'the model\'s key is not the key the live guard obeys either': model.signing_address !== keyBytes(LIVE.acceptedKey).toString('hex'),
      ...(await stillOpen()),
    }));
  await attack('2.6', 'the same pair offered to the registry', 'ERR_BAD_SIGNATURE', async () =>
    refusal(await record(caller, set.registry, modelSigned), 'ERR_BAD_SIGNATURE'));

  await attack('2.7', 'the trusted key\'s signature over the verdict without the domain prefix', 'ERR_BAD_SIGNATURE', async () =>
    refusal(await veto(caller, set.guard, signWithoutDomain(verdictFor(target), TEST_KEY), target.kindJson), 'ERR_BAD_SIGNATURE', await stillOpen()));

  const flipped = Buffer.from(goodSignature);
  flipped[40] ^= 0x01;
  const shapes = [
    ['2.8', 'a correct signature with one bit flipped', flipped],
    ['2.9', 'a correct signature cut to 63 bytes', goodSignature.subarray(0, 63)],
    ['2.10', 'a correct signature with a 65th byte added', Buffer.concat([goodSignature, Buffer.from([0])])],
    ['2.11', 'an empty signature', Buffer.alloc(0)],
  ];
  for (const [id, what, bytes] of shapes) {
    await attack(id, what, 'ERR_BAD_SIGNATURE', async () =>
      refusal(await veto(caller, set.guard, withSignature(bytes), target.kindJson), 'ERR_BAD_SIGNATURE', await stillOpen()));
  }

  await attack('2.12', 'a correctly signed verdict with one byte added after its end', 'ERR_BAD_VERDICT', async () => {
    const longer = { verdict: Buffer.concat([Buffer.from(good.verdict, 'base64'), Buffer.from([0])]).toString('base64'), signature: good.signature };
    return refusal(await veto(caller, set.guard, longer, target.kindJson), 'ERR_BAD_VERDICT', await stillOpen());
  });
  await attack('2.13', 'a correctly signed verdict that says it is version 2', 'ERR_BAD_VERDICT', async () =>
    refusal(await veto(caller, set.guard, signVerdict(verdictFor(target, { version: 2 }), TEST_KEY), target.kindJson), 'ERR_BAD_VERDICT', await stillOpen()));

  try {
    await attack('2.14', 'CONTROL: the owner announces a new key', 'accepted; the new key only waits, and the old key is still the one obeyed', async () => {
      const before = await chainNowMs();
      const sent = await call(owner, set.guard, 'set_accepted_key', { key: OTHER_KEY.publicKey }, CALL_GAS, ONE_YOCTO);
      const pending = await pendingKey();
      const wait = (pending?.effective_at_ms ?? 0) - before;
      return accepted(sent, {
        'the announced key is waiting': pending?.key === OTHER_KEY.publicKey,
        'it may take effect no sooner than 24 hours on': wait >= DAY_MS && wait < DAY_MS + 120_000,
        'the obeyed key is unchanged': (await acceptedKey()) === TEST_KEY.publicKey,
        'key_change_announced was logged': eventsBy(sent.outcome, set.guard).includes('key_change_announced'),
      });
    });
    await attack('2.15', 'a verdict signed by the announced key, handed in before its 24 hours are over', 'ERR_BAD_SIGNATURE', async () =>
      refusal(await veto(caller, set.guard, stranger, target.kindJson), 'ERR_BAD_SIGNATURE', await stillOpen()));
    await attack('2.16', 'a stranger asks the guard to switch to the announced key at once', 'ERR_TOO_EARLY', async () =>
      refusal(await call(caller, set.guard, 'apply_key_change', {}), 'ERR_TOO_EARLY', {
        'the obeyed key is unchanged': (await acceptedKey()) === TEST_KEY.publicKey,
        'the announced key is still waiting': (await pendingKey())?.key === OTHER_KEY.publicKey,
      }));
    await attack('2.17', 'a stranger cancels the owner\'s key change', 'ERR_NOT_OWNER', async () =>
      refusal(await call(caller, set.guard, 'cancel_key_change', {}, CALL_GAS, ONE_YOCTO), 'ERR_NOT_OWNER', {
        'the announced key is still waiting': (await pendingKey())?.key === OTHER_KEY.publicKey,
      }));
    await attack('2.18', 'CONTROL: the verdict every refusal above was built from, with its own signature by the current key, while the change waits', 'accepted, and the request is rejected', async () =>
      accepted(await veto(caller, set.guard, good, target.kindJson), {
        'the request is Rejected by the guard alone': rejectedBy(await settledProposal(set.dao, target.proposalId), set.guard),
        'veto_result is Ok': (await vetoResult(set.guard, good.hash)) === 'Ok',
      }));
    await attack('2.19', 'CONTROL: the owner cancels the change', 'accepted; nothing waits and the old key stays', async () => {
      const sent = await call(owner, set.guard, 'cancel_key_change', {}, CALL_GAS, ONE_YOCTO);
      return accepted(sent, {
        'no key is waiting': (await pendingKey()) === null,
        'the obeyed key is unchanged': (await acceptedKey()) === TEST_KEY.publicKey,
        'key_change_cancelled was logged': eventsBy(sent.outcome, set.guard).includes('key_change_cancelled'),
      });
    });
  } finally {
    // An announced key left behind could be switched in by anyone a day later, and the copy
    // would stop obeying the test key.
    if ((await pendingKey()) !== null) await call(owner, set.guard, 'cancel_key_change', {}, CALL_GAS, ONE_YOCTO);
  }
  await attack('2.20', 'a stranger asks the guard to switch keys when none is announced', 'ERR_NO_PENDING_KEY', async () =>
    refusal(await call(caller, set.guard, 'apply_key_change', {}), 'ERR_NO_PENDING_KEY', {
      'the obeyed key is unchanged': (await acceptedKey()) === TEST_KEY.publicKey,
    }));
});
