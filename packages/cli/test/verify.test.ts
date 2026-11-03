// `kaap verify` against a recorded run on the M1 testnet DAO's proposal 2 (the disguised payment the
// guard rejected on 29 Oct): every check passing, then the same answers with a flipped signature
// bit, a wrong wasm hash and a wrong caller in OutLayer's attestation, a tampered receivers hash, a
// receiver whose code differs at the verdict's block, and the live providers disagreeing on a
// receiver's code now, each failing its check and the command; a receiver redeployed since the
// verdict, which warns; no verdict for a proposal; what the command reads; the accounts the
// receivers hash covers, on the sealed job's own cases; a verdict from another decoder warning
// without failing; and the verdict reader and the ed25519 check on their own. It does not cover the
// Intel quote inside the
// attestation (the CLI does not check it and says so), a receivers hash over a called contract
// recorded live (the M1 payment is native NEAR, so it covers the DAO alone), the live chain changing
// after the recording (DONE MEANS 3 runs live), or a verdict with an AI answer (none is recorded on
// testnet yet).

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import { Core } from '../src/core.js';
import { main } from '../src/main.js';
import type { HttpRequest, Transport } from '../src/net.js';
import { NETWORKS } from '../src/rpc.js';
import { base58, BadVerdict, decodeVerdict, ed25519Valid, edKeyBytes, signedBytes } from '../src/verdict.js';
import { calledAccounts, decoderCheck, render } from '../src/verify.js';
import { fakeClock, load, replay, REPO_ROOT } from './replay.js';

const GUARD_KEY = 'ed25519:4gaYx4kPxaNDc5grjrucuJfxV97gNiAr8TuCwUAuonuN';

/** The recording holds the blocks a passing run read. A run that keeps looking reads the rest of
 *  its window, which the archival node answers here as heights with no block, and the chunks of a
 *  recorded block the passing run did not need to open as chunks with no transactions. */
function wholeWindow(t: Transport): Transport {
  return async (r) => {
    try {
      return await t(r);
    } catch (e) {
      const method = params(r).method;
      if (r.url !== NETWORKS.testnet.archival || (method !== 'block' && method !== 'chunk')) throw e;
      const answer = method === 'block' ? { error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_BLOCK' } } } : { result: { transactions: [] } };
      return { status: 200, text: JSON.stringify({ jsonrpc: '2.0', id: 'kaap', ...answer }) };
    }
  };
}

async function run(edit?: (r: HttpRequest, text: string) => string, wrap: (t: Transport) => Transport = (t) => t) {
  const fx = load('verify-m1-2.json');
  const log: HttpRequest[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(fx.argv, { transport: wrap(wholeWindow(replay(fx, log, edit))), clock: fakeClock(), loadCore: () => Core.load(), repoRoot: REPO_ROOT }, { out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, out: out.join('\n'), err: err.join('\n'), log };
}

/** A changed verdict has a hash the guard never voted with, which the recording cannot hold: both
 *  providers answer its `veto_result` with null, at the recorded block. */
function neverVoted(t: Transport): Transport {
  const recorded = load('verify-m1-2.json').exchanges.filter((e) => e.body?.includes('"method_name":"veto_result"'));
  return async (r) => {
    if (params(r).params?.method_name !== 'veto_result') return t(r);
    const body = recorded.find((e) => e.url === r.url)?.body;
    const answer = await t(body ? { ...r, body } : r);
    const view = JSON.parse(answer.text) as { result: { result: number[] } };
    view.result.result = [...Buffer.from('null', 'utf8')];
    return { ...answer, text: JSON.stringify(view) };
  };
}

const params = (r: HttpRequest) => (JSON.parse(r.body ?? '{}') as { method?: string; params?: { request_type?: string; method_name?: string; account_id?: string } });

/** Changes the JSON a view returned, on both providers alike, so the change is not a disagreement. */
function editView(method: string, change: (value: unknown) => unknown) {
  return (r: HttpRequest, text: string) => {
    if (params(r).params?.method_name !== method) return text;
    const answer = JSON.parse(text) as { result: { result: number[] } };
    const value: unknown = JSON.parse(Buffer.from(answer.result.result).toString('utf8'));
    answer.result.result = [...Buffer.from(JSON.stringify(change(value)), 'utf8')];
    return JSON.stringify(answer);
  };
}

/** Changes the attestation of the verdict's own run. */
function editAttestation(change: (a: Record<string, unknown>) => void) {
  return (r: HttpRequest, text: string) => {
    if (!r.url.endsWith('/attestations/by-tx/7vT7uwgwggGUc3CpNgLApgyjFS4s65KTfZTbMF2enx6T')) return text;
    const a = JSON.parse(text) as Record<string, unknown>;
    change(a);
    return JSON.stringify(a);
  };
}

/** The first output line, trimmed, that `has` matches. */
const line = (out: string, has: RegExp) => out.split('\n').map((l) => l.trim()).find((l) => has.test(l)) ?? '';

test('the M1 attack verdict passes every check, down to the attested run that printed the guard key', async () => {
  const { code, out } = await run();
  assert.equal(code, 0, out);
  assert.match(out, /^kaap verify kaap-dao-1029064008\.testnet #2 on testnet$/m);
  assert.match(out, /risk critical, floor critical, findings DESC_CONTRADICTS, UNKNOWN_VALUE, AI unavailable/);
  assert.match(out, /pass {2}sealed signature: valid for the guard's accepted key ed25519:4gaYx4kPxaNDc5grjrucuJfxV97gNiAr8TuCwUAuonuN/);
  assert.match(out, /pass {2}kind hash: kaap-core recomputes c6ca399d/);
  assert.match(out, /pass {2}policy hash: kaap-core recomputes .* at block 275266740/);
  assert.match(out, /pass {2}receivers hash: kaap-core recomputes d159b011\.\.\.f3e0 from the code of kaap-dao-1029064008\.testnet at block 275266740 \(archival node, one provider: no independent archive keeps block 275266740\)$/m);
  assert.match(out, /pass {2}receivers now: the code of kaap-dao-1029064008\.testnet at block \d+ is unchanged since the verdict \(two providers\)$/m);
  assert.match(out, /pass {2}decoder: the verdict names kaap-core 0\.1\.0, the decoder this CLI runs$/m);
  assert.match(out, /pass {2}sealed run: transaction 7vT7uwgwggGUc3CpNgLApgyjFS4s65KTfZTbMF2enx6T returned exactly this verdict and signature/);
  assert.match(out, /pass {2}the run: OutLayer's attestation names the same project, caller kaap-worker-1029053612\.testnet and wasm 0099d7b7/);
  assert.match(out, /pass {2}the key's run 7HvniWe5\.\.\.: its attested output prints the guard's accepted key/);
  assert.doesNotMatch(out, /^ {2}(fail|warn)/m);
  assert.match(out, /^not checked here\n {2}the Intel TDX quote .* not carry; OutLayer's record: https:\/\/testnet-api\.outlayer\.ai\/attestations\/by-tx\/7vT7uw/m);
  assert.match(out, /AI evidence: none\. .*https:\/\/cloud\.near\.ai\/verify/);
  assert.match(out, /the guard voted to reject with this verdict, and the DAO took the vote/);
  assert.match(out, /^result: all 18 checks pass$/m);
});

test('a tampered receivers hash in the verdict fails the receivers check', async () => {
  const tamper = editView('latest', (value) => {
    const record = value as { verdict: string };
    const bytes = Buffer.from(record.verdict, 'base64');
    const at = bytes.indexOf(Buffer.from(decodeVerdict(bytes).receivers_hash, 'hex'));
    bytes[at] = (bytes[at] ?? 0) ^ 1;
    return { ...record, verdict: bytes.toString('base64') };
  });
  const { code, out, err } = await run(tamper, neverVoted);
  assert.equal(code, 5, `${out}${err}`);
  assert.match(line(out, /receivers hash/), /^fail {2}receivers hash: kaap-core gives d159b011\.\.\.f3e0 from the code of kaap-dao-1029064008\.testnet at block 275266740 \(archival node, one provider: no independent archive keeps block 275266740\), the verdict says d059b011\.\.\.f3e0$/);
  assert.match(out, /the guard has not voted with this verdict/);
});

test('a called contract whose code at the verdict\'s block is not what the verdict pinned fails the receivers check', async () => {
  const redeployed = (r: HttpRequest, text: string) => {
    if (r.url !== NETWORKS.testnet.archival || params(r).params?.request_type !== 'view_account') return text;
    const answer = JSON.parse(text) as { result: { code_hash: string } };
    answer.result.code_hash = '8RMeZ5cXDap6TENxaJKtigRYf3n139iHmTRe8ZUNey6N';
    return JSON.stringify(answer);
  };
  const { code, out } = await run(redeployed);
  assert.equal(code, 5, out);
  assert.match(line(out, /receivers hash/), /^fail {2}receivers hash: kaap-core gives .* the verdict says d159b011\.\.\.f3e0$/);
  assert.match(line(out, /sealed signature/), /^pass/, 'the signed verdict itself is untouched');
});

/** Changes the DAO's code hash at the final block in the live providers' `view_account` answers.
 *  `when` picks which of a provider's reads change, counted from 1 per provider. */
function liveCode(codeHash: string, providers: string[], when: (n: number) => boolean) {
  const seen = new Map<string, number>();
  return (r: HttpRequest, text: string) => {
    if (!providers.includes(r.url) || params(r).params?.request_type !== 'view_account') return text;
    const n = (seen.get(r.url) ?? 0) + 1;
    seen.set(r.url, n);
    if (!when(n)) return text;
    const answer = JSON.parse(text) as { result: { code_hash: string } };
    answer.result.code_hash = codeHash;
    return JSON.stringify(answer);
  };
}

test('a DAO redeployed since the verdict warns in receivers now and fails nothing', async () => {
  // Sputnik 3.1's code hash, so the DAO is still recognised and only the redeploy shows.
  const t = NETWORKS.testnet;
  const { code, out } = await run(liveCode('4zSoHkLjJWZm34Psd4Eq2WUXHELt6LxtKmUXpsZWAECp', [t.primary, t.secondary], () => true));
  assert.equal(code, 0, out);
  assert.match(line(out, /receivers now/), /^warn {2}receivers now: changed since the verdict: kaap-dao-1029064008\.testnet \(block \d+, two providers\); a redeploy after the verdict does not forge it/);
  assert.match(line(out, /receivers hash/), /^pass/, 'the code at the verdict\'s block is untouched');
  assert.match(out, /^result: no check fails; 17 pass and 1 warns$/m);
});

test('the two live providers disagreeing on a receiver\'s code now fails receivers now', async () => {
  // The DAO is read at the final block twice: once to recognise it, then by receivers now. The
  // second provider changes its answer for the second read only.
  const t = NETWORKS.testnet;
  const { code, out } = await run(liveCode('4zSoHkLjJWZm34Psd4Eq2WUXHELt6LxtKmUXpsZWAECp', [t.secondary], (n) => n === 2));
  assert.equal(code, 5, out);
  assert.match(line(out, /receivers now/), /^fail {2}receivers now: the two providers disagree on the code of kaap-dao-1029064008\.testnet at block \d+$/);
});

test('the receivers hash covers the accounts the sealed job reads, and gives its bytes', async () => {
  // The cases of packages/sealed/tests/reads.rs `called_accounts`, and the pair list WO-03d pinned
  // against `kaap_sealed::reads::receivers_hash`, handed over unsorted.
  const core = await Core.load();
  const dao = 'd.sputnikv2.testnet';
  const cases: [string, string[] | null][] = [
    ['{"Transfer":{"token_id":"","receiver_id":"new.testnet","amount":"1","msg":null}}', [dao]],
    ['{"Transfer":{"token_id":"usdc.testnet","receiver_id":"a.testnet","amount":"1","msg":null}}', [dao, 'usdc.testnet']],
    ['{"Transfer":{"token_id":"usdc.testnet","receiver_id":"a.testnet","amount":"1","msg":"x"}}', [dao, 'usdc.testnet', 'a.testnet']],
    ['{"FunctionCall":{"receiver_id":"app.testnet","actions":[]}}', [dao, 'app.testnet']],
    ['{"UpgradeRemote":{"receiver_id":"app.testnet","method_name":"up","hash":"x"}}', [dao, 'app.testnet']],
    ['{"FunctionCall":{"receiver_id":"d.sputnikv2.testnet","actions":[]}}', [dao]],
    ['"Vote"', [dao]],
    ['{"FunctionCall":{"receiver_id":"Not An Account","actions":[]}}', null],
  ];
  for (const [kind, want] of cases) assert.deepEqual(calledAccounts(core, dao, kind), want, kind);
  const pinned: [string, string][] = [
    ['nori4qx.tanssg2.testnet', '12AiGxHGtiSBJenkwsqqrV5Z1XJB1GhWkJRivrQB3m6Y'],
    ['corm1gu.sputnikv2.testnet', 'AA4nA45vauiac3jdVwJTzSdUP3oj2r1fDaPAb2mHdgcH'],
  ];
  assert.equal(core.receiversHash(pinned), '3e45bc50874d22357a5da82e3a5721c951a8d36dd0b8f16d0f6946978c9ccefb');
});

test('a verdict from another decoder version warns and does not fail', () => {
  assert.deepEqual(decoderCheck('0.1.0', '0.1.0'), { ok: true, text: 'decoder: the verdict names kaap-core 0.1.0, the decoder this CLI runs' });
  const older = decoderCheck('0.0.9', '0.1.0');
  assert.equal(older.ok, true);
  assert.equal(older.warning, true);
  const out = render({ title: 't', facts: [], checks: [{ ok: true, text: 'kind hash: same' }, older], notChecked: [], notes: [] });
  assert.match(out, /^ {2}warn {2}decoder: the verdict names decoder 0\.0\.9, this CLI runs kaap-core 0\.1\.0; an older verdict may come from an older decoder/m);
  assert.match(out, /^result: no check fails; 1 pass and 1 warns$/m);
});

test('a tampered signature fails the signature check, and no sealed run returned it', async () => {
  const flip = editView('latest', (value) => {
    const record = value as { signature: string };
    const sig = Buffer.from(record.signature, 'base64');
    sig[10] = (sig[10] ?? 0) ^ 1;
    return { ...record, signature: sig.toString('base64') };
  });
  const { code, out } = await run(flip);
  assert.equal(code, 5, out);
  assert.match(line(out, /sealed signature/), /^fail {2}sealed signature: not valid for the guard's accepted key/);
  assert.match(line(out, /^fail {2}sealed run/), /^fail {2}sealed run: no run by kaap-worker-1029053612\.testnet in blocks .* returned this verdict and signature \(1 run for this proposal returned another\)/);
  assert.match(out, /^result: \d+ of \d+ checks fail$/m);
});

test('an attestation naming a wasm hash that is not a published build fails', async () => {
  const other = 'ab'.repeat(32);
  const { code, out } = await run(editAttestation((a) => {
    a['wasm_hash'] = other;
    a['executed_wasm_sha256'] = other;
  }));
  assert.equal(code, 5, out);
  assert.match(line(out, /the run: OutLayer's attestation/), new RegExp(`^fail {2}the run: OutLayer's attestation: wasm hash ${other} is not a published build; the wasm hash is not the build the contract logged`));
  assert.match(line(out, /the key's run .*OutLayer's attestation/), /^pass/, 'the other run is untouched');
});

test('an attestation naming another caller fails', async () => {
  const { code, out } = await run(editAttestation((a) => {
    a['caller_account_id'] = 'kaap-impostor.testnet';
  }));
  assert.equal(code, 5, out);
  assert.match(line(out, /the run: OutLayer's attestation/), /^fail {2}the run: OutLayer's attestation: caller kaap-impostor\.testnet, not kaap-worker-1029053612\.testnet$/);
});

test('a proposal with no verdict in the registry exits 3 and prints no checks', async () => {
  const { code, out, err } = await run(editView('latest', () => null));
  assert.equal(code, 3);
  assert.equal(out, '');
  assert.match(err, /^kaap-registry-1029061211\.testnet holds no verdict for proposal 2 of kaap-dao-1029064008\.testnet on testnet$/);
});

test('verify only reads: fixed hosts, view, block, chunk and tx calls, and GETs of attestations', async () => {
  const { log } = await run();
  const t = NETWORKS.testnet;
  const rpc = new Set([t.primary, t.secondary, t.archival]);
  const views = new Set(['get_contracts_metadata', 'latest', 'accepted_key', 'get_proposal', 'get_policy', 'veto_result']);
  for (const r of log) {
    if (r.method === 'GET') {
      assert.ok(r.url.startsWith(`${t.outlayer}/attestations/by-tx/`), r.url);
      continue;
    }
    assert.ok(rpc.has(r.url), r.url);
    const { method, params: p } = JSON.parse(r.body ?? '{}') as { method: string; params: { request_type?: string; method_name?: string } };
    assert.ok(['block', 'chunk', 'tx'].includes(method) || (method === 'query' && (p.request_type === 'view_account' || views.has(p.method_name ?? ''))), r.body);
  }
  const src = new URL('../../src/', import.meta.url);
  for (const file of readdirSync(src).filter((f) => f.endsWith('.ts'))) {
    assert.doesNotMatch(readFileSync(new URL(file, src), 'utf8'), /process\.env|KeyPair|private_key|seed phrase|send_tx|broadcast_tx/i, file);
  }
});

test('the verdict reader refuses what kaap-verdict would not write, and ed25519 refuses a changed bit', () => {
  const fx = load('verify-m1-2.json');
  const latest = fx.exchanges.find((e) => e.body?.includes('"method_name":"latest"'));
  const record = JSON.parse((JSON.parse(latest?.text ?? '{}') as { result: { result_text: string } }).result.result_text) as { verdict: string; signature: string };
  const bytes = Buffer.from(record.verdict, 'base64');
  const sig = Buffer.from(record.signature, 'base64');
  const v = decodeVerdict(bytes);
  assert.deepEqual([v.dao, v.proposal_id, v.network, v.risk, v.findings], ['kaap-dao-1029064008.testnet', 2, 'testnet', 'critical', ['DESC_CONTRADICTS', 'UNKNOWN_VALUE']]);
  assert.throws(() => decodeVerdict(Buffer.concat([bytes, Buffer.from([0])])), BadVerdict, 'trailing byte');
  assert.throws(() => decodeVerdict(bytes.subarray(0, bytes.length - 1)), BadVerdict, 'short');
  assert.throws(() => decodeVerdict(Buffer.concat([Buffer.from([2]), bytes.subarray(1)])), BadVerdict, 'version 2');

  const key = edKeyBytes(GUARD_KEY);
  assert.equal(key?.length, 32);
  assert.ok(key && ed25519Valid(key, signedBytes(bytes), sig));
  const changed = Buffer.from(bytes);
  changed[changed.length - 1] = (changed[changed.length - 1] ?? 0) ^ 1;
  assert.ok(key && !ed25519Valid(key, signedBytes(changed), sig));
  assert.equal(edKeyBytes('ed25519:0OIl'), null, 'characters outside base58');
  assert.equal(edKeyBytes('secp256k1:4gaYx4kPxaNDc5grjrucuJfxV97gNiAr8TuCwUAuonuN'), null);
  assert.deepEqual(base58('111'), Buffer.from([0, 0, 0]));
});
