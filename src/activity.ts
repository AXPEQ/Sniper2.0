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
  /** Какую долю купленного разработчик уже продал, % (0 — не продавал). */
  devSoldPct: number;
  /** Доля крупнейшего покупателя в объёме покупок, %. */
  largestBuyerPct: number;
  /** Чистый приток: покупки − продажи (без разработчика), SOL. */
  netFlowSol: number;
  /** Новые покупатели во второй половине окна наблюдения (интерес растёт, а не только снайперы на старте). */
  lateBuyers: number;
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
  startedAt: number;
  windowMs: number;
  lateBuyers: number;
  creationSignature: string;
  devs: Set<string>;
  baselinePrice: number;
  trades: number;
  buyers: Map<string, bigint>;
  holders: Map<string, bigint>;
  buyVolume: bigint;
  sellVolume: bigint;
  devSold: boolean;
  devBought: bigint;
  devSoldTokens: bigint;
  vSol: bigint;
  vTok: bigint;
}

const price = (vSol: bigint, vTok: bigint): number => (vTok === 0n ? 0 : Number(vSol) / Number(vTok));

/** Копит сделки по токенам на наблюдении. */
export class TradeTracker {
  private readonly watched = new Map<string, Watched>();

  isWatched = (mint: string): boolean => this.watched.has(mint);

  watch(
    mint: PublicKey,
    opts: { creationSignature: string; devs: PublicKey[]; initialVSol: bigint; initialVTok: bigint; windowMs?: number; now?: number },
  ): void {
    this.watched.set(mint.toBase58(), {
      startedAt: opts.now ?? Date.now(),
      windowMs: opts.windowMs ?? 0,
      lateBuyers: 0,
      creationSignature: opts.creationSignature,
      devs: new Set(opts.devs.map((d) => d.toBase58())),
      baselinePrice: price(opts.initialVSol, opts.initialVTok),
      trades: 0,
      buyers: new Map(),
      holders: new Map(),
      buyVolume: 0n,
      sellVolume: 0n,
      devSold: false,
      devBought: 0n,
      devSoldTokens: 0n,
      vSol: opts.initialVSol,
      vTok: opts.initialVTok,
    });
  }

  unwatch(mint: PublicKey): void {
    this.watched.delete(mint.toBase58());
  }

  onTrade(trade: TradeEvent, signature: string, now = Date.now()): void {
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
      if (trade.isBuy) w.devBought += trade.tokenAmount;
      else {
        w.devSold = true;
        w.devSoldTokens += trade.tokenAmount;
      }
      return;
    }
    w.trades++;
    if (trade.isBuy) {
      w.buyVolume += trade.solAmount;
      if (!w.buyers.has(user) && w.windowMs > 0 && now - w.startedAt >= w.windowMs / 2) w.lateBuyers++;
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
      devSoldPct: !w.devSold ? 0 : w.devBought > 0n ? Math.min(100, (Number(w.devSoldTokens) / Number(w.devBought)) * 100) : 100,
      largestBuyerPct: w.buyVolume > 0n ? (Number(largest) / Number(w.buyVolume)) * 100 : 0,
      netFlowSol: lamportsToSol(w.buyVolume - w.sellVolume),
      lateBuyers: w.lateBuyers,
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
  | 'minUniqueBuyers'
  | 'minBuyVolumeSol'
  | 'maxSellRatio'
  | 'maxDevSoldPct'
  | 'maxSingleBuyerPct'
  | 'minPriceChangePct'
  | 'maxPriceChangePct'
  | 'minNetFlowSol'
  | 'minLateBuyers'
>;

/** Проверка активности торгов. currentPrice — текущая цена кривой (lamports за raw-токен). */
export function checkActivity(s: ActivityStats, currentPrice: number, rules: ActivityRules): string | null {
  // Частичная фиксация прибыли разработчиком — обычное дело; слив большей части — красный флаг.
  if (s.devSold && s.devSoldPct > rules.maxDevSoldPct) return `разработчик сливает: продал ${s.devSoldPct.toFixed(0)}%`;
  if (s.uniqueBuyers < rules.minUniqueBuyers) return `мало покупателей: ${s.uniqueBuyers} < ${rules.minUniqueBuyers}`;
  if (s.buyVolumeSol < rules.minBuyVolumeSol) {
    return `малый объём покупок: ${s.buyVolumeSol.toFixed(2)} < ${rules.minBuyVolumeSol} SOL`;
  }
  if (s.netFlowSol < rules.minNetFlowSol) return `слабый приток: ${s.netFlowSol.toFixed(2)} SOL`;
  if (s.lateBuyers < rules.minLateBuyers) return `интерес угасает: ${s.lateBuyers} новых покупателей во 2-й половине окна`;
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
