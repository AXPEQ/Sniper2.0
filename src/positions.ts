import type { Connection, PublicKey } from '@solana/web3.js';
import type { Config } from './config.js';
import type { Journal } from './journal.js';
import { log } from './logger.js';
import { decodeBondingCurve, quoteSell, type BondingCurveState } from './pump/bondingCurve.js';
import type { Executor } from './trader/types.js';
import { c, duration, pctChange, signedPct, signedSol, sol, ticker } from './ui.js';
import { errorMessage, lamportsToSol } from './utils.js';

export type ExitReason = 'take_profit' | 'stop_loss' | 'trailing_stop' | 'timeout' | 'migrated' | 'shutdown';

export interface Position {
  mint: PublicKey;
  symbol: string;
  bondingCurve: PublicKey;
  tokenAmount: bigint;
  costSol: number;
  openedAt: number;
  peakValueSol: number;
  lastValueSol: number;
  lastCurve: BondingCurveState | null;
  status: 'open' | 'selling';
  exitReason?: ExitReason;
  sellAttempts: number;
  nextSellAt: number;
  subscriptionId?: number;
}

export interface ExitRules {
  takeProfitPct: number;
  stopLossPct: number;
  trailingStopPct: number;
  trailingActivationPct: number;
  maxHoldSeconds: number;
}

/** Решает, пора ли выходить из позиции. Чистая функция — легко тестировать. */
export function evaluateExit(
  pos: Pick<Position, 'costSol' | 'peakValueSol' | 'openedAt'>,
  valueSol: number,
  now: number,
  rules: ExitRules,
): ExitReason | null {
  const pnlPct = (valueSol / pos.costSol - 1) * 100;
  if (pnlPct >= rules.takeProfitPct) return 'take_profit';
  if (pnlPct <= -rules.stopLossPct) return 'stop_loss';
  if (rules.trailingStopPct > 0) {
    const peakPnlPct = (pos.peakValueSol / pos.costSol - 1) * 100;
    if (peakPnlPct >= rules.trailingActivationPct && valueSol <= pos.peakValueSol * (1 - rules.trailingStopPct / 100)) {
      return 'trailing_stop';
    }
  }
  if (rules.maxHoldSeconds > 0 && now - pos.openedAt >= rules.maxHoldSeconds * 1000) return 'timeout';
  return null;
}

const REASON_RU: Record<ExitReason, string> = {
  take_profit: '🎯 тейк-профит',
  stop_loss: '🛑 стоп-лосс',
  trailing_stop: '📉 трейлинг-стоп',
  timeout: '⏰ время вышло',
  migrated: '🚀 миграция',
  shutdown: '👋 остановка бота',
};

export interface PositionSnapshot {
  symbol: string;
  costSol: number;
  valueSol: number;
  pnlPct: number;
  ageSeconds: number;
  selling: boolean;
}

/**
 * Следит за открытыми позициями: получает обновления кривой по WebSocket (accountSubscribe),
 * раз в секунду локально проверяет условия выхода, а RPC опрашивает лишь раз в PRICE_POLL_MS.
 */
export class PositionManager {
  private readonly positions = new Map<string, Position>();
  private timer: NodeJS.Timeout | null = null;
  private evalTimer: NodeJS.Timeout | null = null;
  private ticking = false;
  realizedPnlSol = 0;
  closedCount = 0;
  winCount = 0;

  constructor(
    private readonly connection: Connection,
    private readonly executor: Executor,
    private readonly journal: Journal,
    private readonly cfg: Config,
  ) {}

  get openCount(): number {
    return this.positions.size;
  }

  /** Открытые позиции с текущей оценкой — для статуса в консоли. */
  snapshot(): PositionSnapshot[] {
    const now = Date.now();
    return [...this.positions.values()].map((p) => ({
      symbol: p.symbol,
      costSol: p.costSol,
      valueSol: p.lastValueSol,
      pnlPct: pctChange(p.costSol, p.lastValueSol),
      ageSeconds: (now - p.openedAt) / 1000,
      selling: p.status === 'selling',
    }));
  }

  has(mint: PublicKey): boolean {
    return this.positions.has(mint.toBase58());
  }

  open(p: Omit<Position, 'peakValueSol' | 'lastValueSol' | 'status' | 'sellAttempts' | 'nextSellAt'>): void {
    const pos: Position = {
      ...p,
      peakValueSol: p.costSol,
      lastValueSol: p.costSol,
      status: 'open',
      sellAttempts: 0,
      nextSellAt: 0,
    };
    this.positions.set(p.mint.toBase58(), pos);
    pos.subscriptionId = this.connection.onAccountChange(
      pos.bondingCurve,
      (acc) => {
        if (this.updateCurve(pos, acc.data)) this.evaluate(pos, Date.now());
      },
      'processed',
    );
  }

  start(): void {
    // Цена приходит по подписке; RPC-опрос — редкая страховка (каждый запрос стоит кредит).
    this.timer = setInterval(() => void this.tick(), this.cfg.pricePollMs);
    // Таймауты и повторы продаж проверяем локально, без запросов к RPC.
    this.evalTimer = setInterval(() => {
      const now = Date.now();
      for (const pos of this.positions.values()) this.evaluate(pos, now);
    }, 1_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.evalTimer) clearInterval(this.evalTimer);
    this.timer = null;
    this.evalTimer = null;
    for (const pos of this.positions.values()) this.unsubscribe(pos);
  }

  /** Продать всё, что открыто (используется при остановке). */
  async closeAll(): Promise<void> {
    await Promise.all([...this.positions.values()].map((p) => this.sell(p, 'shutdown')));
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.positions.size === 0) return;
    this.ticking = true;
    try {
      const list = [...this.positions.values()];
      const accounts = await this.connection.getMultipleAccountsInfo(list.map((p) => p.bondingCurve), 'confirmed');
      const now = Date.now();
      list.forEach((pos, i) => {
        const acc = accounts[i];
        if (acc) this.updateCurve(pos, acc.data);
        this.evaluate(pos, now);
      });
    } catch (err) {
      log.warn(`Ошибка обновления цен: ${errorMessage(err)}`);
    } finally {
      this.ticking = false;
    }
  }

  private updateCurve(pos: Position, data: Buffer): boolean {
    try {
      pos.lastCurve = decodeBondingCurve(data);
      return true;
    } catch (err) {
      log.warn(`${pos.symbol}: не удалось разобрать bonding curve: ${errorMessage(err)}`);
      return false;
    }
  }

  private evaluate(pos: Position, now: number): void {
    if (pos.status !== 'open' || now < pos.nextSellAt) return;
    if (pos.exitReason) {
      // Предыдущая продажа не удалась — повторяем.
      void this.sell(pos, pos.exitReason);
      return;
    }
    if (pos.lastCurve?.complete) {
      // После миграции цена на кривой больше не обновляется — выходим.
      void this.sell(pos, 'migrated');
      return;
    }
    if (!pos.lastCurve) return;

    const value = lamportsToSol(quoteSell(pos.lastCurve, pos.tokenAmount, this.cfg.simFeePct));
    pos.lastValueSol = value;
    pos.peakValueSol = Math.max(pos.peakValueSol, value);
    const reason = evaluateExit(pos, value, now, this.cfg);
    log.debug(`${pos.symbol}: стоимость ${value.toFixed(4)} SOL (${pctChange(pos.costSol, value).toFixed(1)}%)`);
    if (reason) void this.sell(pos, reason);
  }

  private unsubscribe(pos: Position): void {
    if (pos.subscriptionId === undefined) return;
    const id = pos.subscriptionId;
    pos.subscriptionId = undefined;
    this.connection.removeAccountChangeListener(id).catch(() => undefined);
  }

  private async sell(pos: Position, reason: ExitReason): Promise<void> {
    if (pos.status === 'selling') return;
    pos.status = 'selling';
    pos.exitReason = reason;
    pos.sellAttempts++;
    log.debug(`продаю ${pos.symbol}: ${REASON_RU[reason]}, оценка ${sol(pos.lastValueSol)}`);
    try {
      const res = await this.executor.sell(pos.mint, pos.tokenAmount, pos.lastCurve);
      const pnl = res.solReceived - pos.costSol;
      this.realizedPnlSol += pnl;
      this.closedCount++;
      if (pnl > 0) this.winCount++;
      this.positions.delete(pos.mint.toBase58());
      this.unsubscribe(pos);
      const head = pnl > 0 ? `🤑 ${c.green(c.bold('ПРОФИТ '))}` : `😢 ${c.red(c.bold('УБЫТОК '))}`;
      const held = duration((Date.now() - pos.openedAt) / 1000);
      log.info(
        `${head} ${ticker(pos.symbol)} ${signedSol(pnl)} ${c.gray('(')}${signedPct(pctChange(pos.costSol, res.solReceived))}${c.gray(')')}  ` +
          `${REASON_RU[reason]} ${c.gray(`· держал ${held} · ${sol(pos.costSol)} → ${sol(res.solReceived)}`)}`,
      );
      this.journal.write({
        type: 'sell',
        mode: this.executor.mode,
        mint: pos.mint.toBase58(),
        symbol: pos.symbol,
        reason,
        signature: res.signature,
        costSol: pos.costSol,
        solReceived: res.solReceived,
        pnlSol: pnl,
        holdSeconds: Math.round((Date.now() - pos.openedAt) / 1000),
      });
    } catch (err) {
      const backoffMs = Math.min(30_000, 2_000 * pos.sellAttempts);
      pos.status = 'open';
      pos.nextSellAt = Date.now() + backoffMs;
      log.warn(`продажа ${pos.symbol} не прошла (попытка ${pos.sellAttempts}), повтор через ${backoffMs / 1000}с: ${errorMessage(err)}`);
    }
  }
}

