// Subscriptions (C26, C27): a one-time token from the CLI, used from the chat itself, works once
// and expires; /stop ends every subscription of the chat, and so does removing the bot; chat ids
// and tokens never reach a log line in full; the poll offset survives a restart. Not covered: the
// CLI command that asks for the token (`kaap subscribe`, tested in packages/cli) and Telegram's
// own delivery of /start.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Bot, Subscriptions, TOKEN_TTL_MS } from '../src/subscriptions.ts';
import { DAO, FakeTelegram, NETWORK, chatMessage, clock, memoryLog, memoryStore, noSleep } from './helpers.ts';

const CHAT_A = '5550001234';
const CHAT_B = '-1009990005678';
const OTHER_DAO = 'other.sputnik.testnet';

function setup() {
  const c = clock();
  const store = memoryStore(c.now);
  const { log, lines, text } = memoryLog();
  const telegram = new FakeTelegram();
  const subs = new Subscriptions(store, NETWORK, log);
  const bot = new Bot({ subs, telegram, store, log, now: c.now, sleep: noSleep }, 'kaap_test_bot');
  const chats = (dao: string) => store.subscribers(NETWORK, dao).map((r) => r.chat_id);
  return { c, store, telegram, subs, bot, chats, lines: () => lines, logText: text };
}

test('a subscription token works once, from the chat that sends it, and expires after 15 minutes (C27)', async () => {
  const s = setup();
  const { token, expiresMs } = s.subs.issue(DAO);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(expiresMs - s.c.now(), TOKEN_TTL_MS);

  await s.bot.handle(chatMessage(1, CHAT_A, `/start ${token}`));
  assert.deepEqual(s.chats(DAO), [CHAT_A]);
  assert.equal(s.telegram.to(CHAT_A)[0], 'Subscribed. This chat now gets Kaap alerts for treasury[.]sputnik[.]testnet. Send /stop to stop them.');

  await s.bot.handle(chatMessage(2, CHAT_B, `/start ${token}`, 'supergroup'));
  assert.deepEqual(s.chats(DAO), [CHAT_A], 'a used token subscribes nobody else');
  assert.match(s.telegram.to(CHAT_B)[0]!, /^That subscription token is not valid/);

  const late = s.subs.issue(DAO).token;
  const inTime = s.subs.issue(DAO).token;
  s.c.advance(TOKEN_TTL_MS - 1);
  await s.bot.handle(chatMessage(3, CHAT_B, `/start@kaap_test_bot ${inTime}`, 'group'));
  assert.deepEqual(s.chats(DAO), [CHAT_A, CHAT_B], 'a group can subscribe with the command addressed to this bot');
  s.c.advance(1);
  assert.equal(s.subs.redeem(late, '5550004444'), null, 'an expired token is refused');

  await s.bot.handle(chatMessage(4, '5550005555', `/start@another_bot ${s.subs.issue(DAO).token}`, 'group'));
  assert.equal(s.telegram.to('5550005555').length, 0, 'a command for another bot is not ours to answer');
  for (const bad of ['short', `${token}x`, "' OR 1=1 --".padEnd(43, 'a')]) assert.equal(s.subs.redeem(bad, '5550006666'), null);

  const stored = JSON.stringify(s.store.db.prepare('SELECT * FROM subscribe_tokens').all());
  assert.ok(!stored.includes(token) && !stored.includes(inTime), 'only the SHA-256 of a token is kept');
});

test('/stop ends every subscription of the chat, and so does removing the bot', async () => {
  const s = setup();
  for (const dao of [DAO, OTHER_DAO]) await s.bot.handle(chatMessage(1, CHAT_A, `/start ${s.subs.issue(dao).token}`));
  assert.deepEqual([s.chats(DAO), s.chats(OTHER_DAO)], [[CHAT_A], [CHAT_A]]);
  await s.bot.handle(chatMessage(2, CHAT_A, '/help'));
  assert.equal(s.telegram.to(CHAT_A).length, 2, 'a /help straight after a reply waits, so the bot cannot be used to make noise');
  s.c.advance(3_000);
  await s.bot.handle(chatMessage(2, CHAT_A, '/help'));
  assert.equal(s.telegram.to(CHAT_A).at(-1), 'This chat gets Kaap alerts for treasury[.]sputnik[.]testnet, other[.]sputnik[.]testnet. Send /stop to stop them.');

  await s.bot.handle(chatMessage(3, CHAT_A, '/stop'));
  assert.deepEqual([s.chats(DAO), s.chats(OTHER_DAO)], [[], []]);
  assert.equal(s.telegram.to(CHAT_A).at(-1), 'Unsubscribed. This chat gets no more Kaap alerts.');

  await s.bot.handle(chatMessage(4, CHAT_A, `/start ${s.subs.issue(DAO).token}`));
  assert.deepEqual(s.chats(DAO), [CHAT_A], 'a chat can come back with a new token');
  await s.bot.handle({ updateId: 5, chatId: CHAT_A, chatType: 'private', text: null, left: true });
  assert.deepEqual(s.chats(DAO), [], 'blocking the bot unsubscribes the chat');

  const before = s.telegram.sent.length;
  await s.bot.handle(chatMessage(6, CHAT_A, 'please repeat <b>this</b> https://evil.example'));
  await s.bot.handle(chatMessage(7, '-100555', `/start ${s.subs.issue(DAO).token}`, 'channel'));
  assert.equal(s.telegram.sent.length, before, 'plain text and channels get no answer');
  assert.deepEqual(s.chats(DAO), []);
});

test('chat ids and tokens never reach a log line in full (C26)', async () => {
  const s = setup();
  const token = s.subs.issue(DAO).token;
  await s.bot.handle(chatMessage(1, CHAT_A, `/start ${token}`));
  await s.bot.handle(chatMessage(2, CHAT_B, `/start ${token}`, 'group'));
  await s.bot.handle(chatMessage(3, CHAT_A, '/stop'));
  const out = s.logText();
  for (const secret of [token, CHAT_A, CHAT_B, CHAT_A.slice(1), CHAT_B.slice(2)]) assert.ok(!out.includes(secret), `${secret} is not in the log`);
  assert.ok(out.includes('***234') && out.includes('"subscription":1'), 'the log names the subscription row and a masked chat');
});

test('the poll offset is saved, so after a restart each update is answered once', async () => {
  const s = setup();
  s.telegram.updates = [chatMessage(41, CHAT_A, '/help'), chatMessage(42, CHAT_B, '/help', 'group')];
  assert.equal(await s.bot.pollOnce(0), 2);
  assert.equal(s.store.setting('telegram_offset'), '43');

  const restarted = new Bot({ subs: s.subs, telegram: s.telegram, store: s.store, log: memoryLog().log, now: s.c.now, sleep: noSleep }, 'kaap_test_bot');
  s.telegram.updates = [chatMessage(42, CHAT_B, '/help', 'group'), chatMessage(43, CHAT_A, '/stop')];
  assert.equal(await restarted.pollOnce(0), 1);
  assert.equal(s.telegram.to(CHAT_B).length, 1, 'update 42 was not answered twice');
  assert.equal(s.store.setting('telegram_offset'), '44');
});
