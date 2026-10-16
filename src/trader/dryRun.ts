import type { PublicKey } from '@solana/web3.js';
import { quoteBuy, quoteSell, type BondingCurveState } from '../pump/bondingCurve.js';
import { lamportsToSol, solToLamports } from '../utils.js';
import type { BuyResult, Executor, SellResult } from './types.js';

/** Бумажная торговля: считает сделки по формуле кривой, ничего не отправляет в сеть. */
export class DryRunExecutor implements Executor {
  readonly mode = 'dry-run' as const;
  private counter = 0;

  constructor(
    private readonly feePct: number,
    private readonly priorityFeeSol: number,
  ) {}

  async buy(_mint: PublicKey, solAmount: number, curve: BondingCurveState): Promise<BuyResult> {
    return {
      signature: this.fakeSignature(),
      tokenAmount: quoteBuy(curve, solToLamports(solAmount), this.feePct),
      solSpent: solAmount + this.priorityFeeSol,
    };
  }

  async sell(_mint: PublicKey, tokenAmount: bigint, curve: BondingCurveState | null): Promise<SellResult> {
    const gross = curve ? lamportsToSol(quoteSell(curve, tokenAmount, this.feePct)) : 0;
    return { signature: this.fakeSignature(), solReceived: Math.max(0, gross - this.priorityFeeSol) };
  }

  private fakeSignature(): string {
    return `dry-run-${Date.now()}-${++this.counter}`;
  }
}
