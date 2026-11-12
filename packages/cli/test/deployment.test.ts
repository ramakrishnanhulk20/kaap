// The chain of deployment records (deployment.ts): this clone's own two records in order; an earlier
// record named outside deployments/, by `..`, by an absolute path or through a link, refused before
// it is read, while the record that names it is still used; a chain longer than four followed no
// further; a record named twice read once; and run hashes of 42 characters read, while one of 33
// bytes is refused. It does not cover which record a command picks (the verify, check, enroll and
// seal-text tests do).

import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { MAX_DEPLOYMENT_RECORDS } from '../src/caps.js';
import { deploymentChain, loadDeployment, loadTextKey, NoDeployment } from '../src/deployment.js';
import { REPO_ROOT } from './replay.js';

const TODAY = JSON.parse(readFileSync(join(REPO_ROOT, 'deployments', 'testnet.json'), 'utf8')) as Record<string, unknown>;

/** An empty clone with this one's list of sealed builds. */
function clone(): string {
  const root = mkdtempSync(join(tmpdir(), 'kaap-chain-'));
  mkdirSync(join(root, 'deployments'));
  mkdirSync(join(root, 'packages', 'sealed'), { recursive: true });
  copyFileSync(join(REPO_ROOT, 'packages', 'sealed', 'testnet.json'), join(root, 'packages', 'sealed', 'testnet.json'));
  return root;
}

/** Writes at `path` a copy of today's record with registry `kaap-registry-<n>.testnet` and, when
 *  given, `previous`. */
function record(root: string, path: string, n: number, previous?: string): void {
  const { previous: _today, ...base } = TODAY;
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), JSON.stringify({ ...base, deployed_at: `2026-11-0${n}T00:00:00Z`, registry: { account_id: `kaap-registry-${n}.testnet` }, ...(previous === undefined ? {} : { previous }) }));
}

const registries = (root: string) => [...deploymentChain(root, 'testnet')].map((d) => d.registry);

test('this clone\'s chain is today\'s record, then the 29 Oct one it names, and ends there', () => {
  const chain = [...deploymentChain(REPO_ROOT, 'testnet')];
  assert.deepEqual(
    chain.map((d) => [d.record, d.current, d.deployedAt, d.guard, d.registry]),
    [
      ['deployments/testnet.json', true, '2026-11-11T07:28:03Z', 'kaap-guard-1111072803.testnet', 'kaap-registry-1111072803.testnet'],
      ['deployments/testnet-2026-10-29.json', false, '2026-10-29T06:12:11Z', 'kaap-guard-1029061211.testnet', 'kaap-registry-1029061211.testnet'],
    ],
  );
});

test('an earlier record named outside deployments/ is refused before it is read, and the record naming it still serves', () => {
  const root = clone();
  record(root, 'outside.json', 2);
  record(root, 'secret/x.json', 3);
  const named = ['../outside.json', 'outside.json', 'deployments/../outside.json', 'deployments/../secret/x.json', join(root, 'outside.json'), 'deployments'];
  let linked = true;
  try {
    symlinkSync(join(root, 'outside.json'), join(root, 'deployments', 'link.json'));
    named.push('deployments/link.json');
  } catch {
    linked = false;
  }
  for (const previous of named) {
    record(root, 'deployments/testnet.json', 1, previous);
    const chain = deploymentChain(root, 'testnet');
    assert.equal(chain.next().value?.registry, 'kaap-registry-1.testnet', previous);
    assert.throws(() => chain.next(), (e) => e instanceof NoDeployment && /^deployments\/testnet\.json names an earlier record, .*, outside deployments\/; it was not read$/.test(e.message), previous);
  }
  assert.ok(linked || process.platform === 'win32', 'a link can be made everywhere but on Windows without the right to make one');
  record(root, 'deployments/testnet.json', 1, 'deployments/missing.json');
  assert.throws(() => registries(root), /names an earlier record, deployments\/missing\.json, that is not in this clone$/);
});

test('a chain longer than four records is followed no further, and a record named twice is read once', () => {
  assert.equal(MAX_DEPLOYMENT_RECORDS, 4);
  const root = clone();
  record(root, 'deployments/testnet.json', 1, 'deployments/b.json');
  record(root, 'deployments/b.json', 2, 'deployments/c.json');
  record(root, 'deployments/c.json', 3, 'deployments/d.json');
  record(root, 'deployments/d.json', 4, 'deployments/e.json');
  writeFileSync(join(root, 'deployments', 'e.json'), 'not a record, and never read');
  assert.deepEqual(registries(root), ['kaap-registry-1.testnet', 'kaap-registry-2.testnet', 'kaap-registry-3.testnet', 'kaap-registry-4.testnet']);
  record(root, 'deployments/d.json', 4, '../nowhere.json');
  assert.equal(registries(root).length, 4, 'the fifth link is not even checked');

  record(root, 'deployments/b.json', 2, 'deployments/testnet.json');
  assert.deepEqual(registries(root), ['kaap-registry-1.testnet', 'kaap-registry-2.testnet']);
});

test('a record whose runs have 42-character hashes is read, and one naming 33 bytes as a run is refused', () => {
  const root = clone();
  const { previous: _today, ...base } = TODAY;
  const write = (run: string) =>
    writeFileSync(join(root, 'deployments', 'testnet.json'), JSON.stringify({ ...base, sealed: { ...(TODAY['sealed'] as object), attested_run_tx: run }, text_key: { ...(TODAY['text_key'] as object), run_tx: run } }));
  const short = '1tJ93RwaVfE1PEMxd5rpZZuPtLCwbEaDCrNBjvAWVD';
  write(short);
  const d = loadDeployment(root, 'testnet');
  assert.equal(d.attestedRunTx, short);
  assert.equal(loadTextKey(root, d).runTx, short);
  write('z'.repeat(44));
  assert.throws(() => loadDeployment(root, 'testnet'), NoDeployment);
});
