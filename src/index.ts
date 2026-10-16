import 'dotenv/config';
import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { TradeTracker } from './activity.js';
import { loadConfig, redactUrl } from './config.js';
import { TokenFilter } from './filters/index.js';
import { Journal } from './journal.js';
import { TokenListener } from './listener.js';
import { log, setLogLevel } from './logger.js';
import { PositionManager } from './positions.js';
import { Sniper } from './sniper.js';
import { PaperExecutor, PaperWallet } from './trader/paper.js';
import { PumpPortalExecutor } from './trader/pumpPortal.js';
import type { Executor } from './trader/types.js';
import { errorMessage, lamportsToSol } from './utils.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);

  const connection = new Connection(cfg.rpcUrl, { commitment: cfg.listenCommitment, wsEndpoint: cfg.wsUrl });
  const wallet = cfg.privateKey ? Keypair.fromSecretKey(bs58.decode(cfg.privateKey)) : null;

  log.info(`RPC: ${redactUrl(cfg.rpcUrl)}${cfg.wsUrl ? ` | WS: ${redactUrl(cfg.wsUrl)}` : ''}`);
  if (cfg.rpcUrl.includes('api.mainnet-beta.solana.com')) {
    log.warn('Публичный RPC режет запросы — задайте HELIUS_API_KEY или RPC_URL приватного провайдера');
  }

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
    log.warn('БУМАЖНАЯ ТОРГОВЛЯ (DRY_RUN=true): виртуальные деньги, реальные цены mainnet');
    log.info(paperWallet.summary());
  } else {
    if (!wallet) throw new Error('PRIVATE_KEY не задан');
    executor = new PumpPortalExecutor(connection, wallet, cfg);
    const balance = lamportsToSol(await connection.getBalance(wallet.publicKey));
    log.warn(`БОЕВОЙ РЕЖИМ: кошелёк ${wallet.publicKey.toBase58()}, баланс ${balance.toFixed(4)} SOL`);
  }
  log.info(
    `Покупка ${cfg.buyAmountSol} SOL | TP +${cfg.takeProfitPct}% | SL -${cfg.stopLossPct}%` +
      (cfg.trailingStopPct > 0 ? ` | трейлинг ${cfg.trailingStopPct}% (после +${cfg.trailingActivationPct}%)` : '') +
      ` | макс. удержание ${cfg.maxHoldSeconds}с | позиций до ${cfg.maxOpenPositions} | бюджет ${cfg.maxTotalSpentSol} SOL`,
  );
  log.info(
    `Фильтры: ${cfg.filterPreset.toUpperCase()}` +
      (cfg.buyDelayMs > 0
        ? ` | наблюдение ${cfg.buyDelayMs / 1000}с: покупателей ≥ ${cfg.minUniqueBuyers}, объём ≥ ${cfg.minBuyVolumeSol} SOL` +
          (cfg.maxSellRatio > 0 ? `, продажи ≤ ${cfg.maxSellRatio * 100}% покупок` : '') +
          (cfg.maxSingleBuyerPct > 0 ? `, один кошелёк ≤ ${cfg.maxSingleBuyerPct}%` : '') +
          (cfg.maxBundledBuyers >= 0 ? `, бандл ≤ ${cfg.maxBundledBuyers}` : '') +
          (cfg.rejectDevSell ? ', dev не продаёт' : '')
        : ' | без окна наблюдения') +
      ` | mcap ${cfg.minMarketCapSol}–${cfg.maxMarketCapSol} SOL | dev ≤ ${cfg.maxDevHoldingPct}%` +
      (cfg.maxTop10HoldingPct > 0 ? ` | топ-10 ≤ ${cfg.maxTop10HoldingPct}%` : ''),
  );

  const journal = new Journal(cfg.journalPath);
  const tracker = new TradeTracker();
  const positions = new PositionManager(connection, executor, journal, cfg);
  const sniper = new Sniper(
    connection,
    cfg,
    new TokenFilter(connection, cfg),
    executor,
    positions,
    journal,
    cfg.dryRun ? null : (wallet?.publicKey ?? null),
    tracker,
  );
  const listener = new TokenListener(connection, cfg.listenCommitment, {
    onToken: (t) => sniper.handle(t),
    onTrade: (trade, signature, slot) => tracker.onTrade(trade, signature, slot),
    isTradeWanted: tracker.isWatched,
  });

  positions.start();
  listener.start();

  const statusTimer = setInterval(() => {
    const s = sniper.stats;
    log.info(
      `Статус: новых токенов ${s.seen}, отсеяно ${s.quickRejected + s.deepRejected}, пропущено (лимиты) ${s.dropped}, ` +
        `куплено ${s.bought}, ошибок покупки ${s.buyFailed} | открыто ${positions.openCount}, закрыто ${positions.closedCount}, ` +
        `PnL ${positions.realizedPnlSol >= 0 ? '+' : ''}${positions.realizedPnlSol.toFixed(4)} SOL`,
    );
    const reasons = sniper.topRejectReasons();
    if (reasons) log.info(`Частые причины отказа: ${reasons}`);
    if (paperWallet) log.info(paperWallet.summary());
  }, 60_000);

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) process.exit(1); // повторный Ctrl+C — выйти немедленно
    stopping = true;
    log.info('Остановка...');
    clearInterval(statusTimer);
    await listener.stop();
    await sniper.stop();
    positions.stop();
    if (positions.openCount > 0) {
      if (cfg.sellOnExit) {
        log.info(`Продаю ${positions.openCount} открытых позиций (SELL_ON_EXIT=true)`);
        await positions.closeAll();
      } else {
        log.warn(`Остались открытые позиции: ${positions.openCount}. Они НЕ проданы (SELL_ON_EXIT=false).`);
      }
    }
    log.info(`Итог: закрыто сделок ${positions.closedCount}, реализованный PnL ${positions.realizedPnlSol.toFixed(4)} SOL`);
    const reasons = sniper.topRejectReasons(8);
    if (reasons) log.info(`Частые причины отказа: ${reasons}`);
    if (paperWallet) log.info(paperWallet.summary());
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  log.error(`Фатальная ошибка: ${errorMessage(err)}`);
  process.exit(1);
});
