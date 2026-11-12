// The first check of each command that vouches for Kaap (`kaap verify`, `kaap arming`, `kaap
// seal-text`): that the guard and the registry a deployment record names still run the build the
// record names, and that no one holds an access key to either, so no one can sign as them or deploy
// other code to them. Both reads are made at the command's final block on both providers, which must
// agree (C22). The code hash NEAR keeps is the sha256 of the contract's code in base58, so it is
// decoded to its 32 bytes and compared with the record's hex as bytes. A difference from the record
// fails; a read no provider would answer, or one the two answer differently, is unread, since then
// nothing says what the contract is. `kaap verify` counts the four lines among its checks (exit 5
// or 6); `arming` and `seal-text` stop on anything but four passes, before anything is sealed or
// sent, with the same exit codes.
//
// Not covered: whether the recorded build is honest (rebuild it from the commit the record names),
// and both providers lying the same way (C22's named non-goal).

import { Held, type Reader } from './chain.js';
import { codeOf } from './dao.js';
import type { Deployment } from './deployment.js';
import { type Block, RpcError } from './rpc.js';
import { shown, terminalText } from './text.js';
import { base58 } from './verdict.js';

/** A command that stopped on this machine before its answer, ending with exit code `code`. The
 *  router knows it by the name `kaap seal-text` gives it, `SealRefused`. */
export class Refused extends Error {
  readonly code: number;
  constructor(message: string, code = 1) {
    super(message);
    this.name = 'Refused';
    this.code = code;
  }
}

export type ContractStatus = 'pass' | 'fail' | 'unread';

export interface ContractLine {
  status: ContractStatus;
  text: string;
}

const short = (hex: string) => `${hex.slice(0, 8)}...${hex.slice(-4)}`;

type Read<T> = { value: T } | { absent: true } | { unread: string };

/** One read through both providers. An account the first provider says does not exist is asked
 *  of the second too, so a missing contract fails only when both say so. */
async function bothRead<T>(reader: Reader, account: string, head: Block, read: () => Promise<T>): Promise<Read<T>> {
  try {
    return { value: await read() };
  } catch (e) {
    if (e instanceof Held) return { unread: e.message };
    if (!(e instanceof RpcError)) throw e;
    if (e.failure !== 'missing_account') return { unread: e.message };
  }
  try {
    await reader.secondary.account(account, head.height);
    return { unread: `the two providers disagree on whether ${account} exists` };
  } catch (e) {
    if (!(e instanceof RpcError)) throw e;
    return e.failure === 'missing_account' ? { absent: true } : { unread: `the second provider (${reader.secondary.name}) could not be read for ${account}, so nothing can be compared` };
  }
}

async function codeLine(role: string, account: string, recorded: string | null, d: Deployment, reader: Reader, head: Block): Promise<ContractLine> {
  const label = `${role} code: `;
  const at = `(two providers, block ${head.height})`;
  if (recorded === null) return { status: 'fail', text: `${label}${shown(d.record, 120)} names no code_sha256 for ${account}, so its code cannot be checked` };
  const got = await bothRead(reader, account, head, () => reader.account(account, head));
  if ('unread' in got) return { status: 'unread', text: `${label}${account} could not be read at block ${head.height}: ${got.unread}` };
  if ('absent' in got) return { status: 'fail', text: `${label}there is no account ${account}, so it does not run the recorded build ${short(recorded)} ${at}` };
  const code = codeOf(got.value);
  const bytes = code === null ? null : base58(code);
  const hex = bytes?.length === 32 ? bytes.toString('hex') : null;
  if (hex === recorded) return { status: 'pass', text: `${label}${account} runs the recorded build, sha256 ${short(hex)} ${at}` };
  const runs = hex === null ? 'no code of its own' : `code with sha256 ${short(hex)}`;
  return { status: 'fail', text: `${label}${account} runs ${runs}, not the recorded build ${short(recorded)} ${at}` };
}

async function keysLine(role: string, account: string, reader: Reader, head: Block): Promise<ContractLine> {
  const label = `${role} keys: `;
  const at = `(two providers, block ${head.height})`;
  const got = await bothRead(reader, account, head, () => reader.accessKeys(account, head));
  if ('unread' in got) return { status: 'unread', text: `${label}${account} could not be read at block ${head.height}: ${got.unread}` };
  if ('absent' in got) return { status: 'fail', text: `${label}there is no account ${account} ${at}` };
  const keys = got.value;
  if (!keys.length) return { status: 'pass', text: `${label}${account} has no access key, so no one can sign for it ${at}` };
  const named = keys.slice(0, 3).map((k) => shown(k.publicKey, 60)).join(', ');
  const more = keys.length > 3 ? ` and ${keys.length - 3} more` : '';
  const one = keys.length === 1;
  return { status: 'fail', text: `${label}${account} has ${keys.length} access ${one ? 'key' : 'keys'} (${named}${more}), so whoever holds ${one ? 'it' : 'one'} can sign for it ${at}` };
}

/** The four lines, in order: the guard's code, the guard's keys, the registry's code, the
 *  registry's keys, each read at `head` through both providers. */
export async function contractsAsRecorded(reader: Reader, d: Deployment, head: Block): Promise<ContractLine[]> {
  return [
    await codeLine('guard', d.guard, d.guardCode, d, reader, head),
    await keysLine('guard', d.guard, reader, head),
    await codeLine('registry', d.registry, d.registryCode, d, reader, head),
    await keysLine('registry', d.registry, reader, head),
  ];
}

/** `fail` when any line failed, else `unread` when any could not be read, else `pass`. */
export function contractsOutcome(lines: readonly ContractLine[]): ContractStatus {
  if (lines.some((l) => l.status === 'fail')) return 'fail';
  return lines.some((l) => l.status === 'unread') ? 'unread' : 'pass';
}

/** The lines under their heading, as `arming` and `seal-text` print them. */
export function contractBlock(lines: readonly ContractLine[]): string[] {
  return ['contracts', ...lines.map((l) => `  ${l.status}  ${l.text}`)];
}

/** Returns when all four lines pass; otherwise stops the command with the four lines and `closing`,
 *  exit 5 when one failed and 6 when none failed but one could not be read, as `kaap verify` ends. */
export function stopUnlessAsRecorded(d: Deployment, lines: readonly ContractLine[], closing: string): void {
  const outcome = contractsOutcome(lines);
  if (outcome === 'pass') return;
  const record = shown(d.record, 120);
  const opening = outcome === 'fail' ? `Kaap's guard and registry are not as ${record} records them:` : `Kaap's guard and registry could not both be checked against ${record}:`;
  throw new Refused(terminalText([opening, ...contractBlock(lines), closing]), outcome === 'fail' ? 5 : 6);
}
