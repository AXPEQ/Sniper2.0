import 'dotenv/config';
import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { TradeTracker } from './activity.js';
import { costWarnings, loadConfig } from './config.js';
import { renderBanner, renderStatus, renderSummary, type DashboardContext } from './dashboard.js';
import { TokenFilter } from './filters/index.js';
import { Journal } from './journal.js';
import { TokenListener } from './listener.js';
import { setLogDir } from './logfile.js';
import { installWsErrorHandler, log, setLogLevel } from './logger.js';
import { PositionManager } from './positions.js';
import { Sniper } from './sniper.js';
import { PaperExecutor, PaperWallet } from './trader/paper.js';
import { PumpPortalExecutor } from './trader/pumpPortal.js';
import type { Executor } from './trader/types.js';
import { print } from './ui.js';
import { errorMessage, lamportsToSol } from './utils.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);
  setLogDir(cfg.logDir);
  installWsErrorHandler();

  // HTTP-запросы идут в RPC_URL/Helius (по 1 кредиту), подписки — в STREAM_WS_URL (по умолчанию бесплатный публичный).
  const rpcStats = { calls: 0, byMethod: new Map<string, number>() };
  const connection = new Connection(cfg.rpcUrl, {
    commitment: cfg.listenCommitment,
    wsEndpoint: cfg.wsUrl,
    fetch: (input, init) => {
      rpcStats.calls++;
      const method = /"method":"(\w+)"/.exec(String(init?.body ?? ''))?.[1] ?? '?';
      rpcStats.byMethod.set(method, (rpcStats.byMethod.get(method) ?? 0) + 1);
      return fetch(input, init);
    },
  });
  const wallet = cfg.privateKey ? Keypair.fromSecretKey(bs58.decode(cfg.privateKey)) : null;

  let executor: Executor;
  let paperWallet: PaperWallet | null = null;
  if (cfg.dryRun) {
    paperWallet = new PaperWallet(cfg.paperStatePath, cfg.paperBalanceSol, cfg.paperReset);
    executor = new PaperExecutor(connection, paperWallet, {
      feePct: cfg.simFeePct,
      priorityFeeSol: cfg.priorityFeeSol,
      latencyMs: cfg.simLatencyMs,
      accountRentSol: cfg.simAccountRentSol,
      buySlippagePct: cfg.buySlippagePct,
      sellSlippagePct: cfg.sellSlippagePct,
    });
    print(renderBanner(cfg, { paper: paperWallet }));
  } else {
    if (!wallet) throw new Error('PRIVATE_KEY не задан');
    executor = new PumpPortalExecutor(connection, wallet, cfg);
    const balance = lamportsToSol(await connection.getBalance(wallet.publicKey));
    print(renderBanner(cfg, { address: wallet.publicKey.toBase58(), balanceSol: balance }));
  }
  for (const w of costWarnings(cfg)) log.warn(w);

  const journal = new Journal(cfg.journalPath);
  const tracker = new TradeTracker();
  const positions = new PositionManager(connection, executor, journal, cfg);
  const listener = new TokenListener(connection, cfg.listenCommitment, {
    onToken: (t) => sniper.handle(t),
    onTrade: (trade, signature) => tracker.onTrade(trade, signature),
    isTradeWanted: tracker.isWatched,
  });
  const sniper = new Sniper(
    connection,
    cfg,
    new TokenFilter(connection, cfg),
    executor,
    positions,
    journal,
    cfg.dryRun ? null : (wallet?.publicKey ?? null),
    tracker,
    listener,
  );

  positions.start();
  listener.start();

  const dashboard: DashboardContext = { cfg, sniper, positions, paperWallet, rpcStats, startedAt: Date.now() };
  const statusTimer = setInterval(() => print(renderStatus(dashboard)), 60_000);

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) process.exit(1); // повторный Ctrl+C — выйти немедленно
    stopping = true;
    log.info('⏹  останавливаюсь…');
    clearInterval(statusTimer);
    await listener.stop();
    await sniper.stop();
    positions.stop();
    if (positions.openCount > 0) {
      if (cfg.sellOnExit) {
        log.info(`продаю ${positions.openCount} открытых позиций (SELL_ON_EXIT=true)`);
        await positions.closeAll();
      }
    }
    print(renderSummary(dashboard, positions.openCount));
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  log.error(`фатальная ошибка: ${errorMessage(err)}`);
  process.exit(1);
});
