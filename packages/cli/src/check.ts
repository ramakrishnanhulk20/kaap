// `kaap check <dao> [id]`: reads one proposal of any Sputnik DAO with no keys and prints what
// kaap-core makes of it. Everything that decides the answer is read at one final block and must
// agree across two providers (C22); the DAO must be real Sputnik code (C23); the rules are
// kaap-core's own, run as wasm (C14). The CLI only reads: it holds no key and sends no transaction
// (C31). It is advisory: the AI and the guard run only in Kaap's sealed program.

import { Held, Reader } from './chain.js';
import type { CheckAnalysis, Core, History } from './core.js';
import { recognise } from './dao.js';
import { historyBefore, policyBefore, readAll } from './history.js';
import type { Clock, RateLimiter } from './limiter.js';
import type { Transport } from './net.js';
import { readPrices } from './prices.js';
import { type Block, NETWORKS, type Network, Provider, RpcError } from './rpc.js';
import { oneLine, shown, units, utc } from './text.js';

export const ADVISORY = "advisory: plain-code check only; the AI and the guard run in Kaap's sealed program";

export class NoProposal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoProposal';
  }
}

export interface Deps {
  core: Core;
  transport: Transport;
  limiter: RateLimiter;
  clock: Clock;
}

export interface CheckRequest {
  dao: string;
  id: number | null;
  network: Network;
}

export interface CheckReport {
  network: Network;
  dao: string;
  proposal_id: number;
  block: { height: number; hash: string; timestamp_ns: string };
  providers: string[];
  dao_version: string;
  code_hash: string;
  status: string;
  proposer: string;
  description: string;
  kind_hash: string;
  policy_hash_now: string;
  policy_before: { known: boolean; source: string };
  history: History | null;
  history_source: string;
  prices_source: string;
  kind_label: string;
  analysis: CheckAnalysis['analysis'];
  description_reasons: CheckAnalysis['description'];
  advisory: string;
}

export function readers(deps: Deps, network: Network): Reader {
  const { primary, secondary } = NETWORKS[network];
  return new Reader(new Provider(primary, deps.transport, deps.limiter, deps.clock), new Provider(secondary, deps.transport, deps.limiter, deps.clock), deps.core);
}

async function counter(reader: Reader, dao: string, block: Block): Promise<number> {
  const view = await reader.sameView('the proposal counter', dao, 'get_last_proposal_id', {}, block);
  const last: unknown = JSON.parse(view.text);
  if (!Number.isSafeInteger(last) || (last as number) < 0) throw new Held('the proposal counter is not a whole number');
  return last as number;
}

/** The report, and the token decimals the price table knows, for showing amounts. */
export async function check(deps: Deps, request: CheckRequest): Promise<{ report: CheckReport; decimals: Map<string, number> }> {
  const { core } = deps;
  const reader = readers(deps, request.network);
  const head = await reader.head();
  const dao = await recognise(core, reader, NETWORKS[request.network].factory, request.dao, head);
  const last = await counter(reader, request.dao, head);
  if (last === 0) throw new NoProposal('this DAO has no proposals yet');
  const id = request.id ?? last - 1;
  if (id >= last) throw new NoProposal(`proposal ${id} does not exist: this DAO has proposals 0 to ${last - 1}`);

  let proposal;
  try {
    proposal = await reader.proposal(request.dao, id, head);
  } catch (e) {
    if (e instanceof RpcError && e.failure === 'no_proposal') throw new NoProposal(`proposal ${id} is not stored: it was removed, or never stored`);
    throw e;
  }
  const { read } = proposal;
  const policyNow = await reader.policy(request.dao, head);
  const past = await readAll(reader.primary, request.dao, last, head.height);
  const prices = await readPrices(request.network, core, deps.transport, deps.limiter);
  const before = policyBefore(core, read, policyNow, past);
  const history = past.complete ? historyBefore(past.proposals, read.submission_time, prices.prices) : null;

  const result = core.analyze({
    network: request.network,
    dao: request.dao,
    proposal_id: id,
    description: read.description,
    kind_json: read.kind_json,
    policy_before_json: before.known ? before.text : null,
    history,
    prices: prices.prices,
    dao_version: dao.version,
    block_timestamp_ns: head.timestampNs,
  });

  const report: CheckReport = {
    network: request.network,
    dao: request.dao,
    proposal_id: id,
    block: { height: head.height, hash: head.hash, timestamp_ns: head.timestampNs },
    providers: reader.providers,
    dao_version: dao.version,
    code_hash: dao.codeHash,
    status: read.status,
    proposer: read.proposer,
    description: read.description,
    kind_hash: core.kindHash(read.kind_json),
    policy_hash_now: core.policyHash(policyNow),
    policy_before: { known: before.known, source: before.source },
    history,
    history_source: past.complete
      ? `the DAO's approved payments submitted before this proposal (${past.proposals.length} stored proposals read, USD at today's prices)`
      : 'not available: the DAO\'s earlier proposals could not all be read, so NEW_RECIPIENT and LARGE_AMOUNT are not judged',
    prices_source: prices.source,
    kind_label: result.kind_label,
    analysis: result.analysis,
    description_reasons: result.description,
    advisory: ADVISORY,
  };
  return { report, decimals: new Map(Object.entries(prices.prices.usd_by_token).map(([token, [d]]) => [token, d])) };
}

/** Effects whose amount is NEAR whatever else they name. */
const IN_NEAR = new Set(['wrap', 'staking', 'storage_deposit', 'bulk_payment']);

/** 24 decimals for native NEAR, else the decimals the price table holds, else none. */
function decimalsOf(token: unknown, decimals: Map<string, number>): number | null {
  if (token === 'near') return 24;
  return typeof token === 'string' ? (decimals.get(token) ?? null) : null;
}

function effectLine(effect: Record<string, unknown>, decimals: Map<string, number>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(effect)) {
    if (key === 'type') continue;
    let text = typeof value === 'string' ? value : JSON.stringify(value);
    if ((key === 'amount' || key === 'total' || key === 'deposit') && typeof value === 'string' && /^\d+$/.test(value)) {
      const token = key === 'deposit' || IN_NEAR.has(String(effect['type'])) ? 'near' : effect['token'];
      const d = decimalsOf(token, decimals);
      if (d !== null) text = `${value} (${units(value, d)} ${token === 'near' ? 'NEAR' : 'whole tokens'})`;
    }
    parts.push(`${key} ${oneLine(text, 300)}`);
  }
  return `${String(effect['type'])}: ${parts.join(', ')}`;
}

export function render(report: CheckReport, decimals: Map<string, number> = new Map()): string {
  const a = report.analysis;
  const lines = [
    `kaap check ${oneLine(report.dao, 80)} #${report.proposal_id} on ${report.network}`,
    `read at final block ${report.block.height} (${utc(report.block.timestamp_ns)}): the DAO's code, the proposal and the policy agreed by ${report.providers.join(' and ')}; the history from ${report.providers[0] ?? ''} alone`,
    `DAO: Sputnik ${report.dao_version} (code hash ${report.code_hash})`,
    `status: ${oneLine(report.status, 40)}, proposer ${oneLine(report.proposer, 80)}`,
    `description: ${shown(report.description)}`,
    `kind hash: ${report.kind_hash}`,
    `policy before: ${report.policy_before.source}`,
    `history: ${report.history ? `${report.history.approved_payments_before} approved payments before this one, median ${report.history.median_payment_usd_before ?? 'n/a'} USD, ${report.history.recipients_paid_before.length} recipients; ${report.history_source}` : report.history_source}`,
    `prices: ${report.prices_source}`,
    '',
    'effects',
    ...(a.effects.length ? a.effects.map((e) => `  ${effectLine(e, decimals)}`) : ['  none']),
    'findings',
    ...(a.findings.length ? a.findings.map((f) => `  ${f.code.padEnd(26)} ${f.severity}`) : ['  none']),
    `risk floor: ${a.risk_floor}`,
    `description check: ${a.description_check}`,
    ...report.description_reasons.contradictions.map((why) => `  contradicts: ${why}`),
    ...report.description_reasons.agreements.map((why) => `  agrees: ${why}`),
    `must_veto: ${a.must_veto}`,
    `veto_allowed: ${a.veto_allowed}`,
    '',
    report.advisory,
  ];
  return lines.join('\n');
}

