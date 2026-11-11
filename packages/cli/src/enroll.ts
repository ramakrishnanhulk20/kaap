// `kaap enroll <dao>`: the proposals a member files to put a DAO under Kaap's guard, from Kaap's one
// enrolment template (C30, built by kaap-core-wasm `enrolmentDrafts`), each followed by Kaap's own
// decoding of the draft, so the approvers see what it really does before they vote: kaap-core's
// `analyze` against the live policy, the same decoder that judges every other proposal. Who may file
// and who may approve each draft come from Sputnik's own rules on the live policy (`whoActs`), so a
// NEAR Business treasury, where Admin files policy changes and Requestor files function calls,
// is read as it is. The CLI only prints: it holds no key and files nothing (C31).
//
// What it does not do: count an enrolment. That happens only once the on-chain policy matches the
// template, which `kaap arming` checks on the live policy after the proposals pass (C16).

import { armingLines, armingState, readGuard } from './arming.js';
import { Held } from './chain.js';
import { type Deps, plainEffect } from './check.js';
import type { CheckAnalysis, WhoActs } from './core.js';
import { describeDeployment } from './deployment.js';
import { readPrices } from './prices.js';
import type { Network } from './rpc.js';
import { oneLine, units, utc } from './text.js';

export class CannotEnrol extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CannotEnrol';
  }
}

export interface DraftReport {
  title: string;
  label: string;
  filers: string;
  approvers: string;
  /** The exact `add_proposal` arguments. */
  args: string;
  decoding: CheckAnalysis;
}

export interface EnrollReport {
  title: string;
  facts: string[];
  bondYocto: string;
  drafts: DraftReport[];
  after: string[];
  network: Network;
  dao: string;
}

function people(side: WhoActs['add_proposal']): string {
  const parts = side.accounts.map((a) => `${oneLine(a.account, 80)} (${a.roles.map((r) => oneLine(r, 40)).join(', ')})`);
  if (side.anyone.length) parts.push(`any account (role ${side.anyone.map((r) => oneLine(r, 40)).join(', ')})`);
  if (side.token_roles.length) parts.push(`holders of the DAO's token (role ${side.token_roles.map((r) => oneLine(r, 40)).join(', ')})`);
  return parts.join(', ');
}

function votesText(n: string | undefined): string {
  if (n === undefined || n === 'none') return 'no role can pass it';
  if (n === '0') return 'its voting rules let it pass without a guard reject deciding (see the race note)';
  return `${n} ${n === '1' ? 'approval passes' : 'approvals pass'} it`;
}

/** Sputnik's `add_or_update_role` (policy.rs 246-259, kaap-core `Policy::add_or_update_role`): the
 *  first role of that name is replaced whole, else the role is appended. Used only to show the
 *  policy the drafts would leave; the enrolment counts on the live policy alone. */
function withRole(policy: string, role: unknown): string {
  const p = JSON.parse(policy) as { roles: { name?: unknown }[] };
  const name = (role as { name?: unknown }).name;
  const at = p.roles.findIndex((r) => r.name === name);
  if (at >= 0) p.roles[at] = role as { name?: unknown };
  else p.roles.push(role as { name?: unknown });
  return JSON.stringify(p);
}

export async function enroll(deps: Deps & { repoRoot: string }, request: { dao: string; network: Network }): Promise<EnrollReport> {
  const g = await readGuard(deps, request);
  const major = Number(g.dao.version.split('.')[0]);
  if (!(major >= 3)) {
    throw new CannotEnrol(`${request.dao} runs Sputnik ${g.dao.version}; Kaap's enrolment drafts use the ChangePolicyAddOrUpdateRole kind and are tested only on Sputnik 3`);
  }
  const bond = (JSON.parse(g.policy) as { proposal_bond?: unknown }).proposal_bond;
  if (typeof bond !== 'string' || !/^\d{1,40}$/.test(bond)) throw new Held('the policy has no readable proposal bond');
  const last = await g.reader.sameJson('the proposal counter', request.dao, 'get_last_proposal_id', {}, g.head);
  if (!Number.isSafeInteger(last) || (last as number) < 0) throw new Held('the proposal counter is not a whole number');

  const policyMatches = armingState(g.arming, g.template, true).armed;
  const [roleDraft, enrolDraft] = g.template.drafts;
  const wanted = [...(policyMatches || !roleDraft ? [] : [roleDraft]), ...(g.enrolled || !enrolDraft ? [] : [enrolDraft])];
  const prices = await readPrices(request.network, deps.core, deps.transport, deps.limiter);

  const drafts = wanted.map((draft, i): DraftReport => {
    const kindJson = JSON.stringify(draft.kind);
    const who = deps.core.whoActs(g.policy, draft.kind_label);
    const decoding = deps.core.analyze({
      network: request.network,
      dao: request.dao,
      proposal_id: (last as number) + i,
      description: draft.description,
      kind_json: kindJson,
      policy_before_json: g.policy,
      history: null,
      prices: prices.prices,
      dao_version: g.dao.version,
      block_timestamp_ns: g.head.timestampNs,
      guard_account: g.d.guard,
    });
    return {
      title: draft.title,
      label: draft.kind_label,
      filers: people(who.add_proposal) || `nobody: no role of this DAO may file a ${draft.kind_label} proposal`,
      approvers: `${people(who.vote_approve) || 'nobody'}; ${votesText(g.arming.approval_votes_needed[draft.kind_label])}`,
      args: JSON.stringify({ proposal: { description: draft.description, kind: draft.kind } }),
      decoding,
    };
  });

  const afterPolicy = policyMatches || !roleDraft ? g.policy : withRole(g.policy, (roleDraft.kind as { ChangePolicyAddOrUpdateRole: { role: unknown } }).ChangePolicyAddOrUpdateRole.role);
  const afterArming = deps.core.guardArming(afterPolicy, g.d.guard);
  return {
    title: `kaap enroll ${request.dao} on ${request.network}`,
    facts: [
      `read at final block ${g.head.height} (${utc(g.head.timestampNs)}): the DAO's code, its policy and the guard's enrolment agreed by ${g.reader.providers.join(' and ')}`,
      `DAO: Sputnik ${g.dao.version} (code hash ${g.dao.codeHash}); roles: ${roleSummary(g.policy)}`,
      `Kaap on ${request.network}: ${describeDeployment(g.d)}`,
      `guard: ${g.d.guard}; enrolled: ${g.enrolled ? 'yes' : 'no'}; armed by the policy now: ${g.state.armed ? 'yes' : policyMatches ? 'the policy matches Kaap\'s template, the enrolment call is missing' : 'no'}`,
    ],
    bondYocto: bond,
    drafts,
    after: armingLines(afterArming, g.template, armingState(afterArming, g.template, true)),
    network: request.network,
    dao: request.dao,
  };
}

function roleSummary(policy: string): string {
  const roles = (JSON.parse(policy) as { roles: { name: string; kind: unknown }[] }).roles;
  return roles
    .map((r) => {
      const group = (r.kind as { Group?: unknown[] } | null)?.Group;
      return `${oneLine(r.name, 40)} (${Array.isArray(group) ? `${group.length} ${group.length === 1 ? 'member' : 'members'}` : typeof r.kind === 'string' ? oneLine(r.kind, 20) : 'token holders'})`;
    })
    .join(', ');
}

function decodingLines(a: CheckAnalysis): string[] {
  const x = a.analysis;
  return [
    '  Kaap\'s decoding of this draft:',
    ...x.effects.map((e) => `    ${String(e['type'])}: ${plainEffect(e) ?? oneLine(JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'type'))), 600)}`),
    `    findings: ${x.findings.map((f) => `${f.code} ${f.severity}`).join(', ') || 'none'}`,
    `    risk floor ${x.risk_floor}; description check ${x.description_check}; must_veto ${x.must_veto}`,
    ...a.description.contradictions.map((why) => `    contradicts: ${oneLine(why, 300)}`),
  ];
}

export function render(r: EnrollReport): string {
  const near = (yocto: string) => `${units(yocto, 24)} NEAR`;
  const lines = [r.title, ...r.facts, ''];
  const arming = `kaap arming ${r.dao} --network ${r.network}`;
  if (!r.drafts.length) {
    lines.push("nothing to file: the DAO is enrolled and its policy already matches Kaap's template", '', 'now:', ...r.after.map((l) => `  ${l}`), '', `check it again at any time: ${arming}`);
    return lines.join('\n');
  }
  lines.push(`Kaap's enrolment, from its one template: ${r.drafts.length} ${r.drafts.length === 1 ? 'proposal' : 'proposals'}`);
  r.drafts.forEach((d, i) => {
    lines.push(
      '',
      `proposal ${i + 1} of ${r.drafts.length}: ${d.title} (kind ${d.label})`,
      `  who may file it: ${d.filers}`,
      `  who approves it: ${d.approvers}`,
      `  file it with add_proposal on ${r.dao}, attaching exactly ${near(r.bondYocto)} (the DAO's proposal bond) and 30 Tgas, with these arguments:`,
      `  ${d.args}`,
      ...decodingLines(d.decoding),
    );
  });
  lines.push(
    '',
    "after these pass (Sputnik's rules on the policy they leave):",
    ...r.after.map((l) => `  ${l}`),
    '',
    'cost',
    `  each proposal: the DAO's proposal bond, ${near(r.bondYocto)}, attached by whoever files it; Sputnik returns it when the proposal is approved or rejected, and keeps it if the proposal is removed`,
    '  filing burnt about 3 Tgas, about 0.0003 NEAR, on testnet (PROOF-M1.md); each approver pays the gas of their own vote',
    '  the enrolment call: the DAO attaches 0.01 NEAR to enroll; the guard keeps what its entry takes (0.0014 NEAR for a short name, at most about 0.0024) and sends the rest back in the same call. The vote that passes it runs it: 9.0 Tgas in all, about 0.0009 NEAR (packages/contracts/GAS.md)',
    '',
    `when ${r.drafts.length === 1 ? 'it has' : 'they have'} passed, check it on chain: ${arming}`,
  );
  return lines.join('\n');
}
