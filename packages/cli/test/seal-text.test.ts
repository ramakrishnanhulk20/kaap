// `kaap seal-text` against a stand-in chain and a stand-in worker that opens the text with the
// sealed program's key and seals an explanation back: the encryption against the round-trip
// script's own code on fixed inputs, the judged answer printed as the worker's report with its
// explanation opened, a run hash of 42 characters included, an explanation carrying terminal controls, every refusal before anything
// reaches the worker (a guard on other code or one the providers differ on, no text key, a key the
// guard's key did not sign, a text that does not hash to the payload, a text too long for the run's
// input, counted with the sealed program's own longest verdict life), every answer the worker's POST /texts gives, with its model id when judged, and two
// privacy claims, each checked on the bytes: the request holds no plaintext, and nothing is written
// to a file while the command runs. The stand-in chain answers the guard's and registry's code and
// keys as both providers did live on 12 Nov. It does not cover the real worker or OutLayer (only a live testnet run reaches them), the
// sealed program's own opening in Rust (scripts/text-roundtrip.mjs --local checks Node against
// it), or a NEP-461 text that opens (none is planted yet).

import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, sign } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

import { MAX_EXPIRES_IN_MS } from '../src/caps.js';
import { Core } from '../src/core.js';
import { main } from '../src/main.js';
import { type HttpRequest, type HttpResponse, NetError, type Transport } from '../src/net.js';
import { NETWORKS } from '../src/rpc.js';
import { cryptoFresh, explanationContext, type Fresh, openSealed, OVERHEAD, rawPublicKey, SEALED_PREFIX, sealTo, textContext, type X25519Pair } from '../src/sealing.js';
import { carriesHostile } from './hostile.js';
import { fakeClock, REPO_ROOT } from './replay.js';

const DAO = 'kaap-dao-1029064008.testnet';
const GUARD = 'kaap-guard-1029061211.testnet';
const MPC = 'v1.signer-prod.testnet';
const ID = 41;
const WORKER = 'https://kaap.example.com';
const HEIGHT = 250_000_000;
const BLOCK_HASH = 'GQo1rZzQ9jrjQ5HNkDsAs2DcjUrsECEcu8vSPnpQnhCz';
const TIMESTAMP_NS = '1800000000000000000';
const RUN_TX = '9yqAAPBmFJLjSLhAH4HJBUXqY8RSmGT3rKmBVy7Sd8yz';
const MODEL = 'deepseek-ai/DeepSeek-V3.1';
const EXPLANATION = 'AI verified: the text signs an intent the description does not mention.\nIt pays an account this DAO has never paid.';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes: Buffer): string {
  let n = BigInt(`0x${bytes.toString('hex')}`);
  let out = '';
  while (n > 0n) {
    out = `${ALPHABET[Number(n % 58n)] ?? ''}${out}`;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

/** A key pair from 32 fixed bytes, through the PKCS #8 header of RFC 8410. */
function fixedKey(kind: 'x25519' | 'ed25519', fill: number) {
  const header = kind === 'x25519' ? '302e020100300506032b656e04220420' : '302e020100300506032b657004220420';
  return createPrivateKey({ key: Buffer.concat([Buffer.from(header, 'hex'), Buffer.alloc(32, fill)]), format: 'der', type: 'pkcs8' });
}
const x25519Fixed = (fill: number): X25519Pair => {
  const privateKey = fixedKey('x25519', fill);
  return { privateKey, publicKey: rawPublicKey(createPublicKey(privateKey)) };
};
const edPublic = (privateKey: ReturnType<typeof fixedKey>) => `ed25519:${base58(Buffer.from(String(createPublicKey(privateKey).export({ format: 'jwk' }).x), 'base64url'))}`;

const VERDICT_KEY = fixedKey('ed25519', 0x11);
const ACCEPTED_KEY = edPublic(VERDICT_KEY);
const PROGRAM = x25519Fixed(0x22);
const signTextKey = (key: Buffer, by = VERDICT_KEY) => sign(null, Buffer.concat([Buffer.from('kaap-text-key-v1\n'), key]), by).toString('base64');
const TEXT_KEY = {
  key: PROGRAM.publicKey.toString('hex'),
  signature: signTextKey(PROGRAM.publicKey),
  public_key: ACCEPTED_KEY,
  run_tx: 'CJzmwHfXrNSXsL8sUHAmNmKvmPkz2Bf5RjKrzNpJcFfA',
  build: 'e1192b28'.padEnd(64, '0'),
};

const MESSAGE = JSON.stringify({ signer_id: DAO, deadline: '2030-01-01T00:00:00.000Z', intents: [], note: 'planted-5f1e0c9a2b7d4e83' });
const NONCE = Buffer.alloc(32, 7).toString('base64');
const TEXT = { message: MESSAGE, nonce: NONCE, recipient: 'intents.near', standard: 'nep413' };

const core = await Core.load();
const PAYLOAD = core.nep413Hash(MESSAGE, NONCE, 'intents.near');

function signProposal(payload: string) {
  const args = Buffer.from(JSON.stringify({ request: { path: DAO, payload_v2: { Eddsa: payload }, domain_id: 1 } })).toString('base64');
  const kind = { FunctionCall: { receiver_id: MPC, actions: [{ method_name: 'sign', args, deposit: '1', gas: '250000000000000' }] } };
  return { id: ID, proposer: 'kaap-member-1029064001.testnet', description: 'a planted sign request', kind, status: 'InProgress', vote_counts: {}, votes: {}, submission_time: TIMESTAMP_NS };
}

const rpc = (result: unknown): HttpResponse => ({ status: 200, text: JSON.stringify({ jsonrpc: '2.0', id: 'kaap', result }) });
const viewResult = (value: unknown) => rpc({ result: [...Buffer.from(JSON.stringify(value))], logs: [], block_height: HEIGHT, block_hash: BLOCK_HASH });

const REGISTRY = 'kaap-registry-1029061211.testnet';
/** The 29 Oct guard's and registry's `view_account` and `view_access_key_list`, as both providers
 *  answered them live on 12 Nov: the code each record names, and no access key. */
const CONTRACTS: Record<string, { amount: string; code_hash: string; storage_usage: number }> = {
  [GUARD]: { amount: '9999705700160958800000000', code_hash: '77fyhhxdRnHzb8efe9HBYL8C3KcUpEbbRjLvrNyqoxbP', storage_usage: 221803 },
  [REGISTRY]: { amount: '10097032647510237400000000', code_hash: '65Y2p3NqwjE8z8oXdzvRPjDWux2SXmHrxxzAhpqwPdqY', storage_usage: 192797 },
};

/** What each provider answers for a contract's code and keys; `edit` may change one answer. */
type ContractEdit = (url: string, read: string, account: string, result: Record<string, unknown>) => void;

/** Both testnet providers, answering one final block, the guard's key, the DAO's proposal, and the
 *  29 Oct guard's and registry's code and keys. */
function chainAnswer(r: HttpRequest, acceptedKey: string, proposal: object, edit: ContractEdit = () => {}): HttpResponse | null {
  if (r.url !== NETWORKS.testnet.primary && r.url !== NETWORKS.testnet.secondary) return null;
  const { method, params } = JSON.parse(r.body ?? '{}') as { method?: string; params?: { request_type?: string; method_name?: string; account_id?: string } };
  if (method === 'block') return rpc({ header: { height: HEIGHT, hash: BLOCK_HASH, timestamp_nanosec: TIMESTAMP_NS }, chunks: [] });
  const contract = params?.account_id === undefined ? undefined : CONTRACTS[params.account_id];
  if (method === 'query' && contract && params?.account_id && (params.request_type === 'view_account' || params.request_type === 'view_access_key_list')) {
    const pinned = { block_height: HEIGHT, block_hash: BLOCK_HASH };
    const result: Record<string, unknown> = params.request_type === 'view_account' ? { ...contract, locked: '0', storage_paid_at: 0, ...pinned } : { keys: [], ...pinned };
    edit(r.url, params.request_type, params.account_id, result);
    return rpc(result);
  }
  if (method === 'query' && params?.request_type === 'call_function') {
    if (params.method_name === 'accepted_key' && params.account_id === GUARD) return viewResult(acceptedKey);
    if (params.method_name === 'get_proposal' && params.account_id === DAO) return viewResult(proposal);
    if (params.method_name === 'is_enrolled') return viewResult(params.account_id === GUARD);
  }
  return null;
}

/** The worker, standing in for the sealed program: it opens the text with the program's key, keeps
 *  what it opened in `opened`, and seals `said` back to the reply key as the explanation. */
function judging(opened: string[] = [], over: Record<string, unknown> = {}, said = EXPLANATION) {
  return (r: HttpRequest): HttpResponse => {
    const body = JSON.parse(r.body ?? '{}') as { dao: string; proposal_id: number; text_ciphertext: string; reply_key: string };
    const reply = Buffer.from(body.reply_key, 'hex');
    const text = openSealed(PROGRAM.privateKey, Buffer.from(body.text_ciphertext, 'base64'), textContext('testnet', body.dao, body.proposal_id, reply));
    assert.ok(text, 'the sealed program opens the text');
    opened.push(text.toString('utf8'));
    const explanation = `${SEALED_PREFIX}${sealTo(reply, Buffer.from(said), explanationContext('testnet', body.dao, body.proposal_id, reply), cryptoFresh).toString('base64')}`;
    const answer = { status: 'judged', run_tx: RUN_TX, risk: 'critical', floor: 'critical', findings: ['HASH_TEXT_DANGEROUS'], ai_status: 'verified', model_id: MODEL, explanation, veto: 'started' };
    return { status: 200, text: JSON.stringify({ ...answer, ...over }) };
  };
}

const requireCjs = createRequire(import.meta.url);

/** Every way Node's fs writes a file, watched until `stop`. Opens count only with a write flag. */
function watchWrites(): { writes: string[]; stop: () => void } {
  const writes: string[] = [];
  const undo: (() => void)[] = [];
  const fs = requireCjs('node:fs') as Record<string, unknown> & { promises: Record<string, unknown> };
  const forWriting = (flags: unknown) => flags !== undefined && flags !== 'r' && flags !== 0;
  const spy = (target: Record<string, unknown>, name: string, counts: (args: unknown[]) => boolean) => {
    const original = target[name];
    if (typeof original !== 'function') return;
    target[name] = function (this: unknown, ...args: unknown[]) {
      if (counts(args)) writes.push(`${name} ${String(args[0])}`);
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    };
    undo.push(() => {
      target[name] = original;
    });
  };
  const always = () => true;
  const sync = ['writeFileSync', 'appendFileSync', 'writeSync', 'writevSync', 'createWriteStream', 'copyFileSync', 'cpSync', 'renameSync', 'truncateSync', 'mkdirSync', 'mkdtempSync', 'symlinkSync', 'linkSync'];
  for (const name of [...sync, 'writeFile', 'appendFile', 'write', 'writev', 'copyFile', 'cp', 'rename', 'truncate', 'mkdir', 'mkdtemp', 'symlink', 'link']) spy(fs, name, always);
  spy(fs, 'openSync', (a) => forWriting(a[1]));
  spy(fs, 'open', (a) => forWriting(typeof a[1] === 'function' ? undefined : a[1]));
  for (const name of ['writeFile', 'appendFile', 'copyFile', 'cp', 'rename', 'truncate', 'mkdir', 'mkdtemp', 'symlink', 'link']) spy(fs.promises, name, always);
  spy(fs.promises, 'open', (a) => forWriting(a[1]));
  syncBuiltinESMExports();
  return {
    writes,
    stop: () => {
      for (const u of undo) u();
      syncBuiltinESMExports();
    },
  };
}

/** The system's random source, keeping each secret it hands out so a test can look for it. */
function recordingFresh(): { fresh: Fresh; secrets: Buffer[] } {
  const secrets: Buffer[] = [];
  const fresh: Fresh = {
    pair: () => {
      const pair = cryptoFresh.pair();
      secrets.push(Buffer.from(String(pair.privateKey.export({ format: 'jwk' }).d), 'base64url'));
      return pair;
    },
    bytes: (n) => cryptoFresh.bytes(n),
  };
  return { fresh, secrets };
}

interface RunOptions {
  textKey?: object | null;
  text?: object;
  proposal?: object;
  acceptedKey?: string;
  worker?: (r: HttpRequest) => HttpResponse;
  fresh?: Fresh;
  watch?: boolean;
  contracts?: ContractEdit;
}

/** A clone of the testnet records, today's and the 29 Oct one it names in `previous`, with
 *  `textKey` as the 29 Oct worker's text key record: these answers stand in for the 29 Oct guard,
 *  the one the DAO is enrolled with. */
function repoWith(textKey: object | null): string {
  const root = mkdtempSync(join(tmpdir(), 'kaap-seal-text-'));
  mkdirSync(join(root, 'deployments'));
  mkdirSync(join(root, 'packages', 'sealed'), { recursive: true });
  copyFileSync(join(REPO_ROOT, 'deployments', 'testnet.json'), join(root, 'deployments', 'testnet.json'));
  const { text_key: _recorded, ...record } = JSON.parse(readFileSync(join(REPO_ROOT, 'deployments', 'testnet-2026-10-29.json'), 'utf8')) as Record<string, unknown>;
  writeFileSync(join(root, 'deployments', 'testnet-2026-10-29.json'), JSON.stringify(textKey === null ? record : { ...record, text_key: textKey }));
  copyFileSync(join(REPO_ROOT, 'packages', 'sealed', 'testnet.json'), join(root, 'packages', 'sealed', 'testnet.json'));
  return root;
}

async function run(o: RunOptions = {}) {
  const root = repoWith(o.textKey === undefined ? TEXT_KEY : o.textKey);
  const file = join(root, 'text.json');
  writeFileSync(file, JSON.stringify(o.text ?? TEXT));
  const asked: HttpRequest[] = [];
  const transport: Transport = async (r) => {
    asked.push(r);
    const answer = chainAnswer(r, o.acceptedKey ?? ACCEPTED_KEY, o.proposal ?? signProposal(PAYLOAD), o.contracts);
    if (answer) return answer;
    if (r.method === 'POST' && r.url === `${WORKER}/texts`) return (o.worker ?? judging())(r);
    throw new NetError('unreachable', new URL(r.url).host);
  };
  const out: string[] = [];
  const err: string[] = [];
  const argv = ['seal-text', '--dao', DAO, '--id', String(ID), '--file', file, '--worker', WORKER];
  const env = { transport, clock: fakeClock(), loadCore: () => Core.load(), repoRoot: root, ...(o.fresh ? { fresh: o.fresh } : {}) };
  const watcher = o.watch ? watchWrites() : null;
  let code: number;
  try {
    code = await main(argv, env, { out: (t) => out.push(t), err: (t) => err.push(t) });
  } finally {
    watcher?.stop();
  }
  return { code, out: out.join('\n'), err: err.join('\n'), asked, toWorker: asked.filter((r) => r.url.startsWith(WORKER)), writes: watcher?.writes ?? [], file };
}

test("the encryption is the round-trip script's, byte for byte on fixed inputs, and each side opens the other's", () => {
  const source = readFileSync(join(REPO_ROOT, 'scripts', 'text-roundtrip.mjs'), 'utf8');
  const from = source.indexOf('const TEXT_KEY_DOMAIN = ');
  const to = source.indexOf("/** borsh's u32 length");
  assert.ok(from > 0 && to > from, 'the script still holds its constants and crypto helpers where this test cuts them out');
  const ephemeral = x25519Fixed(0x33);
  const nonce = Buffer.alloc(12, 0x44);
  // The script's own lines, run with its two random sources fixed: its X25519 pair and its nonce.
  const script = runInNewContext(`${source.slice(from, to)}\n({ encrypt, decrypt, bound, TEXT_DOMAIN, EXPLANATION_DOMAIN });`, {
    Buffer,
    console,
    createPublicKey,
    createCipheriv,
    createDecipheriv,
    diffieHellman,
    hkdfSync,
    generateKeyPairSync: () => ({ publicKey: createPublicKey(ephemeral.privateKey), privateKey: ephemeral.privateKey }),
    randomBytes: (n: number) => {
      assert.equal(n, 12);
      return nonce;
    },
  }) as {
    encrypt(recipient: Buffer, plaintext: Buffer, aad: Buffer): Buffer;
    decrypt(privateKey: X25519Pair['privateKey'], blob: Buffer, aad: Buffer): Buffer;
    bound(domain: string, dao: string, id: number, replyKey: Buffer): Buffer;
    TEXT_DOMAIN: string;
    EXPLANATION_DOMAIN: string;
  };

  const member = x25519Fixed(0x55);
  const aad = textContext('testnet', DAO, ID, member.publicKey);
  const back = explanationContext('testnet', DAO, ID, member.publicKey);
  assert.equal(aad.toString(), script.bound(script.TEXT_DOMAIN, DAO, ID, member.publicKey).toString());
  assert.equal(back.toString(), script.bound(script.EXPLANATION_DOMAIN, DAO, ID, member.publicKey).toString());

  const plain = Buffer.from(JSON.stringify(TEXT));
  const fixed: Fresh = { pair: () => ephemeral, bytes: () => nonce };
  const ours = sealTo(PROGRAM.publicKey, plain, aad, fixed);
  assert.equal(ours.toString('hex'), script.encrypt(PROGRAM.publicKey, plain, aad).toString('hex'));
  assert.equal(ours.length, plain.length + OVERHEAD);
  assert.equal(ours.subarray(0, 1 + 32 + 12).toString('hex'), `01${ephemeral.publicKey.toString('hex')}${nonce.toString('hex')}`);

  assert.equal(script.decrypt(PROGRAM.privateKey, sealTo(PROGRAM.publicKey, plain, aad, cryptoFresh), aad).toString(), plain.toString(), 'the script opens what the CLI seals');
  const explanation = script.encrypt(member.publicKey, Buffer.from(EXPLANATION), back);
  assert.equal(openSealed(member.privateKey, explanation, back)?.toString(), EXPLANATION, 'the CLI opens what the script seals');
  assert.equal(openSealed(member.privateKey, explanation, aad), null, 'not under the text context');
  assert.equal(openSealed(x25519Fixed(0x77).privateKey, explanation, back), null, 'not with another key');
  const changed = Buffer.from(explanation);
  changed[OVERHEAD] = (changed[OVERHEAD] ?? 0) ^ 0x40;
  assert.equal(openSealed(member.privateKey, changed, back), null, 'not with a changed byte');
});

test('a sealed text comes back judged: the verdict, the veto and the explanation opened with the reply key', async () => {
  const opened: string[] = [];
  const { code, out, err, toWorker } = await run({ worker: judging(opened) });
  assert.equal(err, '');
  assert.equal(code, 0);
  assert.equal(toWorker.length, 1);
  assert.match(out, /^Kaap on testnet: deployment record deployments\/testnet-2026-10-29\.json \(an earlier deployment, not the current deployments\/testnet\.json, deployed 2026-10-29T06:12:11Z\): guard kaap-guard-1029061211\.testnet, /m, 'the record whose guard the DAO is enrolled with');
  assert.deepEqual(opened.map((t) => JSON.parse(t) as unknown), [TEXT], 'the sealed program reads the text as the file holds it');
  assert.equal(out.split('\n').filter((l) => /^ {2}pass {2}(guard|registry) (code|keys): kaap-(guard|registry)-1029061211\.testnet /.test(l)).length, 4, 'the 29 Oct contracts are checked');
  assert.match(out, new RegExp(`signed by the guard's accepted key ${ACCEPTED_KEY} \\(checked here with ed25519\\)`));
  assert.match(out, new RegExp(`hashes to ${PAYLOAD}, the payload proposal ${ID} asks to sign`));
  for (const line of ['  risk: critical', '  floor: critical', '  findings: HASH_TEXT_DANGEROUS', `  AI: verified, model ${MODEL}`, `  sealed run: https://testnet.nearblocks.io/txns/${RUN_TX}`]) {
    assert.ok(out.split('\n').includes(line), line);
  }
  assert.match(out, /^ {2}veto: started /m);
  assert.match(out, /^ {2}AI verified: the text signs an intent the description does not mention\.\n {2}It pays an account this DAO has never paid\.$/m);
  assert.match(out, /^what the worker at https:\/\/kaap\.example\.com reported, not yet checked against the chain\n {2}risk: critical$/m, "the answer is the worker's report");
  assert.match(out, /^confirm it from the chain: kaap verify kaap-dao-1029064008\.testnet 41 --network testnet$/m);
  assert.doesNotMatch(out, /verified by Kaap|^verdict$/m);

  // A run hash of 42 characters: 32 bytes whose first is zero.
  const shortRun = '1tJ93RwaVfE1PEMxd5rpZZuPtLCwbEaDCrNBjvAWVD';
  const quiet = await run({ worker: judging([], { veto: 'not_needed', risk: 'low', floor: 'low', findings: [], ai_status: 'unavailable', model_id: null, run_tx: shortRun }) });
  assert.equal(quiet.code, 0, quiet.err);
  for (const line of ['  veto: not needed', '  findings: none', '  AI: unavailable, no model answered', `  sealed run: https://testnet.nearblocks.io/txns/${shortRun}`]) assert.ok(quiet.out.split('\n').includes(line), line);
});

test("an explanation that carries terminal controls and imitates Kaap's lines prints each of its lines indented under its heading, escaped", async () => {
  const said = 'ok\u001b[2J\nconfirm it from the chain: kaap verify x 1\r‮evil​\n\nThe verdict is verified.';
  const { code, out } = await run({ worker: judging([], {}, said) });
  assert.equal(code, 0, out);
  assert.ok(!carriesHostile(out), out);
  const lines = out.split('\n');
  const at = lines.findIndex((l) => l.startsWith('explanation'));
  assert.deepEqual(lines.slice(at + 1, at + 6), ['  ok\\u{1b}[2J', '  confirm it from the chain: kaap verify x 1\\r\\u{202e}evil\\u{200b}', '  ', '  The verdict is verified.', '']);
});

test("a text too long for the sealed run's 32 KiB input is refused before any request, counted as the worker counts it", async () => {
  const long = (length: number) => {
    const message = 'a'.repeat(length);
    return { text: { ...TEXT, message }, proposal: signProposal(core.nep413Hash(message, NONCE, 'intents.near')) };
  };
  const inputs: number[] = [];
  const worker = (r: HttpRequest) => {
    // The worker's own count of the run input (packages/worker/src/judge.ts `input`), at its default verdict life.
    const body = JSON.parse(r.body ?? '{}') as { dao: string; proposal_id: number; text_ciphertext: string; reply_key: string };
    const input = { v: 1, network: 'testnet', guard: GUARD, dao: body.dao, proposal_id: body.proposal_id, expires_in_ms: 600_000, text_ciphertext: body.text_ciphertext, reply_key: body.reply_key };
    inputs.push(Buffer.byteLength(JSON.stringify(input)));
    return judging()(r);
  };
  const fits = await run({ ...long(24_000), worker });
  assert.equal(fits.code, 0, fits.err);
  assert.ok(inputs.length === 1 && (inputs[0] ?? Infinity) <= 32_768, `the worker reads ${inputs[0]} bytes`);
  const over = await run({ ...long(24_500), worker });
  assert.equal(over.code, 1);
  assert.equal(over.out, '');
  assert.match(over.err, /^the text is too long for Kaap's sealed program: with it, the sealed run's input would be \d{5} bytes, and the program reads at most 32768 \(about 24 KiB of text\)\. Nothing was sent\.$/);
  assert.equal(over.toWorker.length, 0);
});

test("the run's input is counted with the longest verdict life the sealed program accepts, 15 minutes", () => {
  // The worker writes the expiry into the run's input; this command sends none, and must not count
  // with a longer one than the sealed program takes.
  const source = readFileSync(join(REPO_ROOT, 'packages', 'sealed', 'src', 'input.rs'), 'utf8');
  const sealed = /^pub const MAX_EXPIRES_IN_MS: u64 = ([\d_]+);$/m.exec(source)?.[1];
  assert.ok(sealed, 'input.rs still names MAX_EXPIRES_IN_MS');
  assert.equal(MAX_EXPIRES_IN_MS, Number(sealed.replaceAll('_', '')));
  assert.ok(MAX_EXPIRES_IN_MS <= 900_000);
});

test("the request to the worker holds no plaintext: the text is in none of the bytes sent, plain or as base64", async () => {
  const { code, toWorker, file } = await run();
  assert.equal(code, 0);
  const [request] = toWorker;
  assert.ok(request?.body);
  const body = JSON.parse(request.body) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body), ['dao', 'proposal_id', 'text_ciphertext', 'reply_key']);
  assert.deepEqual([body['dao'], body['proposal_id']], [DAO, ID]);
  assert.match(String(body['reply_key']), /^[0-9a-f]{64}$/);
  const sent = Buffer.from(request.body);
  const ciphertext = Buffer.from(String(body['text_ciphertext']), 'base64');
  const note = 'planted-5f1e0c9a2b7d4e83';
  const parts = [MESSAGE, note, NONCE, JSON.stringify(TEXT), readFileSync(file, 'utf8')];
  for (const part of parts) {
    for (const form of [part, Buffer.from(part).toString('base64'), Buffer.from(part).toString('hex')]) {
      assert.ok(!sent.includes(Buffer.from(form)), `the request does not hold ${form.slice(0, 24)}...`);
    }
    assert.ok(!ciphertext.includes(Buffer.from(part)), 'nor do the ciphertext bytes');
  }
});

test('the reply secret and the text are never written to a file or printed while the command runs', async () => {
  const { fresh, secrets } = recordingFresh();
  const { code, out, err, writes, toWorker } = await run({ fresh, watch: true });
  assert.equal(code, 0);
  assert.deepEqual(writes, [], 'no file was written');
  assert.equal(secrets.length, 2, 'one reply key pair and one ephemeral pair');
  const seen = [out, err, ...toWorker.map((r) => r.body ?? '')].join('\n');
  for (const secret of secrets) {
    for (const form of [secret.toString('hex'), secret.toString('base64'), secret.toString('base64url')]) assert.ok(!seen.includes(form), 'a secret is printed or sent');
  }
  assert.ok(!out.includes('planted-5f1e0c9a2b7d4e83') && !err.includes('planted-5f1e0c9a2b7d4e83'), 'the text is printed');
});

test('no recorded text key is refused before anything reaches the worker, saying the worker has not published it', async () => {
  // Which record's key counts is known only once the chain says which guard the DAO is enrolled
  // with, so the only requests made are those reads.
  const { code, out, err, asked, toWorker } = await run({ textKey: null });
  assert.equal(code, 1);
  assert.equal(out, '');
  assert.match(err, /^Kaap's worker has not published the key a text is sealed to on testnet yet \(no text_key in deployments\/testnet-2026-10-29\.json\)\. Nothing was sent\.$/);
  assert.equal(toWorker.length, 0);
  assert.ok(asked.every((r) => r.method === 'POST' && /"method":"(block|query)"/.test(r.body ?? '') && !/"method_name":"get_proposal"/.test(r.body ?? '')), 'only the final block and the enrolment are read');
});

test('a guard that is not the recorded build, or that the providers differ on, stops seal-text before anything is sealed or sent', async () => {
  const otherCode: ContractEdit = (_url, read, account, result) => {
    if (read === 'view_account' && account === GUARD) result['code_hash'] = CONTRACTS[REGISTRY]?.code_hash;
  };
  const secondDiffers: ContractEdit = (url, read, account, result) => {
    if (url === NETWORKS.testnet.secondary && read === 'view_access_key_list' && account === GUARD) result['keys'] = [{ public_key: ACCEPTED_KEY, access_key: { nonce: 1, permission: 'FullAccess' } }];
  };
  for (const [why, contracts, exit, says] of [
    ['another build', otherCode, 5, /^ {2}fail {2}guard code: kaap-guard-1029061211\.testnet runs code with sha256 4b73d851\.\.\.539f, not the recorded build 5adbadb5\.\.\.ec76 \(two providers, block 250000000\)$/m],
    ['providers that differ', secondDiffers, 6, /^ {2}unread {2}guard keys: kaap-guard-1029061211\.testnet could not be read at block 250000000: the two providers disagree on the access keys of kaap-guard-1029061211\.testnet$/m],
  ] as const) {
    const { code, out, err, toWorker } = await run({ contracts });
    assert.equal(code, exit, `${why}\n${err}`);
    assert.equal(out, '', why);
    assert.equal(toWorker.length, 0, `${why}: the worker received a request`);
    assert.match(err, says, why);
    assert.equal(err.split('\n').filter((l) => /^ {2}(pass|fail|unread) {2}(guard|registry) (code|keys): /.test(l)).length, 4, why);
    assert.match(err, /Nothing was sent\.$/, why);
  }
});

test("a text key the guard's key did not sign is refused before any request to the worker", async () => {
  const flipped = Buffer.from(TEXT_KEY.signature, 'base64');
  flipped[0] = (flipped[0] ?? 0) ^ 1;
  const other = fixedKey('ed25519', 0x99);
  for (const [why, o, says] of [
    ['a changed signature bit', { textKey: { ...TEXT_KEY, signature: flipped.toString('base64') } }, /signature is not valid for the guard's accepted key/],
    ['another key signed it', { textKey: { ...TEXT_KEY, signature: signTextKey(PROGRAM.publicKey, other) } }, /signature is not valid for the guard's accepted key/],
    ['the signature covers another text key', { textKey: { ...TEXT_KEY, key: x25519Fixed(0x98).publicKey.toString('hex') } }, /signature is not valid for the guard's accepted key/],
    ['the record names another signer', { textKey: { ...TEXT_KEY, public_key: edPublic(other), signature: signTextKey(PROGRAM.publicKey, other) } }, /names ed25519:\S+ as its signer, but the guard accepts/],
    ['the guard now accepts another key', { acceptedKey: edPublic(other) }, /names ed25519:\S+ as its signer, but the guard accepts/],
  ] as const) {
    const { code, out, err, toWorker } = await run(o);
    assert.equal(code, 1, why);
    assert.equal(out, '', why);
    assert.match(err, says, why);
    assert.match(err, /Nothing was sent\.$/, why);
    assert.equal(toWorker.length, 0, why);
  }
});

test("a text that does not hash to the proposal's payload is refused before any request to the worker", async () => {
  const transfer = { ...signProposal(PAYLOAD), kind: { Transfer: { token_id: '', receiver_id: 'a.testnet', amount: '1' } } };
  for (const [why, o, says] of [
    ['another message', { text: { ...TEXT, message: MESSAGE.replace('planted', 'changed') } }, new RegExp(`hashes to [0-9a-f]{64} \\(nep413\\), but proposal ${ID} asks to sign ${PAYLOAD}: it is not this proposal's text`)],
    ['another payload', { proposal: signProposal('ab'.repeat(32)) }, /but proposal 41 asks to sign (ab){32}: it is not this proposal's text/],
    ['the same bytes read as NEP-461', { text: { ...TEXT, message: Buffer.from(MESSAGE).toString('base64'), standard: 'nep461' } }, /\(nep461\), but proposal 41 asks to sign/],
    ['a proposal that asks for no signature', { proposal: transfer }, /asks for no signature, so no text can be behind it/],
    ['a nonce that is not 32 bytes', { text: { ...TEXT, nonce: Buffer.alloc(31).toString('base64') } }, /nonce is not 32 bytes of base64/],
    ['a field the sealed program does not read', { text: { ...TEXT, memo: 'x' } }, /is not one text: a JSON object with exactly message, nonce, recipient and standard/],
  ] as const) {
    const { code, out, err, toWorker } = await run(o);
    assert.equal(code, 1, why);
    assert.equal(out, '', why);
    assert.match(err, says, why);
    assert.ok(!err.includes('planted-5f1e0c9a2b7d4e83'), `${why}: the refusal quotes the text`);
    assert.equal(toWorker.length, 0, why);
  }
});

test('every answer the worker gives gets its own plain sentence and exit code', async () => {
  const answer = (status: number, body: unknown, retryAfterMs?: number) => () => ({ status, text: typeof body === 'string' ? body : JSON.stringify(body), ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
  const elsewhere = (r: HttpRequest): HttpResponse => {
    const good = JSON.parse(judging()(r).text) as Record<string, unknown>;
    const reply = x25519Fixed(0x12).publicKey;
    return { status: 200, text: JSON.stringify({ ...good, explanation: `${SEALED_PREFIX}${sealTo(reply, Buffer.from(EXPLANATION), explanationContext('testnet', DAO, ID, reply), cryptoFresh).toString('base64')}` }) };
  };
  for (const [worker, exit, says] of [
    [answer(400, { error: 'bad_request' }), 1, /refused the request as malformed \(bad_request\): this CLI and the worker disagree on its shape/],
    [answer(404, { error: 'dao_not_watched' }), 3, /does not watch kaap-dao-1029064008\.testnet: it takes texts only for the DAOs it guards/],
    [answer(404, { error: 'not_found' }), 1, /has no \/texts route: it runs an older worker than this command needs/],
    [answer(409, { error: 'proposal_not_open' }), 1, /proposal 41 of kaap-dao-1029064008\.testnet is no longer open for votes/],
    [answer(429, { error: 'too_many_requests' }, 1_200_000), 1, /too many texts from this address in the last hour, again in about 20 minutes/],
    [answer(503, { error: 'over_budget' }), 1, /its spending caps allow no more sealed runs right now/],
    [answer(502, { error: 'run_failed', reason: 'text_not_opened' }), 1, /the sealed run for proposal 41 of kaap-dao-1029064008\.testnet gave no verdict \(text_not_opened\), so there is nothing to show and nothing was vetoed/],
    [answer(502, { error: 'run_failed', reason: '\u001b[31mred' }), 1, /gave no verdict, so there is nothing to show/],
    [answer(502, { error: 'run_failed', reason: 'text_does_not_match' }), 1, /the sealed program refused the text for proposal 41 of kaap-dao-1029064008\.testnet: it does not hash to the payload the proposal asks to sign, so Kaap refused it and nothing was vetoed/],
    [answer(500, { error: 'internal' }), 1, /answered HTTP 500 \(internal\), an answer this command does not know/],
    [answer(200, 'not json'), 1, /answered 200, but not with a judged text/],
    [answer(200, { status: 'judged' }), 1, /answered 200, but not with a judged text/],
    [judging([], { extra: 'field' }), 1, /answered 200, but not with a judged text/],
    [elsewhere, 1, /does not open with the reply key made for this request, so none of the answer is shown/],
    [() => { throw new NetError('timeout', 'kaap.example.com'); }, 1, /did not answer within 5 minutes\. Its sealed run may still finish/],
  ] as const) {
    const { code, out, err, toWorker } = await run({ worker });
    assert.equal(toWorker.length, 1, String(says));
    assert.equal(code, exit, String(says));
    assert.equal(out, '', String(says));
    assert.match(err, says);
    assert.doesNotMatch(err, /\u001b/, 'no control character reaches the terminal');
  }
});
