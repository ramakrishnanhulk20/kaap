// kaap-core inside the worker, as the wasm that bridge/build.sh builds. Every hash the worker
// compares with a signed verdict, and the veto rule it mirrors, comes from here, so the worker and
// the sealed job read one input one way (threat model standard 2, C14).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

export const DEFAULT_WASM = fileURLToPath(new URL('../dist/kaap-worker-bridge.wasm', import.meta.url));

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const severity = z.enum(['low', 'medium', 'high', 'critical', 'unknown']);

const verdictSchema = z.strictObject({
  version: z.literal(1),
  guard: z.string(),
  network: z.enum(['mainnet', 'testnet', 'sandbox']),
  dao: z.string(),
  proposal_id: z.number().int().nonnegative(),
  kind_hash: hash,
  policy_hash: hash,
  receivers_hash: hash,
  block_height: z.number().int().nonnegative(),
  risk: severity,
  floor: severity,
  findings: z.array(z.string().regex(/^[A-Z_]+$/)),
  decoder_version: z.string(),
  model_id: z.string(),
  ai_status: z.enum(['verified', 'unverified', 'unavailable']),
  explanation_hash: hash,
  expires_at_ms: z.number().int().nonnegative(),
  verdict_hash: hash,
  signed_b64: z.string(),
  vetoable: z.boolean(),
});
export type DecodedVerdict = z.output<typeof verdictSchema>;
export type VerdictFields = Omit<DecodedVerdict, 'verdict_hash' | 'signed_b64' | 'vetoable'>;

const proposalSchema = z.strictObject({
  id: z.number().int().nonnegative(),
  status: z.string(),
  kind: z.string(),
  submission_time: z.string().regex(/^\d{1,20}$/).nullable(),
});
export type ProposalRead = z.output<typeof proposalSchema>;

const answer = z.union([z.strictObject({ ok: z.unknown() }), z.strictObject({ err: z.string() })]);

export class BridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeError';
  }
}

interface Exports {
  memory: { buffer: ArrayBuffer };
  kaap_alloc(len: number): number;
  kaap_free(ptr: number, len: number): void;
  [name: string]: unknown;
}

// The few WebAssembly calls used here, typed by hand: TypeScript's WebAssembly types live in the
// DOM library, which a Node program should not pull in.
interface WasmApi {
  Module: new (bytes: Uint8Array) => object;
  Instance: new (module: object, imports: object) => { exports: unknown };
}
const wasm = (globalThis as unknown as { WebAssembly: WasmApi }).WebAssembly;

const armingSchema = z.strictObject({ rejects_alone: z.array(z.string()), proposal_period_ns: z.string().regex(/^\d{1,20}$/).nullable() });

export interface GuardArming {
  rejectsAlone: string[];
  proposalPeriodMs: number | null;
}

export class Bridge {
  readonly #x: Exports;
  readonly #encoder = new TextEncoder();
  readonly #decoder = new TextDecoder('utf-8', { fatal: true });

  private constructor(x: Exports) {
    this.#x = x;
  }

  static load(path = DEFAULT_WASM): Bridge {
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch {
      throw new BridgeError(`no kaap-core bridge at ${path}: run "npm run build:bridge -w packages/worker" inside WSL first`);
    }
    const instance = new wasm.Instance(new wasm.Module(bytes), {});
    return new Bridge(instance.exports as unknown as Exports);
  }

  #call(name: string, input: Uint8Array): unknown {
    const fn = this.#x[name];
    if (typeof fn !== 'function') throw new BridgeError(`the bridge has no ${name}`);
    const len = input.length;
    const ptr = len > 0 ? this.#x.kaap_alloc(len) : 0;
    if (len > 0) new Uint8Array(this.#x.memory.buffer, ptr, len).set(input);
    let packed: bigint;
    try {
      packed = BigInt.asUintN(64, (fn as (p: number, l: number) => bigint)(ptr, len));
    } finally {
      if (len > 0) this.#x.kaap_free(ptr, len);
    }
    const outPtr = Number(packed >> 32n);
    const outLen = Number(packed & 0xffff_ffffn);
    const text = this.#decoder.decode(new Uint8Array(this.#x.memory.buffer, outPtr, outLen).slice());
    this.#x.kaap_free(outPtr, outLen);
    const parsed = answer.parse(JSON.parse(text));
    if ('err' in parsed) throw new BridgeError(parsed.err);
    return parsed.ok;
  }

  #json(name: string, value: unknown): unknown {
    return this.#call(name, this.#encoder.encode(JSON.stringify(value)));
  }

  /** Decodes a verdict's borsh (no domain prefix) and applies the guard's veto rule to it. */
  decodeVerdict(borsh: Uint8Array): DecodedVerdict {
    return verdictSchema.parse(this.#call('kaap_verdict_decode', borsh));
  }

  /** The borsh, in base64, of a verdict with these fields. Only tests make verdicts. */
  encodeVerdict(fields: VerdictFields): string {
    return z.string().parse(this.#json('kaap_verdict_encode', fields));
  }

  kindHash(kindText: string): string {
    return hash.parse(this.#call('kaap_kind_hash', this.#encoder.encode(kindText)));
  }

  policyHash(policy: Uint8Array): string {
    return hash.parse(this.#call('kaap_policy_hash', policy));
  }

  readProposal(answerBytes: Uint8Array): ProposalRead {
    return proposalSchema.parse(this.#call('kaap_proposal_read', answerBytes));
  }

  readProposals(answerBytes: Uint8Array): ProposalRead[] {
    return z.array(proposalSchema).parse(this.#call('kaap_proposals_read', answerBytes));
  }

  sameProposal(a: string, b: string): boolean {
    return z.boolean().parse(this.#json('kaap_same_proposal', { a, b }));
  }

  calledAccounts(dao: string, kindText: string): string[] {
    return z.array(z.string()).parse(this.#json('kaap_called_accounts', { dao, kind: kindText }));
  }

  receiversHash(pairs: Array<[string, string]>): string {
    return hash.parse(this.#json('kaap_receivers_hash', pairs));
  }

  /** What the policy text gives `guard`, by kaap-core's own reading (C16): the kinds of proposal
   *  its one reject decides, and how long the policy lets a proposal stay open, in milliseconds,
   *  null when the policy states no period that reads as a whole number. */
  guardArming(policyText: string, guard: string): GuardArming {
    const a = armingSchema.parse(this.#json('kaap_guard_arming', { policy: policyText, guard }));
    const ms = a.proposal_period_ns === null ? null : Number(BigInt(a.proposal_period_ns) / 1_000_000n);
    return { rejectsAlone: a.rejects_alone, proposalPeriodMs: ms !== null && Number.isSafeInteger(ms) ? ms : null };
  }
}
