#!/usr/bin/env node
// Asks the sealed program for its two keys, as the watcher: the ed25519 key its verdicts are signed
// with, which the guard and the registry are deployed to obey, and the X25519 key a member's text is
// sealed to. OutLayer derives both for one project and one caller, so they are the watcher's keys
// on this project and nobody else's: another caller gets other keys.
//
//   node scripts/sealed-keys.mjs [runs]
//     Testnet, inside WSL. Signs as the caller named in packages/sealed/testnet.json, whose key is
//     read from ~/.near-credentials/testnet and never printed. Each run costs about 0.002 testnet
//     NEAR. Two runs by default, to show the keys do not move from run to run.
//   node scripts/sealed-keys.mjs --as <another account>
//     One run signed by another account, to show what a stranger gets: keys of their own, not the
//     ones the guard obeys. Exit code 0 only when both keys differ from the recorded ones.
//
// Prints each run's transaction, then one JSON object: `signing_key` and `attested_run_tx` for the
// `sealed` part of deployments/testnet.json, and its `text_key` object as the watcher serves it.
// Exit code 0 only when every run printed the same keys and the verdict key's signature over the
// text key verifies here with Node's own crypto.
//
// Not covered: that the keys stay the same across a later build, which packages/sealed/RUNS.md
// shows for the first project, and OutLayer's own derivation, which is taken from its attestation.

import { createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MILLI_NEAR, REPO, TGAS, accountFor, call, refusal, txLink } from './setup-demo-dao.mjs';

// packages/sealed/src/texts.rs signs these bytes and then the key.
const TEXT_KEY_DOMAIN = 'kaap-text-key-v1\n';
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58(text) {
  let n = 0n;
  for (const c of text) {
    const at = ALPHABET.indexOf(c);
    if (at < 0) throw new Error('not base58');
    n = n * 58n + BigInt(at);
  }
  const hex = n.toString(16);
  const body = Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex');
  const zeros = [...text].findIndex((c) => c !== '1');
  return Buffer.concat([Buffer.alloc(zeros < 0 ? text.length : zeros), body]);
}

const record = JSON.parse(readFileSync(join(REPO, 'packages', 'sealed', 'testnet.json'), 'utf8'));
const other = process.argv[2] === '--as' ? process.argv[3] : null;
const runs = other ? 1 : Number(process.argv[2] ?? 2);
if (record.network !== 'testnet' || typeof record.caller !== 'string' || !/^[0-9a-f]{64}$/.test(record.active_version ?? '') || !Number.isInteger(runs) || runs < 1 || runs > 5) {
  console.error('usage: node scripts/sealed-keys.mjs [1 to 5 runs] | --as <account>, with a published project in packages/sealed/testnet.json');
  process.exit(2);
}
if (other !== null && (!/^[a-z0-9._-]{2,64}$/.test(other ?? '') || other === record.caller)) {
  console.error('--as takes an account other than the caller in packages/sealed/testnet.json');
  process.exit(2);
}

async function main() {
  console.log(`Kaap sealed keys, ${new Date().toISOString()}: ${other ?? record.caller} asks ${record.project_id} (build ${record.active_version}) for its keys, ${runs} time(s)`);
  const caller = accountFor(other ?? record.caller);
  // All three limits written out: an empty resource_limits object is never picked up (OutLayer #31).
  const args = {
    source: { Project: { project_id: record.project_id, version_key: null } },
    input_data: '{"v":1,"op":"pubkey"}',
    response_format: 'Json',
    resource_limits: { max_instructions: 10_000_000_000, max_memory_mb: 128, max_execution_seconds: 60 },
  };
  const answers = [];
  for (let n = 1; n <= runs; n++) {
    const { hash, outcome, failure } = await call(caller, record.contract, 'request_execution', args, 300n * TGAS, 20n * MILLI_NEAR);
    if (failure) throw new Error(`run ${n} failed in ${hash}: ${refusal(failure)}`);
    const text = Buffer.from(outcome.status.SuccessValue ?? '', 'base64').toString('utf8');
    let answer;
    try {
      answer = JSON.parse(text);
      // OutLayer hands a Json answer back as a JSON string of the program's own output.
      if (typeof answer === 'string') answer = JSON.parse(answer);
    } catch {
      throw new Error(`run ${n} (${hash}) did not print JSON: ${text.slice(0, 200)}`);
    }
    console.log(`  run ${n}: ${txLink(hash)}: verdict key ${answer.public_key}, text key ${answer.text_key}`);
    answers.push({ hash, answer });
  }
  const first = answers[0].answer;
  const key = Buffer.from(first.text_key ?? '', 'hex');
  const signature = Buffer.from(first.signature ?? '', 'base64');
  const shaped = first.status === 'ok' && key.length === 32 && signature.length === 64 && /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(first.public_key ?? '');
  const same = answers.every(({ answer }) => answer.public_key === first.public_key && answer.text_key === first.text_key);
  let signed = false;
  if (shaped) {
    const publicKey = createPublicKey({ key: Buffer.concat([ED25519_SPKI, base58(first.public_key.slice(8))]), format: 'der', type: 'spki' });
    signed = verify(null, Buffer.concat([Buffer.from(TEXT_KEY_DOMAIN), key]), publicKey, signature);
  }
  console.log(`  every run printed the same two keys: ${same}; the verdict key signed the text key: ${signed}`);
  if (other) {
    const deployed = JSON.parse(readFileSync(join(REPO, 'deployments', 'testnet.json'), 'utf8'));
    const apart = shaped && signed && first.public_key !== deployed.accepted_key && first.text_key !== deployed.text_key?.key;
    console.log(`  the guard obeys ${deployed.accepted_key}; texts are sealed to ${deployed.text_key?.key}`);
    console.log(apart ? `RESULT: pass, ${other} gets keys of its own on this project, not the watcher's` : 'RESULT: FAIL, another caller got a key the guard obeys or texts are sealed to');
    process.exit(apart ? 0 : 1);
  }
  if (!shaped || !same || !signed) {
    console.log('RESULT: FAIL');
    process.exit(1);
  }
  console.log(JSON.stringify({ signing_key: first.public_key, attested_run_tx: answers[0].hash, text_key: { key: first.text_key, signature: first.signature, public_key: first.public_key, run_tx: answers[0].hash, build: record.active_version } }, null, 2));
  console.log('RESULT: pass');
}

main().catch((e) => {
  console.error(`FAILED: ${e?.message ?? e}`);
  process.exit(1);
});
