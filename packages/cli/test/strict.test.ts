// Strict mode and an announced change of the guard's key, as the command line shows them (C8,
// C19): `enroll --strict` drafts, the mode in `arming` and `check`, and the warning line in `arming`
// and `verify`. The recordings are of guards deployed before either feature, so they answer the two
// newer views with "no such method", which is what both providers gave live on 12 Nov. Each test
// that needs a later guard has both providers answer the view the way that guard's code does
// (`packages/contracts/guard`: `veto_unreadable` is true or false, `pending_key` is null or a key
// and a time). The hash-only request is the 11 Nov demo DAO's request #7, recorded live on 12 Nov.
//
// Not covered: a live guard that has these views (none is deployed yet), the guard's own rule (its
// contract tests), and the worker, which reads the same views for itself.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Core } from '../src/core.js';
import { main } from '../src/main.js';
import type { HttpRequest } from '../src/net.js';
import { NETWORKS } from '../src/rpc.js';
import { answering, fakeClock, load, type MissingView, NO_SUCH_METHOD, RECORDED_ROOT, replay, REPO_ROOT, UNKNOWN_TODAY } from './replay.js';

const GUARD_1029 = 'kaap-guard-1029061211.testnet';
const GUARD = 'kaap-guard-1111072803.testnet';
const DAO = 'kaap-dao-1111072928.testnet';
const NB_DAO = 'kaap-nb-1102140303.sputnikv2.testnet';
const NEW_KEY = 'ed25519:4gaYx4kPxaNDc5grjrucuJfxV97gNiAr8TuCwUAuonuN';
/** `{"veto_unreadable":true}` in base64, the strict enrolment call's arguments. */
const STRICT_ARGS = 'eyJ2ZXRvX3VucmVhZGFibGUiOnRydWV9';

type Edit = (r: HttpRequest, text: string) => string;

async function run(fixture: string, extra: string[] = [], views: MissingView[] = [], edit?: Edit) {
  const fx = load(`${fixture}.json`);
  const out: string[] = [];
  const err: string[] = [];
  const code = await main([...fx.argv, ...extra], { transport: answering(replay(fx, [], edit), fx, [...views, ...UNKNOWN_TODAY]), clock: fakeClock(), loadCore: () => Core.load(), repoRoot: RECORDED_ROOT }, { out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const params = (r: HttpRequest) => (JSON.parse(r.body ?? '{}') as { params?: { account_id?: string; method_name?: string } }).params;

/** Rewrites what a recorded view answered, on the providers named (both when none is). */
function answer(account: string, method: string, value: unknown, only?: string): Edit {
  return (r, text) => {
    const p = params(r);
    if (p?.account_id !== account || p.method_name !== method || (only !== undefined && r.url !== only)) return text;
    const recorded = JSON.parse(text) as { result: Record<string, unknown> };
    const { error: _error, ...rest } = recorded.result;
    return JSON.stringify({ ...recorded, result: { ...rest, result: [...Buffer.from(JSON.stringify(value), 'utf8')] } });
  };
}

const callArgs = (out: string) => {
  const line = out.split('\n').filter((l) => l.trim().startsWith('{"proposal"')).at(-1) ?? '{}';
  const kind = (JSON.parse(line.trim()) as { proposal?: { kind?: { FunctionCall?: { receiver_id: string; actions: { method_name: string; args: string; deposit: string; gas: string }[] } } } }).proposal?.kind?.FunctionCall;
  return kind;
};

test('enroll --strict asks the guard for strict mode in the enrolment call, and changes nothing else in the drafts', async () => {
  const later = [{ account: GUARD, method: 'veto_unreadable', value: false }];
  const plain = await run('enroll-nb', [], later);
  const strict = await run('enroll-nb', ['--strict'], later);
  assert.equal(plain.code, 0, plain.err);
  assert.equal(strict.code, 0, strict.err);
  assert.deepEqual(callArgs(plain.out)?.actions, [{ args: 'e30=', deposit: '10000000000000000000000', gas: '10000000000000', method_name: 'enroll' }]);
  assert.deepEqual(callArgs(strict.out)?.actions, [{ args: STRICT_ARGS, deposit: '10000000000000000000000', gas: '10000000000000', method_name: 'enroll' }]);
  assert.equal(callArgs(strict.out)?.receiver_id, GUARD);
  assert.match(strict.out, /^mode asked for: strict: the guard will also reject any request of this DAO whose signed hash Kaap has not read$/m);
  assert.doesNotMatch(plain.out, /strict/);

  // Apart from the note, the call's arguments and what Kaap's decoder says of them, the two
  // outputs are the same text.
  const IN_STRICT = ', in strict mode: the guard will also reject any request whose signed hash Kaap has not read';
  const same = (out: string) => out.split('\n').filter((l) => !l.startsWith('mode asked for: ')).join('\n').replaceAll(STRICT_ARGS, 'e30=').replace(IN_STRICT, '');
  assert.equal(same(strict.out), same(plain.out));

  // Kaap's own decoder reads the strict call as its own enrolment too, with nothing to warn about.
  const call = strict.out.split(/^proposal \d of 2: /m)[2] ?? '';
  assert.ok(call.split('\n').includes(`    guard_enrol: enrols this DAO in Kaap's guard ${GUARD}, attaching 0.01 NEAR${IN_STRICT}`), call);
  assert.match(call, /^ {4}findings: none$/m);
});

test('enroll --strict stops at a guard built before strict mode, which would enrol the DAO in default mode all the same', async () => {
  const { code, out, err } = await run('enroll-nb', ['--strict']);
  assert.equal(code, 3);
  assert.equal(out, '');
  assert.match(err, new RegExp(`^Kaap's guard ${GUARD.replaceAll('.', '\\.')} was built before strict mode: it would enrol ${NB_DAO.replaceAll('.', '\\.')} in default mode whatever the call says\\.`));
  assert.equal((await run('enroll-nb')).code, 0, 'without the flag the same guard drafts as before');
});

test('enroll --strict on a DAO that is already enrolled says how the mode is switched, since it enrols only once', async () => {
  const inDefault = await run('enroll-1029', ['--strict'], [{ account: GUARD_1029, method: 'veto_unreadable', value: false }]);
  assert.equal(inDefault.code, 0, inDefault.err);
  assert.match(inDefault.out, /^strict mode: this DAO is enrolled in default mode, and it enrols only once\. To switch strict mode on, it files a FunctionCall proposal to kaap-guard-1029061211\.testnet: method set_veto_unreadable, arguments \{"on":true\}, no deposit$/m);
  assert.match(inDefault.out, /^nothing to file: /m);
  const alreadyOn = await run('enroll-1029', ['--strict'], [{ account: GUARD_1029, method: 'veto_unreadable', value: true }]);
  assert.match(alreadyOn.out, /^strict mode is already on for this DAO$/m);
});

test('arming prints the mode the DAO chose: strict, default, or a guard that has no strict mode', async () => {
  const mode = async (views: MissingView[]) => {
    const { code, out, err } = await run('arming-1111', [], views);
    assert.equal(code, 0, err);
    return out.split('\n').filter((l) => l.startsWith('mode in the guard: '));
  };
  assert.deepEqual(await mode([{ account: GUARD, method: 'veto_unreadable', args: { dao: DAO }, value: true }]), ['mode in the guard: strict: the guard also rejects a request of this DAO whose signed hash Kaap has not read']);
  assert.deepEqual(await mode([{ account: GUARD, method: 'veto_unreadable', args: { dao: DAO }, value: false }]), ['mode in the guard: default: a request whose signed hash Kaap has not read alerts the members and is not rejected']);
  assert.deepEqual(await mode([]), ['mode in the guard: this guard has no strict mode: a request whose signed hash Kaap has not read alerts the members and is not rejected']);
});

test('arming holds when the guard answers the mode with anything but true or false', async () => {
  const { code, out, err } = await run('arming-1111', [], [{ account: GUARD, method: 'veto_unreadable', value: 'yes' }]);
  assert.equal(code, 4);
  assert.equal(out, '');
  assert.match(err, /^held, no result: kaap-guard-1111072803\.testnet's veto_unreadable answer is not true or false$/);
});

test('arming and verify warn about an announced key change, with its time against the block read, and say nothing when there is none', async () => {
  const inFuture = [{ account: GUARD, method: 'pending_key', value: { key: NEW_KEY, effective_at_ms: 4_102_444_800_000 } }];
  const warning = /^warning: the guard's owner has announced a new accepted key, ed25519:4gaYx4kPxaNDc5grjrucuJfxV97gNiAr8TuCwUAuonuN\. It can take effect from 2100-01-01 00:00 UTC, in about \d+ hours\. Until it does, every verdict is still checked against the current key\.$/m;
  for (const fixture of ['arming-1111', 'verify-1111-3']) {
    const quiet = await run(fixture);
    const none = await run(fixture, [], [{ account: GUARD, method: 'pending_key', value: null }]);
    const announced = await run(fixture, [], inFuture);
    assert.equal(announced.code, quiet.code, `${fixture}: a warning changes no exit code`);
    assert.match(announced.out, warning, fixture);
    for (const r of [quiet, none]) assert.doesNotMatch(r.out, /warning: /, `${fixture}: no key change, no line`);
    // With the warning taken out, the output is the one with no key change.
    assert.equal(announced.out.split('\n').filter((l) => !l.startsWith('warning: ')).join('\n'), none.out, fixture);
  }

  const ended = await run('arming-1111', [], [{ account: GUARD, method: 'pending_key', value: { key: NEW_KEY, effective_at_ms: 1 } }]);
  assert.match(ended.out, /^warning: the guard's owner has announced a new accepted key, ed25519:\w+\. Its wait ended at 1970-01-01 00:00 UTC, so anyone can make it take effect at any moment\. Until it does, /m);
});

test('a key change that cannot be read is said to be unread, never passed over in silence', async () => {
  for (const value of [{ key: 'ed25519:short', effective_at_ms: 4_102_444_800_000 }, { key: NEW_KEY }, 'soon', { key: NEW_KEY, effective_at_ms: 1.5 }]) {
    const { code, out } = await run('arming-1111', [], [{ account: GUARD, method: 'pending_key', value }]);
    assert.equal(code, 0);
    assert.match(out, /^warning: whether a change of the guard's accepted key has been announced could not be read \(kaap-guard-1111072803\.testnet's pending_key answer is not a key and a time\)$/m, JSON.stringify(value));
    assert.match(out, /^armed: yes\./m, 'the arming answer still prints');
  }
});

test('check shows a hash-only request as one the guard rejects only where the DAO chose strict mode (C8)', async () => {
  const asRecorded = await run('check-1111-7');
  assert.equal(asRecorded.code, 0, asRecorded.err);
  assert.match(asRecorded.out, /^ {2}HASH_UNVERIFIED\s+unknown$/m);
  assert.match(asRecorded.out, /^mode in the guard: this guard has no strict mode: /m);
  assert.match(asRecorded.out, /^must_veto: false\nveto_allowed: false$/m);
  assert.doesNotMatch(asRecorded.out, /^strict mode: /m);

  const inDefault = await run('check-1111-7', [], [], answer(GUARD, 'veto_unreadable', false));
  assert.match(inDefault.out, /^mode in the guard: default: /m);
  assert.match(inDefault.out, /^must_veto: false\nveto_allowed: false$/m);
  assert.doesNotMatch(inDefault.out, /^strict mode: /m);

  const strict = await run('check-1111-7', [], [], answer(GUARD, 'veto_unreadable', true));
  assert.equal(strict.code, 0, strict.err);
  assert.match(strict.out, /^mode in the guard: strict: /m);
  assert.match(strict.out, /^veto_allowed: true\nstrict mode: this DAO chose to have Kaap's guard reject any request whose signed hash is unread, so the guard will reject this one once the sealed program has judged it$/m);
  // The mode changes the two veto lines and adds its own; every other line is the same.
  const rest = (out: string) => out.split('\n').filter((l) => !/^(mode in the guard|must_veto|veto_allowed|strict mode): /.test(l)).join('\n');
  assert.equal(rest(strict.out), rest(inDefault.out));

  const json = await run('check-1111-7', ['--json'], [], answer(GUARD, 'veto_unreadable', true));
  const report = JSON.parse(json.out) as { guard_mode: string; analysis: { veto_allowed: boolean } };
  assert.deepEqual([report.guard_mode, report.analysis.veto_allowed], ['strict', true]);
});

test('one provider saying strict, or saying the guard has no such view, while the other disagrees, holds the check', async () => {
  const { primary, secondary } = NETWORKS.testnet;
  for (const only of [primary, secondary]) {
    const { code, out, err } = await run('check-1111-7', [], [], answer(GUARD, 'veto_unreadable', true, only));
    assert.equal(code, 4, `${only}: ${out}`);
    assert.equal(out, '');
    assert.match(err, /^held, no result: the two providers disagree on the mode kaap-dao-1111072928\.testnet chose in kaap-guard-1111072803\.testnet$/);
  }
  assert.ok(load('check-1111-7.json').exchanges.some((e) => e.text.includes(NO_SUCH_METHOD)), 'the recording holds the old guard answering that it has no such view');
});
