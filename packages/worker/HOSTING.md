# Where the Kaap worker runs during judging

The worker is the part of Kaap that never sleeps. It watches every enrolled treasury, asks the sealed
program to judge each new proposal, records the verdict and sends the guard its veto. If it stops,
the guard stops too, because the guard can only veto what the worker hands it. HACKATHON.md Q-012
asks hosted demos to stay up until 18 Nov 2026, ideally 25 Nov 2026, so whatever we pick has to run
unattended from the day it starts until at least 25 Nov.

Prices below were read from each provider's public pricing page on 29 Oct 2026. Nothing has been
signed up for. Ram picks.

## What the worker needs from a host

- Node 24 and one long-running process. No build step at run time.
- A small disk that survives restarts, for its SQLite file (well under 100 MB for the demo).
- The worker account's key as a file only it can read (`chmod 600`), never pasted into a dashboard
  or an environment variable. A plain virtual machine makes that easy: the file is copied once
  over SSH.
- Outbound HTTPS to two RPC providers and the NEAR testnet. No inbound port for this order; the
  public `/status` page in WO-06b will need one HTTPS port.
- Memory: about 100 to 150 MB for the process. 512 MB of RAM is enough, 1 GB is comfortable.

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
