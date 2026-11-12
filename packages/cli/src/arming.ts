// `kaap arming <dao>`: whether Kaap's guard is really armed on a DAO (C16), worked out by kaap-core
// with Sputnik's own formulas from the live policy, never from what the enrolment meant to give the
// guard. The policy, the DAO's code and the guard's enrolment are read at one final block and must
// agree across two providers (C22). The guard is the one the DAO is enrolled with across Kaap's
// deployment records, current first, else the current one (deployment.ts), and is named with its
// record. Before any answer, that record's guard and registry must still run the build it names
// with no access key (contracts.ts); otherwise the command stops there, exit 5 or 6.
//
// Armed means all three: the DAO enrolled itself in the guard; by kaap-core's `guard_arming`, the
// guard's one reject decides every kind in Kaap's template; and it does not decide the one kind the
// template leaves out, so the DAO can always remove Kaap (C30). C16 has one source, so nothing else
// counts: another account that can also veto alone, and rights beyond rejecting, are shown as
// warnings, never as disarming. The guard contract has no code path that could use extra rights
// (C15).
//
// It also prints the mode the DAO chose in the guard (C8) and, when the guard's owner has announced
// a change of the accepted key, one warning line with the time it can take effect (C19); guard.ts
// reads both.

import type { Reader } from './chain.js';
import { type Deps, readers } from './check.js';
import { contractBlock, contractsAsRecorded, stopUnlessAsRecorded } from './contracts.js';
import type { Arming, EnrolmentDrafts } from './core.js';
import { recognise, type Recognised } from './dao.js';
import { type Deployment, describeDeployment, enrolledDeployment } from './deployment.js';
import { type GuardMode, guardMode, modeWords, pendingKeyLines } from './guard.js';
import { type Block, NETWORKS, type Network } from './rpc.js';
import { oneLine, terminalText, utc } from './text.js';

export interface ArmingState {
  armed: boolean;
  /** Why not, one plain sentence each; empty when armed. */
  reasons: string[];
  /** Template kinds the guard's one reject does not decide. */
  missing: string[];
}

/** Compares C16's answer with Kaap's template. */
export function armingState(a: Arming, template: EnrolmentDrafts, enrolled: boolean): ArmingState {
  const missing = template.labels.filter((l) => !a.rejects_alone.includes(l));
  const over = template.left_out.filter((l) => a.rejects_alone.includes(l));
  const reasons: string[] = [];
  if (!enrolled) reasons.push('the DAO has not enrolled itself in the guard (no approved call to enroll)');
  if (missing.length === template.labels.length) reasons.push('the guard holds no deciding reject vote in this policy');
  else if (missing.length) reasons.push(`the guard's one reject does not decide: ${missing.join(', ')}`);
  if (over.length) reasons.push(`the guard could also reject ${over.join(', ')}, which Kaap leaves out so the DAO can always remove Kaap`);
  return { armed: reasons.length === 0, reasons, missing };
}

export interface GuardRead {
  d: Deployment;
  reader: Reader;
  head: Block;
  dao: Recognised;
  /** The policy in kaap-core's canonical form. */
  policy: string;
  enrolled: boolean;
  /** The mode the DAO chose in the guard; null when it is not enrolled, so it chose none. */
  mode: GuardMode | null;
  arming: Arming;
  template: EnrolmentDrafts;
  state: ArmingState;
}

/** Everything `arming` and `enroll` read: the deployment whose guard the DAO is enrolled with (the
 *  current one when none is), the DAO, its policy, its enrolment. */
export async function readGuard(deps: Deps & { repoRoot: string }, request: { dao: string; network: Network }): Promise<GuardRead> {
  const reader = readers(deps, request.network);
  const head = await reader.head();
  const dao = await recognise(deps.core, reader, NETWORKS[request.network].factory, request.dao, head);
  const policy = await reader.policy(request.dao, head);
  const { d, enrolled } = await enrolledDeployment(reader, deps.repoRoot, request.network, request.dao, head);
  const mode = enrolled ? await guardMode(reader, d.guard, request.dao, head) : null;
  const arming = deps.core.guardArming(policy, d.guard);
  const template = deps.core.enrolmentDrafts(d.guard);
  return { d, reader, head, dao, policy, enrolled, mode, arming, template, state: armingState(arming, template, enrolled) };
}

export interface ArmingReport {
  title: string;
  facts: string[];
  /** The four contract lines under their heading, all passing. */
  contracts: string[];
  lines: string[];
}

/** Whether the guard is armed, once its guard and registry are the recorded build with no access
 *  key; anything else stops the command with the four lines and no arming answer (contracts.ts). */
export async function arming(deps: Deps & { repoRoot: string }, request: { dao: string; network: Network }): Promise<ArmingReport> {
  const g = await readGuard(deps, request);
  const contracts = await contractsAsRecorded(g.reader, g.d, g.head);
  stopUnlessAsRecorded(g.d, contracts, 'Whether the guard is armed is not shown until both providers show each contract running the recorded build with no access key.');
  const keyChange = await pendingKeyLines(g.reader, g.d.guard, g.head);
  return {
    title: `kaap arming ${request.dao} on ${request.network}`,
    facts: [
      `read at final block ${g.head.height} (${utc(g.head.timestampNs)}): the DAO's code, its policy and the guard's enrolment agreed by ${g.reader.providers.join(' and ')}`,
      `DAO: Sputnik ${g.dao.version} (code hash ${g.dao.codeHash})`,
      `Kaap on ${request.network}: ${describeDeployment(g.d)}`,
      `guard: ${g.d.guard}; enrolled in the guard: ${g.enrolled ? 'yes' : 'no'}`,
      ...(g.mode === null ? [] : [`mode in the guard: ${modeWords(g.mode)}`]),
    ],
    contracts: contractBlock(contracts),
    lines: [...keyChange, ...armingLines(g.arming, g.template, g.state)],
  };
}

/** The C16 answer in plain words, shared by `arming` and by `enroll` for the policy after its
 *  drafts pass. */
export function armingLines(a: Arming, template: EnrolmentDrafts, state: ArmingState): string[] {
  const lines = [
    state.armed
      ? `armed: yes. The guard's one reject decides every kind except ${template.left_out.join(', ')}, which Kaap leaves out on purpose so the DAO can always remove Kaap.`
      : `armed: no. ${state.reasons.map((r) => `${r[0]?.toUpperCase() ?? ''}${r.slice(1)}.`).join(' ')}`,
    `kinds the guard cannot reject: ${a.cannot_reject.map((l) => (template.left_out.includes(l) ? `${l} (left out by design)` : l)).join(', ') || 'none'}`,
    `rights beyond rejecting: ${a.extra_rights.length ? `${a.extra_rights.join(', ')} (the guard contract cannot use them: it only ever casts VoteReject)` : 'none'}`,
    'votes the approvers need to pass each kind:',
    ...votes(a.approval_votes_needed),
  ];
  // Kinds with the same accounts are one warning line, so a one-member treasury reads as one line,
  // not 16. Nothing is printed when no other account can veto alone.
  const byAccounts = new Map<string, string[]>();
  for (const [label, who] of Object.entries(a.others_who_reject_alone)) {
    const key = who.map((w) => oneLine(w, 80)).join(', ');
    byAccounts.set(key, [...(byAccounts.get(key) ?? []), label]);
  }
  for (const [who, labels] of byAccounts) lines.push(`also able to veto alone: ${who} (on ${labels.join(', ')})`);
  lines.push(`race: ${a.race_note}`);
  return lines;
}

/** Kinds grouped by the votes that pass them, fewest first. A kind no role can pass, and a kind
 *  whose rules let it pass without a guard reject deciding, are named apart, the latter in the words
 *  of kaap-core's race note. */
function votes(needed: Record<string, string>): string[] {
  const groups = new Map<string, string[]>();
  for (const [label, n] of Object.entries(needed)) groups.set(n, [...(groups.get(n) ?? []), label]);
  const counts = [...groups.keys()].filter((n) => n !== 'none' && n !== '0').sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : 1));
  const out = counts.map((n) => `  ${n} ${n === '1' ? 'vote' : 'votes'}: ${(groups.get(n) ?? []).join(', ')}`);
  if (groups.has('0')) out.push(`  not guardable, see the race note: ${(groups.get('0') ?? []).join(', ')}`);
  if (groups.has('none')) out.push(`  no role can pass: ${(groups.get('none') ?? []).join(', ')}`);
  return out;
}

export function render(r: ArmingReport): string {
  return terminalText([r.title, ...r.facts, ...r.contracts, '', ...r.lines]);
}

