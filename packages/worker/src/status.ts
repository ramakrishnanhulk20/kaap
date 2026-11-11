// The worker's small public HTTP face (C18, C27):
//   GET /status      healthy, degraded or offline, per watched DAO, as JSON. Public by design.
//   POST /subscribe  {"dao": "<account id>"} gives a one-time Telegram token for a watched DAO.
//   GET /text-key    the sealed program's text key for runs the worker signs, as stored.
//   POST /texts      a member's text, sealed to that key, judged in one sealed run (C26).
//
// /status is built only from signal names, levels, times and Kaap's fixed sentences, never from
// a signal's fields, so no key, token, chat id or provider text can reach it. Token and text
// requests are counted per client address, which a caller cannot choose (6e): the connecting
// address, or for a request from the HTTPS proxy on the same machine, the one address that proxy
// adds to X-Forwarded-For (HOSTING.md).
//
// A text arrives as ciphertext only the sealed program can open, and the worker never holds it in
// any other form. Neither the ciphertext nor the reply key is logged, stored or echoed: every
// answer is a fixed error word or the checked verdict, and the log line names the DAO, the
// proposal, the run and the result.

import { createPublicKey, diffieHellman, generateKeyPairSync } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { BlockList, isIP } from 'node:net';

import { PublicKey } from 'near-api-js';
import { z } from 'zod';

import { ACCOUNT_ID } from './config.ts';
import { ALL, SAYS, levelOf, type Health, type Raised } from './health.ts';
import type { SealedText } from './judge.ts';
import type { Logger } from './log.ts';
import type { Subscriptions } from './subscriptions.ts';
import type { TextOutcome } from './worker.ts';

const MAX_BODY = 1_024;
const MAX_TEXT_BODY = 64 * 1_024;
const MAX_CIPHERTEXT_BYTES = 48 * 1_024;
const HOUR = 3_600_000;
const subscribeBody = z.strictObject({ dao: z.string().regex(ACCOUNT_ID) });
const textBody = z.strictObject({
  dao: z.string().regex(ACCOUNT_ID),
  proposal_id: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  text_ciphertext: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/),
  reply_key: z.string().regex(/^[0-9a-fA-F]{64}$/),
});

const X25519_SPKI = Buffer.from('302a300506032b656e032100', 'hex');
const PROBE = generateKeyPairSync('x25519').privateKey;

/** True when `raw` is a public key an X25519 exchange can trust. OpenSSL refuses a low-order point,
 *  whose shared secret is zero whatever the other side holds, which is the sealed program's own
 *  test (`texts::is_usable_key`); a reply sealed to one could be read by anyone. */
function usableReplyKey(raw: Buffer): boolean {
  try {
    diffieHellman({ privateKey: PROBE, publicKey: createPublicKey({ key: Buffer.concat([X25519_SPKI, raw]), format: 'der', type: 'spki' }) });
    return true;
  } catch {
    return false;
  }
}

/** The body of POST /texts, or null for any shape fault: not one JSON object with exactly the
 *  four fields, a reply key that is not 32 usable bytes, a ciphertext that is not canonical base64
 *  of 1 byte to 48 KiB. The ciphertext is compared with its own re-encoding, so the sealed program,
 *  whose base64 reader is strict, reads the same bytes the worker checked. */
export function parseTextBody(raw: string): { dao: string; id: number; text: SealedText } | null {
  let parsed;
  try {
    parsed = textBody.safeParse(JSON.parse(raw));
  } catch {
    return null;
  }
  if (!parsed.success) return null;
  const { dao, proposal_id: id, text_ciphertext: ciphertext, reply_key: replyKey } = parsed.data;
  const bytes = Buffer.from(ciphertext, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_CIPHERTEXT_BYTES || bytes.toString('base64') !== ciphertext) return null;
  const key = Buffer.from(replyKey, 'hex');
  if (key.length !== 32 || !usableReplyKey(key)) return null;
  return { dao, id, text: { ciphertext, replyKey: key.toString('hex') } };
}

/** What POST /texts needs from the worker. */
export interface TextDesk {
  /** Whether the sealed run's input for this text stays inside what the sealed program reads. */
  textFits(dao: string, id: number, text: SealedText): boolean;
  judgeText(dao: string, id: number, text: SealedText): Promise<TextOutcome>;
}

/** The answer of one worker-signed `{"v":1,"op":"pubkey"}` run, as deployments/<network>.json
 *  stores it under `text_key`. */
export const textKeySchema = z.strictObject({
  key: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
  public_key: z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/),
  run_tx: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/),
  build: z.string().regex(/^[0-9a-f]{64}$/),
});
export type TextKey = z.output<typeof textKeySchema>;

/** In front of the 32 key bytes in what the verdict key signs (packages/sealed/src/texts.rs). */
const TEXT_KEY_DOMAIN = 'kaap-text-key-v1\n';

/** Whether `acceptedKey`, the key the guard accepts, signed this text key. */
export function textKeySigned(textKey: TextKey, acceptedKey: string): boolean {
  try {
    const message = Buffer.concat([Buffer.from(TEXT_KEY_DOMAIN), Buffer.from(textKey.key, 'hex')]);
    return PublicKey.fromString(acceptedKey).verify(message, Buffer.from(textKey.signature, 'base64'));
  } catch {
    return false;
  }
}

export interface StatusSettings {
  host: string;
  port: number;
  network: string;
  guard: string;
  botUsername: string;
  tokensPerAddressHour: number;
  textsPerAddressHour: number;
  /** Null when the deployments file holds none; GET /text-key then answers 404. */
  textKey: TextKey | null;
}

export interface StatusDeps {
  health: Health;
  subs: Subscriptions;
  log: Logger;
  now: () => number;
  watching: () => string[];
  texts: TextDesk;
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
  readonly #textsAsked = new Map<string, number[]>();
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
        this.#d.log.info('http_listening', { host: this.#s.host, port, routes: ['GET /status', 'POST /subscribe', 'GET /text-key', 'POST /texts'] });
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
    if (path === '/text-key') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return this.#json(res, 405, { error: 'method_not_allowed' }, { allow: 'GET' });
      if (!this.#s.textKey) return this.#json(res, 404, { error: 'no_text_key' });
      return this.#json(res, 200, this.#s.textKey, { 'access-control-allow-origin': '*' });
    }
    if (path === '/subscribe') {
      if (req.method !== 'POST') return this.#json(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
      return this.#subscribe(req, res);
    }
    if (path === '/texts') {
      if (req.method !== 'POST') return this.#json(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
      return this.#texts(req, res);
    }
    return this.#json(res, 404, { error: 'not_found' });
  }

  /** The texts `address` sent within the hour before `now`, or null when it may send none more. */
  #textsLeft(address: string, now: number): number[] | null {
    const recent = (this.#textsAsked.get(address) ?? []).filter((t) => now - t < HOUR);
    return recent.length < this.#s.textsPerAddressHour ? recent : null;
  }

  #tooManyTexts(res: ServerResponse, address: string, now: number): void {
    const oldest = (this.#textsAsked.get(address) ?? []).find((t) => now - t < HOUR) ?? now;
    this.#d.log.warn('rate_limited', { route: '/texts', address, per_hour: this.#s.textsPerAddressHour });
    this.#json(res, 429, { error: 'too_many_requests' }, { 'retry-after': String(Math.max(1, Math.ceil((HOUR - (now - oldest)) / 1_000))) });
  }

  /** POST /texts. Every answer is a fixed error word or the checked verdict; nothing of the request
   *  is echoed. A text is counted against its address once its shape checks out, and the count is
   *  taken again then, since several requests from one address can be read at the same time. */
  async #texts(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const address = clientAddress(req.socket.remoteAddress, req.headers['x-forwarded-for']);
    if (!this.#textsLeft(address, this.#d.now())) return this.#tooManyTexts(res, address, this.#d.now());
    const raw = await readBody(req, MAX_TEXT_BODY);
    const body = raw === null ? null : parseTextBody(raw);
    if (!body || !this.#d.texts.textFits(body.dao, body.id, body.text)) {
      this.#d.log.info('text', { result: 'bad_request' });
      return this.#json(res, 400, { error: 'bad_request' });
    }
    const now = this.#d.now();
    const recent = this.#textsLeft(address, now);
    if (!recent) return this.#tooManyTexts(res, address, now);
    recent.push(now);
    this.#textsAsked.set(address, recent);
    if (this.#textsAsked.size > 10_000) this.#textsAsked.delete(this.#textsAsked.keys().next().value!);

    const { dao, id } = body;
    let outcome: TextOutcome;
    try {
      outcome = await this.#d.texts.judgeText(dao, id, body.text);
    } catch (e) {
      // Only the error's name: a message could quote what it was handed.
      this.#d.log.error('text', { dao, proposal_id: id, run_tx: null, result: 'internal', error: e instanceof Error ? e.name : 'unknown' });
      return this.#json(res, 500, { error: 'internal' });
    }
    const logged = (result: string, runTx: string | null = null) => this.#d.log.info('text', { dao, proposal_id: id, run_tx: runTx, result });
    switch (outcome.kind) {
      case 'not_watched':
        logged('dao_not_watched');
        return this.#json(res, 404, { error: 'dao_not_watched' });
      case 'not_open':
        logged('proposal_not_open');
        return this.#json(res, 409, { error: 'proposal_not_open' });
      case 'capped':
        logged('over_budget');
        return this.#json(res, 503, { error: 'over_budget' });
      case 'failed':
        logged(`run_failed: ${outcome.reason}`, outcome.runTx);
        return this.#json(res, 502, { error: 'run_failed', reason: outcome.reason });
      case 'judged': {
        const v = outcome.verdict;
        logged(`judged, veto ${outcome.veto === 'started' ? 'started' : 'not needed'}`, outcome.runTx);
        // The verdict writes an empty model id when no model answered.
        const modelId = v.model_id === '' ? null : v.model_id;
        return this.#json(res, 200, { status: 'judged', run_tx: outcome.runTx, risk: v.risk, floor: v.floor, findings: v.findings, ai_status: v.ai_status, model_id: modelId, explanation: outcome.explanation, veto: outcome.veto });
      }
    }
  }

  async #subscribe(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const address = clientAddress(req.socket.remoteAddress, req.headers['x-forwarded-for']);
    const now = this.#d.now();
    const recent = (this.#asked.get(address) ?? []).filter((t) => now - t < HOUR);
    if (recent.length >= this.#s.tokensPerAddressHour) {
      this.#d.log.warn('rate_limited', { route: '/subscribe', address, per_hour: this.#s.tokensPerAddressHour });
      return this.#json(res, 429, { error: 'too_many_requests' }, { 'retry-after': String(Math.ceil((HOUR - (now - recent[0]!)) / 1_000)) });
    }
    const raw = await readBody(req, MAX_BODY);
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

/** The request body, or null when it passes `max` bytes. The rest of an oversized body is read
 *  and dropped, so the answer can still be written; the server's request timeout ends a body
 *  that never stops. */
function readBody(req: IncomingMessage, max: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total <= max) chunks.push(chunk);
    });
    req.on('end', () => resolve(total > max ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
