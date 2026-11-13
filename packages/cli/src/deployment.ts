// Where Kaap runs on a network, read from the repository's own records: `deployments/<network>.json`
// (the guard and the registry with the sha256 of the build each was deployed with, the sealed
// program, the run that printed its key, and the key a text is sealed to) and the list of builds
// that record names, `packages/sealed/<network>.json` unless it says otherwise (every build of the
// sealed program ever published, the account that publishes them and the account that calls
// them). These are
// what `verify`, `check`, `enroll`, `arming` and `seal-text` check the chain against. A redeploy
// keeps the record it replaced and names it in `previous`, so a verdict or an
// enrolment made under an earlier deployment is still checked against that deployment: the chain is
// followed from the current record, at most `MAX_DEPLOYMENT_RECORDS` records, each by the exact path
// it is named by and only inside `deployments/`. Each file is read through a strict schema and a
// missing or unreadable one stops the command, so nothing is checked against a guess.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { z } from 'zod';

import { MAX_DEPLOYMENT_RECORDS } from './caps.js';
import { Held, type Reader } from './chain.js';
import { type Block, isTxHash, type Network } from './rpc.js';
import { oneLine } from './text.js';
import { base58 } from './verdict.js';

export class NoDeployment extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoDeployment';
  }
}

const account = z.string().min(2).max(64);
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const txHash = z.string().refine(isTxHash);
/** An ed25519 public key as NEAR writes it: `ed25519:` and base58 of exactly 32 bytes, at whatever
 *  length base58 writes them. Counting characters is not enough: 44 of them can spell 33 bytes. */
export const isEdKey = (text: string) => text.startsWith('ed25519:') && text.length <= 52 && base58(text.slice(8))?.length === 32;
const edKey = z.string().refine(isEdKey);

const deploymentsSchema = z.looseObject({
  network: z.enum(['mainnet', 'testnet']),
  deployed_at: z.string().min(1).max(64),
  previous: z.string().min(1).max(200).optional(),
  accepted_key: edKey,
  guard: z.looseObject({ account_id: account, code_sha256: sha256Hex.optional() }),
  registry: z.looseObject({ account_id: account, code_sha256: sha256Hex.optional() }),
  sealed: z.looseObject({
    project_id: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
    worker_account: account,
    builds: z.string().min(1).max(200).optional(),
    signing_key: edKey,
    attested_run_tx: txHash,
  }),
});

// Who publishes builds and who calls them: `owner` and `caller`, or in a list written before the
// two were split, the one `account` that did both. A list that gives both spellings, or half of
// one, is not read.
const buildsSchema = z
  .looseObject({
    network: z.enum(['mainnet', 'testnet']),
    account: account.optional(),
    owner: account.optional(),
    caller: account.optional(),
    project_id: z.string(),
    contract: account,
    uuid: z.string().regex(/^[0-9a-z]{1,64}$/),
    versions: z.array(z.looseObject({ sha256: sha256Hex })).min(1),
  })
  .refine((b) => (b.account === undefined ? b.owner !== undefined && b.caller !== undefined : b.owner === undefined && b.caller === undefined));

export interface Deployment {
  network: Network;
  /** The record's path from the repository root: `deployments/<network>.json` for the current one,
   *  else the path the record after it names in `previous`. */
  record: string;
  /** Whether this is the current record, rather than one reached through `previous`. */
  current: boolean;
  /** When the record says this deployment was made, as it writes it. */
  deployedAt: string;
  guard: string;
  registry: string;
  /** The sha256 of the build the record says each was deployed with, lower-case hex; null when the
   *  record names none, which the commands that check it count as a failed check. */
  guardCode: string | null;
  registryCode: string | null;
  /** The key the record says the guard was set up with. The guard's own `accepted_key()` is what
   *  counts; this is only shown next to it. */
  recordedKey: string;
  /** `owner/name` of the sealed program on OutLayer, and the uuid its keys belong to. */
  project: string;
  uuid: string;
  /** The account that publishes builds of the sealed program: the first half of `project`. */
  owner: string;
  /** The one account that calls the sealed program; its keys are bound to this caller. */
  worker: string;
  /** The list of builds this record was read with, as a path from the repository root. */
  buildsRecord: string;
  /** The OutLayer contract that runs requests on this network. */
  outlayer: string;
  /** The run whose attested output printed the program's public key. */
  attestedRunTx: string;
  /** The sha256 of every published build. */
  builds: ReadonlySet<string>;
}

/** The worker's record of one `{"v":1,"op":"pubkey"}` run: the `text_key` object that
 *  packages/worker/HOSTING.md describes. */
const textKeySchema = z.strictObject({
  key: z.string().regex(/^[0-9a-fA-F]{64}$/),
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
  public_key: edKey,
  run_tx: txHash,
  build: sha256Hex,
});

export interface TextKey {
  /** The sealed program's X25519 public key, 32 bytes. */
  key: Buffer;
  /** 64 bytes of ed25519 over `kaap-text-key-v1\n` and `key`, by the program's verdict key. */
  signature: Buffer;
  /** The verdict key the record says signed it. The guard's own `accepted_key()` is what counts. */
  publicKey: string;
  /** The worker-signed run that printed the key. */
  runTx: string;
}

function read(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Whether `path` lies under `dir`, both already resolved the same way. */
function under(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** The file a record names, from the repository root, refused unless it lies inside `folder` both
 *  as written and once every link on the way is resolved, so neither `..` nor a link leads out. */
function namedFile(repoRoot: string, folder: string, named: string, by: string, what: string): string {
  const dir = resolve(repoRoot, folder);
  const path = resolve(repoRoot, named);
  const outside = new NoDeployment(`${by} names ${what}, ${oneLine(named, 120)}, outside ${folder}/; it was not read`);
  if (isAbsolute(named) || !under(dir, path)) throw outside;
  if (!existsSync(path)) throw new NoDeployment(`${by} names ${what}, ${oneLine(named, 120)}, that is not in this clone`);
  if (!under(realpathSync(dir), realpathSync(path))) throw outside;
  return path;
}

const earlierRecord = (repoRoot: string, named: string, by: string) => namedFile(repoRoot, 'deployments', named, by, 'an earlier record');

function deploymentAt(repoRoot: string, network: Network, path: string, record: string, current: boolean): { d: Deployment; previous: string | undefined } {
  const d = deploymentsSchema.safeParse(read(path));
  if (!d.success || d.data.network !== network) throw new NoDeployment(`${record} is not a readable Kaap deployment record for ${network}`);
  const buildsRecord = d.data.sealed.builds ?? `packages/sealed/${network}.json`;
  let buildsAt = join(repoRoot, 'packages', 'sealed', `${network}.json`);
  if (d.data.sealed.builds !== undefined) buildsAt = namedFile(repoRoot, 'packages/sealed', d.data.sealed.builds, record, 'a list of sealed builds');
  else if (!existsSync(buildsAt)) throw new NoDeployment(`Kaap has no published ${network} build of its sealed program recorded (no ${buildsAt})`);
  const b = buildsSchema.safeParse(read(buildsAt));
  if (!b.success || b.data.network !== network) throw new NoDeployment(`${oneLine(buildsRecord, 120)} is not a readable list of sealed builds for ${network}`);
  const owner = b.data.owner ?? b.data.account;
  const caller = b.data.caller ?? b.data.account;
  // A project's id is `<owner>/<name>` on OutLayer, so the list's owner must be the one the id names.
  if (b.data.project_id !== d.data.sealed.project_id || owner === undefined || d.data.sealed.project_id.split('/')[0] !== owner || caller !== d.data.sealed.worker_account) {
    throw new NoDeployment(`${record} and ${oneLine(buildsRecord, 120)} name different sealed programs, owners or callers`);
  }
  return {
    d: {
      network,
      record,
      current,
      deployedAt: d.data.deployed_at,
      guard: d.data.guard.account_id,
      registry: d.data.registry.account_id,
      guardCode: d.data.guard.code_sha256 ?? null,
      registryCode: d.data.registry.code_sha256 ?? null,
      recordedKey: d.data.accepted_key,
      project: d.data.sealed.project_id,
      uuid: b.data.uuid,
      owner,
      worker: d.data.sealed.worker_account,
      buildsRecord,
      outlayer: b.data.contract,
      attestedRunTx: d.data.sealed.attested_run_tx,
      builds: new Set(b.data.versions.map((v) => v.sha256)),
    },
    previous: d.data.previous,
  };
}

/** Kaap's deployments on `network`, current first, then each earlier one its `previous` names, at
 *  most `MAX_DEPLOYMENT_RECORDS` and never one already read. A record's link is checked and read
 *  only when the caller asks for the record after it, so a bad link stops only a command that needs
 *  to go past it. */
export function* deploymentChain(repoRoot: string, network: Network): Generator<Deployment, void, undefined> {
  let record = `deployments/${network}.json`;
  let path = join(repoRoot, 'deployments', `${network}.json`);
  if (!existsSync(path)) throw new NoDeployment(`Kaap has no ${network} deployment recorded yet (no ${path}); this command runs from a clone of the Kaap repository`);
  const seen = new Set<string>();
  for (let n = 0; ; n++) {
    seen.add(realpathSync(path));
    const { d, previous } = deploymentAt(repoRoot, network, path, record, n === 0);
    yield d;
    if (previous === undefined || n + 1 >= MAX_DEPLOYMENT_RECORDS) return;
    const next = earlierRecord(repoRoot, previous, record);
    if (seen.has(realpathSync(next))) return;
    [record, path] = [previous, next];
  }
}

/** Kaap's current deployment on `network`, from the clone of the repository at `repoRoot`. */
export function loadDeployment(repoRoot: string, network: Network): Deployment {
  for (const d of deploymentChain(repoRoot, network)) return d;
  throw new NoDeployment(`Kaap has no ${network} deployment recorded yet`);
}

/** The deployment whose guard `dao` is enrolled with, current first, as both providers agree at
 *  `head`; the current one, not enrolled, when no guard in the chain has it. */
export async function enrolledDeployment(reader: Reader, repoRoot: string, network: Network, dao: string, head: Block): Promise<{ d: Deployment; enrolled: boolean }> {
  let current: Deployment | null = null;
  const asked = new Set<string>();
  for (const d of deploymentChain(repoRoot, network)) {
    current ??= d;
    if (asked.has(d.guard)) continue;
    asked.add(d.guard);
    const enrolled = await reader.sameJson(`the enrolment in ${d.guard}`, d.guard, 'is_enrolled', { dao }, head);
    if (typeof enrolled !== 'boolean') throw new Held(`${d.guard}'s is_enrolled answer is not true or false`);
    if (enrolled) return { d, enrolled };
  }
  if (current === null) throw new NoDeployment(`Kaap has no ${network} deployment recorded yet`);
  return { d: current, enrolled: false };
}

/** The record a deployment came from, its date and its guard and registry, for one line of output,
 *  with an earlier deployment named as such so it is never taken for the current one. */
export function describeDeployment(d: Deployment): string {
  const which = d.current ? 'the current one' : `an earlier deployment, not the current deployments/${d.network}.json`;
  return `deployment record ${oneLine(d.record, 120)} (${which}, deployed ${oneLine(d.deployedAt, 40)}): guard ${d.guard}, registry ${d.registry}`;
}

/** The sealed program of a deployment, who publishes its builds and who calls it, for one line of
 *  output. One account doing both is said plainly: its key can replace the program. */
export function describeSealed(d: Deployment): string {
  return d.owner === d.worker
    ? `sealed program ${d.project}, called by ${d.worker}, the same account that publishes its builds`
    : `sealed program ${d.project}, its builds published by ${d.owner}, called by ${d.worker}`;
}

/** The key a text is sealed to under deployment `d`, as the worker recorded it in that record. Only
 *  read here: whether it is the sealed program's key is the signature check, against the key the
 *  guard accepts on chain. */
export function loadTextKey(repoRoot: string, d: Deployment): TextKey {
  const where = d.record;
  const record = read(join(repoRoot, d.record));
  const found = typeof record === 'object' && record !== null ? (record as Record<string, unknown>)['text_key'] : undefined;
  if (found === undefined) {
    throw new NoDeployment(`Kaap's worker has not published the key a text is sealed to on ${d.network} yet (no text_key in ${where}). Nothing was sent.`);
  }
  const parsed = textKeySchema.safeParse(found);
  const signature = parsed.success ? Buffer.from(parsed.data.signature, 'base64') : null;
  if (!parsed.success || signature?.length !== 64) throw new NoDeployment(`the text_key in ${where} is not a readable key record. Nothing was sent.`);
  return { key: Buffer.from(parsed.data.key, 'hex'), signature, publicKey: parsed.data.public_key, runTx: parsed.data.run_tx };
}
