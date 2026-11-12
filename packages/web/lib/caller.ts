// Who a request is counted against by the routes' per-caller limits.
//
// By default nobody is believed: every caller shares one count, so a limit can only be stricter
// than meant. Where the operator sets KAAP_SITE_PROXY=x-real-ip, saying that every request arrives
// through a proxy that writes the caller's address into X-Real-IP over whatever the caller sent,
// as Vercel's and Railway's do, that header is read, and only when it is one address.
// X-Forwarded-For is never read: Vercel overwrites that one too, but Railway hands a caller's own
// value through untouched, and a limit that holds on one host and not on the next is a trap.
//
// Not covered: the setting switched on at a host whose proxy does not overwrite X-Real-IP, where a
// caller can then name any address (check it after each deploy by asking past a limit under
// made-up addresses), and an IPv6 caller is counted by address, not by network. The limits that
// cost something do not rest on this alone: the try-it button allows one filing in flight and a
// daily count read from the chain, whoever asks.
import { isIP } from 'node:net';

export function callerOf(request: Request): string {
  if (process.env.KAAP_SITE_PROXY !== 'x-real-ip') return 'shared';
  const said = request.headers.get('x-real-ip')?.trim().toLowerCase() ?? '';
  return isIP(said) === 0 ? 'shared' : said;
}
