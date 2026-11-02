// The command line, read into one command. Anything unexpected is a usage error, never a guess: an
// unknown flag, a missing DAO, an id that is not a whole number, a network other than mainnet or
// testnet, a worker address that is not https.

import { parseArgs, type ParseArgsConfig } from 'node:util';

import type { Network } from './rpc.js';

export type Command =
  | { command: 'check'; dao: string; id: number | null; network: Network; json: boolean }
  | { command: 'eval' }
  | { command: 'census'; sample: number | null }
  | { command: 'verify'; dao: string; id: number; network: Network }
  | { command: 'enroll'; dao: string; network: Network }
  | { command: 'arming'; dao: string; network: Network }
  | { command: 'seal-text'; dao: string; id: number; file: string; network: Network }
  | { command: 'subscribe'; dao: string; worker: string }
  | { command: 'help' }
  | { command: 'version' };

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export const USAGE = `kaap: check NEAR DAO proposals with no keys, and rerun Kaap's numbers

  kaap check <dao> [id] [--network mainnet|testnet] [--json]
      Reads one proposal of a Sputnik DAO (the latest when no id is given) from two RPC
      providers at one final block and prints what kaap-core makes of it: effects, findings
      with severities, risk floor, description check, must_veto and veto_allowed.
  kaap verify <dao> <id> [--network mainnet|testnet]
      Checks the verdict Kaap's registry holds for one proposal: the sealed signature against
      the guard's key, the hashes kaap-core recomputes, the sealed run on chain and OutLayer's
      attestation of it, and the run that printed the guard's key. Prints each check as pass
      or fail.
  kaap enroll <dao> [--network mainnet|testnet]
      Prints the proposals a member files to put the DAO under Kaap's guard, who files and who
      approves each, Kaap's own decoding of each draft, and the cost.
  kaap arming <dao> [--network mainnet|testnet]
      Whether Kaap's guard is armed on the DAO's live policy: the kinds it cannot reject, any
      rights beyond rejecting, and the votes the approvers need per kind.
  kaap seal-text --dao <dao> --id <id> --file <text> [--network mainnet|testnet]
      Encrypts the text behind a proposal's hash to Kaap's sealed program. Not yet available.
  kaap subscribe <dao> --worker <https url>
      Asks Kaap's worker for a one-time Telegram token for the DAO's alerts.
  kaap eval
      Runs kaap-core over the public answer key (eval/real, eval/planted) and prints the
      agreement tables. No network.
  kaap census [--sample N]
      Reruns the DAO census headline numbers from mainnet, at most 5 requests a second.
      --sample N scans N DAOs instead of all of them.
  kaap help | --help
  kaap --version

For check, verify, enroll, arming and seal-text the network is testnet for an account ending
in .testnet and mainnet otherwise, unless --network says otherwise.

Nothing here holds a key or sends a transaction.`;

const ID = /^\d{1,16}$/;

function wholeNumber(text: string, what: string, min: number, max: number): number {
  if (!ID.test(text) || Number(text) < min || Number(text) > max) throw new UsageError(`${what} must be a whole number from ${min} to ${max}`);
  return Number(text);
}

const printable = (text: string) => text.replace(/[^\x20-\x7e]/g, '?').slice(0, 120);

function parsed(args: string[], options: NonNullable<ParseArgsConfig['options']>) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (e) {
    throw new UsageError(printable(e instanceof Error ? (e.message.split('\n')[0] ?? 'bad arguments') : 'bad arguments'));
  }
}

function networkOf(value: unknown): Network {
  if (value !== 'mainnet' && value !== 'testnet') throw new UsageError('--network must be mainnet or testnet');
  return value;
}

/** The named network, else the one the account's own name places it on. */
function networkFor(value: unknown, dao: string): Network {
  return value === undefined ? (dao.endsWith('.testnet') ? 'testnet' : 'mainnet') : networkOf(value);
}

function oneDao(positionals: string[], command: string, example: string): string {
  const [dao, ...extra] = positionals;
  if (dao === undefined || dao === '') throw new UsageError(`kaap ${command} needs a DAO account, for example: kaap ${command} ${example}`);
  if (extra.length) throw new UsageError(`kaap ${command} takes one DAO`);
  return dao;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** The worker's address: https, or plain http only to this machine (a worker run locally). No
 *  user name, password, query or fragment, since the CLI adds the path itself. */
function workerUrl(text: string): string {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new UsageError('--worker must be a URL, for example https://kaap.example.com');
  }
  const local = url.protocol === 'http:' && LOOPBACK.has(url.hostname);
  if (url.protocol !== 'https:' && !local) throw new UsageError('--worker must be an https URL (plain http only for 127.0.0.1 or localhost)');
  if (url.username || url.password || url.search || url.hash) throw new UsageError('--worker must not carry a user name, password, query or fragment');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export function parse(argv: string[]): Command {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return { command: 'help' };
    case '--version':
      return { command: 'version' };
    case 'check': {
      const { values, positionals } = parsed(rest, { network: { type: 'string' }, json: { type: 'boolean', default: false } });
      const [dao, id, ...extra] = positionals;
      if (dao === undefined || dao === '') throw new UsageError('kaap check needs a DAO account, for example: kaap check example.sputnik-dao.near 12');
      if (extra.length) throw new UsageError('kaap check takes a DAO and at most one proposal id');
      const network = networkFor(values['network'], dao);
      return { command: 'check', dao, id: id === undefined ? null : wholeNumber(id, 'the proposal id', 0, Number.MAX_SAFE_INTEGER), network, json: values['json'] === true };
    }
    case 'verify': {
      const { values, positionals } = parsed(rest, { network: { type: 'string' } });
      const [dao, id, ...extra] = positionals;
      if (dao === undefined || dao === '' || id === undefined) throw new UsageError('kaap verify needs a DAO account and a proposal id, for example: kaap verify example.sputnik-dao.near 12');
      if (extra.length) throw new UsageError('kaap verify takes a DAO and one proposal id');
      return { command: 'verify', dao, id: wholeNumber(id, 'the proposal id', 0, Number.MAX_SAFE_INTEGER), network: networkFor(values['network'], dao) };
    }
    case 'enroll':
    case 'arming': {
      const { values, positionals } = parsed(rest, { network: { type: 'string' } });
      const dao = oneDao(positionals, command, 'example.sputnik-dao.near');
      return { command, dao, network: networkFor(values['network'], dao) };
    }
    case 'seal-text': {
      const { values, positionals } = parsed(rest, { dao: { type: 'string' }, id: { type: 'string' }, file: { type: 'string' }, network: { type: 'string' } });
      const { dao, id, file } = values;
      if (positionals.length) throw new UsageError('kaap seal-text takes only --dao, --id, --file and --network');
      if (typeof dao !== 'string' || dao === '' || typeof id !== 'string' || typeof file !== 'string' || file === '') {
        throw new UsageError('kaap seal-text needs --dao, --id and --file, for example: kaap seal-text --dao example.sputnik-dao.near --id 12 --file text.json');
      }
      return { command: 'seal-text', dao, id: wholeNumber(id, '--id', 0, Number.MAX_SAFE_INTEGER), file, network: networkFor(values['network'], dao) };
    }
    case 'subscribe': {
      const { values, positionals } = parsed(rest, { worker: { type: 'string' } });
      const dao = oneDao(positionals, 'subscribe', 'example.sputnik-dao.near --worker https://kaap.example.com');
      const worker = values['worker'];
      if (typeof worker !== 'string' || worker === '') throw new UsageError('kaap subscribe needs --worker <https url>, the address of the Kaap worker that watches the DAO');
      return { command: 'subscribe', dao, worker: workerUrl(worker) };
    }
    case 'eval': {
      const { positionals } = parsed(rest, {});
      if (positionals.length) throw new UsageError('kaap eval takes no arguments');
      return { command: 'eval' };
    }
    case 'census': {
      const { values, positionals } = parsed(rest, { sample: { type: 'string' } });
      if (positionals.length) throw new UsageError('kaap census takes only --sample N');
      const sample = values['sample'];
      return { command: 'census', sample: typeof sample === 'string' ? wholeNumber(sample, '--sample', 1, 100_000) : null };
    }
    default:
      throw new UsageError(`unknown command: ${printable(command)}`);
  }
}
