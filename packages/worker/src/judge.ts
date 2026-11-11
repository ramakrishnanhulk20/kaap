// Asks Kaap's sealed program on OutLayer to judge one proposal and turns the answer into a
// verdict the worker may act on.
//
// A run with no answer is a normal outcome, not an exception. When OutLayer cannot run the job
// (testnet FastFS was down for hours on 23 Oct) the transaction hangs until NEAR's yield times
// out, about 200 blocks, and returns null. The worker treats null, or nothing final within its
// window, as a failed run, raises "guard degraded" (C18) and tries once more, under a new
// idempotency key, because the first run is finished. Each attempt keeps its own key, so a crash
// and restart re-sends an attempt's signed bytes rather than paying for a second run. An attempt
// a busy shard never took gives its reservation back under the daily cap when it is finished.
//
// A run may carry a member's sealed text (POST /texts): ciphertext only the sealed program can
// open, and the reply key its explanation is sealed to. Such a run has its own idempotency keys and
// its own daily count, which leaves the NEAR a proposal check needs untouched (C29), the same
// attempts and window, and its signed bytes are kept in memory only, so the store never holds the
// ciphertext (C26). Not covered: a crash mid-run, after which nothing re-sends that
// run; the member sends the text again.

import { createHash, randomBytes } from 'node:crypto';

import { PublicKey } from 'near-api-js';
import { z } from 'zod';

import type { Bridge, DecodedVerdict } from './bridge.ts';
import type { CapGuard } from './caps.ts';
import { ALL, type Health } from './health.ts';
import type { Logger } from './log.ts';
import { MIN_GAS_PRICE, TGAS, worstCase } from './near.ts';
import { events, logs, refusal, successValue, type TxOutcome } from './outcome.ts';
import { TEXT_RUN_PREFIX, type RunState, type Store } from './store.ts';
import type { SubmitResult, Submitter } from './submit.ts';

export const RUN_GAS = 300n * TGAS;
/** What every run attaches (packages/sealed/RUNS.md); OutLayer keeps its charge and refunds the rest. */
export const RUN_DEPOSIT = 20n * 10n ** 21n;
/** The attempts one generation of a proposal gets: the first run and one retry. */
export const RUN_ATTEMPTS = 2;

// All three limits written out on every run: an empty resource_limits object is never picked up
// (OutLayer issue #31). The values scripts/run-sealed-testnet.sh and scripts/prove.mjs send.
const RESOURCE_LIMITS = { max_instructions: 10_000_000_000, max_memory_mb: 128, max_execution_seconds: 60 };

const b64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/);
const output = z.discriminatedUnion('status', [
  z.strictObject({ v: z.literal(1), status: z.literal('ok'), verdict: b64.max(1_400), signature: b64.length(88), public_key: z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/), explanation: z.string().max(900) }),
  z.strictObject({ v: z.literal(1), status: z.enum(['held', 'refused', 'failed']), reason: z.string().max(200) }),
]);

/** The most input the sealed program reads (`MAX_INPUT_BYTES`, packages/sealed/src/input.rs): what
 *  OutLayer stores for a request without charging for it. Anything longer it refuses. */
export const MAX_RUN_INPUT_BYTES = 32_768;

/** Gas NEAR charges per byte of a call's method name and arguments sent to another account:
 *  nearcore's `action_function_call_per_byte`, its send and execution parts (2,235,934 each).
 *  A plain input is about 200 bytes, which the caps leave out; a sealed text can bring 32 KiB,
 *  about 0.000015 NEAR at the minimum gas price, so a text run reserves it too. */
const ARG_BYTE_GAS = 2n * 2_235_934n;

/** A member's text as POST /texts hands it on: ciphertext only the sealed program can open, and
 *  the X25519 public key the explanation is sealed to. */
export interface SealedText {
  /** Canonical base64. */
  ciphertext: string;
  /** 64 lower-case hex characters. */
  replyKey: string;
}

/** A printed explanation sealed to a member's reply key (packages/sealed/src/texts.rs). */
const SEALED_EXPLANATION = /^sealed:[A-Za-z0-9+/]+={0,2}$/;

/** The start of the explanation the sealed job signs when no NEAR AI key reached the run
 *  (packages/sealed/src/ai.rs, `Refusal::AiKeyMissing`). OutLayer runs a project whose secret row
 *  is missing, or locked to another build, without any error, so this is the only sign of it. */
export const AI_KEY_MISSING = 'AI unavailable (ai_key_missing)';

/** The OutLayer secret row a run names: OutLayer's `SecretsReference`. */
export interface SecretsRef {
  profile: string;
  account_id: string;
}

/** The secret row runs name, from the settings, or null when none is set. Says so once, at boot,
 *  when there is none, because every verdict then comes back without the AI. */
export function aiSecrets(settings: { KAAP_AI_SECRETS_ACCOUNT?: string | undefined; KAAP_AI_SECRETS_PROFILE: string }, log: Logger): SecretsRef | null {
  if (!settings.KAAP_AI_SECRETS_ACCOUNT) {
    log.warn('ai_off', { reason: 'KAAP_AI_SECRETS_ACCOUNT is not set, so sealed runs carry no NEAR AI key and verdicts have no AI second opinion' });
    return null;
  }
  return { profile: settings.KAAP_AI_SECRETS_PROFILE, account_id: settings.KAAP_AI_SECRETS_ACCOUNT };
}

export interface JudgeSettings {
  network: string;
  guard: string;
  outlayer: string;
  project: string;
  /** Named in every run when set, so OutLayer hands the sealed job its NEAR AI key. */
  secretsRef?: SecretsRef | null;
  verdictTtlMs: number;
  windowBlocks: number;
}

export type Judgement =
  | { kind: 'verdict'; verdict: DecodedVerdict; verdictB64: string; signatureB64: string; runTx: string; explanation: string }
  | { kind: 'no_verdict'; attempts: number; last: RunState; detail: string; tx: string | null }
  | { kind: 'capped'; detail: string };

type Attempt =
  /** `aiKeyMissing` is null when the explanation is sealed to a member, so the worker cannot read it. */
  | { state: 'answered'; verdict: DecodedVerdict; verdictB64: string; signatureB64: string; tx: string; explanation: string; aiKeyMissing: boolean | null }
  | { state: Exclude<RunState, 'answered' | 'pending'>; detail: string; tx: string | null };

/** OutLayer's charge for a run: its `execution_completed` event, or for an unanswered run the
 *  base fee it logs before refunding the rest. */
export function outlayerCharge(o: TxOutcome): bigint {
  const completed = events(o).find((e) => e.event === 'execution_completed')?.data[0] as { payment_charged?: unknown } | undefined;
  if (typeof completed?.payment_charged === 'string' && /^\d+$/.test(completed.payment_charged)) return BigInt(completed.payment_charged);
  const charged = logs(o).map((l) => /yNEAR charged: "(\d+)"/.exec(l)?.[1]).find((x) => x !== undefined);
  return charged ? BigInt(charged) : 0n;
}

export class Judge {
  readonly #store: Store;
  readonly #submitter: Submitter;
  readonly #caps: CapGuard;
  readonly #bridge: Bridge;
  readonly #health: Health;
  readonly #log: Logger;
  readonly #s: JudgeSettings;
  readonly #acceptedKey: () => string | null;
  readonly #now: () => number;

  constructor(deps: { store: Store; submitter: Submitter; caps: CapGuard; bridge: Bridge; health: Health; log: Logger; acceptedKey: () => string | null; now: () => number }, settings: JudgeSettings) {
    this.#store = deps.store;
    this.#submitter = deps.submitter;
    this.#caps = deps.caps;
    this.#bridge = deps.bridge;
    this.#health = deps.health;
    this.#log = deps.log;
    this.#acceptedKey = deps.acceptedKey;
    this.#now = deps.now;
    this.#s = settings;
  }

  /** The exact input WO-02b's job accepts and nothing else, with a member's sealed text when one
   *  is given. */
  input(dao: string, id: number, text?: SealedText): string {
    const base = { v: 1, network: this.#s.network, guard: this.#s.guard, dao, proposal_id: id, expires_in_ms: this.#s.verdictTtlMs };
    return JSON.stringify(text ? { ...base, text_ciphertext: text.ciphertext, reply_key: text.replyKey } : base);
  }

  /** Whether the input for this text stays inside what the sealed program reads, so a text it
   *  would refuse unread is never paid for. */
  fits(dao: string, id: number, text: SealedText): boolean {
    return Buffer.byteLength(this.input(dao, id, text)) <= MAX_RUN_INPUT_BYTES;
  }

  #args(dao: string, id: number, text: SealedText | undefined) {
    return {
      source: { Project: { project_id: this.#s.project, version_key: null } },
      input_data: this.input(dao, id, text),
      response_format: 'Json',
      resource_limits: RESOURCE_LIMITS,
      ...(this.#s.secretsRef ? { secrets_ref: this.#s.secretsRef } : {}),
    };
  }

  /** Runs the sealed job for (`dao`, `id`) at `generation`, retrying once without an answer. With
   *  `text`, the run carries a member's sealed text, and its answer counts only with an explanation
   *  sealed to them that the signed verdict covers. */
  async judge(dao: string, id: number, generation: number, text?: SealedText): Promise<Judgement> {
    let last: Attempt | null = null;
    const args = this.#args(dao, id, text);
    // A sealed text's bytes cost gas of their own, so the caps reserve them as well.
    const reserved = worstCase(RUN_GAS, RUN_DEPOSIT) + (text ? BigInt(Buffer.byteLength('request_execution') + Buffer.byteLength(JSON.stringify(args))) * ARG_BYTE_GAS * MIN_GAS_PRICE : 0n);
    // One text request is one judgement of its own, never resumed from an earlier one.
    const textRun = text ? randomBytes(8).toString('hex') : null;
    for (let attempt = 1; attempt <= RUN_ATTEMPTS; attempt++) {
      const key = textRun ? `${TEXT_RUN_PREFIX}${this.#s.network}:${dao}:${id}:${textRun}:a${attempt}` : `run:${this.#s.network}:${dao}:${id}:g${generation}:a${attempt}`;
      const seen = this.#store.run(key);
      if (!seen) {
        const capped = text ? this.#caps.textRun(dao, reserved, key) : this.#caps.run(dao, reserved, key);
        if (capped) {
          const detail = JSON.stringify(capped, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
          this.#log.warn('refused', { what: 'sealed_run', dao, proposal_id: id, reason: 'cap', detail, sealed_text: text !== undefined });
          // A text's own caps leave the DAO's proposal checks running, and anyone may send a text,
          // so a refused one says nothing about the DAO.
          if (!text) this.#health.raise('cap_reached', dao, { cap: capped.cap });
          return { kind: 'capped', detail };
        }
      } else if (seen.state !== 'pending' && seen.state !== 'answered') {
        last = { state: seen.state, detail: seen.detail ?? '', tx: null };
        if (seen.state === 'refused') break;
        continue;
      }

      let res: SubmitResult;
      try {
        if (!seen) this.#store.addRun({ idempotency_key: key, network: this.#s.network, dao, proposal_id: id, generation, attempt });
        res = await this.#submitter.submit({
          key,
          kind: 'run',
          dao,
          proposalId: id,
          receiver: this.#s.outlayer,
          method: 'request_execution',
          args,
          gas: RUN_GAS,
          deposit: RUN_DEPOSIT,
          reserved,
          windowBlocks: this.#s.windowBlocks,
          kept: outlayerCharge,
          ...(text ? { memoryOnly: true } : {}),
        });
      } finally {
        this.#caps.settle(key);
      }
      const result = res.kind === 'final' ? this.read(dao, id, res.outcome, res.hash, text !== undefined) : res.kind === 'no_outcome' ? ({ state: 'no_answer', detail: `nothing final within ${this.#s.windowBlocks} blocks`, tx: res.hash } as const) : ({ state: 'failed', detail: `not sent: ${res.detail}`, tx: null } as const);
      last = result;
      if (result.state === 'answered') {
        this.#store.finishRun(key, 'answered', null);
        this.#log.info('verdict', { dao, proposal_id: id, generation, attempt, risk: result.verdict.risk, floor: result.verdict.floor, findings: result.verdict.findings, ai_status: result.verdict.ai_status, vetoable: result.verdict.vetoable, read_at_block: result.verdict.block_height, verdict_hash: result.verdict.verdict_hash, run_tx: result.tx, sealed_text: text !== undefined });
        // A verdict that verified under the guard's current key shows the sealed judge works and
        // that the guard and the sealed job agree on the key again.
        this.#health.clear('run_no_answer', dao);
        this.#health.clear('run_without_verdict', dao);
        this.#health.clear('verdict_rejected', dao);
        this.#health.clear('accepted_key_changed', ALL);
        // The key is one setting for every DAO: missing in one run means missing for all, and a
        // run it reached means it is back. A sealed explanation says neither.
        if (result.aiKeyMissing === true) this.#health.raise('ai_key_missing', ALL, { dao, proposal_id: id });
        else if (result.aiKeyMissing === false) this.#health.clear('ai_key_missing', ALL);
        return { kind: 'verdict', verdict: result.verdict, verdictB64: result.verdictB64, signatureB64: result.signatureB64, runTx: result.tx, explanation: result.explanation };
      }
      this.#store.finishRun(key, result.state, result.detail);
      // A finished attempt is never sent again, so bytes no node took can never land, and what
      // they reserved goes back under the NEAR cap before the next attempt reserves its own. The
      // run is marked finished first: a crash in between leaves the reservation counted, which
      // errs on the side of spending less.
      if (res.kind === 'no_outcome' && !res.taken) this.#submitter.release(key, 'never taken: the receiver shard stayed busy, and this run attempt is finished');
      this.#log.warn('run_without_verdict', { dao, proposal_id: id, generation, attempt, state: result.state, detail: result.detail, run_tx: result.tx, retry: attempt < RUN_ATTEMPTS && result.state !== 'refused' });
      if (result.state === 'no_answer') this.#health.raise('run_no_answer', dao, { proposal_id: id, attempt });
      // A refused input is refused again, so it is not worth a second payment.
      if (result.state === 'refused') break;
    }
    const detail = last && 'detail' in last ? last.detail : 'no attempt was made';
    const state = last && last.state !== 'answered' ? last.state : 'failed';
    // A text the sealed program refused is the sender's fault, not a sign the judge is down, and
    // anyone may send one; raising it would let a stranger mark any DAO degraded.
    if (!(text && state === 'refused')) this.#health.raise('run_without_verdict', dao, { proposal_id: id, last: state });
    return { kind: 'no_verdict', attempts: RUN_ATTEMPTS, last: state, detail, tx: last?.tx ?? null };
  }

  /** Reads one final request_execution outcome. Every field of the job's output is checked like
   *  an input (standard 3): the shape, the key that signed it, the signature, and that the
   *  verdict names this guard, network, DAO and proposal and is not already expired. For a run
   *  with a sealed text, the explanation the member gets must also be sealed and be the one the
   *  signed verdict's hash covers. */
  read(dao: string, id: number, o: TxOutcome, tx: string, sealedText = false): Attempt {
    const why = refusal(o);
    if (why) return { state: 'failed', detail: `request_execution failed: ${why}`, tx };
    const value = successValue(o);
    if (value === undefined) return { state: 'failed', detail: 'request_execution returned nothing', tx };
    let parsed: z.output<typeof output>;
    try {
      const text = Buffer.from(value, 'base64').toString('utf8');
      const json: unknown = JSON.parse(text);
      if (json === null) return { state: 'no_answer', detail: 'the yield timed out: OutLayer never answered', tx };
      parsed = output.parse(json);
    } catch {
      return { state: 'failed', detail: 'the job printed something that is not its output shape', tx };
    }
    if (parsed.status !== 'ok') return { state: parsed.status === 'held' ? 'held' : parsed.status === 'refused' ? 'refused' : 'failed', detail: parsed.reason.replace(/[^\x20-\x7e]/g, '?'), tx };

    const reject = (detail: string): Attempt => {
      this.#health.raise('verdict_rejected', dao, { proposal_id: id, detail });
      return { state: 'failed', detail, tx };
    };
    const accepted = this.#acceptedKey();
    if (!accepted) return reject('the guard key is not known yet');
    if (parsed.public_key !== accepted) return reject('the job signed with a key the guard does not accept');
    const borsh = Buffer.from(parsed.verdict, 'base64');
    let verdict: DecodedVerdict;
    try {
      verdict = this.#bridge.decodeVerdict(borsh);
    } catch {
      return reject('the verdict does not decode');
    }
    const signature = Buffer.from(parsed.signature, 'base64');
    if (signature.length !== 64 || !PublicKey.fromString(accepted).verify(Buffer.from(verdict.signed_b64, 'base64'), signature)) return reject('the signature does not verify under the accepted key');
    if (verdict.guard !== this.#s.guard || verdict.network !== this.#s.network || verdict.dao !== dao || verdict.proposal_id !== id) return reject('the verdict names another guard, network, DAO or proposal');
    if (verdict.expires_at_ms <= this.#now()) return reject('the verdict is already expired');
    // The explanation counts only when it is the text the signed verdict's hash covers.
    const explained = createHash('sha256').update(parsed.explanation, 'utf8').digest('hex') === verdict.explanation_hash;
    if (sealedText) {
      if (!explained || !SEALED_EXPLANATION.test(parsed.explanation)) return reject('the explanation is not sealed to the member, or not the one the verdict covers');
      return { state: 'answered', verdict, verdictB64: parsed.verdict, signatureB64: parsed.signature, tx, explanation: parsed.explanation, aiKeyMissing: null };
    }
    const aiKeyMissing = explained && verdict.ai_status === 'unavailable' && parsed.explanation.startsWith(AI_KEY_MISSING);
    return { state: 'answered', verdict, verdictB64: parsed.verdict, signatureB64: parsed.signature, tx, explanation: parsed.explanation, aiKeyMissing };
  }
}
