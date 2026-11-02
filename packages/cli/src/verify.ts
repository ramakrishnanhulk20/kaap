// `kaap verify <dao> <id>`: checks the verdict Kaap's registry holds for one proposal, down to the
// sealed hardware run that produced it, and prints each check as pass or fail. Every signature and
// hash is recomputed here, with Node's ed25519 and kaap-core's own encoders, from values read off
// the chain; no service's "valid" is taken (A8, C28). Reads that decide a check are made at one
// final block and must agree across two providers (C22); the verdict's own block and its sealed run
// are older than the live providers keep, so those come from one archival node, and say so.
//
// What it does not check, and prints as such: the hash of the called contracts' code (kaap-core has
// no shared function for it yet), and the Intel quote inside OutLayer's attestation (see
// outlayer.ts). It only reads: no key, no transaction (C31).

import { z } from 'zod';

import { Held, type Reader } from './chain.js';
import { type Deps, readers } from './check.js';
import { recognise } from './dao.js';
import { type Deployment, loadDeployment } from './deployment.js';
import { type AttestationRead, findRun, readAttestation, readRun, type Run, type Search } from './outlayer.js';
import { type Block, NETWORKS, type Network, Provider, RpcError } from './rpc.js';
import { oneLine, utc } from './text.js';
import { BadVerdict, decodeVerdict, ed25519Valid, edKeyBytes, sha256Hex, signedBytes, type VerdictFields } from './verdict.js';

export class NoVerdict extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoVerdict';
  }
}

export interface VerifyRequest {
  dao: string;
  id: number;
  network: Network;
}

export interface Check {
  ok: boolean;
  text: string;
}

export interface VerifyReport {
  title: string;
  facts: string[];
  checks: Check[];
  notChecked: string[];
  notes: string[];
}

/** The registry's `VerdictRecord` (packages/contracts/registry/src/lib.rs). */
const recordSchema = z.strictObject({
  index: z.number().int().nonnegative(),
  supersedes: z.number().int().nonnegative().nullable(),
  verdict_hash: z.string(),
  verdict: z.string(),
  signature: z.string(),
  guard: z.string(),
  risk: z.string(),
  floor: z.string(),
  findings: z.array(z.string()),
  ai_status: z.string(),
  model_id: z.string(),
  decoder_version: z.string(),
  block_height: z.number().int().nonnegative(),
  expires_at_ms: z.number().int().nonnegative(),
  recorded_by: z.string(),
  recorded_at_block: z.number().int().nonnegative(),
  recorded_at_ms: z.number().int().nonnegative(),
});
type RegistryRecord = z.output<typeof recordSchema>;

const pass = (text: string): Check => ({ ok: true, text });
const fail = (text: string): Check => ({ ok: false, text });
const check = (ok: boolean, yes: string, no: string): Check => (ok ? pass(yes) : fail(no));
const short = (hex: string) => `${hex.slice(0, 8)}...${hex.slice(-4)}`;

async function key(reader: Reader, what: string, account: string, head: Block): Promise<string> {
  const value = await reader.sameJson(what, account, 'accepted_key', {}, head);
  if (typeof value !== 'string') throw new Held(`${what} is not a key`);
  return value;
}

/** The fields the registry shows next to the signed bytes, compared with what the bytes say. */
function summaryMatches(r: RegistryRecord, v: VerdictFields, verdictHash: string): boolean {
  return (
    r.verdict_hash === verdictHash &&
    r.guard === v.guard &&
    r.risk === v.risk &&
    r.floor === v.floor &&
    JSON.stringify(r.findings) === JSON.stringify(v.findings) &&
    r.ai_status === v.ai_status &&
    r.model_id === v.model_id &&
    r.decoder_version === v.decoder_version &&
    r.block_height === v.block_height &&
    r.expires_at_ms === v.expires_at_ms
  );
}

/** The run's chain record and its attestation, against the deployment. Returns the failures. */
function runProblems(run: Run, att: AttestationRead, d: Deployment): { chain: string[]; attested: string[]; hashes: string[] } {
  const chain: string[] = [];
  if (run.signer !== d.worker) chain.push(`signed by ${oneLine(run.signer, 80)}, not ${d.worker}`);
  if (run.receiver !== d.outlayer) chain.push(`sent to ${oneLine(run.receiver, 80)}, not ${d.outlayer}`);
  const r = run.requested;
  if (r === null) chain.push(`${d.outlayer} logged no execution_requested for it`);
  else {
    if (r.sender !== d.worker) chain.push(`the request names caller ${oneLine(r.sender, 80)}`);
    if (r.project !== d.project) chain.push(`the request names project ${oneLine(String(r.project), 80)}`);
    if (r.uuid !== d.uuid) chain.push(`the request names project uuid ${oneLine(String(r.uuid), 40)}, not ${d.uuid}`);
    if (r.build === null || !d.builds.has(r.build)) chain.push(`the request ran build ${oneLine(String(r.build), 70)}, which is not a published build`);
    if (r.inputData !== run.inputData) chain.push('the logged input is not the transaction\'s input');
  }
  const attested: string[] = [];
  const hashes: string[] = [];
  if (!att.found) {
    attested.push(att.why);
    hashes.push(att.why);
    return { chain, attested, hashes };
  }
  const a = att.attestation;
  if (a.transaction_hash !== run.tx) attested.push(`it is for transaction ${oneLine(a.transaction_hash, 50)}`);
  if (a.project_id !== d.project) attested.push(`project ${oneLine(String(a.project_id), 80)}, not ${d.project}`);
  if (a.caller_account_id !== d.worker) attested.push(`caller ${oneLine(a.caller_account_id, 80)}, not ${d.worker}`);
  if (a.wasm_hash === null || !d.builds.has(a.wasm_hash)) attested.push(`wasm hash ${oneLine(String(a.wasm_hash), 70)} is not a published build`);
  if (a.executed_wasm_sha256 !== a.wasm_hash) attested.push(`the executed wasm ${oneLine(String(a.executed_wasm_sha256), 70)} is not the wasm hash`);
  if (r?.build && a.wasm_hash !== r.build) attested.push('the wasm hash is not the build the contract logged');
  if (a.input_hash !== sha256Hex(run.inputData)) hashes.push('the input hash is not the sha256 of the transaction\'s input');
  if (run.output === null) hashes.push('the transaction returned no output');
  else if (a.output_hash !== sha256Hex(run.output)) hashes.push('the output hash is not the sha256 of the transaction\'s output');
  return { chain, attested, hashes };
}

function runChecks(run: Run, att: AttestationRead, d: Deployment, label: string): Check[] {
  const p = runProblems(run, att, d);
  const build = run.requested?.build ? short(run.requested.build) : 'unknown';
  return [
    check(
      !p.chain.length,
      `${label}: ${d.outlayer} recorded the request from ${d.worker} for project ${d.project} (uuid ${d.uuid}), build ${build}, a published build`,
      `${label}: on chain, ${p.chain.join('; ')}`,
    ),
    check(
      !p.attested.length,
      `${label}: OutLayer's attestation names the same project, caller ${d.worker} and wasm ${build}, the build that ran`,
      `${label}: OutLayer's attestation: ${p.attested.join('; ')}`,
    ),
    check(!p.hashes.length, `${label}: the attested input and output hashes are the sha256 of the transaction's input and output`, `${label}: ${p.hashes.join('; ')}`),
  ];
}

export async function verify(deps: Deps & { repoRoot: string }, request: VerifyRequest): Promise<VerifyReport> {
  const { core } = deps;
  const d = loadDeployment(deps.repoRoot, request.network);
  const reader = readers(deps, request.network);
  const head = await reader.head();
  const dao = await recognise(core, reader, NETWORKS[request.network].factory, request.dao, head);
  const latest = await reader.sameJson('the registry\'s latest verdict', d.registry, 'latest', { network: request.network, dao: request.dao, proposal_id: request.id }, head);
  if (latest === null) throw new NoVerdict(`${d.registry} holds no verdict for proposal ${request.id} of ${request.dao} on ${request.network}`);
  const parsed = recordSchema.safeParse(latest);
  if (!parsed.success) throw new Held('the registry\'s latest verdict is not the expected record');
  const record = parsed.data;
  const guardKey = await key(reader, 'the guard\'s accepted key', d.guard, head);
  const registryKey = await key(reader, 'the registry\'s accepted key', d.registry, head);
  const archival = new Provider(NETWORKS[request.network].archival, deps.transport, deps.limiter, deps.clock);

  const bytes = Buffer.from(record.verdict, 'base64');
  const signature = Buffer.from(record.signature, 'base64');
  const signedHash = sha256Hex(signedBytes(bytes));
  const facts = [
    `read at final block ${head.height} (${utc(head.timestampNs)}): agreed by ${reader.providers.join(' and ')}; the verdict's own block and its sealed run from ${archival.name} alone, the one archival provider`,
    `DAO: Sputnik ${dao.version} (code hash ${dao.codeHash})`,
    `Kaap on ${request.network}: guard ${d.guard}, registry ${d.registry}, sealed program ${d.project} called by ${d.worker}`,
    `verdict: record ${record.index} in ${d.registry}, recorded by ${oneLine(record.recorded_by, 80)} at block ${record.recorded_at_block}`,
  ];
  const checks: Check[] = [];
  const notChecked: string[] = [];
  const notes: string[] = [];

  let v: VerdictFields | null = null;
  try {
    v = decodeVerdict(bytes);
  } catch (e) {
    if (!(e instanceof BadVerdict)) throw e;
    checks.push(fail(`format: ${e.message}`));
  }
  if (v !== null) {
    const again = core.verdictHash(v);
    checks.push(check(again === signedHash, `format: a version 1 verdict, and kaap-verdict encodes its fields back to exactly the signed bytes (hash ${short(signedHash)})`, 'format: kaap-verdict does not encode the fields back to the signed bytes'));
    facts.push(
      `  risk ${v.risk}, floor ${v.floor}, findings ${v.findings.join(', ') || 'none'}, AI ${v.ai_status}${v.model_id ? ` (${oneLine(v.model_id, 80)})` : ''}`,
      `  read at block ${v.block_height}, expires ${new Date(v.expires_at_ms).toISOString()}, decoder ${oneLine(v.decoder_version, 20)}`,
    );
    checks.push(
      check(
        v.network === request.network && v.dao === request.dao && v.proposal_id === request.id && v.guard === d.guard,
        `names this network, DAO and proposal, and Kaap's guard ${d.guard}`,
        `names ${oneLine(v.network, 10)}, ${oneLine(v.dao, 80)} #${v.proposal_id} and guard ${oneLine(v.guard, 80)}, not what was asked`,
      ),
      check(summaryMatches(record, v, signedHash), 'the registry\'s summary (hash, risk, floor, findings, AI, block, expiry) is what the signed bytes say', 'the registry\'s summary differs from the signed bytes'),
    );
  }
  const guardRaw = edKeyBytes(guardKey);
  checks.push(
    check(
      guardRaw !== null && ed25519Valid(guardRaw, signedBytes(bytes), signature),
      `sealed signature: valid for the guard's accepted key ${guardKey}, checked here with ed25519`,
      `sealed signature: not valid for the guard's accepted key ${oneLine(guardKey, 60)}`,
    ),
  );
  const registryRaw = edKeyBytes(registryKey);
  checks.push(check(guardRaw !== null && registryRaw !== null && guardRaw.equals(registryRaw), 'the registry accepts the same key as the guard', `the registry accepts ${oneLine(registryKey, 60)}, the guard ${oneLine(guardKey, 60)}`));

  if (v !== null) {
    checks.push(await kindCheck(reader, deps, request, head, v, notes));
    checks.push(await policyCheck(archival, deps, request, v));
    notChecked.push(`receivers hash ${short(v.receivers_hash)} (the DAO's and the called contracts' code): kaap-core has no shared function for it yet, so it is shown, not recomputed`);
  }

  let search: Search | null = null;
  let searchError: string | null = null;
  try {
    if (v !== null) search = await findRun(archival, d, { network: request.network, dao: request.dao, proposalId: request.id, verdict: bytes, signature }, v.block_height);
  } catch (e) {
    if (!(e instanceof RpcError)) throw e;
    searchError = `could not be read: ${e.message}`;
  }
  const run = search?.run ?? null;
  if (run === null) {
    const why =
      v === null
        ? 'the verdict did not decode, so its block is unknown'
        : (searchError ?? `no run by ${d.worker} in blocks ${search?.to} to ${search?.from} returned this verdict and signature${search?.otherRuns ? ` (${search.otherRuns} ${search.otherRuns === 1 ? 'run' : 'runs'} for this proposal returned another)` : ''}`);
    checks.push(fail(`sealed run: ${why}`));
  } else {
    checks.push(pass(`sealed run: transaction ${run.tx} returned exactly this verdict and signature (found in ${search?.blocksRead} blocks)`));
    const att = await readAttestation(request.network, run.tx, deps.transport, deps.limiter);
    checks.push(...runChecks(run, att, d, 'the run'));
    notChecked.push(`the Intel TDX quote inside the attestation: its signature chain needs Intel's collateral, which this CLI does not carry; OutLayer's record: ${att.url}`);
  }

  checks.push(...(await keyChecks(archival, deps, request.network, d, guardRaw)));

  notes.push(aiEvidence(v));
  const used = await reader.sameJson('the guard\'s veto result', d.guard, 'veto_result', { verdict_hash_hex: signedHash }, head);
  notes.push(
    used === 'Ok'
      ? 'the guard voted to reject with this verdict, and the DAO took the vote'
      : used === 'Failed'
        ? 'the guard tried to vote with this verdict and the DAO refused the vote'
        : 'the guard has not voted with this verdict',
  );
  return { title: `kaap verify ${request.dao} #${request.id} on ${request.network}`, facts, checks, notChecked, notes };
}

async function kindCheck(reader: Reader, deps: Deps, request: VerifyRequest, head: Block, v: VerdictFields, notes: string[]): Promise<Check> {
  try {
    const { read } = await reader.proposal(request.dao, request.id, head);
    notes.push(`proposal ${request.id} is ${oneLine(read.status, 40)} at block ${head.height}`);
    const kindHash = deps.core.kindHash(read.kind_json);
    return check(kindHash === v.kind_hash, `kind hash: kaap-core recomputes ${short(kindHash)} from proposal ${request.id} as stored`, `kind hash: kaap-core gives ${short(kindHash)} from the stored proposal, the verdict says ${short(v.kind_hash)}`);
  } catch (e) {
    if (e instanceof RpcError && e.failure === 'no_proposal') return fail(`kind hash: proposal ${request.id} is no longer stored, so its kind cannot be hashed again`);
    throw e;
  }
}

async function policyCheck(archival: Provider, deps: Deps, request: VerifyRequest, v: VerdictFields): Promise<Check> {
  try {
    const view = await archival.view(request.dao, 'get_policy', {}, v.block_height);
    const policyHash = deps.core.policyHash(view.text);
    return check(policyHash === v.policy_hash, `policy hash: kaap-core recomputes ${short(policyHash)} from the DAO's policy at block ${v.block_height}`, `policy hash: kaap-core gives ${short(policyHash)} at block ${v.block_height}, the verdict says ${short(v.policy_hash)}`);
  } catch (e) {
    if (e instanceof RpcError) return fail(`policy hash: the policy at block ${v.block_height} could not be read (${e.message})`);
    throw e;
  }
}

/** The guard's key must be the one a run of this project, caller and published build printed in
 *  its attested output: no OutLayer call returns a project's key directly. */
async function keyChecks(archival: Provider, deps: Deps, network: Network, d: Deployment, guardRaw: Buffer | null): Promise<Check[]> {
  const label = `the key's run ${d.attestedRunTx.slice(0, 8)}...`;
  let run: Run | null;
  try {
    run = await readRun(archival, d.attestedRunTx, d.worker, d.outlayer);
  } catch (e) {
    if (!(e instanceof RpcError)) throw e;
    return [fail(`${label}: could not be read (${e.message})`)];
  }
  if (run === null) return [fail(`${label}: ${archival.name} does not know transaction ${d.attestedRunTx}`)];
  const att = await readAttestation(network, run.tx, deps.transport, deps.limiter);
  const printed = run.sealed ? edKeyBytes(run.sealed.public_key) : null;
  return [
    ...runChecks(run, att, d, label),
    check(
      guardRaw !== null && printed !== null && printed.equals(guardRaw),
      `${label}: its attested output prints the guard's accepted key`,
      `${label}: its attested output prints ${run.sealed ? oneLine(run.sealed.public_key, 60) : 'no key'}, not the guard's accepted key`,
    ),
  ];
}

function aiEvidence(v: VerdictFields | null): string {
  if (v === null) return 'AI evidence: unknown, the verdict did not decode';
  if (v.model_id === '') return `AI evidence: none. This verdict carries no AI answer (AI ${v.ai_status}), so there is nothing for https://cloud.near.ai/verify to check`;
  return `AI evidence: AI ${v.ai_status}, model ${oneLine(v.model_id, 80)}; NEAR AI's own verifier: https://cloud.near.ai/verify?model=${encodeURIComponent(v.model_id)}`;
}

export function render(r: VerifyReport): string {
  const failed = r.checks.filter((c) => !c.ok).length;
  return [
    r.title,
    ...r.facts,
    '',
    'checks',
    ...r.checks.map((c) => `  ${c.ok ? 'pass' : 'fail'}  ${c.text}`),
    '',
    'not checked here',
    ...r.notChecked.map((t) => `  ${t}`),
    '',
    ...r.notes,
    '',
    failed === 0 ? `result: all ${r.checks.length} checks pass` : `result: ${failed} of ${r.checks.length} checks fail`,
  ].join('\n');
}
