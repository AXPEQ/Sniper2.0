import type { PublicKey } from '@solana/web3.js';
import type { Config } from './config.js';
import type { TradeEvent } from './pump/events.js';
import { lamportsToSol } from './utils.js';

/**
 * Статистика торгов по токену, собранная из потока сделок — без запросов к RPC.
 * Покупатели/объёмы — без учёта разработчика; холдеры — все, включая разработчика.
 */
export interface ActivityStats {
  trades: number;
  uniqueBuyers: number;
  buyVolumeSol: number;
  sellVolumeSol: number;
  devSold: boolean;
  /** Доля крупнейшего покупателя в объёме покупок, %. */
  largestBuyerPct: number;
  /** Цена сразу после транзакции создания (с учётом dev-покупки), lamports за raw-токен. */
  baselinePrice: number;
  /** Сколько токенов (raw) держат разработчики по данным сделок. */
  devTokens: bigint;
  /** Сколько токенов (raw) у 10 крупнейших холдеров по данным сделок. */
  top10Tokens: bigint;
  /** Резервы кривой после последней сделки (или исходные, если сделок не было). */
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
}

interface Watched {
  creationSignature: string;
  devs: Set<string>;
  baselinePrice: number;
  trades: number;
  buyers: Map<string, bigint>;
  holders: Map<string, bigint>;
  buyVolume: bigint;
  sellVolume: bigint;
  devSold: boolean;
  vSol: bigint;
  vTok: bigint;
}

const price = (vSol: bigint, vTok: bigint): number => (vTok === 0n ? 0 : Number(vSol) / Number(vTok));

/** Копит сделки по токенам на наблюдении. */
export class TradeTracker {
  private readonly watched = new Map<string, Watched>();

  isWatched = (mint: string): boolean => this.watched.has(mint);

  watch(mint: PublicKey, opts: { creationSignature: string; devs: PublicKey[]; initialVSol: bigint; initialVTok: bigint }): void {
    this.watched.set(mint.toBase58(), {
      creationSignature: opts.creationSignature,
      devs: new Set(opts.devs.map((d) => d.toBase58())),
      baselinePrice: price(opts.initialVSol, opts.initialVTok),
      trades: 0,
      buyers: new Map(),
      holders: new Map(),
      buyVolume: 0n,
      sellVolume: 0n,
      devSold: false,
      vSol: opts.initialVSol,
      vTok: opts.initialVTok,
    });
  }

  unwatch(mint: PublicKey): void {
    this.watched.delete(mint.toBase58());
  }

  onTrade(trade: TradeEvent, signature: string): void {
    const w = this.watched.get(trade.mint.toBase58());
    if (!w) return;
    const user = trade.user.toBase58();
    const isDev = w.devs.has(user);

    w.vSol = trade.virtualSolReserves;
    w.vTok = trade.virtualTokenReserves;
    const held = (w.holders.get(user) ?? 0n) + (trade.isBuy ? trade.tokenAmount : -trade.tokenAmount);
    w.holders.set(user, held > 0n ? held : 0n);

    // dev-покупка в транзакции создания задаёт базовую цену
    if (signature === w.creationSignature) w.baselinePrice = price(trade.virtualSolReserves, trade.virtualTokenReserves);
    if (isDev) {
      if (!trade.isBuy) w.devSold = true;
      return;
    }
    w.trades++;
    if (trade.isBuy) {
      w.buyVolume += trade.solAmount;
      w.buyers.set(user, (w.buyers.get(user) ?? 0n) + trade.solAmount);
    } else {
      w.sellVolume += trade.solAmount;
    }
  }

  stats(mint: PublicKey): ActivityStats | null {
    const w = this.watched.get(mint.toBase58());
    if (!w) return null;
    let largest = 0n;
    for (const v of w.buyers.values()) if (v > largest) largest = v;
    let devTokens = 0n;
    for (const d of w.devs) devTokens += w.holders.get(d) ?? 0n;
    const top10Tokens = [...w.holders.values()]
      .sort((a, b) => (b > a ? 1 : b < a ? -1 : 0))
      .slice(0, 10)
      .reduce((a, b) => a + b, 0n);
    return {
      trades: w.trades,
      uniqueBuyers: w.buyers.size,
      buyVolumeSol: lamportsToSol(w.buyVolume),
      sellVolumeSol: lamportsToSol(w.sellVolume),
      devSold: w.devSold,
      largestBuyerPct: w.buyVolume > 0n ? (Number(largest) / Number(w.buyVolume)) * 100 : 0,
      baselinePrice: w.baselinePrice,
      devTokens,
      top10Tokens,
      virtualSolReserves: w.vSol,
      virtualTokenReserves: w.vTok,
    };
  }
}

type ActivityRules = Pick<
  Config,
  'minUniqueBuyers' | 'minBuyVolumeSol' | 'maxSellRatio' | 'rejectDevSell' | 'maxSingleBuyerPct' | 'minPriceChangePct' | 'maxPriceChangePct'
>;

/** Проверка активности торгов. currentPrice — текущая цена кривой (lamports за raw-токен). */
export function checkActivity(s: ActivityStats, currentPrice: number, rules: ActivityRules): string | null {
  if (rules.rejectDevSell && s.devSold) return 'разработчик продаёт';
  if (s.uniqueBuyers < rules.minUniqueBuyers) return `мало покупателей: ${s.uniqueBuyers} < ${rules.minUniqueBuyers}`;
  if (s.buyVolumeSol < rules.minBuyVolumeSol) {
    return `малый объём покупок: ${s.buyVolumeSol.toFixed(2)} < ${rules.minBuyVolumeSol} SOL`;
  }
  if (rules.maxSellRatio > 0 && s.buyVolumeSol > 0 && s.sellVolumeSol / s.buyVolumeSol > rules.maxSellRatio) {
    return `много продаж: ${((s.sellVolumeSol / s.buyVolumeSol) * 100).toFixed(0)}% от покупок`;
  }
  if (rules.maxSingleBuyerPct > 0 && s.uniqueBuyers > 0 && s.largestBuyerPct > rules.maxSingleBuyerPct) {
    return `один кошелёк скупает: ${s.largestBuyerPct.toFixed(0)}% объёма`;
  }
  if (s.baselinePrice > 0 && currentPrice > 0) {
    const change = (currentPrice / s.baselinePrice - 1) * 100;
    if (change < rules.minPriceChangePct) return `цена ниже старта: ${change.toFixed(0)}%`;
    if (rules.maxPriceChangePct > 0 && change > rules.maxPriceChangePct) return `уже вырос: +${change.toFixed(0)}%`;
  }
  return null;
}
