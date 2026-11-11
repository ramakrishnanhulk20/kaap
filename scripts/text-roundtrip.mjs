#!/usr/bin/env node
// A member's whole trip through the sealed text channel. Asks the job for its key and checks that
// the verdict key signed it, encrypts a planted text here with Node's own crypto, has the job judge
// a proposal with the ciphertext, and opens the explanation it sends back. Then it attacks the
// channel: a tampered ciphertext, a ciphertext sent with a thief's reply key, a ciphertext for a key
// that is not the job's, and a text sealed the right way that does not hash to the proposal's
// payload. Exit code 0 only when the text came back HASH_TEXT_DANGEROUS, the request carried nothing
// but ciphertext, and every attack was refused, the last one as text_does_not_match.
//
//   node scripts/text-roundtrip.mjs
//     Testnet, inside WSL, needing a published build that has this channel and refuses a text that
//     matches no payload. Signs as the demo member (files one proposal) and the worker (6 runs).
//     Keys are read from ~/.near-credentials/testnet and never printed. Spends about 0.01 testnet
//     NEAR.
//   node scripts/text-roundtrip.mjs --local <kaap-sealed-local.wasm>
//     The same trip against `bash packages/sealed/build.sh local` under plain wasmtime, on a recorded
//     fixture edited to carry the planted proposal, with the test keys. Needs wasmtime 28
//     (KAAP_WASMTIME, default ~/kaap-tools/wasmtime28). No account, no network.
//
// What this does not cover: the "preflight failed, so the text stays in" rule (C12), which needs a
// keyed run with broken attestation and is proven by the transport tests in packages/sealed/tests.
// The local run proves Node and Rust agree on the bytes, not that OutLayer's keystore behaves.
//
// The planted text is made up here. It is never printed, and the run fails if it shows in what the
// job printed or logged.

import { spawnSync } from 'node:child_process';
import {
  createCipheriv, createDecipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, verify,
} from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK_OUTPUT = join(REPO, 'packages', 'sealed', 'tools', 'check-output.mjs');
const FIXTURE = join(REPO, 'packages', 'sealed', 'tests', 'fixtures', 'function-call.json');

// packages/sealed/src/texts.rs: each side must write the same bytes, and Rust has no way to check
// these from here, so a change there fails this script's first run.
const TEXT_KEY_DOMAIN = 'kaap-text-key-v1\n';
const HKDF_INFO = 'kaap-texts-v1';
const TEXT_DOMAIN = 'kaap-text-v1';
const EXPLANATION_DOMAIN = 'kaap-explanation-v1';
const SEALED_PREFIX = 'sealed:';
const FORMAT = 0x01;
const OVERHEAD = 1 + 32 + 12 + 16;
// packages/sealed/src/output.rs, printed whole: a signature anywhere in it would break the match.
const TEXT_DOES_NOT_MATCH = '{"reason":"text_does_not_match","status":"refused","v":1}';

// RFC 8032's first test key, which the local build signs with (packages/sealed/src/local.rs).
const LOCAL_VERDICT_KEY = 'ed25519:FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z';
const NETWORK = 'testnet';
const MPC = 'v1.signer-prod.testnet';
const OUTLAYER = 'outlayer.testnet';
const RECIPIENT = 'intents.near';
const NEP413_TAG = 2 ** 31 + 413;
const EXPIRES_IN_MS = 600_000;

const X25519_SPKI = Buffer.from('302a300506032b656e032100', 'hex');
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const failures = [];
const pass = (what) => console.log(`  ok: ${what}`);
const fail = (what) => {
  failures.push(what);
  console.log(`  FAIL: ${what}`);
};
const expect = (holds, what) => (holds ? pass(what) : fail(what));

function base58(text) {
  let n = 0n;
  for (const c of text) n = n * 58n + BigInt(ALPHABET.indexOf(c));
  const bytes = [];
  for (; n > 0n; n /= 256n) bytes.unshift(Number(n % 256n));
  return Buffer.from(bytes);
}

const x25519Key = (raw) => createPublicKey({ key: Buffer.concat([X25519_SPKI, raw]), format: 'der', type: 'spki' });
const ed25519Key = (text) => createPublicKey({ key: Buffer.concat([ED25519_SPKI, base58(text.slice('ed25519:'.length))]), format: 'der', type: 'spki' });
const rawPublic = (key) => Buffer.from(key.export({ format: 'jwk' }).x, 'base64url');

function x25519Pair() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return { privateKey, raw: rawPublic(publicKey) };
}

/** HKDF with no salt, as OutLayer's `eciesEncrypt`: an empty salt and RFC 5869's zeros are one key. */
function aeadKey(privateKey, peer) {
  return Buffer.from(hkdfSync('sha256', diffieHellman({ privateKey, publicKey: peer }), Buffer.alloc(0), HKDF_INFO, 32));
}

function encrypt(recipient, plaintext, aad) {
  const ephemeral = x25519Pair();
  const nonce = randomBytes(12);
  const cipher = createCipheriv('chacha20-poly1305', aeadKey(ephemeral.privateKey, x25519Key(recipient)), nonce, { authTagLength: 16 });
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([FORMAT]), ephemeral.raw, nonce, body, cipher.getAuthTag()]);
}

function decrypt(privateKey, blob, aad) {
  if (blob.length < OVERHEAD || blob[0] !== FORMAT) throw new Error('not a sealed blob');
  const decipher = createDecipheriv('chacha20-poly1305', aeadKey(privateKey, x25519Key(blob.subarray(1, 33))), blob.subarray(33, 45), { authTagLength: 16 });
  decipher.setAAD(aad);
  decipher.setAuthTag(blob.subarray(blob.length - 16));
  return Buffer.concat([decipher.update(blob.subarray(45, blob.length - 16)), decipher.final()]);
}

const bound = (domain, dao, id, replyKey) => Buffer.from(`${domain}\n${NETWORK}\n${dao}\n${id}\n${replyKey.toString('hex')}`);

/** borsh's u32 length then the bytes. */
function borshString(text) {
  const bytes = Buffer.from(text);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length);
  return Buffer.concat([length, bytes]);
}

/** kaap-core's `nep413_hash`, with no callback URL. */
function nep413Hash(message, nonce, recipient) {
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(NEP413_TAG);
  return createHash('sha256').update(Buffer.concat([tag, borshString(message), nonce, borshString(recipient), Buffer.from([0])])).digest();
}

/** Hashes to the payload, so kaap-core reads it, and carries a field its strict reader refuses. */
function plantedText(dao) {
  const nonce = randomBytes(32);
  const message = JSON.stringify({ signer_id: dao, deadline: '2030-01-01T00:00:00.000Z', intents: [], note: `planted-${randomBytes(8).toString('hex')}` });
  return { message, nonce, payload: nep413Hash(message, nonce, RECIPIENT) };
}

function signKind(dao, payload) {
  const args = JSON.stringify({ request: { path: dao, payload_v2: { Eddsa: payload.toString('hex') }, domain_id: 1 } });
  return { FunctionCall: { receiver_id: MPC, actions: [{ method_name: 'sign', args: Buffer.from(args).toString('base64'), deposit: '1', gas: '250000000000000' }] } };
}

/** The recorded answers with the proposal swapped for the planted one, in the two providers' shape. */
function plantedFixture(dir, payload) {
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const receiver = JSON.parse(Buffer.from(JSON.parse(fixture.exchanges.find((e) => e.params?.method_name === 'get_proposal').body).result.result).toString()).kind.FunctionCall.receiver_id;
  for (const exchange of fixture.exchanges) {
    if (exchange.params?.method_name === 'get_proposal') {
      const body = JSON.parse(exchange.body);
      const proposal = JSON.parse(Buffer.from(body.result.result).toString());
      body.result.result = [...Buffer.from(JSON.stringify({ ...proposal, kind: signKind(fixture.dao, payload) }))];
      exchange.body = JSON.stringify(body);
    }
    if (exchange.params?.account_id === receiver) exchange.params.account_id = MPC;
  }
  writeFileSync(join(dir, 'planted.json'), JSON.stringify(fixture));
  return fixture;
}

function localTrip(wasm) {
  const dir = mkdtempSync(join(tmpdir(), 'kaap-text-'));
  const wasmtime = process.env.KAAP_WASMTIME ?? join(homedir(), 'kaap-tools', 'wasmtime28');
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const text = plantedText(fixture.dao);
  plantedFixture(dir, text.payload);
  const logs = [];
  const run = async (input) => {
    const args = ['run', '-S', 'http', '--dir', `${dir}::/fixtures`, '--env', `NEAR_NETWORK_ID=${NETWORK}`, '--env', 'KAAP_FIXTURES=/fixtures/planted.json', wasm];
    const job = spawnSync(wasmtime, args, { input, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (job.status !== 0) throw new Error(`wasmtime exited ${job.status}: ${(job.stderr ?? '').slice(0, 300)}`);
    logs.push(job.stderr);
    return job.stdout;
  };
  return { dir, dao: fixture.dao, id: fixture.proposal_id, guard: 'guard.kaap.testnet', verdictKey: LOCAL_VERDICT_KEY, text, run, logs };
}

async function testnetTrip() {
  const { MILLI_NEAR, TGAS, accountFor, call, loadState, refusal, returned, txLink, viewFinal } = await import('./setup-demo-dao.mjs');
  const state = loadState();
  const dao = state.dao.account_id;
  const guard = state.guard.account_id;
  const verdictKey = await viewFinal(guard, 'accepted_key');
  const worker = accountFor(state.sealed.worker_account);
  const member = accountFor(state.dao.member.account_id);
  const text = plantedText(dao);
  const description = 'Sealed text round trip: a planted sign request';
  const filed = await call(member, dao, 'add_proposal', { proposal: { description, kind: signKind(dao, text.payload) } }, 30n * TGAS);
  if (filed.failure) throw new Error(`add_proposal failed in ${filed.hash}: ${refusal(filed.failure)}`);
  const id = returned(filed.outcome);
  console.log(`filed proposal #${id} on ${dao}: ${txLink(filed.hash)}`);
  const run = async (input) => {
    // All three limits written out on every run: an empty resource_limits object is never picked
    // up (OutLayer issue #31).
    const args = {
      source: { Project: { project_id: state.sealed.project_id, version_key: null } },
      input_data: input,
      response_format: 'Json',
      resource_limits: { max_instructions: 10_000_000_000, max_memory_mb: 128, max_execution_seconds: 60 },
    };
    const { hash, outcome, failure } = await call(worker, OUTLAYER, 'request_execution', args, 300n * TGAS, 20n * MILLI_NEAR);
    if (failure) throw new Error(`request_execution failed in ${hash}: ${refusal(failure)}`);
    console.log(`  run: ${txLink(hash)}`);
    return Buffer.from(outcome.status.SuccessValue, 'base64').toString('utf8');
  };
  return { dir: mkdtempSync(join(tmpdir(), 'kaap-text-')), dao, id, guard, verdictKey, text, run, logs: [] };
}

const refused = (output) => {
  const out = JSON.parse(output);
  return out.status === 'refused' && out.signature === undefined ? out.reason : null;
};

async function main() {
  const local = process.argv[2] === '--local';
  if (local && !process.argv[3]) throw new Error('usage: node scripts/text-roundtrip.mjs [--local <kaap-sealed-local.wasm>]');
  const trip = local ? localTrip(process.argv[3]) : await testnetTrip();
  const { dao, id, guard, verdictKey, text, run } = trip;
  console.log(`Kaap sealed text round trip, ${new Date().toISOString()}, ${local ? 'local wasmtime build, test keys' : 'OutLayer testnet'}: ${dao} #${id}`);

  console.log('1. the job\'s key');
  const answer = JSON.parse(await run('{"v":1,"op":"pubkey"}'));
  const jobKey = Buffer.from(answer.text_key ?? '', 'hex');
  console.log(`  text key ${answer.text_key}`);
  expect(answer.status === 'ok' && jobKey.length === 32, 'the job printed a 32-byte key');
  expect(answer.public_key === verdictKey, `it names the verdict key ${verdictKey}`);
  const signed = Buffer.concat([Buffer.from(TEXT_KEY_DOMAIN), jobKey]);
  expect(verify(null, signed, ed25519Key(verdictKey), Buffer.from(answer.signature ?? '', 'base64')), 'the verdict key signed it');
  const swapped = Buffer.concat([Buffer.from(TEXT_KEY_DOMAIN), randomBytes(32)]);
  expect(!verify(null, swapped, ed25519Key(verdictKey), Buffer.from(answer.signature ?? '', 'base64')), 'the same signature does not cover another key');

  console.log('2. the request');
  const memberKeys = x25519Pair();
  const textJson = JSON.stringify({ message: text.message, nonce: text.nonce.toString('base64'), recipient: RECIPIENT, standard: 'nep413' });
  const ciphertext = encrypt(jobKey, Buffer.from(textJson), bound(TEXT_DOMAIN, dao, id, memberKeys.raw));
  const judge = (blob, replyKey) =>
    JSON.stringify({ v: 1, network: NETWORK, guard, dao, proposal_id: id, expires_in_ms: EXPIRES_IN_MS, text_ciphertext: blob.toString('base64'), reply_key: replyKey.toString('hex') });
  const input = judge(ciphertext, memberKeys.raw);
  console.log(`  input bytes (${Buffer.byteLength(input)}): ${input}`);
  const clear = [text.message, Buffer.from(text.message).toString('base64'), JSON.parse(text.message).note, textJson];
  expect(!clear.some((part) => input.includes(part)), 'the request holds no part of the text in clear, plain or as base64');
  expect(!ciphertext.includes(Buffer.from(text.message)) && !ciphertext.includes(Buffer.from(JSON.parse(text.message).note)), 'nor do the ciphertext bytes');

  console.log('3. the verdict');
  const output = await run(input);
  const file = join(trip.dir, 'output.json');
  writeFileSync(file, output);
  const check = spawnSync(process.execPath, [CHECK_OUTPUT, file, '--dao', dao, '--id', String(id), '--network', NETWORK, '--guard', guard, '--key', verdictKey], { encoding: 'utf8' });
  const report = JSON.parse(check.stdout || '{}');
  expect(check.status === 0 && report.check === 'passed', `the signature verifies under the verdict key and the explanation hash matches the printed text (${report.bytes ?? '?'} bytes): ${report.why ?? 'checked by check-output.mjs'}`);
  const findings = report.verdict?.findings ?? [];
  console.log(`  risk ${report.verdict?.risk}, floor ${report.verdict?.floor}, ai ${report.verdict?.ai_status}, findings ${findings.join(', ')}`);
  expect(findings.includes('HASH_TEXT_DANGEROUS'), 'the planted text came back HASH_TEXT_DANGEROUS');

  console.log('4. the explanation');
  const explanation = JSON.parse(output).explanation ?? '';
  console.log(`  printed: ${explanation.slice(0, 48)}... (${explanation.length} characters)`);
  expect(explanation.startsWith(SEALED_PREFIX), 'it is sealed');
  const blob = Buffer.from(explanation.slice(SEALED_PREFIX.length), 'base64');
  const aad = bound(EXPLANATION_DOMAIN, dao, id, memberKeys.raw);
  try {
    console.log(`  the member reads: ${decrypt(memberKeys.privateKey, blob, aad).toString()}`);
    pass('it opens with the member\'s key');
  } catch {
    fail('it does not open with the member\'s key');
  }
  try {
    decrypt(x25519Pair().privateKey, blob, aad);
    fail('it opened with another key');
  } catch {
    pass('it stays shut for any other key');
  }
  const seen = [output, ...trip.logs].join('\n');
  expect(!clear.some((part) => seen.includes(part)), 'no part of the text is in anything the job printed or logged');

  console.log('5. the attacks');
  const tampered = Buffer.from(ciphertext);
  tampered[OVERHEAD] ^= 0x40;
  const reasons = {
    'a tampered ciphertext': refused(await run(judge(tampered, memberKeys.raw))),
    'the member\'s ciphertext with a thief\'s reply key': refused(await run(judge(ciphertext, x25519Pair().raw))),
    'a ciphertext for another key': refused(await run(judge(encrypt(x25519Pair().raw, Buffer.from(textJson), bound(TEXT_DOMAIN, dao, id, memberKeys.raw)), memberKeys.raw))),
  };
  for (const [attack, reason] of Object.entries(reasons)) expect(reason !== null, `${attack} is refused, no signature: ${reason}`);
  // Opens fine and parses, but a fresh nonce gives other bytes than the proposal asks to sign.
  // Anyone can send such a text, so the job must refuse it rather than judge it.
  const other = plantedText(dao);
  const otherJson = JSON.stringify({ message: other.message, nonce: other.nonce.toString('base64'), recipient: RECIPIENT, standard: 'nep413' });
  const mismatch = await run(judge(encrypt(jobKey, Buffer.from(otherJson), bound(TEXT_DOMAIN, dao, id, memberKeys.raw)), memberKeys.raw));
  let printed = mismatch;
  try {
    printed = JSON.stringify(JSON.parse(mismatch));
  } catch {}
  expect(printed === TEXT_DOES_NOT_MATCH, `a sealed text that does not hash to the payload is refused, no signature: ${printed.slice(0, 200)}`);

  console.log(failures.length === 0 ? 'RESULT: pass' : `RESULT: FAIL, ${failures.length} check(s): ${failures.join('; ')}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

try {
  await main();
} catch (e) {
  console.log(`RESULT: FAIL: ${e?.message ?? e}`);
  process.exit(1);
}
