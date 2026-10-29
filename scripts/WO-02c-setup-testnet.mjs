#!/usr/bin/env node
// Sets up the testnet treasury Kaap's M1 proof runs against: a Sputnik DAO running the exact 3.2
// code, with the role setup of a live NEAR Business treasury (deployments/near-business-policy.json,
// members removed) and our demo accounts in its two member places, plus a reject-only `guard` role held by the
// deployed kaap-guard, which the DAO joins through its own approved proposal. Last, the DAO's own
// full-access key is deleted, as a factory-made DAO has none.
//
// Idempotent: each finished step is written to deployments/testnet.json at once, and a second
// run reuses what is recorded and only checks it.
//
// Testnet only. Run inside WSL, where the keys live (~/.near-credentials/testnet), with Node 24
// and near-api-js 7.4.0 at the repo root:
//   npm install --no-save --no-package-lock near-api-js@7.4.0
//   node scripts/WO-02c-setup-testnet.mjs
// The faucet pays for every new account, so no funds are needed. The guard owner's key (from
// deployments/testnet.json) must be in the keychain, because the owner is one of the two Approvers.
//
// The other helpers here (signing, waiting for final, reading at final) are exported for
// scripts/prove-m1.mjs, so both scripts send and read the chain the same way.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(join(REPO, '.env'))) process.loadEnvFile(join(REPO, '.env'));

export const NEAR_API_JS_VERSION = '7.4.0';
{
  const entry = fileURLToPath(import.meta.resolve('near-api-js'));
  const found = JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8')).version;
  if (found !== NEAR_API_JS_VERSION) {
    console.error(`near-api-js ${found} is installed; these scripts are pinned to ${NEAR_API_JS_VERSION}`);
    process.exit(2);
  }
}
export const { Account, JsonRpcProvider, KeyPair, KeyPairSigner, PublicKey, actions, baseEncode } = await import('near-api-js');

export const NETWORK = 'testnet';
export const DEPLOYMENTS = join(REPO, 'deployments', 'testnet.json');
const POLICY_FILE = join(REPO, 'deployments', 'near-business-policy.json');
const SPUTNIK_WASM = join(REPO, 'packages', 'contracts', 'tests', 'wasm', 'sputnik-dao-3.2.wasm');
export const SPUTNIK_CODE_HASH = 'DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF';
const SPUTNIK_SHA256 = 'bf6f951ee5e45968e3367fa857bebf8bc80badec183998c2239c487237e0d7f6';
const TEMPLATE = 'the NEAR Business template';
// Member places in the saved template. The guard owner takes the first, the demo member the second.
const SLOTS = ['<member 1>', '<member 2>'];
export const GUARD_ROLE = 'guard';
// Sputnik's to_policy_label (proposals.rs 125-147) without remove_member_from_role, so the DAO
// can always remove Kaap: the guard may reject anything except its own removal.
export const GUARD_REJECT_LABELS = [
  'config', 'policy', 'add_member_to_role', 'call', 'upgrade_self', 'upgrade_remote', 'transfer',
  'set_vote_token', 'add_bounty', 'bounty_done', 'vote', 'factory_info_update',
  'policy_add_or_update_role', 'policy_remove_role', 'policy_update_default_vote_policy',
  'policy_update_parameters',
];
export const TGAS = 10n ** 12n;
export const MILLI_NEAR = 10n ** 21n;
// packages/contracts/GAS.md: 0.01 NEAR always covers an enrolment's storage, and the guard sends
// the rest straight back; enroll burns 1.88 Tgas, the guard's README asks for 10.
const ENROL_DEPOSIT = 10n * MILLI_NEAR;
const ENROL_GAS = 10n * TGAS;
const NO_CODE = '11111111111111111111111111111111';

const TESTNET_RPC = process.env.KAAP_TESTNET_RPC || 'https://rpc.testnet.fastnear.com';
const TESTNET_ARCHIVAL_RPC = process.env.KAAP_TESTNET_ARCHIVAL_RPC || 'https://archival-rpc.testnet.fastnear.com';
const MAINNET_RPC = process.env.KAAP_MAINNET_RPC || 'https://rpc.mainnet.fastnear.com';
const FAUCET_URL = process.env.KAAP_TESTNET_FAUCET || 'https://helper.nearprotocol.com/account';
const CREDENTIALS = join(homedir(), '.near-credentials', NETWORK);

export const provider = new JsonRpcProvider({ url: TESTNET_RPC });
const archival = new JsonRpcProvider({ url: TESTNET_ARCHIVAL_RPC });

export const txLink = (hash) => `https://testnet.nearblocks.io/txns/${hash}`;
export const accountLink = (id) => `https://testnet.nearblocks.io/address/${id}`;
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const toNear = (yocto) => (Number(BigInt(yocto)) / 1e24).toFixed(6);
export const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(4, 14);

/** An Account that signs with the full-access key near-cli keeps for `accountId`. The private
 *  key is read from the keychain file and held in memory only; no message ever carries it. */
export function accountFor(accountId) {
  const file = join(CREDENTIALS, `${accountId}.json`);
  if (!existsSync(file)) throw new Error(`no key for ${accountId}: expected ${file}`);
  let saved;
  let signer;
  try {
    saved = JSON.parse(readFileSync(file, 'utf8'));
    signer = new KeyPairSigner(KeyPair.fromString(saved.private_key));
  } catch {
    throw new Error(`${file} does not hold a readable ed25519 key pair`);
  }
  return { account: new Account(accountId, provider, signer), publicKey: saved.public_key, signer };
}

/** Polls the transaction until every receipt is final. Each poll is a read, so retrying one that
 *  failed is harmless; the deadline is what fails closed. */
export async function finalOutcome(hash, senderId, timeoutMs = 240_000) {
  const until = Date.now() + timeoutMs;
  let last = '';
  for (;;) {
    try {
      const result = await provider.viewTransactionStatusWithReceipts({ txHash: hash, accountId: senderId, waitUntil: 'FINAL' });
      if (result?.final_execution_status === 'FINAL') return result;
      last = `status ${result?.final_execution_status}`;
    } catch (e) {
      last = String(e?.message ?? e).slice(0, 200);
    }
    if (Date.now() > until) throw new Error(`transaction ${hash} was not final after ${timeoutMs / 1000} s (last answer: ${last})`);
    await sleep(2000);
  }
}

/** Signs, sends and waits for the final outcome. The hash is taken from the signed bytes before
 *  sending, so a send that times out is still followed to its outcome rather than sent twice. */
export async function send(from, receiverId, actionList) {
  const tx = await from.account.createTransaction({ receiverId, actions: actionList, publicKey: await from.signer.getPublicKey() });
  const { txHash, signedTransaction } = await from.signer.signTransaction(tx);
  const hash = baseEncode(txHash);
  try {
    await provider.sendTransactionUntil(signedTransaction, 'INCLUDED');
  } catch (e) {
    if (e?.constructor?.name !== 'TransactionTimeoutError') throw new Error(`sending ${hash} failed: ${String(e?.message ?? e).slice(0, 300)}`);
  }
  const outcome = await finalOutcome(hash, from.account.accountId);
  return { hash, outcome, failure: outcome.status?.Failure ?? null };
}

export const call = (from, contractId, method, args, gas, deposit = 0n) =>
  send(from, contractId, [actions.functionCall(method, args, gas, deposit)]);

/** The value a successful transaction returned, parsed as JSON when it is JSON. */
export function returned(outcome) {
  const value = outcome.status?.SuccessValue;
  if (value === undefined) return undefined;
  const text = Buffer.from(value, 'base64').toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The contract's own panic text, such as ERR_REPLAY, from a failed outcome. */
export function refusal(failure) {
  const text = JSON.stringify(failure ?? null);
  return text.match(/ERR_[A-Z0-9_]+/)?.[0] ?? text.slice(0, 300);
}

/** Every NEP-297 event a transaction's receipts logged, with the account that logged it. */
export function events(outcome) {
  return outcome.receipts_outcome.flatMap((r) =>
    r.outcome.logs
      .filter((line) => line.startsWith('EVENT_JSON:'))
      .map((line) => {
        try {
          return { by: r.outcome.executor_id, ...JSON.parse(line.slice('EVENT_JSON:'.length)) };
        } catch {
          return { by: r.outcome.executor_id, event: 'unreadable' };
        }
      }),
  );
}

/** Gas burnt by every outcome of a transaction, in yoctoNEAR: what its sender paid for it. */
export const burnt = (outcome) =>
  [outcome.transaction_outcome, ...outcome.receipts_outcome].reduce((sum, o) => sum + BigInt(o.outcome.tokens_burnt), 0n);

const blocks = new Map();
export async function blockAt(hash) {
  if (!blocks.has(hash)) {
    const b = await provider.viewBlock({ blockId: hash });
    blocks.set(hash, { height: b.header.height, ms: Number(BigInt(b.header.timestamp_nanosec) / 1_000_000n) });
  }
  return blocks.get(hash);
}

export const viewFinal = (contractId, method, args = {}) =>
  provider.callFunction({ contractId, method, args, blockQuery: { finality: 'final' } });

/** A view's raw bytes and the final block they were read at, for callers that must keep the
 *  bytes exactly as the contract returned them. */
export async function viewFinalRaw(contractId, method, args = {}) {
  const r = await provider.callFunctionRaw({ contractId, method, args, blockQuery: { finality: 'final' } });
  return { text: Buffer.from(r.result).toString('utf8'), blockHeight: r.block_height };
}

export async function accountState(accountId) {
  try {
    return await provider.viewAccount({ accountId, blockQuery: { finality: 'final' } });
  } catch (e) {
    if (/does not exist|UNKNOWN_ACCOUNT|AccountDoesNotExist/i.test(`${e?.constructor?.name} ${e?.message}`)) return null;
    throw e;
  }
}

async function waitForAccount(accountId, timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs;
  while (!(await accountState(accountId))) {
    if (Date.now() > until) throw new Error(`${accountId} did not appear at final finality within ${timeoutMs / 1000} s`);
    await sleep(2000);
  }
}

/** A fresh ed25519 key for `accountId`, saved where near-cli keeps its legacy keychain before any
 *  account is made with it, so a crash never leaves an account whose key nobody holds. An existing
 *  key file is never replaced. Returns the public key. */
export function newSavedKey(accountId) {
  const file = join(CREDENTIALS, `${accountId}.json`);
  const keyPair = KeyPair.fromRandom('ed25519');
  const publicKey = keyPair.getPublicKey().toString();
  mkdirSync(CREDENTIALS, { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ account_id: accountId, public_key: publicKey, private_key: keyPair.toString() }) + '\n', { mode: 0o600, flag: 'wx' });
  return publicKey;
}

/** Creates `accountId` through the testnet faucet with a fresh saved key. */
export async function createFaucetAccount(accountId) {
  const publicKey = newSavedKey(accountId);
  const res = await fetch(FAUCET_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: publicKey }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`the faucet answered HTTP ${res.status} for ${accountId}: ${(await res.text()).slice(0, 200)}`);
  await waitForAccount(accountId);
}

export function loadState() {
  return JSON.parse(readFileSync(DEPLOYMENTS, 'utf8'));
}

function saveState(state) {
  writeFileSync(DEPLOYMENTS, JSON.stringify(state, null, 2) + '\n');
}

/** Object keys sorted, and Sputnik's two sets (a Group's members, a role's permissions) sorted,
 *  because Sputnik stores both as hash sets whose JSON order is not fixed (threat model C5). */
function policyForm(policy) {
  const sortKeys = (v) =>
    Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v;
  const roles = policy.roles.map((role) => ({
    ...role,
    kind: role.kind?.Group ? { Group: [...role.kind.Group].sort() } : role.kind,
    permissions: [...role.permissions].sort(),
  }));
  return JSON.stringify(sortKeys({ ...policy, roles }));
}

/** The template's policy with our two accounts in its member places and the guard role added.
 *  Refuses, rather than adapts, if the template no longer has the shape this proof is about. */
export function demoPolicy(template, owner, member, guard) {
  const names = template.roles.map((r) => r.name);
  if (JSON.stringify(names) !== JSON.stringify(['Requestor', 'Admin', 'Approver'])) {
    throw new Error(`${TEMPLATE} has the roles ${JSON.stringify(names)}, not Requestor, Admin, Approver`);
  }
  for (const role of template.roles) {
    if (!Array.isArray(role.kind?.Group) || !role.kind.Group.every((m) => SLOTS.includes(m))) {
      throw new Error(`${TEMPLATE} role ${role.name} is not a Group of ${SLOTS.join(' and ')}`);
    }
  }
  const ours = new Map([[SLOTS[0], owner], [SLOTS[1], member]]);
  const roles = template.roles.map((role) => ({ ...role, kind: { Group: role.kind.Group.map((m) => ours.get(m)) } }));
  // Two of two Approvers means one approval never executes a payment, which is what leaves the
  // guard time to vote. A treasury with one Approver, or a threshold of one, loses that race:
  // the payment runs inside the approver's own call (scratchpad M0 test alice_alone_approves_first).
  const approver = roles.find((r) => r.name === 'Approver');
  for (const label of ['transfer', 'call']) {
    const vp = approver.vote_policy?.[label];
    if (approver.kind.Group.length !== 2 || vp?.weight_kind !== 'RoleWeight' || vp?.quorum !== '0' || vp?.threshold !== '2') {
      throw new Error(`${TEMPLATE} Approver ${label} vote is not 2 of 2: ${JSON.stringify(vp)}`);
    }
  }
  roles.push({
    name: GUARD_ROLE,
    kind: { Group: [guard] },
    permissions: GUARD_REJECT_LABELS.map((label) => `${label}:VoteReject`),
    vote_policy: Object.fromEntries(GUARD_REJECT_LABELS.map((label) => [label, { weight_kind: 'RoleWeight', quorum: '0', threshold: '1' }])),
  });
  return { ...template, roles };
}

/** The saved template. Without one, the policy of the mainnet treasury named in
 *  KAAP_TEMPLATE_DAO is read at final finality and saved with its members replaced by the two
 *  places, in the order they first appear, and without the treasury's name, because the
 *  template is published and a real treasury's members are not ours to publish. */
async function policyTemplate() {
  if (existsSync(POLICY_FILE)) return JSON.parse(readFileSync(POLICY_FILE, 'utf8'));
  const source = process.env.KAAP_TEMPLATE_DAO;
  if (!source) throw new Error(`no ${POLICY_FILE}: set KAAP_TEMPLATE_DAO to a mainnet NEAR Business treasury to read one`);
  const mainnet = new JsonRpcProvider({ url: MAINNET_RPC });
  const r = await mainnet.callFunctionRaw({ contractId: source, method: 'get_policy', args: {}, blockQuery: { finality: 'final' } });
  const policy = JSON.parse(Buffer.from(r.result).toString('utf8'));
  const people = [];
  for (const role of policy.roles) for (const m of role.kind?.Group ?? []) if (!people.includes(m)) people.push(m);
  if (people.length !== SLOTS.length) throw new Error(`that treasury has ${people.length} distinct members, not ${SLOTS.length}`);
  const place = new Map(people.map((m, i) => [m, SLOTS[i]]));
  const saved = {
    source: `the role setup of a live NEAR Business treasury on mainnet, read ${new Date().toISOString().slice(0, 10)}, members removed`,
    members: `each Group lists ${SLOTS.join(' and ')}; scripts/WO-02c-setup-testnet.mjs puts the guard owner in ${SLOTS[0]} and the demo member in ${SLOTS[1]}`,
    policy: { ...policy, roles: policy.roles.map((role) => (role.kind?.Group ? { ...role, kind: { Group: role.kind.Group.map((m) => place.get(m)) } } : role)) },
  };
  writeFileSync(POLICY_FILE, JSON.stringify(saved, null, 2) + '\n');
  return saved;
}

function sputnikCode() {
  if (!existsSync(SPUTNIK_WASM)) execFileSync('bash', [join(REPO, 'scripts', 'fetch-sputnik-wasm.sh')], { stdio: 'inherit' });
  const code = readFileSync(SPUTNIK_WASM);
  const digest = createHash('sha256').update(code).digest();
  if (digest.toString('hex') !== SPUTNIK_SHA256 || baseEncode(digest) !== SPUTNIK_CODE_HASH) {
    throw new Error(`${SPUTNIK_WASM} is not Sputnik 3.2 (sha256 ${digest.toString('hex')})`);
  }
  return code;
}

/** The key printed by the attested run recorded in deployments/testnet.json, read back from the
 *  transaction itself, after checking that run was this project called by this worker. */
async function keyTheSealedJobPrinted(sealed) {
  const status = await archival.viewTransactionStatusWithReceipts({ txHash: sealed.attested_run_tx, accountId: sealed.worker_account, waitUntil: 'FINAL' });
  const tx = status.transaction;
  const fc = tx.actions?.[0]?.FunctionCall;
  const args = fc ? JSON.parse(Buffer.from(fc.args, 'base64').toString('utf8')) : null;
  if (tx.signer_id !== sealed.worker_account || tx.receiver_id !== 'outlayer.testnet' || fc?.method_name !== 'request_execution' || args?.source?.Project?.project_id !== sealed.project_id) {
    throw new Error(`transaction ${sealed.attested_run_tx} is not a run of ${sealed.project_id} by ${sealed.worker_account}`);
  }
  return JSON.parse(Buffer.from(status.status.SuccessValue, 'base64').toString('utf8')).public_key;
}

async function main() {
  const state = loadState();
  const guard = state.guard.account_id;
  const registry = state.registry.account_id;
  const owner = state.owner.account_id;
  console.log(`Kaap M1 testnet setup, ${new Date().toISOString()}, RPC ${TESTNET_RPC}, near-api-js ${NEAR_API_JS_VERSION}`);

  const printed = await keyTheSealedJobPrinted(state.sealed);
  const guardKey = await viewFinal(guard, 'accepted_key');
  const registryKey = await viewFinal(registry, 'accepted_key');
  console.log(`sealed key printed by attested run ${state.sealed.attested_run_tx}: ${printed}`);
  console.log(`accepted_key(): guard ${guardKey}, registry ${registryKey}`);
  if (![guardKey, registryKey, state.accepted_key, state.sealed.signing_key].every((k) => k === printed)) {
    throw new Error('the guard, the registry, deployments/testnet.json and the sealed job do not all name one key');
  }
  for (const [name, entry] of [['guard', state.guard], ['registry', state.registry]]) {
    const onChain = await accountState(entry.account_id);
    if (onChain?.code_hash !== entry.code_hash) throw new Error(`${name} ${entry.account_id} runs ${onChain?.code_hash}, not the recorded ${entry.code_hash}`);
  }
  accountFor(owner);

  const saved = await policyTemplate();
  console.log(`NEAR Business template: ${saved.source}; in deployments/near-business-policy.json`);

  state.dao ??= { set_up_by: 'scripts/WO-02c-setup-testnet.mjs (work order WO-02c)' };
  const dao = state.dao;
  if (!dao.member) {
    const id = `kaap-member-${stamp()}.${NETWORK}`;
    await createFaucetAccount(id);
    dao.member = { account_id: id, held_by: `Ram; the key is only in ~/.near-credentials/testnet/${id}.json inside WSL on his machine` };
    saveState(state);
    console.log(`created ${id} (faucet)`);
  }
  const member = dao.member.account_id;
  if (!dao.account_id) {
    const id = `kaap-dao-${stamp()}.${NETWORK}`;
    await createFaucetAccount(id);
    dao.account_id = id;
    dao.full_access_key = `on the account until the end of setup, which deletes it; only in ~/.near-credentials/testnet/${id}.json inside WSL`;
    saveState(state);
    console.log(`created ${id} (faucet)`);
  }
  const daoId = dao.account_id;
  const expected = demoPolicy(saved.policy, owner, member, guard);

  if ((await accountState(daoId)).code_hash === NO_CODE) {
    const config = { name: daoId.split('.')[0], purpose: "Kaap M1 demo treasury with the role setup of a live NEAR Business treasury", metadata: '' };
    const deployer = accountFor(daoId);
    // Deploy and init in one transaction, so the code can never sit on chain uninitialised.
    const { hash, failure } = await send(deployer, daoId, [
      actions.deployContract(sputnikCode()),
      actions.functionCall('new', { config, policy: expected }, 150n * TGAS, 0n),
    ]);
    if (failure) throw new Error(`deploy and init of ${daoId} failed in ${hash}: ${refusal(failure)}`);
    dao.deploy_and_init_tx = hash;
    saveState(state);
    console.log(`deployed Sputnik 3.2 to ${daoId} and ran new: ${txLink(hash)}`);
  }
  const codeHash = (await accountState(daoId)).code_hash;
  if (codeHash !== SPUTNIK_CODE_HASH) throw new Error(`${daoId} runs ${codeHash}, not Sputnik 3.2 ${SPUTNIK_CODE_HASH}`);
  const onChain = await viewFinal(daoId, 'get_policy');
  if (policyForm(onChain) !== policyForm(expected)) throw new Error(`${daoId} get_policy() differs from the policy built from ${TEMPLATE}`);
  Object.assign(dao, {
    code_hash: codeHash,
    code_sha256: SPUTNIK_SHA256,
    policy_from: { source: saved.source, saved_in: 'deployments/near-business-policy.json' },
    members: Object.fromEntries(expected.roles.map((r) => [r.name, r.kind.Group])),
    approver_vote: 'transfer and call need 2 of 2 Approvers, so one approval never executes a proposal',
    guard_role: `${GUARD_ROLE}: [${guard}], VoteReject on ${GUARD_REJECT_LABELS.length} labels (all but remove_member_from_role), threshold 1`,
  });
  saveState(state);
  console.log(`checked ${daoId}: code hash ${codeHash}, policy equals the NEAR Business shape with our members and the guard role`);

  if (!(await viewFinal(guard, 'is_enrolled', { dao: daoId }))) {
    dao.enrolment ??= {};
    const enrolment = dao.enrolment;
    const proposer = accountFor(member);
    if (enrolment.proposal_id === undefined) {
      const kind = {
        FunctionCall: {
          receiver_id: guard,
          actions: [{ method_name: 'enroll', args: Buffer.from('{}').toString('base64'), deposit: ENROL_DEPOSIT.toString(), gas: ENROL_GAS.toString() }],
        },
      };
      const description = `Enrol this treasury in Kaap's guard ${guard}. It attaches 0.01 NEAR for the guard's storage; the guard keeps what its entry costs and refunds the rest.`;
      const { hash, outcome, failure } = await call(proposer, daoId, 'add_proposal', { proposal: { description, kind } }, 30n * TGAS);
      if (failure) throw new Error(`filing the enrolment proposal failed in ${hash}: ${refusal(failure)}`);
      enrolment.proposal_id = returned(outcome);
      enrolment.add_proposal_tx = hash;
      saveState(state);
      console.log(`filed enrolment proposal #${enrolment.proposal_id} as ${member}: ${txLink(hash)}`);
    }
    enrolment.vote_txs ??= [];
    for (const voter of [owner, member]) {
      const proposal = await viewFinal(daoId, 'get_proposal', { id: enrolment.proposal_id });
      if (proposal.status !== 'InProgress' || proposal.votes?.[voter]) continue;
      const { hash, failure } = await call(accountFor(voter), daoId, 'act_proposal', { id: enrolment.proposal_id, action: 'VoteApprove', proposal: proposal.kind }, 300n * TGAS);
      if (failure) throw new Error(`${voter}'s approval failed in ${hash}: ${refusal(failure)}`);
      enrolment.vote_txs.push(hash);
      saveState(state);
      console.log(`${voter} approved #${enrolment.proposal_id}: ${txLink(hash)}`);
    }
    const proposal = await viewFinal(daoId, 'get_proposal', { id: enrolment.proposal_id });
    enrolment.status = proposal.status;
    saveState(state);
    if (proposal.status !== 'Approved') throw new Error(`enrolment proposal #${enrolment.proposal_id} is ${proposal.status}, not Approved`);
  }
  if (!(await viewFinal(guard, 'is_enrolled', { dao: daoId }))) throw new Error(`${guard} does not list ${daoId} as enrolled`);
  dao.enrolment = { ...dao.enrolment, enrolled: true };
  saveState(state);

  // A factory DAO has no access keys, so only its own approved proposals can act for it. The
  // setup key goes last, once the code, the policy and the enrolment are checked; after that
  // nobody, including us, can change the DAO's code or sign as it.
  const daoKeys = async () => (await provider.viewAccessKeyList({ accountId: daoId, finalityQuery: { finality: 'final' } })).keys;
  const keys = await daoKeys();
  if (keys.length > 0) {
    const holder = accountFor(daoId);
    if (keys.length !== 1 || keys[0].public_key !== holder.publicKey) {
      throw new Error(`${daoId} holds keys this setup did not add: ${keys.map((k) => k.public_key).join(', ')}`);
    }
    const { hash, failure } = await send(holder, daoId, [actions.deleteKey(PublicKey.fromString(holder.publicKey))]);
    if (failure) throw new Error(`deleting ${daoId}'s key failed in ${hash}: ${refusal(failure)}`);
    dao.full_access_key_deleted_tx = hash;
    saveState(state);
    console.log(`deleted ${daoId}'s only full-access key: ${txLink(hash)}`);
  }
  const left = (await daoKeys()).length;
  if (left !== 0) throw new Error(`${daoId} still has ${left} access key(s)`);
  delete dao.full_access_key;
  dao.access_keys_left = 0;
  dao.checked_at = new Date().toISOString();
  saveState(state);
  console.log(`${daoId} access keys: 0`);

  console.log(`\n${guard}.is_enrolled(${daoId}) = true`);
  console.log(`DAO:     ${daoId} ${accountLink(daoId)}`);
  for (const role of expected.roles) console.log(`  ${role.name}: ${role.kind.Group.join(', ')}`);
  console.log(`state written to deployments/testnet.json`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (e) {
    console.error(`setup stopped: ${e?.message ?? e}`);
    process.exit(1);
  }
}
