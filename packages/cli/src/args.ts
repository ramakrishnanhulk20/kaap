// The command line, read into one of four commands. Anything unexpected is a usage error, never a
// guess: an unknown flag, a missing DAO, an id that is not a whole number, a network other than
// mainnet or testnet.

import { parseArgs, type ParseArgsConfig } from 'node:util';

import type { Network } from './rpc.js';

export type Command =
  | { command: 'check'; dao: string; id: number | null; network: Network; json: boolean }
  | { command: 'eval' }
  | { command: 'census'; sample: number | null }
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
      The network is mainnet unless --network says otherwise.
  kaap eval
      Runs kaap-core over the public answer key (eval/real, eval/planted) and prints the
      agreement tables. No network.
  kaap census [--sample N]
      Reruns the DAO census headline numbers from mainnet, at most 5 requests a second.
      --sample N scans N DAOs instead of all of them.
  kaap help | --help
  kaap --version

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
      const { values, positionals } = parsed(rest, { network: { type: 'string', default: 'mainnet' }, json: { type: 'boolean', default: false } });
      const [dao, id, ...extra] = positionals;
      if (dao === undefined || dao === '') throw new UsageError('kaap check needs a DAO account, for example: kaap check example.sputnik-dao.near 12');
      if (extra.length) throw new UsageError('kaap check takes a DAO and at most one proposal id');
      const network = values['network'];
      if (network !== 'mainnet' && network !== 'testnet') throw new UsageError('--network must be mainnet or testnet');
      return { command: 'check', dao, id: id === undefined ? null : wholeNumber(id, 'the proposal id', 0, Number.MAX_SAFE_INTEGER), network, json: values['json'] === true };
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
