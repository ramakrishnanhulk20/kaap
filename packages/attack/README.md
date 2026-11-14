# Attack suite

91 cases run on NEAR testnet against Kaap's guard and registry: 75 attempts to make them do something they should not, 10 controls, and 6 doors that are open by design. Each one prints a single line: what was tried, what should happen, what did happen, and the transaction. The newest full run is saved in [RESULTS.md](RESULTS.md).

```
ATTACK 1.3: the verdict that was just used, sent again -> EXPECTED ERR_REPLAY -> OBSERVED refused with ERR_REPLAY; checked: the request still carries one vote; https://testnet.nearblocks.io/txns/... -> PASS
```

## What is attacked

Copies, not the live contracts. `lib/test-set.mjs` deploys a second guard and a second registry and three throwaway Sputnik 3.2 treasuries: one enrolled, one enrolled in strict mode, one that never enrols.

The copies run the same code as the live contracts. That is checked twice. When the copies are made, the wasm's sha256 must equal the one `deployments/testnet.json` records. At the start of every attack file, the code hash the chain reports for each copy must equal the one it reports for the live contract that day, or the file stops before sending anything.

There are two reasons for copies.

1. The copies trust a public test key. Many of these attacks need a verdict that is correctly signed and still wrong, such as "critical on the AI's word alone". The live guard trusts only the sealed program's key, and that key never signs such a verdict, so the live guard cannot be asked the question at all. With a test key the suite plays the worst signer there is: one that will sign anything.
2. The live deployment is what the public demo runs on. No attack file sends it a transaction. The one function that sends transactions, `send` in `lib/chain.mjs`, refuses any signer or receiver whose name is not one the suite gives its own accounts, and sends nothing unless the node answers for testnet.

## The six files

| File | What it tries | Cases |
|---|---|---|
| `attacks/01-replay.mjs` | One verdict used twice, pointed at another request or treasury, sent after it expired, sent for another network, recorded twice, or spent by a stranger with too little gas | 11 |
| `attacks/02-wrong-signer.mjs` | Signatures by keys the contracts do not trust, including the AI model's own signature from a real run; malformed signatures and verdicts; a new key trusted before its 24-hour wait is over | 20 |
| `attacks/03-enrolment.mjs` | A treasury that never enrolled, a verdict naming another guard, and what a stranger gains by enrolling its own account | 13 |
| `attacks/04-veto-rule.mjs` | Correctly signed verdicts that must still not reject a request: critical on the AI's word alone, on an unread hash alone, on an unverified AI answer, and strict mode asked to do more than it should | 15 |
| `attacks/05-kind-mismatch.mjs` | A verdict handed in with another request's content, respelled content, content with `"action":"VoteApprove"` appended, oversized content | 9 |
| `attacks/06-access.mjs` | Every changing method called by an account with no right to it; malformed keys; unpaid, oversized, malformed and wrong-network records; an old verdict recorded late to roll the registry back | 23 |

A line marked `CONTROL` is the honest path: it shows the same verdict or call succeeds when it should, so a refusal next to it means something. A line marked `BY DESIGN` is a door that is open on purpose, such as anyone enrolling their own account, with what walking through it changes. There are 10 controls and 6 by-design lines among the 91.

## Run it

On Linux or inside WSL, with Node 24, after `npm ci` at the repository root and `bash packages/core-wasm/build.sh`:

```bash
node scripts/attack-all.mjs
```

That runs the six files in order, takes about nine minutes, and rewrites `RESULTS.md`. One file alone:

```bash
node packages/attack/attacks/04-veto-rule.mjs
```

The callers are throwaway accounts the suite makes through the testnet faucet. Their keys stay in `~/.near-credentials/testnet` on the machine that made them. A full run burns well under 1 testnet NEAR of gas.

### On your own machine

Several attacks are the copy's owner making a mistake, and only the owner's key can sign those. The copies recorded in `testnet.json` are owned by an account whose key is on our machine, so to run the suite yourself, make copies of your own first. You do not need to build the contracts: the setup takes the live contracts' code from the chain and checks its hash.

```bash
export KAAP_ATTACK_SET=$HOME/kaap-attack-set.json
node packages/attack/lib/test-set.mjs
node scripts/attack-all.mjs
```

The setup makes up to six accounts through the faucet (the copies' owner, the two copies and the three treasuries) and the first run makes one more, the caller. The faucet limits how many accounts one address may make in a day; on 14 Nov 2026 it stopped ours after twelve. The setup can be run again later and carries on from where it stopped. The first time, it also downloads the Sputnik DAO 3.2 code from mainnet by its hash, which needs `curl` and `python3`.

## What the suite does not cover

- **The live guard and registry themselves.** They are never sent a transaction here. What ties these results to them is the code hash. [PROOF.md](../../PROOF.md) holds the runs made on the live deployment, including a replay it refused.
- **Everything that is not a contract.** The watcher, the sealed program, the command line and the site are not attacked by these files. Two other scripts attack parts of them: `scripts/attack-site-limits.mjs` (the site's per-caller limits) and `scripts/attack-sealed-owner.mjs` (owner-only calls on the sealed program's project).
- **A key change after its 24 hours.** The suite announces a key change and shows that nothing obeys the new key early. It then cancels the change and never waits a day to see it apply.
- **The owner transfer carried through.** A stranger is refused both halves. Handing a copy to a new owner would break the other files, so the full transfer is left to the contracts' own tests.
- **A hostile contract enrolled as a treasury.** Here the enrolled stranger is a plain account. A contract that answers the guard's vote with calls of its own has not been run against the guard, here or in the contracts' own tests. The reasons it should gain nothing: the guard marks a verdict used before it calls out, its call carries no deposit, and its callback only reads whether the vote landed ([threat model](../../docs/security/threat-model.md), C15). That is an argument, not a run.
- **A real request with a signed hash.** The strict-mode cases hand the guard verdicts that list an unread hash, about requests that are plain transfers. The guard reads the verdict and not the request's meaning, so that tests its rule, but no sign request was filed here.
- **The limits from the accepting side.** A veto with 899 Tgas, a request one byte over 217 KiB and a verdict one byte over 1,024 bytes are refused here. That the largest request the guard accepts still gets its vote with 900 Tgas is measured in a sandbox (`packages/contracts/GAS.md`), not on testnet.
- **Two verdicts read at the same block.** The registry counts the one recorded later as the latest, on purpose. Case 6.23 records a verdict read at an older block and shows it never becomes the latest. It does not try a tie.
- **Two vetoes racing in one block.**
- **Treasury contracts other than Sputnik 3.2.**
- **Mainnet.** Nothing here runs there.

This is a self-audit: the people who wrote the contracts wrote the attacks. No outside auditor has reviewed either.
