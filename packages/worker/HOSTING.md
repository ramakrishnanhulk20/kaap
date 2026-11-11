# Where the Kaap worker runs during judging

The worker is the part of Kaap that never sleeps. It watches every enrolled treasury, asks the sealed
program to judge each new proposal, records the verdict and sends the guard its veto. If it stops,
the guard stops too, because the guard can only veto what the worker hands it. HACKATHON.md Q-012
asks hosted demos to stay up until 18 Nov 2026, ideally 25 Nov 2026, so whatever we pick has to run
unattended from the day it starts until at least 25 Nov.

Prices below were read from each provider's public pricing page on 29 Oct 2026. Ram picked option
A, the Google Cloud e2-micro, on 2 Nov 2026. How it serves the public `/status` page safely is in
the last section.

## What the worker needs from a host

- Node 24 and one long-running process. No build step at run time.
- A small disk that survives restarts, for its SQLite file (well under 100 MB for the demo).
- The worker account's key as a file only it can read (`chmod 600`), never pasted into a dashboard
  or an environment variable. A plain virtual machine makes that easy: the file is copied once
  over SSH.
- Outbound HTTPS to two RPC providers, the NEAR testnet and Telegram. Inbound, only HTTPS (443,
  plus 80 for the certificate) to a proxy in front of the public `/status` page; the worker's own
  port stays on loopback.
- Memory: about 100 to 150 MB for the process. 512 MB of RAM is enough, 1 GB is comfortable.
- Two settings for the AI secret, beside the others in `.env`: `KAAP_AI_SECRETS_ACCOUNT`, the NEAR
  account that owns the OutLayer secret row holding the NEAR AI key (no default; left empty, runs
  carry no key and verdicts have no AI), and `KAAP_AI_SECRETS_PROFILE`, the row's profile name
  (default `near-ai`).

## Requests a day, times the price

The worker asks each enrolled treasury for its proposal counter once a second on each of two
providers, and once every 15 seconds re-reads the policy, the open proposals and the code of every
contract they call, also on both providers (that is how it notices a change that must re-run the
judge). These numbers are what the code in `src/` actually does, per enrolled treasury:

| Read | How often | Requests a day |
|---|---|---|
| Proposal counter, 2 providers | every second | 172,800 |
| Policy, open proposals, one called contract (the demo pays plain NEAR, so only the treasury itself), 2 providers | every 15 s | 34,560 |
| Enrolled list (2 providers) and the guard's key (1 provider), shared by all treasuries | every 60 s | 4,320 |
| One judged proposal: the sealed run, the record, the veto and their status reads | per proposal, about 45 | 2,250 at 50 proposals a day |
| **Total for the demo treasury at 50 proposals a day** | | **about 214,000 a day, 6.4 million a month, half on each provider** |

| Provider | Plan that covers the demo | Price | Cost for the demo |
|---|---|---|---|
| FastNEAR testnet RPC, keyless | free, no published quota; on 20 Oct it served 1 request a second on testnet with no refusals (docs/RD-BRIEF.md Q1) | paid plans start at $69 a month for 10 million requests | $0 |
| dRPC public testnet endpoint | Free plan: public nodes, up to about 10 million requests a month, 100 a second | Pay as You Go $6 per million beyond that | $0 (3.2 million a month is inside the free plan) |
| OutLayer sealed runs | testnet, paid in testnet NEAR | 0.001 NEAR base fee plus 0.0000001 NEAR per millisecond run, so 0.00114 NEAR per run, plus 0.00078 NEAR gas (packages/sealed/RUNS.md) | 0 dollars; testnet NEAR from the faucet |

What one proposal costs the worker account in testnet NEAR (PROOF-M1.md, measured): judging
0.0019, recording 0.0067 (mostly the registry storage it keeps forever), and a veto 0.0008. So an
honest proposal costs about 0.0086 and a stopped attack about 0.0094. At 50 proposals a day that
is about 0.45 testnet NEAR a day. The worker holds 9.92 testnet NEAR today (read 29 Oct 2026), which
lasts about 22 days at that rate, so it needs one top-up before 25 Nov. The daily caps in the
config stop it from spending more than 1 testnet NEAR a day whatever happens. WO-06b adds the
low-balance alert.

Scaling note for later, not for the demo: each extra treasury adds about 104,000 requests a day
per provider, about 3.1 million a month. On mainnet that means a paid RPC plan after the first
two or three treasuries, roughly $19 a month per treasury per provider at dRPC's Pay as You Go
rate. Mainnet sealed runs are priced in dollars: $0.001 base fee per run (OutLayer's
`/public/pricing`, read 29 Oct 2026).

## The options

| | Monthly cost | How it stays up to 25 Nov | The key | What Ram does |
|---|---|---|---|---|
| **A. Google Cloud e2-micro** (one VM, us-west1, us-central1 or us-east1) | about $3.65: the VM and its 30 GB disk are in Google's free tier; the public IPv4 address costs $0.005 an hour | a standard (not spot) VM runs until deleted; the worker is a systemd service set to restart on any exit and to start on boot | copied once over SSH into `~/.near-credentials/testnet/`, mode 600 | sign in to Google Cloud (AGENT-RETROS.md says an earlier project ran a bot there with pm2 and systemd; whether that account is still active is not checked) and approve the VM; I install `gcloud` here again (it is no longer on this machine) and do the rest |
| **B. DigitalOcean Basic droplet, 1 GB** | $6.00 ($4.00 for 512 MB) | the same systemd service; billed by the hour up to the monthly price, deleted after judging | the same | create an account with a card, create the droplet, add my SSH key |
| **C. Hetzner Cloud, smallest Regular Performance server** | from €6.49 excluding VAT (the cheaper Cost-Optimized line, from €5.99, says "currently not available") | the same systemd service; billed by the hour up to the monthly cap | the same | create an account (Hetzner may ask for ID), create the server, add my SSH key |
| **D. Fly.io, shared-cpu-1x, 512 MB, 1 GB volume** | about $3.84 ($3.69 machine, $0.15 volume); no free tier | a Machine with automatic stop turned off and a restart policy of always | stored as a Fly secret and mounted as a file | create an account with a card; I write a Dockerfile and `fly.toml`, Ram runs `fly deploy` once |
| E. Railway Hobby (used for Hearth) | $5 minimum, which covers this worker's usage | always-on service, restarts on crash | Railway has no secret files, so the key would have to sit in an environment variable, which breaks the key-in-a-file rule | not recommended for that reason |
| F. Ram's own PC, inside WSL | $0 | only while the PC stays on and awake for four weeks, through Windows updates and WSL's idle shutdown | already there | not recommended: one reboot and the guard goes quiet |

## Recommendation

Option A, Google Cloud e2-micro. It is the cheapest option that keeps the key as a file (about
$3.65 a month, all of it the IP address), Ram has used Google Cloud before, and the same setup
(systemd, restart always, start on boot) survived a VM reboot on that earlier project. If the
free tier is not available on his account, option B at $6 is the same setup on another provider.

Whichever he picks, on day one the setup also adds a daily copy of the SQLite file off the
machine, a reboot test (restart the VM and check the worker comes back by itself), and the
balance check above, so nobody has to remember to ask whether the guard is still awake.

## Serving /status safely on the e2-micro

The worker's small web face (`GET /status`, `POST /subscribe`) listens on `127.0.0.1:8787` only,
which is what `KAAP_HTTP_HOST` and `KAAP_HTTP_PORT` default to. Keep it that way on the VM. The
public reaches it through Caddy, an HTTPS server on the same VM that gets and renews its own
certificate:

1. Reserve the VM's external IP address as static (VPC network, IP addresses), so it survives a
   stop and start, and point a DNS name at it with an A record, for example `status.example.org`
   on a domain Ram controls.
2. In the VM's firewall, allow TCP 80 and 443 from anywhere. Caddy needs 80 to get its certificate
   and to send plain HTTP visitors to HTTPS. Port 8787 is never opened.
3. Install Caddy from its official Debian package (caddyserver.com/docs/install), put this in
   `/etc/caddy/Caddyfile`, then run `sudo systemctl reload caddy`:
   ```
   status.example.org {
       reverse_proxy 127.0.0.1:8787
   }
   ```
4. From any other machine, `curl https://status.example.org/status` returns the health report.

### The rate limit behind the proxy

`POST /subscribe` gives each address 10 tokens an hour (`TOKENS_PER_ADDRESS_HOUR` in
`src/main.ts`), counted on an address the caller cannot choose. Behind the proxy, every request
reaches the worker from 127.0.0.1. Counted by that address, everyone in the world would share one
count of 10, and one person could use it up for all the others.

The fix is built and tested, not left as a step: the worker trusts exactly one proxy hop. A
request whose connecting address is loopback (127.0.0.0/8 or ::1) came through the proxy on the
same machine, so the worker counts the last address in its `X-Forwarded-For` header, the one the
proxy added for the client it was talking to. Anything a client wrote earlier in that header is
ignored. A request from any other address is counted by that address, and its header is ignored.
A missing or unreadable header counts against the proxy's own address, which only makes the limit
stricter. Code: `clientAddress` in `src/status.ts`. Test: "behind the HTTPS proxy on the same
machine, POST /subscribe counts each client by the address the proxy saw" in
`test/health.test.ts`.

Two conditions keep this true on the VM:

- The proxy must add its client's address at the end of `X-Forwarded-For`. Caddy's
  `reverse_proxy` does that by itself. nginx does not: it passes a client's own header through
  untouched unless its config says `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`,
  and without that line anyone could pick their own count.
- Nothing else on the VM may pass outside traffic to port 8787, since the worker treats every
  loopback connection as the proxy.

Check after setup, from a laptop, with an enrolled DAO's account id in place of `<dao>`:

```
for i in $(seq 1 11); do curl -s -o /dev/null -w '%{http_code} ' -X POST https://status.example.org/subscribe -H 'content-type: application/json' -H "x-forwarded-for: 198.51.100.$i" -d '{"dao":"<dao>"}'; done; echo
```

Ten `200` and then one `429` shows that a made-up header buys nothing: all eleven requests count
against the laptop's real address. Each `200` creates an unused subscription token that expires
after 15 minutes.

Not covered: someone with many addresses, such as an IPv6 range, gets 10 tokens an hour per
address. A token only lets a chat subscribe to alerts about facts that are public on chain, so
this limit protects the worker from waste, not a secret.

## Member texts: GET /text-key and POST /texts

NEAR Business treasuries pay through sign requests that carry only a hash, and the text behind the
hash sits on their own server. A member who has it can hand it to Kaap without the worker ever
reading it: the text is sealed so that only the sealed program can open it, and the explanation
comes back sealed so that only that member can open it. Both routes listen beside `/status`, on the
same port, behind the same proxy.

`GET /text-key` returns the `text_key` object in `deployments/<network>.json`, exactly as stored and
with the same headers as `/status`: `key` (the sealed program's X25519 key, 64 hex), `signature`
(the verdict key's, over `kaap-text-key-v1\n` followed by the 32 key bytes), `public_key`, `run_tx`
and `build`. The program derives this key per caller, so it comes from one `{"v":1,"op":"pubkey"}`
run the worker account signed; a key from anyone else's run would not open in the worker's runs.
Members check the signature against the guard's `accepted_key` before they seal anything. With no
`text_key` in the file the route answers 404 `no_text_key` and the worker logs `text_key_missing`
at boot; when the guard's key no longer signed it, the worker logs `text_key_unverified`.

`POST /texts` takes exactly `{"dao": <account>, "proposal_id": <whole number>, "text_ciphertext":
<base64>, "reply_key": <64 hex>}`, at most 64 KiB, on the worker's own network. Every answer is
JSON with a fixed word, and none repeats anything from the request:

| Answer | When |
|---|---|
| 200 `{"status":"judged","run_tx","risk","floor","findings","ai_status","model_id","explanation":"sealed:...","veto":"started" or "not_needed"}` | the sealed run answered and its verdict checked out like every verdict; a veto it calls for has started down the usual veto path, and the answer does not wait for it to land |
| 400 `bad_request` | any shape fault: a missing or unknown field, a reply key that is not 32 usable bytes, a ciphertext that is not canonical base64 or is over 48 KiB once decoded, or a run input over the 32 KiB the sealed program reads (in practice a ciphertext over about 24 KiB) |
| 404 `dao_not_watched` | the worker does not watch the DAO |
| 409 `proposal_not_open` | the proposal is not InProgress, or the two RPC providers do not agree it is |
| 429 `too_many_requests`, with `retry-after` | the client address sent `KAAP_TEXTS_PER_ADDRESS_HOUR` texts in the past hour (default 3, 1 to 100), counted the way `/subscribe` counts tokens behind the proxy |
| 503 `over_budget` | the daily caps refuse the run |
| 502 `{"error":"run_failed","reason":...}` | the run gave no verdict: the sealed program's own fixed reason when it refused or held the run, else `no_answer` or `failed` |

What it costs and how long it takes. Each text is one sealed run under the same daily caps, attempts
and window as any other run. On 11 Nov 2026 a text for a planted proposal on the demo treasury cost
0.0042 testnet NEAR to judge, then 0.0008 for the veto and 0.0058 for the registry record. The
answer waits for the run, about 40 seconds, and for any judgement of the same proposal already
running: that text was answered after 86 seconds because the worker was judging the new proposal
without its text first. At worst, with OutLayer not answering, the run alone takes two windows of
220 blocks, about four and a half minutes, and a judgement it waits for can take as long again.
The proxy must let a request run that long. nginx cuts it at 60
seconds unless `proxy_read_timeout` is raised; check whichever proxy is used by sending one text
after setup and watching the answer arrive.

What the worker keeps. The worker only ever holds the ciphertext, for the one request. Neither it
nor the reply key is logged or stored: the log line for a text names the DAO, the proposal, the run
and the result, and a run that carries a text keeps no signed bytes in the database, only its hash
and what it reserved under the caps. Not covered: a worker that stops in the middle of a text run
does not send it again after a restart; the member sends the text again. A re-judge of a text's
verdict, after the proposal's state moves, runs without the text for the same reason.
