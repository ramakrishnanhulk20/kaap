#!/usr/bin/env node
// Sets up what the attack suite attacks, so that no attack ever touches the live deployment:
//
// - a second guard and a second registry, each the same wasm the live one runs. That is proven
//   twice: the file's sha256 equals the one deployments/testnet.json records, and the code hash
//   the chain reports for the copy equals the one it reports for the live contract;
// - both copies trust the public test key (lib/verdict.mjs) and not the sealed program's key, so
//   an attack can hand them a verdict the real key would never sign;
// - three throwaway Sputnik 3.2 DAOs whose policy gives the second guard the same reject-only
//   role the demo treasury gives the live guard: one enrolled, one enrolled in strict mode
//   (`veto_unreadable`), one that never enrols. No role in any of them may approve a transfer, so
//   the test requests, all transfers of a few yoctoNEAR, can never pay out.
//
// Each contract account's full-access key is deleted at the end, as the live deploy does.
//
// Idempotent: each finished step is written to packages/attack/testnet.json at once (or to the
// file KAAP_ATTACK_SET names), and a second run reuses and checks what is recorded. It never
// writes deployments/.
//
// Testnet only. On Linux or inside WSL, with Node 24 and near-api-js 7.4.0 at the repo root:
//   node packages/attack/lib/test-set.mjs
// It uses the two wasm files the live deployment was made from when they are on this machine
// (KAAP_GUARD_WASM and KAAP_REGISTRY_WASM, or ~/kaap-target/near-deploy/ where
// scripts/deploy-contracts-testnet.sh leaves them), and otherwise takes the same bytes from the
// chain. The faucet funds every account.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  GUARD_REJECT_LABELS, LIVE, MILLI_NEAR, PublicKey, SPUTNIK_CODE_HASH, TGAS, accountFor, accountState, actions, attacker,
  baseEncode, call, createFaucetAccount, fileProposal, provider, requireTestnet, send, sleep, stamp, txLink, viewFinal, viewFinalRaw,
} from './chain.mjs';
import { REPO, core } from './core.mjs';
import { TEST_KEY } from './verdict.mjs';

// KAAP_ATTACK_SET names another record file, for someone who sets up copies of their own: the
// recorded copy's owner key is only on the machine that made it.
export const TEST_SET_FILE = process.env.KAAP_ATTACK_SET || join(REPO, 'packages', 'attack', 'testnet.json');
const SPUTNIK_WASM = join(REPO, 'packages', 'contracts', 'tests', 'wasm', 'sputnik-dao-3.2.wasm');
const BUILDS = join(process.env.CARGO_TARGET_DIR || join(homedir(), 'kaap-target'), 'near-deploy');
const GUARD_WASM = process.env.KAAP_GUARD_WASM || join(BUILDS, 'kaap_guard.wasm');
const REGISTRY_WASM = process.env.KAAP_REGISTRY_WASM || join(BUILDS, 'kaap_registry.wasm');
const GUARD_ROLE = 'guard';
// packages/contracts/GAS.md: 0.01 NEAR always covers an enrolment's storage, and the guard sends
// the rest straight back; enroll burns 1.88 Tgas.
const ENROL_DEPOSIT = 10n * MILLI_NEAR;
const ENROL_GAS = 10n * TGAS;
const WEEK_NS = '604800000000000';
const DAOS = [
  { field: 'dao', prefix: 'kaap-attack-dao', enrol: {}, strict: false },
  { field: 'strict_dao', prefix: 'kaap-attack-strict', enrol: { veto_unreadable: true }, strict: true },
  { field: 'unenrolled_dao', prefix: 'kaap-attack-unenrolled', enrol: null, strict: false },
];

const save = (set) => writeFileSync(TEST_SET_FILE, JSON.stringify(set, null, 2) + '\n');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest();
const codeOf = async (id) => (await accountState(id))?.code_hash;

/** The suite's test set as recorded, checked against the chain: both copies still run the code
 *  the live contracts run today, both still trust only the test key, and the three DAOs are
 *  enrolled as recorded. Throws when anything differs, so no attack runs on a stale copy. */
export async function testSet() {
  await requireTestnet();
  if (!existsSync(TEST_SET_FILE)) throw new Error(`no test set is recorded at ${TEST_SET_FILE}: run node packages/attack/lib/test-set.mjs`);
  const set = JSON.parse(readFileSync(TEST_SET_FILE, 'utf8'));
  const entries = [set.guard, set.registry, set.dao, set.strict_dao, set.unenrolled_dao];
  if (!entries.every((e) => e?.account_id && e.access_keys_left === 0)) {
    throw new Error(`the test set in ${TEST_SET_FILE} is not finished: run node packages/attack/lib/test-set.mjs`);
  }
  try {
    accountFor(set.set_up_by_account);
  } catch {
    // Several attacks are the copy's owner making a mistake, and only its owner can sign those.
    throw new Error(`the key of ${set.set_up_by_account}, which owns the recorded copies, is not on this machine: set up copies of your own with KAAP_ATTACK_SET=<a new file> node packages/attack/lib/test-set.mjs, and run the attacks with the same variable`);
  }
  const guard = set.guard.account_id;
  const registry = set.registry.account_id;
  const [guardCode, liveGuardCode, registryCode, liveRegistryCode] = await Promise.all([guard, LIVE.guard, registry, LIVE.registry].map(codeOf));
  if (guardCode !== liveGuardCode || guardCode !== LIVE.guardCodeHash) {
    throw new Error(`${guard} runs ${guardCode}; the live guard ${LIVE.guard} runs ${liveGuardCode}: set the copies up again`);
  }
  if (registryCode !== liveRegistryCode || registryCode !== LIVE.registryCodeHash) {
    throw new Error(`${registry} runs ${registryCode}; the live registry ${LIVE.registry} runs ${liveRegistryCode}: set the copies up again`);
  }
  for (const id of [guard, registry]) {
    const key = await viewFinal(id, 'accepted_key');
    if (key !== TEST_KEY.publicKey) throw new Error(`${id} accepts ${key}, not the test key`);
  }
  const out = { guard, registry, operator: set.set_up_by_account, guardCode, liveGuardCode, registryCode, liveRegistryCode };
  for (const { field, enrol, strict } of DAOS) {
    const id = set[field].account_id;
    const enrolled = await viewFinal(guard, 'is_enrolled', { dao: id });
    const mode = await viewFinal(guard, 'veto_unreadable', { dao: id });
    if (enrolled !== (enrol !== null) || mode !== strict) throw new Error(`${id} is enrolled: ${enrolled}, strict: ${mode}, not as recorded`);
    out[field.replace(/_dao$/, 'Dao')] = id;
  }
  console.log(`under attack: ${guard}, code ${guardCode}, the code the live guard ${LIVE.guard} runs; ${registry}, code ${registryCode}, the code the live registry ${LIVE.registry} runs. Both trust only the public test key.`);
  return out;
}

function wasm(path, wantSha256, wantHash, what) {
  if (!existsSync(path)) throw new Error(`no ${what} wasm at ${path}`);
  return checked(readFileSync(path), path, wantSha256, wantHash, what);
}

function checked(bytes, from, wantSha256, wantHash, what) {
  const digest = sha256(bytes);
  if (digest.toString('hex') !== wantSha256 || baseEncode(digest) !== wantHash) {
    throw new Error(`${from} has sha256 ${digest.toString('hex')}, not the ${what}'s ${wantSha256}`);
  }
  return bytes;
}

/** The code a live contract runs: the local build when there is one, or else the bytes the chain
 *  itself holds for the account, so anyone can make copies without rebuilding. Either way the
 *  sha256 must be the one deployments/testnet.json records. */
async function liveCode(path, account, wantSha256, wantHash, what) {
  if (existsSync(path)) return wasm(path, wantSha256, wantHash, what);
  const answer = await provider.sendJsonRpc('query', { request_type: 'view_code', finality: 'final', account_id: account });
  console.log(`no build at ${path}: took the ${what}'s code from the chain (${account})`);
  return checked(Buffer.from(answer.code_base64, 'base64'), `the code of ${account} on chain`, wantSha256, wantHash, what);
}

/** The demo treasury's guard role, for `guard`, beside a council that may file requests and
 *  approve only function calls (the DAO's own enrolment), and an Everyone role that may only
 *  file, as Sputnik's default lets anyone do. */
function throwawayPolicy(council, guard) {
  const one = { weight_kind: 'RoleWeight', quorum: '0', threshold: '1' };
  return {
    roles: [
      { name: 'council', kind: { Group: [council] }, permissions: ['*:AddProposal', 'call:VoteApprove'], vote_policy: { call: one } },
      { name: 'anyone', kind: 'Everyone', permissions: ['*:AddProposal'], vote_policy: {} },
      {
        name: GUARD_ROLE,
        kind: { Group: [guard] },
        permissions: GUARD_REJECT_LABELS.map((label) => `${label}:VoteReject`),
        vote_policy: Object.fromEntries(GUARD_REJECT_LABELS.map((label) => [label, one])),
      },
    ],
    default_vote_policy: { weight_kind: 'RoleWeight', quorum: '0', threshold: [1, 2] },
    proposal_bond: '0',
    proposal_period: WEEK_NS,
    bounty_bond: '0',
    bounty_forgiveness_period: WEEK_NS,
  };
}

async function keysLeft(accountId) {
  return (await provider.viewAccessKeyList({ accountId, finalityQuery: { finality: 'final' } })).keys.length;
}

async function freshAccount(entry, prefix, set) {
  if (entry.account_id) return;
  entry.account_id = `${prefix}-${stamp()}.testnet`;
  await createFaucetAccount(entry.account_id);
  save(set);
  console.log(`created ${entry.account_id} (faucet)`);
  // The faucet answers before every RPC node has the account.
  await sleep(2000);
}

/** Deploys one of Kaap's contracts to a fresh faucet account, runs `new` in the same
 *  transaction, and checks the chain reports the live contract's code hash for it. */
async function deployCopy(entry, prefix, code, args, live, set) {
  await freshAccount(entry, prefix, set);
  const id = entry.account_id;
  if (!entry.deploy_and_init_tx) {
    const { hash, failure } = await send(accountFor(id), id, [actions.deployContract(code.bytes), actions.functionCall('new', args, 100n * TGAS, 0n)]);
    if (failure) throw new Error(`deploy and init of ${id} failed in ${txLink(hash)}`);
    entry.deploy_and_init_tx = hash;
    save(set);
    console.log(`deployed to ${id} and ran new: ${txLink(hash)}`);
  }
  entry.code_hash = await codeOf(id);
  entry.code_sha256 = code.sha256;
  entry.copy_of = live.account;
  entry.live_code_hash = await codeOf(live.account);
  if (entry.code_hash !== entry.live_code_hash || entry.code_hash !== live.codeHash) {
    throw new Error(`${id} runs ${entry.code_hash}; ${live.account} runs ${entry.live_code_hash}; the record says ${live.codeHash}`);
  }
  entry.same_code_as_live = true;
  entry.accepted_key = await viewFinal(id, 'accepted_key');
  entry.network = await viewFinal(id, 'network');
  if (entry.accepted_key !== TEST_KEY.publicKey || entry.network !== 'testnet') {
    throw new Error(`${id} was initialised with ${entry.accepted_key}, ${entry.network}`);
  }
  save(set);
  console.log(`${id}: code ${entry.code_hash}, equal to ${live.account}; accepts ${entry.accepted_key}`);
}

/** Sputnik DAO 3.2's code. It is not kept in the repository, so it is fetched from mainnet by
 *  its hash the first time, as the contracts' own tests do. */
function sputnikCode() {
  if (!existsSync(SPUTNIK_WASM)) execFileSync('bash', [join(REPO, 'scripts', 'fetch-sputnik-wasm.sh')], { stdio: 'inherit' });
  return wasm(SPUTNIK_WASM, 'bf6f951ee5e45968e3367fa857bebf8bc80badec183998c2239c487237e0d7f6', SPUTNIK_CODE_HASH, 'Sputnik 3.2');
}

/** Deploys Sputnik 3.2 to a fresh faucet account and runs `new` in the same transaction. */
async function deployDao(entry, prefix, operator, guard, sputnik, set) {
  await freshAccount(entry, prefix, set);
  const id = entry.account_id;
  if (!entry.deploy_and_init_tx) {
    const policy = throwawayPolicy(operator, guard);
    const config = { name: id.split('.')[0], purpose: 'Kaap attack suite throwaway DAO, holds nothing', metadata: '' };
    const { hash, failure } = await send(accountFor(id), id, [actions.deployContract(sputnik), actions.functionCall('new', { config, policy }, 150n * TGAS, 0n)]);
    if (failure) throw new Error(`deploy and init of ${id} failed in ${txLink(hash)}`);
    entry.deploy_and_init_tx = hash;
    save(set);
    console.log(`deployed Sputnik 3.2 to ${id} and ran new: ${txLink(hash)}`);
  }
  entry.code_hash = await codeOf(id);
  if (entry.code_hash !== SPUTNIK_CODE_HASH) throw new Error(`${id} runs ${entry.code_hash}, not Sputnik 3.2`);
  const { text } = await viewFinalRaw(id, 'get_policy');
  const arming = JSON.parse(core.guardArming(text, guard));
  if (!arming.rejects_alone.includes('transfer') || arming.approval_votes_needed.transfer !== 'none') {
    throw new Error(`${id}'s policy does not let ${guard} reject a transfer alone while nothing can approve one`);
  }
  entry.guard_role = `${GUARD_ROLE}: [${guard}], VoteReject on ${GUARD_REJECT_LABELS.length} labels, threshold 1`;
  entry.arming = `kaap-core guardArming on the live policy: the guard rejects alone on ${arming.rejects_alone.length} labels; transfer approval votes needed: none`;
  save(set);
}

/** Enrols `dao` in `guard` through the DAO's own approved request, with the given `enroll`
 *  arguments. */
async function enrol(entry, guard, operator, args, set) {
  const dao = entry.account_id;
  const e = (entry.enrolment ??= {});
  if (!(await viewFinal(guard, 'is_enrolled', { dao }))) {
    const op = accountFor(operator);
    if (e.proposal_id === undefined) {
      const kind = {
        FunctionCall: {
          receiver_id: guard,
          actions: [{ method_name: 'enroll', args: Buffer.from(JSON.stringify(args)).toString('base64'), deposit: ENROL_DEPOSIT.toString(), gas: ENROL_GAS.toString() }],
        },
      };
      const filed = await fileProposal(op, dao, `Enrol this DAO in the test-key guard ${guard}.`, kind);
      e.proposal_id = filed.id;
      e.add_proposal_tx = filed.hash;
      save(set);
      console.log(`filed enrolment request #${filed.id} on ${dao}: ${txLink(filed.hash)}`);
    }
    const p = await viewFinal(dao, 'get_proposal', { id: e.proposal_id });
    if (p.status === 'InProgress') {
      const { hash, failure } = await call(op, dao, 'act_proposal', { id: e.proposal_id, action: 'VoteApprove', proposal: p.kind }, 300n * TGAS);
      if (failure) throw new Error(`approving the enrolment failed in ${txLink(hash)}`);
      e.vote_tx = hash;
      save(set);
      console.log(`${operator} approved #${e.proposal_id}: ${txLink(hash)}`);
    }
  }
  if (!(await viewFinal(guard, 'is_enrolled', { dao }))) throw new Error(`${guard} does not list ${dao} as enrolled`);
  e.enrolled = true;
  e.veto_unreadable = await viewFinal(guard, 'veto_unreadable', { dao });
  if (e.veto_unreadable !== (args.veto_unreadable === true)) throw new Error(`${dao} enrolled with strict mode ${e.veto_unreadable}`);
  save(set);
}

async function main() {
  console.log(`Kaap attack suite test set, ${new Date().toISOString()}`);
  await requireTestnet();
  // All three contracts' code is in hand before any account is made, so a missing file cannot
  // leave a half-made set behind.
  const sputnik = sputnikCode();
  const guardCode = { bytes: await liveCode(GUARD_WASM, LIVE.guard, LIVE.guardSha256, LIVE.guardCodeHash, 'live guard'), sha256: LIVE.guardSha256 };
  const registryCode = { bytes: await liveCode(REGISTRY_WASM, LIVE.registry, LIVE.registrySha256, LIVE.registryCodeHash, 'live registry'), sha256: LIVE.registrySha256 };

  const set = existsSync(TEST_SET_FILE) ? JSON.parse(readFileSync(TEST_SET_FILE, 'utf8')) : {};
  if (set.guard?.code_hash && set.guard.code_hash !== LIVE.guardCodeHash) {
    throw new Error(`${TEST_SET_FILE} records copies of an earlier deployment (${set.guard.code_hash}); move that file aside and run this again`);
  }
  set.network = 'testnet';
  set.purpose = 'what the attack suite attacks: copies of the guard and the registry that trust a public test key, and throwaway DAOs; never part of Kaap\'s deployment';
  set.set_up_by = 'packages/attack/lib/test-set.mjs';
  set.test_key = {
    public_key: TEST_KEY.publicKey,
    seed: 'thirty-two bytes of 7, the public verdict key seed of the contracts\' sandbox tests: anyone can sign with it, by design',
  };
  if (!set.set_up_by_account) {
    set.set_up_by_account = (await attacker({ label: 'operator' })).account.accountId;
    save(set);
  }
  const operator = set.set_up_by_account;
  accountFor(operator);

  set.guard ??= {};
  await deployCopy(set.guard, 'kaap-attack-guard', guardCode, { owner: operator, accepted_key: TEST_KEY.publicKey, network: 'testnet' }, { account: LIVE.guard, codeHash: LIVE.guardCodeHash }, set);
  set.guard.owner = await viewFinal(set.guard.account_id, 'owner');
  if (set.guard.owner !== operator) throw new Error(`${set.guard.account_id} is owned by ${set.guard.owner}`);
  set.registry ??= {};
  await deployCopy(set.registry, 'kaap-attack-registry', registryCode, { accepted_key: TEST_KEY.publicKey, network: 'testnet' }, { account: LIVE.registry, codeHash: LIVE.registryCodeHash }, set);

  const guard = set.guard.account_id;
  for (const { field, prefix, enrol: args } of DAOS) {
    set[field] ??= {};
    await deployDao(set[field], prefix, operator, guard, sputnik, set);
    if (args) await enrol(set[field], guard, operator, args, set);
    else {
      if (await viewFinal(guard, 'is_enrolled', { dao: set[field].account_id })) throw new Error(`${set[field].account_id} is enrolled, so it cannot stand for a DAO that never enrolled`);
      set[field].enrolled = false;
      save(set);
    }
  }

  for (const entry of [set.guard, set.registry, ...DAOS.map(({ field }) => set[field])]) {
    if ((await keysLeft(entry.account_id)) > 0) {
      const holder = accountFor(entry.account_id);
      const { hash, failure } = await send(holder, entry.account_id, [actions.deleteKey(PublicKey.fromString(holder.publicKey))]);
      if (failure) throw new Error(`deleting ${entry.account_id}'s key failed in ${txLink(hash)}`);
      entry.full_access_key_deleted_tx = hash;
      console.log(`deleted ${entry.account_id}'s only full-access key: ${txLink(hash)}`);
    }
    entry.access_keys_left = await keysLeft(entry.account_id);
    if (entry.access_keys_left !== 0) throw new Error(`${entry.account_id} still has ${entry.access_keys_left} access key(s)`);
    save(set);
  }
  set.checked_at = new Date().toISOString();
  save(set);
  await testSet();
  console.log(`test set written to ${TEST_SET_FILE}`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (e) {
    console.error(`test set stopped: ${e?.message ?? e}`);
    process.exit(1);
  }
}
