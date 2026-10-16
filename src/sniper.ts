import type { Connection, PublicKey } from '@solana/web3.js';
import type { TradeTracker } from './activity.js';
import type { Config } from './config.js';
import type { TokenFilter } from './filters/index.js';
import type { Journal } from './journal.js';
import type { NewToken } from './listener.js';
import { log } from './logger.js';
import type { PositionManager } from './positions.js';
import { marketCapSol } from './pump/bondingCurve.js';
import type { Executor } from './trader/types.js';
import { errorMessage, lamportsToSol, sleep } from './utils.js';

/** Связывает всё вместе: новый токен → фильтры → покупка → позиция под управлением TP/SL. */
export class Sniper {
  private inFlight = 0;
  private pendingBuys = 0;
  private spentSol = 0;
  private budgetWarned = false;
  private stopped = false;
  readonly stats = { seen: 0, quickRejected: 0, deepRejected: 0, dropped: 0, bought: 0, buyFailed: 0 };
  /** Причины отказов (числа обезличены) — помогают подобрать пороги фильтров. */
  readonly rejectReasons = new Map<string, number>();

  constructor(
    private readonly connection: Connection,
    private readonly cfg: Config,
    private readonly filter: TokenFilter,
    private readonly executor: Executor,
    private readonly positions: PositionManager,
    private readonly journal: Journal,
    private readonly wallet: PublicKey | null,
    private readonly tracker: TradeTracker,
  ) {}

  /** Топ причин отказа, например «мало покупателей: # < #» — 120. */
  topRejectReasons(limit = 5): string {
    return [...this.rejectReasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([r, n]) => `${r} — ${n}`)
      .join('; ');
  }

  private countReject(reason: string): void {
    const key = reason.replace(/-?\d+(\.\d+)?/g, '#');
    this.rejectReasons.set(key, (this.rejectReasons.get(key) ?? 0) + 1);
  }

  /** Прекратить новые покупки и дождаться завершения уже отправленных (не дольше timeoutMs). */
  async stop(timeoutMs = 30_000): Promise<void> {
    this.stopped = true;
    const deadline = Date.now() + timeoutMs;
    while (this.pendingBuys > 0 && Date.now() < deadline) await sleep(200);
  }

  handle(token: NewToken): void {
    if (this.stopped) return;
    this.stats.seen++;
    const { event } = token;
    const label = `${event.symbol} (${event.name}) ${event.mint.toBase58()}`;

    const quickReason = this.filter.quickCheck(event);
    if (quickReason) {
      this.stats.quickRejected++;
      this.countReject(quickReason);
      log.debug(`пропуск ${label}: ${quickReason}`);
      return;
    }
    if (!this.hasCapacity()) {
      this.stats.dropped++;
      return;
    }
    if (this.inFlight >= this.cfg.maxConcurrentChecks) {
      this.stats.dropped++;
      log.debug(`пропуск ${label}: слишком много параллельных проверок`);
      return;
    }

    this.inFlight++;
    if (this.cfg.buyDelayMs > 0) {
      this.tracker.watch(event.mint, {
        creationSignature: token.signature,
        creationSlot: token.slot,
        devs: event.creator ? [event.user, event.creator] : [event.user],
        initialVSol: event.virtualSolReserves ?? 30_000_000_000n,
        initialVTok: event.virtualTokenReserves ?? 1_073_000_000_000_000n,
      });
    }
    void this.process(token, label).finally(() => {
      this.inFlight--;
      this.tracker.unwatch(event.mint);
    });
  }

  private async process(token: NewToken, label: string): Promise<void> {
    const { event } = token;
    // Метаданные грузим сразу, параллельно с окном наблюдения.
    const metadata = this.filter.fetchMetadata(event);
    if (this.cfg.buyDelayMs > 0) await sleep(this.cfg.buyDelayMs);

    let check;
    try {
      check = await this.filter.deepCheck(event, this.tracker.stats(event.mint), metadata);
    } catch (err) {
      check = { reason: `ошибка проверки: ${errorMessage(err)}` };
    }
    if (check.reason || !check.curve) {
      this.stats.deepRejected++;
      this.countReject(check.reason ?? 'нет данных кривой');
      log.info(`✗ ${label}: ${check.reason ?? 'нет данных кривой'}`);
      return;
    }
    // Пока шли проверки, бот мог остановиться или слоты могли закончиться.
    if (this.stopped) return;
    if (!this.hasCapacity()) {
      this.stats.dropped++;
      return;
    }

    const curve = check.curve;
    const latencyMs = Date.now() - token.detectedAt;
    const a = this.tracker.stats(event.mint);
    const activity = a ? `, покупателей ${a.uniqueBuyers}, объём ${a.buyVolumeSol.toFixed(2)} SOL` : '';
    log.info(`✓ ${label}: фильтры пройдены за ${latencyMs}мс, mcap ${marketCapSol(curve).toFixed(1)} SOL${activity} — ПОКУПКА ${this.cfg.buyAmountSol} SOL`);

    this.pendingBuys++;
    try {
      if (this.wallet) await this.ensureBalance(this.wallet);
      const res = await this.executor.buy(event.mint, this.cfg.buyAmountSol, curve);
      this.spentSol += res.solSpent;
      this.stats.bought++;
      this.positions.open({
        mint: event.mint,
        symbol: event.symbol,
        bondingCurve: event.bondingCurve,
        tokenAmount: res.tokenAmount,
        costSol: res.solSpent,
        openedAt: Date.now(),
        lastCurve: curve,
      });
      log.info(`КУПЛЕНО ${event.symbol}: ${res.tokenAmount} токенов (raw) за ${res.solSpent.toFixed(4)} SOL tx=${res.signature}`);
      this.journal.write({
        type: 'buy',
        mode: this.executor.mode,
        mint: event.mint.toBase58(),
        symbol: event.symbol,
        name: event.name,
        signature: res.signature,
        solSpent: res.solSpent,
        tokenAmount: res.tokenAmount,
        marketCapSol: marketCapSol(curve),
        latencyMs,
        activity: a ?? undefined,
      });
    } catch (err) {
      this.stats.buyFailed++;
      log.error(`Покупка ${event.symbol} не удалась: ${errorMessage(err)}`);
    } finally {
      this.pendingBuys--;
    }
  }

  private hasCapacity(): boolean {
    if (this.positions.openCount + this.pendingBuys >= this.cfg.maxOpenPositions) return false;
    if (this.cfg.maxTotalSpentSol > 0 && this.spentSol + this.cfg.buyAmountSol > this.cfg.maxTotalSpentSol) {
      if (!this.budgetWarned) {
        this.budgetWarned = true;
        log.warn(`Достигнут лимит MAX_TOTAL_SPENT_SOL=${this.cfg.maxTotalSpentSol} — новые покупки остановлены`);
      }
      return false;
    }
    return true;
  }

  private async ensureBalance(wallet: PublicKey): Promise<void> {
    const balance = lamportsToSol(await this.connection.getBalance(wallet, 'confirmed'));
    const needed = this.cfg.buyAmountSol + this.cfg.priorityFeeSol + this.cfg.minSolReserve;
    if (balance < needed) throw new Error(`недостаточно SOL: ${balance.toFixed(4)} < ${needed.toFixed(4)}`);
  }
}
