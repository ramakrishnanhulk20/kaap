// The two pure pieces behind the try-it button's bounds: one caller's share of presses, and the
// deadline on a filing. Run with `npm test` in packages/web (Node 24 reads the .ts files directly).
// Not covered: the routes themselves, the chain reads behind the daily count, and which address a
// host's proxy reports for a caller; those are checked against a running site.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { withDeadline } from '../lib/deadline.ts';
import { DAY_MS, press, PRESSES_A_DAY, WINDOW_MS } from '../lib/presses.ts';

const MINUTE = 60_000;

test('one caller pressing every five minutes for a day gets six presses, not the 288 the ten-minute limit alone allows', () => {
  const recent = new Map();
  const answers = [];
  for (let at = 0; at < DAY_MS; at += 5 * MINUTE) answers.push(press(recent, 'one-address', 1_000_000 + at));
  assert.equal(answers.filter((a) => a === 'yes').length, PRESSES_A_DAY);
  assert.equal(PRESSES_A_DAY * 6 < 40, true, 'six callers at their limit still leave room in the 40 a day');
  assert.deepEqual(answers.slice(0, 4), ['yes', 'yes', 'yes', 'yes'], 'every five minutes is one press per ten-minute window twice over');
  assert.equal(answers.at(-1), 'day_used');
});

test('a third press inside ten minutes is told to slow down and is not counted', () => {
  const recent = new Map();
  assert.deepEqual([press(recent, 'a', 0), press(recent, 'a', 1_000), press(recent, 'a', 2_000), press(recent, 'a', 3_000)], ['yes', 'yes', 'slow_down', 'slow_down']);
  assert.equal(recent.get('a').length, 2, 'refused presses do not use up the day');
  assert.equal(press(recent, 'a', WINDOW_MS + 1_000), 'yes', 'the window moves on');
  assert.equal(press(recent, 'b', 2_500), 'yes', 'another caller has its own count');
});

test('the day is a moving 24 hours: a press comes back as the oldest one ages out', () => {
  const recent = new Map();
  const times = [0, 11, 22, 33, 44, 55].map((m) => m * MINUTE);
  for (const at of times) assert.equal(press(recent, 'a', at), 'yes');
  assert.equal(press(recent, 'a', 70 * MINUTE), 'day_used');
  assert.equal(press(recent, 'a', DAY_MS - 1), 'day_used');
  assert.equal(press(recent, 'a', DAY_MS + 1), 'yes', 'the first press is now older than a day');
  assert.equal(press(recent, 'a', DAY_MS + 2), 'day_used');
});

test('a filing that does not answer is given up on at its deadline, and one that answers in time is passed on', async () => {
  const never = new Promise(() => {});
  const started = Date.now();
  await assert.rejects(withDeadline(never, 60), /deadline/);
  assert.ok(Date.now() - started < 1_000, 'the wait ends at the deadline, not when the work does');
  assert.equal(await withDeadline(Promise.resolve('filed'), 60), 'filed');
  await assert.rejects(withDeadline(Promise.reject(new Error('refused')), 60), /refused/);
  // Work that finishes after its deadline changes nothing and throws nowhere.
  let finish;
  const late = new Promise((resolve) => (finish = resolve));
  await assert.rejects(withDeadline(late, 20), /deadline/);
  finish('too late');
  await new Promise((resolve) => setTimeout(resolve, 20));
});
