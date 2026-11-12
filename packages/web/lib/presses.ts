// The try-it button's limit per caller: two presses in ten minutes, and six in a day. The demo
// allows 40 filings a day in all (lib/demo.ts), so six is under a sixth of the day: one address
// pressing as often as it may cannot keep the button dark for everyone else. The count lives in
// this process; a host that runs several processes gives a caller this much in each.

export const PRESSES = 2;
export const WINDOW_MS = 10 * 60_000;
export const PRESSES_A_DAY = 6;
export const DAY_MS = 24 * 3_600_000;

export type Press = 'yes' | 'slow_down' | 'day_used';

/** Counts a press at `now` against `caller` in `recent`, or says which of the two limits is used
 *  up and counts nothing. */
export function press(recent: Map<string, number[]>, caller: string, now: number): Press {
  const today = (recent.get(caller) ?? []).filter((at) => now - at < DAY_MS);
  const lately = today.filter((at) => now - at < WINDOW_MS).length;
  if (lately >= PRESSES || today.length >= PRESSES_A_DAY) {
    recent.set(caller, today);
    return lately >= PRESSES ? 'slow_down' : 'day_used';
  }
  today.push(now);
  recent.set(caller, today);
  if (recent.size > 5_000) for (const [key, times] of recent) if (times.every((at) => now - at >= DAY_MS)) recent.delete(key);
  return 'yes';
}
