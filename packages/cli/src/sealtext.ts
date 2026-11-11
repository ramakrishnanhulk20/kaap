// `kaap seal-text`: hands Kaap's worker the text behind a hash-only proposal so that only Kaap's
// sealed program can read it, and opens the explanation it sends back (C12, C26). Before anything
// leaves this machine, three checks stop it: the key the text is sealed to must carry a signature
// by the key the guard accepts on chain, read from two providers at one final block (C22); and the
// text must hash, by kaap-core's own NEP-413 or NEP-461 hash, to the payload the proposal asks to
// sign, so a wrong text never costs a paid run; nor does one too long for the run's input, counted
// as the worker counts it. The text and the reply key's secret stay in memory:
// they are never written to a file, printed, or sent; only ciphertext and the reply key's public
// half go to the worker.
//
// What this does not cover: whether the worker runs the sealed program at all (its answer is
// checked for shape, and the explanation must open with this request's reply key, but the verdict
// itself is the worker's word until `kaap verify` checks it), and who else holds the same text.

import { readFileSync, statSync } from 'node:fs';

import { z } from 'zod';

import { MAX_EXPIRES_IN_MS, MAX_RUN_INPUT_BYTES, MAX_TEXT_ANSWER_BYTES, MAX_TEXT_FILE_BYTES, TEXT_ANSWER_TIMEOUT_MS } from './caps.js';
import { Held, type Reader } from './chain.js';
import { type Deps, NoProposal, readers } from './check.js';
import { type Core, CoreError, type ProposalRead } from './core.js';
import { loadDeployment, loadTextKey, type TextKey } from './deployment.js';
import { type HttpResponse, NetError, type Transport } from './net.js';
import { type Block, type Network, RpcError } from './rpc.js';
import { explanationContext, type Fresh, openSealed, SEALED_PREFIX, SealingError, sealTo, textContext, textKeySigned } from './sealing.js';
import { WorkerRefused } from './subscribe.js';
import { oneLine, shown, utc } from './text.js';
import { edKeyBytes } from './verdict.js';

/** Refused on this machine, before or after the worker answered. `code` is the exit code. */
export class SealRefused extends Error {
  readonly code: number;
  constructor(message: string, code = 1) {
    super(message);
    this.name = 'SealRefused';
    this.code = code;
  }
}

export interface SealTextRequest {
  dao: string;
  id: number;
  file: string;
  network: Network;
  worker: string;
}

const NOTHING_SENT = 'Nothing was sent.';

/** The guard's live `accepted_key`, and the recorded text key checked against it: the record must
 *  name that key as its signer, and the signature must hold under it. Returns the accepted key. */
async function checkTextKey(reader: Reader, guard: string, textKey: TextKey, head: Block): Promise<string> {
  const accepted = await reader.sameJson("the guard's accepted key", guard, 'accepted_key', {}, head);
  if (typeof accepted !== 'string') throw new Held("the guard's accepted key is not a key");
  const raw = edKeyBytes(accepted);
  if (raw === null) throw new SealRefused(`the guard's accepted key ${oneLine(accepted, 60)} is not an ed25519 key, so the text key cannot be checked. ${NOTHING_SENT}`);
  const named = edKeyBytes(textKey.publicKey);
  if (named === null || !named.equals(raw)) {
    throw new SealRefused(`the recorded text key names ${textKey.publicKey} as its signer, but the guard accepts ${accepted}: it is not the current sealed program's key. ${NOTHING_SENT}`);
  }
  if (!textKeySigned(raw, textKey.key, textKey.signature)) {
    throw new SealRefused(`the recorded text key's signature is not valid for the guard's accepted key ${accepted} (checked here with ed25519), so it may not be Kaap's sealed program's key. ${NOTHING_SENT}`);
  }
  return accepted;
}

/** packages/sealed/src/texts.rs `RawText`, which refuses any field it does not know. */
const textSchema = z.strictObject({
  message: z.string(),
  nonce: z.string(),
  recipient: z.string(),
  standard: z.enum(['nep413', 'nep461']),
  quotes: z.array(z.string()).optional(),
});

interface Text {
  /** The bytes that are sealed: the fields as read, written back as one JSON object, so the
   *  program reads the very values hashed here even when the file repeats a field. */
  plain: Buffer;
  standard: 'nep413' | 'nep461';
  /** kaap-core's hash of it, lower-case hex. */
  hash: string;
}

/** Reads the member's text. No refusal quotes any of it. */
function readText(core: Core, file: string): Text {
  const name = oneLine(file, 200);
  let bytes: Buffer;
  try {
    if (statSync(file).size > MAX_TEXT_FILE_BYTES) throw new SealRefused(`${name} is larger than ${MAX_TEXT_FILE_BYTES / 1024} KiB, more than a sealed run can take. ${NOTHING_SENT}`);
    bytes = readFileSync(file);
  } catch (e) {
    if (e instanceof SealRefused) throw e;
    throw new SealRefused(`could not read ${name}. ${NOTHING_SENT}`);
  }
  if (bytes.length > MAX_TEXT_FILE_BYTES) throw new SealRefused(`${name} is larger than ${MAX_TEXT_FILE_BYTES / 1024} KiB, more than a sealed run can take. ${NOTHING_SENT}`);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    value = undefined;
  }
  const parsed = textSchema.safeParse(value);
  if (!parsed.success) {
    throw new SealRefused(`${name} is not one text: a JSON object with exactly message, nonce, recipient and standard ("nep413" or "nep461"), and optionally quotes, a list of strings. ${NOTHING_SENT}`);
  }
  const t = parsed.data;
  // A "\ud800" escape reads into JavaScript as half a character, which the sealed job's JSON reader
  // refuses inside a paid run and the wasm hash would read as another character.
  if (![t.message, t.nonce, t.recipient, ...(t.quotes ?? [])].every((s) => s.isWellFormed())) {
    throw new SealRefused(`${name} holds an escaped half of a character (a lone surrogate), which Kaap's sealed program cannot read. ${NOTHING_SENT}`);
  }
  const plain = Buffer.from(JSON.stringify({ message: t.message, nonce: t.nonce, recipient: t.recipient, standard: t.standard, ...(t.quotes === undefined ? {} : { quotes: t.quotes }) }), 'utf8');
  return { plain, standard: t.standard, hash: textHash(core, t) };
}

/** The NEP-413 hash also reads the nonce, with the base64 engine and the 32-byte rule of the sealed
 *  job's `RawText`, which needs one for either standard; so it runs for a NEP-461 text too. */
function textHash(core: Core, t: z.output<typeof textSchema>): string {
  let nep413: string;
  try {
    nep413 = core.nep413Hash(t.message, t.nonce, t.recipient);
  } catch (e) {
    if (!(e instanceof CoreError)) throw e;
    throw new SealRefused(`the text's nonce is not 32 bytes of base64, which Kaap's sealed program needs for either standard. ${NOTHING_SENT}`);
  }
  if (t.standard === 'nep413') return nep413;
  try {
    return core.nep461Hash(t.message);
  } catch (e) {
    if (!(e instanceof CoreError)) throw e;
    throw new SealRefused(`the text says nep461, but its message is not base64, the form a NEP-461 delegate action takes. ${NOTHING_SENT}`);
  }
}

async function readProposal(reader: Reader, request: SealTextRequest, head: Block): Promise<ProposalRead> {
  try {
    return (await reader.proposal(request.dao, request.id, head)).read;
  } catch (e) {
    if (e instanceof RpcError && e.failure === 'no_proposal') throw new NoProposal(`proposal ${request.id} of ${request.dao} is not stored: it was removed, or never filed. ${NOTHING_SENT}`);
    throw e;
  }
}

/** Every payload the proposal asks the MPC network to sign, as kaap-core reads its `sign` calls:
 *  the same reader the sealed job matches a text against. */
function signPayloads(core: Core, request: SealTextRequest, read: ProposalRead, head: Block): string[] {
  const { analysis } = core.analyze({
    network: request.network,
    dao: request.dao,
    proposal_id: request.id,
    description: read.description,
    kind_json: read.kind_json,
    policy_before_json: null,
    history: null,
    prices: { usd_by_token: {} },
    dao_version: null,
    block_timestamp_ns: head.timestampNs,
  });
  return analysis.effects.flatMap((e) => (e.type === 'sign_request' && typeof e['payload_hash'] === 'string' ? [e['payload_hash']] : []));
}

/** The text must hash to one of the proposal's payloads, both sides lower-case hex from kaap-core. */
function checkTextHash(text: Text, payloads: string[], request: SealTextRequest): void {
  if (!payloads.length) {
    throw new SealRefused(`proposal ${request.id} of ${request.dao} asks for no signature, so no text can be behind it: Kaap takes texts only for sign requests. ${NOTHING_SENT}`);
  }
  if (!payloads.includes(text.hash)) {
    throw new SealRefused(`the text hashes to ${text.hash} (${text.standard}), but proposal ${request.id} asks to sign ${payloads.join(' and ')}: it is not this proposal's text. ${NOTHING_SENT} No run was paid for.`);
  }
}

const severity = z.enum(['low', 'medium', 'high', 'critical', 'unknown']);

/** WO-06d's 200 answer to POST /texts, and nothing else. */
const judgedSchema = z.strictObject({
  status: z.literal('judged'),
  run_tx: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/),
  risk: severity,
  floor: severity,
  findings: z.array(z.string().regex(/^[A-Z_]{3,40}$/)).max(32),
  ai_status: z.enum(['verified', 'unverified', 'unavailable']),
  /** Null when the verdict carries no AI answer. */
  model_id: z.string().min(1).max(200).nullable(),
  explanation: z.string().startsWith(SEALED_PREFIX),
  veto: z.enum(['started', 'not_needed']),
});
type Judged = z.output<typeof judgedSchema>;

const refusalSchema = z.looseObject({ error: z.string(), reason: z.string().optional() });

/** A reason the worker sent is shown only when it is short printable text. */
const PRINTABLE = /^[\x20-\x7e]{1,120}$/;

export interface SealTextReport {
  request: SealTextRequest;
  block: Block;
  providers: string[];
  guardKey: string;
  textKey: string;
  textKeyRun: string;
  standard: Text['standard'];
  payload: string;
  ciphertextBytes: number;
  verdict: { risk: string; floor: string; findings: string[]; aiStatus: string; modelId: string | null; veto: Judged['veto']; runTx: string };
  explanation: string;
}

/** Runs the whole command: the three checks, the sealing, the one request, the opening. */
export async function sealText(deps: Deps & { repoRoot: string; fresh: Fresh }, request: SealTextRequest): Promise<SealTextReport> {
  const { core } = deps;
  if (!core.isAccountId(request.dao)) throw new SealRefused(`not a valid NEAR account id. ${NOTHING_SENT}`, 3);
  const d = loadDeployment(deps.repoRoot, request.network);
  const textKey = loadTextKey(deps.repoRoot, request.network);
  const reader = readers(deps, request.network);
  const head = await reader.head();
  const guardKey = await checkTextKey(reader, d.guard, textKey, head);
  const text = readText(core, request.file);
  const read = await readProposal(reader, request, head);
  checkTextHash(text, signPayloads(core, request, read, head), request);

  const reply = deps.fresh.pair();
  let sealed: Buffer;
  try {
    sealed = sealTo(textKey.key, text.plain, textContext(request.network, request.dao, request.id, reply.publicKey), deps.fresh);
  } catch (e) {
    if (!(e instanceof SealingError)) throw e;
    throw new SealRefused(`the recorded text key cannot be sealed to (${e.message}). ${NOTHING_SENT}`);
  }
  const ciphertext = sealed.toString('base64');
  const inputBytes = runInputBytes(request, d.guard, ciphertext, reply.publicKey);
  if (inputBytes > MAX_RUN_INPUT_BYTES) {
    throw new SealRefused(`the text is too long for Kaap's sealed program: with it, the sealed run's input would be ${inputBytes} bytes, and the program reads at most ${MAX_RUN_INPUT_BYTES} (about 24 KiB of text). ${NOTHING_SENT}`);
  }
  const answer = await ask(deps.transport, request, ciphertext, reply.publicKey);
  const blob = Buffer.from(answer.explanation.slice(SEALED_PREFIX.length), 'base64');
  const opened = openSealed(reply.privateKey, blob, explanationContext(request.network, request.dao, request.id, reply.publicKey));
  let explanation: string | null = null;
  try {
    explanation = opened === null ? null : new TextDecoder('utf-8', { fatal: true }).decode(opened);
  } catch {
    explanation = null;
  }
  if (explanation === null) {
    throw new SealRefused("the explanation in the worker's answer does not open with the reply key made for this request, so none of the answer is shown.");
  }
  return {
    request,
    block: head,
    providers: reader.providers,
    guardKey,
    textKey: textKey.key.toString('hex'),
    textKeyRun: textKey.runTx,
    standard: text.standard,
    payload: text.hash,
    ciphertextBytes: sealed.length,
    verdict: { risk: answer.risk, floor: answer.floor, findings: answer.findings, aiStatus: answer.ai_status, modelId: answer.model_id, veto: answer.veto, runTx: answer.run_tx },
    explanation,
  };
}

/** The sealed run's input as the worker writes it (packages/worker/src/judge.ts `input`), counted
 *  with the longest verdict life the worker allows, so never shorter than the worker counts it. */
function runInputBytes(request: SealTextRequest, guard: string, ciphertext: string, replyKey: Buffer): number {
  const input = { v: 1, network: request.network, guard, dao: request.dao, proposal_id: request.id, expires_in_ms: MAX_EXPIRES_IN_MS, text_ciphertext: ciphertext, reply_key: replyKey.toString('hex') };
  return Buffer.byteLength(JSON.stringify(input));
}

/** The one request. It is never sent twice: a second would be a second paid run. */
async function ask(transport: Transport, request: SealTextRequest, ciphertext: string, replyKey: Buffer): Promise<Judged> {
  const body = JSON.stringify({ dao: request.dao, proposal_id: request.id, text_ciphertext: ciphertext, reply_key: replyKey.toString('hex') });
  let response: HttpResponse;
  try {
    response = await transport({ url: `${request.worker}/texts`, method: 'POST', body, timeoutMs: TEXT_ANSWER_TIMEOUT_MS, maxBytes: MAX_TEXT_ANSWER_BYTES });
  } catch (e) {
    if (e instanceof NetError && e.failure === 'timeout') {
      throw new WorkerRefused(`the worker did not answer within ${TEXT_ANSWER_TIMEOUT_MS / 60_000} minutes. Its sealed run may still finish, and the guard may still vote; the text is not sent again from here.`);
    }
    throw new WorkerRefused(e instanceof NetError ? `the worker could not be asked: ${e.message}` : 'the worker could not be asked');
  }
  if (response.status !== 200) throw refusal(response, request);
  let parsed;
  try {
    parsed = judgedSchema.safeParse(JSON.parse(response.text));
  } catch {
    parsed = null;
  }
  if (!parsed?.success) throw new WorkerRefused('the worker answered 200, but not with a judged text, so nothing it said is shown.');
  return parsed.data;
}

/** One plain sentence for every answer in WO-06d, matched on the status and its fixed word together. */
function refusal(response: HttpResponse, request: SealTextRequest): WorkerRefused {
  let word: string | null = null;
  let reason: string | null = null;
  try {
    const parsed = refusalSchema.safeParse(JSON.parse(response.text));
    if (parsed.success) {
      word = parsed.data.error;
      reason = parsed.data.reason ?? null;
    }
  } catch {
    word = null;
  }
  const at = `the worker at ${request.worker}`;
  const proposal = `proposal ${request.id} of ${request.dao}`;
  switch (`${response.status} ${word}`) {
    case '400 bad_request':
      return new WorkerRefused(`${at} refused the request as malformed (bad_request): this CLI and the worker disagree on its shape. Nothing was judged.`);
    case '404 dao_not_watched':
      return new WorkerRefused(`${at} does not watch ${request.dao}: it takes texts only for the DAOs it guards. Nothing was judged.`, 3);
    case '404 not_found':
      return new WorkerRefused(`${at} has no /texts route: it runs an older worker than this command needs. Nothing was judged.`);
    case '409 proposal_not_open':
      return new WorkerRefused(`${at} refused: ${proposal} is no longer open for votes, so there is nothing left to judge or veto.`);
    case '429 too_many_requests': {
      const minutes = response.retryAfterMs === undefined ? null : Math.ceil(response.retryAfterMs / 60_000);
      const wait = minutes === null ? '' : `, again in about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
      return new WorkerRefused(`${at} refused: too many texts from this address in the last hour${wait}. Nothing was judged.`);
    }
    case '503 over_budget':
      return new WorkerRefused(`${at} refused: its spending caps allow no more sealed runs right now, so nothing was judged. Try again later.`);
    case '502 run_failed': {
      if (reason === 'text_does_not_match') {
        return new WorkerRefused(`the sealed program refused the text for ${proposal}: it does not hash to the payload the proposal asks to sign, so Kaap refused it and nothing was vetoed.`);
      }
      const why = reason !== null && PRINTABLE.test(reason) ? ` (${oneLine(reason, 120)})` : '';
      return new WorkerRefused(`the sealed run for ${proposal} gave no verdict${why}, so there is nothing to show and nothing was vetoed.`);
    }
  }
  const shownWord = word !== null && /^[a-z_]{1,40}$/.test(word) ? ` (${word})` : '';
  return new WorkerRefused(`${at} answered HTTP ${response.status}${shownWord}, an answer this command does not know. Nothing is known about the text's verdict.`);
}

const EXPLORER: Readonly<Record<Network, string>> = { mainnet: 'https://nearblocks.io/txns/', testnet: 'https://testnet.nearblocks.io/txns/' };

export function render(r: SealTextReport): string {
  const v = r.verdict;
  return [
    `kaap seal-text ${oneLine(r.request.dao, 80)} #${r.request.id} on ${r.request.network}`,
    `read at final block ${r.block.height} (${utc(r.block.timestampNs)}): the guard's key and the proposal, agreed by ${r.providers.join(' and ')}`,
    `text key: ${r.textKey} from run ${r.textKeyRun}, signed by the guard's accepted key ${r.guardKey} (checked here with ed25519)`,
    `text: ${r.standard === 'nep413' ? 'NEP-413' : 'NEP-461'}, hashes to ${r.payload}, the payload proposal ${r.request.id} asks to sign`,
    `sent to ${r.request.worker}/texts: ${r.ciphertextBytes} bytes of ciphertext only Kaap's sealed program can open, and a reply key made for this request`,
    '',
    'verdict',
    `  risk: ${v.risk}`,
    `  floor: ${v.floor}`,
    `  findings: ${v.findings.join(', ') || 'none'}`,
    `  AI: ${v.aiStatus}${v.modelId === null ? ', no model answered' : `, model ${oneLine(v.modelId, 120)}`}`,
    `  veto: ${v.veto === 'started' ? "started (the guard's vote to reject lands on chain on its own, after this answer)" : 'not needed'}`,
    `  sealed run: ${EXPLORER[r.request.network]}${v.runTx}`,
    '',
    'explanation, opened here with the reply key (the worker only ever held ciphertext)',
    ...shown(r.explanation).split('\n').map((line) => `  ${line}`),
    '',
    "The verdict is the worker's report of its sealed run. The AI part of a verdict can differ between runs.",
  ].join('\n');
}
