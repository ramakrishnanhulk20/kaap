// Starts the worker: settings checked, key loaded and checked on chain, store opened, loops
// started. Any problem at boot stops it with a message saying what to fix and a non-zero exit, so
// a host's restart policy shows the failure instead of hiding it.

import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { Actor } from './act.ts';
import { Alerts } from './alerts.ts';
import { Bridge } from './bridge.ts';
import { CapGuard } from './caps.ts';
import { NearChain, loadKey } from './chain.ts';
import { ConfigError, loadConfig } from './config.ts';
import { ALL, Health } from './health.ts';
import { Judge } from './judge.ts';
import { addSecret, createLogger } from './log.ts';
import { formatNear } from './near.ts';
import { Reads } from './reads.ts';
import { RejudgeWatch } from './rejudge.ts';
import { RpcClient } from './rpc.ts';
import { StatusServer } from './status.ts';
import { Store } from './store.ts';
import { Submitter } from './submit.ts';
import { Bot, Subscriptions } from './subscriptions.ts';
import { BotApi } from './telegram.ts';
import { Worker } from './worker.ts';

/** Token requests one address may make an hour on POST /subscribe. */
const TOKENS_PER_ADDRESS_HOUR = 10;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  // Values already in the environment win over the file, so a host's own settings are never
  // overridden by a stale copy.
  const envFile = resolve(process.env.KAAP_ENV_FILE ?? '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const config = loadConfig(process.env);
  // Before anything can log: the token is in every Telegram request path.
  addSecret(config.TELEGRAM_BOT_TOKEN);
  addSecret(config.TELEGRAM_BOT_TOKEN.split(':')[1]!);
  const log = createLogger(config.KAAP_LOG_LEVEL);
  const explorer = (hash: string) => `https://${config.KAAP_NETWORK === 'mainnet' ? '' : 'testnet.'}nearblocks.io/txns/${hash}`;

  const telegram = new BotApi(config.TELEGRAM_BOT_TOKEN);
  const bot = await telegram.getMe();

  const key = loadKey(config.KAAP_WORKER_CREDENTIALS_FILE, config.KAAP_WORKER_ACCOUNT, log);
  const bridge = Bridge.load();
  const primary = new RpcClient(config.KAAP_RPC_PRIMARY);
  const secondary = new RpcClient(config.KAAP_RPC_SECONDARY);
  const chain = new NearChain(config.KAAP_WORKER_ACCOUNT, key, primary);
  await chain.checkKey();

  mkdirSync(dirname(resolve(config.KAAP_WORKER_DB)), { recursive: true });
  const store = new Store(config.KAAP_WORKER_DB);
  const now = Date.now;
  const health = new Health(log, now);
  const alerts = new Alerts(
    { store, telegram, log, now, sleep, onDelivery: (working) => (working ? health.clear('alerts_failing', ALL) : health.raise('alerts_failing', ALL)) },
    { network: config.KAAP_NETWORK, siteUrl: config.KAAP_SITE_URL ?? null, batchMs: config.KAAP_ALERT_BATCH_MS, capPerHour: config.KAAP_ALERT_CAP_PER_HOUR },
  );
  health.on((event) => alerts.health(event));
  const subs = new Subscriptions(store, config.KAAP_NETWORK, log);
  const chatBot = new Bot({ subs, telegram, store, log, now, sleep }, bot.username);
  const caps = new CapGuard(store, { runsPerDaoDay: config.KAAP_CAP_RUNS_PER_DAO_DAY, recordsPerDaoDay: config.KAAP_CAP_RECORDS_PER_DAO_DAY, nearPerDay: config.KAAP_CAP_NEAR_PER_DAY }, config.KAAP_NETWORK);
  const reads = new Reads(primary, secondary, bridge, 1_000, sleep);
  const submitter = new Submitter(store, chain, config.KAAP_NETWORK, log, { pollMs: 1_500, sendTries: 4, sleep, explorer });
  const acceptedKey = { value: null as string | null };
  const judge = new Judge(
    { store, submitter, caps, bridge, health, log, acceptedKey: () => acceptedKey.value, now },
    { network: config.KAAP_NETWORK, guard: config.KAAP_GUARD, outlayer: config.KAAP_OUTLAYER, project: config.KAAP_SEALED_PROJECT, verdictTtlMs: config.KAAP_VERDICT_TTL_MS, windowBlocks: config.KAAP_RUN_WINDOW_BLOCKS },
  );
  const actor = new Actor({ store, submitter, caps, reads, health, log, now, sleep }, { network: config.KAAP_NETWORK, guard: config.KAAP_GUARD, registry: config.KAAP_REGISTRY, gateTries: 3, gateRetryMs: 1_500 });
  let worker: Worker | null = null;
  const rejudge = new RejudgeWatch({ reads, store, bridge, health, log, enqueue: (dao, id) => worker?.enqueue(dao, id) }, config.KAAP_NETWORK);
  worker = new Worker(
    { store, reads, judge, actor, rejudge, health, log, now, acceptedKey, bridge, alerts },
    {
      network: config.KAAP_NETWORK,
      guard: config.KAAP_GUARD,
      pollMs: config.KAAP_POLL_MS,
      watchMs: config.KAAP_WATCH_MS,
      enrolledMs: config.KAAP_ENROLLED_MS,
      holdAlertMs: config.KAAP_HOLD_ALERT_MS,
      backfillWindow: config.KAAP_BACKFILL_WINDOW,
      maxConcurrentRuns: config.KAAP_MAX_CONCURRENT_RUNS,
      lagAlertMs: config.KAAP_LAG_ALERT_MS,
      workerAccount: config.KAAP_WORKER_ACCOUNT,
    },
  );
  const http = new StatusServer(
    { health, subs, log, now, watching: () => worker!.watching() },
    { host: config.KAAP_HTTP_HOST, port: config.KAAP_HTTP_PORT, network: config.KAAP_NETWORK, guard: config.KAAP_GUARD, botUsername: bot.username, tokensPerAddressHour: TOKENS_PER_ADDRESS_HOUR },
  );

  log.info('worker_starting', {
    network: config.KAAP_NETWORK,
    worker_account: config.KAAP_WORKER_ACCOUNT,
    guard: config.KAAP_GUARD,
    registry: config.KAAP_REGISTRY,
    sealed_project: config.KAAP_SEALED_PROJECT,
    providers: [primary.name, secondary.name],
    caps: { runs_per_dao_day: config.KAAP_CAP_RUNS_PER_DAO_DAY, records_per_dao_day: config.KAAP_CAP_RECORDS_PER_DAO_DAY, near_per_day: formatNear(config.KAAP_CAP_NEAR_PER_DAY) },
    poll_ms: config.KAAP_POLL_MS,
    db: config.KAAP_WORKER_DB,
    alerts: { telegram_bot: bot.username, site: config.KAAP_SITE_URL ?? 'none, so alerts carry no link', batch_ms: config.KAAP_ALERT_BATCH_MS, cap_per_hour: config.KAAP_ALERT_CAP_PER_HOUR },
    lag_alert_ms: config.KAAP_LAG_ALERT_MS,
  });

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('worker_stopping', { signal });
    // The bot's long poll is left to end with the process: waiting for it adds up to 20 s.
    void chatBot.stop();
    void Promise.all([http.stop(), worker!.stop()])
      .then(() => alerts.stop())
      .finally(() => {
        store.close();
        process.exit(0);
      });
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('unhandledRejection', (e) => log.error('unhandled_rejection', { error: e }));

  await http.start();
  await worker.start();
  alerts.start();
  chatBot.start();
  log.info('worker_started', { watching: worker.watching().length, status: health.current().length === 0 ? 'healthy' : 'degraded' });
}

main().catch((e: unknown) => {
  const message = e instanceof ConfigError ? e.message : `the worker stopped at boot: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`;
  // Boot errors are fixed texts or redacted logger output, never a key: the logger's redactor
  // has every loaded secret registered by now.
  createLogger('error').error('boot_failed', { message });
  process.exit(2);
});
