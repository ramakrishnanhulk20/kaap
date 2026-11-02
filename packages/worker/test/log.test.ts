// The log redaction proof: the worker's key never reaches a log line, whatever object carries
// it. Not covered: what the operating system or a host's log shipper does with stdout.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { CredentialsError, loadKey } from '../src/chain.ts';
import { redact } from '../src/log.ts';
import { memoryLog, testKey } from './helpers.ts';

test('the loaded key is cut from every line, in every shape it can take', () => {
  const key = testKey();
  const secret = key.toString();
  const body = secret.split(':')[1]!;
  const dir = mkdtempSync(join(tmpdir(), 'kaap-worker-key-'));
  const file = join(dir, 'worker.testnet.json');
  writeFileSync(file, JSON.stringify({ account_id: 'worker.testnet', public_key: key.getPublicKey().toString(), private_key: secret }), { mode: 0o600 });

  const { log, text } = memoryLog();
  const loaded = loadKey(file, 'worker.testnet', log);
  assert.equal(loaded.getPublicKey().toString(), key.getPublicKey().toString());

  log.info('plain_field', { key: secret });
  log.info('bare_body', { note: `the body alone ${body}` });
  log.info('nested', { deep: { deeper: [{ private_key: 'something', value: secret }] } });
  log.error('thrown', { error: new Error(`signing failed with ${secret}`) });
  log.warn('stack', { error: Object.assign(new Error('x'), { stack: `Error: x\n at sign (${body})` }) });
  log.info('as_bytes', { bytes: Buffer.from(secret) });
  log.info('joined', { text: `prefix-${secret}-suffix` });

  const out = text();
  assert.ok(out.length > 0);
  assert.ok(!out.includes(secret), 'the full key never appears');
  assert.ok(!out.includes(body), 'the bare key body never appears');
  assert.ok(out.includes('[redacted]'));
});

test('a near-cli-rs file, with no account_id and a seed phrase beside the key, loads and its phrase is cut', () => {
  const key = testKey();
  const phrase = 'ocean ladder vivid humble orbit crane maple sudden fiber wagon tunnel brisk';
  const file = join(mkdtempSync(join(tmpdir(), 'kaap-worker-key-')), 'worker.testnet.json');
  writeFileSync(file, JSON.stringify({ seed_phrase_hd_path: "m/44'/397'/0'", master_seed_phrase: phrase, implicit_account_id: 'ab'.repeat(32), public_key: key.getPublicKey().toString(), private_key: key.toString() }), { mode: 0o600 });
  const { log, text } = memoryLog();
  assert.equal(loadKey(file, 'worker.testnet', log).getPublicKey().toString(), key.getPublicKey().toString());
  log.error('thrown', { error: new Error(`restore with ${phrase}`) });
  assert.ok(!text().includes(phrase));
});

test('a key the worker never loaded is still cut by its shape, while public keys stay', () => {
  const other = testKey();
  const line = redact(JSON.stringify({ a: other.toString(), pub: other.getPublicKey().toString() }));
  assert.ok(!line.includes(other.toString()));
  assert.ok(line.includes(other.getPublicKey().toString()), 'a public key is not a secret');
});

test('a broken or foreign credentials file fails with a fixed message that holds no key', () => {
  const key = testKey();
  const dir = mkdtempSync(join(tmpdir(), 'kaap-worker-key-'));
  const cases: Array<[string, string]> = [
    ['not json', 'is not a near-cli credentials file'],
    [JSON.stringify({ account_id: 'someone-else.testnet', public_key: key.getPublicKey().toString(), private_key: key.toString() }), 'holds the key of another account'],
    [JSON.stringify({ account_id: 'worker.testnet', public_key: testKey().getPublicKey().toString(), private_key: key.toString() }), 'does not match its public key'],
  ];
  for (const [i, [content, expected]] of cases.entries()) {
    const file = join(dir, `c${i}.json`);
    writeFileSync(file, content);
    const { log } = memoryLog();
    assert.throws(() => loadKey(file, 'worker.testnet', log), (e: unknown) => e instanceof CredentialsError && e.message.includes(expected) && !e.message.includes(key.toString()));
  }
  assert.throws(() => loadKey(join(dir, 'missing.json'), 'worker.testnet', memoryLog().log), /cannot read the worker credentials file/);
});
