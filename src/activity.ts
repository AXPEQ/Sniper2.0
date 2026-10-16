import type { PublicKey } from '@solana/web3.js';
import type { Config } from './config.js';
import type { TradeEvent } from './pump/events.js';
import { lamportsToSol } from './utils.js';

/** Статистика торгов по токену за окно наблюдения (без сделок разработчика). */
export interface ActivityStats {
  trades: number;
  uniqueBuyers: number;
  buyVolumeSol: number;
  sellVolumeSol: number;
  devSold: boolean;
  /** Доля крупнейшего покупателя в объёме покупок, %. */
  largestBuyerPct: number;
  /** Сколько сторонних кошельков купили в том же слоте, что и создание (признак бандла/инсайдеров). */
  bundledBuyers: number;
  /** Цена сразу после транзакции создания (с учётом dev-покупки), lamports за raw-токен. */
  baselinePrice: number;
}

interface Watched {
  creationSignature: string;
  creationSlot: number;
  devs: Set<string>;
  baselinePrice: number;
  trades: number;
  buyers: Map<string, bigint>;
  buyVolume: bigint;
  sellVolume: bigint;
  devSold: boolean;
  bundled: Set<string>;
}

const price = (vSol: bigint, vTok: bigint): number => (vTok === 0n ? 0 : Number(vSol) / Number(vTok));

/** Копит сделки по токенам, которые сейчас на наблюдении (поток TradeEvent из той же подписки на логи). */
export class TradeTracker {
  private readonly watched = new Map<string, Watched>();

  isWatched = (mint: string): boolean => this.watched.has(mint);

  watch(
    mint: PublicKey,
    opts: { creationSignature: string; creationSlot: number; devs: PublicKey[]; initialVSol: bigint; initialVTok: bigint },
  ): void {
    this.watched.set(mint.toBase58(), {
      creationSignature: opts.creationSignature,
      creationSlot: opts.creationSlot,
      devs: new Set(opts.devs.map((d) => d.toBase58())),
      baselinePrice: price(opts.initialVSol, opts.initialVTok),
      trades: 0,
      buyers: new Map(),
      buyVolume: 0n,
      sellVolume: 0n,
      devSold: false,
      bundled: new Set(),
    });
  }

  unwatch(mint: PublicKey): void {
    this.watched.delete(mint.toBase58());
  }

  onTrade(trade: TradeEvent, signature: string, slot: number): void {
    const w = this.watched.get(trade.mint.toBase58());
    if (!w) return;
    const user = trade.user.toBase58();
    const isDev = w.devs.has(user);

    if (signature === w.creationSignature) {
      // dev-покупка в транзакции создания задаёт базовую цену
      w.baselinePrice = price(trade.virtualSolReserves, trade.virtualTokenReserves);
      if (isDev) return;
    }
    if (isDev) {
      if (!trade.isBuy) w.devSold = true;
      return;
    }
    w.trades++;
    if (trade.isBuy) {
      w.buyVolume += trade.solAmount;
      w.buyers.set(user, (w.buyers.get(user) ?? 0n) + trade.solAmount);
      if (slot <= w.creationSlot) w.bundled.add(user);
    } else {
      w.sellVolume += trade.solAmount;
    }
  }

  stats(mint: PublicKey): ActivityStats | null {
    const w = this.watched.get(mint.toBase58());
    if (!w) return null;
    let largest = 0n;
    for (const v of w.buyers.values()) if (v > largest) largest = v;
    return {
      trades: w.trades,
      uniqueBuyers: w.buyers.size,
      buyVolumeSol: lamportsToSol(w.buyVolume),
      sellVolumeSol: lamportsToSol(w.sellVolume),
      devSold: w.devSold,
      largestBuyerPct: w.buyVolume > 0n ? (Number(largest) / Number(w.buyVolume)) * 100 : 0,
      bundledBuyers: w.bundled.size,
      baselinePrice: w.baselinePrice,
    };
  }
}

type ActivityRules = Pick<
  Config,
  | 'minUniqueBuyers'
  | 'minBuyVolumeSol'
  | 'maxSellRatio'
  | 'rejectDevSell'
  | 'maxSingleBuyerPct'
  | 'maxBundledBuyers'
  | 'minPriceChangePct'
  | 'maxPriceChangePct'
>;

/** Проверка активности торгов. currentPrice — текущая цена кривой (lamports за raw-токен). */
export function checkActivity(s: ActivityStats, currentPrice: number, rules: ActivityRules): string | null {
  if (rules.rejectDevSell && s.devSold) return 'разработчик продаёт';
  if (rules.maxBundledBuyers >= 0 && s.bundledBuyers > rules.maxBundledBuyers) {
    return `бандл: ${s.bundledBuyers} покупателей в блоке создания`;
  }
  if (s.uniqueBuyers < rules.minUniqueBuyers) return `мало покупателей: ${s.uniqueBuyers} < ${rules.minUniqueBuyers}`;
  if (s.buyVolumeSol < rules.minBuyVolumeSol) {
    return `малый объём покупок: ${s.buyVolumeSol.toFixed(2)} < ${rules.minBuyVolumeSol} SOL`;
  }
  if (rules.maxSellRatio > 0 && s.buyVolumeSol > 0 && s.sellVolumeSol / s.buyVolumeSol > rules.maxSellRatio) {
    return `много продаж: ${((s.sellVolumeSol / s.buyVolumeSol) * 100).toFixed(0)}% от покупок`;
  }
  if (rules.maxSingleBuyerPct > 0 && s.uniqueBuyers > 0 && s.largestBuyerPct > rules.maxSingleBuyerPct) {
    return `один кошелёк купил ${s.largestBuyerPct.toFixed(0)}% объёма`;
  }
  if (s.baselinePrice > 0 && currentPrice > 0) {
    const change = (currentPrice / s.baselinePrice - 1) * 100;
    if (change < rules.minPriceChangePct) return `цена ${change.toFixed(0)}% от старта (< ${rules.minPriceChangePct}%)`;
    if (rules.maxPriceChangePct > 0 && change > rules.maxPriceChangePct) {
      return `уже вырос на ${change.toFixed(0)}% (> ${rules.maxPriceChangePct}%)`;
    }
  }
  return null;
}
