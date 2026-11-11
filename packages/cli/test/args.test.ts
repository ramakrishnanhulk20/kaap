// The command line: what each command accepts, the default network, and every refusal. It does not
// run any command (the other test files do).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parse, UsageError } from '../src/args.js';
import { main } from '../src/main.js';
import { Core } from '../src/core.js';
import { fakeClock, REPO_ROOT } from './replay.js';

test('check takes a DAO and an optional id, on mainnet for a .near account unless told otherwise', () => {
  assert.deepEqual(parse(['check', 'a.sputnik-dao.near']), { command: 'check', dao: 'a.sputnik-dao.near', id: null, network: 'mainnet', json: false });
  assert.deepEqual(parse(['check', 'a.sputnik-dao.near', '132', '--network', 'testnet', '--json']), {
    command: 'check',
    dao: 'a.sputnik-dao.near',
    id: 132,
    network: 'testnet',
    json: true,
  });
  assert.deepEqual(parse(['check', '--network=mainnet', 'a.sputnik-dao.near', '0']), { command: 'check', dao: 'a.sputnik-dao.near', id: 0, network: 'mainnet', json: false });
});

test('check takes testnet from a .testnet account when --network is absent, and --network still wins', () => {
  assert.equal((parse(['check', 'kaap-dao-1029064008.testnet', '7']) as { network: string }).network, 'testnet');
  assert.equal((parse(['check', 'a.sputnikv2.testnet']) as { network: string }).network, 'testnet');
  assert.equal((parse(['check', 'kaap-dao-1029064008.testnet', '--network', 'mainnet']) as { network: string }).network, 'mainnet');
  assert.equal((parse(['check', 'testnet.sputnik-dao.near']) as { network: string }).network, 'mainnet', 'only the suffix counts');
});

test('check refuses a missing DAO, a bad id, a third argument and any other network', () => {
  for (const argv of [
    ['check'],
    ['check', 'a.near', '-1'],
    ['check', 'a.near', '1.5'],
    ['check', 'a.near', 'twelve'],
    ['check', 'a.near', '99999999999999999'],
    ['check', 'a.near', '1', '2'],
    ['check', 'a.near', '--network', 'sandbox'],
    ['check', 'a.near', '--network', 'Mainnet'],
    ['check', 'a.near', '--key', 'ed25519:abc'],
  ]) {
    assert.throws(() => parse(argv), UsageError, argv.join(' '));
  }
});

test('census takes --sample from 1 up, and eval takes nothing', () => {
  assert.deepEqual(parse(['census']), { command: 'census', sample: null });
  assert.deepEqual(parse(['census', '--sample', '50']), { command: 'census', sample: 50 });
  for (const argv of [['census', '--sample', '0'], ['census', '--sample', 'all'], ['census', 'extra'], ['eval', 'x'], ['eval', '--json'], ['steal']]) {
    assert.throws(() => parse(argv), UsageError, argv.join(' '));
  }
  assert.deepEqual(parse(['eval']), { command: 'eval' });
});

test('help and version answer without loading anything, and a usage error exits 2 with the usage', async () => {
  const out: string[] = [];
  const err: string[] = [];
  const env = { transport: async () => assert.fail('no request'), clock: fakeClock(), loadCore: () => Core.load(), repoRoot: REPO_ROOT };
  const io = { out: (t: string) => out.push(t), err: (t: string) => err.push(t) };
  assert.equal(await main([], env, io), 0);
  assert.equal(await main(['--version'], env, io), 0);
  assert.match(out.join('\n'), /kaap check <dao> \[id\]/);
  assert.match(out.join('\n'), /kaap 0\.1\.0/);
  assert.equal(await main(['check', 'a.near', '--network', 'devnet'], env, io), 2);
  assert.match(err.join('\n'), /--network must be mainnet or testnet[\s\S]*kaap check <dao>/);
});

test('verify, enroll and arming take the network from --network, else from a .testnet account name', () => {
  assert.deepEqual(parse(['verify', 'kaap-dao-1029064008.testnet', '2']), { command: 'verify', dao: 'kaap-dao-1029064008.testnet', id: 2, network: 'testnet' });
  assert.deepEqual(parse(['verify', 'a.sputnik-dao.near', '2']), { command: 'verify', dao: 'a.sputnik-dao.near', id: 2, network: 'mainnet' });
  assert.deepEqual(parse(['verify', 'a.testnet', '2', '--network', 'mainnet']), { command: 'verify', dao: 'a.testnet', id: 2, network: 'mainnet' });
  assert.deepEqual(parse(['enroll', 'a.sputnikv2.testnet']), { command: 'enroll', dao: 'a.sputnikv2.testnet', network: 'testnet' });
  assert.deepEqual(parse(['arming', 'a.sputnik-dao.near', '--network', 'testnet']), { command: 'arming', dao: 'a.sputnik-dao.near', network: 'testnet' });
  for (const argv of [['verify', 'a.near'], ['verify', 'a.near', 'x'], ['verify', 'a.near', '1', '2'], ['enroll'], ['arming', 'a.near', 'b.near'], ['arming', 'a.near', '--network', 'devnet']]) {
    assert.throws(() => parse(argv), UsageError, argv.join(' '));
  }
});

test('verify takes KAAP_ARCHIVAL_RPC only as an https address, and a bad one exits 2 before any request', async () => {
  const verify = { command: 'verify', dao: 'a.testnet', id: 2, network: 'testnet' };
  assert.deepEqual(parse(['verify', 'a.testnet', '2'], { KAAP_ARCHIVAL_RPC: 'https://archive.example.org/rpc/?project=7' }), { ...verify, archival: 'https://archive.example.org/rpc?project=7' });
  assert.deepEqual(parse(['verify', 'a.testnet', '2'], { KAAP_ARCHIVAL_RPC: '' }), verify);
  for (const value of ['http://archive.example.org', 'archive.example.org', 'https://user:pw@archive.example.org', 'https://archive.example.org/#x']) {
    assert.throws(() => parse(['verify', 'a.testnet', '2'], { KAAP_ARCHIVAL_RPC: value }), /^UsageError: KAAP_ARCHIVAL_RPC must /, value);
  }
  assert.equal((parse(['check', 'a.testnet'], { KAAP_ARCHIVAL_RPC: 'not a url' }) as { command: string }).command, 'check', 'only verify reads it');
  const err: string[] = [];
  const env = { transport: async () => assert.fail('no request'), clock: fakeClock(), loadCore: () => Core.load(), repoRoot: REPO_ROOT, vars: { KAAP_ARCHIVAL_RPC: 'http://archive.example.org' } };
  assert.equal(await main(['verify', 'a.testnet', '2'], env, { out: () => {}, err: (t) => err.push(t) }), 2);
  assert.match(err.join('\n'), /^KAAP_ARCHIVAL_RPC must be an https URL/);
});

test('seal-text needs --dao, --id, --file and a worker from --worker or KAAP_WORKER_URL; subscribe needs an https --worker', () => {
  const sealed = { command: 'seal-text', dao: 'a.testnet', id: 3, file: 't.json', network: 'testnet' };
  assert.deepEqual(parse(['seal-text', '--dao', 'a.testnet', '--id', '3', '--file', 't.json', '--worker', 'https://kaap.example.com/']), { ...sealed, worker: 'https://kaap.example.com' });
  assert.deepEqual(parse(['seal-text', '--dao', 'a.testnet', '--id', '3', '--file', 't.json'], { KAAP_WORKER_URL: 'http://127.0.0.1:8787' }), { ...sealed, worker: 'http://127.0.0.1:8787' });
  assert.deepEqual(parse(['seal-text', '--dao', 'a.testnet', '--id', '3', '--file', 't.json', '--worker', 'https://a.example.com'], { KAAP_WORKER_URL: 'https://b.example.com' }), { ...sealed, worker: 'https://a.example.com' }, '--worker wins');
  assert.throws(() => parse(['seal-text', '--dao', 'a.testnet', '--id', '3', '--file', 't.json']), /needs --worker <https url>, or KAAP_WORKER_URL/);
  assert.throws(() => parse(['seal-text', '--dao', 'a.testnet', '--id', '3', '--file', 't.json'], { KAAP_WORKER_URL: 'http://kaap.example.com' }), /^UsageError: KAAP_WORKER_URL must be an https URL/);
  assert.deepEqual(parse(['seal-text', '--help']), { command: 'help' });
  assert.deepEqual(parse(['subscribe', 'a.near', '--worker', 'https://kaap.example.com/api/']), { command: 'subscribe', dao: 'a.near', worker: 'https://kaap.example.com/api' });
  assert.deepEqual(parse(['subscribe', 'a.near', '--worker', 'http://127.0.0.1:8787']), { command: 'subscribe', dao: 'a.near', worker: 'http://127.0.0.1:8787' });
  for (const argv of [
    ['seal-text', '--dao', 'a.near', '--id', '3'],
    ['seal-text', '--dao', 'a.near', '--file', 't.json'],
    ['seal-text', 'a.near', '--id', '3', '--file', 't.json'],
    ['subscribe', 'a.near'],
    ['subscribe', 'a.near', '--worker', 'http://kaap.example.com'],
    ['subscribe', 'a.near', '--worker', 'https://user:pw@kaap.example.com'],
    ['subscribe', 'a.near', '--worker', 'https://kaap.example.com/?dao=b.near'],
    ['subscribe', 'a.near', '--worker', 'not a url'],
  ]) {
    assert.throws(() => parse(argv), UsageError, argv.join(' '));
  }
});
