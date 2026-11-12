// The settings schema the worker checks at boot (6e). Not covered here: loading the .env file
// itself (Node's process.loadEnvFile) and the credentials file, which chain.test.ts reads.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConfigError, loadConfig } from '../src/config.ts';

const complete = {
  KAAP_NETWORK: 'testnet',
  KAAP_WORKER_ACCOUNT: 'kaap-worker-1029053612.testnet',
  KAAP_WORKER_CREDENTIALS_FILE: '/home/worker/.near-credentials/testnet/kaap-worker-1029053612.testnet.json',
  KAAP_GUARD: 'kaap-guard-1029061211.testnet',
  KAAP_REGISTRY: 'kaap-registry-1029061211.testnet',
  KAAP_OUTLAYER: 'outlayer.testnet',
  KAAP_SEALED_PROJECT: 'kaap-worker-1029053612.testnet/kaap-sealed',
  KAAP_RPC_PRIMARY: 'https://rpc.testnet.fastnear.com',
  KAAP_RPC_SECONDARY: 'https://near-testnet.drpc.org/',
  KAAP_WORKER_DB: '/home/worker/kaap-worker/testnet.sqlite',
  KAAP_CAP_RUNS_PER_DAO_DAY: '60',
  KAAP_CAP_RECORDS_PER_DAO_DAY: '60',
  KAAP_CAP_NEAR_PER_DAY: '1',
  TELEGRAM_BOT_TOKEN: '123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-Ms',
};

const problems = (env: Record<string, string | undefined>) => {
  try {
    loadConfig(env);
  } catch (e) {
    assert.ok(e instanceof ConfigError);
    return e.problems;
  }
  assert.fail('the settings were accepted');
};

test('a complete testnet setting loads, with the defaults filled in', () => {
  const c = loadConfig({ ...complete, NEAR_AI_API_KEY: 'not-ours', PATH: '/usr/bin' });
  assert.equal(c.KAAP_NETWORK, 'testnet');
  assert.equal(c.KAAP_RPC_SECONDARY, 'https://near-testnet.drpc.org');
  assert.equal(c.KAAP_CAP_RUNS_PER_DAO_DAY, 60);
  assert.equal(c.KAAP_CAP_NEAR_PER_DAY, 10n ** 24n);
  assert.equal(c.KAAP_POLL_MS, 1_000);
  assert.equal(c.KAAP_RUN_WINDOW_BLOCKS, 220);
  assert.equal(c.KAAP_VERDICT_TTL_MS, 600_000);
  assert.ok(!('NEAR_AI_API_KEY' in c), 'only KAAP_ settings are read');
});

test('every missing key is named in one error, and an empty value counts as missing', () => {
  const got = problems({ KAAP_NETWORK: 'testnet', KAAP_GUARD: '' });
  for (const key of Object.keys(complete).filter((k) => k !== 'KAAP_NETWORK')) {
    assert.ok(got.includes(`${key}: missing`), `${key} is reported missing`);
  }
});

test('malformed values are refused, and the values themselves are never echoed', () => {
  const secretLooking = 'ed25519:3D4YudUahN1nawWogh8pAKSj92sUNMdbZGjn7kERKzYoTy8tnFQuwoGUC51DowKqorvkr2pytJSnwuSbsNVfqygr';
  const got = problems({
    ...complete,
    KAAP_NETWORK: 'devnet',
    KAAP_GUARD: 'Not An Account',
    KAAP_RPC_PRIMARY: 'http://rpc.testnet.fastnear.com',
    KAAP_CAP_RUNS_PER_DAO_DAY: '0',
    KAAP_CAP_NEAR_PER_DAY: secretLooking,
    KAAP_POLL_MS: '10',
  });
  const text = got.join('\n');
  for (const key of ['KAAP_NETWORK', 'KAAP_GUARD', 'KAAP_RPC_PRIMARY', 'KAAP_CAP_RUNS_PER_DAO_DAY', 'KAAP_CAP_NEAR_PER_DAY', 'KAAP_POLL_MS']) {
    assert.ok(got.some((p) => p.startsWith(`${key}:`)), `${key} is refused`);
  }
  assert.ok(!text.includes(secretLooking));
  assert.ok(!text.includes('Not An Account'));
});

test('the bot token is required and checked, never echoed, and alerts get no link until a site is set', () => {
  const c = loadConfig(complete);
  assert.equal(c.KAAP_SITE_URL, undefined);
  assert.deepEqual([c.KAAP_HTTP_HOST, c.KAAP_HTTP_PORT, c.KAAP_ALERT_BATCH_MS, c.KAAP_ALERT_CAP_PER_HOUR, c.KAAP_LAG_ALERT_MS], ['127.0.0.1', 8_787, 60_000, 30, 15_000]);
  assert.equal(loadConfig({ ...complete, KAAP_SITE_URL: 'https://kaap.example/' }).KAAP_SITE_URL, 'https://kaap.example');
  const leaked = '123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-Ms ';
  const got = problems({ ...complete, TELEGRAM_BOT_TOKEN: leaked, KAAP_SITE_URL: 'http://kaap.example', KAAP_HTTP_HOST: '0.0.0.0.0' });
  assert.ok(got.some((p) => p.startsWith('TELEGRAM_BOT_TOKEN:')));
  assert.ok(got.some((p) => p.startsWith('KAAP_SITE_URL:')), 'a link may only point at an https site');
  assert.ok(got.some((p) => p.startsWith('KAAP_HTTP_HOST:')));
  assert.ok(!got.join('\n').includes('AAEhBOweik6ad9r'));
  assert.ok(problems({ ...complete, TELEGRAM_BOT_TOKEN: '' }).includes('TELEGRAM_BOT_TOKEN: missing'));
});

test('texts one address may send an hour: 3 by default, 1 to 100', () => {
  assert.equal(loadConfig(complete).KAAP_TEXTS_PER_ADDRESS_HOUR, 3);
  assert.equal(loadConfig({ ...complete, KAAP_TEXTS_PER_ADDRESS_HOUR: '100' }).KAAP_TEXTS_PER_ADDRESS_HOUR, 100);
  for (const bad of ['0', '101', '2.5']) assert.ok(problems({ ...complete, KAAP_TEXTS_PER_ADDRESS_HOUR: bad }).some((p) => p.startsWith('KAAP_TEXTS_PER_ADDRESS_HOUR:')), bad);
});

test('text runs per DAO a day: 5 by default, 1 to 1,000', () => {
  assert.equal(loadConfig(complete).KAAP_CAP_TEXT_RUNS_PER_DAO_DAY, 5);
  assert.equal(loadConfig({ ...complete, KAAP_CAP_TEXT_RUNS_PER_DAO_DAY: '1000' }).KAAP_CAP_TEXT_RUNS_PER_DAO_DAY, 1_000);
  for (const bad of ['0', '1001', '2.5']) assert.ok(problems({ ...complete, KAAP_CAP_TEXT_RUNS_PER_DAO_DAY: bad }).some((p) => p.startsWith('KAAP_CAP_TEXT_RUNS_PER_DAO_DAY:')), bad);
});

test('a backfill window above 50, the most proposal ids one pass takes up, stops the worker at start and says so', () => {
  assert.equal(loadConfig(complete).KAAP_BACKFILL_WINDOW, 50);
  assert.equal(loadConfig({ ...complete, KAAP_BACKFILL_WINDOW: '1' }).KAAP_BACKFILL_WINDOW, 1);
  assert.deepEqual(problems({ ...complete, KAAP_BACKFILL_WINDOW: '500' }), ['KAAP_BACKFILL_WINDOW: at most 50, the most proposal ids the worker takes up in one pass']);
  assert.deepEqual(problems({ ...complete, KAAP_BACKFILL_WINDOW: '51' }), ['KAAP_BACKFILL_WINDOW: at most 50, the most proposal ids the worker takes up in one pass']);
});

test('treasuries watched at once: 200 by default, 1 to 5,000', () => {
  assert.equal(loadConfig(complete).KAAP_MAX_WATCHED_DAOS, 200);
  assert.equal(loadConfig({ ...complete, KAAP_MAX_WATCHED_DAOS: '5000' }).KAAP_MAX_WATCHED_DAOS, 5_000);
  for (const bad of ['0', '5001', '2.5']) assert.ok(problems({ ...complete, KAAP_MAX_WATCHED_DAOS: bad }).some((p) => p.startsWith('KAAP_MAX_WATCHED_DAOS:')), bad);
});

test('the two providers must be different hosts (C22)', () => {
  const got = problems({ ...complete, KAAP_RPC_SECONDARY: 'https://rpc.testnet.fastnear.com/other' });
  assert.deepEqual(got, ['KAAP_RPC_SECONDARY: the two RPC providers must be different hosts (C22)']);
});

test('NEAR amounts are read as exact decimals, never through a float', () => {
  assert.equal(loadConfig({ ...complete, KAAP_CAP_NEAR_PER_DAY: '0.000000000000000000000001' }).KAAP_CAP_NEAR_PER_DAY, 1n);
  assert.equal(loadConfig({ ...complete, KAAP_CAP_NEAR_PER_DAY: '2.5' }).KAAP_CAP_NEAR_PER_DAY, 25n * 10n ** 23n);
  for (const bad of ['1e3', '-1', '0', ' 1', '1.0000000000000000000000001']) {
    assert.ok(problems({ ...complete, KAAP_CAP_NEAR_PER_DAY: bad }).some((p) => p.startsWith('KAAP_CAP_NEAR_PER_DAY:')), bad);
  }
});

test('the NEAR AI secret row is optional: no account by default, profile near-ai, both checked', () => {
  const c = loadConfig(complete);
  assert.equal(c.KAAP_AI_SECRETS_ACCOUNT, undefined, 'no default account');
  assert.equal(c.KAAP_AI_SECRETS_PROFILE, 'near-ai');
  const set = loadConfig({ ...complete, KAAP_AI_SECRETS_ACCOUNT: 'secrets-owner.testnet', KAAP_AI_SECRETS_PROFILE: 'kaap_ai-2' });
  assert.deepEqual([set.KAAP_AI_SECRETS_ACCOUNT, set.KAAP_AI_SECRETS_PROFILE], ['secrets-owner.testnet', 'kaap_ai-2']);
  assert.equal(loadConfig({ ...complete, KAAP_AI_SECRETS_ACCOUNT: '' }).KAAP_AI_SECRETS_ACCOUNT, undefined, 'empty counts as unset');
  const got = problems({ ...complete, KAAP_AI_SECRETS_ACCOUNT: 'Not An Account', KAAP_AI_SECRETS_PROFILE: 'near ai/x' });
  assert.ok(got.some((p) => p.startsWith('KAAP_AI_SECRETS_ACCOUNT:')));
  assert.ok(got.some((p) => p.startsWith('KAAP_AI_SECRETS_PROFILE:')));
  assert.ok(!got.join('\n').includes('near ai/x'), 'values are never echoed');
});
