# The site

One Next.js 16 app: the landing page, the check screen, the docs and the check route.

| Path | What it is |
|---|---|
| `/` | The landing page: the watchman film, a real hash-only request, how Kaap works, what it cannot do, and a table of what is live |
| `/check` | Reads one request of any Sputnik DAO on mainnet or testnet and shows what it will really do. No wallet |
| `/docs` | The docs, from the files in `content/docs` |
| `/api/check` | The check as JSON. `GET` with `dao`, `network` and an optional `id`; `POST` to supply the words behind a hash |

## Run it

Node 24 or newer:

```bash
npm install
npm run dev
```

Then open http://localhost:3000. It needs no environment variable and no key.

## Where the numbers come from

Nothing on a screen is typed by hand.

- `/check` and `/api/check` read the chain live, through the command line's own `check`. That code is in `engine/`: one bundled file, `kaap-core` as WebAssembly, and the deployment records. `npm run engine` rebuilds the folder from `packages/cli`, and `engine/BUILD.json` names the commit and the hashes.
- `data/proof.json` is written by `npm run data:proof` from `deployments/testnet.json`, `PROOF.md` and `packages/sealed/AI-EVAL.md`.
- `data/hash-proposal.json` is the demo treasury's request #7 as testnet returned it, written by `npm run data:proposal`.

## The film

The landing film and the three close-ups are rendered in Blender from the scripts in `art/world` at the repository root. The files in `public/world` are their output.

## Hosting

Set the host's root directory to `packages/web`. The build is `next build`, and the route `/api/check` carries the `engine` folder with it (`next.config.ts`).
