// The sealed run behind a verdict, and OutLayer's attestation of it. No OutLayer call says which run
// produced a verdict, so the run is found on chain: the worker's `request_execution` transactions
// to the OutLayer contract in the blocks around the block the verdict was read at, whose input names
// the verdict's DAO and proposal, and whose final output carries exactly the verdict's bytes and
// signature. Everything the attestation claims is then compared with the chain: the caller is the
// transaction's signer, the project and build are what the OutLayer contract logged when it took
// the request, and the input and output hashes are recomputed from the transaction.
//
// Covered: which program ran, for whom, on what input, with what output, as OutLayer's contract and
// API record it. Not covered: the Intel TDX quote inside the attestation (its signature chain needs
// Intel's collateral and DCAP, which this CLI does not carry), and whether the build's source is
// honest (rebuild it: packages/sealed/README.md).

import { z } from 'zod';

import { MAX_ATTESTATION_BYTES, RPC_TIMEOUT_MS, RUN_SCAN_AHEAD, RUN_SCAN_BACK } from './caps.js';
import type { Deployment } from './deployment.js';
import type { RateLimiter } from './limiter.js';
import { NetError, type Transport } from './net.js';
import { type Network, NETWORKS, type Provider, RpcError } from './rpc.js';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The sealed program's output (packages/sealed/README.md, "What it signs"). */
const outputSchema = z.looseObject({
  v: z.literal(1),
  status: z.literal('ok'),
  verdict: z.string().max(2048),
  signature: z.string().max(256),
  public_key: z.string().max(128),
  explanation: z.string().max(2048),
});
export type SealedOutput = z.output<typeof outputSchema>;

const inputSchema = z.looseObject({ network: z.string(), dao: z.string(), proposal_id: z.number().int().nonnegative() });

const txSchema = z.looseObject({
  hash: z.string(),
  signer_id: z.string(),
  receiver_id: z.string(),
  actions: z.array(z.unknown()),
});

const requestSchema = z.looseObject({
  sender_id: z.string(),
  project_id: z.string().nullable().optional(),
  project_uuid: z.string().nullable().optional(),
  input_data: z.string().nullable().optional(),
  code_source: z.record(z.string(), z.looseObject({ hash: z.string().optional() })),
});

const attestationSchema = z.looseObject({
  transaction_hash: z.string(),
  caller_account_id: z.string(),
  project_id: z.string().nullable(),
  wasm_hash: z.string().nullable(),
  executed_wasm_sha256: z.string().nullable(),
  input_hash: z.string().nullable(),
  output_hash: z.string(),
});
export type Attestation = z.output<typeof attestationSchema>;

/** What the OutLayer contract logged when it took the request. */
export interface Requested {
  sender: string;
  project: string | null;
  uuid: string | null;
  build: string | null;
  inputData: string | null;
}

export interface Run {
  tx: string;
  signer: string;
  receiver: string;
  /** `input_data` exactly as the transaction carried it. */
  inputData: string;
  /** The transaction's final return value, the program's output, byte for byte. */
  output: Buffer | null;
  sealed: SealedOutput | null;
  /** Null when no receipt of the OutLayer contract logged `execution_requested`. */
  requested: Requested | null;
}

/** The `input_data` of a `request_execution` call in `actions`, or null for any other call. */
function requestInput(actions: unknown[]): string | null {
  if (actions.length !== 1) return null;
  const call = isRecord(actions[0]) ? actions[0]['FunctionCall'] : undefined;
  if (!isRecord(call) || call['method_name'] !== 'request_execution' || typeof call['args'] !== 'string') return null;
  try {
    const args: unknown = JSON.parse(Buffer.from(call['args'], 'base64').toString('utf8'));
    return isRecord(args) && typeof args['input_data'] === 'string' ? args['input_data'] : null;
  } catch {
    return null;
  }
}

function names(inputData: string, network: Network, dao: string, proposalId: number): boolean {
  try {
    const input = inputSchema.safeParse(JSON.parse(inputData));
    return input.success && input.data.network === network && input.data.dao === dao && input.data.proposal_id === proposalId;
  } catch {
    return false;
  }
}

/** The `execution_requested` event, read only from a receipt the OutLayer contract itself ran, so
 *  no other contract's log can stand in for it. */
function requestedBy(outcome: Record<string, unknown>, outlayer: string): Requested | null {
  const receipts = outcome['receipts_outcome'];
  if (!Array.isArray(receipts)) return null;
  for (const r of receipts) {
    const o = isRecord(r) ? r['outcome'] : undefined;
    if (!isRecord(o) || o['executor_id'] !== outlayer || !Array.isArray(o['logs'])) continue;
    for (const line of o['logs']) {
      if (typeof line !== 'string' || !line.startsWith('EVENT_JSON:')) continue;
      try {
        const event: unknown = JSON.parse(line.slice('EVENT_JSON:'.length));
        if (!isRecord(event) || event['standard'] !== 'near-outlayer' || event['event'] !== 'execution_requested' || !Array.isArray(event['data'])) continue;
        const data: unknown = event['data'][0];
        const raw = isRecord(data) ? data['request_data'] : undefined;
        const request = requestSchema.safeParse(typeof raw === 'string' ? JSON.parse(raw) : undefined);
        if (!request.success) continue;
        const sources = Object.values(request.data.code_source);
        return {
          sender: request.data.sender_id,
          project: request.data.project_id ?? null,
          uuid: request.data.project_uuid ?? null,
          build: sources.length === 1 ? (sources[0]?.hash ?? null) : null,
          inputData: request.data.input_data ?? null,
        };
      } catch {
        continue;
      }
    }
  }
  return null;
}

/** The run `tx` as the archival node knows it, or null when it does not. */
export async function readRun(archival: Provider, tx: string, sender: string, outlayer: string): Promise<Run | null> {
  const outcome = await archival.txStatus(tx, sender);
  if (outcome === null) return null;
  const parsed = txSchema.safeParse(outcome['transaction']);
  if (!parsed.success) throw new RpcError(archival.name, 'shape', `transaction ${tx.slice(0, 12)} is not readable`);
  const inputData = requestInput(parsed.data.actions);
  if (inputData === null) throw new RpcError(archival.name, 'shape', `transaction ${tx.slice(0, 12)} is not a request_execution call`);
  const status = outcome['status'];
  const value = isRecord(status) && typeof status['SuccessValue'] === 'string' ? status['SuccessValue'] : null;
  const output = value === null ? null : Buffer.from(value, 'base64');
  let sealed: SealedOutput | null = null;
  if (output !== null) {
    try {
      const read = outputSchema.safeParse(JSON.parse(output.toString('utf8')));
      sealed = read.success ? read.data : null;
    } catch {
      sealed = null;
    }
  }
  return { tx: parsed.data.hash, signer: parsed.data.signer_id, receiver: parsed.data.receiver_id, inputData, output, sealed, requested: requestedBy(outcome, outlayer) };
}

export interface Search {
  run: Run | null;
  /** Heights read, and runs for this proposal whose output was another verdict. */
  blocksRead: number;
  otherRuns: number;
  from: number;
  to: number;
}

/** Looks for the worker's run that returned exactly `verdict` and `signature` (base64 as the
 *  registry gives them, compared as bytes), from a few blocks after `readAt` back to
 *  `RUN_SCAN_BACK` blocks before it, nearest first. */
export async function findRun(archival: Provider, d: Deployment, want: { network: Network; dao: string; proposalId: number; verdict: Buffer; signature: Buffer }, readAt: number): Promise<Search> {
  const search: Search = { run: null, blocksRead: 0, otherRuns: 0, from: readAt + RUN_SCAN_AHEAD, to: Math.max(0, readAt - RUN_SCAN_BACK) };
  for (let height = search.from; height >= search.to; height--) {
    const block = await archival.blockChunks(height);
    search.blocksRead++;
    if (block === null) continue;
    for (const chunk of block.chunks) {
      for (const raw of await archival.chunkTransactions(chunk.hash)) {
        const tx = txSchema.safeParse(raw);
        if (!tx.success || tx.data.signer_id !== d.worker || tx.data.receiver_id !== d.outlayer) continue;
        const inputData = requestInput(tx.data.actions);
        if (inputData === null || !names(inputData, want.network, want.dao, want.proposalId)) continue;
        const run = await readRun(archival, tx.data.hash, d.worker, d.outlayer);
        if (run?.sealed && Buffer.from(run.sealed.verdict, 'base64').equals(want.verdict) && Buffer.from(run.sealed.signature, 'base64').equals(want.signature)) {
          search.run = run;
          return search;
        }
        search.otherRuns++;
      }
    }
  }
  return search;
}

export type AttestationRead = { found: true; attestation: Attestation; url: string } | { found: false; why: string; url: string };

/** OutLayer's attestation of the run `tx`. Answered from OutLayer's own API: the CLI checks each
 *  field it uses against the chain, so the API is a source of claims, never of a verdict. */
export async function readAttestation(network: Network, tx: string, transport: Transport, limiter: RateLimiter): Promise<AttestationRead> {
  const url = `${NETWORKS[network].outlayer}/attestations/by-tx/${tx}`;
  await limiter.slot();
  let response;
  try {
    response = await transport({ url, method: 'GET', timeoutMs: RPC_TIMEOUT_MS, maxBytes: MAX_ATTESTATION_BYTES });
  } catch (e) {
    return { found: false, why: e instanceof NetError ? e.message : 'OutLayer could not be reached', url };
  }
  if (response.status !== 200) return { found: false, why: `OutLayer answered HTTP ${response.status}`, url };
  try {
    const parsed = attestationSchema.safeParse(JSON.parse(response.text));
    if (parsed.success) return { found: true, attestation: parsed.data, url };
  } catch {
    // fall through to the same refusal as a wrong shape
  }
  return { found: false, why: 'OutLayer\'s answer is not an attestation', url };
}
