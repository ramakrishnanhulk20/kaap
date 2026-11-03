// The command router. Exit codes: 0 done; 1 something could not be read or built, or is not yet
// available; 2 a usage error; 3 not a recognised DAO, no such proposal, no verdict for it, or a DAO
// the worker does not watch; 4 held, because the two providers disagreed or one could not be
// compared; 5 `kaap verify` ran and at least one check failed. No result is printed for 1, 3 or 4.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parse, USAGE, UsageError } from './args.js';
import { census, render as renderCensus } from './census.js';
import { Held } from './chain.js';
import { arming, render as renderArming } from './arming.js';
import { check, NoProposal, render as renderCheck } from './check.js';
import { Core, CoreError } from './core.js';
import { NotADao } from './dao.js';
import { NoDeployment } from './deployment.js';
import { CannotEnrol, enroll, render as renderEnroll } from './enroll.js';
import { evaluate, MissingFiles, render as renderEval } from './evaluate.js';
import { type Clock, RateLimiter, realClock } from './limiter.js';
import { fetchTransport, type Transport } from './net.js';
import { REQUESTS_PER_SECOND } from './caps.js';
import { RpcError } from './rpc.js';
import { render as renderSubscription, subscribe, WorkerRefused } from './subscribe.js';
import { NoVerdict, render as renderVerify, verify } from './verify.js';

/** Printed by `kaap seal-text` until Kaap's sealed program publishes the key texts are sealed to. */
export const SEAL_TEXT_NOT_YET = "kaap seal-text is not yet available: Kaap's sealed program does not publish the key a text is encrypted to yet. Nothing was read or sent.";

export interface Env {
  transport: Transport;
  clock: Clock;
  loadCore: () => Promise<Core>;
  /** The repository root, where `kaap eval` finds the answer key. */
  repoRoot: string;
  /** Spaces every request; one at `REQUESTS_PER_SECOND` on `clock` when not given. */
  limiter?: RateLimiter;
}

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

/** The real network, the real clock, and the wasm built next to this package. */
export function realEnv(): Env {
  return {
    transport: fetchTransport,
    clock: realClock,
    loadCore: () => Core.load(),
    repoRoot: fileURLToPath(new URL('../../../../', import.meta.url)),
  };
}

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
  return String(pkg.version);
}

export async function main(argv: string[], env: Env, io: Io): Promise<number> {
  let command;
  try {
    command = parse(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`${e.message}\n\n${USAGE}`);
      return 2;
    }
    throw e;
  }
  if (command.command === 'help') {
    io.out(USAGE);
    return 0;
  }
  if (command.command === 'version') {
    io.out(`kaap ${version()}`);
    return 0;
  }
  if (command.command === 'seal-text') {
    io.err(SEAL_TEXT_NOT_YET);
    return 1;
  }

  const json = command.command === 'check' && command.json;
  const fail = (code: number, message: string, extra: Record<string, unknown> = {}) => {
    if (json) io.out(JSON.stringify({ ok: false, reason: message, ...extra }, null, 2));
    else io.err(message);
    return code;
  };
  try {
    const core = await env.loadCore();
    const deps = { core, transport: env.transport, limiter: env.limiter ?? new RateLimiter(REQUESTS_PER_SECOND, env.clock), clock: env.clock };
    switch (command.command) {
      case 'check': {
        const { report, decimals } = await check({ ...deps, repoRoot: env.repoRoot }, command);
        io.out(json ? JSON.stringify({ ok: true, ...report }, null, 2) : renderCheck(report, decimals));
        return 0;
      }
      case 'eval':
        io.out(renderEval(evaluate(core, env.repoRoot)));
        return 0;
      case 'census':
        io.out(renderCensus(await census(deps, command.sample)));
        return 0;
      case 'verify': {
        const report = await verify({ ...deps, repoRoot: env.repoRoot }, command);
        io.out(renderVerify(report));
        return report.checks.every((c) => c.ok) ? 0 : 5;
      }
      case 'enroll':
        io.out(renderEnroll(await enroll({ ...deps, repoRoot: env.repoRoot }, command)));
        return 0;
      case 'arming':
        io.out(renderArming(await arming({ ...deps, repoRoot: env.repoRoot }, command)));
        return 0;
      case 'subscribe':
        io.out(renderSubscription(await subscribe(core, env.transport, command)));
        return 0;
    }
  } catch (e) {
    if (e instanceof NotADao) return fail(3, e.message, { recognised: false });
    if (e instanceof NoProposal || e instanceof NoVerdict || e instanceof CannotEnrol) return fail(3, e.message);
    if (e instanceof WorkerRefused) return fail(e.code, e.message);
    if (e instanceof NoDeployment) return fail(1, e.message);
    if (e instanceof Held) return fail(4, `held, no result: ${e.message}`);
    if (e instanceof RpcError) return fail(1, `could not read the chain: ${e.message}`);
    if (e instanceof CoreError || e instanceof MissingFiles) return fail(1, e.message);
    throw e;
  }
}
