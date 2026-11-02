// A Kaap verdict as the registry returns it: the borsh bytes the sealed program signed. They are
// read here field by field in kaap-verdict's order (packages/verdict/src/types.rs), and then the
// fields go back through kaap-verdict itself (`Core.verdictHash`), which encodes them again. Both
// hashes must be equal, so a field this file reads wrongly can only fail the check, never pass it
// (standard 2). Signatures are checked here with Node's ed25519 against a key read from the chain,
// never taken from a service's "valid" (C28).

import { createHash, createPublicKey, verify } from 'node:crypto';

/** kaap-verdict `VERDICT_DOMAIN`: what the sealed program signs is this, then the borsh bytes. */
export const VERDICT_DOMAIN = Buffer.from('kaap-verdict-v1\n', 'utf8');

/** The registry refuses anything larger (`MAX_VERDICT_BYTES`). */
const MAX_VERDICT_BYTES = 1024;

// kaap-verdict's enums, in declaration order: borsh writes a variant as its index. These tables
// only read; a stale entry makes the re-encoding differ, which fails the check.
const NETWORK = ['mainnet', 'testnet', 'sandbox'] as const;
const SEVERITY = ['low', 'medium', 'high', 'critical', 'unknown'] as const;
const AI_STATUS = ['verified', 'unverified', 'unavailable'] as const;
const FINDING = [
  'HASH_MISMATCH', 'HASH_TEXT_DANGEROUS', 'POLICY_DUPLICATE_ROLE_NAMES', 'PROMPT_INJECTION', 'DESC_CONTRADICTS',
  'POLICY_ADDS_APPROVER', 'POLICY_LOWERS_THRESHOLD', 'POLICY_REPLACES_ROLE', 'POLICY_REMOVES_MEMBER', 'POLICY_BEFORE_UNKNOWN',
  'CODE_UPGRADE', 'INTENTS_KEY_CHANGE', 'GUARD_WEAKENED', 'UNKNOWN_CALL', 'ARGS_NOT_JSON', 'UNKNOWN_VALUE', 'LOOKALIKE_TOKEN',
  'OTHER_RISKY_KIND', 'HASH_UNVERIFIED', 'ATTACHED_DEPOSIT', 'CROSS_CHAIN_OUT', 'NEW_RECIPIENT', 'LARGE_AMOUNT', 'EMPTY_DESCRIPTION',
] as const;

/** The shape `Core.verdictHash` takes: the 32-byte fields as lower-case hex. */
export interface VerdictFields {
  version: number;
  guard: string;
  network: (typeof NETWORK)[number];
  dao: string;
  proposal_id: number;
  kind_hash: string;
  policy_hash: string;
  receivers_hash: string;
  block_height: number;
  risk: (typeof SEVERITY)[number];
  floor: (typeof SEVERITY)[number];
  findings: (typeof FINDING)[number][];
  decoder_version: string;
  model_id: string;
  ai_status: (typeof AI_STATUS)[number];
  explanation_hash: string;
  expires_at_ms: number;
}

export class BadVerdict extends Error {
  constructor(why: string) {
    super(why);
    this.name = 'BadVerdict';
  }
}

/** Reads a version 1 verdict, or throws `BadVerdict` with a fixed reason. Every u64 must be a
 *  JavaScript-safe integer; heights, ids and times are far below that. */
export function decodeVerdict(bytes: Uint8Array): VerdictFields {
  if (bytes.length > MAX_VERDICT_BYTES) throw new BadVerdict('the verdict is larger than the registry accepts');
  const b = Buffer.from(bytes);
  let at = 0;
  const take = (n: number) => {
    if (at + n > b.length) throw new BadVerdict('the verdict is shorter than its layout');
    const out = b.subarray(at, at + n);
    at += n;
    return out;
  };
  const u8 = () => take(1)[0] as number;
  const u32 = () => take(4).readUInt32LE(0);
  const u64 = () => {
    const n = take(8).readBigUInt64LE(0);
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new BadVerdict('a number in the verdict is too large to show exactly');
    return Number(n);
  };
  const str = () => {
    const len = u32();
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(take(len));
    } catch (e) {
      if (e instanceof BadVerdict) throw e;
      throw new BadVerdict('a text field of the verdict is not UTF-8');
    }
  };
  const hex = () => take(32).toString('hex');
  const pick = <T>(table: readonly T[], what: string): T => {
    const v = table[u8()];
    if (v === undefined) throw new BadVerdict(`the verdict's ${what} is not one kaap-verdict knows`);
    return v;
  };
  const version = u8();
  if (version !== 1) throw new BadVerdict('the verdict is not version 1');
  const guard = str();
  const network = pick(NETWORK, 'network');
  const dao = str();
  const proposal_id = u64();
  const kind_hash = hex();
  const policy_hash = hex();
  const receivers_hash = hex();
  const block_height = u64();
  const risk = pick(SEVERITY, 'risk');
  const floor = pick(SEVERITY, 'floor');
  const count = u32();
  if (count > FINDING.length) throw new BadVerdict('the verdict lists more findings than there are codes');
  const findings = Array.from({ length: count }, () => pick(FINDING, 'finding'));
  const decoder_version = str();
  const model_id = str();
  const ai_status = pick(AI_STATUS, 'AI status');
  const explanation_hash = hex();
  const expires_at_ms = u64();
  if (at !== b.length) throw new BadVerdict('bytes are left over after the verdict');
  return { version, guard, network, dao, proposal_id, kind_hash, policy_hash, receivers_hash, block_height, risk, floor, findings, decoder_version, model_id, ai_status, explanation_hash, expires_at_ms };
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** The exact bytes the sealed program signs for these verdict bytes. */
export function signedBytes(verdict: Uint8Array): Buffer {
  return Buffer.concat([VERDICT_DOMAIN, verdict]);
}

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Bitcoin-alphabet base58, as NEAR writes keys and hashes. Null for any other character. */
export function base58(text: string): Buffer | null {
  let n = 0n;
  for (const c of text) {
    const d = ALPHABET.indexOf(c);
    if (d < 0) return null;
    n = n * 58n + BigInt(d);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of text) {
    if (c !== '1') break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

/** The 32 key bytes of "ed25519:<base58>", or null for anything else. Two keys are compared as
 *  these bytes, never as text (standard 2). */
export function edKeyBytes(key: string): Buffer | null {
  if (!key.startsWith('ed25519:')) return null;
  const raw = base58(key.slice('ed25519:'.length));
  return raw !== null && raw.length === 32 ? raw : null;
}

/** RFC 8032 ed25519 through Node's crypto. False for a key or a signature of the wrong size. */
export function ed25519Valid(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  // The fixed DER header of an ed25519 SubjectPublicKeyInfo (RFC 8410), then the 32 key bytes.
  const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKey]);
  return verify(null, message, createPublicKey({ key: der, format: 'der', type: 'spki' }), signature);
}
