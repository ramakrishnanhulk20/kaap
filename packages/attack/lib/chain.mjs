// Testnet access for the attack suite. Sending and reading at final reuse the helpers
// scripts/setup-demo-dao.mjs exports for scripts/prove.mjs, so the attacks reach the chain exactly
// the way the proof does: a transaction's hash is taken before it is sent, every outcome is
// followed to FINAL, and every view is read at final finality.
//
// Scope. The suite attacks copies: a second guard and a second registry that run the same code as
// the live ones, and throwaway DAOs (lib/test-set.mjs). Every transaction goes through `send`
// below, which refuses any signer or receiver whose name is not one the suite gives its own
// accounts, and refuses everything unless the node answers for testnet. The live deployment in
// deployments/testnet.json is only ever read. What `send` does not see is the receiver named
// inside a request filed on a throwaway DAO; the two files that file such a request name the
// copy of the guard.
//
// Attackers are throwaway faucet accounts named kaap-attacker-<time>.testnet, kept in the local
// near-cli keychain (~/.near-credentials/testnet) and reused while they hold enough for gas.

import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  GUARD_REJECT_LABELS, MILLI_NEAR, NETWORK, PublicKey, SPUTNIK_CODE_HASH, TGAS, accountFor, accountState, actions,
  baseEncode, createFaucetAccount, events, loadState, provider, returned, send as sendAnywhere, sleep, stamp, toNear,
  txLink, viewFinal, viewFinalRaw,
} from '../../../scripts/setup-demo-dao.mjs';
import { core } from './core.mjs';

export {
  GUARD_REJECT_LABELS, MILLI_NEAR, NETWORK, PublicKey, SPUTNIK_CODE_HASH, TGAS, accountFor, accountState, actions,
  baseEncode, createFaucetAccount, events, provider, returned, sleep, stamp, toNear, txLink, viewFinal, viewFinalRaw,
};

/** The live deployment, as deployments/testnet.json records it. Read, never sent to. */
export const LIVE = (() => {
  const s = loadState();
  return {
    guard: s.guard.account_id,
    guardCodeHash: s.guard.code_hash,
    guardSha256: s.guard.code_sha256,
    registry: s.registry.account_id,
    registryCodeHash: s.registry.code_hash,
    registrySha256: s.registry.code_sha256,
    acceptedKey: s.accepted_key,
    owner: s.owner.account_id,
    dao: s.dao.account_id,
    member: s.dao.member.account_id,
    worker: s.sealed.worker_account,
    project: s.sealed.project_id,
  };
})();

const LIVE_ACCOUNTS = new Set([LIVE.guard, LIVE.registry, LIVE.owner, LIVE.dao, LIVE.member, LIVE.worker]);
// One rule for every account the suite makes: kaap-attacker-<time> for the callers, and
// kaap-attack-<role>-<time> for the copies and the throwaway DAOs.
const OWN_ACCOUNT = /^kaap-attack(er|-[a-z]+)-\d{10}\.testnet$/;
const ATTACKER_FILE = /^(kaap-attacker-\d{10}\.testnet)\.json$/;
// A veto prepays 1,000 Tgas, 0.1 NEAR at the lowest gas price, and gets back what it does not burn.
const ATTACKER_MIN_BALANCE = 1000n * MILLI_NEAR;
// The guard refuses a veto that attaches less than 900 Tgas; 1,000 is the most a transaction carries.
export const VETO_GAS = 1000n * TGAS;
export const CALL_GAS = 30n * TGAS;
// kaap-registry's README: 0.02 NEAR always covers a record, and the rest comes back.
export const RECORD_DEPOSIT = 20n * MILLI_NEAR;
export const ONE_YOCTO = 1n;

/** True for an account the suite made and may sign with or send to. */
export const isOwnAccount = (id) => OWN_ACCOUNT.test(id) && !LIVE_ACCOUNTS.has(id);

let askedTheNode;
/** Stops unless the node answers for NEAR testnet, whatever KAAP_TESTNET_RPC points at. Asked
 *  once in each run. */
export function requireTestnet() {
  askedTheNode ??= provider.sendJsonRpc('status', []).then((status) => {
    if (status?.chain_id !== 'testnet') throw new Error(`the node answers for ${status?.chain_id}, not testnet: nothing is sent`);
  });
  return askedTheNode;
}

/** The only way the suite sends a transaction. It stops before signing unless the node is a
 *  testnet node and both the signer and the receiver carry a name the suite gives its own
 *  accounts, which no account of the live deployment does. */
export async function send(from, receiverId, actionList) {
  await requireTestnet();
  for (const id of [from.account.accountId, receiverId]) {
    if (!isOwnAccount(id)) throw new Error(`out of scope: ${id} is not one of the attack suite's own accounts`);
  }
  return sendAnywhere(from, receiverId, actionList);
}

export const call = (from, contractId, method, args, gas = CALL_GAS, deposit = 0n) =>
  send(from, contractId, [actions.functionCall(method, args, gas, deposit)]);

/** A throwaway caller: the newest kaap-attacker account in the local keychain that still holds
 *  1 NEAR and is not one of `not`, or a new one from the faucet. */
export async function attacker({ not = [], label = 'attacker' } = {}) {
  const dir = join(homedir(), '.near-credentials', NETWORK);
  let names = [];
  try {
    names = readdirSync(dir).map((f) => f.match(ATTACKER_FILE)?.[1]).filter(Boolean).sort().reverse();
  } catch {
    names = [];
  }
  for (const id of names) {
    if (not.includes(id)) continue;
    const state = await accountState(id);
    if (state && BigInt(state.amount) >= ATTACKER_MIN_BALANCE) return useAttacker(id, state.amount, 'kept from an earlier run', label);
  }
  // Two accounts made in the same second would share a name.
  let id = `kaap-attacker-${stamp()}.${NETWORK}`;
  while (not.includes(id) || names.includes(id)) {
    await sleep(1000);
    id = `kaap-attacker-${stamp()}.${NETWORK}`;
  }
  await createFaucetAccount(id);
  return useAttacker(id, (await accountState(id)).amount, 'new from the faucet', label);
}

function useAttacker(id, amount, how, label) {
  if (!isOwnAccount(id)) throw new Error(`${id} is not one of the attack suite's own accounts`);
  console.log(`${label}: ${id} (${how}, ${toNear(amount)} NEAR), key only in the local keychain`);
  return accountFor(id);
}

const clean = (text) => String(text).replace(/[^\x20-\x7e]/g, '?');

/** The panic text of one failure, shortened to its ERR_ code when it has one. */
function failureText(failure) {
  const panic = failure?.ActionError?.kind?.FunctionCallError?.ExecutionError;
  const text = typeof panic === 'string' ? panic.replace(/^Smart contract panicked: /, '') : JSON.stringify(failure);
  return clean(text.match(/ERR_[A-Z0-9_]+/)?.[0] ?? text).slice(0, 160);
}

/** How a transaction ended: `refused` with the contract's own reason, or accepted. */
export function verdictOf(outcome) {
  const failure = outcome.status?.Failure;
  return failure ? { refused: true, reason: failureText(failure) } : { refused: false, reason: 'accepted' };
}

/** For a call that must be refused. `reason` is the contract's error code, or a pattern for the
 *  refusals near-sdk words itself. `also` names further facts that must hold, each read from the
 *  chain after the call: a refusal with the right word still fails if one of them is false. */
export function refusal({ hash, outcome }, reason, also = {}) {
  const v = verdictOf(outcome);
  const right = reason instanceof RegExp ? reason.test(v.reason) : v.reason === reason;
  const broken = Object.entries(also).filter(([, holds]) => !holds).map(([name]) => name);
  const kept = Object.keys(also).filter((name) => !broken.includes(name));
  const observed = [
    v.refused ? `refused with ${v.reason}` : 'ACCEPTED',
    kept.length ? `checked: ${kept.join(', ')}` : '',
    broken.length ? `NOT SO: ${broken.join(', ')}` : '',
    txLink(hash),
  ].filter(Boolean).join('; ');
  return { observed, pass: v.refused && right && broken.length === 0 };
}

/** For a call the contract accepts by design. `facts` are what must hold afterwards. */
export function accepted({ hash, outcome }, facts = {}) {
  const v = verdictOf(outcome);
  const broken = Object.entries(facts).filter(([, holds]) => !holds).map(([name]) => name);
  const kept = Object.keys(facts).filter((name) => !broken.includes(name));
  const observed = [
    v.refused ? `REFUSED with ${v.reason}` : 'accepted',
    kept.length ? `checked: ${kept.join(', ')}` : '',
    broken.length ? `NOT SO: ${broken.join(', ')}` : '',
    txLink(hash),
  ].filter(Boolean).join('; ');
  return { observed, pass: !v.refused && broken.length === 0 };
}

/** The failure of the receipt `accountId` executed in this transaction, or null if it succeeded. */
export function receiptFailure(outcome, accountId) {
  const r = outcome.receipts_outcome.find((o) => o.outcome.executor_id === accountId && o.outcome.status?.Failure);
  return r ? failureText(r.outcome.status.Failure) : null;
}

/** The names of the events `accountId` logged in this transaction. */
export const eventsBy = (outcome, accountId) => events(outcome).filter((e) => e.by === accountId).map((e) => e.event);

/** A proposal read at final through kaap-core's reader, with `kindJson` the exact bytes Sputnik
 *  returned, and the final block it was read at. */
export async function proposalAt(dao, id) {
  const { text, blockHeight } = await viewFinalRaw(dao, 'get_proposal', { id });
  const read = JSON.parse(core.readProposal(text));
  const { votes } = JSON.parse(text);
  return { id, status: read.status, votes: votes ?? {}, kindJson: read.kind_json, blockHeight };
}

/** Reads a proposal until its status leaves `from`, for up to 20 s, since a vote can land a block
 *  after the transaction that sent it is final. */
export async function settledProposal(dao, id, from = 'InProgress') {
  let p = await proposalAt(dao, id);
  for (let i = 0; i < 20 && p.status === from; i++) {
    await sleep(1000);
    p = await proposalAt(dao, id);
  }
  return p;
}

/** True when the proposal is still open and nobody has voted on it. */
export const untouched = (p) => p.status === 'InProgress' && Object.keys(p.votes).length === 0;

/** True when the proposal was rejected by the one guard's vote and no other. */
export const rejectedBy = (p, guard) =>
  p.status === 'Rejected' && Object.keys(p.votes).length === 1 && p.votes[guard] === 'Reject';

/** Everything a verdict on `dao` #`id` must carry, read at final: the kind as stored, the policy,
 *  and the DAO's code hash. */
export async function targetOf(dao, id, guard) {
  const p = await proposalAt(dao, id);
  const { text: policyJson } = await viewFinalRaw(dao, 'get_policy');
  const daoCodeHash = (await accountState(dao)).code_hash;
  return { guard, dao, proposalId: id, kindJson: p.kindJson, policyJson, daoCodeHash, blockHeight: p.blockHeight };
}

/** Files a proposal and returns its id and transaction. */
export async function fileProposal(from, dao, description, kind) {
  const { hash, outcome, failure } = await call(from, dao, 'add_proposal', { proposal: { description, kind } });
  if (failure) throw new Error(`add_proposal on ${dao} failed in ${txLink(hash)}: ${failureText(failure)}`);
  return { id: returned(outcome), hash };
}

/** A native NEAR Transfer of `amount` yoctoNEAR to `to`, the kind every test request uses. On the
 *  suite's throwaway DAOs no role may approve a transfer, so it can never pay out. */
export const transferKind = (to, amount = '1') => ({ Transfer: { token_id: '', receiver_id: to, amount, msg: null } });

let filed = 0;
/** Files a fresh test request on `dao`, a transfer of `amount` yoctoNEAR back to its filer, and
 *  returns what a verdict on it must carry. */
export async function freshTarget(from, dao, guard, amount = '1') {
  const { id } = await fileProposal(from, dao, `Kaap attack suite test request ${stamp()}-${filed++}`, transferKind(from.account.accountId, amount));
  return targetOf(dao, id, guard);
}

/** The time of the newest final block, in milliseconds: the clock the guard reads. An attack
 *  whose point is an expiry sets it from this, since this machine's clock may be off. Every
 *  other verdict takes ten minutes from this machine's clock (lib/verdict.mjs). */
export async function chainNowMs() {
  const block = await provider.viewBlock({ finality: 'final' });
  return Number(BigInt(block.header.timestamp_nanosec) / 1_000_000n);
}

// The protocol's storage price: 10^19 yoctoNEAR a byte.
const STORAGE_BYTE_COST = 10n ** 19n;
/** What an account holds beyond what its own storage locks up, in yoctoNEAR. A contract that
 *  paid for somebody else's storage would see this fall. */
export async function freeBalance(accountId) {
  const state = await accountState(accountId);
  const bytes = state?.storage_usage ?? state?.storageUsage;
  if (state?.amount === undefined || bytes === undefined) throw new Error(`the node did not say what ${accountId} holds and stores`);
  return BigInt(state.amount) - BigInt(bytes) * STORAGE_BYTE_COST;
}

export const wasUsed = (guard, hash) => viewFinal(guard, 'was_used', { verdict_hash_hex: hash });
export const vetoResult = (guard, hash) => viewFinal(guard, 'veto_result', { verdict_hash_hex: hash });

/** Hands a verdict to a guard's `veto` as `from`. */
export const veto = (from, guard, signed, kindJson, gas = VETO_GAS) =>
  call(from, guard, 'veto', { verdict: signed.verdict, signature: signed.signature, kind_json: kindJson }, gas);

/** Hands a verdict to a registry's `record` as `from`, with `deposit` attached. */
export const record = (from, registry, signed, deposit = RECORD_DEPOSIT) =>
  call(from, registry, 'record', { verdict: signed.verdict, signature: signed.signature }, CALL_GAS, deposit);
