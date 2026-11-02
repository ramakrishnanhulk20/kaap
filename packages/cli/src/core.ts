// kaap-core inside the CLI, as the WebAssembly that packages/core-wasm builds. Every rule the CLI
// prints a result from runs here, never in a TypeScript copy, so a judge's laptop and the sealed
// job decide one proposal the same way (C14, standard 2). Answers are checked against a schema
// before use, like any other input.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { z } from 'zod';

import type { Network } from './rpc.js';

/** `packages/cli/wasm`, where `npm run build:wasm` writes wasm-bindgen's output. */
export const WASM_DIR = fileURLToPath(new URL('../../wasm/', import.meta.url));

interface Bindings {
  initSync(options: { module: Uint8Array }): unknown;
  analyze(input: string): string;
  readProposal(answer: string): string;
  isAccountId(id: string): boolean;
  canonicalKind(kind: string): string;
  canonicalPolicy(policy: string): string;
  kindHash(kind: string): string;
  policyHash(policy: string): string;
  nep413Hash(message: string, nonceB64: string, recipient: string, callbackUrl?: string | null): string;
  nep461Hash(delegateB64: string): string;
  verdictHash(verdict: string): string;
  guardArming(policy: string, guard: string): string;
  pricesFromTokens(tokens: string): string;
  evalScoreboards(real: string, planted: string, tokens: string): string;
}

export class CoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoreError';
  }
}

const severity = z.enum(['low', 'medium', 'high', 'critical', 'unknown']);
const findingCode = z.string().regex(/^[A-Z_]{3,40}$/);

const analysisSchema = z.strictObject({
  analysis: z.strictObject({
    effects: z.array(z.looseObject({ type: z.string() })),
    findings: z.array(z.strictObject({ code: findingCode, severity })),
    risk_floor: severity,
    description_check: z.enum(['matches', 'contradicts', 'vague', 'empty', 'hidden']),
    must_veto: z.boolean(),
    veto_allowed: z.boolean(),
  }),
  kind_label: z.string(),
  description: z.strictObject({ agreements: z.array(z.string()), contradictions: z.array(z.string()), injection: z.boolean() }),
});
export type CheckAnalysis = z.output<typeof analysisSchema>;

const proposalSchema = z.strictObject({
  id: z.number().int().nonnegative(),
  proposer: z.string(),
  description: z.string(),
  kind_json: z.string(),
  status: z.string(),
  submission_time: z.string(),
});
export type ProposalRead = z.output<typeof proposalSchema>;

/** `usd_by_token`: token id to (decimals, USD per whole token). */
const pricesSchema = z.strictObject({ usd_by_token: z.record(z.string(), z.tuple([z.number().int().min(0).max(255), z.number().positive()])) });
export type Prices = z.output<typeof pricesSchema>;

const boardsSchema = z.strictObject({
  records: z.strictObject({ real: z.number(), planted: z.number(), run: z.number(), unreadable: z.number() }),
  boards: z.array(
    z.strictObject({
      name: z.string(),
      title: z.string(),
      rows: z.array(z.strictObject({ measure: z.string(), agree: z.number().int(), of: z.number().int() })),
    }),
  ),
});
export type Scoreboards = z.output<typeof boardsSchema>;

export interface History {
  approved_payments_before: number;
  median_payment_usd_before: number | null;
  recipients_paid_before: string[];
}

export interface AnalyzeInput {
  network: Network;
  dao: string;
  proposal_id: number;
  description: string;
  /** The exact text of the kind as `get_proposal` returned it (C5). */
  kind_json: string;
  policy_before_json: string | null;
  history: History | null;
  prices: Prices;
  dao_version: string | null;
  block_timestamp_ns: string | null;
}

export class Core {
  readonly #b: Bindings;

  private constructor(bindings: Bindings) {
    this.#b = bindings;
  }

  static async load(dir = WASM_DIR): Promise<Core> {
    const glue = join(dir, 'kaap_core_wasm.js');
    const wasm = join(dir, 'kaap_core_wasm_bg.wasm');
    if (!existsSync(glue) || !existsSync(wasm)) {
      throw new CoreError(`kaap-core is not built yet (no ${wasm}): run "npm run build -w packages/cli" first; it needs Rust and wasm-bindgen-cli 0.2.129`);
    }
    const bindings = (await import(pathToFileURL(glue).href)) as Bindings;
    bindings.initSync({ module: readFileSync(wasm) });
    return new Core(bindings);
  }

  #run<T>(what: string, call: () => T): T {
    try {
      return call();
    } catch (e) {
      // A Rust panic surfaces as a WebAssembly trap; the wasm instance is not used again after one.
      if (e instanceof Error && e.name === 'RuntimeError') throw new CoreError(`kaap-core stopped on this input (${what}); nothing was decided`);
      throw new CoreError(e instanceof Error ? e.message : `${what} failed`);
    }
  }

  analyze(input: AnalyzeInput): CheckAnalysis {
    return analysisSchema.parse(JSON.parse(this.#run('analyze', () => this.#b.analyze(JSON.stringify(input)))));
  }

  readProposal(answer: string): ProposalRead {
    return proposalSchema.parse(JSON.parse(this.#run('readProposal', () => this.#b.readProposal(answer))));
  }

  isAccountId(id: string): boolean {
    return this.#run('isAccountId', () => this.#b.isAccountId(id));
  }

  canonicalKind(kind: string): string {
    return this.#run('canonicalKind', () => this.#b.canonicalKind(kind));
  }

  canonicalPolicy(policy: string): string {
    return this.#run('canonicalPolicy', () => this.#b.canonicalPolicy(policy));
  }

  kindHash(kind: string): string {
    return this.#run('kindHash', () => this.#b.kindHash(kind));
  }

  policyHash(policy: string): string {
    return this.#run('policyHash', () => this.#b.policyHash(policy));
  }

  pricesFromTokens(tokens: string): Prices {
    return pricesSchema.parse(JSON.parse(this.#run('pricesFromTokens', () => this.#b.pricesFromTokens(tokens))));
  }

  evalScoreboards(real: string, planted: string, tokens: string): Scoreboards {
    return boardsSchema.parse(JSON.parse(this.#run('evalScoreboards', () => this.#b.evalScoreboards(real, planted, tokens))));
  }
}
