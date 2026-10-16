import 'dotenv/config';
import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { loadConfig } from './config.js';
import { TokenFilter } from './filters/index.js';
import { Journal } from './journal.js';
import { TokenListener } from './listener.js';
import { log, setLogLevel } from './logger.js';
import { PositionManager } from './positions.js';
import { Sniper } from './sniper.js';
import { DryRunExecutor } from './trader/dryRun.js';
import { PumpPortalExecutor } from './trader/pumpPortal.js';
import type { Executor } from './trader/types.js';
import { errorMessage, lamportsToSol } from './utils.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);

  const connection = new Connection(cfg.rpcUrl, { commitment: cfg.listenCommitment, wsEndpoint: cfg.wsUrl });
  const wallet = cfg.privateKey ? Keypair.fromSecretKey(bs58.decode(cfg.privateKey)) : null;

  let executor: Executor;
  if (cfg.dryRun) {
    executor = new DryRunExecutor(cfg.simFeePct, cfg.priorityFeeSol);
    log.warn('РЕЖИМ СИМУЛЯЦИИ (DRY_RUN=true): реальные сделки не отправляются');
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

  const journal = new Journal(cfg.journalPath);
  const positions = new PositionManager(connection, executor, journal, cfg);
  const sniper = new Sniper(
    connection,
    cfg,
    new TokenFilter(connection, cfg),
    executor,
    positions,
    journal,
    cfg.dryRun ? null : (wallet?.publicKey ?? null),
  );
  const listener = new TokenListener(connection, cfg.listenCommitment, (t) => sniper.handle(t));

  positions.start();
  listener.start();

  const statusTimer = setInterval(() => {
    const s = sniper.stats;
    log.info(
      `Статус: новых токенов ${s.seen}, отсеяно ${s.quickRejected + s.deepRejected}, пропущено (лимиты) ${s.dropped}, ` +
        `куплено ${s.bought}, ошибок покупки ${s.buyFailed} | открыто ${positions.openCount}, закрыто ${positions.closedCount}, ` +
        `PnL ${positions.realizedPnlSol >= 0 ? '+' : ''}${positions.realizedPnlSol.toFixed(4)} SOL`,
    );
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
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  log.error(`Фатальная ошибка: ${errorMessage(err)}`);
  process.exit(1);
});
