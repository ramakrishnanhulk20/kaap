# Kaap threat model

Written 20 Oct 2026 at the architecture gate, before any code. Method: the system was first described in plain functional terms with security left out (`system-description.md`), then reviewed against that description with the design-review prompt from the Monad Foundation's article on writing secure code with LLMs (https://monad.xyz/blog/writing-secure-code-with-llms). Section C is the definition of done: the build is complete only when every invariant in C is shown to hold. Line references point at the Sputnik DAO contract source (`sputnikdao2/src/policy.rs` and `proposals.rs`, main branch as read on 20 Oct 2026).

Designs A, B and C are the three candidate architectures: A runs the worker and the guard key on our server; B runs the verdict logic inside OutLayer's sealed hardware; C makes the guard a NEAR contract that votes only on a signed verdict.

Decisions taken at the architecture gate (20 Oct 2026), and later ones with their dates, are marked **DECIDED**. The chosen architecture is design B and C together: the verdict is produced and signed inside OutLayer's sealed hardware, and the guard is a contract that can only cast VoteReject on a verdict signed by that key.

---

## A) App-class risk profile

In security terms, Kaap is three systems at once:
1. **An automated interpreter that acts.** It reads content written by attackers on a public chain (under Sputnik's default policy anyone can file a proposal: policy.rs 188-192). It turns that content into meaning with a deterministic decoder plus an LLM, then acts on the meaning with a privileged on-chain vote that cannot be undone.
2. **A data store shared by many DAOs** (member contacts, confidential message texts, payments), behind a wallet-signature login.
3. **A public web app and messaging service.** It renders text that attackers control and relays requests to fixed outside services.

The vulnerability categories that typically hit this class, each tied to a Kaap data flow:

- **A1 Two readings of one input (parser differential).** Applies to the Decoder, the Hash checker and the policy diff. Kaap's reading has to match what the chain will do. The places they can differ:
  - Sputnik matches permission strings exactly, with four patterns (policy.rs 346-353).
  - A policy can hold two roles with the same name. Sputnik then takes permissions from a map keyed by name, where the last match wins (323-331), but takes vote rules from the first match (374-376).
  - `policy_add_or_update_role` replaces the whole role, member set included (246-259).
  - `add_member_to_role` on a role that does not exist only writes a log line (292-305).
  - FunctionCall args are bytes the receiver parses, not Kaap. The `msg` of `ft_transfer_call` is a second JSON layer that `intents.near` reads.
  - NEP-413 text is hashed as exact bytes, then parsed separately.
- **A2 Instruction injection into the LLM, direct and stored.** Applies to the Judge. These all reach the prompt: the description, decoded args, token names, memos, `msg` strings, and the history summary, which carries earlier attacker descriptions back in. The attacker wants "low" on their own proposal or "critical" on someone else's.
- **A3 Rendering attacker text.** XSS, markup injection in Telegram and email, and text written permanently to the chain. Applies to the web app, the Notifier and the Publisher. Sources: descriptions, the AI explanation (an output the attacker can steer), submitted hash texts, token metadata.
- **A4 The state checked is not the state used.** Applies to the verdict versus the execution:
  - Policy shortcut kinds are applied to the policy as it is at execution time (proposals.rs 367-371, 436-459).
  - A receiver contract can change its code after the verdict.
  - A Failed proposal can be run again through Finalize (658-675), while voting on it is closed (625-628).
- **A5 Races and missed proposals.** Applies to the Watcher and the Guard. Approval executes inside the vote that crosses the threshold (640-643). Proposals that arrive through batches or cross-contract calls can slip past a transaction filter, and a missed proposal is never reviewed.
- **A6 Authentication and authorization.** Applies to the member login, the member view, enrolment, registry writes and subscriptions. The usual failures: a replayed login message, a signature from a key the account no longer holds, counting the Everyone role as membership, a member of DAO X reading DAO Y's data, and CSRF on cookie sessions.
- **A7 How much power each key has.** Applies to the Guard and the Publisher, differently in each design. A key limited to one method does not limit the action argument. A function call key's allowance of 0, or none at all, means unlimited.
- **A8 Checking signatures and attestations.** Applies to the Judge, the verify button, the quote check and the login. The usual failures: accepting an alias model id; accepting a gateway-signed stream as if the sealed model had signed it; a signer not tied to a fresh attestation; checking a 1Click quote with a key taken from the same response; trusting a "yes" from a proxy.
- **A9 Running Kaap out of money or capacity.** Applies to the Watcher, the Judge, the paste box, the Notifier and the registry. Rejected proposals get their bond back, every paste costs a paid AI call, and every verdict takes registry storage.
- **A10 Leaking sensitive data.** Applies to hash texts, contacts, logs, the AI provider and the chain. A stored message text plus the public signature on chain can be enough to submit that intent, or, for an auth-type text, to open a session on the DAO's 1Click account. Until their deadline, these texts are secrets, not notes.
- **A11 Trusting outside services.** Applies to the RPC providers, the block stream, Trezu, 1Click and Agent Market. A provider that lies or lags can show Kaap a proposal or policy the chain does not hold.
- **A12 Server-side request forgery.** Narrow here: only the verify proxy and the paste box. With fixed upstream hosts, it shrinks to an open-relay and rate-limit problem.
- **A13 Build integrity (designs B and C).** An attestation proves which wasm ran. It does not prove the wasm was built from the published source.
- **Do not apply, or only as a basic standard:** SQL injection (closed by parameterised queries); file upload and path traversal (no file inputs); unsafe deserialisation (inputs go into typed JSON and borsh parsers, so the live risk is size and depth, A9); payment fraud (low value, handled as correct enrolment state in C30).

---

## B) Threat model

### Trust boundaries (each is a point where untrusted data becomes trusted)
- T1 The chain to the Watcher and Decoder. Every proposal field is written by whoever filed it.
- T2 The RPC and block-stream providers to Kaap. A third party sits on every read.
- T3 The public to the hash checker endpoint.
- T4 Kaap to NEAR AI Cloud (private data leaving) and back (the answer is untrusted text).
- T5 Intel, NVIDIA, 1Click, Trezu and Agent Market responses coming into Kaap.
- T6 The browser to the web app (paste box, verify proxy, enrolment drafts, login, subscriptions), and Telegram webhooks to the bot.
- T7 A wallet signature turning into a session that can read private data.
- T8 The database back to the services: values stored earlier and read back as if they were trusted.
- T9 Kaap's keys to the chain: registry writes and guard votes carry Kaap's authority.
- T10 Design B: the operator and the OutLayer coordinator to the TEE input, and the TEE output to the chain.
- T11 Design C: any relayer to the guard contract, and the host of the signing key to the contract.
- T12 The proof CLIs running every mainnet DAO's content on a judge's machine.
- T13 The sealed hardware under the job. OutLayer runs it on Intel TDX with the open-source dstack stack, so the verdict key is only as safe as that stack. On 20 Oct 2026 OutLayer said a dstack incident Phala disclosed on 19 Oct did not affect it and that it was rolling out the patched release. The README states this dependency plainly.

### Inputs an attacker controls
- **Direct:**
  - every proposal field: description, kind, receiver ids, method names, base64 args, deposits, gas, token ids, amounts, `msg`, role definitions, permission strings, vote policies, bounty data, blob hashes;
  - the timing and order of proposals and votes, and re-filing after a reject;
  - hash checker submissions (text, nonce, recipient, the proposal named);
  - paste box input;
  - login messages, signatures and session tokens;
  - email addresses and Telegram commands;
  - verify proxy request bodies;
  - payment deposits and Agent Market job inputs;
  - request headers (forwarded-for is trusted only when our own proxy set it).
- **Indirect:**
  - any contract the attacker deploys: token name, symbol and decimals, view results, and a fake "DAO" that returns crafted `get_proposal` and `get_policy` output of any size;
  - DAO state the attacker can change through proposals that pass, including UpgradeSelf;
  - receiver contract code at execution time;
  - RPC and stream responses, and redirects from any upstream;
  - AI answers, signatures, attestation reports, and the model catalog and its aliases;
  - the 1Click price list, quotes and signatures;
  - Trezu metadata;
  - values Kaap stored earlier: the history cache (holding earlier attacker descriptions), submitted texts, earlier verdicts, subscription rows.

### What Kaap can reach that an attacker cannot
- **The guard vote.** On an enrolled DAO, a single Kaap vote can end a proposal as Rejected (proposals.rs 649-652), and each account votes only once (279-282).
- **The guard's keys and its gas balance.** Design A keeps them on our server. Design B keeps them in OutLayer custody. In design C the guard is a contract, and the crown jewels become the verdict-signing key and the contract owner's key.
- **The publisher key and the registry's storage balance:** Kaap's name on chain.
- **Secrets:** the NEAR AI key (it spends money), the 1Click partner key, the Telegram bot token, the email provider login (it sends as Kaap's domain), Agent Market credentials and RPC keys.
- **The database:** member contacts, confidential texts (they work like bearer credentials until their deadline), payments, enrolment state.
- **Trust.** Members act on "Kaap says low", and the public reads the "verified" badges.

### Attacker goals
- **G1 Drain or capture a treasury despite Kaap:** a harmful proposal gets a low verdict and no guard vote. Enabled by decoder blind spots (A1), injection (A2), state that changes after the check (A4), outrunning the guard (A5), a hash with no text or a false one, or disarming the guard first through a policy change or `remove_member_from_role`.
- **G2 Turn Kaap against its own DAOs:** make the guard reject honest proposals and freeze governance. Enabled by injection stored in the history, a stolen guard key, a critical verdict replayed onto a different proposal.
- **G3 Forge trust:** publish or replay a verdict in Kaap's name, or show "verified" on an answer that was gateway-signed, came through an alias, or was stale. Enabled by the publisher key, registry write rights, the verify button.
- **G4 Steal private data:** confidential texts, contacts, another DAO's records. Enabled by member-view authorization, logs, the explanation field on chain, a model that does not run in sealed hardware.
- **G5 Wear Kaap down or misuse it:** burn AI spend, flood members with alerts until the real one is buried, use Kaap to send mail to arbitrary addresses, use the proxy as an open relay, or drain registry storage or guard gas.

---

## C) Defensive-programming standards (the definition of done)

### Meaning matches what the chain will do
- **C1** The decoder's list of effects is what Sputnik would execute, given the policy and state it read. It is modelled with Sputnik's own rules: exact permission matching with the four patterns; for duplicate role names, last match for permissions and first match for vote rules; whole-role replacement for `policy_add_or_update_role`; shortcut kinds applied to the policy at execution time. Duplicate role names, an unrecognised kind, and a permission string Sputnik would ignore are each reported as findings, never quietly tidied up. Proof: table tests built from the Sputnik source, plus a ChangePolicy with duplicate role names that must come out critical.
- **C2** No effect is rated below its worst plausible reading. All of these produce an explicit "unknown" effect at high or above, never "low" and never "0 USD": an unknown receiver, method, args, `msg` format, token or price; args that are not JSON; UpgradeSelf, UpgradeRemote, SetStakingContract and FactoryInfoUpdate. The deposit attached to a FunctionCall counts as NEAR sent.
- **C3** A method name maps to an effect (ft_transfer, mt_transfer, staking, lending, exchange, sign) only for the exact receiver account read from chain. Value comes from the price list keyed by exact contract id, never by symbol. If decimals come only from the token's own metadata, the value is marked unverified.
- **C4** A verdict is tied to the state it was computed on: network, DAO, proposal id, kind hash, policy hash, receiver code hashes, the block of the reads, decoder version, and model id. If any of these changes while the proposal is open (a policy change, a receiver redeploy, a move to Failed), every open verdict for that DAO is recomputed before the guard may act.
- **C5** The kind in the guard's VoteReject is the bytes read from `get_proposal`, forwarded unchanged, never Kaap's re-encoding of them. That way Sputnik's `ERR_WRONG_KIND` check (proposals.rs 616, a comparison by value) ties the vote to the kind that was reviewed. The verdict pins the kind by a hash of kaap-core's canonical form (object keys sorted, and Sputnik's unordered sets sorted: a Group role's members and a role's permissions), because Sputnik stores roles' permissions, members and vote policies as hash sets and maps whose JSON order can change between reads with no edit (seen on a live DAO between 24 and 26 Oct 2026). The guard recomputes that hash from the bytes it forwards.

### Hash checker
- **C6** A text is accepted only when the NEP-413 hash, recomputed from the exact submitted bytes, equals `payload_v2`; the sign path is the DAO; `signer_id` is the DAO; and the recipient is one Kaap models. The same bytes are then parsed by a strict parser that rejects duplicate keys, unknown fields at the top level, and trailing data. Any intent that changes who controls the DAO's intents account, or any unknown intent kind, is critical. Proof: a duplicate-key text, a changed nonce, and a text for another DAO all fail.
- **C7** A 1Click deposit address maps to a final payee only through a quote signature checked against 1Click's key pinned in config. The quote's token, amount and deadline must match the intent in whole base units. Otherwise the result is "unknown deposit address".
- **C8** A sign proposal with no text received is reported "UNKNOWN, not verifiable", never low. **DECIDED:** UNKNOWN alerts every member and does not trigger the guard. A DAO may opt in to a strict mode where UNKNOWN also triggers it. Strict mode is one setting per enrolled DAO, chosen by the DAO's own vote at enrolment or later, and switching it off reads as weakening the guard (C17). It is built in the next version of the guard (`veto_unreadable` in `packages/contracts/guard/src/lib.rs`), in the rules engine (`is_vetoable` in `packages/core/src/floor.rs`) and in the command line (`packages/cli/src/guard.ts`). The guard deployed on testnet today was built before it and vetoes no unread hash for anyone.

### Judge
- **C9** The AI can raise a severity but never push it below the deterministic floor set by C1 to C8. **DECIDED:** the guard votes only on a critical verdict backed by at least one deterministic finding. A deterministic critical finding (proof of deception: a hash mismatch, a dangerous hash text, prompt injection, duplicate role names, or a description that contradicts an effect that moves value or changes control) makes the verdict critical whatever the AI says, so the guard vetoes it, including when it looks like an honest typo; the DAO re-files with the right text (decided 20 Oct 2026). **DECIDED:** only an AI answer marked "AI verified" (C11) can raise a verdict to critical; an unverified or unavailable answer can raise it to high at most, so it alerts but never vetoes. The sealed job applies this cap and the guard re-checks it from the verdict's AI status (decided 23 Oct 2026). **DECIDED:** a policy proposal whose description names specific member, role or threshold changes is a proven contradiction when its effect, measured against the policy it would replace now, makes a control change the description does not mention (adding or removing an approver, or lowering the votes needed) or claims a change already in place; it is critical and vetoed. This catches stale full-policy copies that would silently undo or exceed what the text says (decided 26 Oct 2026, after a live case in which a stale full-policy proposal silently removed an approver, and `techbros` #4, which cut the votes Admin needs from half the admins to one under a description that listed only new members). Proof: a planted "routine payroll, rate low" proposal that grants a new approver still comes out critical; a critical verdict on a high floor with an unverified AI answer is refused by the guard.
- **C10** Every attacker string goes to the model as quoted data inside a fixed structure, with length caps. The answer is parsed into a fixed schema: a risk value from the enum, a capped explanation, no URLs, no markup. An answer that fails to parse becomes "AI unavailable" and the deterministic verdict stands. The history the model sees is a summary Kaap builds from chain facts, never earlier descriptions word for word.
- **C11** A verdict is marked "AI verified" only when all of these hold: the model id is canonical and sent with `x-no-aliasing`; the model runs in sealed hardware with attestation supported; the answer was not streamed; `signature_kind` is `provider_tee`; the signed content recomputes from the exact request and response bytes; the signer is tied to an attestation fetched with a fresh nonce Kaap chose; the Intel and NVIDIA checks pass the stated TCB policy. **DECIDED:** the TCB policy accepts UpToDate and OutOfDate, and every verdict and the verify page state which one the hardware reported (decided 23 Oct 2026; on that day NEAR's hardware reported OutOfDate with 10 Intel advisories). The model's own quote is checked, not only the gateway's: NEAR's public Intel token carries the gateway's quote, so it is never shown as proof of the model. If any check fails, the verdict is labelled "AI unverified". It is never silently shown as verified.
- **C12** Confidential texts and member-only explanations go only to models that meet the sealed-hardware condition in C11.

### Publisher and registry
- **C13** Only a verdict signed by the sealed program's key is recorded. Anyone may send it: the registry trusts the signature, not the caller. A verdict is never overwritten; it can only be superseded by a newer one that points back to it. Entries over a size cap are refused. Public fields never hold a confidential text, an explanation of one, or a contact detail (a hash at most).
- **C14** The effects hash uses one published canonical encoder, shared by the service, the registry, the CLI and the browser, so anyone can recompute it from chain data.

### Guard
- **C15** The guard's only on-chain action is VoteReject on an enrolled DAO, for a proposal that is InProgress, tied to the kind as in C5. Designs A and B: no code path builds any other action, and the key has a finite allowance. Design C: the method and the action are hardcoded, so a stolen signing key can only reject, never approve, remove or finalise. As built (29 Oct 2026), the guard's one other promise is a plain Transfer that returns a caller's own excess storage deposit on `enroll` and `unenroll`; VoteReject is its only cross-contract call.
- **C16** Before a DAO is shown as protected, and after every policy change, Kaap works out from the live policy with Sputnik's formulas (policy.rs 98-106, 397-418; proposals.rs 265-269): (a) for each kind, whether a single guard vote reaches the reject threshold under RoleWeight; (b) every right the guard account holds, across every role it matches, Everyone and Member roles included; (c) the approval threshold per kind, which gives the race window; (d) every other account whose own single reject would also decide a proposal. Any kind the guard cannot reject, any extra right it holds, and any other account that can veto alone are shown on the DAO page and sent to members. Proof, checked against the Sputnik 3.2 binary (`packages/core/tests/policy_arming.rs`, and `guard_arming_agrees_with_the_binary` in `packages/core-diff`): under the enrolment template's fixed threshold of 1, a second account in the Guard role leaves the guard armed and is reported as another account that can veto alone; under the default 1/2 ratio the same change disarms the guard, and Kaap reports "disarmed".
- **C17** Any proposal that weakens Kaap's oversight is at least high and alerts every member: removing or changing the Guard role, its vote policy or its members, removing Kaap, or raising a quorum the guard needs. That includes `remove_member_from_role`, which the guard cannot reject by design.
- **C18** A guard that is down is visible, not silent. Watcher lag, a guard balance too low for N votes, a low key allowance, or a failing attestation each raise "guard offline" to members and on the public page.
- **C19** Design C only: a signed verdict is used once; it names the guard contract, the network, the DAO, the proposal id, the kind, a critical risk level and an expiry; only the owner can change the accepted signer keys, and this document names who holds that owner key: Kaap's founder, as one testnet account key, with no second signer. In the next version of the guard a change of the accepted key is announced on chain and takes effect 24 hours later at the earliest, the owner can cancel it, and `kaap arming` and `kaap verify` warn while one is pending (`set_accepted_key`, `apply_key_change` in `packages/contracts/guard/src/lib.rs`). On the guard deployed on testnet today a change still takes effect at once. Proof: replaying a verdict onto another proposal id, onto another DAO, after its expiry, or across testnet and mainnet fails in all four cases.
- **C20** Design B only: the TEE input names the final block hash it read from, so anyone can fetch the same data and check it. The wasm builds reproducibly, so its code hash can be matched to the published source. The OutLayer key policy allows only the enrolled DAO contracts and `act_proposal`.

### Watcher and outside services
- **C21** Every proposal of an enrolled DAO gets reviewed. Kaap checks against the DAO's own proposal counter, not only against the transactions its filter caught. A gap triggers a backfill and an alert. One pass takes up at most 50 new proposals of one treasury, the newest; when more are new, the older ones are skipped and said so (`proposals_skipped`), never passed over in silence (`#settle` in `packages/worker/src/watcher.ts`).
- **C22** Any read that can lead to a vote is done at final finality and must agree across two independent RPC providers. If they disagree, the vote is held and an alert goes out. Trezu metadata is for display only and never changes an effect or a risk level.
- **C23** Paste box targets must be valid NEAR account ids on a named network, and their code hash must match Sputnik's before anything is decoded. Otherwise the answer is "not a recognised DAO". Paste box verdicts are labelled advisory and are not written to the registry as if they came from an enrolled DAO.

### Web, notifications and data
- **C24** Every string an attacker can influence is encoded for whoever reads it next. In the web app it is HTML-escaped and raw HTML is never rendered. In Telegram it goes as plain text with no parse mode. In email it is plain or escaped. It is length-capped. Links are built only by Kaap, from a validated DAO id and a numeric proposal id, and point only at Kaap's own domain.
- **C25** A member session needs a NEP-413 signature on a message that has Kaap as recipient, a single-use server nonce with an expiry, and the network. The signing key must be a current full-access key of the account at a final block. The account must be in a Group role of the DAO's current policy. Everyone never counts; token Member roles do not count either. Every private read checks the session account against the DAO it asks for. Proof: a replayed message, a removed key, and a DAO X session reading DAO Y are all refused.
- **C26** Confidential texts are encrypted at rest and readable only through C25. They never appear in logs or error reports, and they are deleted after their deadline. Contacts are never public, never logged in full, and never sent to the AI.
- **C27** An email subscription is confirmed by a link sent to that address. A Telegram subscription starts from the chat itself with a one-time token. Every message has an unsubscribe. Alerts are capped and batched per DAO and per proposer, but batching never delays a critical verdict.
- **C28** The verify proxy talks only to the two fixed Intel and NVIDIA endpoints. It follows no redirects, caps body size and request rate, and returns the raw upstream bytes. The browser checks the signatures itself.
- **C29** Spending has hard ceilings: a spend limit set on the NEAR AI key itself; per-DAO and per-IP budgets on the paste box and the hash checker; a cache keyed by C4's state binding; a daily cap on registry writes per DAO; the guard's balance kept separate from the payments account.
- **C30** Enrolment drafts come from one fixed template, and the page shows Kaap's own decoding of the draft. An enrolment counts only once the on-chain policy matches the template (C16). Payment state changes only on settled on-chain receipts, compared in whole base units.
- **C31** The proof CLIs only read: no keys loaded, no writes. They apply the same caps as the services. Any number that depends on the AI is printed with the model id and a note that runs can differ.

### The try-it button and the hosted watcher (added 12 Nov 2026)
The site has one button that writes to a chain: it files a prepared fake theft on the demo treasury so a visitor can watch the guard reject it. It is a public endpoint that spends Kaap's own testnet gas, and the watcher gained one public read route to feed it.
- **C32** The button files with a key the network itself limits: an access key of the demo member that can call `add_proposal` on the demo treasury and nothing else. It cannot vote, pay, attach a deposit, add a key or reach another contract, whatever the site's code does or whoever holds the key. What it can file is any kind of request on that one treasury, since the demo member may file every kind: a filed request does nothing until the approvers vote, the guard reads it like any other, and each one costs Kaap a sealed run inside the watcher's daily cap. The site itself files one fixed request and takes nothing from the caller into it, and refuses to sign with any key but the one the setup recorded. Upheld by `scripts/setup-demo-filer.mjs` (makes the key and checks its permission on chain) and `fileOne` in `packages/web/lib/demo.ts`; attacked five ways by `scripts/check-demo-filer.mjs`.
- **C33** A press is bounded by things the caller cannot choose: two presses in ten minutes and six in a day per address, so one address cannot use up the day; one filing in flight at a time in each server process; a 25-second deadline on the filing; and at most 40 filings in any 24 hours, counted from the treasury's own proposals, so the count holds on every host and after every restart. A press from another site's page is refused, because the route needs a header a cross-site page cannot send. What a press costs is Kaap's own: testnet gas for the filing, one sealed run with its AI call, one registry record, and an alert to that treasury's subscribers; never a visitor's or a treasury's funds (`press` in `packages/web/lib/presses.ts`, `fileOne` in `packages/web/lib/demo.ts`, tested in `packages/web/test/limits.test.mjs`).
  Found in review on 12 Nov 2026 and fixed that day: the first version allowed one address 288 presses a day against the day's 40, so one visitor could keep the button dark; the filing had no deadline, so a provider that stopped answering held every later press; and a second press in the moment before a filing became final filed again.
- **C34** `GET /proposal` on the watcher answers only for a DAO it watches, and only with its own fixed words, verdict hashes, finding codes and transaction ids, each checked against its shape before it leaves. Nothing a proposal's author wrote is in the answer. The site checks the same shapes again before it shows them (`proposalView` in `packages/worker/src/status.ts`, `fromWatcher` in `packages/web/lib/demo.ts`).
- **C35** A request is counted against the address it connects from, unless a proxy the operator has named is in front. By default that is a proxy on the same machine, read by the last `X-Forwarded-For` entry, the one it wrote. Behind a host's own proxy, `KAAP_HTTP_PROXY=x-real-ip` reads `X-Real-IP` and nothing else, as one address: a missing, doubled or unreadable value counts against the proxy itself, so a wrong guess makes the limit stricter and never looser. The setting is off by default, because where the port can be reached directly it would let a caller choose its own address. The site has the same switch, `KAAP_SITE_PROXY=x-real-ip`, and without it counts every caller as one. Which header a host overwrites is the host's behaviour and no test in this repository can see it, so `scripts/attack-caller-limit.mjs` attacks the live watcher after each deploy (`clientAddress` in `packages/worker/src/status.ts`, `callerOf` in `packages/web/lib/caller.ts`).
  Found by that attack on 12 Nov 2026, the day the watcher was first hosted: this rule first read the last `X-Forwarded-For` entry behind Railway, Railway passed the caller's own header through, and twelve made-up addresses got twelve separate counts. A caller could have asked past the token and text limits until the treasury's daily cap on sealed runs stopped it; no vote, payment or verdict was within reach. Closed the same hour. `PROOF.md` has the attack's output before and after.
- **C36** Being enrolled earns nothing by itself. Anyone can enrol an account in the guard, so the watcher takes one up only when both providers list it, its code is one of Sputnik DAO's releases, and its policy gives the guard a deciding reject. An account that fails the code check has none of its views read and costs nothing; one that is not armed is judged only once it is; and a watched treasury whose policy change takes the guard out is let go, and its members are told at once. What one account can ask for is bounded: 50 proposal ids a pass, nothing at all from a counter no treasury could have (not a whole number below 2^53, or more than 10,000 past the last id taken up), and `KAAP_MAX_WATCHED_DAOS` treasuries at once (`refreshEnrolled` and `#standing` in `packages/worker/src/worker.ts`, `#settle` in `packages/worker/src/watcher.ts`, the release list in `packages/worker/src/sputnik-releases.json`).
  Found in review on 12 Nov 2026: until then every enrolled account was watched, judged and paid for, and a made-up counter could keep the watcher busy. Not covered: a Sputnik release newer than the list is not watched until the list gains it, which shows on the status page as `not_a_sputnik_dao`.

Not defended, on purpose: the site's routes count an IPv6 caller by address, not by network, and each server process keeps its own counts, so two processes pressed at the same instant can both file. A visitor with seven or more addresses can use up the day's 40 filings, and the button then says so while the recorded run still works. The reads that set the button's bounds and feed its live view go to one RPC provider at a time: a provider that answers short lets a press through that should have waited, and the bound that does not rest on it is the watcher's own cap of 60 sealed runs a day for a treasury. The verdict shown is the registry's, which stores only verdicts the sealed reader signed. The watcher's `GET /status` and `GET /proposal` have no rate bound of their own.

Not upheld yet: the watcher's key is also the key to the sealed reader. Found in review on 12 Nov 2026. The account that sends the watcher's transactions is the account the sealed program is published under on OutLayer, and OutLayer gives a new build of a project the same signing key and text key as the one before. The watcher needs a full-access key of that account, and since 12 Nov that key file is on the watcher's host. Whoever copies it can publish a different reader that signs with the key the guard accepts. They could then have the guard reject honest requests of every enrolled treasury, write verdicts into the registry, and open texts that members sealed to the reader. They could not approve, pay or change a rule, because the guard has no such call, and `kaap verify` fails a verdict whose run was not a build published in this repository; the guard itself checks only the signature. The rule this needs: the key on the host can spend the watcher's gas and nothing else, and the account that can publish a build is held offline, like the guard's owner key. Until the two are split it is a risk Kaap carries, with one treasury enrolled, the demo one, on testnet.

### General standards
1. **Primitives over lists.**
   - One port of Sputnik's `can_execute_action` and `proposal_status`, tested against its source, instead of a hand-made list of "dangerous kinds". It covers what Sputnik allows. It does not cover what a receiver contract does.
   - One NEAR account-id parser for every input. It covers syntax. It does not catch lookalike names; those surface through "never paid before" (C3).
   - The Guard role's list of kinds is the one list we cannot avoid, because Sputnik has no "all except". It is generated from `to_policy_label` in the DAO's own Sputnik version (proposals.rs 125-147), and a test fails when a label is missing. A change in the DAO's code hash re-runs C16.
   - The paste box check is a code-hash predicate. It covers fakes. It does not cover a DAO that upgrades later; C4 catches that.
   - The modelled intent kinds are an allowlist, and anything not on it is critical, so a missing entry produces an alert, not a pass.
   - The proxy has two fixed URLs, not a host filter.
2. **Normalise before you compare.**
   - NEP-413: hash and parse the same bytes.
   - The VoteReject kind is the bytes as read (C5).
   - Amounts go through one bigint parser in base units; floats are never used.
   - Account ids are compared only as values read from the chain, never from Trezu or the AI.
   - One strict JSON parser handles args, `msg` and intent texts. Duplicate keys are a finding.
   - One canonical encoder produces the effects hash.
   - The network is part of every key, because implicit accounts exist on both networks.
   - The AI signature is checked over the exact bytes, never over re-serialised JSON.
3. **Validate outputs like inputs.**
   - The AI answer schema (C10), the notifier's encoding (C24), the on-chain fields (C13) and the proxy's pass-through of raw bytes (C28) are all checked.
   - Before the guard signs, Kaap rebuilds the `act_proposal` arguments and checks receiver, method, action and kind against C15.
   - Logs never hold texts, contacts, keys or tokens.
4. **Fail closed.**
   - A parse error gives unknown, high, and an alert. An AI failure gives "AI unavailable". A failed attestation gives "AI unverified". Disagreeing RPCs hold the vote. A gap in the watcher triggers a backfill.
   - For the guard, "closed" means no vote without a fresh, bound and verified critical verdict, and a loud alert instead. A reject that cannot be undone, cast on a guess, is not the safe default.
   - Limits are set in config and tested: proposal size, args size, JSON depth, actions per proposal, pages of history, AI tokens in and out, a timeout for every outside call, a cap on retries, text size.
   - Defaults: the guard is disarmed until C16 passes, and the member view is off until C25 passes.
5. **Non-goals.** Kaap does not:
   - promise to vote before the approvers; where one approver or one block is enough, it alerts after the fact;
   - reject `remove_member_from_role` proposals, by design, since that is the DAO's way out of Kaap;
   - judge a hash whose text it never received;
   - prove the AI's judgement is right; the attestation proves which model ran in sealed hardware, and physical attacks on that hardware are out of scope;
   - model what an unknown receiver contract does, or what any contract does after the proposal executes;
   - stop a majority of the DAO's own approvers;
   - stop a change to a DAO's own code that does not go through a proposal: a veto acts on proposals only. The watcher sees the DAO's code hash move while a proposal of that DAO is open, judges the open proposals again and lets go of a DAO whose code is no longer a Sputnik release (C4, C36), and `kaap verify` shows the change since a verdict; members get no alert for the code change itself;
   - secure members' wallets or front ends;
   - defend against both RPC providers colluding;
   - follow a cross-chain withdrawal past its quote;
   - attach a guard to paste box verdicts.

---

## Open questions carried from the review
1. Exactly which bytes a NEAR AI response signature covers (C11 recomputes them). Being checked in the R&D brief.
2. Whether the Sputnik factory exposes code hashes for C23 (the census mapped hashes through `get_contracts_metadata`, so likely yes).
3. Whether receiver contracts and `intents.near` reject duplicate JSON keys; until known, duplicates are a finding (C6, standard 2).
4. Whether 1Click refuses a deposit address it did not quote for that DAO (C7).
5. Whether OutLayer wasm fetches RPC itself or is handed its inputs (C20 assumes it is handed them).
