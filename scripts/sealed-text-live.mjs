#!/usr/bin/env node
// The sealed text channel, end to end, through the hosted watcher (C6, C26).
//
//   1. The demo member files a sign request on the demo treasury that shows only a hash.
//   2. The watcher judges it by itself. It cannot read a hash, so the verdict says
//      HASH_UNVERIFIED and the guard does not vote.
//   3. The words behind the hash are handed to the watcher with `kaap seal-text`, encrypted here
//      so that only the sealed reader can open them.
//   4. The sealed reader checks the words produce that hash, reads them, and signs a new verdict.
//      The words add a key with full control of the treasury's NEAR Intents balance, so the guard
//      votes to reject.
//
// Exit code 0 only when the request was judged and left open before the words were sent, the
// verdict after them names HASH_TEXT_DANGEROUS, and the request ends Rejected by the guard's vote
// alone.
//
//   node scripts/sealed-text-live.mjs [--watcher <https address>]
//     Testnet, inside WSL, after `npm run build:ts -w packages/cli`. Signs one transaction as the
//     demo member, whose key is read from ~/.near-credentials/testnet and never printed. Without an
//     address it uses the watcher named in deployments/testnet.json.
//   node scripts/sealed-text-live.mjs --leave-open
//     Files the hash-only request, waits for the watcher to judge it with no words, and stops
//     there: the words are never handed over, so the request stays open and unread, as a
//     standing example of what a treasury in the default mode sees. Exit code 0 when the watcher
//     left it alone.
//   node scripts/sealed-text-live.mjs --resume <request id> <text.json>
//     Takes up a request this script filed earlier, from the words it saved, and files nothing.
//     For when the sealed reader's host was too slow the first time: a sealed run that OutLayer
//     does not answer inside its window is asked again by the watcher, which can take minutes.
//
// The words are made up here: a new key that nobody holds. They are no secret, and they are
// written to ~/kaap-texts (or KAAP_TEXTS_DIR), never into the repository and not to the system's
// temporary folder, which can be emptied before a slow run is taken up again. The watcher pays for
// two sealed runs.
// It takes three texts an hour from one address and five text runs a day for one treasury.
//
// Not covered: a text that does not match the hash, a tampered ciphertext and a wrong reply key,
// which scripts/text-roundtrip.mjs attacks against the sealed reader directly; and who can read
// the explanation, which is encrypted to a key made for the one request.

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { REPO, TGAS, accountFor, baseEncode, blockAt, call, loadState, refusal, returned, sleep, txLink, viewFinal } from './setup-demo-dao.mjs';

const MPC = 'v1.signer-prod.testnet';
const DESCRIPTION = 'Authenticate DAO for confidential intents';
const NEP413_TAG = 2 ** 31 + 413;
const CLI = join(REPO, 'packages', 'cli', 'dist', 'src', 'bin.js');

const state = loadState();
const dao = state.dao.account_id;
const guard = state.guard.account_id;
const memberId = state.dao.member.account_id;
const flag = (name) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv.slice(at + 1);
};
const watcher = flag('--watcher')?.[0] ?? state.watcher?.url;
const resume = flag('--resume');
const leaveOpen = flag('--leave-open') !== undefined;
if (typeof watcher !== 'string' || !/^https:\/\/[a-z0-9.-]+$/i.test(watcher)) {
  console.error("give the watcher's address, such as https://watcher.example.org");
  process.exit(2);
}

const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const borshString = (s) => {
  const bytes = Buffer.from(s, 'utf8');
  return Buffer.concat([u32(bytes.length), bytes]);
};
/** NEP-413's hash, written here apart from kaap-core: the command line computes it again with
 *  kaap-core before it seals anything, so the two must agree for the words to be sent at all. */
const nep413Hash = (message, nonce, recipient) =>
  createHash('sha256').update(Buffer.concat([u32(NEP413_TAG), borshString(message), nonce, borshString(recipient), Buffer.from([0])])).digest('hex');

/** What the watcher holds on the request: its state, the verdict's findings and the vote. */
async function seenByWatcher(id) {
  try {
    const res = await fetch(`${watcher}/proposal?dao=${dao}&id=${id}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const j = await res.json();
    return { state: j.state, findings: j.verdict?.findings ?? [], risk: j.verdict?.risk ?? null, hash: j.verdict?.verdict_hash ?? null, veto: j.veto };
  } catch {
    return null;
  }
}

async function until(what, ms, check) {
  const end = Date.now() + ms;
  for (;;) {
    const got = await check();
    if (got) return got;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(3_000);
  }
}

async function main() {
  console.log(`Kaap sealed text, live, ${new Date().toISOString()}: ${memberId} files a hash-only request on ${dao}; watcher ${watcher}`);
  let id;
  let file;
  let filedMs;
  if (resume) {
    id = Number(resume[0]);
    file = resume[1];
    if (!Number.isSafeInteger(id) || !file) throw new Error('--resume needs a request id and the saved text file');
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    const p = await viewFinal(dao, 'get_proposal', { id });
    const asked = JSON.parse(Buffer.from(p.kind?.FunctionCall?.actions?.[0]?.args ?? '', 'base64').toString('utf8') || '{}').request?.payload_v2?.Eddsa;
    if (asked !== nep413Hash(saved.message, Buffer.from(saved.nonce, 'base64'), saved.recipient)) throw new Error(`the words in ${file} are not the ones behind request #${id}`);
    filedMs = Number(BigInt(p.submission_time) / 1_000_000n);
    console.log(`1. taking up request #${id} again, filed ${new Date(filedMs).toISOString()}, with the words saved in ${file}`);
  } else {
    const member = accountFor(memberId);
    const plantedKey = `ed25519:${baseEncode(randomBytes(32))}`;
    const deadline = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    const message = JSON.stringify({ signer_id: dao, deadline, intents: [{ intent: 'add_public_key', public_key: plantedKey }] });
    const nonce = randomBytes(32);
    const recipient = 'intents.near';
    const payload = nep413Hash(message, nonce, recipient);
    // Saved before anything is filed, so a run that stops half way can be taken up again.
    const kept = process.env.KAAP_TEXTS_DIR || join(homedir(), 'kaap-texts');
    mkdirSync(kept, { recursive: true });
    file = join(mkdtempSync(join(kept, 'text-')), 'text.json');
    writeFileSync(file, JSON.stringify({ message, nonce: nonce.toString('base64'), recipient, standard: 'nep413' }));

    const args = { request: { path: dao, payload_v2: { Eddsa: payload }, domain_id: 1 } };
    const kind = { FunctionCall: { receiver_id: MPC, actions: [{ method_name: 'sign', args: Buffer.from(JSON.stringify(args)).toString('base64'), deposit: '1', gas: (15n * TGAS).toString() }] } };
    const bond = BigInt((await viewFinal(dao, 'get_policy')).proposal_bond);
    const filed = await call(member, dao, 'add_proposal', { proposal: { description: DESCRIPTION, kind } }, 30n * TGAS, bond);
    if (filed.failure) throw new Error(`add_proposal failed in ${filed.hash}: ${refusal(filed.failure)}`);
    id = returned(filed.outcome);
    filedMs = (await blockAt(filed.outcome.receipts_outcome.find((r) => r.outcome.executor_id === dao).block_hash)).ms;
    console.log(`1. filed request #${id}: "${DESCRIPTION}", showing only the hash ${payload}: ${txLink(filed.hash)}`);
    console.log(`   the words behind the hash are saved in ${file} (to take this up again: --resume ${id} ${file})`);
  }

  const blind = await until('the watcher to judge the request by itself', 900_000, async () => {
    const seen = await seenByWatcher(id);
    return seen?.state === 'judged' && seen.veto !== 'none' ? seen : null;
  });
  const open = (await viewFinal(dao, 'get_proposal', { id })).status;
  console.log(`2. the watcher judged it with no words: risk ${blind.risk}, findings ${blind.findings.join(', ')}, vote ${blind.veto}; the request is ${open}`);
  const leftAlone = blind.findings.includes('HASH_UNVERIFIED') && blind.veto === 'not_needed' && open === 'InProgress';
  if (leaveOpen) {
    console.log(leftAlone ? `RESULT: pass, request #${id} is unreadable, was left alone, and stays open: its words were handed to nobody` : `RESULT: FAIL (request #${id} was not left alone)`);
    process.exit(leftAlone ? 0 : 1);
  }

  console.log(`3. handing the words to the watcher, sealed: kaap seal-text --dao ${dao} --id ${id} --file <text.json> --worker ${watcher}`);
  const sentAt = Date.now();
  const sealed = spawnSync(process.execPath, [CLI, 'seal-text', '--dao', dao, '--id', String(id), '--file', file, '--worker', watcher], { encoding: 'utf8', timeout: 600_000 });
  console.log(((sealed.stdout || '') + (sealed.stderr || '')).trimEnd().split('\n').map((l) => `   | ${l}`).join('\n'));
  if (sealed.status !== 0) throw new Error(`kaap seal-text ended with exit code ${sealed.status}`);
  const named = /findings: .*HASH_TEXT_DANGEROUS/.test(sealed.stdout) && /veto: started/.test(sealed.stdout);

  const ended = await until("the guard's vote", 300_000, async () => {
    const p = await viewFinal(dao, 'get_proposal', { id });
    return p.status === 'InProgress' ? null : p;
  });
  const votes = Object.entries(ended.votes ?? {});
  const byGuardAlone = ended.status === 'Rejected' && votes.length === 1 && votes[0][0] === guard && votes[0][1] === 'Reject';
  const after = await seenByWatcher(id);
  console.log(`4. request #${id} is ${ended.status}, seen ${((Date.now() - sentAt) / 1000).toFixed(1)} s after the words were sent and ${((Date.now() - filedMs) / 1000).toFixed(1)} s after the filing block; votes: {${votes.map(([who, v]) => `${who}: ${v}`).join(', ')}}`);
  if (after) console.log(`   the watcher now holds: risk ${after.risk}, findings ${after.findings.join(', ')}, vote ${after.veto}, verdict ${after.hash}`);
  const replaced = after !== null && after.hash !== blind.hash;

  const ok = leftAlone && named && byGuardAlone && replaced;
  console.log(ok ? 'RESULT: pass, unreadable and left alone without the words, read and rejected by the guard alone with them' : `RESULT: FAIL (left alone ${leftAlone}, dangerous text named ${named}, rejected by the guard alone ${byGuardAlone}, new verdict ${replaced})`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(`FAILED: ${e?.message ?? e}`);
  process.exit(1);
});
