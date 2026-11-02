// Who gets alerts (C27). A subscription starts in the chat itself: a member asks for a one-time
// token (`kaap subscribe <dao>`, which calls POST /subscribe), then sends `/start <token>` to the
// bot, or opens the bot's t.me link carrying it. The token is random, lives 15 minutes, works
// once, and is stored only as its SHA-256. `/stop` ends every subscription of the chat.
//
// Anyone can ask for a token for an enrolled DAO: alerts carry only facts that are public on
// chain, so a subscription grants nothing private. Chat ids are kept only in the store and are
// never logged in full (C26).

import { createHash, randomBytes } from 'node:crypto';

import { shownAccount } from './alerts.ts';
import type { Logger } from './log.ts';
import type { Store, SubscriptionRow } from './store.ts';
import { maskChat, type ChatUpdate, type TelegramApi } from './telegram.ts';

export const TOKEN_TTL_MS = 15 * 60_000;
// 32 random bytes in base64url: also inside Telegram's 64-character limit for a /start payload.
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const COMMAND = /^\/(start|stop|help)(?:@([A-Za-z0-9_]{5,32}))?(?:[ \t]+(\S+))?[ \t]*$/;
const CHAT_TYPES: ReadonlySet<string> = new Set(['private', 'group', 'supergroup']);
const REPLY_GAP_MS = 3_000;

/** One hash for both the stored token and the one presented, so the two are always compared in
 *  the same form. */
const digest = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

const HOW = 'To get Kaap alerts for a DAO, run "kaap subscribe <dao>" and send the /start line it prints here.';

export class Subscriptions {
  readonly #store: Store;
  readonly #network: string;
  readonly #log: Logger;

  constructor(store: Store, network: string, log: Logger) {
    this.#store = store;
    this.#network = network;
    this.#log = log;
  }

  /** A new one-time token for `dao`. The caller has checked that the worker watches `dao`. */
  issue(dao: string): { token: string; expiresMs: number } {
    const token = randomBytes(32).toString('base64url');
    const expiresMs = this.#store.now() + TOKEN_TTL_MS;
    this.#store.addToken(this.#network, dao, digest(token), expiresMs);
    this.#log.info('subscribe_token_issued', { dao, expires_at: new Date(expiresMs).toISOString() });
    return { token, expiresMs };
  }

  /** Subscribes `chatId` with `token`, or returns null when the token is malformed, unknown,
   *  used or expired. A token that is not well formed never reaches the store. */
  redeem(token: string, chatId: string): SubscriptionRow | null {
    if (!TOKEN.test(token)) return null;
    return this.#store.redeemToken(this.#network, digest(token), chatId);
  }

  stop(chatId: string): number {
    return this.#store.endChat(this.#network, chatId);
  }

  active(chatId: string): SubscriptionRow[] {
    return this.#store.chatSubscriptions(this.#network, chatId);
  }
}

export interface BotDeps {
  subs: Subscriptions;
  telegram: TelegramApi;
  store: Store;
  log: Logger;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export class Bot {
  readonly #d: BotDeps;
  readonly #username: string;
  readonly #lastReply = new Map<string, number>();
  #running = false;
  #loop: Promise<void> | null = null;

  constructor(deps: BotDeps, username: string) {
    this.#d = deps;
    this.#username = username;
  }

  /** Answers one update. Only the three commands get a reply, each a fixed text, so the bot
   *  cannot be made to repeat anything a stranger typed. */
  async handle(u: ChatUpdate): Promise<void> {
    const { subs, log } = this.#d;
    if (!CHAT_TYPES.has(u.chatType)) return;
    if (u.left) {
      const ended = subs.stop(u.chatId);
      if (ended > 0) log.info('unsubscribed', { chat: maskChat(u.chatId), subscriptions: ended, why: 'the bot was blocked or removed from the chat' });
      return;
    }
    const m = u.text === null ? null : COMMAND.exec(u.text.trim());
    if (!m) return;
    if (m[2] !== undefined && m[2].toLowerCase() !== this.#username.toLowerCase()) return;

    if (m[1] === 'start' && m[3] !== undefined) {
      const sub = subs.redeem(m[3], u.chatId);
      if (sub) {
        log.info('subscribed', { subscription: sub.id, dao: sub.dao, chat: maskChat(u.chatId) });
        await this.#reply(u.chatId, `Subscribed. This chat now gets Kaap alerts for ${shownAccount(sub.dao)}. Send /stop to stop them.`, true);
      } else {
        log.warn('subscribe_refused', { chat: maskChat(u.chatId), why: 'the token is malformed, unknown, used or expired' });
        await this.#reply(u.chatId, `That subscription token is not valid: it may be used or more than 15 minutes old. ${HOW}`);
      }
      return;
    }
    if (m[1] === 'stop') {
      const ended = subs.stop(u.chatId);
      if (ended > 0) log.info('unsubscribed', { chat: maskChat(u.chatId), subscriptions: ended, why: '/stop' });
      await this.#reply(u.chatId, ended > 0 ? 'Unsubscribed. This chat gets no more Kaap alerts.' : 'This chat had no Kaap alerts to stop.', true);
      return;
    }
    const daos = subs.active(u.chatId).map((s) => shownAccount(s.dao));
    await this.#reply(u.chatId, daos.length > 0 ? `This chat gets Kaap alerts for ${daos.join(', ')}. Send /stop to stop them.` : HOW);
  }

  /** At most one reply every few seconds per chat, except the answers to a subscribe or a stop. */
  async #reply(chatId: string, text: string, always = false): Promise<void> {
    const now = this.#d.now();
    if (!always && now - (this.#lastReply.get(chatId) ?? -Infinity) < REPLY_GAP_MS) return;
    this.#lastReply.set(chatId, now);
    if (this.#lastReply.size > 10_000) this.#lastReply.clear();
    const r = await this.#d.telegram.sendMessage(chatId, text);
    if (!r.ok) this.#d.log.warn('bot_reply_failed', { chat: maskChat(chatId), code: r.code, detail: r.detail });
  }

  /** One long poll. The offset is saved after each batch, so a restart neither answers an update
   *  twice nor skips one. */
  async pollOnce(timeoutSec: number): Promise<number> {
    const { store, telegram, log } = this.#d;
    const offset = Number(store.setting('telegram_offset') ?? '0');
    const { updates, next } = await telegram.getUpdates(offset, timeoutSec);
    for (const u of updates) {
      try {
        await this.handle(u);
      } catch (e) {
        log.error('bot_update_failed', { update: u.updateId, error: e });
      }
    }
    if (next !== offset) store.setSetting('telegram_offset', String(next));
    return updates.length;
  }

  start(): void {
    this.#running = true;
    this.#loop = this.#run();
  }

  async stop(): Promise<void> {
    this.#running = false;
    await this.#loop;
  }

  async #run(): Promise<void> {
    let failingSince: number | null = null;
    while (this.#running) {
      try {
        await this.pollOnce(20);
        if (failingSince !== null) this.#d.log.info('telegram_poll_recovered', { failed_for_ms: this.#d.now() - failingSince });
        failingSince = null;
      } catch (e) {
        if (failingSince === null) this.#d.log.error('telegram_poll_failed', { error: e, effect: 'new subscriptions and /stop wait until Telegram answers again' });
        failingSince ??= this.#d.now();
        await this.#d.sleep(5_000);
      }
    }
  }
}
