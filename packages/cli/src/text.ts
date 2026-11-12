// Turns text an attacker can write (a description, an account name, a node's answer, a worker's
// explanation) into something a terminal shows as plain characters (C24). One rule covers every
// command: a string from the chain, an RPC node, OutLayer's API or a worker is printed only through
// `shown`, or after a check that it has a fixed shape (an account id, a hash, a number, a fixed
// word). `shown` leaves no character a terminal acts on: every control (C0, DEL, C1) and every
// format character, which takes in the bidirectional marks and isolates and the zero-width spaces
// and joiners, is written out as a visible escape, and so are the Unicode line and paragraph
// separators. A line break becomes `\n`, so a value never starts a line of its own; prose that
// should keep its lines goes through `shownLines` and is indented under its heading by the caller.
// Long text is cut and says so. `check`, `verify`, `arming` and `seal-text` also pass every
// finished line through `shown` once more (`terminalText`), so a value that reached a line without
// its own check is still inert. `check --json` prints through `terminalJson`, which writes the same
// characters as JSON escapes, so the output is as inert and still parses to the same values.
//
// Not covered: letters that look like others or draw nothing (homoglyphs, combining marks, the
// Hangul fillers) are shown as they are, since they can mislead the eye but cannot move the cursor,
// reorder a line or start one; and a backslash is shown as it is, so an escape the text spells out
// itself looks like one made here.

import { MAX_SHOWN_TEXT } from './caps.js';

// Controls, format characters, unpaired surrogates, and the line and paragraph separators.
const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;
const NAMED: Readonly<Record<string, string>> = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };

function cut(text: string, max: number): string {
  const points = [...text];
  return points.length > max ? `${points.slice(0, max).join('')} [${points.length - max} more characters not shown]` : text;
}

const escaped = (text: string) => text.replace(UNSAFE, (c) => NAMED[c] ?? `\\u{${c.codePointAt(0)?.toString(16) ?? ''}}`);

/** Attacker text as one line with nothing a terminal acts on, at most `max` characters of it. */
export function shown(text: string, max = MAX_SHOWN_TEXT): string {
  return escaped(cut(text, max));
}

/** `shown` under the name most callers use for it. */
export const oneLine = shown;

/** Attacker prose as its own lines (split at each line break), each as `shown` leaves it, for the
 *  caller to indent under a heading of its own so no line of it starts a line of output. */
export function shownLines(text: string, max = MAX_SHOWN_TEXT): string[] {
  return cut(text, max).split(/\r?\n/).map(escaped);
}

/** A command's finished lines as the text it prints, each line through `shown` once more. */
export function terminalText(lines: readonly string[]): string {
  return lines.map((line) => shown(line, Number.POSITIVE_INFINITY)).join('\n');
}

const jsonEscape = (c: string) => Array.from({ length: c.length }, (_, i) => `\\u${c.charCodeAt(i).toString(16).padStart(4, '0')}`).join('');

/** `value` as the indented JSON a command prints, with nothing a terminal acts on: every character
 *  `shown` escapes is written as its JSON `\u` escape, two of them above U+FFFF, so the text still
 *  parses to `value`. JSON.stringify already escapes U+0000 to U+001F inside a string, so those in
 *  its output are its own line breaks between values, and stay. Nothing is cut. */
export function terminalJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(UNSAFE, (c) => ((c.codePointAt(0) ?? 0) < 0x20 ? c : jsonEscape(c)));
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
