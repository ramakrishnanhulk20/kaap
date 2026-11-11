// `kaap verify` against recorded runs on the M1 testnet DAO's proposals 2 (the disguised payment the
// guard rejected on 29 Oct) and 9 (the same attack, judged by the second published build on 3 Nov),
// found through the real chain of deployment records (today's registry holds no verdict for them,
// so the 29 Oct record it names is used, and said so) with the live providers answering for those
// blocks as they did on 11 Nov, and on the 11 Nov demo DAO's proposal 3 under today's record, its fresh run
// read from a live provider and only the key's run from an archive. On the M1 recording: the first
// archive refusing every request (a pass through the second), every archive refusing (the checks
// that need one unread, none failed, exit 6), KAAP_ARCHIVAL_RPC asked before the public ones, and
// OutLayer's API dropping a connection (asked again) or never answering (its checks unread).
// Then every check passing, then the same answers with a flipped signature bit, a wrong wasm hash and a
// wrong caller in OutLayer's attestation, a tampered receivers hash, a receiver whose code differs
// at the verdict's block, and the live providers disagreeing on a receiver's code now, each failing
// its check and the command; OutLayer's record changed against its TDX quote, its quote rewritten
// to the Legacy hash, and a record whose quote is rewritten to match it but whose fields or time
// disagree with the chain, each failing the binding check; a receiver redeployed since the verdict,
// which warns; no verdict for a proposal; what the command reads; the accounts the receivers hash
// covers, on the sealed job's own cases; a verdict from another decoder warning without failing;
// and the verdict reader and the ed25519 check on their own. It does not cover Intel's signature on
// the TDX quote or OutLayer's approval of its measurements (the CLI does not check them and says
// so), a receivers hash over a called contract recorded live (the M1 payment is native NEAR, so it
// covers the DAO alone), the live chain changing after the recording (DONE MEANS runs live), or a
// verdict with an AI answer (none is recorded on testnet yet).

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import { type BindingRecord, taskHash } from '../src/binding.js';
import { Core } from '../src/core.js';
import { main } from '../src/main.js';
import { type HttpRequest, NetError, type Transport } from '../src/net.js';
import { NETWORKS } from '../src/rpc.js';
import { base58, BadVerdict, decodeVerdict, ed25519Valid, edKeyBytes, signedBytes } from '../src/verdict.js';
import { calledAccounts, decoderCheck, render } from '../src/verify.js';
import { answering, fakeClock, load, replay, REPO_ROOT, UNKNOWN_TODAY, withoutAllowedReads } from './replay.js';

const GUARD_KEY = 'ed25519:4gaYx4kPxaNDc5grjrucuJfxV97gNiAr8TuCwUAuonuN';
const [ARCHIVE = '', SECOND_ARCHIVE = ''] = NETWORKS.testnet.archives;
const LIVE = new Set([NETWORKS.testnet.primary, NETWORKS.testnet.secondary]);
/** How each line that rests on the M1 recordings names the archival node they were recorded from. */
const FROM_ARCHIVE = ' (chain read from archival-rpc.testnet.fastnear.com)';

/** The recording holds the blocks a passing run read. A run that keeps looking reads the rest of
 *  its window, which the archival node answers here as heights with no block, and the chunks of a
 *  recorded block the passing run did not need to open as chunks with no transactions. */
function wholeWindow(t: Transport): Transport {
  return async (r) => {
    try {
      return await t(r);
    } catch (e) {
      const method = params(r).method;
      if (r.url !== ARCHIVE || (method !== 'block' && method !== 'chunk')) throw e;
      const answer = method === 'block' ? { error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_BLOCK' } } } : { result: { transactions: [] } };
      return { status: 200, text: JSON.stringify({ jsonrpc: '2.0', id: 'kaap', ...answer }) };
    }
  };
}

/** The M1 recordings hold only the live providers' answers at the final block. For the 29 Oct
 *  blocks, chunks and runs they no longer keep, each answers as both did on 11 Nov. */
function pruned(t: Transport): Transport {
  return async (r) => {
    try {
      return await t(r);
    } catch (e) {
      if (!LIVE.has(r.url)) throw e;
      const method = params(r).method;
      const cause = method === 'chunk' ? 'UNKNOWN_CHUNK' : method === 'tx' ? 'UNKNOWN_TRANSACTION' : 'UNKNOWN_BLOCK';
      return { status: 200, text: JSON.stringify({ jsonrpc: '2.0', id: 'kaap', error: { name: 'HANDLER_ERROR', cause: { name: cause } } }) };
    }
  };
}

interface RunEnv {
  /** The repository records the command reads: this clone's unless a test says otherwise. */
  root?: string;
  vars?: Record<string, string>;
}

async function run(edit?: (r: HttpRequest, text: string) => string, wrap: (t: Transport) => Transport = (t) => t, fixture = 'verify-m1-2.json', env: RunEnv = {}) {
  const fx = load(fixture);
  const log: HttpRequest[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    fx.argv,
    { transport: wrap(pruned(answering(wholeWindow(replay(fx, log, edit)), fx, UNKNOWN_TODAY))), clock: fakeClock(), loadCore: () => Core.load(), repoRoot: env.root ?? REPO_ROOT, ...(env.vars ? { vars: env.vars } : {}) },
    { out: (t) => out.push(t), err: (t) => err.push(t) },
  );
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

/** Writes `first` and `rest` into the quote's REPORTDATA, as a server inventing a quote would. */
function setReportData(a: Record<string, unknown>, first: Buffer, rest: Buffer = Buffer.alloc(32)) {
  const quote = Buffer.from(String(a['tdx_quote']), 'base64');
  first.copy(quote, 568);
  rest.copy(quote, 600);
  a['tdx_quote'] = quote.toString('base64');
}

/** Changes OutLayer's record, then rewrites its quote to commit to the change, so only the chain
 *  can tell. */
const rehashed = (change: Record<string, unknown>) =>
  editAttestation((a) => {
    Object.assign(a, change);
    setReportData(a, taskHash(a as unknown as BindingRecord));
  });

/** The first output line, trimmed, that `has` matches. */
const line = (out: string, has: RegExp) => out.split('\n').map((l) => l.trim()).find((l) => has.test(l)) ?? '';

const BINDING = /^(pass|fail) {2}the run: OutLayer's record /;

/** The line naming the record the M1 verdicts are checked against, before the checks. */
const OCT_29_RECORD =
  /^Kaap on testnet: deployment record deployments\/testnet-2026-10-29\.json \(an earlier deployment, not the current deployments\/testnet\.json, deployed 2026-10-29T06:12:11Z\): guard kaap-guard-1029061211\.testnet, registry kaap-registry-1029061211\.testnet, sealed program kaap-worker-1029053612\.testnet\/kaap-sealed called by kaap-worker-1029053612\.testnet; used because kaap-registry-1111072803\.testnet holds no verdict for this proposal\n(?:.*\n)*checks\n/m;

test('the M1 attack verdict passes every check, down to the attested run that printed the guard key', async () => {
  const { code, out } = await run();
  assert.equal(code, 0, out);
  assert.match(out, /^kaap verify kaap-dao-1029064008\.testnet #2 on testnet$/m);
  assert.match(out, OCT_29_RECORD);
  assert.match(out, /risk critical, floor critical, findings DESC_CONTRADICTS, UNKNOWN_VALUE, AI unavailable/);
  assert.match(out, /pass {2}sealed signature: valid for the guard's accepted key ed25519:4gaYx4kPxaNDc5grjrucuJfxV97gNiAr8TuCwUAuonuN/);
  assert.match(out, /pass {2}kind hash: kaap-core recomputes c6ca399d/);
  assert.match(out, /pass {2}policy hash: kaap-core recomputes .* at block 275266740/);
  assert.match(out, /pass {2}policy hash: kaap-core recomputes .* at block 275266740 \(read from archival-rpc\.testnet\.fastnear\.com, one node, not compared\)$/m);
  assert.match(out, /pass {2}receivers hash: kaap-core recomputes d159b011\.\.\.f3e0 from the code of kaap-dao-1029064008\.testnet at block 275266740 \(read from archival-rpc\.testnet\.fastnear\.com, one node per read, not compared\)$/m);
  assert.match(out, /pass {2}receivers now: the code of kaap-dao-1029064008\.testnet at block \d+ is unchanged since the verdict \(two providers\)$/m);
  assert.match(out, /pass {2}decoder: the verdict names kaap-core 0\.1\.0, the decoder this CLI runs$/m);
  assert.match(out, /pass {2}sealed run: transaction 7vT7uwgwggGUc3CpNgLApgyjFS4s65KTfZTbMF2enx6T returned exactly this verdict and signature \(found in \d+ blocks, read from archival-rpc\.testnet\.fastnear\.com\)$/m);
  assert.match(out, /pass {2}the run: OutLayer's attestation names the same project, caller kaap-worker-1029053612\.testnet and wasm 0099d7b7/);
  assert.match(out, /^ {2}pass {2}the run: OutLayer's record is the one its TDX quote commits to \(task hash 9b4c3c22\.\.\.da4f, V1\); Intel's signature on the quote is not checked here \(chain read from archival-rpc\.testnet\.fastnear\.com\)$/m);
  assert.match(out, /^ {2}pass {2}the key's run 7HvniWe5\.\.\.: OutLayer's record is the one its TDX quote commits to \(task hash [0-9a-f]{8}\.\.\.[0-9a-f]{4}, V1\)/m);
  assert.match(out, /pass {2}the key's run 7HvniWe5\.\.\.: its attested output prints the guard's accepted key \(chain read from archival-rpc\.testnet\.fastnear\.com\)$/m);
  assert.doesNotMatch(out, /^ {2}(fail|warn)/m);
  assert.match(
    out,
    /^not checked here\n {2}Intel's signature on the TDX quote and OutLayer's approval of its measurements \(OutLayer's own tool: outlayer-verify tx 7vT7uwgwggGUc3CpNgLApgyjFS4s65KTfZTbMF2enx6T --network testnet --api https:\/\/testnet-api\.outlayer\.ai\); record: https:\/\/testnet-api\.outlayer\.ai\/attestations\/by-tx\/7vT7uwgwggGUc3CpNgLApgyjFS4s65KTfZTbMF2enx6T$/m,
  );
  assert.match(out, /AI evidence: none\. .*https:\/\/cloud\.near\.ai\/verify/);
  assert.match(out, /the guard voted to reject with this verdict, and the DAO took the vote/);
  assert.match(out, /^result: all 20 checks pass$/m);
});

test('the 11 Nov demo verdict passes every check on today\'s record, reading its fresh run from a live provider and only the key\'s run from an archive', async () => {
  const { code, out, log } = await run(undefined, undefined, 'verify-1111-3.json');
  assert.equal(code, 0, out);
  assert.match(out, /^kaap verify kaap-dao-1111072928\.testnet #3 on testnet$/m);
  assert.match(out, /^Kaap on testnet: deployment record deployments\/testnet\.json \(the current one, deployed 2026-11-11T07:28:03Z\): guard kaap-guard-1111072803\.testnet, registry kaap-registry-1111072803\.testnet, sealed program kaap-worker-1029053612\.testnet\/kaap-sealed called by kaap-worker-1029053612\.testnet$/m);
  assert.match(out, /pass {2}policy hash: kaap-core recomputes .* at block 277184829 \(read from near-testnet\.drpc\.org, one node, not compared\)$/m);
  assert.match(out, /pass {2}receivers hash: kaap-core recomputes .* at block 277184829 \(read from near-testnet\.drpc\.org, one node per read, not compared\)$/m);
  assert.match(out, /pass {2}sealed run: transaction 4TxRqqMeQJCC1QFzhhzcozBZn1w3ZcDyLX4qXNJH4DSy returned exactly this verdict and signature \(found in 13 blocks, read from near-testnet\.drpc\.org\)$/m);
  assert.match(out, /pass {2}the run: OutLayer's attestation names the same project, caller kaap-worker-1029053612\.testnet and wasm bf7bb4f8\.\.\.4f58, the build that ran \(chain read from near-testnet\.drpc\.org\)$/m);
  assert.match(out, /pass {2}the key's run 7HvniWe5\.\.\.: its attested output prints the guard's accepted key \(chain read from archival-rpc\.testnet\.fastnear\.com\)$/m);
  assert.doesNotMatch(out, /^ {2}(fail|warn|unread)/m);
  assert.match(out, /^result: all 20 checks pass$/m);
  const live = log.find((r) => r.url === NETWORKS.testnet.primary && params(r).method === 'tx' && r.body?.includes('4TxRqqMeQJCC1QFzhhzcozBZn1w3ZcDyLX4qXNJH4DSy'));
  assert.match(live?.body ?? '', /"wait_until":"NONE"/, 'a live provider is asked not to wait');
  const archived = log.filter((r) => NETWORKS.testnet.archives.includes(r.url));
  assert.deepEqual(archived.map((r) => params(r).method), ['tx', 'block', 'block'], 'the key\'s run and the blocks of its two receipts');
  assert.match(archived[0]?.body ?? '', /7HvniWe5JKgqARsiWW8onQpSw1rPcHWiNG4vLwBtekSC/);
});

test('the M1 verdict on proposal 9, from the second published build, passes every check with its run bound to its quote', async () => {
  const { code, out } = await run(undefined, undefined, 'verify-m1-9.json');
  assert.equal(code, 0, out);
  assert.match(out, /^kaap verify kaap-dao-1029064008\.testnet #9 on testnet$/m);
  assert.match(out, OCT_29_RECORD);
  assert.match(out, /pass {2}sealed run: transaction 8P46vmTE9pUDxCX3s4yS5DCUpXdWEVPDRdfGYWJYyTqY returned exactly this verdict and signature/);
  assert.match(out, /pass {2}the run: OutLayer's attestation names the same project, caller kaap-worker-1029053612\.testnet and wasm 73409203/);
  assert.match(out, /^ {2}pass {2}the run: OutLayer's record is the one its TDX quote commits to \(task hash a4863e46\.\.\.8aa8, V1\); Intel's signature on the quote is not checked here \(chain read from archival-rpc\.testnet\.fastnear\.com\)$/m);
  assert.match(out, /record: https:\/\/testnet-api\.outlayer\.ai\/attestations\/by-tx\/8P46vmTE9pUDxCX3s4yS5DCUpXdWEVPDRdfGYWJYyTqY$/m);
  assert.doesNotMatch(out, /^ {2}(fail|warn)/m);
  assert.match(out, /^result: all 20 checks pass$/m);
});

test('a changed output hash, caller, timestamp or payment, a non-zero REPORTDATA tail, or a placeholder quote fails the binding check', async () => {
  const signed = '9b4c3c22...da4f';
  const cases: [string, (a: Record<string, unknown>) => void, RegExp][] = [
    ['output hash', (a) => (a['output_hash'] = `0${String(a['output_hash']).slice(1)}`), new RegExp(`^the task hash recomputed from the record, [0-9a-f.]+, is not the ${signed} the quote commits to$`)],
    ['caller', (a) => (a['caller_account_id'] = 'kaap-impostor.testnet'), new RegExp(`is not the ${signed} the quote commits to$`)],
    ['timestamp', (a) => (a['timestamp'] = Number(a['timestamp']) + 1), new RegExp(`is not the ${signed} the quote commits to$`)],
    ['payment', (a) => (a['attached_usd'] = '1'), new RegExp(`is not the ${signed} the quote commits to; attached usd 1, the request names 0$`)],
    ['REPORTDATA tail', (a) => setReportData(a, Buffer.from('9b4c3c22b0285e72a10939d1a2a0e6b040aeda6761a426b33d7c6b5abd8bda4f', 'hex'), Buffer.alloc(32, 1)), /^the quote's REPORTDATA is not zero after the task hash$/],
    ['placeholder', (a) => (a['tdx_quote'] = Buffer.from('no-attestation-dev-mode').toString('base64')), /^the record carries no quote: OutLayer ran it in development mode \(tee_mode=none\)/],
  ];
  for (const [name, change, why] of cases) {
    const { code, out } = await run(editAttestation(change));
    assert.equal(code, 5, `${name}\n${out}`);
    const shown = line(out, BINDING);
    assert.match(shown, /^fail {2}the run: OutLayer's record and its TDX quote: /, name);
    assert.ok(shown.endsWith(FROM_ARCHIVE), name);
    assert.match(shown.replace(/^fail {2}the run: OutLayer's record and its TDX quote: /, '').slice(0, -FROM_ARCHIVE.length), why, name);
    assert.match(line(out, /the key's run .*OutLayer's record/), /^pass/, `${name}: the other run is untouched`);
  }
});

test('a V1 record whose quote carries its Legacy hash fails: the format is never chosen by what matches', async () => {
  // The Legacy preimage leaves the timestamp out, so a stamp before the cutoff gives the Legacy hash.
  let legacy = '';
  const { code, out } = await run(
    editAttestation((a) => {
      const hash = taskHash({ ...(a as unknown as BindingRecord), timestamp: 1_769_784_938 });
      legacy = hash.toString('hex');
      setReportData(a, hash);
    }),
  );
  assert.equal(code, 5, out);
  assert.match(line(out, BINDING), new RegExp(`^fail {2}the run: OutLayer's record and its TDX quote: the task hash recomputed from the record, 9b4c3c22\\.\\.\\.da4f, is not the ${legacy.slice(0, 8)}\\.\\.\\.${legacy.slice(-4)} the quote commits to \\(chain read from archival-rpc\\.testnet\\.fastnear\\.com\\)$`));
});

test('a record whose quote is rewritten to match it still fails when it disagrees with the chain', async () => {
  // Request block 275266735 at 1793257833.5 s, completion block at 1793257840.7 s.
  const prefix = 'fail  the run: OutLayer\'s record and its TDX quote: ';
  const cases: [Record<string, unknown>, string][] = [
    [{ block_height: 275266736 }, 'block height 275266736, the request ran in block 275266735'],
    [{ block_height: null }, 'block height none, the request ran in block 275266735'],
    [{ build_target: 'wasm32-wasip1' }, 'build target wasm32-wasip1, the request names wasm32-wasip2'],
    [{ attached_usd: '5' }, 'attached usd 5, the request names 0'],
    [{ secrets_ref: 'kaap-worker-1029053612.testnet/default' }, 'secrets reference kaap-worker-1029053612.testnet/default, the request names none'],
    [{ timestamp: 1793257832 }, 'stamped 1793257832, outside the request block\'s time 1793257833 to the completion block\'s time 1793257840'],
    [{ timestamp: 1793257841 }, 'stamped 1793257841, outside the request block\'s time 1793257833 to the completion block\'s time 1793257840'],
  ];
  for (const [change, why] of cases) {
    const { code, out } = await run(rehashed(change));
    assert.equal(code, 5, `${JSON.stringify(change)}\n${out}`);
    assert.equal(line(out, BINDING), `${prefix}${why}${FROM_ARCHIVE}`);
  }
  for (const timestamp of [1793257833, 1793257840]) {
    const { code, out } = await run(rehashed({ timestamp }));
    assert.equal(code, 0, `the window is inclusive: ${timestamp}\n${out}`);
    assert.match(line(out, BINDING), /^pass/);
  }
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
  assert.match(line(out, /receivers hash/), /^fail {2}receivers hash: kaap-core gives d159b011\.\.\.f3e0 from the code of kaap-dao-1029064008\.testnet at block 275266740 \(read from archival-rpc\.testnet\.fastnear\.com, one node per read, not compared\), the verdict says d059b011\.\.\.f3e0$/);
  assert.match(out, /the guard has not voted with this verdict/);
});

test('a called contract whose code at the verdict\'s block is not what the verdict pinned fails the receivers check', async () => {
  const redeployed = (r: HttpRequest, text: string) => {
    if (r.url !== ARCHIVE || params(r).params?.request_type !== 'view_account') return text;
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
  assert.match(out, /^result: no check fails; 19 pass and 1 warns$/m);
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
  // The cases of packages/core/src/receipt.rs `called_accounts`, and the pair list WO-03d pinned
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
  assert.match(line(out, /the run: OutLayer's attestation/), /^fail {2}the run: OutLayer's attestation: caller kaap-impostor\.testnet, not kaap-worker-1029053612\.testnet \(chain read from archival-rpc\.testnet\.fastnear\.com\)$/);
});

test('a proposal no registry in the chain of records holds a verdict for exits 3 and prints no checks', async () => {
  const { code, out, err } = await run(editView('latest', () => null));
  assert.equal(code, 3);
  assert.equal(out, '');
  assert.match(err, /^kaap-registry-1111072803\.testnet and kaap-registry-1029061211\.testnet hold no verdict for proposal 2 of kaap-dao-1029064008\.testnet on testnet$/);
});

test('with the first archive refusing every request, every check passes through the second, which each line names', async () => {
  let refused = 0;
  const secondOnly = (t: Transport): Transport => async (r) => {
    if (r.url === ARCHIVE) {
      refused++;
      return { status: 429, text: '' };
    }
    return t(r.url === SECOND_ARCHIVE ? { ...r, url: ARCHIVE } : r);
  };
  const { code, out } = await run(undefined, secondOnly);
  assert.equal(code, 0, out);
  assert.match(out, /pass {2}policy hash: kaap-core recomputes .* \(read from archival-rpc\.testnet\.near\.org, one node, not compared\)$/m);
  assert.match(out, /pass {2}receivers hash: .* \(read from archival-rpc\.testnet\.near\.org, one node per read, not compared\)$/m);
  assert.match(out, /pass {2}sealed run: transaction 7vT7uwgwggGUc3CpNgLApgyjFS4s65KTfZTbMF2enx6T returned exactly this verdict and signature \(found in \d+ blocks, read from archival-rpc\.testnet\.near\.org\)$/m);
  assert.match(out, /pass {2}the key's run 7HvniWe5\.\.\.: its attested output prints the guard's accepted key \(chain read from archival-rpc\.testnet\.near\.org\)$/m);
  assert.match(out, /^result: all 20 checks pass$/m);
  assert.equal(refused, 3, 'asked at once, after 2 s and after 5 s, then left to rest for the rest of the run');
});

test('with every archive refusing, the checks that need one are unread, none fails, and verify exits 6 with the plain sentence', async () => {
  const refuseAll = (t: Transport): Transport => async (r) => (NETWORKS.testnet.archives.includes(r.url) ? { status: 429, text: '' } : t(r));
  const { code, out } = await run(undefined, refuseAll);
  assert.equal(code, 6, out);
  assert.doesNotMatch(out, /^ {2}fail/m);
  for (const what of ['policy hash', 'receivers hash', 'sealed run', "the key's run 7HvniWe5\\.\\.\\."]) assert.match(out, new RegExp(`^ {2}unread {2}${what}: .*could not be read`, 'm'), what);
  assert.match(
    line(out, /^unread {2}policy hash/),
    /\(no node answered: near-testnet\.drpc\.org does not hold it; rpc\.testnet\.fastnear\.com does not hold it; archival-rpc\.testnet\.fastnear\.com: HTTP 429; archival-rpc\.testnet\.near\.org: HTTP 429\)$/,
  );
  assert.match(out, /^ {2}pass {2}sealed signature: valid for the guard's accepted key/m, 'what the live providers answered still passes');
  assert.match(out, /^result: no check fails, but 4 of \d+ could not be read\nThe archive nodes are rate-limiting or not answering: wait a minute and run again, or set KAAP_ARCHIVAL_RPC to the https address of an archival node you can use\.$/m);
});

test('KAAP_ARCHIVAL_RPC is asked before the public archives, each line names it, and they are asked only for what it lacks', async () => {
  const own = 'https://archive.example.org';
  let toPublic = 0;
  let ownLacked = 0;
  const named = (t: Transport): Transport => async (r) => {
    if (NETWORKS.testnet.archives.includes(r.url)) toPublic++;
    if (r.url !== own) return t(r);
    const answer = await t({ ...r, url: ARCHIVE });
    if (/UNKNOWN_(BLOCK|CHUNK|TRANSACTION)/.test(answer.text)) ownLacked++;
    return answer;
  };
  const { code, out } = await run(undefined, named, undefined, { vars: { KAAP_ARCHIVAL_RPC: `${own}/` } });
  assert.equal(code, 0, out);
  assert.match(out, /pass {2}policy hash: kaap-core recomputes .* \(read from archive\.example\.org, one node, not compared\)$/m);
  assert.match(out, /pass {2}the run: OutLayer's attestation names the same project, .* \(chain read from archive\.example\.org\)$/m);
  assert.match(out, /pass {2}the key's run 7HvniWe5\.\.\.: its attested output prints the guard's accepted key \(chain read from archive\.example\.org\)$/m);
  assert.match(out, /^result: all 20 checks pass$/m);
  assert.equal(toPublic, ownLacked);
});

test('OutLayer\'s API dropping a connection is asked again, and one that never answers leaves its checks unread, never failed', async () => {
  let drops = 1;
  const dropOnce = (t: Transport): Transport => async (r) => {
    if (r.method === 'GET' && drops > 0) {
      drops--;
      throw new NetError('unreachable', new URL(r.url).host);
    }
    return t(r);
  };
  const once = await run(undefined, dropOnce);
  assert.equal(once.code, 0, once.out);
  assert.match(once.out, /^result: all 20 checks pass$/m);

  let gets = 0;
  const down = (t: Transport): Transport => async (r) => {
    if (r.method !== 'GET') return t(r);
    gets++;
    return { status: 503, text: '' };
  };
  const { code, out } = await run(undefined, down);
  assert.equal(gets, 8, 'four tries for each run\'s attestation');
  assert.equal(code, 6, out);
  assert.doesNotMatch(out, /^ {2}fail/m);
  assert.equal(out.match(/^ {2}unread {2}/gm)?.length, 6, 'three checks for each of the two runs');
  assert.match(line(out, /^unread {2}the run: the attested input and output hashes/), /could not be checked, because OutLayer's API did not answer for its attestation \(OutLayer answered HTTP 503\) \(chain read from archival-rpc\.testnet\.fastnear\.com\)$/);
  assert.match(line(out, /^pass {2}the run: outlayer\.testnet recorded the request/), /a published build/, 'the chain record of the run is still checked');
  assert.match(out, /^result: no check fails, but 6 of 20 could not be read\nOutLayer's API is not answering: wait a minute and run again\.$/m);
});

test('verify only reads: fixed hosts, view, block, chunk and tx calls, and GETs of attestations', async () => {
  const { log } = await run();
  const t = NETWORKS.testnet;
  const rpc = new Set([t.primary, t.secondary, ...t.archives]);
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
    assert.doesNotMatch(withoutAllowedReads(readFileSync(new URL(file, src), 'utf8')), /process\.env|KeyPair|private_key|seed phrase|send_tx|broadcast_tx/i, file);
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
