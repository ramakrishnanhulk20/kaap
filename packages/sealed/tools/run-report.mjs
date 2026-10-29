// Reads one request_execution transaction back from testnet RPC at final finality and writes a
// summary: the job's output as the transaction returned it, OutLayer's execution_completed event,
// the blocks and time from the request to the result, and what the caller paid.
//
// Usage: node run-report.mjs <tx hash> <sender account> <summary.json> <output.json> [rpc url]
import { writeFileSync } from 'node:fs';

const [tx, sender, summaryFile, outputFile, rpcUrl = 'https://rpc.testnet.fastnear.com'] = process.argv.slice(2);
if (!tx || !sender || !summaryFile || !outputFile) {
  console.error('usage: node run-report.mjs <tx> <sender> <summary.json> <output.json> [rpc]');
  process.exit(2);
}

async function rpc(method, params) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'kaap', method, params }),
        signal: AbortSignal.timeout(30000),
      });
      const body = await res.json();
      if (body.error) throw new Error(JSON.stringify(body.error).slice(0, 300));
      return body.result;
    } catch (e) {
      if (attempt >= 5) throw e;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

const status = await rpc('EXPERIMENTAL_tx_status', { tx_hash: tx, sender_account_id: sender, wait_until: 'FINAL' });
const outcomes = [status.transaction_outcome, ...status.receipts_outcome];
const heights = new Map();
async function block(hash) {
  if (!heights.has(hash)) {
    const b = await rpc('block', { block_id: hash });
    heights.set(hash, { height: b.header.height, ms: Number(BigInt(b.header.timestamp_nanosec) / 1000000n) });
  }
  return heights.get(hash);
}
const requestBlock = await block(status.transaction_outcome.block_hash);
let resultBlock = requestBlock;
for (const o of status.receipts_outcome) {
  const b = await block(o.block_hash);
  if (b.height > resultBlock.height) resultBlock = b;
}

const logs = status.receipts_outcome.flatMap((o) => o.outcome.logs);
const events = logs.filter((l) => l.startsWith('EVENT_JSON:')).map((l) => {
  try {
    return JSON.parse(l.slice('EVENT_JSON:'.length));
  } catch {
    return null;
  }
});
const completed = events.find((e) => e?.event === 'execution_completed')?.data?.[0] ?? null;
const burnt = outcomes.reduce((sum, o) => sum + BigInt(o.outcome.tokens_burnt), 0n);
const charged = completed?.payment_charged ? BigInt(completed.payment_charged) : 0n;
const value = status.status?.SuccessValue;
const output = value ? Buffer.from(value, 'base64').toString('utf8') : '';
writeFileSync(outputFile, output);

const yocto = (n) => Number(n) / 1e24;
const summary = {
  tx,
  explorer: `https://testnet.nearblocks.io/txns/${tx}`,
  sender,
  success: value !== undefined,
  failure: status.status?.Failure ?? null,
  output_bytes: Buffer.byteLength(output),
  request_block: requestBlock.height,
  result_block: resultBlock.height,
  blocks: resultBlock.height - requestBlock.height,
  on_chain_ms: resultBlock.ms - requestBlock.ms,
  worker_time_ms: completed?.resources_used?.time_ms ?? null,
  worker_instructions: completed?.resources_used?.instructions ?? null,
  compile_time_ms: completed?.resources_used?.compile_time_ms ?? null,
  compilation_note: completed?.compilation_note ?? null,
  outlayer_charge_near: yocto(charged),
  gas_burnt_near: yocto(burnt),
  total_near: yocto(charged + burnt),
  execution_completed: completed,
};
writeFileSync(summaryFile, JSON.stringify(summary, null, 1) + '\n');
console.log(JSON.stringify({ tx, success: summary.success, blocks: summary.blocks, on_chain_ms: summary.on_chain_ms, worker_time_ms: summary.worker_time_ms, total_near: summary.total_near }));
