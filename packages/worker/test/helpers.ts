// Fakes shared by the worker's tests: two RPC providers serving one in-memory DAO, a chain that
// records every signing and send, test verdicts signed with a throwaway key, and recorded
// testnet fixtures.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { KeyPair } from 'near-api-js';

import { Bridge, type VerdictFields } from '../src/bridge.ts';
import type { Broadcast, Chain, Signed } from '../src/chain.ts';
import { createLogger, type Logger } from '../src/log.ts';
import type { TxOutcome } from '../src/outcome.ts';
import type { At, AccountView, BlockView, ViewProvider, ViewResult } from '../src/rpc.ts';
import { Store } from '../src/store.ts';
import type { ChatUpdate, SendResult, TelegramApi } from '../src/telegram.ts';

export const bridge = Bridge.load();

export function fixture<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)), 'utf8')) as T;
}

/** The DAO reads recorded from kaap-dao-1029064008.testnet (tools/record-fixtures.mjs). */
export const daoReads = fixture<{ dao: string; code_hash: string; get_policy: string; get_proposal_2: string; get_proposal_3: string; get_proposals_0_10: string }>('dao-reads');

export const NETWORK = 'testnet';
export const GUARD = 'guard.kaap.testnet';
export const REGISTRY = 'registry.kaap.testnet';
export const DAO = 'treasury.sputnik.testnet';
export const DAO_CODE = 'DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF';
export const POLICY = daoReads.get_policy;
export const T0 = Date.parse('2026-11-02T10:00:00Z');

export const noSleep = async () => {};

export function memoryLog(): { log: Logger; lines: Array<Record<string, unknown>>; text: () => string } {
  const raw: string[] = [];
  // One array that keeps growing, so a test holding it sees every later line.
  const lines: Array<Record<string, unknown>> = [];
  const log = createLogger('debug', (line) => {
    raw.push(line);
    lines.push(JSON.parse(line) as Record<string, unknown>);
  });
  return { log, lines, text: () => raw.join('\n') };
}

export const events = (lines: Array<Record<string, unknown>>, event: string) => lines.filter((l) => l.event === event);

export function clock(start = T0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

export function memoryStore(now: () => number = () => T0): Store {
  return new Store(':memory:', now);
}

/** A Transfer proposal as Sputnik's get_proposal returns it. */
export function proposalText(id: number, opts: { status?: string; receiver?: string; kind?: string } = {}): string {
  const kind = opts.kind ?? `{"Transfer":{"token_id":"","receiver_id":"${opts.receiver ?? 'bob.testnet'}","amount":"5000000000000000000000000","msg":null}}`;
  return `{"id":${id},"proposer":"member.testnet","description":"pay","kind":${kind},"status":"${opts.status ?? 'InProgress'}","vote_counts":{},"votes":{},"submission_time":"1793257828612807556","last_actions_log":null}`;
}

/** One RPC provider serving one DAO, its guard and its registry at one moving block. */
export class FakeProvider implements ViewProvider {
  readonly name: string;
  height = 5_000;
  optimistic = 0;
  final = 0;
  policy = POLICY;
  proposals = new Map<number, string>();
  codeHashes = new Map<string, string>([[DAO, DAO_CODE]]);
  acceptedKey = '';
  enrolled: string[] = [DAO];
  vetoResults = new Map<string, string | null>();
  /** Liquid yoctoNEAR per account; 1 NEAR when unset. Every account uses 100 bytes of storage. */
  balances = new Map<string, bigint>();
  down = false;
  calls: Array<{ method: string; at: At }> = [];

  constructor(name: string) {
    this.name = name;
  }

  #result(text: string): ViewResult {
    return { bytes: new TextEncoder().encode(text), text, blockHeight: this.height, blockHash: `h${this.height}` };
  }

  async callFunction(account: string, method: string, args: Record<string, unknown>, at: At): Promise<ViewResult> {
    this.calls.push({ method, at });
    if (this.down) throw new Error(`${this.name} is down`);
    if (method === 'get_last_proposal_id') return this.#result(String('finality' in at && at.finality === 'optimistic' ? this.optimistic : this.final));
    if (method === 'get_policy') return this.#result(this.policy);
    if (method === 'get_proposal') {
      const text = this.proposals.get(Number(args.id));
      if (!text) throw new Error('ERR_NO_PROPOSAL');
      return this.#result(text);
    }
    if (method === 'get_proposals') {
      const from = Number(args.from_index);
      const items = [];
      for (let id = from; id < from + Number(args.limit); id++) if (this.proposals.has(id)) items.push(this.proposals.get(id));
      return this.#result(`[${items.join(',')}]`);
    }
    if (method === 'accepted_key') return this.#result(JSON.stringify(this.acceptedKey));
    if (method === 'enrolled_daos') return this.#result(JSON.stringify(Number(args.from_index) === 0 ? this.enrolled : []));
    if (method === 'veto_result') return this.#result(JSON.stringify(this.vetoResults.get(String(args.verdict_hash_hex)) ?? null));
    throw new Error(`no fake answer for ${account}.${method}`);
  }

  async viewAccount(account: string): Promise<AccountView> {
    if (this.down) throw new Error(`${this.name} is down`);
    const codeHash = this.codeHashes.get(account) ?? '11111111111111111111111111111111';
    return { codeHash, amount: this.balances.get(account) ?? 10n ** 24n, storageUsage: 100, blockHeight: this.height, blockHash: `h${this.height}` };
  }

  async block(at: At): Promise<BlockView> {
    if (this.down) throw new Error(`${this.name} is down`);
    if ('blockId' in at && typeof at.blockId === 'string') return { height: this.height, hash: at.blockId, timestampMs: Number(1793257828612807556n / 1_000_000n) + 21_800 };
    return { height: this.height, hash: `h${this.height}`, timestampMs: T0 };
  }
}

/** Two providers that agree, serving the same DAO. Change both for a real chain change, or one
 *  for a provider that lies or lags. */
export function twoProviders(): [FakeProvider, FakeProvider] {
  return [new FakeProvider('primary.test'), new FakeProvider('secondary.test')];
}

export function bothSet(ps: FakeProvider[], f: (p: FakeProvider) => void): void {
  for (const p of ps) f(p);
}

export interface SentCall {
  receiverId: string;
  method: string;
  args: Record<string, unknown>;
  hash: string;
  signedB64: string;
  nonce: bigint;
  gas: bigint;
  deposit: bigint;
}

/** A chain that records every signing and send. `respond` decides each transaction's final
 *  outcome when it is included (null: it never becomes final); `plan` scripts send results. */
export class FakeChain implements Chain {
  readonly accountId = 'worker.kaap.testnet';
  headHeight = 1_000;
  #nonce = 0n;
  signed: SentCall[] = [];
  broadcasts: string[] = [];
  plan: Array<Broadcast['kind']> = [];
  outcomes = new Map<string, TxOutcome>();
  respond: (call: SentCall) => TxOutcome | null = () => okOutcome();

  async sign(receiverId: string, method: string, args: object, gas: bigint, deposit: bigint): Promise<Signed> {
    this.#nonce++;
    const signedB64 = Buffer.from(JSON.stringify({ receiverId, method, nonce: Number(this.#nonce) })).toString('base64');
    const call = { receiverId, method, args: args as Record<string, unknown>, hash: `tx${this.#nonce}`, signedB64, nonce: this.#nonce, gas, deposit };
    this.signed.push(call);
    return { hash: call.hash, signedB64, nonce: this.#nonce };
  }

  async broadcast(signedB64: string): Promise<Broadcast> {
    this.broadcasts.push(signedB64);
    const kind = this.plan.shift() ?? 'included';
    if (kind === 'included') {
      const call = this.signed.find((c) => c.signedB64 === signedB64);
      const outcome = call ? this.respond(call) : null;
      if (call && outcome) this.outcomes.set(call.hash, outcome);
      return { kind };
    }
    return { kind, detail: `scripted ${kind}` };
  }

  async outcome(hash: string): Promise<TxOutcome | null> {
    this.headHeight += 5;
    return this.outcomes.get(hash) ?? null;
  }

  async head(): Promise<number> {
    return this.headHeight;
  }

  resetNonce(): void {}

  calls(method: string): SentCall[] {
    return this.signed.filter((c) => c.method === method);
  }
}

/** A Telegram that records every message; `plan` scripts send results, `updates` feeds polls. */
export class FakeTelegram implements TelegramApi {
  sent: Array<{ chatId: string; text: string }> = [];
  plan: SendResult[] = [];
  updates: ChatUpdate[] = [];
  #messageId = 100;

  async sendMessage(chatId: string, text: string): Promise<SendResult> {
    this.sent.push({ chatId, text });
    return this.plan.shift() ?? { ok: true, messageId: ++this.#messageId, chatId };
  }

  async getUpdates(offset: number): Promise<{ updates: ChatUpdate[]; next: number }> {
    const updates = this.updates.filter((u) => u.updateId >= offset);
    this.updates = [];
    return { updates, next: updates.reduce((n, u) => Math.max(n, u.updateId + 1), offset) };
  }

  async getMe(): Promise<{ username: string }> {
    return { username: 'kaap_test_bot' };
  }

  to(chatId: string): string[] {
    return this.sent.filter((m) => m.chatId === chatId).map((m) => m.text);
  }
}

export const chatMessage = (updateId: number, chatId: string, text: string, chatType = 'private'): ChatUpdate => ({ updateId, chatId, chatType, text, left: false });

export function okOutcome(value?: unknown, logs: string[] = []): TxOutcome {
  return {
    final_execution_status: 'FINAL',
    status: { SuccessValue: value === undefined ? '' : Buffer.from(JSON.stringify(value)).toString('base64') },
    transaction_outcome: { outcome: { tokens_burnt: '300000000000000000000' } },
    receipts_outcome: [{ id: 'r1', block_hash: 'vote-block', outcome: { executor_id: DAO, logs, tokens_burnt: '500000000000000000000' } }],
  };
}

export function failedOutcome(code: string): TxOutcome {
  return {
    final_execution_status: 'FINAL',
    status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${code}` } } } } },
    transaction_outcome: { outcome: { tokens_burnt: '200000000000000000000' } },
    receipts_outcome: [],
  };
}

export const testKey = () => KeyPair.fromRandom('ed25519');

const ZERO = '0'.repeat(64);

/** Verdict fields for `DAO` #`id` with every pin set from the fake DAO's real state. */
export function verdictFields(id: number, over: Partial<VerdictFields> = {}): VerdictFields {
  const kind = JSON.parse(proposalText(id)).kind;
  return {
    version: 1,
    guard: GUARD,
    network: NETWORK,
    dao: DAO,
    proposal_id: id,
    kind_hash: bridge.kindHash(JSON.stringify(kind)),
    policy_hash: bridge.policyHash(new TextEncoder().encode(POLICY)),
    receivers_hash: bridge.receiversHash([[DAO, DAO_CODE]]),
    block_height: 4_990,
    risk: 'critical',
    floor: 'critical',
    findings: ['DESC_CONTRADICTS', 'UNKNOWN_VALUE'],
    decoder_version: '0.1.0',
    model_id: '',
    ai_status: 'unavailable',
    explanation_hash: ZERO,
    expires_at_ms: T0 + 600_000,
    ...over,
  };
}

/** The sealed job's printed output for `fields`, signed with `key`. */
export function sealedOutput(fields: VerdictFields, key: KeyPair): { v: 1; status: 'ok'; verdict: string; signature: string; public_key: string; explanation: string } {
  const verdict = bridge.encodeVerdict(fields);
  const decoded = bridge.decodeVerdict(Buffer.from(verdict, 'base64'));
  const signature = Buffer.from(key.sign(Buffer.from(decoded.signed_b64, 'base64')).signature).toString('base64');
  return { v: 1, status: 'ok', verdict, signature, public_key: key.getPublicKey().toString(), explanation: 'AI unavailable: no NEAR AI key is set for this project yet.' };
}

/** A request_execution outcome returning `output`, with OutLayer's completion event. */
export function runOutcome(output: unknown): TxOutcome {
  const o = okOutcome(output);
  o.receipts_outcome!.push({ id: 'r2', block_hash: 'b2', outcome: { executor_id: 'outlayer.testnet', logs: ['EVENT_JSON:{"standard":"near-outlayer","version":"1.0.0","event":"execution_completed","data":[{"payment_charged":"1138000000000000000000"}]}'], tokens_burnt: '0' } });
  return o;
}
