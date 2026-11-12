// One planted record of the evaluation set as a proposal that can be filed on testnet: its
// `.sandbox` account names moved under an account we control.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The planted native NEAR Transfer `id` (for example `planted:17`) with every `<name>.sandbox`
 *  in its description and receiver moved to `<name>.<root>`. Returns the description, the kind,
 *  and every account the two name, the receiver first. */
export function plantedTransfer(repo, id, root) {
  const line = readFileSync(join(repo, 'eval', 'planted', 'planted.jsonl'), 'utf8').split('\n').find((l) => l.trim() && JSON.parse(l).id === id);
  if (!line) throw new Error(`${id} is not in eval/planted/planted.jsonl`);
  const record = JSON.parse(line);
  const transfer = record.kind?.Transfer;
  if (!transfer || transfer.token_id !== '') throw new Error(`${id} is not a native NEAR Transfer`);
  const move = (text) => text.replace(/\b([a-z0-9][a-z0-9_-]*)\.sandbox\b/g, `$1.${root}`);
  const kind = { Transfer: { ...transfer, receiver_id: move(transfer.receiver_id) } };
  const description = move(record.description);
  const named = [...description.matchAll(new RegExp(`[a-z0-9][a-z0-9_-]*\\.${root.replaceAll('.', '\\.')}`, 'g'))].map((m) => m[0]);
  return { description, kind, accounts: [...new Set([kind.Transfer.receiver_id, ...named])] };
}
