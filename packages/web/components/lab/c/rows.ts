/** The text moved forward by `by` characters, wrapping round, so each row starts later in the string. */
export function rotate(text: string, by: number): string {
  const start = ((by % text.length) + text.length) % text.length;
  return text.slice(start) + text.slice(0, start);
}

/** Enough rows to overflow any screen the lab page is opened on. */
export const ROW_COUNT = 64;

/** Enough copies of a row to overflow the widest screens, including the sideways drift. */
export const COPIES = 4;

export function buildRows(unit: string, step: number): string[] {
  return Array.from({ length: ROW_COUNT }, (_, index) => rotate(unit, index * step).repeat(COPIES));
}
