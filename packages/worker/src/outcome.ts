// Reading a final transaction outcome as the RPC returns it. Every value here was written by a
// contract or an RPC provider, so each reader checks shapes and returns fixed fallbacks rather
// than throwing on something odd.

export interface TxOutcome {
  final_execution_status?: string;
  status?: { SuccessValue?: string; Failure?: unknown } | string;
  transaction?: { hash?: string; signer_id?: string; receiver_id?: string };
  transaction_outcome?: { block_hash?: string; outcome?: OutcomePart };
  receipts_outcome?: Array<{ id?: string; block_hash?: string; outcome?: OutcomePart }>;
}

interface OutcomePart {
  executor_id?: string;
  logs?: unknown[];
  tokens_burnt?: string;
  gas_burnt?: number;
  status?: unknown;
}

export interface NearEvent {
  by: string;
  standard: string;
  event: string;
  data: unknown[];
}

export function isFinal(o: unknown): o is TxOutcome {
  return !!o && typeof o === 'object' && (o as TxOutcome).final_execution_status === 'FINAL' && (o as TxOutcome).status !== undefined;
}

/** The base64 the transaction returned, or undefined when it failed or returned nothing. */
export function successValue(o: TxOutcome): string | undefined {
  const s = o.status;
  return s && typeof s === 'object' && typeof s.SuccessValue === 'string' ? s.SuccessValue : undefined;
}

export function failed(o: TxOutcome): boolean {
  const s = o.status;
  return !!s && typeof s === 'object' && s.Failure !== undefined;
}

/** The contract's own refusal code, such as ERR_REPLAY, or a fixed word for any other failure. */
export function refusal(o: TxOutcome): string | null {
  if (!failed(o)) return null;
  const text = JSON.stringify((o.status as { Failure: unknown }).Failure ?? null);
  return text.match(/ERR_[A-Z0-9_]+/)?.[0] ?? (text.includes('NotEnoughBalance') ? 'NOT_ENOUGH_BALANCE' : text.includes('Exceeded') ? 'GAS_EXCEEDED' : 'FAILED');
}

/** Every NEP-297 event the transaction's receipts logged, with the account that logged it. */
export function events(o: TxOutcome): NearEvent[] {
  const out: NearEvent[] = [];
  for (const r of o.receipts_outcome ?? []) {
    for (const line of r.outcome?.logs ?? []) {
      if (typeof line !== 'string' || !line.startsWith('EVENT_JSON:')) continue;
      try {
        const e = JSON.parse(line.slice('EVENT_JSON:'.length)) as { standard?: unknown; event?: unknown; data?: unknown };
        if (typeof e.standard === 'string' && typeof e.event === 'string') {
          out.push({ by: String(r.outcome?.executor_id ?? ''), standard: e.standard, event: e.event, data: Array.isArray(e.data) ? e.data : [] });
        }
      } catch {
        // An unreadable event is ignored: nothing the worker decides rests on one alone.
      }
    }
  }
  return out;
}

/** Gas the sender paid for, in yoctoNEAR: every outcome's tokens_burnt. */
export function burnt(o: TxOutcome): bigint {
  const parts = [o.transaction_outcome, ...(o.receipts_outcome ?? [])];
  return parts.reduce((sum, p) => sum + (/^\d+$/.test(p?.outcome?.tokens_burnt ?? '') ? BigInt(p!.outcome!.tokens_burnt!) : 0n), 0n);
}

/** The block hash of the first receipt `executor` ran, such as the DAO's act_proposal. */
export function receiptBlock(o: TxOutcome, executor: string): string | undefined {
  return (o.receipts_outcome ?? []).find((r) => r.outcome?.executor_id === executor)?.block_hash;
}

export function logs(o: TxOutcome): string[] {
  return (o.receipts_outcome ?? []).flatMap((r) => (r.outcome?.logs ?? []).filter((l): l is string => typeof l === 'string'));
}
