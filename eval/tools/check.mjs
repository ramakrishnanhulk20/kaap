// Checks every label in the public answer key (eval/real/labels.jsonl, 300 records, and
// eval/planted/labels.jsonl, 73 records) against labelling guide v2.3 (docs/eval/labeling-guide.md).
// It shares no code with Kaap: every rule is re-derived here from the raw proposal kind and its
// context, so a label that slipped past the labeller is caught by a second, independent reading.
// Each problem prints the record id and the guide section of the rule it breaks; exit 0 only when
// every rule holds.
//
// Usage: node eval/tools/check.mjs [--eval <dir>]
//   --eval points it at a copy of the eval/ folder, for example one with a label broken on purpose.
//
// What it does not prove. For policy kinds it re-derives the effect and every policy finding from
// the raw kind and the policy before. For the other kinds it checks each effect's shape and the
// findings that follow mechanically from the kind or the effects, but not that the effect list is
// complete or that its amounts and payees match the kind. It does not re-derive NEW_RECIPIENT,
// LARGE_AMOUNT, LOOKALIKE_TOKEN, PROMPT_INJECTION, INTENTS_KEY_CHANGE, OTHER_RISKY_KIND,
// HASH_UNVERIFIED, HASH_TEXT_DANGEROUS or UNKNOWN_CALL, nor the choice between matches, vague and
// hidden; their severities, and the floor and veto fields they lead to, are still checked.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs, readJsonl } from "./lib/files.mjs";
import { POLICY_KINDS, kindOf, policyAfter } from "./lib/policy.mjs";
import { dollars } from "./lib/prices.mjs";

const { evalDir } = parseArgs(process.argv.slice(2));

const TABLE = {
  HASH_MISMATCH: "critical", HASH_TEXT_DANGEROUS: "critical", POLICY_DUPLICATE_ROLE_NAMES: "critical", PROMPT_INJECTION: "critical",
  DESC_CONTRADICTS: "critical or high", POLICY_ADDS_APPROVER: "high", POLICY_LOWERS_THRESHOLD: "high", POLICY_REPLACES_ROLE: "high",
  POLICY_REMOVES_MEMBER: "high", POLICY_BEFORE_UNKNOWN: "high", CODE_UPGRADE: "high", INTENTS_KEY_CHANGE: "high", GUARD_WEAKENED: "high",
  UNKNOWN_CALL: "high", ARGS_NOT_JSON: "high", UNKNOWN_VALUE: "high", LOOKALIKE_TOKEN: "high", OTHER_RISKY_KIND: "high",
  HASH_UNVERIFIED: "unknown", ATTACHED_DEPOSIT: "medium", CROSS_CHAIN_OUT: "medium", NEW_RECIPIENT: "medium", LARGE_AMOUNT: "medium",
  EMPTY_DESCRIPTION: "low",
};
const EFFECT_FIELDS = {
  transfer: ["token", "amount", "to"],
  token_call_transfer: ["token", "amount", "to", "msg_kind"],
  intents_withdraw: ["token", "amount", "chain", "address"],
  intents_transfer: ["token", "amount", "to"],
  intents_key_change: ["op", "public_key"],
  wrap: ["op", "amount"],
  staking: ["pool", "op", "amount"],
  storage_deposit: ["contract", "for_account", "amount"],
  defi_call: ["protocol", "method", "summary"],
  bulk_payment: ["contract", "list_id", "total"],
  sign_request: ["mpc", "path", "domain_id", "payload_hash", "text_supplied", "text_source", "text_standard"],
  policy_change: ["roles_added", "roles_removed", "members_added", "members_removed", "permissions_changed", "vote_policy_changed", "bond_or_period_changed", "before_unknown"],
  config_change: ["name", "purpose_changed", "metadata_changed"],
  code_upgrade: ["target", "code_hash"],
  other_kind: ["kind", "summary"],
  unknown_call: ["receiver", "method", "args", "deposit"],
};
const RECORD_KEYS = ["id", "source", "network", "dao", "proposal_id", "status", "description", "kind", "context", "is_test", "label", "guide_version", "labelled_by", "second_label"];
const LABEL_KEYS = ["effects", "findings", "risk_floor", "description_check", "must_veto", "veto_allowed", "should_veto", "notes"];
const MOVES_VALUE = ["transfer", "token_call_transfer", "intents_withdraw", "intents_transfer", "bulk_payment"];
const TEST_WORDS = ["test", "staging", "qa", "demo", "sandbox", "audit", "trial", "dummy", "playground"];
const LEVEL = { low: 0, medium: 1, high: 2, critical: 3 };
// Built from the code point so this file never holds the character it looks for. A label may carry
// it as the character or as the six-character JSON escape, so both are checked.
const EM_DASH = String.fromCharCode(0x2014);
const EM_DASH_ESCAPED = "\\" + "u" + (0x2014).toString(16);
// Every Sputnik 3.2 proposal kind label, as used in permissions such as "transfer:VoteApprove".
const KINDS = ["config", "policy", "add_member_to_role", "remove_member_from_role", "call", "upgrade_self", "upgrade_remote", "transfer", "set_vote_token", "add_bounty", "bounty_done", "vote", "factory_info_update", "policy_add_or_update_role", "policy_remove_role", "policy_update_default_vote_policy", "policy_update_parameters"];
const DEFI_ACCOUNTS = ["contract.main.burrow.near", "v2.ref-finance.near", "dclv2.ref-labs.near"];

const problems = [];
const bad = (id, rule, msg) => problems.push({ id, line: `${id} [${rule}] ${msg}` });

const isWhole = (v) => typeof v === "string" && /^[0-9]+$/.test(v);
function argsOf(b64) {
  const bytes = Buffer.from(b64 || "", "base64");
  if (bytes.length === 0) return "empty";
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return "not_json"; }
  try { JSON.parse(text); return "json"; } catch { return "not_json"; }
}
const argsJson = (b64) => { try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(b64 || "", "base64"))); } catch { return null; } };

// NEP-413: sha256(u32le(2^31+413) ++ borsh(message) ++ nonce ++ borsh(recipient) ++ no callback).
function borshString(s) { const b = Buffer.from(s, "utf8"); const n = Buffer.alloc(4); n.writeUInt32LE(b.length); return Buffer.concat([n, b]); }
function nep413(t) {
  const tag = Buffer.alloc(4); tag.writeUInt32LE(2 ** 31 + 413);
  return crypto.createHash("sha256").update(Buffer.concat([tag, borshString(t.message), Buffer.from(t.nonce, "base64"), borshString(t.recipient), Buffer.from([0])])).digest("hex");
}
// A NEP-461 delegate action printed in a description: sha256(u32le(2^30+366) ++ bytes).
function nep461FromDescription(desc) {
  const m = desc.match(/"kind":"delegate_action","bytes":"([A-Za-z0-9+/=]+)"/);
  if (!m) return null;
  const tag = Buffer.alloc(4); tag.writeUInt32LE(2 ** 30 + 366);
  return crypto.createHash("sha256").update(Buffer.concat([tag, Buffer.from(m[1], "base64")])).digest("hex");
}
// The payload a sign call asks the MPC signer to sign, read from the kind itself.
function signedPayload(fc) {
  const a = fc && fc.actions.find((x) => x.method_name === "sign");
  const req = a && argsJson(a.args) && argsJson(a.args).request;
  const p = req && (req.payload_v2 || req.payload);
  return p && typeof p === "object" ? Object.values(p)[0] : typeof p === "string" ? p : null;
}

const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, x]) => [k, sortKeys(x)])) : v);
const js = (v) => JSON.stringify(sortKeys(v));
const roleMembers = (p, name) => { const out = new Set(); for (const r of p.roles) if (r.name === name && r.kind && r.kind.Group) for (const m of r.kind.Group) out.add(m); return out; };
const roleNames = (p) => [...new Set(p.roles.map((r) => r.name))];
const canApprove = (perms, kind) => perms.some((s) => { const [k, act] = s.split(":"); return (k === "*" || k === kind) && (act === "*" || act === "VoteApprove"); });
const roleApproves = (x) => KINDS.some((k) => canApprove(x.permissions || [], k));
// Votes needed for `n` members: the larger of the quorum and the threshold, where a ratio
// threshold [a, b] means more than a/b of the group.
const need = (vp, n) => {
  const q = Number(vp.quorum || 0);
  const t = Array.isArray(vp.threshold) ? Math.min(n, Math.floor((vp.threshold[0] * n) / vp.threshold[1]) + 1) : Number(vp.threshold);
  return Math.max(q, t);
};

// A second, separate reading of the replaced-role and removed-member rules, with its own approve
// test (the action after the colon), so a slip in the per-kind test above cannot hide one here.
const approves = (role) => (role.permissions || []).some((p) => ["VoteApprove", "*"].includes(String(p).split(":")[1]));
const groupOf = (role) => (role.kind && Array.isArray(role.kind.Group) ? role.kind.Group : null);
// Approving roles whose members after the change are not all members before. Same-name roles are
// pooled because Sputnik counts votes per role name. Roles without a member list are not compared.
function replacedApprovingRoles(before, after) {
  const out = [];
  for (const name of new Set(after.roles.map((x) => x.name))) {
    const b = before.roles.filter((x) => x.name === name), a = after.roles.filter((x) => x.name === name);
    if (!b.length || ![...a, ...b].some(approves) || [...a, ...b].some((x) => !groupOf(x))) continue;
    const old = new Set(b.flatMap(groupOf));
    if (a.flatMap(groupOf).some((m) => !old.has(m))) out.push(name);
  }
  return out;
}
// Members of a role before that are not in the role of that name after (pooled by name; a role the
// replacement leaves out drops all its members). Roles without a member list are not compared.
function droppedFromRoles(before, after) {
  const out = [];
  for (const name of new Set(before.roles.map((x) => x.name))) {
    const b = before.roles.filter((x) => x.name === name), a = after.roles.filter((x) => x.name === name);
    if ([...a, ...b].some((x) => !groupOf(x))) continue;
    const now = new Set(a.flatMap(groupOf));
    for (const m of new Set(b.flatMap(groupOf))) if (!now.has(m)) out.push(`${m} from ${name}`);
  }
  return out;
}

function readLabelFile(rel, source, expected) {
  const rule = "section 8, record format";
  const text = fs.readFileSync(path.join(evalDir, rel), "utf8");
  if (text.charCodeAt(0) === 0xfeff) bad(rel, rule, "starts with a byte-order mark");
  if (!text.endsWith("\n")) bad(rel, rule, "does not end with a newline");
  if (text.includes(EM_DASH)) bad(rel, rule, "contains a literal em-dash");
  const lines = text.split("\n").filter((l) => l.length);
  if (lines.length !== expected) bad(rel, rule, `has ${lines.length} records, expected ${expected}`);
  const recs = [];
  for (const [i, line] of lines.entries()) {
    try { recs.push(JSON.parse(line)); } catch { bad(rel, rule, `line ${i + 1} is not JSON`); }
  }
  if (new Set(recs.map((r) => r.id)).size !== recs.length) bad(rel, rule, "duplicate ids");
  for (const r of recs) if (r.source !== source) bad(r.id, rule, `source ${r.source} in the ${source} file`);
  for (let i = 1; i < recs.length; i++) if (!(recs[i - 1].id < recs[i].id)) bad(rel, rule, `not sorted by id at ${recs[i].id}`);
  return recs;
}

const real = readLabelFile("real/labels.jsonl", "real", 300);
const planted = readLabelFile("planted/labels.jsonl", "planted", 73);
const sampleOf = new Map(readJsonl(evalDir, "real/sample.jsonl").map((r) => [r.id, r]));
const plantedOf = new Map(readJsonl(evalDir, "planted/planted.jsonl").map((r) => [r.id, r]));
// Who made each first label: the three real shards and the planted file. A record whose labeller
// differs was labelled again after the 26 Oct chain re-read (eval/RECONCILE.md), and its note must
// say why.
const firstLabeller = new Map();
for (const f of ["real/labels-shard-1.jsonl", "real/labels-shard-2.jsonl", "real/labels-shard-3.jsonl", "planted/planted.jsonl"]) for (const r of readJsonl(evalDir, f)) firstLabeller.set(r.id, r.labelled_by);

// Guide sections 3, 4 and 7: the policy effect and the policy findings, re-derived from the raw
// kind and the policy before.
function checkPolicy(r, L, eff, codes, kind, body) {
  const id = r.id;
  const before = r.context.policy_before;
  if (!before) return;
  const after = policyAfter(kind, body, before);
  const pc = eff.find((e) => e.type === "policy_change");
  if (!pc) return;
  // Section 3: `approver` comes from the policy the member is in, after the change for an added
  // member and before it for a removed one.
  for (const e of eff.filter((x) => x.type === "policy_change")) for (const [f, policy] of [["members_added", after], ["members_removed", before]]) for (const m of e[f] || []) {
    if (Object.keys(m).join(",") !== "role,member,approver") bad(id, "section 3, policy_change approver", `${f} entry ${m.member} has keys ${Object.keys(m).join(",")}`);
    const wantA = policy.roles.filter((x) => x.name === m.role).some(roleApproves);
    if (m.approver !== wantA) bad(id, "section 3, policy_change approver", `${f} ${m.member} in ${m.role}: approver ${m.approver}, the policy ${f === "members_added" ? "after" : "before"} gives ${wantA}`);
  }
  const want = { roles_added: [], roles_removed: [], members_added: [], members_removed: [], permissions_changed: [], vote_policy_changed: [] };
  const nb = roleNames(before), na = roleNames(after);
  want.roles_added = na.filter((n) => !nb.includes(n));
  want.roles_removed = nb.filter((n) => !na.includes(n));
  for (const n of new Set([...nb, ...na])) {
    const mb = roleMembers(before, n), ma = roleMembers(after, n);
    for (const m of ma) if (!mb.has(m)) want.members_added.push({ role: n, member: m });
    for (const m of mb) if (!ma.has(m)) want.members_removed.push({ role: n, member: m });
    const rb = before.roles.find((x) => x.name === n), ra = after.roles.find((x) => x.name === n);
    if (rb && ra) {
      const added = (ra.permissions || []).filter((s) => !(rb.permissions || []).includes(s)), removed = (rb.permissions || []).filter((s) => !(ra.permissions || []).includes(s));
      if (added.length || removed.length) want.permissions_changed.push({ role: n, added, removed });
      for (const k of new Set([...Object.keys(ra.vote_policy || {}), ...Object.keys(rb.vote_policy || {})])) {
        const x = (rb.vote_policy || {})[k] ?? null, y = (ra.vote_policy || {})[k] ?? null;
        if (js(x) !== js(y)) want.vote_policy_changed.push({ role: n, label: k, before: x, after: y });
      }
    }
  }
  if (js(before.default_vote_policy) !== js(after.default_vote_policy)) want.vote_policy_changed.push({ role: "default", label: "default", before: before.default_vote_policy, after: after.default_vote_policy });
  const wantBond = ["proposal_bond", "proposal_period", "bounty_bond", "bounty_forgiveness_period"].some((k) => before[k] !== after[k]);
  const norm = (list, keyFn) => js(list.slice().sort((x, y) => (keyFn(x) < keyFn(y) ? -1 : 1)));
  // Planted policy effects were written by hand in a short form: only the fields the attack
  // changes, with vote rules in words. They are held to the findings below, not to this diff.
  if (r.source !== "planted") {
    const rule = "section 3, policy_change";
    for (const f of ["roles_added", "roles_removed"]) if (js(pc[f].slice().sort()) !== js(want[f].slice().sort())) bad(id, rule, `${f} differs from the diff of policy_before and the result`);
    for (const f of ["members_added", "members_removed"]) if (norm(pc[f].map(({ role, member }) => ({ role, member })), (x) => x.role + "|" + x.member) !== norm(want[f], (x) => x.role + "|" + x.member)) bad(id, rule, `${f} differs from the diff`);
    if (norm(pc.permissions_changed, (x) => x.role) !== norm(want.permissions_changed, (x) => x.role)) bad(id, rule, "permissions_changed differs from the diff");
    if (norm(pc.vote_policy_changed, (x) => x.role + "|" + x.label) !== norm(want.vote_policy_changed, (x) => x.role + "|" + x.label)) bad(id, rule, "vote_policy_changed differs from the diff");
    if (pc.bond_or_period_changed !== wantBond) bad(id, rule, `bond_or_period_changed ${pc.bond_or_period_changed}, diff gives ${wantBond}`);
  }
  // Section 4 policy findings, both ways: each must be present exactly when the policies say so.
  const dup = new Set(after.roles.map((x) => x.name)).size !== after.roles.length;
  const adds = want.members_added.some((m) => after.roles.filter((x) => x.name === m.role).some((x) => canApprove(x.permissions || [], "*") || KINDS.some((k) => canApprove(x.permissions || [], k))));
  let lowers = false;
  for (const ra of after.roles) {
    const rb = before.roles.find((x) => x.name === ra.name);
    if (!rb) continue;
    const n = ra.kind && ra.kind.Group ? ra.kind.Group.length : null;
    for (const k of KINDS) {
      const nowOk = canApprove(ra.permissions || [], k), wasOk = canApprove(rb.permissions || [], k);
      if (nowOk && !wasOk) lowers = true;
      if (nowOk && wasOk && n !== null && rb.kind && rb.kind.Group && need((ra.vote_policy || {})[k] || after.default_vote_policy, n) < need((rb.vote_policy || {})[k] || before.default_vote_policy, n)) lowers = true;
    }
  }
  const replaced = (kind === "ChangePolicy" || kind === "ChangePolicyAddOrUpdateRole") && na.some((n) => {
    const rb = before.roles.filter((x) => x.name === n), ra = after.roles.filter((x) => x.name === n);
    if (!rb.length || ![...rb, ...ra].some((x) => KINDS.some((k) => canApprove(x.permissions || [], k))) || [...rb, ...ra].some((x) => !(x.kind && x.kind.Group))) return false;
    const old = roleMembers(before, n);
    return [...roleMembers(after, n)].some((m) => !old.has(m));
  });
  const removes = want.members_removed.length > 0;
  const guard = [...want.roles_added, ...want.roles_removed, ...want.members_added.map((m) => m.role), ...want.members_removed.map((m) => m.role), ...want.permissions_changed.map((m) => m.role), ...want.vote_policy_changed.map((m) => m.role)].some((n) => /guard/i.test(n));
  const must = { POLICY_DUPLICATE_ROLE_NAMES: dup, POLICY_ADDS_APPROVER: adds, POLICY_LOWERS_THRESHOLD: lowers, POLICY_REPLACES_ROLE: replaced, POLICY_REMOVES_MEMBER: removes, GUARD_WEAKENED: guard };
  for (const [c, v] of Object.entries(must)) if (codes.includes(c) !== v) bad(id, `section 4, ${c}`, `${c} is ${codes.includes(c) ? "present" : "absent"}, the policy before and the result give ${v}`);
  for (const c of codes) if (!(c in must) && !["DESC_CONTRADICTS", "EMPTY_DESCRIPTION", "PROMPT_INJECTION"].includes(c)) bad(id, "section 4, findings", `${c} on a policy proposal`);
  // Ruling 24: an add or remove that changes nothing is a described change that is not made.
  const nothing = !want.members_added.length && !want.members_removed.length && !want.permissions_changed.length && !want.vote_policy_changed.length && !want.roles_added.length && !want.roles_removed.length && !wantBond;
  if (nothing && /^(Add|Remove) \S+ (to|from)/.test(r.description) && L.description_check === "matches") bad(id, "section 5, description check", "the change is a no-op but the description names a member and says matches");
  if (nothing && /^(Add|Remove) \S+ (to|from)/.test(r.description) && !codes.includes("DESC_CONTRADICTS")) bad(id, "section 4, DESC_CONTRADICTS", "a described add or remove that changes nothing must fire DESC_CONTRADICTS (ruling 24)");
}

// Section 4, DESC_CONTRADICTS row: does the policy change control? Members added to or removed
// from a role that can approve, permissions or vote rules changed, or any change to a Guard role
// (ruling 23).
const canonRole = (x) => sortKeys({ ...x, kind: x.kind && Array.isArray(x.kind.Group) ? { Group: [...x.kind.Group].sort() } : x.kind, permissions: [...(x.permissions || [])].sort() });
function policyControl(r, kind, body) {
  const before = r.context.policy_before, after = policyAfter(kind, body, before);
  for (const n of new Set([...roleNames(before), ...roleNames(after)])) {
    if (/guard/i.test(n) && js(before.roles.filter((x) => x.name === n).map(canonRole)) !== js(after.roles.filter((x) => x.name === n).map(canonRole))) return true;
    const mb = roleMembers(before, n), ma = roleMembers(after, n);
    if ([...ma].some((m) => !mb.has(m)) && after.roles.filter((x) => x.name === n).some(roleApproves)) return true;
    if ([...mb].some((m) => !ma.has(m)) && before.roles.filter((x) => x.name === n).some(roleApproves)) return true;
    // Same-name roles are compared as a group, so a duplicate role that brings new rights counts.
    const bs = before.roles.filter((x) => x.name === n), as = after.roles.filter((x) => x.name === n);
    if (bs.length && as.length) {
      const rules = (rs) => js(rs.map((x) => ({ p: [...(x.permissions || [])].sort(), v: sortKeys(x.vote_policy || {}) })));
      if (rules(bs) !== rules(as)) return true;
    }
  }
  return js(before.default_vote_policy) !== js(after.default_vote_policy);
}

// Section 4, DESC_CONTRADICTS row and ruling 22: for a real policy proposal whose description names
// specific member, role or threshold changes, the finding also fires on a control change the text
// does not mention, or on a described change that is already in place. The claims are read from the
// description shapes that occur in the real set; a description with none of them names nothing
// specific, is vague, and is skipped.
function checkUndisclosedControl(r, kind, body, codes) {
  if (r.source === "planted" || !r.context.policy_before) return;
  const id = r.id, before = r.context.policy_before, after = policyAfter(kind, body, before);
  const d = r.description.replace(/ +/g, " ");
  const cl = [];
  const quoted = (s) => [...s.matchAll(/"([^"]+)"/g)].map((q) => q[1]);
  let m;
  for (const x of d.matchAll(/- add "([^"]+)" to \[([^\]]*)\]/g)) for (const ro of quoted(x[2])) cl.push({ t: "add", a: x[1], ro });
  for (const x of d.matchAll(/- edit "([^"]+)": added to \[([^\]]*)\]/g)) for (const ro of quoted(x[2])) cl.push({ t: "add", a: x[1], ro });
  for (const x of d.matchAll(/- remove "([^"]+)" from \[([^\]]*)\]/g)) for (const ro of quoted(x[2])) cl.push({ t: "rem", a: x[1], ro });
  if ((m = d.match(/voting threshold from (\d+) to (\d+)/))) cl.push({ t: "votes", x: +m[1], y: +m[2] });
  if ((m = d.match(/voting duration from (\d+) to (\d+)/))) cl.push({ t: "days", x: +m[1], y: +m[2] });
  if (!cl.length) {
    const addP = (re) => (m = d.match(re)) && cl.push({ t: "add", a: m[1], ro: m[2] ?? null });
    const remP = (re) => (m = d.match(re)) && cl.push({ t: "rem", a: m[1], ro: m[2] ?? null });
    addP(/^Add (\S+) to the treasury \((\w+)\)$/) || addP(/^Add (\S+) to "([^"]+)"$/) || addP(/^Add (\S+) as (\w+)$/) || addP(/^add member: (\S+)$/)
      || remP(/^Remove (\S+) from "?([^"]+)"?$/) || remP(/^remove (?:inactive )?member: (\S+)$/i) || remP(/^Rotation: remove (\S+)$/) || remP(/^remove (\S+\.near)$/);
    if (!cl.length && (m = d.match(/^change threshold to (\d+)%$/))) cl.push({ t: "pct", n: +m[1] });
    if (!cl.length && /^council: /.test(d)) {
      const roster = d.slice("council: ".length).split(" (")[0].split(",").map((s) => s.trim());
      const out = [...(d.match(/\(([^)]*)\)/) || ["", ""])[1].matchAll(/([a-z0-9_.-]+\.near)(?: and ([a-z0-9_.-]+\.near))? out/g)].flatMap((q) => [q[1], q[2]].filter(Boolean));
      cl.push({ t: "roster", ro: "council", roster, out });
    }
    if (!cl.length && /^Remove community role/.test(d)) cl.push({ t: "gone", ro: "community" });
    if (!cl.length && /^Change the fallback vote policy/.test(d)) cl.push({ t: "dvp" });
    if (!cl.length && /^Add an Everyone\/all role/.test(d)) cl.push({ t: "new", ro: "all" });
  }
  if (!cl.length) return;
  const anyRole = (p, a) => p.roles.some((x) => x.kind && x.kind.Group && x.kind.Group.includes(a));
  const has_ = (p, ro, a) => (ro ? roleMembers(p, ro).has(a) : anyRole(p, a));
  const votePairs = [];
  for (const ra of after.roles) {
    const rb = before.roles.find((x) => x.name === ra.name);
    if (!rb || !rb.kind.Group || !ra.kind.Group) continue;
    for (const k of KINDS) {
      if (!canApprove(ra.permissions || [], k) || !canApprove(rb.permissions || [], k)) continue;
      const own0 = (rb.vote_policy || {})[k], own1 = (ra.vote_policy || {})[k], n = ra.kind.Group.length;
      votePairs.push({ role: ra.name, k, n0: need(own0 || before.default_vote_policy, n), n1: need(own1 || after.default_vote_policy, n), viaDefault: !own0 && !own1 });
    }
  }
  // Ruling 24: an end-state roster is checked against the policy after, so a member it lists as in
  // who was already in is not a contradiction.
  const status = cl.map((c) => {
    if (c.t === "add") return has_(before, c.ro, c.a) && has_(after, c.ro, c.a) ? "stale" : has_(after, c.ro, c.a) ? "made" : "wrong";
    if (c.t === "rem") return has_(after, c.ro, c.a) ? "wrong" : has_(before, c.ro, c.a) ? "made" : "stale";
    if (c.t === "votes") return votePairs.some((p) => p.n0 === c.x && p.n1 === c.y) ? "made" : votePairs.some((p) => p.n0 === c.y && p.n1 === c.y) ? "stale" : "wrong";
    if (c.t === "days") { const b0 = Math.round(Number(BigInt(before.proposal_period) / 86400000000000n)), b1 = Math.round(Number(BigInt(after.proposal_period) / 86400000000000n)); return b0 === c.x && b1 === c.y ? "made" : b1 === c.y ? "stale" : "wrong"; }
    if (c.t === "pct") { const th = after.default_vote_policy.threshold; const ok = Array.isArray(th) && th[0] === c.n && th[1] === 100; return ok ? (js(before.default_vote_policy) !== js(after.default_vote_policy) ? "made" : "stale") : "wrong"; }
    if (c.t === "roster") { const ma = roleMembers(after, c.ro); return c.roster.length === ma.size && c.roster.every((a) => ma.has(a)) && c.out.every((a) => !ma.has(a)) ? "made" : "wrong"; }
    if (c.t === "gone") return roleNames(after).includes(c.ro) ? "wrong" : "made";
    if (c.t === "dvp") return js(before.default_vote_policy) !== js(after.default_vote_policy) ? "made" : "stale";
    if (c.t === "new") return roleNames(after).includes(c.ro) && !roleNames(before).includes(c.ro) ? "made" : "wrong";
    return "wrong";
  });
  const wrongOrStale = status.some((s) => s !== "made");
  const coveredAdd = (ro, a) => cl.some((c) => (c.t === "add" && c.a === a && (c.ro === null || c.ro === ro)) || (c.t === "roster" && c.ro === ro && c.roster.includes(a)));
  const coveredRem = (ro, a) => cl.some((c) => (c.t === "rem" && c.a === a && (c.ro === null || c.ro === ro)) || (c.t === "gone" && c.ro === ro) || (c.t === "roster" && c.ro === ro && (c.out.includes(a) || !c.roster.includes(a))));
  const extras = [];
  for (const n of new Set([...roleNames(before), ...roleNames(after)])) {
    const mb = roleMembers(before, n), ma = roleMembers(after, n);
    if (after.roles.filter((x) => x.name === n).some(roleApproves)) for (const a of ma) if (!mb.has(a) && !coveredAdd(n, a)) extras.push(`add ${a} to ${n}`);
    if (before.roles.filter((x) => x.name === n).some(roleApproves)) for (const a of mb) if (!ma.has(a) && !coveredRem(n, a)) extras.push(`remove ${a} from ${n}`);
  }
  const dclaim = cl.some((c) => c.t === "dvp" || c.t === "pct");
  for (const p of votePairs) if (p.n1 < p.n0 && !(p.viaDefault && dclaim) && !cl.some((c) => c.t === "votes" && c.x === p.n0 && c.y === p.n1)) extras.push(`votes ${p.role}:${p.k} ${p.n0} to ${p.n1}`);
  const expected = wrongOrStale || extras.length > 0;
  if (codes.includes("DESC_CONTRADICTS") !== expected) bad(id, "section 4, DESC_CONTRADICTS (ruling 22)", `DESC_CONTRADICTS is ${codes.includes("DESC_CONTRADICTS") ? "present" : "absent"}; claims ${status.join(",")}, unmentioned control changes: ${extras.slice(0, 3).join("; ") || "none"}`);
}

function checkRecord(r) {
  const id = r.id;
  const format = "section 8, record format";
  if (r.source !== "planted") {
    // A real record must be the sampled proposal exactly, as read from the chain.
    const base = sampleOf.get(id);
    if (!base) { bad(id, format, "no eval/real/sample.jsonl record with this id"); return; }
    if (Object.keys(r).join(",") !== RECORD_KEYS.join(",")) bad(id, format, `keys are ${Object.keys(r).join(",")}`);
    const canon = (v, key) => (Array.isArray(v) ? (key === "permissions" || key === "Group" ? v.map((x) => canon(x)).sort() : v.map((x) => canon(x))) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k], k)])) : v);
    for (const k of ["id", "source", "network", "dao", "proposal_id", "status", "description", "kind", "context"]) if (JSON.stringify(k === "context" ? canon(base[k]) : base[k]) !== JSON.stringify(k === "context" ? canon(r[k]) : r[k])) bad(id, format, `${k} differs from eval/real/sample.jsonl (context compared with keys, permissions and group members sorted)`);
  } else {
    // Outside the label, is_test, guide_version and labelled_by, a planted label record is its
    // eval/planted/planted.jsonl record, which is what was filed on the real contract in the sandbox.
    const old = plantedOf.get(id);
    if (!old) { bad(id, format, "no eval/planted/planted.jsonl record with this id"); return; }
    const wantKeys = [];
    for (const k of Object.keys(old)) { wantKeys.push(k); if (k === "label") wantKeys.push("guide_version"); }
    if (Object.keys(r).join(",") !== wantKeys.join(",")) bad(id, format, `keys are ${Object.keys(r).join(",")}`);
    for (const k of Object.keys(old)) if (!["label", "is_test", "labelled_by"].includes(k) && JSON.stringify(old[k]) !== JSON.stringify(r[k])) bad(id, format, `${k} differs from eval/planted/planted.jsonl`);
    // An honest control on a member kind names the account its kind adds or removes, and no other;
    // otherwise its own description contradicts it and the control is not a control.
    const kn = kindOf(r.kind);
    if (/^control:/.test(r.attack) && (kn === "AddMemberToRole" || kn === "RemoveMemberFromRole")) {
      const m = r.kind[kn].member_id;
      const named = r.description.match(/[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.sandbox/g) || [];
      if (!named.includes(m) || named.some((a) => a !== m)) bad(id, "section 6, planted control", `the description names ${named.join(", ") || "no account"}, the kind ${kn === "AddMemberToRole" ? "adds" : "removes"} ${m}`);
    }
  }
  if (r.guide_version !== "v2.3") bad(id, format, `guide_version is ${r.guide_version}, not v2.3`);
  const L = r.label;
  if (!L || Object.keys(L).join(",") !== LABEL_KEYS.join(",")) { bad(id, format, `label keys are not the section 8 set (${L ? Object.keys(L).join(",") : "no label"})`); if (!L) return; }
  if (firstLabeller.has(id) && r.labelled_by !== firstLabeller.get(id)) {
    if (!L.notes || L.notes.length < 40) bad(id, "section 1, notes", "a label made again after the chain re-read has an empty or very short note");
    if (/not in the data|is unknown|not known|cannot be checked/i.test(L.notes)) bad(id, "section 7, policy before", "the note still talks about an unknown policy before");
    if ((L.notes.match(/[.!?](\s|$)/g) || []).length > 3) bad(id, "section 1, notes", "the note is longer than two or three sentences");
  }
  const labelText = JSON.stringify(L);
  if (labelText.includes(EM_DASH) || labelText.includes(EM_DASH_ESCAPED)) bad(id, format, "em-dash in the label");

  const kind = kindOf(r.kind);
  const body = typeof r.kind === "string" ? null : r.kind[kind];
  const fc = kind === "FunctionCall" ? body : null;
  const eff = Array.isArray(L.effects) ? L.effects : [];
  const types = eff.map((e) => e.type);
  const codes = (L.findings || []).map((f) => f.code);
  const has = (c) => codes.includes(c);

  // Section 3: effect types and their fields (ruling 21 for the written forms).
  const effects = "section 3, effects";
  if (!eff.length) bad(id, effects, "no effects");
  for (const e of eff) {
    const fields = EFFECT_FIELDS[e.type];
    if (!fields) { bad(id, effects, `type ${e.type} is not in section 3`); continue; }
    for (const k of Object.keys(e).filter((x) => x !== "type")) if (!fields.includes(k)) bad(id, effects, `${e.type} has field ${k}`);
    const shortPlanted = r.source === "planted" && e.type === "policy_change";
    if (!shortPlanted) for (const k of fields) if (!(k in e)) bad(id, effects, `${e.type} lacks field ${k}`);
    if ("token" in e && (typeof e.token !== "string" || e.token.startsWith("nep141:"))) bad(id, effects, `token ${e.token} keeps a nep141: prefix (ruling 21)`);
    for (const f of ["amount", "total"]) if (f in e && !(isWhole(e[f]) || (e.type === "staking" && e[f] === "all"))) bad(id, effects, `${e.type}.${f} is not a whole-unit string`);
    if (e.type === "unknown_call" && !isWhole(e.deposit)) bad(id, effects, "unknown_call deposit is not a whole-unit string");
    if (e.type === "config_change" && (e.purpose_changed === null || e.metadata_changed === null)) bad(id, effects, "config flag null, ruling 21 says \"unknown\"");
    if (e.type === "policy_change") {
      if (typeof e.before_unknown !== "boolean") bad(id, effects, "policy_change.before_unknown is not a boolean");
      if ("bond_or_period_changed" in e && !(typeof e.bond_or_period_changed === "boolean" || e.bond_or_period_changed === null)) bad(id, effects, "bond_or_period_changed is not a boolean");
      for (const v of e.vote_policy_changed || []) if (["default_vote_policy", "<default>"].includes(v.role) || ["default_vote_policy", "<all>"].includes(v.label) || (v.role === "default") !== (v.label === "default")) bad(id, effects, "default vote policy not written as role default, label default (ruling 21)");
    }
    if (e.type === "sign_request") {
      if (e.text_supplied === true && !["planted", "description"].includes(e.text_source)) bad(id, effects, "supplied text without a text_source");
      if (e.text_supplied !== true && (e.text_source !== null || e.text_standard !== null)) bad(id, effects, "text_source or text_standard set without a supplied text");
      if (![null, "nep413", "nep461"].includes(e.text_standard)) bad(id, effects, `text_standard ${e.text_standard}`);
    }
  }

  // Section 4: known codes only, one entry per code, severity from the table.
  const movesValue = eff.some((e) => MOVES_VALUE.includes(e.type));
  const kindIsPolicy = POLICY_KINDS.includes(kind);
  const changesControl = eff.some((e) => e.type === "intents_key_change" || e.type === "code_upgrade") || (kindIsPolicy && r.context.policy_before && policyControl(r, kind, body));
  const once = new Set();
  for (const f of L.findings || []) {
    if (Object.keys(f).join(",") !== "code,severity") bad(id, "section 4, findings", "a finding has fields other than code and severity");
    if (!(f.code in TABLE)) { bad(id, "section 4, findings", `${f.code} is not a section 4 code`); continue; }
    if (once.has(f.code)) bad(id, "section 4, findings", `${f.code} appears twice`);
    once.add(f.code);
    const want = f.code === "DESC_CONTRADICTS" ? (movesValue || changesControl ? "critical" : "high") : TABLE[f.code];
    if (f.severity !== want) bad(id, "section 4, severity", `${f.code} is ${f.severity}, section 4 gives ${want}`);
  }
  // The same control test read from the effects alone (an approver added or removed, permissions or
  // vote rules changed, GUARD_WEAKENED, a key change or a code upgrade) must agree with the policy data.
  const effectControl = eff.some((e) => e.type === "intents_key_change" || e.type === "code_upgrade") || codes.includes("GUARD_WEAKENED")
    || eff.some((e) => e.type === "policy_change" && ([...(e.members_added || []), ...(e.members_removed || [])].some((m) => m.approver === true) || (e.permissions_changed || []).length > 0 || (e.vote_policy_changed || []).length > 0));
  const dc = (L.findings || []).find((f) => f.code === "DESC_CONTRADICTS");
  if (dc && dc.severity !== (movesValue || effectControl ? "critical" : "high")) bad(id, "section 4, DESC_CONTRADICTS", `DESC_CONTRADICTS is ${dc.severity}, the effects alone give ${movesValue || effectControl ? "critical" : "high"}`);
  if (Boolean(effectControl) !== Boolean(changesControl)) bad(id, "section 4, DESC_CONTRADICTS", `the effects alone say control ${Boolean(effectControl)}, the policy data says ${Boolean(changesControl)}`);

  // Section 1: the floor is the highest finding severity, unknown counting as high.
  let floor = "low";
  for (const f of L.findings || []) { const s = f.severity === "unknown" ? "high" : f.severity; if (LEVEL[s] > LEVEL[floor]) floor = s; }
  if (L.risk_floor !== floor) bad(id, "section 1, risk floor", `risk_floor ${L.risk_floor}, findings give ${floor}`);
  // Section 6: the veto fields.
  if (L.must_veto !== (floor === "critical")) bad(id, "section 6, must_veto", `must_veto ${L.must_veto} with floor ${floor}`);
  const strong = (L.findings || []).some((f) => f.code !== "HASH_UNVERIFIED" && (f.severity === "high" || f.severity === "critical"));
  const guardCanReject = kind !== "RemoveMemberFromRole";
  if (L.veto_allowed !== ((floor === "high" || floor === "critical") && strong && guardCanReject)) bad(id, "section 6, veto_allowed", `veto_allowed ${L.veto_allowed} does not follow section 6`);
  if (!guardCanReject && L.veto_allowed !== false) bad(id, "section 6, veto_allowed", "veto_allowed on a RemoveMemberFromRole, which the guard can never reject");
  if (r.source === "planted") {
    const should = !/^control:/.test(r.attack) && kind !== "RemoveMemberFromRole";
    if (L.should_veto !== should) bad(id, "section 6, should_veto", `should_veto ${L.should_veto}, section 6 gives ${should}`);
  } else if (L.should_veto !== L.must_veto) bad(id, "section 6, should_veto", `real record with should_veto ${L.should_veto} and must_veto ${L.must_veto}; for a real proposal they are equal`);

  // Section 1: the note says nothing the label contradicts.
  if (/critical/i.test(L.notes) && floor !== "critical") bad(id, "section 1, notes", `note says critical while the floor is ${floor}`);
  for (const c of Object.keys(TABLE)) if (new RegExp(`\\b${c}\\b`).test(L.notes) && !has(c)) bad(id, "section 1, notes", `note names ${c}, which the label does not carry`);

  // Sections 3 and 4, sign requests: a planted supplied_text is supplied, and HASH_MISMATCH fires
  // exactly when a supplied text does not hash to the payload the kind asks to sign.
  const signs = eff.filter((e) => e.type === "sign_request");
  const payload = signs.length ? signedPayload(fc) : null;
  if (signs.length && !payload) bad(id, "section 3, sign_request", "sign request whose payload cannot be read from the kind");
  for (const e of signs) if (e.payload_hash !== payload) bad(id, "section 3, sign_request", "sign_request payload_hash differs from the kind");
  if (r.supplied_text) {
    if (!signs.length) bad(id, "section 3, sign_request", "supplied_text without a sign_request");
    for (const e of signs) if (e.text_supplied !== true || e.text_source !== "planted") bad(id, "section 3, sign_request", `planted supplied_text with text_supplied ${e.text_supplied}, text_source ${e.text_source}`);
  }
  for (const e of signs) if (e.text_source === "description" && nep461FromDescription(r.description) !== payload) bad(id, "section 3, sign_request", "text_source description, but the description text does not hash to the payload (ruling 11)");
  const mismatch = Boolean(r.supplied_text) && nep413(r.supplied_text) !== payload;
  if (has("HASH_MISMATCH") !== mismatch) bad(id, "section 4, HASH_MISMATCH", `HASH_MISMATCH ${has("HASH_MISMATCH") ? "present" : "missing"} while a supplied text that does not hash is ${mismatch ? "present" : "absent"}`);

  // Section 4: every whole-role replacement that brings in new members, or drops any.
  if ((kind === "ChangePolicy" || kind === "ChangePolicyAddOrUpdateRole") && r.context.policy_before) {
    const after = policyAfter(kind, body, r.context.policy_before);
    const roles = replacedApprovingRoles(r.context.policy_before, after);
    if (roles.length && !has("POLICY_REPLACES_ROLE")) bad(id, "section 4, POLICY_REPLACES_ROLE", `approving role ${roles.join(", ")} replaced by a member set that is not a subset of the old one, without POLICY_REPLACES_ROLE`);
    const dropped = droppedFromRoles(r.context.policy_before, after);
    if (dropped.length && !has("POLICY_REMOVES_MEMBER")) bad(id, "section 4, POLICY_REMOVES_MEMBER", `the replacement drops ${dropped.join(", ")} without POLICY_REMOVES_MEMBER`);
  }

  // Section 4, HASH_TEXT_DANGEROUS row: an unknown intent inside a supplied hash text is not a call,
  // so UNKNOWN_CALL needs an unknown_call that is not one of the text's intents. A NEP-461 delegate
  // action in a description is a call (ruling 11), so it counts as outside.
  if (signs.length && has("UNKNOWN_CALL")) {
    const intents = (() => { try { const m = JSON.parse(r.supplied_text.message); return Array.isArray(m.intents) ? m.intents : []; } catch { return []; } })();
    const inText = (e) => e.receiver === "intents.near" && intents.some((i) => { const { intent, ...rest } = i; return intent === e.method && JSON.stringify(Object.keys(rest).sort().map((k) => [k, rest[k]])) === JSON.stringify(Object.keys(e.args || {}).sort().map((k) => [k, e.args[k]])); });
    if (!eff.some((e) => e.type === "unknown_call" && !(r.supplied_text && inText(e)))) bad(id, "section 4, UNKNOWN_CALL", "UNKNOWN_CALL on a sign_request record whose only unknown calls are intents inside the hash text");
  }

  // Section 3: defi_call only for calls made directly on the three named accounts; a token's
  // ft_transfer_call is a token_call_transfer only.
  if (eff.some((e) => e.type === "defi_call") && !(fc && DEFI_ACCOUNTS.includes(fc.receiver_id))) bad(id, "section 3, defi_call", "defi_call effect on a call not made directly on Burrow or Ref");
  if (fc) for (const a of fc.actions.filter((x) => x.method_name === "ft_transfer_call")) {
    const v = argsJson(a.args);
    if (!v || !eff.some((e) => e.type === "token_call_transfer" && e.token === fc.receiver_id && e.to === v.receiver_id && e.amount === v.amount)) bad(id, "section 3, token_call_transfer", "ft_transfer_call without its token_call_transfer effect");
  }

  // Section 4: ARGS_NOT_JSON never on empty or {} arguments (ruling 2).
  if (fc) {
    const notJson = fc.actions.some((a) => argsOf(a.args) === "not_json");
    if (has("ARGS_NOT_JSON") !== notJson) bad(id, "section 4, ARGS_NOT_JSON", `ARGS_NOT_JSON ${has("ARGS_NOT_JSON") ? "present" : "absent"} while non-JSON arguments are ${notJson ? "present" : "absent"}`);
    for (const e of eff) if (e.type === "unknown_call" && e.args === "not_json" && e.receiver === fc.receiver_id && fc.actions.some((a) => a.method_name === e.method && argsOf(a.args) === "empty")) bad(id, "section 4, ARGS_NOT_JSON", "empty arguments written as not_json (ruling 2)");
  } else if (has("ARGS_NOT_JSON")) bad(id, "section 4, ARGS_NOT_JSON", "ARGS_NOT_JSON on a kind without call arguments");

  // Section 3 and ruling 5: code_upgrade only on the two Sputnik upgrade kinds.
  const upgradeKind = kind === "UpgradeSelf" || kind === "UpgradeRemote";
  if (types.includes("code_upgrade") && !upgradeKind) bad(id, "section 3, code_upgrade", `code_upgrade effect on a ${kind} (ruling 5)`);
  if (has("CODE_UPGRADE") !== upgradeKind) bad(id, "section 4, CODE_UPGRADE", `CODE_UPGRADE ${has("CODE_UPGRADE") ? "on" : "missing from"} a ${kind}`);

  // Section 7: every policy record now has its policy before, read from the chain.
  if (kindIsPolicy) {
    const before = "section 7, policy before";
    if (r.context.policy_before === null || r.context.policy_before === undefined) bad(id, before, "policy_before is null");
    for (const e of eff) if (e.type === "policy_change" && e.before_unknown !== false) bad(id, before, "policy_change.before_unknown is not false");
    if (!types.includes("policy_change")) bad(id, before, "policy kind without a policy_change effect");
    if (has("POLICY_BEFORE_UNKNOWN")) bad(id, before, "POLICY_BEFORE_UNKNOWN with the policy before known");
    checkPolicy(r, L, eff, codes, kind, body);
    checkUndisclosedControl(r, kind, body, codes);
  } else if (has("POLICY_BEFORE_UNKNOWN")) bad(id, "section 4, POLICY_BEFORE_UNKNOWN", "POLICY_BEFORE_UNKNOWN on a kind that is not a policy kind");

  // Section 4 and rulings 3 and 4: ATTACHED_DEPOSIT never on a deposit that is a wrap, staking,
  // storage_deposit or bulk_payment effect.
  if (fc) {
    const pool = /\.(pool|poolv1)\.near$/.test(fc.receiver_id);
    const ownEffect = (a) => (fc.receiver_id === "wrap.near" && a.method_name === "near_deposit") || (pool && ["deposit", "deposit_and_stake"].includes(a.method_name)) || a.method_name === "storage_deposit" || (fc.receiver_id === "bulkpayment.near" && a.method_name === "approve_list");
    let other = false;
    for (const a of fc.actions) {
      if (BigInt(a.deposit) <= 1n) continue;
      if (ownEffect(a)) { if (eff.some((e) => e.type === "transfer" && e.token === "near" && e.to === fc.receiver_id && e.amount === a.deposit)) bad(id, "section 3, transfer", `the deposit of ${a.method_name} is also a transfer (ruling 4)`); }
      else other = true;
    }
    if (has("ATTACHED_DEPOSIT") !== other) bad(id, "section 4, ATTACHED_DEPOSIT", `ATTACHED_DEPOSIT ${has("ATTACHED_DEPOSIT") ? "present" : "missing"} while deposits outside the four known effects are ${other ? "present" : "absent"}`);
    for (const a of fc.actions) if (a.method_name === "storage_deposit" && !eff.some((e) => e.type === "storage_deposit" && e.contract === fc.receiver_id)) bad(id, "section 3, storage_deposit", "storage_deposit call without a storage_deposit effect (ruling 3)");
  } else if (has("ATTACHED_DEPOSIT")) bad(id, "section 4, ATTACHED_DEPOSIT", "ATTACHED_DEPOSIT on a kind without a deposit");

  // Section 4 and ruling 14: UNKNOWN_VALUE whenever a value-moving token has no census price, and
  // then never LARGE_AMOUNT. A bulk payment is priced in the token that funds it, NEAR otherwise.
  const funding = eff.find((e) => e.type === "token_call_transfer" && e.to === "bulkpayment.near");
  const values = eff.filter((e) => MOVES_VALUE.includes(e.type)).map((e) => (e.type === "bulk_payment" ? dollars(funding ? funding.token : "near", e.total) : dollars(e.token, e.amount)));
  const unpriced = values.some((v) => v === null);
  if (has("UNKNOWN_VALUE") !== unpriced) bad(id, "section 4, UNKNOWN_VALUE", `UNKNOWN_VALUE ${has("UNKNOWN_VALUE") ? "present" : "missing"} while an unpriced value-moving token is ${unpriced ? "present" : "absent"}`);
  if (unpriced && has("LARGE_AMOUNT")) bad(id, "section 4, LARGE_AMOUNT", "LARGE_AMOUNT on an unpriced token (ruling 14)");

  // Section 4 and ruling 15: CROSS_CHAIN_OUT only when the destination chain is not NEAR.
  const offNear = eff.some((e) => e.type === "intents_withdraw" && e.chain !== "near");
  if (has("CROSS_CHAIN_OUT") !== offNear) bad(id, "section 4, CROSS_CHAIN_OUT", `CROSS_CHAIN_OUT ${has("CROSS_CHAIN_OUT") ? "present" : "missing"} while a withdrawal off NEAR is ${offNear ? "present" : "absent"}`);

  // Section 2: is_test from the DAO account name, or every value-moving effect under 5 USD.
  const name = r.dao.toLowerCase();
  const wantTest = TEST_WORDS.some((w) => name.includes(w)) || (values.length > 0 && values.every((v) => v !== null && v < 5));
  if (r.is_test !== wantTest) bad(id, "section 2, is_test", `is_test ${r.is_test}, section 2 gives ${wantTest}`);

  // Section 5: the description check, and its link to EMPTY_DESCRIPTION and DESC_CONTRADICTS.
  const chars = [...r.description].length;
  if ((chars < 20) !== has("EMPTY_DESCRIPTION")) bad(id, "section 4, EMPTY_DESCRIPTION", `EMPTY_DESCRIPTION does not match a ${chars}-character description`);
  if ((chars < 20) !== (L.description_check === "empty")) bad(id, "section 5, description check", `description_check ${L.description_check} for a ${chars}-character description`);
  if (L.description_check === "contradicts" && !has("DESC_CONTRADICTS")) bad(id, "section 5, description check", "contradicts without DESC_CONTRADICTS");
  if (has("DESC_CONTRADICTS") && !["contradicts", "empty"].includes(L.description_check)) bad(id, "section 5, description check", `DESC_CONTRADICTS with description_check ${L.description_check}`);
}

for (const r of [...real, ...planted]) checkRecord(r);

const total = real.length + planted.length;
if (!problems.length) {
  console.log(`guide v2.3: ${total} records (${real.length} real, ${planted.length} planted), all rules hold`);
} else {
  for (const p of problems) console.log(p.line);
  const flagged = [...new Set(problems.map((p) => p.id))];
  console.log(`guide v2.3: ${problems.length} problem${problems.length === 1 ? "" : "s"} on ${flagged.length} of ${total} records: ${flagged.join(", ")}`);
  process.exitCode = 1;
}
