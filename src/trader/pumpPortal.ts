import { VersionedTransaction, type Connection, type Keypair, type PublicKey } from '@solana/web3.js';
import { quoteSell, type BondingCurveState } from '../pump/bondingCurve.js';
import { tokenBalance } from '../filters/index.js';
import { log } from '../logger.js';
import { errorMessage, lamportsToSol, sleep } from '../utils.js';
import { assertTransactionShape, simulateAndCheck } from './guard.js';
import { sendAndConfirm, TxTimeoutError } from './txSender.js';
import type { BuyResult, Executor, SellResult } from './types.js';

const TRADE_LOCAL_URL = 'https://pumpportal.fun/api/trade-local';

/** Запас на ренту токен-аккаунта и комиссии сети сверх суммы сделки. */
const RENT_AND_FEES_MARGIN_SOL = 0.005;

interface PumpPortalOptions {
  buySlippagePct: number;
  sellSlippagePct: number;
  priorityFeeSol: number;
  simulateBeforeSend: boolean;
}

/**
 * Реальная торговля через PumpPortal Local Transaction API: сервис собирает транзакцию
 * (pump.fun bonding curve или PumpSwap после миграции), мы подписываем её локально
 * и отправляем через свой RPC. Приватный ключ никуда не передаётся. Перед подписью
 * транзакция проверяется (fee payer, белый список программ) и симулируется.
 * Комиссия PumpPortal — 0.5% от сделки.
 */
export class PumpPortalExecutor implements Executor {
  readonly mode = 'live' as const;

  constructor(
    private readonly connection: Connection,
    private readonly wallet: Keypair,
    private readonly opts: PumpPortalOptions,
  ) {}

  async buy(mint: PublicKey, solAmount: number): Promise<BuyResult> {
    const tx = await this.buildTx({
      action: 'buy',
      mint: mint.toBase58(),
      amount: solAmount,
      denominatedInSol: 'true',
      slippage: this.opts.buySlippagePct,
    });
    let signature: string;
    try {
      // Комиссия PumpPortal 0.5% + небольшой запас.
      signature = await this.signAndSend(tx, solAmount * 1.01 + this.opts.priorityFeeSol + RENT_AND_FEES_MARGIN_SOL);
    } catch (err) {
      if (!(err instanceof TxTimeoutError)) throw err;
      // Не дождались подтверждения, но транзакция могла пройти: проверяем баланс, чтобы не потерять токены.
      await sleep(5_000);
      const balance = await tokenBalance(this.connection, this.wallet.publicKey, mint);
      if (balance <= 0n) throw err;
      log.warn(`Покупка ${err.signature} подтвердилась с опозданием — беру позицию под управление`);
      return { signature: err.signature, tokenAmount: balance, solSpent: solAmount + this.opts.priorityFeeSol };
    }
    const delta = await this.balanceDelta(signature, mint);
    const tokenAmount = delta?.tokens ?? (await tokenBalance(this.connection, this.wallet.publicKey, mint));
    if (tokenAmount <= 0n) throw new Error(`покупка ${signature} подтверждена, но токены не найдены`);
    return { signature, tokenAmount, solSpent: delta ? -delta.sol : solAmount + this.opts.priorityFeeSol };
  }

  async sell(mint: PublicKey, tokenAmount: bigint, curve: BondingCurveState | null): Promise<SellResult> {
    // Если прошлая попытка продажи прошла с опозданием, токенов уже нет — считаем позицию закрытой.
    const estimate = curve ? lamportsToSol(quoteSell(curve, tokenAmount, 1.75)) - this.opts.priorityFeeSol : 0;
    if ((await tokenBalance(this.connection, this.wallet.publicKey, mint)) === 0n) {
      log.warn(`Токенов ${mint.toBase58()} на кошельке нет — похоже, прошлая продажа прошла с опозданием`);
      return { signature: 'already-sold', solReceived: Math.max(0, estimate) };
    }
    // Продаём весь баланс: так не остаётся «пыли» из-за округлений.
    const tx = await this.buildTx({
      action: 'sell',
      mint: mint.toBase58(),
      amount: '100%',
      denominatedInSol: 'false',
      slippage: this.opts.sellSlippagePct,
    });
    const signature = await this.signAndSend(tx, this.opts.priorityFeeSol + RENT_AND_FEES_MARGIN_SOL);
    const delta = await this.balanceDelta(signature, mint);
    // Если детали транзакции недоступны — оценка по последнему состоянию кривой (pump.fun 1.25% + PumpPortal 0.5%).
    return { signature, solReceived: delta?.sol ?? estimate };
  }

  private async buildTx(params: Record<string, string | number>): Promise<VersionedTransaction> {
    const res = await fetch(TRADE_LOCAL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicKey: this.wallet.publicKey.toBase58(),
        priorityFee: this.opts.priorityFeeSol,
        pool: 'auto',
        ...params,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status !== 200) throw new Error(`PumpPortal HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return VersionedTransaction.deserialize(new Uint8Array(await res.arrayBuffer()));
  }

  /** maxLossSol — сколько максимум кошелёк может потерять в этой транзакции (проверяется симуляцией). */
  private async signAndSend(tx: VersionedTransaction, maxLossSol: number): Promise<string> {
    assertTransactionShape(tx, this.wallet.publicKey);
    if (this.opts.simulateBeforeSend) {
      await simulateAndCheck(this.connection, tx, this.wallet.publicKey, maxLossSol);
    }
    tx.sign([this.wallet]);
    const { signature, err } = await sendAndConfirm(this.connection, tx);
    if (err) throw new Error(`транзакция ${signature} упала: ${JSON.stringify(err)}`);
    return signature;
  }

  /** Изменение баланса SOL и токена кошелька по метаданным транзакции. */
  private async balanceDelta(signature: string, mint: PublicKey): Promise<{ sol: number; tokens: bigint } | null> {
    const owner = this.wallet.publicKey.toBase58();
    const mintStr = mint.toBase58();
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const tx = await this.connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
        if (tx?.meta) {
          const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
          const idx = keys.staticAccountKeys.findIndex((k) => k.toBase58() === owner);
          const sol = idx >= 0 ? lamportsToSol(tx.meta.postBalances[idx]! - tx.meta.preBalances[idx]!) : 0;
          const sum = (list: typeof tx.meta.postTokenBalances) =>
            (list ?? [])
              .filter((b) => b.owner === owner && b.mint === mintStr)
              .reduce((acc, b) => acc + BigInt(b.uiTokenAmount.amount), 0n);
          return { sol, tokens: sum(tx.meta.postTokenBalances) - sum(tx.meta.preTokenBalances) };
        }
      } catch (err) {
        log.debug(`getTransaction ${signature}: ${errorMessage(err)}`);
      }
      await sleep(1_000);
    }
    log.warn(`Не удалось получить детали транзакции ${signature}, использую оценку`);
    return null;
  }
}
