import proof from '@/data/proof.json';
import { accountLink, transactionLink } from '@/lib/links';

// Pieces a docs page drops in where it needs a live value. Each reads data/proof.json, which
// scripts/proof-data.mjs writes from the deploy record, the evaluation report and PROOF.md.

const { guard, registry, treasury, sealed, stopped, evaluation } = proof;

function Tx({ hash, children }: { hash: string; children: string }) {
  return (
    <a href={transactionLink(hash)} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

/** Every deployed piece on testnet: its account, its code and the transactions that set it up. */
export function LiveAddresses() {
  const rows = [
    { what: 'Guard contract', entry: guard },
    { what: 'Registry contract', entry: registry },
    { what: 'Demo treasury (Sputnik DAO)', entry: treasury },
  ];
  return (
    <table>
      <thead>
        <tr>
          <th>What</th>
          <th>Account on {proof.network}</th>
          <th>Code (sha256)</th>
          <th>Set up by</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ what, entry }) => (
          <tr key={what}>
            <td>{what}</td>
            <td>
              <a href={accountLink(entry.account)} target="_blank" rel="noreferrer">
                <code>{entry.account}</code>
              </a>
              <br />
              {entry.accessKeysLeft === 0 ? 'no access key left' : `${entry.accessKeysLeft} access keys left`}
            </td>
            <td>
              <code>{entry.codeSha256}</code>
            </td>
            <td>
              <Tx hash={entry.deployTx}>deploy</Tx>, <Tx hash={entry.keyDeletedTx}>key deleted</Tx>
            </td>
          </tr>
        ))}
        <tr>
          <td>Sealed program</td>
          <td>
            <code>{sealed.project}</code>
            <br />
            on OutLayer
          </td>
          <td>
            signs with <code>{sealed.signingKey}</code>
          </td>
          <td>
            <a href={sealed.attestationUrl} target="_blank" rel="noreferrer">
              attestation of a run
            </a>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

/** The four transactions of the disguised payment the guard rejected, in order. */
export function StoppedTheft() {
  const steps = [
    { name: 'A member files the request', hash: stopped.filedTx },
    { name: 'The sealed program reads it and signs a verdict', hash: stopped.sealedTx },
    { name: 'The verdict is recorded in the registry', hash: stopped.recordedTx },
    { name: 'The guard votes to reject', hash: stopped.vetoTx },
  ];
  return (
    <>
      <p>
        Request #{stopped.proposalId} on the demo treasury said &ldquo;{stopped.said}&rdquo; and in fact paid the lookalike
        account {stopped.paid} The guard&apos;s vote landed {stopped.seconds} seconds after the request was filed.
      </p>
      <ol>
        {steps.map((step) => (
          <li key={step.hash}>
            {step.name}: <Tx hash={step.hash}>{`${step.hash.slice(0, 10)}...`}</Tx>
          </li>
        ))}
      </ol>
    </>
  );
}

/** The headline counts of the evaluation's test split, as the guard would act. */
export function EvaluationNumbers() {
  const { caught, wronglyVetoed, records } = evaluation;
  return (
    <table>
      <thead>
        <tr>
          <th>On {records} test requests</th>
          <th>With the AI</th>
          <th>Plain code alone</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Should be vetoed, and the guard would veto</td>
          <td>
            {caught.withAi} of {caught.total}
          </td>
          <td>
            {caught.plain} of {caught.total}
          </td>
        </tr>
        <tr>
          <td>Should not be vetoed, and the guard would veto</td>
          <td>
            {wronglyVetoed.withAi} of {wronglyVetoed.total}
          </td>
          <td>
            {wronglyVetoed.plain} of {wronglyVetoed.total}
          </td>
        </tr>
      </tbody>
    </table>
  );
}
