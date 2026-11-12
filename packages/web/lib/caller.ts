// Who a request is counted against by the routes' per-caller limits.
//
// Only X-Real-IP is read, and only when it is one address. Vercel's and Railway's proxies write
// the caller's address there over whatever the caller sent. X-Forwarded-For is not read: Vercel
// overwrites that one too, but Railway hands a caller's own value through untouched, and a limit
// that holds on one host and not on the next is a trap.
//
// With no readable X-Real-IP (a run on one's own machine, or a host whose proxy sets none) every
// caller shares one count, so the limit only ever gets stricter.
//
// Not covered: a host where callers reach the app with no such proxy in between can be told any
// address, and an IPv6 caller is counted by address, not by network. The limits that cost
// something do not rest on this: the try-it button allows one filing in flight and a daily count
// read from the chain, whoever asks.
import { isIP } from 'node:net';

export function callerOf(request: Request): string {
  const said = request.headers.get('x-real-ip')?.trim().toLowerCase() ?? '';
  return isIP(said) === 0 ? 'shared' : said;
}
