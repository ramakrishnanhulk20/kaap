// The worker's settings, read once from the environment at boot and checked with one schema. Any
// missing or malformed key stops the worker before it makes a single call, with every problem
// named in one message (6e: validate .env at boot and fail loudly).

import { z } from 'zod';

import { parseNear } from './near.ts';

// NEAR's own account id rule (nearcore `AccountId::validate`): 2 to 64 characters, lowercase
// letters and digits in parts joined by "-" or "_", parts separated by ".".
export const ACCOUNT_ID = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

const accountId = z.string().regex(ACCOUNT_ID, 'not a NEAR account id');
const https = z.url({ protocol: /^https$/, hostname: z.regexes.domain }).transform((u) => u.replace(/\/+$/, ''));
const count = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

const schema = z
  .object({
    KAAP_NETWORK: z.enum(['testnet', 'mainnet']),
    KAAP_WORKER_ACCOUNT: accountId,
    KAAP_WORKER_CREDENTIALS_FILE: z.string().min(1),
    KAAP_GUARD: accountId,
    KAAP_REGISTRY: accountId,
    KAAP_OUTLAYER: accountId,
    KAAP_SEALED_PROJECT: z.string().regex(/^[a-z\d._-]{2,64}\/[a-zA-Z\d._-]{1,64}$/, 'not <owner account>/<project name>'),
    KAAP_RPC_PRIMARY: https,
    KAAP_RPC_SECONDARY: https,
    KAAP_WORKER_DB: z.string().min(1),
    KAAP_CAP_RUNS_PER_DAO_DAY: count(1, 10_000),
    KAAP_CAP_RECORDS_PER_DAO_DAY: count(1, 10_000),
    KAAP_CAP_NEAR_PER_DAY: z.string().transform((text, ctx) => {
      const yocto = parseNear(text);
      if (yocto === null || yocto <= 0n) {
        ctx.addIssue({ code: 'custom', message: 'not a positive NEAR amount such as 1 or 0.5' });
        return z.NEVER;
      }
      return yocto;
    }),
    KAAP_POLL_MS: count(250, 60_000).default(1_000),
    KAAP_WATCH_MS: count(1_000, 600_000).default(15_000),
    KAAP_ENROLLED_MS: count(5_000, 3_600_000).default(60_000),
    KAAP_VERDICT_TTL_MS: count(60_000, 3_600_000).default(600_000),
    KAAP_RUN_WINDOW_BLOCKS: count(50, 2_000).default(220),
    KAAP_HOLD_ALERT_MS: count(1_000, 600_000).default(30_000),
    KAAP_BACKFILL_WINDOW: count(1, 1_000).default(100),
    KAAP_MAX_CONCURRENT_RUNS: count(1, 32).default(4),
    KAAP_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    TELEGRAM_BOT_TOKEN: z.string().regex(/^\d{5,16}:[A-Za-z0-9_-]{30,64}$/, 'not a bot token as BotFather gives it (<digits>:<letters>)'),
    // Unset until Kaap has its own site: alerts then carry no link at all, since a link may only
    // point at Kaap's own domain (C24).
    KAAP_SITE_URL: https.optional(),
    KAAP_HTTP_HOST: z.union([z.ipv4(), z.ipv6()]).default('127.0.0.1'),
    KAAP_HTTP_PORT: count(1, 65_535).default(8_787),
    KAAP_ALERT_BATCH_MS: count(5_000, 3_600_000).default(60_000),
    KAAP_ALERT_CAP_PER_HOUR: count(1, 1_000).default(30),
    KAAP_LAG_ALERT_MS: count(3_000, 600_000).default(15_000),
  })
  .refine((c) => new URL(c.KAAP_RPC_PRIMARY).host !== new URL(c.KAAP_RPC_SECONDARY).host, {
    message: 'the two RPC providers must be different hosts (C22)',
    path: ['KAAP_RPC_SECONDARY'],
  })
  .refine((c) => ACCOUNT_ID.test(c.KAAP_SEALED_PROJECT.split('/')[0] ?? ''), {
    message: 'the project owner is not a NEAR account id',
    path: ['KAAP_SEALED_PROJECT'],
  });

export type Config = z.output<typeof schema>;

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`the worker's settings are not usable:\n  ${problems.join('\n  ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/** Reads every KAAP_ setting and the Telegram bot token from `env`. Values are never echoed in
 *  the error, only key names and what is wrong with them, so a misplaced secret cannot end up in
 *  a log. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const picked = Object.fromEntries(Object.entries(env).filter(([k, v]) => (k.startsWith('KAAP_') || k === 'TELEGRAM_BOT_TOKEN') && v !== undefined && v !== ''));
  const parsed = schema.safeParse(picked);
  if (parsed.success) return parsed.data;
  throw new ConfigError(
    parsed.error.issues.map((i) => {
      const key = String(i.path[0] ?? '(settings)');
      return `${key}: ${picked[key] === undefined ? 'missing' : i.message}`;
    }),
  );
}
