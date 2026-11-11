// The Telegram Bot API, Kaap's one alert channel (decided 20 Oct 2026). A message goes out as
// plain text with no parse mode and no entities (C24), so Telegram reads no markup in it, and
// with link previews off, so Telegram never fetches anything a message names.
//
// The bot token sits in every request path. So every error here is fixed text plus Telegram's
// numeric code, never an exception message or a URL that could carry the token, and main.ts
// registers the token with the log redactor before the first call.

import { z } from 'zod';

import { readCapped } from './rpc.ts';

export type SendResult =
  /** Telegram's own `"ok": true`, its message_id, and the chat its reply names. */
  | { ok: true; messageId: number; chatId: string | null }
  | {
      ok: false;
      /** Telegram's error_code, or null when no answer came back. */
      code: number | null;
      /** A network failure, a 5xx or a 429: the same message may go through later. */
      retryable: boolean;
      /** 403: the bot was blocked or removed, so the chat can never get a message again. */
      gone: boolean;
      retryAfterMs: number | null;
      detail: string;
    };

export interface ChatUpdate {
  updateId: number;
  chatId: string;
  chatType: string;
  text: string | null;
  /** The bot was blocked in, or removed from, this chat. */
  left: boolean;
}

/** What the worker needs from Telegram. The live one is `BotApi`; tests use a fake. */
export interface TelegramApi {
  sendMessage(chatId: string, text: string): Promise<SendResult>;
  /** Updates from `offset` on, and the offset that confirms all of them. Updates of a shape the
   *  worker does not read are skipped, and confirmed too, so one odd update never blocks the rest. */
  getUpdates(offset: number, timeoutSec: number): Promise<{ updates: ChatUpdate[]; next: number }>;
  getMe(): Promise<{ username: string }>;
}

const MAX_ANSWER_BYTES = 1024 * 1024;

const answer = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error_code: z.number().int().optional(),
  description: z.string().optional(),
  parameters: z.object({ retry_after: z.number().int().nonnegative().optional() }).optional(),
});

// Telegram says a chat id "has at most 52 significant bits", so a JavaScript number holds it.
const chat = z.object({ id: z.number().int().refine(Number.isSafeInteger), type: z.string().max(32) });
const update = z.object({
  update_id: z.number().int().nonnegative(),
  message: z.object({ chat, text: z.string().max(4_096).optional() }).optional(),
  my_chat_member: z.object({ chat, new_chat_member: z.object({ status: z.string().max(32) }) }).optional(),
});

const clean = (text: unknown) => String(text ?? '').replace(/[^\x20-\x7e]/g, '?').slice(0, 120);

/** A chat id as logs may show it: never in full (C26). */
export const maskChat = (chatId: string) => `***${chatId.slice(-3)}`;

export interface BotApiOptions {
  /** Only tests change this, to point the client at a local server. */
  base?: string;
  timeoutMs?: number;
}

export class BotApi implements TelegramApi {
  readonly #base: string;
  readonly #timeoutMs: number;

  constructor(token: string, options: BotApiOptions = {}) {
    this.#base = `${options.base ?? 'https://api.telegram.org'}/bot${token}`;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  async #call(method: string, body: object, timeoutMs = this.#timeoutMs): Promise<z.output<typeof answer> | { failed: string }> {
    let res: Response;
    try {
      res = await fetch(`${this.#base}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
      return { failed: timedOut ? `no answer from Telegram within ${timeoutMs} ms` : 'Telegram could not be reached' };
    }
    try {
      const parsed = answer.safeParse(JSON.parse(await readCapped(res, MAX_ANSWER_BYTES, 'telegram')));
      return parsed.success ? parsed.data : { failed: `Telegram answered HTTP ${res.status} in an unknown shape` };
    } catch {
      return { failed: `Telegram answered HTTP ${res.status} with something that is not JSON` };
    }
  }

  async sendMessage(chatId: string, text: string): Promise<SendResult> {
    const r = await this.#call('sendMessage', { chat_id: Number(chatId), text, link_preview_options: { is_disabled: true } });
    if ('failed' in r) return { ok: false, code: null, retryable: true, gone: false, retryAfterMs: null, detail: r.failed };
    const sent = r.result as { message_id?: unknown; chat?: { id?: unknown } } | undefined;
    if (r.ok && typeof sent?.message_id === 'number') return { ok: true, messageId: sent.message_id, chatId: typeof sent.chat?.id === 'number' ? String(sent.chat.id) : null };
    const code = r.error_code ?? null;
    return {
      ok: false,
      code,
      retryable: code === null || code === 429 || code >= 500,
      gone: code === 403,
      retryAfterMs: r.parameters?.retry_after !== undefined ? r.parameters.retry_after * 1_000 : null,
      detail: clean(r.description ?? 'Telegram refused the message'),
    };
  }

  async getUpdates(offset: number, timeoutSec: number): Promise<{ updates: ChatUpdate[]; next: number }> {
    const r = await this.#call('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message', 'my_chat_member'] }, (timeoutSec + 10) * 1_000);
    if ('failed' in r) throw new Error(r.failed);
    if (!r.ok || !Array.isArray(r.result)) throw new Error(`getUpdates refused: ${r.error_code ?? 'no code'} ${clean(r.description)}`);
    const updates: ChatUpdate[] = [];
    let next = offset;
    for (const raw of r.result) {
      const id = (raw as { update_id?: unknown })?.update_id;
      if (typeof id === 'number' && Number.isSafeInteger(id)) next = Math.max(next, id + 1);
      const u = update.safeParse(raw);
      if (!u.success) continue;
      if (u.data.message) {
        updates.push({ updateId: u.data.update_id, chatId: String(u.data.message.chat.id), chatType: u.data.message.chat.type, text: u.data.message.text ?? null, left: false });
      } else if (u.data.my_chat_member) {
        const status = u.data.my_chat_member.new_chat_member.status;
        updates.push({ updateId: u.data.update_id, chatId: String(u.data.my_chat_member.chat.id), chatType: u.data.my_chat_member.chat.type, text: null, left: status === 'kicked' || status === 'left' });
      }
    }
    return { updates, next };
  }

  async getMe(): Promise<{ username: string }> {
    const r = await this.#call('getMe', {});
    if ('failed' in r) throw new Error(`getMe failed: ${r.failed}`);
    const username = (r.result as { username?: unknown } | undefined)?.username;
    if (!r.ok || typeof username !== 'string' || !/^[A-Za-z0-9_]{5,32}$/.test(username)) throw new Error(`the Telegram bot token was refused (${r.error_code ?? 'no code'})`);
    return { username };
  }
}
