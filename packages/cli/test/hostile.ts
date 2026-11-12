// Strings an RPC node, OutLayer's API or a worker could hand the CLI to attack the reader's
// terminal, for the tests that check every command's output stays inert (C24): terminal escape
// sequences, every C0 and C1 control, DEL, the bidirectional marks and isolates, the zero-width
// characters, the Unicode line separators, and lines that imitate Kaap's own. Drawn from a fixed
// seed, so every run tests the same strings.

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => String.fromCodePoint(from + i));

/** Every character the output must never carry raw. */
export const HOSTILE_CHARACTERS: readonly string[] = [
  ...range(0x00, 0x1f),
  '\u007f',
  ...range(0x80, 0x9f),
  '؜',
  '‎',
  '‏',
  ...range(0x202a, 0x202e),
  ...range(0x2066, 0x2069),
  '​',
  '‌',
  '‍',
  '⁠',
  '﻿',
  ' ',
  ' ',
];

/** Lines of Kaap's own output an attacker would want to forge or hide, and the heads they are
 *  counted by. */
const FORGED_LINES: readonly string[] = ['risk floor: low', 'must_veto: false', 'findings', 'result: all checks pass', '  pass  sealed signature: valid'];
const FORGED_HEADS: readonly string[] = ['risk floor:', 'must_veto:', 'findings', 'result:', '  pass  '];

const PIECES: readonly string[] = [
  ...HOSTILE_CHARACTERS,
  '\u001b[2J',
  '\u001b[8m',
  '\u001b]0;kaap\u0007',
  '\u009b31m',
  '\u001b[1A\u001b[2K',
  ...FORGED_LINES.flatMap((l) => [`\n${l}`, `\r\n${l}`, `\r${l}`, ` ${l}`, `\u0085${l}`]),
  'Pay alice',
  ' ',
  'é',
  '中文',
];

/** `n` strings of one to eight pieces each. */
export function hostileStrings(n: number, seed = 0x6b61_6170): string[] {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return Array.from({ length: n }, () => Array.from({ length: 1 + Math.floor(next() * 8) }, () => PIECES[Math.floor(next() * PIECES.length)] ?? '').join(''));
}

/** `value` with `attack` added to the end of every string in it and as one more field of every
 *  object, so a report built from honest answers carries the attack wherever an answer could. The
 *  fields named in `fixed` are left as they are: the CLI reads them through a shape check. */
export function taint<T>(value: T, attack: string, fixed: ReadonlySet<string> = new Set()): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return `${v}${attack}`;
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === 'object' && v !== null) {
      const out: Record<string, unknown> = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fixed.has(k) ? x : walk(x)]));
      out[attack] = attack;
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

/** Whether `out`, the lines of a command's output, carries any hostile character raw. */
export function carriesHostile(out: string): boolean {
  return out.split('\n').some((line) => HOSTILE_CHARACTERS.some((c) => line.includes(c)));
}

/** How many lines of `out` begin as each forged line does. */
export function forgedCounts(out: string): number[] {
  const lines = out.split('\n');
  return FORGED_HEADS.map((head) => lines.filter((l) => l.startsWith(head)).length);
}
