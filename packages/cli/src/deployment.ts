// Where Kaap runs on a network, read from the repository's own records: `deployments/<network>.json`
// (the guard, the registry, the sealed program, the run that printed its key, and the key a text is
// sealed to) and `packages/sealed/<network>.json` (every build of the sealed program ever
// published). These are what `verify`, `enroll`, `arming` and `seal-text` check the chain against.
// Each file is read through a strict schema and a missing or unreadable one stops the command, so
// nothing is checked against a guess.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import type { Network } from './rpc.js';

export class NoDeployment extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoDeployment';
  }
}

const account = z.string().min(2).max(64);
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const txHash = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
const edKey = z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/);

const deploymentsSchema = z.looseObject({
  network: z.enum(['mainnet', 'testnet']),
  accepted_key: edKey,
  guard: z.looseObject({ account_id: account }),
  registry: z.looseObject({ account_id: account }),
  sealed: z.looseObject({
    project_id: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
    worker_account: account,
    signing_key: edKey,
    attested_run_tx: txHash,
  }),
});

const buildsSchema = z.looseObject({
  network: z.enum(['mainnet', 'testnet']),
  account: account,
  project_id: z.string(),
  contract: account,
  uuid: z.string().regex(/^[0-9a-z]{1,64}$/),
  versions: z.array(z.looseObject({ sha256: sha256Hex })).min(1),
});

export interface Deployment {
  network: Network;
  guard: string;
  registry: string;
  /** The key `deployments/<network>.json` says the guard was set up with. The guard's own
   *  `accepted_key()` is what counts; this is only shown next to it. */
  recordedKey: string;
  /** `owner/name` of the sealed program on OutLayer, and the uuid its keys belong to. */
  project: string;
  uuid: string;
  /** The one account that calls the sealed program; its keys are bound to this caller. */
  worker: string;
  /** The OutLayer contract that runs requests on this network. */
  outlayer: string;
  /** The run whose attested output printed the program's public key. */
  attestedRunTx: string;
  /** The sha256 of every published build. */
  builds: ReadonlySet<string>;
}

/** The worker's record of one `{"v":1,"op":"pubkey"}` run (WO-06d). */
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

/** Kaap's deployment on `network`, from the clone of the repository at `repoRoot`. */
export function loadDeployment(repoRoot: string, network: Network): Deployment {
  const where = join(repoRoot, 'deployments', `${network}.json`);
  const buildsAt = join(repoRoot, 'packages', 'sealed', `${network}.json`);
  if (!existsSync(where)) throw new NoDeployment(`Kaap has no ${network} deployment recorded yet (no ${where}); this command runs from a clone of the Kaap repository`);
  if (!existsSync(buildsAt)) throw new NoDeployment(`Kaap has no published ${network} build of its sealed program recorded (no ${buildsAt})`);
  const d = deploymentsSchema.safeParse(read(where));
  const b = buildsSchema.safeParse(read(buildsAt));
  if (!d.success || d.data.network !== network) throw new NoDeployment(`${where} is not a readable Kaap deployment record for ${network}`);
  if (!b.success || b.data.network !== network) throw new NoDeployment(`${buildsAt} is not a readable list of sealed builds for ${network}`);
  if (b.data.project_id !== d.data.sealed.project_id || b.data.account !== d.data.sealed.worker_account) {
    throw new NoDeployment(`${where} and ${buildsAt} name different sealed programs or callers`);
  }
  return {
    network,
    guard: d.data.guard.account_id,
    registry: d.data.registry.account_id,
    recordedKey: d.data.accepted_key,
    project: d.data.sealed.project_id,
    uuid: b.data.uuid,
    worker: d.data.sealed.worker_account,
    outlayer: b.data.contract,
    attestedRunTx: d.data.sealed.attested_run_tx,
    builds: new Set(b.data.versions.map((v) => v.sha256)),
  };
}

/** The key a text is sealed to on `network`, as the worker recorded it in `deployments/<network>.json`.
 *  Only read here: whether it is the sealed program's key is the signature check, against the key
 *  the guard accepts on chain. */
export function loadTextKey(repoRoot: string, network: Network): TextKey {
  const where = join(repoRoot, 'deployments', `${network}.json`);
  const record = read(where);
  const found = typeof record === 'object' && record !== null ? (record as Record<string, unknown>)['text_key'] : undefined;
  if (found === undefined) {
    throw new NoDeployment(`Kaap's worker has not published the key a text is sealed to on ${network} yet (no text_key in ${where}). Nothing was sent.`);
  }
  const parsed = textKeySchema.safeParse(found);
  const signature = parsed.success ? Buffer.from(parsed.data.signature, 'base64') : null;
  if (!parsed.success || signature?.length !== 64) throw new NoDeployment(`the text_key in ${where} is not a readable key record. Nothing was sent.`);
  return { key: Buffer.from(parsed.data.key, 'hex'), signature, publicKey: parsed.data.public_key, runTx: parsed.data.run_tx };
}
