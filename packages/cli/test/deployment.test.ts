// The chain of deployment records (deployment.ts): this clone's own two records in order; an earlier
// record named outside deployments/, by `..`, by an absolute path or through a link, refused before
// it is read, while the record that names it is still used; a chain longer than four followed no
// further; a record named twice read once; run hashes of 42 characters read, while one of 33
// bytes is refused; an accepted key of 44 characters that spells 33 bytes refused; and the list of
// sealed builds a record is read with: one that names the owner and the caller apart, one written
// before the split, the mismatches that are refused, and a list named outside packages/sealed. It
// does not cover which record a command picks (the verify, check, enroll and seal-text tests do),
// nor who owns the sealed program on chain, which no command reads.

import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { MAX_DEPLOYMENT_RECORDS } from '../src/caps.js';
import { deploymentChain, describeSealed, loadDeployment, loadTextKey, NoDeployment } from '../src/deployment.js';
import { RECORDED_ROOT, REPO_ROOT } from './replay.js';

/** The 11 Nov 2026 record, kept with the fixtures: the record the tests below build theirs from. */
const TODAY = JSON.parse(readFileSync(join(RECORDED_ROOT, 'deployments', 'testnet.json'), 'utf8')) as Record<string, unknown>;

/** An empty clone with this one's lists of sealed builds. */
function clone(): string {
  const root = mkdtempSync(join(tmpdir(), 'kaap-chain-'));
  mkdirSync(join(root, 'deployments'));
  mkdirSync(join(root, 'packages', 'sealed'), { recursive: true });
  for (const list of readdirSync(join(RECORDED_ROOT, 'packages', 'sealed'))) {
    copyFileSync(join(RECORDED_ROOT, 'packages', 'sealed', list), join(root, 'packages', 'sealed', list));
  }
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

test('this clone\'s own chain is the 13 Nov record, then the 11 Nov and the 29 Oct ones, and its sealed program has an owner that is not its caller', () => {
  const chain = [...deploymentChain(REPO_ROOT, 'testnet')];
  assert.deepEqual(
    chain.map((d) => [d.record, d.current, d.guard, d.registry, d.project, d.buildsRecord]),
    [
      ['deployments/testnet.json', true, 'kaap-guard-1113045147.testnet', 'kaap-registry-1113045147.testnet', 'kaap-sealed-owner-1113041743.testnet/kaap-sealed', 'packages/sealed/testnet.json'],
      ['deployments/testnet-2026-11-11.json', false, 'kaap-guard-1111072803.testnet', 'kaap-registry-1111072803.testnet', 'kaap-worker-1029053612.testnet/kaap-sealed', 'packages/sealed/testnet-2026-10-29.json'],
      ['deployments/testnet-2026-10-29.json', false, 'kaap-guard-1029061211.testnet', 'kaap-registry-1029061211.testnet', 'kaap-worker-1029053612.testnet/kaap-sealed', 'packages/sealed/testnet-2026-10-29.json'],
    ],
  );
  const [now, before] = chain;
  assert.deepEqual([now!.owner, now!.worker, now!.uuid], ['kaap-sealed-owner-1113041743.testnet', 'kaap-worker-1029053612.testnet', 'p0000000000000171']);
  assert.notEqual(now!.owner, now!.worker);
  assert.equal(before!.owner, before!.worker, 'before the split one account did both');
  assert.equal(loadTextKey(REPO_ROOT, now!).publicKey, now!.recordedKey);
});

test('the chain the fixtures were recorded against is the 11 Nov record, then the 29 Oct one it names, and ends there', () => {
  const chain = [...deploymentChain(RECORDED_ROOT, 'testnet')];
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

test('an accepted key of 44 base58 characters that spells 33 bytes is refused, and a real key is read', () => {
  const root = clone();
  const { previous: _today, ...base } = TODAY;
  const write = (key: unknown) => writeFileSync(join(root, 'deployments', 'testnet.json'), JSON.stringify({ ...base, accepted_key: key }));
  write(TODAY['accepted_key']);
  assert.equal(loadDeployment(root, 'testnet').recordedKey, TODAY['accepted_key']);
  write(`ed25519:${'z'.repeat(44)}`);
  assert.throws(() => loadDeployment(root, 'testnet'), NoDeployment);
});

const FIRST_LIST = 'packages/sealed/testnet-2026-10-29.json';
const WATCHER = 'kaap-worker-1029053612.testnet';
const OWNER = 'kaap-sealed-owner-1.testnet';
const SPLIT_LIST = { network: 'testnet', owner: OWNER, caller: WATCHER, project_id: `${OWNER}/kaap-sealed`, contract: 'outlayer.testnet', uuid: 'p00000000000000ff', versions: [{ sha256: 'ab'.repeat(32) }] };

/** A clone whose record names `sealed` over today's, read with `list` as packages/sealed/testnet.json. */
function withList(list: object, sealed: Record<string, unknown>): string {
  const root = clone();
  const { previous: _today, ...base } = TODAY;
  const { builds: _named, ...today } = TODAY['sealed'] as Record<string, unknown>;
  writeFileSync(join(root, 'packages', 'sealed', 'testnet.json'), JSON.stringify(list));
  writeFileSync(join(root, 'deployments', 'testnet.json'), JSON.stringify({ ...base, sealed: { ...today, ...sealed } }));
  return root;
}

test('a list of builds that names its owner and its caller apart is read, and the two are told apart', () => {
  const d = loadDeployment(withList(SPLIT_LIST, { project_id: SPLIT_LIST.project_id }), 'testnet');
  assert.deepEqual([d.project, d.owner, d.worker, d.uuid, d.buildsRecord], [`${OWNER}/kaap-sealed`, OWNER, WATCHER, 'p00000000000000ff', 'packages/sealed/testnet.json']);
  assert.deepEqual([...d.builds], ['ab'.repeat(32)]);
  assert.equal(describeSealed(d), `sealed program ${OWNER}/kaap-sealed, its builds published by ${OWNER}, called by ${WATCHER}`);
});

test('a list written before the split, where one account did both, still reads and is described as such', () => {
  const first = JSON.parse(readFileSync(join(RECORDED_ROOT, FIRST_LIST), 'utf8')) as Record<string, unknown>;
  assert.equal(first['account'], WATCHER);
  const root = clone();
  const { previous: _today, ...base } = TODAY;
  writeFileSync(join(root, 'deployments', 'testnet.json'), JSON.stringify({ ...base, sealed: { ...(TODAY['sealed'] as object), project_id: `${WATCHER}/kaap-sealed`, builds: FIRST_LIST } }));
  const d = loadDeployment(root, 'testnet');
  assert.deepEqual([d.owner, d.worker, d.buildsRecord], [WATCHER, WATCHER, FIRST_LIST]);
  assert.equal(describeSealed(d), `sealed program ${WATCHER}/kaap-sealed, called by ${WATCHER}, the same account that publishes its builds`);
});

test('a list of builds that disagrees with the record on the program, its owner or its caller is refused', () => {
  const sealed = { project_id: SPLIT_LIST.project_id };
  const refused = (list: object, record: Record<string, unknown>, why: string) =>
    assert.throws(() => loadDeployment(withList(list, record), 'testnet'), NoDeployment, why);
  refused({ ...SPLIT_LIST, owner: 'someone-else.testnet' }, sealed, 'an owner that is not the first half of the project id');
  refused({ ...SPLIT_LIST, owner: WATCHER }, sealed, 'the watcher written as the owner of a project it does not own');
  refused({ ...SPLIT_LIST, caller: 'someone-else.testnet' }, sealed, 'a caller that is not the record\'s worker');
  refused(SPLIT_LIST, { project_id: `${WATCHER}/kaap-sealed` }, 'a record that names another program');
  refused({ ...SPLIT_LIST, account: WATCHER }, sealed, 'both spellings at once');
  const { caller: _c, ...ownerOnly } = SPLIT_LIST;
  refused(ownerOnly, sealed, 'an owner and no caller');
  const { owner: _o, ...callerOnly } = SPLIT_LIST;
  refused(callerOnly, sealed, 'a caller and no owner');
  const { owner: _o2, caller: _c2, ...nobody } = SPLIT_LIST;
  refused(nobody, sealed, 'neither spelling');
  assert.match(
    (() => {
      try {
        loadDeployment(withList({ ...SPLIT_LIST, owner: WATCHER }, sealed), 'testnet');
        return '';
      } catch (e) {
        return (e as Error).message;
      }
    })(),
    /^deployments\/testnet\.json and packages\/sealed\/testnet\.json name different sealed programs, owners or callers$/,
  );
});

test('a list of builds named outside packages/sealed is refused before it is read', () => {
  const root = clone();
  const { previous: _today, ...base } = TODAY;
  writeFileSync(join(root, 'outside.json'), JSON.stringify(SPLIT_LIST));
  for (const builds of ['../outside.json', 'outside.json', 'packages/sealed/../../outside.json', 'deployments/testnet.json', join(root, 'outside.json'), 'packages/sealed']) {
    writeFileSync(join(root, 'deployments', 'testnet.json'), JSON.stringify({ ...base, sealed: { ...(TODAY['sealed'] as object), builds } }));
    assert.throws(() => loadDeployment(root, 'testnet'), (e) => e instanceof NoDeployment && /^deployments\/testnet\.json names a list of sealed builds, .*, outside packages\/sealed\/; it was not read$/.test(e.message), builds);
  }
  writeFileSync(join(root, 'deployments', 'testnet.json'), JSON.stringify({ ...base, sealed: { ...(TODAY['sealed'] as object), builds: 'packages/sealed/missing.json' } }));
  assert.throws(() => loadDeployment(root, 'testnet'), /names a list of sealed builds, packages\/sealed\/missing\.json, that is not in this clone$/);
});
