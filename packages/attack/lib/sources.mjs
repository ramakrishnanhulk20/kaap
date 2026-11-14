// Real material signed by keys the suite does not hold, taken from where any attacker can read it:
// the live registry's public records and the output of a sealed run on chain. Each verdict is
// checked before use: its signature verifies under the sealed program's key, and its bytes decode
// and encode back unchanged through kaap-core-wasm, so an attack never rests on a verdict this
// suite made up.
//
// Also the public evidence of one sealed run in which the AI answered, which holds the AI model's
// own signature over its answer.
//
// Everything here is a read. Nothing is sent to the live contracts.

import { JsonRpcProvider } from '../../../scripts/setup-demo-dao.mjs';
import { LIVE, viewFinal } from './chain.mjs';
import { VERDICT_DOMAIN, ed25519Valid, realForm } from './verdict.mjs';

/** A sealed run of 13 Nov 2026 by Kaap's watcher, with the AI's answer verified: the verdict that
 *  rejected request #10 on the demo treasury. */
export const AI_RUN = 'E8H9iJBkehBvenEKEZ9WfEViDXeGTNs9JNNqaH8RrvE4';

const OUTLAYER = 'outlayer.testnet';
const OUTLAYER_API = 'https://testnet-api.outlayer.ai';
// Archival, because a run only days old is gone from the plain RPC.
const archival = new JsonRpcProvider({ url: process.env.KAAP_TESTNET_ARCHIVAL_RPC || 'https://archival-rpc.testnet.fastnear.com' });

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** The 32 bytes of "ed25519:<base58>". */
export function keyBytes(key) {
  if (!key.startsWith('ed25519:')) throw new Error(`${key} is not an ed25519 key`);
  let n = 0n;
  for (const c of key.slice('ed25519:'.length)) {
    const d = ALPHABET.indexOf(c);
    if (d < 0) throw new Error(`${key} is not base58`);
    n = n * 58n + BigInt(d);
  }
  const out = Buffer.alloc(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  if (n !== 0n) throw new Error(`${key} is longer than 32 bytes`);
  return out;
}

/** A real signed verdict, refused unless the sealed program's key signed exactly these bytes. */
function genuine(verdictB64, signatureB64, origin) {
  const form = realForm(verdictB64);
  const ok = ed25519Valid(keyBytes(LIVE.acceptedKey), Buffer.concat([VERDICT_DOMAIN, form.bytes]), Buffer.from(signatureB64, 'base64'));
  if (!ok) throw new Error(`${origin} does not carry a valid signature by ${LIVE.acceptedKey}`);
  return { verdict: verdictB64, signature: signatureB64, hash: form.hash, fields: form.fields, origin };
}

/** The latest verdict the live registry holds for a request on the demo treasury. */
export async function liveRecord(proposalId) {
  const r = await viewFinal(LIVE.registry, 'latest', { network: 'testnet', dao: LIVE.dao, proposal_id: proposalId });
  if (!r) throw new Error(`${LIVE.registry} holds no verdict for ${LIVE.dao} #${proposalId}`);
  return genuine(r.verdict, r.signature, `${LIVE.registry}'s record for ${LIVE.dao} #${proposalId}`);
}

/** The output of one sealed run, refused unless it is a run of Kaap's sealed program by Kaap's
 *  watcher. */
export async function runOutput(txHash) {
  const status = await archival.viewTransactionStatusWithReceipts({ txHash, accountId: LIVE.worker, waitUntil: 'FINAL' });
  const tx = status.transaction;
  const fc = tx.actions?.[0]?.FunctionCall;
  const args = fc ? JSON.parse(Buffer.from(fc.args, 'base64').toString('utf8')) : null;
  if (tx.signer_id !== LIVE.worker || tx.receiver_id !== OUTLAYER || fc?.method_name !== 'request_execution' || args?.source?.Project?.project_id !== LIVE.project) {
    throw new Error(`${txHash} is not a run of ${LIVE.project} by ${LIVE.worker}`);
  }
  return JSON.parse(Buffer.from(status.status.SuccessValue, 'base64').toString('utf8'));
}

/** The signed verdict a sealed run printed. */
export async function runVerdict(txHash) {
  const out = await runOutput(txHash);
  if (out.status !== 'ok') throw new Error(`run ${txHash} printed no verdict (${out.status})`);
  return genuine(out.verdict, out.signature, `sealed run ${txHash}`);
}

/** The evidence record a sealed run published in OutLayer's public storage, under the hash of its
 *  signed verdict, and that verdict. */
export async function runEvidence(txHash) {
  const verdict = await runVerdict(txHash);
  const url = `${OUTLAYER_API}/public/storage/get?project=${LIVE.project}&key=ai-evidence:${verdict.hash}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`OutLayer storage answered HTTP ${res.status} for ${url}`);
  const stored = await res.json();
  if (stored.exists !== true || typeof stored.value !== 'string') throw new Error(`no evidence is stored at ${url}`);
  const evidence = JSON.parse(Buffer.from(stored.value, 'base64').toString('utf8'));
  if (evidence.verdict_hash !== verdict.hash) throw new Error(`the evidence at ${url} names another verdict`);
  return { verdict, evidence, url };
}
