#!/usr/bin/env node
// Places the watcher's two secrets on Railway from the machine that holds them, printing neither:
//
//   1. TELEGRAM_BOT_TOKEN, read from .env at the repository root, as a service variable. Railway
//      then starts the service again, and the container waits for the key file.
//   2. The watcher account's key file, onto the service's disk, where the service's
//      KAAP_WORKER_CREDENTIALS_FILE points. The key is never a variable and never in the image.
//
// Then it waits for the watcher's public /status to answer.
//
// From the repository root, with the Railway command line signed in:
//   node scripts/railway-secrets.mjs --key-file <the near-cli key file of the watcher account>
// Options, with their defaults: --project kaap --service watcher --volume watcher-volume
//   --environment production. Add --dry-run to make every check and place nothing.
// The person who runs this is the one moving the secrets: it asks nothing and shows no value.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};
const keyFile = option('key-file');
const service = option('service', 'watcher');
const volume = option('volume', 'watcher-volume');
const environment = option('environment', 'production');
const project = option('project', 'kaap');
const dryRun = args.includes('--dry-run');

const fail = (message) => {
  console.error(`STOPPED: ${message}`);
  process.exit(1);
};

/** Runs the Railway command line. Its own output is shown only when `show` is set, since some
 *  commands echo what they were given. */
function railway(parameters, { input, show = false } = {}) {
  // On Windows the command is a .cmd file, which only a shell can start, so each parameter is
  // quoted for that shell. No secret is ever a parameter: the token goes in on standard input.
  const windows = process.platform === 'win32';
  const quoted = windows ? parameters.map((p) => (/^[A-Za-z0-9_.\/:=@\-]+$/.test(p) ? p : `"${p.replaceAll('"', '')}"`)) : parameters;
  const r = spawnSync('railway', quoted, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], shell: windows, env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  if (r.error) fail(`the railway command could not be run: ${r.error.message}`);
  if (show) process.stdout.write(r.stdout);
  return { ok: r.status === 0, out: r.stdout, err: r.stderr };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!keyFile) fail('give the key file: --key-file <path>');
if (!existsSync(keyFile)) fail(`there is no file at ${keyFile}`);

const linked = railway(['status', '--json']);
if (!linked.ok) fail('this folder is not linked to a Railway project: run "railway link" here first');
let linkedName = '';
try {
  linkedName = JSON.parse(linked.out).name ?? '';
} catch {
  fail('the Railway command line gave an answer this script cannot read');
}
if (linkedName !== project) fail(`this folder is linked to the Railway project "${linkedName}", not "${project}"`);

const listed = railway(['variable', 'list', '--service', service, '--environment', environment, '--json']);
if (!listed.ok) fail(`the service ${service} could not be read: ${listed.err.trim().slice(0, 200)}`);
const variables = JSON.parse(listed.out);
const account = variables.KAAP_WORKER_ACCOUNT;
const remoteFull = variables.KAAP_WORKER_CREDENTIALS_FILE;
const mount = variables.RAILWAY_VOLUME_MOUNT_PATH;
if (!account || !remoteFull) fail(`the service ${service} has no KAAP_WORKER_ACCOUNT or KAAP_WORKER_CREDENTIALS_FILE`);
if (!mount || !remoteFull.startsWith(`${mount}/`)) fail(`KAAP_WORKER_CREDENTIALS_FILE (${remoteFull}) is not on the service's disk (${mount ?? 'no disk'})`);
// File commands name a path inside the disk, not inside the container.
const remote = remoteFull.slice(mount.length);

let saved;
try {
  saved = JSON.parse(readFileSync(keyFile, 'utf8'));
} catch {
  fail(`${keyFile} is not a near-cli key file`);
}
if (typeof saved.private_key !== 'string' || !saved.private_key.startsWith('ed25519:')) fail(`${keyFile} holds no ed25519 key`);
if (saved.account_id !== undefined && saved.account_id !== account) fail(`${keyFile} is the key of ${saved.account_id}, and the service runs as ${account}`);

// The key must be one the chain holds for that account with full access, or the watcher could not
// send with it. Asked of the service's own first RPC provider, with the public half only.
if (typeof saved.public_key !== 'string' || !variables.KAAP_RPC_PRIMARY) fail(`${keyFile} names no public key, or the service has no KAAP_RPC_PRIMARY`);
try {
  const res = await fetch(variables.KAAP_RPC_PRIMARY, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'kaap', method: 'query', params: { request_type: 'view_access_key', finality: 'final', account_id: account, public_key: saved.public_key } }),
    signal: AbortSignal.timeout(10_000),
  });
  const answer = await res.json();
  if (answer.result?.permission !== 'FullAccess') fail(`${account} has no full-access key matching ${keyFile}`);
} catch (e) {
  fail(`the chain could not be asked about the key: ${String(e?.message ?? e).slice(0, 120)}`);
}

const envFile = fileURLToPath(new URL('../.env', import.meta.url));
const tokenLine = existsSync(envFile) ? readFileSync(envFile, 'utf8').split(/\r?\n/).find((l) => l.startsWith('TELEGRAM_BOT_TOKEN=')) : undefined;
const token = tokenLine?.slice('TELEGRAM_BOT_TOKEN='.length).trim().replace(/^["']|["']$/g, '');
if (!token || !/^\d{5,16}:[A-Za-z0-9_-]{30,64}$/.test(token)) fail('.env has no TELEGRAM_BOT_TOKEN in the shape BotFather gives');

console.log(`Railway project ${project}, service ${service}, running as ${account}`);
if (dryRun) {
  console.log(`dry run: the bot token in .env has the right shape, and ${keyFile} is a full-access key of ${account} on chain`);
  console.log(`dry run: it would set TELEGRAM_BOT_TOKEN on ${service} and place the key file at ${remoteFull} (${remote} on the disk ${volume})`);
  process.exit(0);
}
const set = railway(['variable', 'set', 'TELEGRAM_BOT_TOKEN', '--stdin', '--service', service, '--environment', environment], { input: token });
if (!set.ok) fail(`the bot token could not be set: ${set.err.trim().slice(0, 200)}`);
console.log('1 of 3  bot token set as a service variable; the service is starting again');

// File commands work only against a running deployment, so this waits for the restart.
let uploaded = false;
for (let i = 0; i < 60 && !uploaded; i++) {
  await sleep(i === 0 ? 20_000 : 8_000);
  const up = railway(['volume', 'files', '--volume', volume, 'upload', keyFile, remote, '--overwrite']);
  uploaded = up.ok;
  if (!up.ok && !/no active deployment|not ready|deploying|restart/i.test(up.err + up.out)) fail(`the key file could not be placed: ${(up.err || up.out).trim().slice(0, 200)}`);
}
if (!uploaded) fail('the service did not come up within eight minutes; nothing was placed');
console.log(`2 of 3  key file placed on the disk at ${remoteFull}`);

const domains = railway(['domain', 'list', '--service', service, '--environment', environment, '--json']);
let host = '';
try {
  const parsed = JSON.parse(domains.out);
  const all = Array.isArray(parsed) ? parsed : [...(parsed.serviceDomains ?? []), ...(parsed.customDomains ?? []), ...(parsed.domains ?? [])];
  host = all.map((d) => d.domain ?? d.name ?? '').find((d) => typeof d === 'string' && d.includes('.')) ?? '';
} catch {
  host = '';
}
if (!host) {
  console.log('3 of 3  done; the service has no public address to check, so read its logs: railway logs');
  process.exit(0);
}
for (let i = 0; i < 40; i++) {
  await sleep(5_000);
  try {
    const res = await fetch(`https://${host}/status`, { signal: AbortSignal.timeout(8_000) });
    if (res.ok) {
      const body = await res.json();
      console.log(`3 of 3  the watcher answers at https://${host}/status: ${body.status}, watching ${body.watching} treasury`);
      process.exit(0);
    }
  } catch {
    // Not up yet.
  }
}
fail(`the key is placed, but https://${host}/status did not answer within three minutes: run "railway logs" to see why`);
