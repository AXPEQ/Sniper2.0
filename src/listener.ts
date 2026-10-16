import type { Commitment, Connection } from '@solana/web3.js';
import { PUMP_PROGRAM_ID } from './constants.js';
import { log } from './logger.js';
import { extractCreateEvents, type CreateEvent } from './pump/events.js';

export interface NewToken {
  event: CreateEvent;
  signature: string;
  detectedAt: number;
}

/** Через сколько мс тишины считаем подписку мёртвой (программа pump.fun активна каждую секунду). */
const SILENCE_TIMEOUT_MS = 30_000;

/**
 * Слушает логи программы pump.fun через WebSocket (logsSubscribe) и
 * отдаёт каждый новый токен ровно один раз.
 */
export class TokenListener {
  private subscriptionId: number | null = null;
  private lastMessageAt = 0;
  private watchdog: NodeJS.Timeout | null = null;
  private readonly seenMints = new Set<string>();

  constructor(
    private readonly connection: Connection,
    private readonly commitment: Commitment,
    private readonly onToken: (token: NewToken) => void,
  ) {}

  start(): void {
    this.subscribe();
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastMessageAt > SILENCE_TIMEOUT_MS) {
        log.warn('Нет логов от pump.fun 30с — переподписываюсь');
        void this.resubscribe();
      }
    }, 5_000);
  }

  async stop(): Promise<void> {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    await this.unsubscribe();
  }

  private subscribe(): void {
    this.lastMessageAt = Date.now();
    this.subscriptionId = this.connection.onLogs(
      PUMP_PROGRAM_ID,
      (result) => {
        this.lastMessageAt = Date.now();
        if (result.err) return;
        for (const event of extractCreateEvents(result.logs)) {
          const mint = event.mint.toBase58();
          if (this.seenMints.has(mint)) continue;
          this.rememberMint(mint);
          this.onToken({ event, signature: result.signature, detectedAt: Date.now() });
        }
      },
      this.commitment,
    );
    log.info(`Подписка на pump.fun активна (commitment=${this.commitment})`);
  }

  private async unsubscribe(): Promise<void> {
    if (this.subscriptionId === null) return;
    const id = this.subscriptionId;
    this.subscriptionId = null;
    try {
      await this.connection.removeOnLogsListener(id);
    } catch (err) {
      log.debug('Ошибка при отписке', err);
    }
  }

  private async resubscribe(): Promise<void> {
    await this.unsubscribe();
    this.subscribe();
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
