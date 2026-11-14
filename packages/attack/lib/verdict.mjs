// Kaap verdicts in their real byte format, for the attack suite. A verdict is written here field by
// field in kaap-verdict's order (packages/verdict/src/types.rs), and every encoding is then handed
// back to kaap-core-wasm's own `verdictHash`, which encodes the same fields with kaap-verdict
// itself. The two hashes must agree or nothing is signed, so a verdict this file gets wrong can
// never reach a contract (C14, standard 2).
//
// The two signing keys come from the fixed seeds the contracts' sandbox tests use
// (packages/contracts/tests/common/mod.rs): public test values that anyone can sign with, by
// design. Neither is a key the production guard or registry trusts.
//
// What this file does NOT cover: checking that a contract accepts what it builds. The attacks do
// that on testnet.

import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { baseEncode } from './chain.mjs';
import { core } from './core.mjs';

export const VERDICT_DOMAIN = Buffer.from('kaap-verdict-v1\n', 'utf8');
export const VERDICT_VERSION = 1;
// The registry refuses anything larger (MAX_VERDICT_BYTES in kaap-registry).
export const MAX_VERDICT_BYTES = 1024;
// Every verdict built here is good for ten minutes unless an attack sets its own expiry.
export const EXPIRES_IN_MS = 600_000;

// kaap-verdict's enums in declaration order: borsh writes a variant as its index.
const NETWORKS = ['mainnet', 'testnet', 'sandbox'];
const SEVERITIES = ['low', 'medium', 'high', 'critical', 'unknown'];
const AI_STATUSES = ['verified', 'unverified', 'unavailable'];
const FINDINGS = [
  'HASH_MISMATCH', 'HASH_TEXT_DANGEROUS', 'POLICY_DUPLICATE_ROLE_NAMES', 'PROMPT_INJECTION', 'DESC_CONTRADICTS',
  'POLICY_ADDS_APPROVER', 'POLICY_LOWERS_THRESHOLD', 'POLICY_REPLACES_ROLE', 'POLICY_REMOVES_MEMBER', 'POLICY_BEFORE_UNKNOWN',
  'CODE_UPGRADE', 'INTENTS_KEY_CHANGE', 'GUARD_WEAKENED', 'UNKNOWN_CALL', 'ARGS_NOT_JSON', 'UNKNOWN_VALUE', 'LOOKALIKE_TOKEN',
  'OTHER_RISKY_KIND', 'HASH_UNVERIFIED', 'ATTACHED_DEPOSIT', 'CROSS_CHAIN_OUT', 'NEW_RECIPIENT', 'LARGE_AMOUNT', 'EMPTY_DESCRIPTION',
];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest();
const isHex32 = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);

function indexOf(table, value, what) {
  const i = table.indexOf(value);
  if (i < 0) throw new Error(`${what} "${value}" is not one kaap-verdict knows`);
  return i;
}

/** borsh of a verdict, without the domain prefix. The four 32-byte fields are lower-case hex. */
export function encodeVerdict(v) {
  const parts = [];
  const u8 = (n) => parts.push(Buffer.from([n]));
  const u32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    parts.push(b);
  };
  const u64 = (n) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(n));
    parts.push(b);
  };
  const str = (s) => {
    const b = Buffer.from(s, 'utf8');
    u32(b.length);
    parts.push(b);
  };
  const hex32 = (s, what) => {
    if (!isHex32(s)) throw new Error(`${what} is not 32 bytes of lower-case hex`);
    parts.push(Buffer.from(s, 'hex'));
  };
  u8(v.version);
  str(v.guard);
  u8(indexOf(NETWORKS, v.network, 'network'));
  str(v.dao);
  u64(v.proposal_id);
  hex32(v.kind_hash, 'kind_hash');
  hex32(v.policy_hash, 'policy_hash');
  hex32(v.receivers_hash, 'receivers_hash');
  u64(v.block_height);
  u8(indexOf(SEVERITIES, v.risk, 'risk'));
  u8(indexOf(SEVERITIES, v.floor, 'floor'));
  u32(v.findings.length);
  for (const f of v.findings) u8(indexOf(FINDINGS, f, 'finding'));
  str(v.decoder_version);
  str(v.model_id);
  u8(indexOf(AI_STATUSES, v.ai_status, 'ai_status'));
  hex32(v.explanation_hash, 'explanation_hash');
  u64(v.expires_at_ms);
  return Buffer.concat(parts);
}

/** Reads verdict bytes back into fields. Throws on anything that is not exactly one verdict. */
export function decodeVerdict(bytes) {
  const b = Buffer.from(bytes);
  let at = 0;
  const take = (n) => {
    if (at + n > b.length) throw new Error('the verdict is shorter than its layout');
    const out = b.subarray(at, at + n);
    at += n;
    return out;
  };
  const u8 = () => take(1)[0];
  const u32 = () => take(4).readUInt32LE(0);
  const u64 = () => {
    const n = take(8).readBigUInt64LE(0);
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('a number in the verdict is too large to hold exactly');
    return Number(n);
  };
  const str = () => take(u32()).toString('utf8');
  const hex = () => take(32).toString('hex');
  const pick = (table, what) => {
    const value = table[u8()];
    if (value === undefined) throw new Error(`the verdict's ${what} is not one kaap-verdict knows`);
    return value;
  };
  const v = {};
  v.version = u8();
  v.guard = str();
  v.network = pick(NETWORKS, 'network');
  v.dao = str();
  v.proposal_id = u64();
  v.kind_hash = hex();
  v.policy_hash = hex();
  v.receivers_hash = hex();
  v.block_height = u64();
  v.risk = pick(SEVERITIES, 'risk');
  v.floor = pick(SEVERITIES, 'floor');
  const count = u32();
  if (count > FINDINGS.length) throw new Error('the verdict lists more findings than there are codes');
  v.findings = Array.from({ length: count }, () => pick(FINDINGS, 'finding'));
  v.decoder_version = str();
  v.model_id = str();
  v.ai_status = pick(AI_STATUSES, 'AI status');
  v.explanation_hash = hex();
  v.expires_at_ms = u64();
  if (at !== b.length) throw new Error('bytes are left over after the verdict');
  return v;
}

/** The verdict's bytes and its hash, the id the guard records against a second use. Refuses
 *  unless kaap-core-wasm's `verdictHash` gives the same hash for the same fields. */
export function sealedForm(v) {
  const bytes = encodeVerdict(v);
  const hash = sha256(Buffer.concat([VERDICT_DOMAIN, bytes])).toString('hex');
  const coreHash = core.verdictHash(JSON.stringify(v));
  if (coreHash !== hash) throw new Error(`this encoder and kaap-core-wasm disagree on a verdict (${hash} against ${coreHash})`);
  return { bytes, hash };
}

/** Hash of real verdict bytes, after checking that decoding and encoding them again through
 *  kaap-core-wasm gives back exactly the same bytes. */
export function realForm(verdictB64) {
  const bytes = Buffer.from(verdictB64, 'base64');
  const fields = decodeVerdict(bytes);
  const again = sealedForm(fields);
  if (!again.bytes.equals(bytes)) throw new Error('a real verdict does not encode back to its own bytes');
  return { fields, bytes, hash: again.hash };
}

/** An ed25519 key from a 32-byte seed, through Node's crypto. */
function keyFromSeed(seed) {
  // The fixed DER header of an ed25519 PKCS#8 private key (RFC 8410), then the 32-byte seed.
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  const raw = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
  return { privateKey, raw: Buffer.from(raw), publicKey: `ed25519:${baseEncode(raw)}` };
}

/** The test-key guard's accepted key: seed [7; 32], the sandbox tests' verdict key. Its public
 *  half is the throwaway default in scripts/deploy-contracts-testnet.sh. */
export const TEST_KEY = keyFromSeed(Buffer.alloc(32, 7));
/** A key no Kaap contract trusts: seed [9; 32], the sandbox tests' "other" key. */
export const OTHER_KEY = keyFromSeed(Buffer.alloc(32, 9));
if (TEST_KEY.publicKey !== 'ed25519:GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB') {
  throw new Error(`the test seed gives ${TEST_KEY.publicKey}, not the sandbox tests' public test key`);
}

/** Signs a verdict the way the sealed program does: ed25519 over the domain prefix and the
 *  borsh bytes. Returns the base64 pair `veto` and `record` take, and the verdict's hash. */
export function signVerdict(v, key) {
  const { bytes, hash } = sealedForm(v);
  const signature = sign(null, Buffer.concat([VERDICT_DOMAIN, bytes]), key.privateKey);
  return { verdict: bytes.toString('base64'), signature: signature.toString('base64'), hash, fields: v };
}

/** Signs fields kaap-verdict itself might refuse to build, such as a verdict over the size limit,
 *  without the cross-check `signVerdict` makes: for attacks whose point is a malformed verdict. */
export function signUnchecked(v, key) {
  const bytes = encodeVerdict(v);
  const signature = sign(null, Buffer.concat([VERDICT_DOMAIN, bytes]), key.privateKey);
  return { verdict: bytes.toString('base64'), signature: signature.toString('base64'), hash: sha256(Buffer.concat([VERDICT_DOMAIN, bytes])).toString('hex'), fields: v };
}

/** The same verdict signed over its borsh bytes alone, without the domain prefix: what a key that
 *  also signs other things could be talked into producing. */
export function signWithoutDomain(v, key) {
  const { bytes, hash } = sealedForm(v);
  return { verdict: bytes.toString('base64'), signature: sign(null, bytes, key.privateKey).toString('base64'), hash, fields: v };
}

/** RFC 8032 ed25519 through Node's crypto, for 32 raw key bytes. */
export function ed25519Valid(rawKey, message, signature) {
  if (rawKey.length !== 32 || signature.length !== 64) return false;
  const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawKey]);
  return verify(null, message, createPublicKey({ key: der, format: 'der', type: 'spki' }), signature);
}

/** A verdict on the given proposal with everything a real one carries: the kind hash and the
 *  policy hash from kaap-core-wasm over the exact bytes read at final, the receivers hash over
 *  the DAO's own code (a native Transfer calls no other contract), and kaap-core's decoder
 *  version. `over` replaces any field. No model ran: the guard reads only `ai_status`, so the
 *  model id stays empty. */
export function verdictFor({ guard, dao, proposalId, kindJson, policyJson, daoCodeHash, blockHeight }, over = {}) {
  return {
    version: VERDICT_VERSION,
    guard,
    network: 'testnet',
    dao,
    proposal_id: proposalId,
    kind_hash: core.kindHash(kindJson),
    policy_hash: core.policyHash(policyJson),
    receivers_hash: core.receiversHash(JSON.stringify([[dao, daoCodeHash]])),
    block_height: blockHeight,
    risk: 'critical',
    floor: 'critical',
    findings: ['DESC_CONTRADICTS'],
    decoder_version: core.decoderVersion(),
    model_id: '',
    ai_status: 'unavailable',
    explanation_hash: sha256(Buffer.from(`attack suite verdict on ${dao} #${proposalId}`)).toString('hex'),
    expires_at_ms: Date.now() + EXPIRES_IN_MS,
    ...over,
  };
}

/** A real verdict with one field changed and the original signature kept, as an attacker who
 *  holds a signed verdict but not the key would try. */
export function edited(real, over) {
  const fields = { ...real.fields, ...over };
  return { verdict: encodeVerdict(fields).toString('base64'), fields };
}
