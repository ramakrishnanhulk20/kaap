// What the command line reads from Kaap's guard beyond a DAO's enrolment: the mode the DAO chose
// (C8: in strict mode the guard also rejects a request whose signed hash Kaap has not read), and a
// change of the guard's accepted key that its owner has announced and that has not taken effect yet
// (C19: a change waits 24 hours). Both views came with a later build of the guard. A guard built
// before them answers that it has no such method, and that is a plain answer here, "this guard has
// neither", once both providers give it (C22).
//
// Not covered: whether the owner will cancel or apply an announced key, and a guard that lies in
// these views; `kaap arming` and `kaap verify` first check that the guard runs the recorded build.

import { z } from 'zod';

import { Held, type Reader } from './chain.js';
import { isEdKey } from './deployment.js';
import { type Block, RpcError } from './rpc.js';
import { oneLine } from './text.js';

/** `none`: this build of the guard has no strict mode at all. */
export type GuardMode = 'strict' | 'default' | 'none';

/** The mode `dao` chose in `guard`, as both providers agree at `head`. The guard answers false for
 *  an account that is not enrolled, so ask only for an enrolled DAO. */
export async function guardMode(reader: Reader, guard: string, dao: string, head: Block): Promise<GuardMode> {
  const got = await reader.optionalJson(`the mode ${dao} chose in ${guard}`, guard, 'veto_unreadable', { dao }, head);
  if ('absent' in got) return 'none';
  if (typeof got.value !== 'boolean') throw new Held(`${guard}'s veto_unreadable answer is not true or false`);
  return got.value ? 'strict' : 'default';
}

const MODE_WORDS: Readonly<Record<GuardMode, string>> = {
  strict: 'strict: the guard also rejects a request of this DAO whose signed hash Kaap has not read',
  default: 'default: a request whose signed hash Kaap has not read alerts the members and is not rejected',
  none: 'this guard has no strict mode: a request whose signed hash Kaap has not read alerts the members and is not rejected',
};

/** The mode in plain words. Anything but the three known modes prints as itself, escaped. */
export function modeWords(mode: string): string {
  return (MODE_WORDS as Readonly<Record<string, string>>)[mode] ?? oneLine(mode, 40);
}

export interface PendingKey {
  key: string;
  effectiveAtMs: number;
}

const pendingSchema = z.strictObject({ key: z.string().refine(isEdKey), effective_at_ms: z.number().int().nonnegative() });

/** The key change `guard`'s owner has announced, or null when there is none or this build of the
 *  guard cannot announce one. An answer in any other shape holds: a change that cannot be read is
 *  not reported as no change. */
export async function pendingKey(reader: Reader, guard: string, head: Block): Promise<PendingKey | null> {
  const got = await reader.optionalJson(`the key change announced in ${guard}`, guard, 'pending_key', {}, head);
  if ('absent' in got || got.value === null) return null;
  const parsed = pendingSchema.safeParse(got.value);
  if (!parsed.success) throw new Held(`${guard}'s pending_key answer is not a key and a time`);
  return { key: parsed.data.key, effectiveAtMs: parsed.data.effective_at_ms };
}

/** One warning line for an announced key change, with the time measured against the block that
 *  was read, not this machine's clock. */
export function pendingKeyWarning(p: PendingKey, head: Block): string {
  const nowMs = Number(BigInt(head.timestampNs) / 1_000_000n);
  const at = new Date(p.effectiveAtMs);
  const when = Number.isNaN(at.getTime()) ? `${p.effectiveAtMs} ms after 1970` : `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  const left = p.effectiveAtMs - nowMs;
  const hours = Math.ceil(left / 3_600_000);
  const timing = left > 0 ? `It can take effect from ${when}, in about ${hours} ${hours === 1 ? 'hour' : 'hours'}` : `Its wait ended at ${when}, so anyone can make it take effect at any moment`;
  return `warning: the guard's owner has announced a new accepted key, ${p.key}. ${timing}. Until it does, every verdict is still checked against the current key.`;
}

/** The lines `kaap arming` and `kaap verify` print about a key change: none when no change is
 *  announced or the guard cannot announce one, the warning when one is, and one line saying so
 *  when the view could not be read or compared, so a failed read is never silence. */
export async function pendingKeyLines(reader: Reader, guard: string, head: Block): Promise<string[]> {
  try {
    const pending = await pendingKey(reader, guard, head);
    return pending === null ? [] : [pendingKeyWarning(pending, head)];
  } catch (e) {
    if (!(e instanceof Held) && !(e instanceof RpcError)) throw e;
    return [`warning: whether a change of the guard's accepted key has been announced could not be read (${oneLine(e.message, 200)})`];
  }
}
