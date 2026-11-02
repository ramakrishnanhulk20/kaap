// Turns text an attacker can write (a description, an account name, a token id) into something a
// terminal shows as plain characters (C24). Control characters could move the cursor, recolour or
// clear the screen, and bidirectional marks could make a line read in another order, so each is
// written out as a visible \u{...} escape. Long text is cut and says so.

import { MAX_SHOWN_TEXT } from './caps.js';

// C0 and C1 controls, DEL, and the bidirectional marks and isolates.
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/gu;

export function shown(text: string, max = MAX_SHOWN_TEXT): string {
  const cut = [...text];
  const head = cut.length > max ? `${cut.slice(0, max).join('')} [${cut.length - max} more characters not shown]` : text;
  return head.replace(UNSAFE, (c) => `\\u{${c.codePointAt(0)?.toString(16) ?? ''}}`);
}

/** One line: newlines and tabs become visible too. */
export function oneLine(text: string, max = MAX_SHOWN_TEXT): string {
  return shown(text, max).replace(/\r?\n/g, '\\n').replace(/\t/g, '\\t');
}

export function percent(part: number, whole: number): string {
  return whole === 0 ? 'n/a' : `${Math.round((100 * part) / whole)}%`;
}

export function count(n: number | bigint): string {
  return n.toLocaleString('en-US');
}

/** Whole base units as a decimal amount, exactly, with no float in between. */
export function units(raw: string, decimals: number): string {
  if (!/^\d+$/.test(raw)) return raw;
  const padded = raw.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = decimals === 0 ? '' : padded.slice(padded.length - decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/** A time in nanoseconds since 1970 as a UTC timestamp to the minute. */
export function utc(timestampNs: string): string {
  const ms = Number(BigInt(timestampNs) / 1_000_000n);
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
