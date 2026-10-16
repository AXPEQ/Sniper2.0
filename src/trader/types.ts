import type { PublicKey } from '@solana/web3.js';
import type { BondingCurveState } from '../pump/bondingCurve.js';

export interface BuyResult {
  signature: string;
  /** Получено токенов (raw, с учётом decimals). */
  tokenAmount: bigint;
  /** Фактически потрачено SOL, включая комиссии сети. */
  solSpent: number;
}

export interface SellResult {
  signature: string;
  /** Фактически получено SOL за вычетом комиссий сети. */
  solReceived: number;
}

export interface Executor {
  readonly mode: 'dry-run' | 'live';
  buy(mint: PublicKey, solAmount: number, curve: BondingCurveState): Promise<BuyResult>;
  /** curve — последнее известное состояние кривой (null, если токен уже мигрировал и цены нет). */
  sell(mint: PublicKey, tokenAmount: bigint, curve: BondingCurveState | null): Promise<SellResult>;
}
