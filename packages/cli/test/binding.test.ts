// The task hash OutLayer's TDX quote commits to, rebuilt from the record: our two testnet runs as
// recorded from OutLayer's API, and outlayer-verify's own three test records (a V1 HTTPS run, a
// Legacy run 53 minutes before the cutoff, and a V1 on-chain run), each giving the exact bytes in its
// quote; a V1 record hashed as Legacy, and a changed output hash, caller, timestamp or payment, each
// missing them; and the quotes the reader refuses. The verifier's quotes are cut to their first 632
// bytes, the header and TD report that hold REPORTDATA; the rest is the signature part, which this
// does not read. It does not cover Intel's signature on any quote, nor the chain cross-checks (both
// in verify.test.ts, the second only).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type BindingRecord, quoteReportData, taskHash } from '../src/binding.js';
import { load } from './replay.js';

type Served = BindingRecord & { tdx_quote: string };

/** OutLayer's record of `tx` as the fixture recorded it from the API. */
function ours(fixture: string, tx: string): Served {
  const exchange = load(fixture).exchanges.find((e) => e.method === 'GET' && e.url.endsWith(`/attestations/by-tx/${tx}`));
  assert.ok(exchange, `${fixture} holds no record of ${tx}`);
  return JSON.parse(exchange.text) as Served;
}

/** crates/verify-core/tests/fixtures of https://github.com/out-layer/outlayer-verify at commit
 *  90c27d9. */
const VERIFIER: [string, string, Served][] = [
  [
    'mainnet-205123-v1',
    '7d19e4dcb6e3b36ff6f5e62580224e956fec8adac57e54156befc2c263c57efe',
    {
      task_id: 205123,
      task_type: 'execute',
      tdx_quote:
        'BAACAIEAAAAAAAAAk5pyM/ecTKmUCg2zlX8GBwpwaYoenQSyxNjXVqXaVyEAAAAADgEEAAAAAAAAAAAAAAAAADRrx3oYRsrCFN0ujt657kNJRJ1sP5/yxSFJpjTCe3/RvTFMLva5c+7r1VdClSUxoQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAADnAgYAAAAAAH/mB4ciK9OUy1FqvKJDXyLwNassycCktLOxSORil/PZMaI3ty81kFLG5lfYwUCRcwHL2P1CnR11iamUlWe5lchp7nNbWieAHLiQIF2oyqa4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFMFJuRWcz3/FRcS0dsXKM/DvIXtCmwTZTrdLmRMVwaACVlbk19qUM5KcUutKzO8juhgG2SUL596ZvTY9XJ8Cn1KcZU8/Dx9E+BD+N30+U0jWK/RfgH1Z6XYIJ8890eUia0e0RPb7PhRaxrhujOlGI1h3UpLr1wYHB3Txh7YuRpiS1rCJCMoAo5UDZovtPLb/gAfSd3i6mABGcKYypIhLwRNIgvtrwZ+5cyBcQM1DSAVOCJKCIABSDDKPZiLfxWbdX0Z5Ny247Nv9vXmJYAiTpVv7IraxX5UFWvvwsJjxX7+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      caller_account_id: 'humblemee.near',
      block_height: 209012631,
      repo_url: 'https://github.com/zavodil/random-ark',
      commit_hash: 'main',
      build_target: 'wasm32-wasip1',
      wasm_hash: '45070a47cb68e4a4a80cef011fbc16cd625b6f6423d9652b4f387dbdc06fccff',
      input_hash: '0cf36617a12e749a9875f4527b96c750cb3c64aae7e981627930c04b3f74162a',
      output_hash: '82b2b42f1755c0e200fdcedbde8ca04d358c2a31177df5f5609123e8810560df',
      secrets_ref: 'humblemee.near/humble',
      attached_usd: '0',
      timestamp: 1785309658,
    },
  ],
  [
    'mainnet-500-legacy',
    'ff60d3fa7acf5d8da64844dea25de7e056732a9c74a43a0efcd923a817973755',
    {
      task_id: 500,
      task_type: 'execute',
      tdx_quote:
        'BAACAIEAAAAAAAAAk5pyM/ecTKmUCg2zlX8GB8yh6BjA2eixcAfClcMQBOwAAAAACwEFAAAAAAAAAAAAAAAAAHvwYygOlPsFH13XsfxZzpqsQruWHfjUS3Ccmw/4entN9khle6bRGJWJ/qsdWjyanQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAHAgAAAAAAAPBt/abc4c+QTU4rqx3DcGNM+Vzvos6y3i7uEnyTgmmAkNekoT4UxTbsbJw8j6hwdwEfT8EOkI3j04X9U1uVMGaY1riVslB9GGPw/S3CuRt8uQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGgQLntSSvMQ97fUJs51SB42xA9dUTqQCcBG6dN+MVUfATTZVLSWozV/1h0D8H/+ltqpOA3DOxRyiprbIiQ3zxTbLUD/xNcGHY88Mp9sazOfcUhtM1ISh+j66uIjAfTYFRvcdtnL6VvW6XeWm8Pixa+rLoXLaxncF8xxzv4nz+e0/ilgXydcujef+JgMqu7mdBcYo/Nyn565el0XNoZI4UOMr6J0A+NE6k9nZgGWN8HhmXCHG7GJ/Yg6l+EEbEkqtP9g0/p6z12NpkhE3qJd5+BWcyqcdKQ6DvzZI6gXlzdVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      caller_account_id: 'hlpv.near',
      block_height: 183384885,
      build_target: 'wasm32-wasip2',
      wasm_hash: 'ddaa9df2d989b311289dd1d7af19611a24b03180cd66d46d171d16f28f7fb94b',
      input_hash: '0a7d71085812f8eff09d42240cac5f8ccb88d851e25c76c3270d96e0d22df88a',
      output_hash: '9e8427241137bb0c28575777378aed63218f2f554c2bef0cfac7b25b0316b4fb',
      timestamp: 1769781716,
    },
  ],
  [
    'testnet-2008-chain',
    '1b91f4f71b77abae936bf0003fd07bf9f7d2c52195aca2f623aa2e78607eb1b1',
    {
      task_id: 2008,
      task_type: 'execute',
      tdx_quote:
        'BAACAIEAAAAAAAAAk5pyM/ecTKmUCg2zlX8GBwpwaYoenQSyxNjXVqXaVyEAAAAADgEEAAAAAAAAAAAAAAAAADRrx3oYRsrCFN0ujt657kNJRJ1sP5/yxSFJpjTCe3/RvTFMLva5c+7r1VdClSUxoQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAADnAgYAAAAAAH/mB4ciK9OUy1FqvKJDXyLwNassycCktLOxSORil/PZMaI3ty81kFLG5lfYwUCRcwGE4DsKEspuuEOhj4AzBGNGpDkOyZtVLv0kOKWs/0XAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFMFJuRWcz3/FRcS0dsXKM/DvIXtCmwTZTrdLmRMVwaACVlbk19qUM5KcUutKzO8juhgG2SUL596ZvTY9XJ8Cn1KcZU8/Dx9E+BD+N30+U0jWK/RfgH1Z6XYIJ8890eUia0e0RPb7PhRaxrhujOlGI1h3UpLr1wYHB3Txh7YuRpiS1rCJCMoAo5UDZovtPLb/mVQAMk7tVq3PDlHLQIqu+lqRsHUu7t3TknKiWv9v7Dn+8VCL43j74wKoGDjjPSqbxuR9Pcbd6uuk2vwAD/Qe/n30sUhlayi9iOqLnhgfrGxAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      caller_account_id: 'maguila.testnet',
      block_height: 261245882,
      repo_url: 'https://github.com/zavodil/weather-ark',
      commit_hash: 'main',
      build_target: 'wasm32-wasip2',
      wasm_hash: '788e865fffddb333cf36c29b7f2251a9c3c4da8306e5527d2b1e8c7045ec4ff0',
      input_hash: '48592c499d13432c061534fafc8e6bd6353aeec799e6264a915805f3718344b0',
      output_hash: 'ca6e60c897ffa2b10211bb75e5e7cfa2f8ddc0ab1727097e35b383c1ea919a29',
      secrets_ref: 'zavodil2.testnet/default',
      attached_usd: '0',
      timestamp: 1785196543,
    },
  ],
];

/** The record's hash and the quote's REPORTDATA both equal `want`, with a zero second half. */
function matches(name: string, record: Served, want: string) {
  const quote = quoteReportData(record.tdx_quote);
  assert.equal(quote.first.toString('hex'), want, `${name}: the quote's bytes`);
  assert.equal(taskHash(record).toString('hex'), want, `${name}: the recomputed hash`);
  assert.ok(quote.rest.equals(Buffer.alloc(32)), `${name}: REPORTDATA after the hash is zero`);
}

const RUN_2 = ours('verify-m1-2.json', '7vT7uwgwggGUc3CpNgLApgyjFS4s65KTfZTbMF2enx6T');
const RUN_9 = ours('verify-m1-9.json', '8P46vmTE9pUDxCX3s4yS5DCUpXdWEVPDRdfGYWJYyTqY');

test('our two testnet runs hash to the bytes their quotes commit to', () => {
  matches('7vT7uw', RUN_2, '9b4c3c22b0285e72a10939d1a2a0e6b040aeda6761a426b33d7c6b5abd8bda4f');
  matches('8P46vm', RUN_9, 'a4863e46f15a0e569f69cfeea9a79f397aaa70209e08f8adc25cafca3ed18aa8');
});

test('the verifier\'s own three records hash to the bytes their quotes commit to', () => {
  for (const [name, want, record] of VERIFIER) matches(name, record, want);
});

test('a record stamped at or after the cutoff hashes as V1 only, so its Legacy hash misses the quote', () => {
  // The Legacy preimage leaves the timestamp out, so moving the stamp one second before the cutoff
  // gives exactly the Legacy hash of the same record.
  const asLegacy = (r: Served) => taskHash({ ...r, timestamp: 1_769_784_938 });
  for (const record of [RUN_2, RUN_9, VERIFIER[0]![2], VERIFIER[2]![2]]) {
    assert.ok(record.timestamp >= 1_769_784_939);
    assert.notDeepEqual(asLegacy(record), quoteReportData(record.tdx_quote).first);
  }
  const atCutoff = { ...RUN_2, timestamp: 1_769_784_939 };
  assert.notDeepEqual(taskHash(atCutoff), asLegacy(RUN_2), 'the cutoff second itself is V1');
});

test('a changed output hash, caller, timestamp or payment misses the quote\'s bytes', () => {
  const signed = quoteReportData(RUN_2.tdx_quote).first;
  const changes: Partial<Served>[] = [
    { output_hash: `0${RUN_2.output_hash.slice(1)}` },
    { caller_account_id: 'kaap-impostor.testnet' },
    { timestamp: RUN_2.timestamp + 1 },
    { attached_usd: '1' },
    { attached_usd: null },
  ];
  for (const change of changes) assert.notDeepEqual(taskHash({ ...RUN_2, ...change }), signed, JSON.stringify(change));
});

test('the quote reader refuses a development placeholder, a short quote, another quote type and loose base64', () => {
  const dev = Buffer.from('no-attestation-dev-mode').toString('base64');
  assert.throws(() => quoteReportData(dev), { name: 'BindingRefused', message: /development mode \(tee_mode=none\)/ });
  assert.throws(() => quoteReportData('no-attestation-dev-mode'), { name: 'BindingRefused', message: /development mode/ });
  const quote = Buffer.from(RUN_2.tdx_quote, 'base64');
  assert.throws(() => quoteReportData(quote.subarray(0, 631).toString('base64')), { name: 'BindingRefused', message: /^the quote is 631 bytes, too short to be a TDX quote \(at least 632\)$/ });
  assert.equal(quoteReportData(quote.subarray(0, 632).toString('base64')).first.length, 32, 'exactly 632 bytes is read');
  const sgx = Buffer.from(quote);
  sgx.writeUInt32LE(0, 4);
  assert.throws(() => quoteReportData(sgx.toString('base64')), { message: /not a TDX quote v4: version 4, TEE type 0x0/ });
  const v3 = Buffer.from(quote);
  v3.writeUInt16LE(3, 0);
  assert.throws(() => quoteReportData(v3.toString('base64')), { message: /not a TDX quote v4: version 3, TEE type 0x81/ });
  assert.throws(() => quoteReportData(`${RUN_2.tdx_quote.slice(0, 100)}*${RUN_2.tdx_quote.slice(100)}`), { message: /not canonical base64/ });
});
