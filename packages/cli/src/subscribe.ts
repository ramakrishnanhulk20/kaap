// `kaap subscribe <dao> --worker <url>`: asks Kaap's worker for a one-time Telegram token for a
// DAO's alerts (C27). The subscription itself starts in the chat: the member sends `/start <token>`
// to the bot, so the CLI never learns or sends a chat id. The token is single use and expires in
// 15 minutes (packages/worker/src/subscriptions.ts).
//
// The worker is the one host the CLI does not fix itself: its address comes from --worker, which
// args.ts holds to https (or http on this machine). Its answer is checked like any input before a
// character of it is shown (C24): the token's exact shape, the DAO it names, and a link that can only
// point at Telegram's own t.me.

import { z } from 'zod';

import { MAX_WORKER_ANSWER_BYTES, RPC_TIMEOUT_MS } from './caps.js';
import type { Core } from './core.js';
import { NetError, type Transport } from './net.js';
import { oneLine } from './text.js';

export class WorkerRefused extends Error {
  /** Exit code: 3 when the worker does not watch the DAO, 1 for anything else. */
  readonly code: number;
  constructor(message: string, code = 1) {
    super(message);
    this.name = 'WorkerRefused';
    this.code = code;
  }
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

const answerSchema = z.strictObject({
  dao: z.string(),
  token: z.string().regex(TOKEN),
  expires_at: z.iso.datetime(),
  start_command: z.string(),
  telegram_link: z.string(),
});

export interface Subscription {
  dao: string;
  token: string;
  expiresAt: string;
  link: string;
}

export async function subscribe(core: Core, transport: Transport, request: { dao: string; worker: string }): Promise<Subscription> {
  if (!core.isAccountId(request.dao)) throw new WorkerRefused('not a valid NEAR account id', 3);
  let response;
  try {
    response = await transport({ url: `${request.worker}/subscribe`, method: 'POST', body: JSON.stringify({ dao: request.dao }), timeoutMs: RPC_TIMEOUT_MS, maxBytes: MAX_WORKER_ANSWER_BYTES });
  } catch (e) {
    throw new WorkerRefused(e instanceof NetError ? `the worker could not be asked: ${e.message}` : 'the worker could not be asked');
  }
  if (response.status === 404) throw new WorkerRefused(`the worker at ${request.worker} does not watch ${request.dao}: only an enrolled DAO has alerts`, 3);
  if (response.status === 429) {
    const wait = response.retryAfterMs === undefined ? '' : `, again in about ${Math.ceil(response.retryAfterMs / 60_000)} minutes`;
    throw new WorkerRefused(`the worker refused: too many token requests from this address${wait}`);
  }
  if (response.status !== 200) throw new WorkerRefused(`the worker answered HTTP ${response.status}`);
  let answer;
  try {
    answer = answerSchema.safeParse(JSON.parse(response.text));
  } catch {
    answer = null;
  }
  if (!answer?.success) throw new WorkerRefused('the worker\'s answer is not a subscription token');
  const { token, dao, start_command: start, telegram_link: link, expires_at: expiresAt } = answer.data;
  const bot = /^https:\/\/t\.me\/([A-Za-z0-9_]{5,32})\?start=([A-Za-z0-9_-]{43})$/.exec(link);
  if (dao !== request.dao || start !== `/start ${token}` || bot === null || bot[2] !== token) {
    throw new WorkerRefused('the worker\'s answer does not hold together (DAO, token and link differ)');
  }
  return { dao, token, expiresAt, link };
}

export function render(s: Subscription): string {
  return [
    `kaap subscribe ${oneLine(s.dao, 80)}`,
    `one-time token, valid until ${s.expiresAt}: ${s.token}`,
    '',
    'To get this DAO\'s alerts in Telegram:',
    `  1. Open ${s.link}`,
    '     (or find the bot in Telegram and send it the line below)',
    `  2. Send: /start ${s.token}`,
    '  3. The bot answers "Subscribed". Send /stop at any time to end every alert in that chat.',
    '',
    'The token works once. Anyone who has it before you use it could take this subscription, so keep it to yourself until you send it.',
  ].join('\n');
}
