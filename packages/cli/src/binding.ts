// What OutLayer's TDX quote commits to. Before the chip signs, OutLayer's worker writes the SHA-256
// of the run's record into the first 32 bytes of the quote's REPORTDATA and zeros into the rest.
// This rebuilds that hash from the record OutLayer's API serves. It is a port, field for field, of
// out-layer/outlayer-verify crates/verify-core/src/preimage.rs `task_hash` and the record.rs
// `V1_CUTOFF` at commit 90c27d9. That code rules over OutLayer's docs page, whose formula is an
// older, shorter one that no current quote matches.
//
// A match says the record agrees with the quote it was served with. It does not say Intel signed
// that quote: the quote's signature chain needs Intel's collateral, which is not checked here.

import { createHash } from 'node:crypto';

/** Records stamped from this instant on (2026-01-30T14:55:39Z) commit to the V1 field set. The
 *  format is picked by the stamp and never by trying both shapes: the Legacy preimage leaves out
 *  caller, project, secrets, time and payment, so a fallback would let a modern record carry any
 *  values for those five and still match. */
const V1_CUTOFF = 1_769_784_939;

/** A TDX quote v4 is a 48-byte header, then the 584-byte TD report whose last 64 bytes are
 *  REPORTDATA. */
const REPORT_DATA_AT = 568;
const REPORT_DATA_HALF = 600;
const REPORT_DATA_END = 632;
const TDX_VERSION = 4;
const TDX_TEE_TYPE = 0x81;

/** What OutLayer stores in place of a quote when a worker runs without a TEE (tee_mode=none). */
const DEV_MODE = 'no-attestation-dev-mode';

export class BindingRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BindingRefused';
  }
}

/** The fields of OutLayer's record the hash covers, named as the API serves them. A text field
 *  that is null or missing adds no bytes. */
export interface BindingRecord {
  task_type: string;
  task_id: number;
  repo_url?: string | null | undefined;
  commit_hash?: string | null | undefined;
  build_target?: string | null | undefined;
  wasm_hash?: string | null | undefined;
  input_hash?: string | null | undefined;
  output_hash: string;
  block_height?: number | null | undefined;
  caller_account_id?: string | null | undefined;
  project_id?: string | null | undefined;
  secrets_ref?: string | null | undefined;
  /** Unix seconds. */
  timestamp: number;
  attached_usd?: string | null | undefined;
}

/** Hex values are hashed as their text, never decoded. */
const text = (value: string | null | undefined) => Buffer.from(value ?? '', 'utf8');

function int64(value: number, name: string): Buffer {
  if (!Number.isSafeInteger(value)) throw new BindingRefused(`the record's ${name} is not a whole number`);
  const out = Buffer.alloc(8);
  out.writeBigInt64LE(BigInt(value));
  return out;
}

function uint64(value: number, name: string): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) throw new BindingRefused(`the record's ${name} is not a whole number at or above zero`);
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(value));
  return out;
}

/** The 32 bytes the quote's REPORTDATA should start with: SHA-256 over the fields joined with no
 *  separator and no length prefix, `task_id` and `timestamp` as i64 little-endian and
 *  `block_height` as u64 little-endian. A record stamped at or after the cutoff hashes as V1 and
 *  only as V1. Throws `BindingRefused` when a number cannot be written as its integer type. */
export function taskHash(att: BindingRecord): Buffer {
  const stamp = int64(att.timestamp, 'timestamp');
  const parts = [
    text(att.task_type),
    int64(att.task_id, 'task_id'),
    text(att.repo_url),
    text(att.commit_hash),
    text(att.build_target),
    text(att.wasm_hash),
    text(att.input_hash),
    text(att.output_hash),
  ];
  if (att.block_height !== null && att.block_height !== undefined) parts.push(uint64(att.block_height, 'block_height'));
  if (att.timestamp >= V1_CUTOFF) parts.push(text(att.caller_account_id), text(att.project_id), text(att.secrets_ref), stamp, text(att.attached_usd));
  return createHash('sha256').update(Buffer.concat(parts)).digest();
}

/** REPORTDATA of a base64 TDX quote v4: `first` is the task hash half, `rest` the half that must be
 *  zero. Throws `BindingRefused` for the development placeholder, for text that is not canonical
 *  base64, for a quote under 632 bytes, and for any header other than version 4 with TEE type
 *  0x81 (TDX). */
export function quoteReportData(quoteB64: string): { first: Buffer; rest: Buffer } {
  const devMode = new BindingRefused(`the record carries no quote: OutLayer ran it in development mode (tee_mode=none), which stores the placeholder "${DEV_MODE}" instead of a TDX quote`);
  if (quoteB64 === DEV_MODE) throw devMode;
  const quote = Buffer.from(quoteB64, 'base64');
  // Node's decoder skips characters it does not know, so the text must be exactly what the bytes
  // encode back to.
  if (quote.toString('base64') !== quoteB64) throw new BindingRefused('the quote is not canonical base64');
  if (quote.equals(Buffer.from(DEV_MODE, 'utf8'))) throw devMode;
  if (quote.length < REPORT_DATA_END) throw new BindingRefused(`the quote is ${quote.length} bytes, too short to be a TDX quote (at least ${REPORT_DATA_END})`);
  const version = quote.readUInt16LE(0);
  const teeType = quote.readUInt32LE(4);
  if (version !== TDX_VERSION || teeType !== TDX_TEE_TYPE) {
    throw new BindingRefused(`the quote is not a TDX quote v4: version ${version}, TEE type 0x${teeType.toString(16)}, where TDX is version ${TDX_VERSION}, TEE type 0x${TDX_TEE_TYPE.toString(16)}`);
  }
  return { first: Buffer.from(quote.subarray(REPORT_DATA_AT, REPORT_DATA_HALF)), rest: Buffer.from(quote.subarray(REPORT_DATA_HALF, REPORT_DATA_END)) };
}
