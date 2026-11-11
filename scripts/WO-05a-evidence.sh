#!/usr/bin/env bash
# Shows what Kaap checked before it called an AI answer verified, for one real run on testnet. Reads
# the transaction's output, hashes the verdict, fetches the evidence record the job published under
# that hash, and prints it. Needs node and curl. No account, no key.
#
# Usage: bash scripts/WO-05a-evidence.sh <transaction hash>
#
# Refuses, exit 1, when the record is missing or names a different verdict.
# Does NOT repeat Intel's, NVIDIA's or NEAR AI's checks: it shows what the run recorded and ties that
# record to the transaction by hash. To repeat them, run a DCAP verifier over the full quote in the
# record, or open the verify link it prints.
set -euo pipefail

command -v node > /dev/null || { echo "this script needs node" >&2; exit 2; }
command -v curl > /dev/null || { echo "this script needs curl" >&2; exit 2; }

exec node --input-type=module - "$@" <<'JS'
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// Archival, because this has to keep working long after a run: the plain RPC answered
// UNKNOWN_TRANSACTION for a run only seven days old.
const RPC = 'https://archival-rpc.testnet.fastnear.com';
const API = 'https://testnet-api.outlayer.ai';
const WORKER = 'kaap-worker-1029053612.testnet';
const PROJECT = `${WORKER}/kaap-sealed`;
// The job's output leaves this prefix off, but the hash it publishes under includes it.
const VERDICT_DOMAIN = Buffer.from('kaap-verdict-v1\n');

const refuse = (why) => {
  console.error(`refused: ${why}`);
  process.exit(1);
};
// Everything printed came over the network, so no control code from it reaches the terminal.
const clean = (value) => String(value).replace(/[^\x20-\x7e]/g, '?');
const line = (label, value) => console.log(`  ${label.padEnd(24)} ${clean(value ?? 'not recorded')}`);
const heading = (text) => console.log(`\n${clean(text)}`);
const ids = (list) => (Array.isArray(list) ? list.join(', ') || 'none' : undefined);

function curl(args) {
  try {
    return execFileSync('curl', ['-sS', '--max-time', '30', '--retry', '4', '--retry-delay', '3', ...args], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    refuse(`the network call failed: ${clean(String(e.stderr || e.message).trim()).slice(0, 300)}`);
  }
}

function parsed(text, what) {
  try {
    return JSON.parse(text);
  } catch {
    refuse(`${what} is not JSON`);
  }
}

const [tx] = process.argv.slice(2);
if (process.argv.length !== 3 || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(tx)) {
  console.error('usage: bash scripts/WO-05a-evidence.sh <transaction hash>');
  process.exit(2);
}

const request = JSON.stringify({
  jsonrpc: '2.0',
  id: 'kaap',
  method: 'EXPERIMENTAL_tx_status',
  // NONE, with finality checked below: FINAL makes the RPC sit and wait for a hash it has never seen.
  params: { tx_hash: tx, sender_account_id: WORKER, wait_until: 'NONE' },
});
const answer = parsed(curl(['-H', 'content-type: application/json', '-d', request, RPC]), 'the RPC answer');
if (answer.error) refuse(`the RPC could not give this transaction: ${clean(JSON.stringify(answer.error)).slice(0, 300)}`);
if (answer.result?.final_execution_status !== 'FINAL') refuse('this transaction is not final yet');
const value = answer.result?.status?.SuccessValue;
if (value === undefined) refuse('this transaction did not finish with a result');

const job = parsed(Buffer.from(value, 'base64').toString('utf8'), "the transaction's output");
if (job.status !== 'ok' || typeof job.verdict !== 'string') {
  refuse(`this run gave no verdict, so it has no evidence (status ${clean(job.status)}, ${clean(job.reason)})`);
}

const hash = createHash('sha256').update(VERDICT_DOMAIN).update(Buffer.from(job.verdict, 'base64')).digest('hex');
const url = `${API}/public/storage/get?project=${PROJECT}&key=ai-evidence:${hash}`;

const stored = parsed(curl([url]), "OutLayer's storage answer");
if (stored.exists !== true || typeof stored.value !== 'string') {
  refuse(`no evidence record is stored for this verdict: ${url}`);
}
const record = parsed(Buffer.from(stored.value, 'base64').toString('utf8'), 'the evidence record');
if (record.verdict_hash !== hash) {
  refuse(`the record names verdict ${clean(record.verdict_hash)}, but this transaction's verdict hashes to ${hash}`);
}

heading('Tied to the transaction');
line('transaction', tx);
line('verdict sha256', hash);
line('record verdict_hash', `${record.verdict_hash} (matches)`);
line('record', url);

heading('Result');
line('ai_status', record.ai_status);
if (record.reason !== undefined) line('reason', record.reason);
line('model id', record.model_id);
line('chat id', record.completion?.chat_id);
line('nonce', record.nonce);

const quotes = Array.isArray(record.model_quotes) ? record.model_quotes : [];
if (quotes.length === 0) heading('Model quote: not recorded');
quotes.forEach((model, i) => {
  const quote = typeof model.intel_quote === 'string' ? model.intel_quote : '';
  const flags = Object.entries(model.pck_flags ?? {}).map(([name, flag]) => `${name}=${flag}`);
  heading(`Model quote ${i + 1} of ${quotes.length}, the machine that ran the model`);
  line('signing address', model.signing_address);
  line('TCB status', model.tcb_status);
  line('advisory ids', ids(model.advisory_ids));
  line('TCB eval data number', model.tcb_eval_data_number);
  line('PCK flags', flags.join(' ') || undefined);
  line('PCK flags policy', model.pck_flags_policy);
  line('GPU count', model.gpus);
  line('NRAS result', model.nras_passed === undefined ? undefined : model.nras_passed ? 'passed' : 'failed');
  line('NRAS issued at (unix)', model.nras_issued_at);
  line('Intel quote', `${quote.length} hex characters, starts ${quote.slice(0, 32)}`);

  heading('Software record (recorded and proven consistent, not judged)');
  if (model.compose_hash === undefined) {
    console.log('  not in this record: the run predates the software checks');
    return;
  }
  line('MRTD', model.mr_td);
  line('MRCONFIGID', model.mr_config_id);
  for (const r of ['rtmr0', 'rtmr1', 'rtmr2', 'rtmr3']) line(r.toUpperCase(), model[r]);
  line('launcher compose hash', model.compose_hash);
  line('system image hash', model.os_image_hash);
  const known = model.os_image_known;
  line('system image published', known === undefined ? undefined : known ? 'yes, by the OS vendor' : 'no (recorded, not judged)');
  line('app id', model.app_id);
  line('instance id', model.instance_id);
  const log = model.deployment;
  if (log === 'absent') {
    line('deployment log', 'absent');
  } else if (log && typeof log === 'object') {
    const up = log.newest_compose_up ?? {};
    line('deployment actions', log.actions);
    line('actions sha256', log.actions_hash);
    line('launcher quote sha256', log.quote_sha256);
    line('newest compose_up tag', up.tag);
    line('  commit', up.commit);
    line('  file', up.file);
    line('  file sha256', up.file_sha256);
  } else {
    line('deployment log', undefined);
  }
});

const gateway = record.gateway;
heading("Gateway, from Intel's public token");
line('scope', gateway?.scope);
line('TCB status', gateway?.tcb_status);
line('TCB date', gateway?.tcb_date);
line('advisory ids', ids(gateway?.advisory_ids));
line('signing address', gateway?.signing_address);
line('Intel key id', gateway?.intel_kid);
line('issued at (unix)', gateway?.issued_at);
line('expires at (unix)', gateway?.expires_at);
line('Intel GPU count', gateway?.intel_gpu_count);

const signature = record.signature;
heading('Signature over the answer');
line('kind', signature?.kind);
line('algorithm', signature?.algo);
line('signing address', signature?.signing_address);
line('signed text', signature?.text);
line('signature', signature?.signature);
line('request sha256', signature?.request_sha256);
line('response sha256', signature?.response_sha256);

heading('Check it yourself');
line('verify link', record.verify_link);
console.log('\nThis prints what the run recorded. It does not repeat the checks. The record never holds');
console.log("the answer text, only hashes. The link shows NEAR AI's own check, which compares no build");
console.log('with an approved list. The software record names the launcher, system image and deployment');
console.log("file the model's quote commits to; Kaap does not judge whether that software is safe.");
JS
