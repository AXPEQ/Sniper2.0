import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Connection, PublicKey } from '@solana/web3.js';
import { log } from '../logger.js';
import { decodeBondingCurve, deriveBondingCurve, quoteBuy, quoteSell, type BondingCurveState } from '../pump/bondingCurve.js';
import { errorMessage, lamportsToSol, sleep, solToLamports } from '../utils.js';
import type { BuyResult, Executor, SellResult } from './types.js';

interface PaperWalletState {
  startBalanceSol: number;
  balanceSol: number;
  createdAt: string;
  buys: number;
  sells: number;
  wins: number;
  failedTxs: number;
}

/** Виртуальный кошелёк: баланс сохраняется в JSON и переживает перезапуски бота. */
export class PaperWallet {
  private state: PaperWalletState;

  constructor(
    private readonly path: string,
    initialBalanceSol: number,
    reset: boolean,
  ) {
    const fresh = (): PaperWalletState => ({
      startBalanceSol: initialBalanceSol,
      balanceSol: initialBalanceSol,
      createdAt: new Date().toISOString(),
      buys: 0,
      sells: 0,
      wins: 0,
      failedTxs: 0,
    });
    this.state = fresh();
    if (!reset && existsSync(path)) {
      try {
        this.state = { ...fresh(), ...(JSON.parse(readFileSync(path, 'utf8')) as Partial<PaperWalletState>) };
      } catch (err) {
        log.warn(`Не удалось прочитать ${path}, начинаю с нового виртуального кошелька: ${errorMessage(err)}`);
      }
    }
    mkdirSync(dirname(path), { recursive: true });
    this.save();
  }

  get balance(): number {
    return this.state.balanceSol;
  }

  summary(): string {
    const s = this.state;
    const pnl = s.balanceSol - s.startBalanceSol;
    const winRate = s.sells > 0 ? ((s.wins / s.sells) * 100).toFixed(0) : '—';
    return (
      `виртуальный баланс ${s.balanceSol.toFixed(4)} SOL (старт ${s.startBalanceSol} SOL, ` +
      `${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL, ${((pnl / s.startBalanceSol) * 100).toFixed(1)}%) | ` +
      `покупок ${s.buys}, продаж ${s.sells}, в плюс ${winRate}%, неудачных транзакций ${s.failedTxs}`
    );
  }

  debit(sol: number): void {
    this.state.balanceSol -= sol;
    this.save();
  }

  recordBuy(cost: number): void {
    this.state.buys++;
    this.debit(cost);
  }

  recordSell(received: number, cost: number): void {
    this.state.sells++;
    if (received > cost) this.state.wins++;
    this.state.balanceSol += received;
    this.save();
  }

  recordFailedTx(fee: number): void {
    this.state.failedTxs++;
    this.debit(fee);
  }

  private save(): void {
    writeFileSync(this.path, JSON.stringify(this.state, null, 2));
  }
}

export interface PaperOptions {
  feePct: number;
  priorityFeeSol: number;
  latencyMs: number;
  accountRentSol: number;
  buySlippagePct: number;
  sellSlippagePct: number;
}

/**
 * Торговля не настоящими деньгами, максимально близкая к реальной:
 * - цена исполнения берётся с кривой ПОСЛЕ задержки SIM_LATENCY_MS (как будто транзакция летит в сеть);
 * - если цена ушла дальше допустимого slippage, «транзакция падает», списывается только комиссия;
 * - учитываются комиссии pump.fun/PumpPortal, priority fee и рента токен-аккаунта.
 */
export class PaperExecutor implements Executor {
  readonly mode = 'paper' as const;
  private counter = 0;
  private readonly costs = new Map<string, number>();

  constructor(
    private readonly connection: Connection,
    readonly wallet: PaperWallet,
    private readonly opts: PaperOptions,
  ) {}

  async buy(mint: PublicKey, solAmount: number, curve: BondingCurveState): Promise<BuyResult> {
    const cost = solAmount + this.opts.priorityFeeSol + this.opts.accountRentSol;
    if (this.wallet.balance < cost) {
      throw new Error(`недостаточно виртуальных SOL: ${this.wallet.balance.toFixed(4)} < ${cost.toFixed(4)}`);
    }
    const lamports = solToLamports(solAmount);
    const expected = quoteBuy(curve, lamports, this.opts.feePct);

    const fresh = await this.curveAfterLatency(mint, curve);
    if (fresh.complete) throw this.failTx('кривая заполнилась, пока летела транзакция');
    const actual = quoteBuy(fresh, lamports, this.opts.feePct);
    const minOut = (expected * BigInt(Math.round((100 - this.opts.buySlippagePct) * 100))) / 10_000n;
    if (actual < minOut) {
      throw this.failTx(`проскальзывание: получили бы ${pctDiff(actual, expected)} от ожидаемого (лимит −${this.opts.buySlippagePct}%)`);
    }
    this.wallet.recordBuy(cost);
    this.costs.set(mint.toBase58(), cost);
    return { signature: this.nextSignature(), tokenAmount: actual, solSpent: cost };
  }

  async sell(mint: PublicKey, tokenAmount: bigint, curve: BondingCurveState | null): Promise<SellResult> {
    const expected = curve ? quoteSell(curve, tokenAmount, this.opts.feePct) : 0n;
    const fresh = curve ? await this.curveAfterLatency(mint, curve) : null;
    if (!fresh) throw this.failTx('нет данных о цене для продажи');
    const actual = quoteSell(fresh, tokenAmount, this.opts.feePct);
    const minOut = (expected * BigInt(Math.round((100 - this.opts.sellSlippagePct) * 100))) / 10_000n;
    if (expected > 0n && actual < minOut) {
      throw this.failTx(`проскальзывание: получили бы ${pctDiff(actual, expected)} от ожидаемого (лимит −${this.opts.sellSlippagePct}%)`);
    }
    const received = Math.max(0, lamportsToSol(actual) - this.opts.priorityFeeSol);
    this.wallet.recordSell(received, this.costs.get(mint.toBase58()) ?? 0);
    this.costs.delete(mint.toBase58());
    return { signature: this.nextSignature(), solReceived: received };
  }

  private async curveAfterLatency(mint: PublicKey, fallback: BondingCurveState): Promise<BondingCurveState> {
    if (this.opts.latencyMs > 0) await sleep(this.opts.latencyMs);
    try {
      const acc = await this.connection.getAccountInfo(deriveBondingCurve(mint), 'processed');
      return acc ? decodeBondingCurve(acc.data) : fallback;
    } catch (err) {
      log.debug(`paper: не удалось обновить кривую, использую последнюю известную: ${errorMessage(err)}`);
      return fallback;
    }
  }

  private failTx(reason: string): Error {
    this.wallet.recordFailedTx(this.opts.priorityFeeSol);
    return new Error(`транзакция не прошла бы — ${reason}; списана комиссия ${this.opts.priorityFeeSol} SOL`);
  }

  private nextSignature(): string {
    return `paper-${Date.now()}-${++this.counter}`;
  }
}

function pctDiff(actual: bigint, expected: bigint): string {
  if (expected === 0n) return '0%';
  const p = (Number(actual) / Number(expected) - 1) * 100;
  return `${p >= 0 ? '+' : ''}${p.toFixed(1)}%`;
}
