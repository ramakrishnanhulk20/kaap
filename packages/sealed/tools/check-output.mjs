// Checks one output of the sealed job the way a stranger would, with Node's own crypto: the
// signature verifies over "kaap-verdict-v1\n" plus the verdict's borsh bytes under the printed
// key, the verdict decodes, the explanation hash matches the printed text, and the output fits in
// 900 bytes. Prints the decoded verdict as one JSON line. Exits 1 on any failed check.
//
// Usage: node check-output.mjs <output.json> [--dao d] [--id n] [--network testnet] [--guard g] [--key ed25519:...]
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';

const [file, ...rest] = process.argv.slice(2);
const want = {};
for (let i = 0; i < rest.length; i += 2) want[rest[i].replace(/^--/, '')] = rest[i + 1];
const text = readFileSync(file, 'utf8').trim();
const fail = (why) => {
  console.log(JSON.stringify({ check: 'failed', why }));
  process.exit(1);
};

let out;
try {
  out = JSON.parse(text);
} catch {
  fail('the output is not JSON');
}
if (Buffer.byteLength(text) > 900) fail(`the output is ${Buffer.byteLength(text)} bytes, over 900`);
if (out.status !== 'ok') {
  console.log(JSON.stringify({ check: 'no verdict', status: out.status, reason: out.reason, signature: out.signature ?? null }));
  process.exit(out.signature === undefined ? 0 : 1);
}

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(s) {
  let n = 0n;
  for (const c of s) {
    const d = ALPHABET.indexOf(c);
    if (d < 0) fail('the public key is not base58');
    n = n * 58n + BigInt(d);
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of s) {
    if (c !== '1') break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

const DOMAIN = Buffer.from('kaap-verdict-v1\n');
const borsh = Buffer.from(out.verdict, 'base64');
const message = Buffer.concat([DOMAIN, borsh]);
const signature = Buffer.from(out.signature, 'base64');
if (!out.public_key?.startsWith('ed25519:')) fail('the public key is not ed25519:<base58>');
const raw = base58(out.public_key.slice('ed25519:'.length));
if (raw.length !== 32 || signature.length !== 64) fail('wrong key or signature length');
const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
if (!verify(null, message, key, signature)) fail('the signature does not verify');
const flipped = Buffer.from(message);
flipped[flipped.length - 1] ^= 1;
if (verify(null, flipped, key, signature)) fail('a changed message still verifies');

// kaap_core::Verdict, field by field, in declaration order (borsh: u32 lengths, little endian).
let at = 0;
const take = (n) => {
  if (at + n > borsh.length) fail('the verdict is shorter than its layout');
  const b = borsh.subarray(at, at + n);
  at += n;
  return b;
};
const u8 = () => take(1)[0];
const u32 = () => take(4).readUInt32LE(0);
const u64 = () => take(8).readBigUInt64LE(0).toString();
const str = () => take(u32()).toString('utf8');
const hex = () => take(32).toString('hex');
const NETWORKS = ['mainnet', 'testnet', 'sandbox'];
const SEVERITIES = ['low', 'medium', 'high', 'critical', 'unknown'];
const AI = ['verified', 'unverified', 'unavailable'];
const CODES = ['HASH_MISMATCH', 'HASH_TEXT_DANGEROUS', 'POLICY_DUPLICATE_ROLE_NAMES', 'PROMPT_INJECTION', 'DESC_CONTRADICTS',
  'POLICY_ADDS_APPROVER', 'POLICY_LOWERS_THRESHOLD', 'POLICY_REPLACES_ROLE', 'POLICY_REMOVES_MEMBER', 'POLICY_BEFORE_UNKNOWN',
  'CODE_UPGRADE', 'INTENTS_KEY_CHANGE', 'GUARD_WEAKENED', 'UNKNOWN_CALL', 'ARGS_NOT_JSON', 'UNKNOWN_VALUE', 'LOOKALIKE_TOKEN',
  'OTHER_RISKY_KIND', 'HASH_UNVERIFIED', 'ATTACHED_DEPOSIT', 'CROSS_CHAIN_OUT', 'NEW_RECIPIENT', 'LARGE_AMOUNT', 'EMPTY_DESCRIPTION'];
const v = {
  version: u8(),
  guard: str(),
  network: NETWORKS[u8()],
  dao: str(),
  proposal_id: u64(),
  kind_hash: hex(),
  policy_hash: hex(),
  receivers_hash: hex(),
  block_height: u64(),
  risk: SEVERITIES[u8()],
  floor: SEVERITIES[u8()],
  findings: Array.from({ length: u32() }, () => CODES[u8()]),
  decoder_version: str(),
  model_id: str(),
  ai_status: AI[u8()],
  explanation_hash: hex(),
  expires_at_ms: u64(),
};
if (at !== borsh.length) fail('bytes left over after the verdict');
if (v.version !== 1) fail('verdict version is not 1');
if ([v.network, v.risk, v.floor, v.ai_status, ...v.findings].includes(undefined)) fail('an enum index is out of range');
const explanationHash = createHash('sha256').update(out.explanation, 'utf8').digest('hex');
if (explanationHash !== v.explanation_hash) fail('the explanation hash does not match the printed explanation');
for (const [field, value] of Object.entries(want)) {
  const got = field === 'key' ? out.public_key : field === 'id' ? v.proposal_id : v[field];
  if (String(got) !== String(value)) fail(`${field} is ${got}, expected ${value}`);
}
console.log(JSON.stringify({ check: 'passed', bytes: Buffer.byteLength(text), public_key: out.public_key, verdict: v, explanation: out.explanation }));
