// `kaap verify <dao> <id>`: checks the verdict Kaap's registry holds for one proposal, down to the
// sealed hardware run that produced it, and prints each check as pass or fail. The verdict is looked
// for in the current deployment's registry, then in each earlier record's (deployment.ts), and every
// check is made against the deployment that holds it, named in its own line, starting with that
// deployment's guard and registry still running the build its record names, with no access key
// (contracts.ts). Every signature and hash is recomputed here, with Node's ed25519 and kaap-core's
// own encoders, from values read off the chain; no service's "valid" is taken (A8, C28). Reads that
// decide a check are made at one final block and must agree across two providers (C22); the
// verdict's own block and its sealed run soon grow older than the live providers keep, so each of
// those reads comes from one node (rpc.ts `Archive`): a live provider while it still holds the data,
// else KAAP_ARCHIVAL_RPC when set, else a public archival node. That covers the policy and the
// called contracts' code at the verdict's block, and the sealed runs. They are never compared: the
// two public testnet archives are served by the same operator (checked 3 Nov), so a second read
// there would not be independent. Every line that rests on one of them names the node that answered
// and says it is one node, not compared; one that also rests on OutLayer's API says so; and the
// result line counts them, so a quote of it never claims more than its lines do. As corroboration,
// the same contracts' code is read again at the final block from both live providers, and a
// redeploy since the verdict is a warning. A read that no node would answer is shown as unread,
// never as a failed check, and the command exits 6, not 5.
//
// What it does not check, and prints as such: Intel's signature on the TDX quote inside OutLayer's
// attestation, and OutLayer's approval of its measurements (see outlayer.ts and binding.ts). A
// verdict from another decoder version is a warning, not a failure, since an older verdict was
// made by an older kaap-core. It only reads: no key, no transaction (C31).

import { z } from 'zod';

import { BindingRefused, quoteReportData, taskHash } from './binding.js';
import { Held, type Reader, Unanswered } from './chain.js';
import { type Deps, readers } from './check.js';
import { type ContractLine, contractsAsRecorded } from './contracts.js';
import { type Core, CoreError } from './core.js';
import { recognise } from './dao.js';
import { type Deployment, deploymentChain, describeDeployment } from './deployment.js';
import { type Attestation, type AttestationRead, findRun, readAttestation, readRun, type Run, type Search } from './outlayer.js';
import { Archive, archiveHosts, type Block, NETWORKS, type Network, RpcError } from './rpc.js';
import { oneLine, terminalText, utc } from './text.js';
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
  /** KAAP_ARCHIVAL_RPC, asked before the public archival nodes. */
  archival?: string;
}

export interface Check {
  ok: boolean;
  text: string;
  /** Passed, but the reader should know something: shown as "warn", never as a failure. */
  warning?: boolean;
  /** Could not be read at all, so neither passed nor failed: shown as "unread". Names where the
   *  read was asked: the archive list, the two live providers, or OutLayer's API. */
  unread?: Unread;
  /** Its evidence came from one node, or from OutLayer's API checked against one node, and its
   *  text says so. Every other check that reads the chain rests on both live providers. */
  oneSource?: boolean;
}

/** How a line that rests on one node, and one that also rests on OutLayer's API, names its source. */
const oneNode = (source: string) => `chain read from ${source}, one node per read, not compared`;
const apiAndNode = (source: string) => `attestation from OutLayer's API alone; ${oneNode(source)}`;
const single = (c: Check): Check => ({ ...c, oneSource: true });

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
type Unread = 'archive' | 'live' | 'outlayer';
const unread = (text: string, from: Unread = 'archive'): Check => ({ ok: false, unread: from, text });
const check = (ok: boolean, yes: string, no: string): Check => (ok ? pass(yes) : fail(no));
const contractCheck = (l: ContractLine): Check => (l.status === 'pass' ? pass(l.text) : l.status === 'fail' ? fail(l.text) : unread(l.text, 'live'));
/** A failed read: unread when no node answered, failed when one did with something else. */
const notRead = (e: RpcError, text: string, from: Unread = 'archive'): Check => (e.failure === 'unavailable' ? unread(text, from) : fail(text));
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

const seconds = (b: Block) => Number(BigInt(b.timestampNs) / 1_000_000_000n);

/** OutLayer's record against the TDX quote it was served with, then against the chain: the fields
 *  the quote commits to that the chain also holds must be the chain's, and the record's time must
 *  fall between the request's block and its completion's. Returns the task hash recomputed from
 *  the record (null when the quote or the record is refused) and the failures. */
function bindingProblems(run: Run, a: Attestation, d: Deployment): { hash: string | null; problems: string[] } {
  const problems: string[] = [];
  let hash: string | null = null;
  try {
    const quote = quoteReportData(a.tdx_quote);
    hash = taskHash(a).toString('hex');
    const signed = quote.first.toString('hex');
    if (hash !== signed) problems.push(`the task hash recomputed from the record, ${short(hash)}, is not the ${short(signed)} the quote commits to`);
    if (!quote.rest.equals(Buffer.alloc(32))) problems.push('the quote\'s REPORTDATA is not zero after the task hash');
  } catch (e) {
    if (!(e instanceof BindingRefused)) throw e;
    problems.push(e.message);
  }
  const r = run.requested;
  if (r === null) {
    problems.push(`${d.outlayer} logged no execution_requested to compare it with`);
    return { hash, problems };
  }
  const shown = (v: string | number | null | undefined) => (v === null || v === undefined ? 'none' : oneLine(String(v), 70));
  const fields: [string, string | null | undefined, string | null][] = [
    ['build target', a.build_target, r.buildTarget],
    ['wasm hash', a.wasm_hash, r.build],
    ['attached usd', a.attached_usd, r.attachedUsd],
    ['secrets reference', a.secrets_ref, r.secretsRef],
  ];
  for (const [name, record, chain] of fields) if ((record ?? null) !== chain) problems.push(`${name} ${shown(record)}, the request names ${shown(chain)}`);
  const from = run.requestBlock;
  const to = run.completionBlock;
  if (from === null) problems.push('the request\'s receipt names no block');
  else if (a.block_height !== from.height) problems.push(`block height ${shown(a.block_height)}, the request ran in block ${from.height}`);
  if (to === null) problems.push(`${d.outlayer} logged no execution_completed, so the record's time cannot be bounded`);
  if (from !== null && to !== null && (a.timestamp < seconds(from) || a.timestamp > seconds(to))) {
    problems.push(`stamped ${a.timestamp}, outside the request block's time ${seconds(from)} to the completion block's time ${seconds(to)}`);
  }
  return { hash, problems };
}

/** The run's checks, each naming its sources in its own text: `source`, the one node per read its
 *  chain record came from, and for the three that rest on it, OutLayer's API. When OutLayer never
 *  answered for its attestation, those three are unread. */
function runChecks(run: Run, att: AttestationRead, d: Deployment, label: string, source: string): Check[] {
  const p = runProblems(run, att, d);
  const b = att.found ? bindingProblems(run, att.attestation, d) : { hash: null, problems: [att.why] };
  // Named in a passing line only, which needs a published build, so it is shown only when it is one.
  const build = run.requested?.build && d.builds.has(run.requested.build) ? short(run.requested.build) : 'unknown';
  const why = att.found ? '' : att.why;
  const unreadAttestation = (what: string): Check => unread(`${label}: ${what} could not be checked, because OutLayer's API did not answer for its attestation (${why})`, 'outlayer');
  const record = check(
    !p.chain.length,
    `${label}: ${d.outlayer} recorded the request from ${d.worker} for project ${d.project} (uuid ${d.uuid}), build ${build}, a published build`,
    `${label}: on chain, ${p.chain.join('; ')}`,
  );
  const attested =
    !att.found && att.unanswered
      ? [unreadAttestation('the attested project, caller and wasm'), unreadAttestation('the attested input and output hashes'), unreadAttestation('OutLayer\'s record against its TDX quote')]
      : attestationChecks(p, b, d, label, build);
  const sources = (c: Check, named: string): Check => single({ ...c, text: `${c.text} (${named})` });
  return [sources(record, oneNode(source)), ...attested.map((c) => sources(c, att.found ? apiAndNode(source) : oneNode(source)))];
}

function attestationChecks(p: ReturnType<typeof runProblems>, b: { hash: string | null; problems: string[] }, d: Deployment, label: string, build: string): Check[] {
  return [
    check(
      !p.attested.length,
      `${label}: OutLayer's attestation names the same project, caller ${d.worker} and wasm ${build}, the build that ran`,
      `${label}: OutLayer's attestation: ${p.attested.join('; ')}`,
    ),
    check(!p.hashes.length, `${label}: the attested input and output hashes are the sha256 of the transaction's input and output`, `${label}: ${p.hashes.join('; ')}`),
    // A pass is always V1: the time window puts the record after the request's block, and every
    // block a Kaap run can sit in is after the V1 cutoff.
    check(
      b.hash !== null && !b.problems.length,
      `${label}: OutLayer's record is the one its TDX quote commits to (task hash ${short(b.hash ?? '')}, V1); Intel's signature on the quote is not checked here`,
      `${label}: OutLayer's record and its TDX quote: ${b.problems.join('; ')}`,
    ),
  ];
}

/** The first deployment, current first, whose registry holds a verdict for the proposal, read by
 *  both providers at `head`, with the registries before it that hold none. */
async function withVerdict(reader: Reader, repoRoot: string, request: VerifyRequest, head: Block): Promise<{ d: Deployment; latest: unknown; without: string[] }> {
  const without: string[] = [];
  for (const d of deploymentChain(repoRoot, request.network)) {
    if (without.includes(d.registry)) continue;
    const latest = await reader.sameJson('the registry\'s latest verdict', d.registry, 'latest', { network: request.network, dao: request.dao, proposal_id: request.id }, head);
    if (latest !== null) return { d, latest, without };
    without.push(d.registry);
  }
  throw new NoVerdict(`${without.join(' and ')} ${without.length === 1 ? 'holds' : 'hold'} no verdict for proposal ${request.id} of ${request.dao} on ${request.network}`);
}

export async function verify(deps: Deps & { repoRoot: string }, request: VerifyRequest): Promise<VerifyReport> {
  const { core } = deps;
  const reader = readers(deps, request.network);
  const head = await reader.head();
  const dao = await recognise(core, reader, NETWORKS[request.network].factory, request.dao, head);
  const { d, latest, without } = await withVerdict(reader, deps.repoRoot, request, head);
  // The contracts of the record that holds the verdict, an earlier one included, come first: the
  // checks after them read through that guard and that registry.
  const contracts = await contractsAsRecorded(reader, d, head);
  const parsed = recordSchema.safeParse(latest);
  if (!parsed.success) throw new Held('the registry\'s latest verdict is not the expected record');
  const record = parsed.data;
  const guardKey = await key(reader, 'the guard\'s accepted key', d.guard, head);
  const registryKey = await key(reader, 'the registry\'s accepted key', d.registry, head);
  const archive = new Archive(archiveHosts(request.network, request.archival ?? null), deps.transport, deps.limiter, deps.clock);

  const bytes = Buffer.from(record.verdict, 'base64');
  const signature = Buffer.from(record.signature, 'base64');
  const signedHash = sha256Hex(signedBytes(bytes));
  const facts = [
    `read at final block ${head.height} (${utc(head.timestampNs)}): agreed by ${reader.providers.join(' and ')}; the verdict's own block (the policy and the called contracts' code) and the sealed runs from one node per read, never compared: a live provider while it still holds them, else an archival node, named on each line`,
    `DAO: Sputnik ${dao.version} (code hash ${dao.codeHash})`,
    `Kaap on ${request.network}: ${describeDeployment(d)}, sealed program ${d.project} called by ${d.worker}${without.length ? `; used because ${without.join(' and ')} ${without.length === 1 ? 'holds' : 'hold'} no verdict for this proposal` : ''}`,
    `verdict: record ${record.index} in ${d.registry}, recorded by ${oneLine(record.recorded_by, 80)} at block ${record.recorded_at_block}`,
  ];
  const checks: Check[] = contracts.map(contractCheck);
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
    // The verdict reader takes any safe integer, and past 8.64e15 ms a date holds no time at all.
    const expiry = new Date(v.expires_at_ms);
    const realTime = !Number.isNaN(expiry.getTime());
    facts.push(
      `  risk ${v.risk}, floor ${v.floor}, findings ${v.findings.join(', ') || 'none'}, AI ${v.ai_status}${v.model_id ? ` (${oneLine(v.model_id, 80)})` : ''}`,
      `  read at block ${v.block_height}, expires ${realTime ? expiry.toISOString() : `at ${v.expires_at_ms} ms after 1970, not a real time`}, decoder ${oneLine(v.decoder_version, 20)}`,
    );
    if (!realTime) checks.push(fail(`expiry: the verdict expires ${v.expires_at_ms} ms after 1970, which is not a real time`));
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
    const kind = await storedKind(reader, request, head, notes);
    checks.push(kindCheck(core, request, v, kind));
    checks.push(await policyCheck(archive, deps, request, v));
    const receivers = await receiversCheck(archive, core, request, v, kind);
    checks.push(receivers.check);
    if (receivers.pairs !== null) checks.push(await receiversNow(reader, head, receivers.pairs));
    checks.push(decoderCheck(v.decoder_version, core.decoderVersion()));
  }

  let search: Search | null = null;
  let searchError: RpcError | null = null;
  const searchMark = archive.answered.length;
  try {
    if (v !== null) search = await findRun(archive, d, { network: request.network, dao: request.dao, proposalId: request.id, verdict: bytes, signature }, v.block_height);
  } catch (e) {
    if (!(e instanceof RpcError)) throw e;
    searchError = e;
  }
  const searched = archive.hostsSince(searchMark);
  const run = search?.run ?? null;
  if (searchError !== null) {
    checks.push(notRead(searchError, `sealed run: could not be read: ${searchError.message}`));
  } else if (run === null) {
    const why =
      v === null
        ? 'the verdict did not decode, so its block is unknown'
        : `no run by ${d.worker} in blocks ${search?.to} to ${search?.from} returned this verdict and signature${search?.otherRuns ? ` (${search.otherRuns} ${search.otherRuns === 1 ? 'run' : 'runs'} for this proposal returned another)` : ''}${searched ? ` (${oneNode(searched)})` : ''}`;
    checks.push(v === null ? fail(`sealed run: ${why}`) : single(fail(`sealed run: ${why}`)));
  } else {
    checks.push(single(pass(`sealed run: transaction ${run.tx} returned exactly this verdict and signature (found in ${search?.blocksRead} blocks, ${oneNode(searched)})`)));
    const att = await readAttestation(request.network, run.tx, deps.transport, deps.limiter, deps.clock);
    checks.push(...runChecks(run, att, d, 'the run', searched));
    notChecked.push(`Intel's signature on the TDX quote and OutLayer's approval of its measurements (OutLayer's own tool: outlayer-verify tx ${run.tx} --network ${request.network} --api ${NETWORKS[request.network].outlayer}); record: ${att.url}`);
  }

  checks.push(...(await keyChecks(archive, deps, request.network, d, guardRaw)));

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

/** The proposal's kind as both providers store it now, or null when the DAO no longer stores it. */
async function storedKind(reader: Reader, request: VerifyRequest, head: Block, notes: string[]): Promise<string | null> {
  try {
    const { read } = await reader.proposal(request.dao, request.id, head);
    notes.push(`proposal ${request.id} is ${oneLine(read.status, 40)} at block ${head.height}`);
    return read.kind_json;
  } catch (e) {
    if (e instanceof RpcError && e.failure === 'no_proposal') return null;
    throw e;
  }
}

function kindCheck(core: Core, request: VerifyRequest, v: VerdictFields, kind: string | null): Check {
  if (kind === null) return fail(`kind hash: proposal ${request.id} is no longer stored, so its kind cannot be hashed again`);
  const kindHash = core.kindHash(kind);
  return check(kindHash === v.kind_hash, `kind hash: kaap-core recomputes ${short(kindHash)} from proposal ${request.id} as stored`, `kind hash: kaap-core gives ${short(kindHash)} from the stored proposal, the verdict says ${short(v.kind_hash)}`);
}

async function policyCheck(archive: Archive, deps: Deps, request: VerifyRequest, v: VerdictFields): Promise<Check> {
  try {
    const view = await archive.view(request.dao, 'get_policy', {}, v.block_height);
    const policyHash = deps.core.policyHash(view.text);
    const from = `(read from ${archive.name}, one node, not compared)`;
    return single(
      check(
        policyHash === v.policy_hash,
        `policy hash: kaap-core recomputes ${short(policyHash)} from the DAO's policy at block ${v.block_height} ${from}`,
        `policy hash: kaap-core gives ${short(policyHash)} at block ${v.block_height} ${from}, the verdict says ${short(v.policy_hash)}`,
      ),
    );
  } catch (e) {
    if (e instanceof RpcError) return notRead(e, `policy hash: the policy at block ${v.block_height} could not be read (${e.message})`);
    throw e;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The DAO, then every contract whose code runs when the kind executes, exactly as kaap-core picks
 *  them for the sealed job (packages/core/src/receipt.rs `called_accounts`): the receiver of a
 *  FunctionCall or an UpgradeRemote, the token of a non-NEAR Transfer, and that Transfer's receiver
 *  when it carries a `msg`. kaap-core-wasm does not export this pick, so it is copied here. A copy
 *  that picks differently can only fail the receivers check, never pass it, because the hash covers
 *  every account by name. A kind kaap-core cannot read adds nothing, as in the sealed job. Null when
 *  an account is not a valid id, a kind the sealed job refuses to judge. */
export function calledAccounts(core: Core, dao: string, kindJson: string): string[] | null {
  const accounts = [dao];
  let kind: unknown = null;
  try {
    kind = JSON.parse(core.canonicalKind(kindJson));
  } catch (e) {
    if (!(e instanceof CoreError) && !(e instanceof SyntaxError)) throw e;
  }
  const entries = isRecord(kind) ? Object.entries(kind) : [];
  if (entries.length === 1 && entries[0] !== undefined) {
    const [variant, body] = entries[0];
    const field = (name: string) => {
      const value = isRecord(body) ? body[name] : undefined;
      return typeof value === 'string' ? value : null;
    };
    const add = (account: string | null) => {
      if (account !== null) accounts.push(account);
    };
    if (variant === 'FunctionCall' || variant === 'UpgradeRemote') add(field('receiver_id'));
    if (variant === 'Transfer') {
      const token = field('token_id');
      if (token) {
        add(token);
        if (field('msg') !== null) add(field('receiver_id'));
      }
    }
  }
  const unique = [...new Set(accounts)];
  return unique.every((a) => core.isAccountId(a)) ? unique : null;
}

/** C4: the verdict pins the code of the DAO and of every contract the kind calls, at its block.
 *  Returns the (account, code hash) pairs read there, or null when they could not all be read. */
async function receiversCheck(archive: Archive, core: Core, request: VerifyRequest, v: VerdictFields, kind: string | null): Promise<{ check: Check; pairs: [string, string][] | null }> {
  const at = v.block_height;
  const refused = (text: string) => ({ check: fail(`receivers hash: ${text}`), pairs: null });
  if (kind === null) return refused(`proposal ${request.id} is no longer stored, so the contracts it calls cannot be named`);
  const accounts = calledAccounts(core, request.dao, kind);
  if (accounts === null) return refused('the proposal names a receiver that is not a valid account id, which Kaap\'s sealed program never judges');
  const pairs: [string, string][] = [];
  const mark = archive.answered.length;
  for (const account of accounts) {
    try {
      const state = await archive.account(account, at);
      if (state.blockHeight !== at) return refused(`${archive.name} answered for block ${state.blockHeight} when asked for ${oneLine(account, 80)} at block ${at}`);
      pairs.push([account, state.codeHash]);
    } catch (e) {
      if (!(e instanceof RpcError)) throw e;
      const why = e.failure === 'missing_account' ? `${e.provider}: no such account at that block` : e.message;
      return { check: notRead(e, `receivers hash: the code of ${oneLine(account, 80)} at block ${at} could not be read (${why})`), pairs: null };
    }
  }
  const hash = core.receiversHash(pairs);
  const named = accounts.map((a) => oneLine(a, 80)).join(', ');
  const source = `(read from ${archive.hostsSince(mark)}, one node per read, not compared)`;
  return {
    check: single(
      check(
        hash === v.receivers_hash,
        `receivers hash: kaap-core recomputes ${short(hash)} from the code of ${named} at block ${at} ${source}`,
        `receivers hash: kaap-core gives ${short(hash)} from the code of ${named} at block ${at} ${source}, the verdict says ${short(v.receivers_hash)}`,
      ),
    ),
    pairs,
  };
}

/** C4 again, now: the same contracts' code at the final block, agreed by both live providers (C22).
 *  A contract redeployed after the verdict does not forge it, but the verdict judged code that no
 *  longer runs, so a change warns instead of failing. A disagreement, or a read that fails, fails. */
async function receiversNow(reader: Reader, head: Block, pinned: [string, string][]): Promise<Check> {
  const changed: string[] = [];
  for (const [account, then] of pinned) {
    let now: string;
    try {
      now = (await reader.account(account, head)).codeHash;
    } catch (e) {
      if (e instanceof Unanswered) return unread(`receivers now: ${e.message} at block ${head.height}`, 'live');
      if (e instanceof Held) return fail(`receivers now: ${e.message} at block ${head.height}`);
      if (e instanceof RpcError) return notRead(e, `receivers now: the code of ${oneLine(account, 80)} at block ${head.height} could not be read (${e.failure === 'missing_account' ? 'no such account' : e.message})`, 'live');
      throw e;
    }
    if (now !== then) changed.push(oneLine(account, 80));
  }
  if (!changed.length) return pass(`receivers now: the code of ${pinned.map(([a]) => oneLine(a, 80)).join(', ')} at block ${head.height} is unchanged since the verdict (two providers)`);
  return {
    ok: true,
    warning: true,
    text: `receivers now: changed since the verdict: ${changed.join(', ')} (block ${head.height}, two providers); a redeploy after the verdict does not forge it, but the verdict judged the code of its own block`,
  };
}

/** A verdict names the kaap-core that judged it. Another version is a warning, not a failure: a
 *  verdict made before an upgrade carries the decoder of its day. */
export function decoderCheck(verdictDecoder: string, ours: string): Check {
  if (verdictDecoder === ours) return pass(`decoder: the verdict names kaap-core ${ours}, the decoder this CLI runs`);
  return {
    ok: true,
    warning: true,
    text: `decoder: the verdict names decoder ${oneLine(verdictDecoder, 20)}, this CLI runs kaap-core ${ours}; an older verdict may come from an older decoder, so what kaap check prints today can differ from it`,
  };
}

/** The guard's key must be the one a run of this project, caller and published build printed in
 *  its attested output: no OutLayer call returns a project's key directly. */
async function keyChecks(archive: Archive, deps: Deps, network: Network, d: Deployment, guardRaw: Buffer | null): Promise<Check[]> {
  const label = `the key's run ${d.attestedRunTx.slice(0, 8)}...`;
  const mark = archive.answered.length;
  let run: Run | null;
  try {
    run = await readRun(archive, d.attestedRunTx, d.worker, d.outlayer);
  } catch (e) {
    if (!(e instanceof RpcError)) throw e;
    return [notRead(e, `${label}: could not be read (${e.message})`)];
  }
  if (run === null) return [fail(`${label}: ${archive.name} does not know transaction ${d.attestedRunTx}`)];
  const source = archive.hostsSince(mark);
  const att = await readAttestation(network, d.attestedRunTx, deps.transport, deps.limiter, deps.clock);
  const printed = run.sealed ? edKeyBytes(run.sealed.public_key) : null;
  return [
    ...runChecks(run, att, d, label, source),
    single(
      check(
        guardRaw !== null && printed !== null && printed.equals(guardRaw),
        `${label}: its attested output prints the guard's accepted key (${oneNode(source)})`,
        `${label}: its attested output prints ${run.sealed ? oneLine(run.sealed.public_key, 60) : 'no key'}, not the guard's accepted key (${oneNode(source)})`,
      ),
    ),
  ];
}

function aiEvidence(v: VerdictFields | null): string {
  if (v === null) return 'AI evidence: unknown, the verdict did not decode';
  if (v.model_id === '') return `AI evidence: none. This verdict carries no AI answer (AI ${v.ai_status}), so there is nothing for https://cloud.near.ai/verify to check`;
  return `AI evidence: AI ${v.ai_status}, model ${oneLine(v.model_id, 80)}; NEAR AI's own verifier: https://cloud.near.ai/verify?model=${encodeURIComponent(v.model_id)}`;
}

/** `fail` when any check failed, whatever else could not be read; `unread` when none failed but at
 *  least one could not be read; `pass` otherwise, warnings included. */
export function outcome(r: VerifyReport): 'pass' | 'fail' | 'unread' {
  if (r.checks.some((c) => !c.ok && !c.unread)) return 'fail';
  return r.checks.some((c) => c.unread) ? 'unread' : 'pass';
}

/** The report as the terminal shows it, every line through `terminalText`. The result line counts
 *  the passing checks that rest on one node or on OutLayer's API, so a quote of it carries that too. */
export function render(r: VerifyReport): string {
  const failed = r.checks.filter((c) => !c.ok && !c.unread).length;
  const unreadChecks = r.checks.filter((c) => c.unread);
  const warned = r.checks.filter((c) => c.ok && c.warning).length;
  const thin = r.checks.filter((c) => c.ok && c.oneSource).length;
  const backing = thin ? `; ${thin} of the passes rest on one node or on OutLayer's API alone, as their lines say` : '';
  const result =
    failed > 0
      ? `result: ${failed} of ${r.checks.length} checks fail${unreadChecks.length ? `, and ${unreadChecks.length} could not be read` : ''}`
      : unreadChecks.length > 0
        ? `result: no check fails, but ${unreadChecks.length} of ${r.checks.length} could not be read${backing}`
        : warned > 0
          ? `result: no check fails; ${r.checks.length - warned} pass and ${warned} ${warned === 1 ? 'warns' : 'warn'}${backing}`
          : `result: all ${r.checks.length} checks pass${backing}`;
  const advice = !unreadChecks.length
    ? []
    : unreadChecks.some((c) => c.unread === 'archive')
      ? ['The archive nodes are rate-limiting or not answering: wait a minute and run again, or set KAAP_ARCHIVAL_RPC to the https address of an archival node you can use.']
      : unreadChecks.some((c) => c.unread === 'outlayer')
        ? ['OutLayer\'s API is not answering: wait a minute and run again.']
        : ['The two RPC providers are rate-limiting, not answering, or not answering alike: wait a minute and run again.'];
  return terminalText([
    r.title,
    ...r.facts,
    '',
    'checks',
    ...r.checks.map((c) => `  ${c.unread ? 'unread' : !c.ok ? 'fail' : c.warning ? 'warn' : 'pass'}  ${c.text}`),
    '',
    ...(r.notChecked.length ? ['not checked here', ...r.notChecked.map((t) => `  ${t}`), ''] : []),
    ...r.notes,
    '',
    result,
    ...advice,
  ]);
}
