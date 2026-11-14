#!/usr/bin/env node
// Access. Every method of the guard and the registry that changes something, called by an account
// with no right to call it or with input it must not take: a stranger replacing the trusted key,
// taking ownership, calling the guard's own callback, initialising a contract a second time; the
// owner's call sent without the one yoctoNEAR that proves a full-access key signed it; keys that
// are not exactly one ed25519 key; and, for the registry, verdicts for another network, without
// payment, oversized, malformed, and an older verdict recorded after a newer one to roll the
// record back (threat model C13, C19, C29).
//
// Two cases are doors that are open by design. The file says so on their lines and shows what
// walking through them changes.
//
// The contracts under attack are the copies lib/test-set.mjs sets up, which run the live code.
//
//   node packages/attack/attacks/06-access.mjs
//
// What this does NOT cover: the two-step owner transfer carried through, since handing the copy
// to another owner would break the other files (the contracts' own tests cover it); the account
// keys of the live contracts, which were deleted at deploy and can be checked on any explorer;
// and the views' paging limits, which need more records than this suite makes.

import {
  CALL_GAS, LIVE, ONE_YOCTO, accepted, accountFor, attacker, baseEncode, call, freshTarget, record, refusal, vetoResult, viewFinal,
  wasUsed,
} from '../lib/chain.mjs';
import { attack, main } from '../lib/report.mjs';
import { testSet } from '../lib/test-set.mjs';
import { MAX_VERDICT_BYTES, OTHER_KEY, TEST_KEY, encodeVerdict, signUnchecked, signVerdict, verdictFor } from '../lib/verdict.mjs';

/** A view that must fail: what the node answered, and whether it names `reason`. */
async function refusedView(contract, method, args, reason) {
  try {
    const value = await viewFinal(contract, method, args);
    return { observed: `ANSWERED ${JSON.stringify(value)}`, pass: false };
  } catch (e) {
    const text = String(e?.message ?? e).replace(/[^\x20-\x7e]/g, '?');
    return { observed: `refused with ${text.match(/ERR_[A-Z0-9_]+/)?.[0] ?? text.slice(0, 120)}`, pass: text.includes(reason) };
  }
}

await main('access', async () => {
  const set = await testSet();
  const owner = accountFor(set.operator);
  const caller = await attacker({ not: [set.operator], label: 'caller' });
  const me = caller.account.accountId;
  const guardAsBefore = async () => ({
    'the owner is unchanged': (await viewFinal(set.guard, 'owner')) === set.operator,
    'the trusted key is unchanged': (await viewFinal(set.guard, 'accepted_key')) === TEST_KEY.publicKey,
    'no key change is waiting': (await viewFinal(set.guard, 'pending_key')) === null,
  });

  await attack('6.1', 'a stranger announces a key of its own as the guard\'s trusted key', 'ERR_NOT_OWNER', async () =>
    refusal(await call(caller, set.guard, 'set_accepted_key', { key: OTHER_KEY.publicKey }, CALL_GAS, ONE_YOCTO), 'ERR_NOT_OWNER', await guardAsBefore()));
  await attack('6.2', 'a stranger names itself the next owner', 'ERR_NOT_OWNER', async () =>
    refusal(await call(caller, set.guard, 'propose_owner', { new_owner: me }, CALL_GAS, ONE_YOCTO), 'ERR_NOT_OWNER', await guardAsBefore()));
  await attack('6.3', 'a stranger accepts an ownership nobody offered it', 'ERR_NOT_PENDING_OWNER', async () =>
    refusal(await call(caller, set.guard, 'accept_owner', {}, CALL_GAS, ONE_YOCTO), 'ERR_NOT_PENDING_OWNER', await guardAsBefore()));

  const unused = signVerdict(verdictFor(await freshTarget(caller, set.dao, set.guard, '1')), TEST_KEY);
  await attack('6.4', 'a stranger calls the guard\'s own callback, to mark an unused verdict as already answered', 'refused: the method is private', async () =>
    refusal(await call(caller, set.guard, 'on_veto_result', { verdict_hash: unused.hash }), /private/i, {
      'the verdict is not marked used': (await wasUsed(set.guard, unused.hash)) === false,
      'it has no recorded answer': (await vetoResult(set.guard, unused.hash)) === null,
    }));
  await attack('6.5', 'a stranger initialises the guard a second time, with itself as owner and its own key', 'refused: the method is private', async () =>
    refusal(await call(caller, set.guard, 'new', { owner: me, accepted_key: OTHER_KEY.publicKey, network: 'testnet' }), /private|already been initialized/i, await guardAsBefore()));
  await attack('6.6', 'a stranger initialises the registry a second time with its own key', 'refused: the method is private', async () =>
    refusal(await call(caller, set.registry, 'new', { accepted_key: OTHER_KEY.publicKey, network: 'testnet' }), /private|already been initialized/i, {
      'the registry\'s trusted key is unchanged': (await viewFinal(set.registry, 'accepted_key')) === TEST_KEY.publicKey,
    }));

  await attack('6.7', 'the owner\'s key change sent without the one yoctoNEAR, as a limited access key would send it', 'ERR_NEED_ONE_YOCTO', async () =>
    refusal(await call(owner, set.guard, 'set_accepted_key', { key: OTHER_KEY.publicKey }), 'ERR_NEED_ONE_YOCTO', await guardAsBefore()));
  const bare = OTHER_KEY.publicKey.slice('ed25519:'.length);
  const notOneKey = [
    ['6.8', 'a key with its prefix in capitals', `ED25519:${bare}`],
    ['6.9', 'a key without its prefix', bare],
    ['6.10', 'a key that is too short', 'ed25519:abc'],
    ['6.11', 'a key of another curve', `secp256k1:${baseEncode(Buffer.alloc(64, 5))}`],
  ];
  for (const [id, what, key] of notOneKey) {
    await attack(id, `the owner announces ${what}, which the guard could never check a signature against`, 'ERR_BAD_KEY', async () =>
      refusal(await call(owner, set.guard, 'set_accepted_key', { key }, CALL_GAS, ONE_YOCTO), 'ERR_BAD_KEY', await guardAsBefore()));
  }
  await attack('6.12', 'was_used asked about something that is not a verdict hash', 'ERR_BAD_HASH, not an answer of "unused"', async () =>
    refusedView(set.guard, 'was_used', { verdict_hash_hex: 'not a hash' }, 'ERR_BAD_HASH'));

  const a = await freshTarget(caller, set.dao, set.guard, '2');
  const b = await freshTarget(caller, set.dao, set.guard, '3');
  console.log(`test requests for the registry: ${set.dao} #${a.proposalId}, #${b.proposalId}`);
  const latest = (t) => viewFinal(set.registry, 'latest', { network: 'testnet', dao: t.dao, proposal_id: t.proposalId });
  const history = (t) => viewFinal(set.registry, 'history', { network: 'testnet', dao: t.dao, proposal_id: t.proposalId, from: 0, limit: 50 });
  const nothingFor = async (t) => ({ 'the registry holds nothing for the request': (await latest(t)) === null });

  await attack('6.13', 'a correctly signed verdict written for mainnet, offered to the testnet registry', 'ERR_WRONG_NETWORK', async () =>
    refusal(await record(caller, set.registry, signVerdict(verdictFor(a, { network: 'mainnet' }), TEST_KEY)), 'ERR_WRONG_NETWORK', await nothingFor(a)));
  const plain = signVerdict(verdictFor(a), TEST_KEY);
  await attack('6.14', 'a correct verdict recorded with nothing attached, so the registry would pay for its storage', 'ERR_NOT_ENOUGH_DEPOSIT', async () =>
    refusal(await record(caller, set.registry, plain, 0n), 'ERR_NOT_ENOUGH_DEPOSIT', await nothingFor(a)));
  await attack('6.15', 'the same with one yoctoNEAR attached', 'ERR_NOT_ENOUGH_DEPOSIT', async () =>
    refusal(await record(caller, set.registry, plain, ONE_YOCTO), 'ERR_NOT_ENOUGH_DEPOSIT', await nothingFor(a)));
  await attack('6.16', `a correctly signed verdict of ${MAX_VERDICT_BYTES + 1} bytes, one over the limit`, 'ERR_TOO_LARGE', async () => {
    const room = MAX_VERDICT_BYTES - encodeVerdict(verdictFor(a)).length;
    const oversized = verdictFor(a, { model_id: 'm'.repeat(room + 1) });
    if (encodeVerdict(oversized).length !== MAX_VERDICT_BYTES + 1) throw new Error('the padded verdict is not one byte over the limit');
    return refusal(await record(caller, set.registry, signUnchecked(oversized, TEST_KEY)), 'ERR_TOO_LARGE', await nothingFor(a));
  });
  await attack('6.17', 'a correctly signed verdict whose treasury is not an account name', 'ERR_BAD_VERDICT', async () =>
    refusal(await record(caller, set.registry, signUnchecked(verdictFor(a, { dao: 'Not A Treasury' }), TEST_KEY)), 'ERR_BAD_VERDICT'));
  await attack('6.18', 'bytes that are not a verdict', 'ERR_BAD_VERDICT', async () =>
    refusal(await record(caller, set.registry, { verdict: Buffer.alloc(200, 0xab).toString('base64'), signature: Buffer.alloc(64, 1).toString('base64') }), 'ERR_BAD_VERDICT', await nothingFor(a)));
  await attack('6.19', 'a correctly signed verdict that says it is version 2', 'ERR_BAD_VERDICT', async () =>
    refusal(await record(caller, set.registry, signUnchecked(verdictFor(a, { version: 2 }), TEST_KEY)), 'ERR_BAD_VERDICT', await nothingFor(a)));
  await attack('6.20', 'the registry asked for a network it does not know', 'ERR_BAD_NETWORK', async () =>
    refusedView(set.registry, 'latest', { network: 'Testnet', dao: a.dao, proposal_id: a.proposalId }, 'ERR_BAD_NETWORK'));

  await attack('6.21', `BY DESIGN: a correctly signed verdict that names another guard (${LIVE.guard})`, 'recorded, and the record says which guard it names', async () =>
    accepted(await record(caller, set.registry, signVerdict(verdictFor(a, { guard: LIVE.guard }), TEST_KEY)), {
      'the record names that other guard, not this deployment\'s': (await latest(a))?.guard === LIVE.guard,
    }));

  const newer = signVerdict(verdictFor(b), TEST_KEY);
  const older = signVerdict(verdictFor(b, { block_height: b.blockHeight - 100, risk: 'low', floor: 'low', findings: [] }), TEST_KEY);
  await attack('6.22', 'CONTROL: a critical verdict recorded for a request', 'accepted as the latest', async () =>
    accepted(await record(caller, set.registry, newer), { 'it is the latest': (await latest(b))?.verdict_hash === newer.hash }));
  await attack('6.23', 'BY DESIGN: an older, harmless-looking verdict for the same request recorded afterwards, to roll the record back', 'kept in the history, never the latest', async () => {
    const sent = await record(caller, set.registry, older);
    const all = await history(b);
    const current = await latest(b);
    return accepted(sent, {
      'the latest is still the critical one': current?.verdict_hash === newer.hash && current?.risk === 'critical',
      'the history holds both': all.length === 2,
      'the older one replaces nothing': all[1]?.verdict_hash === older.hash && all[1]?.supersedes === null,
    });
  });
});
