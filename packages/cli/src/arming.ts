// `kaap arming <dao>`: whether Kaap's guard is really armed on a DAO (C16), worked out by kaap-core
// with Sputnik's own formulas from the live policy, never from what the enrolment meant to give the
// guard. The policy, the DAO's code and the guard's enrolment are read at one final block and must
// agree across two providers (C22).
//
// Armed means all four: the DAO enrolled itself in the guard; the guard's one reject decides every
// kind in Kaap's template; it does not decide the one kind the template leaves out, so the DAO can
// always remove Kaap; and every role that holds the guard holds it alone, as the template's role
// does, so no other account shares its vote or its role's count (C30). Rights beyond rejecting are
// shown, not counted against arming: the guard contract has no code path that could use them (C15).

import { Held, type Reader } from './chain.js';
import { type Deps, readers } from './check.js';
import type { Arming, EnrolmentDrafts } from './core.js';
import { recognise, type Recognised } from './dao.js';
import { type Deployment, loadDeployment } from './deployment.js';
import { type Block, NETWORKS, type Network } from './rpc.js';
import { oneLine, utc } from './text.js';

export interface ArmingState {
  armed: boolean;
  /** Why not, one plain sentence each; empty when armed. */
  reasons: string[];
  /** Template kinds the guard's one reject does not decide. */
  missing: string[];
}

/** Each role whose Group names `guard` together with other accounts, as "role (other, ...)". The
 *  policy is kaap-core's canonical form, so a Group is a plain list of account ids. */
export function sharedRoles(policy: string, guard: string): string[] {
  const roles = (JSON.parse(policy) as { roles: { name: string; kind: unknown }[] }).roles;
  return roles.flatMap((r) => {
    const group = (r.kind as { Group?: unknown } | null)?.Group;
    if (!Array.isArray(group) || !group.includes(guard)) return [];
    const others = group.filter((m) => m !== guard).map((m) => oneLine(String(m), 80));
    return others.length ? [`${oneLine(r.name, 40)} (${others.join(', ')})`] : [];
  });
}

/** Compares C16's answer, and the roles that hold the guard, with Kaap's template. */
export function armingState(a: Arming, template: EnrolmentDrafts, enrolled: boolean, shared: string[]): ArmingState {
  const missing = template.labels.filter((l) => !a.rejects_alone.includes(l));
  const over = template.left_out.filter((l) => a.rejects_alone.includes(l));
  const reasons: string[] = [];
  if (!enrolled) reasons.push('the DAO has not enrolled itself in the guard (no approved call to enroll)');
  if (missing.length === template.labels.length) reasons.push('the guard holds no deciding reject vote in this policy');
  else if (missing.length) reasons.push(`the guard's one reject does not decide: ${missing.join(', ')}`);
  if (over.length) reasons.push(`the guard could also reject ${over.join(', ')}, which Kaap leaves out so the DAO can always remove Kaap`);
  if (shared.length) reasons.push(`the guard shares a role with other accounts, which Kaap's template never does: ${shared.join('; ')}`);
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
  arming: Arming;
  template: EnrolmentDrafts;
  state: ArmingState;
}

/** Everything `arming` and `enroll` read: the deployment, the DAO, its policy, its enrolment. */
export async function readGuard(deps: Deps & { repoRoot: string }, request: { dao: string; network: Network }): Promise<GuardRead> {
  const d = loadDeployment(deps.repoRoot, request.network);
  const reader = readers(deps, request.network);
  const head = await reader.head();
  const dao = await recognise(deps.core, reader, NETWORKS[request.network].factory, request.dao, head);
  const policy = await reader.policy(request.dao, head);
  const enrolled = await reader.sameJson('the guard\'s enrolment', d.guard, 'is_enrolled', { dao: request.dao }, head);
  if (typeof enrolled !== 'boolean') throw new Held('the guard\'s is_enrolled answer is not true or false');
  const arming = deps.core.guardArming(policy, d.guard);
  const template = deps.core.enrolmentDrafts(d.guard);
  return { d, reader, head, dao, policy, enrolled, arming, template, state: armingState(arming, template, enrolled, sharedRoles(policy, d.guard)) };
}

export interface ArmingReport {
  title: string;
  facts: string[];
  lines: string[];
}

export async function arming(deps: Deps & { repoRoot: string }, request: { dao: string; network: Network }): Promise<ArmingReport> {
  const g = await readGuard(deps, request);
  return {
    title: `kaap arming ${request.dao} on ${request.network}`,
    facts: [
      `read at final block ${g.head.height} (${utc(g.head.timestampNs)}): the DAO's code, its policy and the guard's enrolment agreed by ${g.reader.providers.join(' and ')}`,
      `DAO: Sputnik ${g.dao.version} (code hash ${g.dao.codeHash})`,
      `guard: ${g.d.guard}; enrolled in the guard: ${g.enrolled ? 'yes' : 'no'}`,
    ],
    lines: armingLines(g.arming, g.template, g.state),
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
  // Kinds with the same accounts are one line, so a one-member treasury reads as one line, not 16.
  const byAccounts = new Map<string, string[]>();
  for (const [label, who] of Object.entries(a.others_who_reject_alone)) {
    const key = who.map((w) => oneLine(w, 80)).join(', ');
    byAccounts.set(key, [...(byAccounts.get(key) ?? []), label]);
  }
  if (byAccounts.size) {
    lines.push('other accounts whose one reject also decides:');
    for (const [who, labels] of byAccounts) lines.push(`  ${who}: ${labels.join(', ')}`);
  }
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
  return [r.title, ...r.facts, '', ...r.lines].join('\n');
}

