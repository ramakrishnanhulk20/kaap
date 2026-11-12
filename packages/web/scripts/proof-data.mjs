// Gathers what the landing page's "what is live" table shows into data/proof.json, so no value
// in that table is typed by hand. It copies from four files in this repository:
//   deployments/testnet.json         the accounts and transactions of the live testnet deploy
//   deployments/demo-hash-text.json  the demo request that shows only a hash, and the text behind it
//   packages/sealed/AI-EVAL.md       the evaluation report, itself written by eval/tools/ai-report.mjs
//   PROOF.md                         the saved output of scripts/prove.mjs: a disguised payment the guard rejected
//
// Run from packages/web:  npm run data:proof
// It stops with an error, and writes nothing, if a line it needs is missing or has changed shape.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

const deploy = JSON.parse(read('deployments/testnet.json'));
const report = read('packages/sealed/AI-EVAL.md');
const demo = JSON.parse(read('deployments/demo-hash-text.json'));
const proofRun = read('PROOF.md');

const need = (value, what) => {
  if (value === undefined || value === null || value === '') throw new Error(`deployments/testnet.json has no ${what}`);
  return value;
};

// One row of the report's "as the guard would act" table: "| <label> | 41 of 54 | 41 of 54 |".
// The first figure is with the AI on, the second with plain code alone.
const guardRow = (label) => {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found = report.match(new RegExp(`^\\| ${escaped} \\| (\\d+) of (\\d+) \\| (\\d+) of (\\d+) \\|$`, 'm'));
  if (!found) throw new Error(`packages/sealed/AI-EVAL.md has no table row "${label}"`);
  const [, withAi, total, plain, plainTotal] = found.map(Number);
  if (total !== plainTotal) throw new Error(`the row "${label}" gives two different totals`);
  return { withAi, plain, total };
};

const split = report.match(/^## Headline: the test split \((\d+) records/m);
if (!split) throw new Error('packages/sealed/AI-EVAL.md has no test split headline');

// The first attack of the saved proof run. Each line of that run ends with the transaction it
// names, as a link to the explorer.
const STOPPED_ID = 1;
const runLine = (start, what) => {
  const found = proofRun.match(new RegExp(`^${start}.*https://testnet\\.nearblocks\\.io/txns/([1-9A-HJ-NP-Za-km-z]{32,44})$`, 'm'));
  if (!found) throw new Error(`PROOF.md has no line for ${what}`);
  return found[1];
};
const took = proofRun.match(new RegExp(`^attack: ([0-9.]+) s from add_proposal to the guard's vote, proposal #${STOPPED_ID} Rejected$`, 'm'));
if (!took) throw new Error('PROOF.md does not say how long the first attack took');
const said = proofRun.match(/^1\. A member of a real Sputnik DAO 3\.2 treasury files planted attack #\d+: "([^"]+)", which in fact pays the lookalike account `([^`]+)`\.$/m);
if (!said) throw new Error('PROOF.md does not describe the first attack');

const contract = (entry, what) => ({
  account: need(entry.account_id, `${what}.account_id`),
  codeSha256: need(entry.code_sha256, `${what}.code_sha256`),
  deployTx: need(entry.deploy_and_init_tx, `${what}.deploy_and_init_tx`),
  keyDeletedTx: need(entry.full_access_key_deleted_tx, `${what}.full_access_key_deleted_tx`),
  accessKeysLeft: need(entry.access_keys_left, `${what}.access_keys_left`),
});

const proof = {
  source:
    'Written by packages/web/scripts/proof-data.mjs from deployments/testnet.json, deployments/demo-hash-text.json, packages/sealed/AI-EVAL.md and PROOF.md. Do not edit by hand.',
  network: need(deploy.network, 'network'),
  deployedAt: need(deploy.deployed_at, 'deployed_at'),
  guard: contract(deploy.guard, 'guard'),
  registry: contract(deploy.registry, 'registry'),
  treasury: {
    ...contract(deploy.dao, 'dao'),
    policyFrom: need(deploy.dao.policy_from?.source, 'dao.policy_from.source'),
    enrolled: need(deploy.dao.enrolment?.enrolled, 'dao.enrolment.enrolled'),
  },
  sealed: {
    project: need(deploy.sealed.project_id, 'sealed.project_id'),
    signingKey: need(deploy.sealed.signing_key, 'sealed.signing_key'),
    attestedRunTx: need(deploy.sealed.attested_run_tx, 'sealed.attested_run_tx'),
    attestationUrl: need(deploy.sealed.attestation_url, 'sealed.attestation_url'),
  },
  // The text behind the demo treasury's hash-only request, so the check page can offer it.
  demoText: {
    dao: need(demo.dao, 'demo dao'),
    proposalId: need(demo.proposal_id, 'demo proposal_id'),
    message: need(demo.message, 'demo message'),
    nonce: need(demo.nonce_base64, 'demo nonce_base64'),
    recipient: need(demo.recipient, 'demo recipient'),
    standard: need(demo.standard, 'demo standard'),
  },
  // A payment that said one thing and did another, rejected by the guard on testnet.
  stopped: {
    record: 'PROOF.md',
    proposalId: STOPPED_ID,
    said: said[1],
    paid: said[2],
    seconds: Number(took[1]),
    filedTx: runLine(`filed:\\s+proposal #${STOPPED_ID} by`, 'the filing'),
    sealedTx: runLine('sealed job:', 'the sealed job'),
    recordedTx: runLine('recorded:', 'the registry record'),
    vetoTx: runLine(`veto:.*\\{"id":${STOPPED_ID},"action":"VoteReject"`, "the guard's vote"),
  },
  // What the "try it yourself" button files, and the public half of the key it files with: a key
  // that can call add_proposal on the demo treasury and nothing else (scripts/setup-demo-filer.mjs).
  tryIt: deploy.demo_filer?.public_key
    ? {
        account: need(deploy.demo_filer.account_id, 'demo_filer.account_id'),
        publicKey: deploy.demo_filer.public_key,
        addKeyTx: need(deploy.demo_filer.add_key_tx, 'demo_filer.add_key_tx'),
        description: need(deploy.demo_filer.description, 'demo_filer.description'),
        kind: need(deploy.demo_filer.kind, 'demo_filer.kind'),
      }
    : null,
  // The always-on watcher, once it is hosted and its record is in deployments/testnet.json.
  watcher: deploy.watcher?.url ? { url: deploy.watcher.url, since: need(deploy.watcher.since, 'watcher.since'), host: need(deploy.watcher.host, 'watcher.host') } : null,
  evaluation: {
    report: 'packages/sealed/AI-EVAL.md',
    records: Number(split[1]),
    caught: guardRow('Should be vetoed: caught'),
    wronglyVetoed: guardRow('Should not be vetoed: wrongly vetoed'),
  },
};

const out = new URL('../data/proof.json', import.meta.url);
mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
writeFileSync(out, `${JSON.stringify(proof, null, 2)}\n`);
console.log(`wrote ${fileURLToPath(out)}`);
console.log(
  `evaluation: ${proof.evaluation.caught.withAi} of ${proof.evaluation.caught.total} caught, ` +
    `${proof.evaluation.wronglyVetoed.withAi} of ${proof.evaluation.wronglyVetoed.total} wrongly vetoed, ` +
    `${proof.evaluation.records} records`,
);
