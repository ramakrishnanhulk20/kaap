// The command line: what each command accepts, the default network, and every refusal. It does not
// run any command (check.test.ts, eval.test.ts and census.test.ts do).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parse, UsageError } from '../src/args.js';
import { main } from '../src/main.js';
import { Core } from '../src/core.js';
import { fakeClock, REPO_ROOT } from './replay.js';

test('check takes a DAO and an optional id, on mainnet unless told otherwise', () => {
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
