#!/usr/bin/env node
// Attacks the split between the sealed program's owner and the watcher that calls it (rule C37 in
// docs/security/threat-model.md): can the key on the watcher's host replace the program the guard
// obeys?
//
//   node scripts/attack-sealed-owner.mjs
//     Testnet, inside WSL. Signs as the caller named in packages/sealed/testnet.json, whose key is
//     read from ~/.near-credentials/testnet and never printed. Costs a few thousandths of a testnet
//     NEAR in gas; every deposit comes back with its refused call.
//
// What it does, in order:
//   1. reads the project from OutLayer and checks its owner is the owner account of the record, and
//      that the caller is another account that holds none of the owner's keys;
//   2. as the caller, tries every call OutLayer gives a project's owner: publish a build and make it
//      active, choose the active build, remove a build, hand the project to itself, delete it.
//      OutLayer looks a project up under the account that calls, so the only way to name the
//      owner's project is by its full id, and that is what each try does;
//   3. reads the project again: same owner, same active build, same number of builds.
// Exit code 0 only when every try was refused on chain and nothing changed.
//
// Never sent: the same calls with the project's short name. Under the caller's account that name
// is the caller's own first project, from before the split, and the calls would act on it.
//
// Not covered: what the caller's key can still do, which is run the program and pay for it, so a
// thief of that key gets real verdicts on real requests and an empty account. Nor OutLayer's own
// operators, nor a change to OutLayer's contract.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO, TGAS, MILLI_NEAR, accountFor, call, provider, txLink, viewFinal } from './setup-demo-dao.mjs';

const record = JSON.parse(readFileSync(join(REPO, 'packages', 'sealed', 'testnet.json'), 'utf8'));
const { owner, caller, project_id: project, contract } = record;
const name = project?.split('/')[1];
const account = /^[a-z0-9._-]{2,64}$/;
if (record.network !== 'testnet' || contract !== 'outlayer.testnet' || !account.test(owner ?? '') || !account.test(caller ?? '') || project !== `${owner}/${name}`) {
  console.error('packages/sealed/testnet.json does not name a testnet project with an owner and a caller');
  process.exit(2);
}

const keysOf = async (accountId) => (await provider.viewAccessKeyList({ accountId, finalityQuery: { finality: 'final' } })).keys.map((k) => k.public_key);
const projectNow = async () => {
  const p = await viewFinal(contract, 'get_project', { project_id: project });
  const count = await viewFinal(contract, 'get_version_count', { project_id: project });
  return p === null ? null : { owner: p.owner, active: p.active_version, uuid: p.uuid, builds: Number(count) };
};
/** The contract's own words for a refusal, without the code location that follows them. */
const why = (failure) => {
  const text = JSON.stringify(failure ?? null);
  return (text.match(/Smart contract panicked: ([^"\\]{1,160})/)?.[1] ?? text.match(/"(MethodNotFound|MethodResolveError)[^}]{0,60}/)?.[0] ?? text.slice(0, 200)).trim();
};

async function main() {
  console.log(`Kaap sealed owner attack, ${new Date().toISOString()}: project ${project} on ${contract}, attacked by its caller ${caller}`);
  const before = await projectNow();
  if (before === null) throw new Error(`${contract} has no project ${project}: publish it first`);
  const [ownerKeys, callerKeys] = await Promise.all([keysOf(owner), keysOf(caller)]);
  const shared = ownerKeys.filter((k) => callerKeys.includes(k));
  console.log(`1. OutLayer names ${before.owner} as the owner; active build ${before.active}, ${before.builds} build(s), uuid ${before.uuid}`);
  console.log(`   keys: ${owner} has ${ownerKeys.length}, ${caller} has ${callerKeys.length}, in common ${shared.length}`);
  const apart = before.owner === owner && owner !== caller && ownerKeys.length > 0 && shared.length === 0;
  if (!apart) throw new Error('the owner and the caller are not apart; nothing was sent');
  // The full id as a name resolves under the caller to an id OutLayer cannot hold, since a name has
  // no slash. Checked before anything is signed, so no try can land on a real project.
  if ((await viewFinal(contract, 'get_project', { project_id: `${caller}/${project}` })) !== null) throw new Error(`${caller}/${project} exists; nothing was sent`);

  const attacker = accountFor(caller);
  const build = before.active;
  const source = { WasmUrl: { url: record.versions.find((v) => v.sha256 === build)?.url ?? 'https://example.org/kaap-sealed.wasm', hash: build, build_target: 'wasm32-wasip2' } };
  const tries = [
    ['publish a build and make it active', 'add_version', { project_name: project, source, set_active: true }, 50n * MILLI_NEAR],
    ['choose the active build', 'set_active_version', { project_name: project, version_key: build }, 0n],
    ['remove a build', 'remove_version', { project_name: project, version_key: build }, 0n],
    ['hand the project to itself', 'transfer_project', { project_name: project, new_owner: caller }, 0n],
    ['delete the project', 'delete_project', { project_name: project }, 0n],
  ];
  console.log(`2. ${caller} tries the owner's calls on ${project}:`);
  let refused = 0;
  for (const [what, method, args, deposit] of tries) {
    const sent = await call(attacker, contract, method, args, 100n * TGAS, deposit);
    if (sent.failure) refused += 1;
    console.log(`   ${sent.failure ? 'refused' : 'WENT THROUGH'}: ${what} (${method}): ${sent.failure ? why(sent.failure) : 'no failure'}: ${txLink(sent.hash)}`);
  }

  const after = await projectNow();
  const unchanged = after !== null && after.owner === before.owner && after.active === before.active && after.builds === before.builds && after.uuid === before.uuid;
  console.log(`3. the project now: owner ${after?.owner}, active build ${after?.active}, ${after?.builds} build(s): ${unchanged ? 'unchanged' : 'CHANGED'}`);
  const ok = refused === tries.length && unchanged;
  console.log(ok ? `RESULT: pass, ${refused} of ${tries.length} tries refused on chain and the project is unchanged` : `RESULT: FAIL (${refused} of ${tries.length} refused, project ${unchanged ? 'unchanged' : 'changed'})`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(`FAILED: ${e?.message ?? e}`);
  process.exit(1);
});
