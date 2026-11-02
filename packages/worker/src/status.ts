// The worker's small public HTTP face (C18, C27):
//   GET /status      healthy, degraded or offline, per watched DAO, as JSON. Public by design.
//   POST /subscribe  {"dao": "<account id>"} gives a one-time Telegram token for a watched DAO.
//
// /status is built only from signal names, levels, times and Kaap's fixed sentences, never from
// a signal's fields, so no key, token, chat id or provider text can reach it. Token requests are
// counted per client address, which a caller cannot choose (6e): the connecting address, or for a
// request from the HTTPS proxy on the same machine, the one address that proxy adds to
// X-Forwarded-For (HOSTING.md).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { BlockList, isIP } from 'node:net';

import { z } from 'zod';

import { ACCOUNT_ID } from './config.ts';
import { ALL, SAYS, levelOf, type Health, type Raised } from './health.ts';
import type { Logger } from './log.ts';
import type { Subscriptions } from './subscriptions.ts';

const MAX_BODY = 1_024;
const HOUR = 3_600_000;
const subscribeBody = z.strictObject({ dao: z.string().regex(ACCOUNT_ID) });

export interface StatusSettings {
  host: string;
  port: number;
  network: string;
  guard: string;
  botUsername: string;
  tokensPerAddressHour: number;
}

export interface StatusDeps {
  health: Health;
  subs: Subscriptions;
  log: Logger;
  now: () => number;
  watching: () => string[];
}

/** Where the HTTPS proxy on the same machine connects from. */
const LOOPBACK = new BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');

/** One written form per address, so one client is one count: an IPv4 address written inside
 *  IPv6 is read as plain IPv4. Null for anything that is not an IP address. */
function oneForm(text: string): string | null {
  const a = text.trim().toLowerCase();
  const inside = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a)?.[1];
  if (inside !== undefined && isIP(inside) === 4) return inside;
  return isIP(a) === 0 ? null : a;
}

/** The address a request is counted against. A request from loopback came through the HTTPS
 *  proxy on the same machine, which adds the address its client connected from as the last entry
 *  of X-Forwarded-For: that one entry is trusted, and anything a client wrote before it is not.
 *  Any other peer is counted as it connects, its header ignored. A missing or unreadable entry
 *  counts against the proxy itself, which only ever makes the limit stricter. Not covered: a
 *  client that holds many addresses, such as an IPv6 range, which gets one count per address. */
export function clientAddress(peer: string | undefined, forwardedFor: string | string[] | undefined): string {
  const direct = oneForm(peer ?? '');
  if (direct === null) return 'unknown';
  if (!LOOPBACK.check(direct, isIP(direct) === 4 ? 'ipv4' : 'ipv6')) return direct;
  const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : (forwardedFor ?? '');
  return oneForm(header.split(',').at(-1) ?? '') ?? direct;
}

const shown = (r: Raised) => ({ signal: r.signal, level: levelOf(r.signal), since: new Date(r.since).toISOString(), says: SAYS[r.signal] });

/** The /status document. */
export function statusReport(health: Health, watching: string[], s: Pick<StatusSettings, 'network' | 'guard'>, now: number) {
  const raised = health.current();
  const everywhere = raised.filter((r) => r.dao === ALL).map(shown);
  const daos = [...watching].sort().map((dao) => ({ dao, status: health.levelFor(dao), signals: raised.filter((r) => r.dao === dao).map(shown) }));
  const levels = [...daos.map((d) => d.status), ...everywhere.map((e) => e.level)];
  const status = levels.includes('offline') ? 'offline' : levels.includes('degraded') ? 'degraded' : 'healthy';
  return { v: 1, network: s.network, guard: s.guard, status, watching: daos.length, checked_at: new Date(now).toISOString(), daos, everywhere };
}

export class StatusServer {
  readonly #d: StatusDeps;
  readonly #s: StatusSettings;
  readonly #asked = new Map<string, number[]>();
  #server: Server | null = null;

  constructor(deps: StatusDeps, settings: StatusSettings) {
    this.#d = deps;
    this.#s = settings;
  }

  /** Starts listening and resolves with the port, which tests set to 0. */
  start(): Promise<number> {
    const server = createServer((req, res) => {
      this.#handle(req, res).catch((e) => {
        this.#d.log.error('http_failed', { error: e });
        if (!res.headersSent) this.#json(res, 500, { error: 'internal' });
      });
    });
    server.requestTimeout = 10_000;
    server.headersTimeout = 5_000;
    server.keepAliveTimeout = 5_000;
    this.#server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.#s.port, this.#s.host, () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : this.#s.port;
        this.#d.log.info('http_listening', { host: this.#s.host, port, routes: ['GET /status', 'POST /subscribe'] });
        resolve(port);
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
  }

  #json(res: ServerResponse, code: number, body: unknown, extra: Record<string, string> = {}): void {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
    res.end(JSON.stringify(body));
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0];
    if (path === '/status') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return this.#json(res, 405, { error: 'method_not_allowed' }, { allow: 'GET' });
      return this.#json(res, 200, statusReport(this.#d.health, this.#d.watching(), this.#s, this.#d.now()), { 'access-control-allow-origin': '*' });
    }
    if (path === '/subscribe') {
      if (req.method !== 'POST') return this.#json(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
      return this.#subscribe(req, res);
    }
    return this.#json(res, 404, { error: 'not_found' });
  }

  async #subscribe(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const address = clientAddress(req.socket.remoteAddress, req.headers['x-forwarded-for']);
    const now = this.#d.now();
    const recent = (this.#asked.get(address) ?? []).filter((t) => now - t < HOUR);
    if (recent.length >= this.#s.tokensPerAddressHour) {
      this.#d.log.warn('rate_limited', { route: '/subscribe', address, per_hour: this.#s.tokensPerAddressHour });
      return this.#json(res, 429, { error: 'too_many_requests' }, { 'retry-after': String(Math.ceil((HOUR - (now - recent[0]!)) / 1_000)) });
    }
    const raw = await readBody(req);
    if (raw === null) return this.#json(res, 413, { error: 'body_too_large' });
    let parsed;
    try {
      parsed = subscribeBody.safeParse(JSON.parse(raw));
    } catch {
      parsed = null;
    }
    if (!parsed?.success) return this.#json(res, 400, { error: 'bad_request', expected: '{"dao": "<NEAR account id>"}' });
    const dao = parsed.data.dao;
    recent.push(now);
    this.#asked.set(address, recent);
    if (this.#asked.size > 10_000) this.#asked.delete(this.#asked.keys().next().value!);
    if (!this.#d.watching().includes(dao)) return this.#json(res, 404, { error: 'not_enrolled', dao });
    const { token, expiresMs } = this.#d.subs.issue(dao);
    return this.#json(res, 200, {
      dao,
      token,
      expires_at: new Date(expiresMs).toISOString(),
      start_command: `/start ${token}`,
      telegram_link: `https://t.me/${this.#s.botUsername}?start=${token}`,
    });
  }
}

/** The request body, or null when it passes the size cap. The rest of an oversized body is read
 *  and dropped, so the answer can still be written; the server's request timeout ends a body
 *  that never stops. */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total <= MAX_BODY) chunks.push(chunk);
    });
    req.on('end', () => resolve(total > MAX_BODY ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
