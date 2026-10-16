import type { Commitment, Connection, Context, Logs, PublicKey } from '@solana/web3.js';
import { PUMP_MINT_AUTHORITY } from './constants.js';
import { log } from './logger.js';
import { parseProgramEvents, type CreateEvent, type TradeEvent } from './pump/events.js';
import { c } from './ui.js';

export interface NewToken {
  event: CreateEvent;
  signature: string;
  slot: number;
  detectedAt: number;
}

export interface ListenerHandlers {
  onToken: (token: NewToken) => void;
  /** Сделки разбираются только по токенам, для которых isTradeWanted вернёт true. */
  onTrade?: (trade: TradeEvent, signature: string, slot: number) => void;
  isTradeWanted?: (mint: string) => boolean;
}

/** Тишина в потоке созданий дольше этого — подписка, скорее всего, отвалилась (токены создаются каждые 1–3 с). */
const SILENCE_TIMEOUT_MS = 60_000;

/**
 * Подписки на логи (logsSubscribe), экономные по трафику:
 * - создания токенов: фильтр по mint authority pump.fun — только транзакции создания (~4 КБ/с вместо ~400 КБ/с
 *   при подписке на всю программу);
 * - сделки: отдельная подписка на bonding curve конкретного токена, только пока он на наблюдении.
 */
export class TokenListener {
  private createsSubId: number | null = null;
  private readonly tradeSubs = new Map<string, number>();
  private lastCreateAt = 0;
  private watchdog: NodeJS.Timeout | null = null;
  private readonly seenMints = new Set<string>();

  constructor(
    private readonly connection: Connection,
    private readonly commitment: Commitment,
    private readonly handlers: ListenerHandlers,
  ) {}

  start(): void {
    this.subscribeCreates();
    log.info(`📡 Подключился к pump.fun — ищу новые токены ${c.gray('(сводка раз в минуту)')}`);
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastCreateAt > SILENCE_TIMEOUT_MS) {
        log.warn('новых токенов нет уже минуту — переподключаюсь');
        void this.resubscribeCreates();
      }
    }, 10_000);
  }

  async stop(): Promise<void> {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    await this.unsubscribeCreates();
    await Promise.all([...this.tradeSubs.values()].map((id) => this.removeListener(id)));
    this.tradeSubs.clear();
  }

  /** Начать получать сделки по токену (подписка на его bonding curve). */
  watchTrades(bondingCurve: PublicKey): void {
    const key = bondingCurve.toBase58();
    if (this.tradeSubs.has(key)) return;
    this.tradeSubs.set(key, this.connection.onLogs(bondingCurve, (r, ctx) => this.handleLogs(r, ctx), this.commitment));
  }

  unwatchTrades(bondingCurve: PublicKey): void {
    const key = bondingCurve.toBase58();
    const id = this.tradeSubs.get(key);
    if (id === undefined) return;
    this.tradeSubs.delete(key);
    void this.removeListener(id);
  }

  private handleLogs(result: Logs, ctx: Context): void {
    if (result.err) return;
    const wantTrade = this.handlers.onTrade ? (this.handlers.isTradeWanted ?? (() => true)) : () => false;
    for (const item of parseProgramEvents(result.logs, wantTrade)) {
      if (item.kind === 'trade') {
        this.handlers.onTrade?.(item.event, result.signature, ctx.slot);
        continue;
      }
      this.lastCreateAt = Date.now();
      const mint = item.event.mint.toBase58();
      if (this.seenMints.has(mint)) continue;
      this.rememberMint(mint);
      this.handlers.onToken({ event: item.event, signature: result.signature, slot: ctx.slot, detectedAt: Date.now() });
    }
  }

  private subscribeCreates(): void {
    this.lastCreateAt = Date.now();
    this.createsSubId = this.connection.onLogs(PUMP_MINT_AUTHORITY, (r, ctx) => this.handleLogs(r, ctx), this.commitment);
  }

  private async unsubscribeCreates(): Promise<void> {
    if (this.createsSubId === null) return;
    const id = this.createsSubId;
    this.createsSubId = null;
    await this.removeListener(id);
  }

  private async resubscribeCreates(): Promise<void> {
    await this.unsubscribeCreates();
    this.subscribeCreates();
  }

  private async removeListener(id: number): Promise<void> {
    try {
      await this.connection.removeOnLogsListener(id);
    } catch (err) {
      log.debug('Ошибка при отписке', err);
    }
  }

  private rememberMint(mint: string): void {
    this.seenMints.add(mint);
    // Ограничиваем память: Set хранит порядок вставки, удаляем самые старые.
    if (this.seenMints.size > 50_000) {
      const oldest = this.seenMints.values().next().value;
      if (oldest !== undefined) this.seenMints.delete(oldest);
    }
  }
}
