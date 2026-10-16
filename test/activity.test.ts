import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { checkActivity, TradeTracker, type ActivityStats } from '../src/activity.js';
import { loadConfig } from '../src/config.js';
import type { TradeEvent } from '../src/pump/events.js';

const mint = Keypair.generate().publicKey;
const dev = Keypair.generate().publicKey;
const wallets = Array.from({ length: 12 }, () => Keypair.generate().publicKey);
const VSOL = 30_000_000_000n;
const VTOK = 1_073_000_000_000_000n;

const trade = (user = wallets[0]!, isBuy = true, sol = 500_000_000n, tokens = 10_000_000_000_000n, vSol = VSOL, vTok = VTOK): TradeEvent => ({
  mint,
  solAmount: sol,
  tokenAmount: tokens,
  isBuy,
  user,
  timestamp: 0,
  virtualSolReserves: vSol,
  virtualTokenReserves: vTok,
});

function tracker(): TradeTracker {
  const t = new TradeTracker();
  t.watch(mint, { creationSignature: 'create', devs: [dev], initialVSol: VSOL, initialVTok: VTOK });
  return t;
}

describe('TradeTracker', () => {
  it('ignores unwatched tokens', () => {
    const t = new TradeTracker();
    t.onTrade(trade(), 'sig');
    expect(t.stats(mint)).toBeNull();
    expect(t.isWatched(mint.toBase58())).toBe(false);
  });

  it('starts from the initial reserves', () => {
    const s = tracker().stats(mint)!;
    expect(s.virtualSolReserves).toBe(VSOL);
    expect(s.devTokens).toBe(0n);
  });

  it('uses the dev buy in the creation tx as baseline, counts dev holdings, excludes dev from buyers', () => {
    const t = tracker();
    t.onTrade(trade(dev, true, 2_000_000_000n, 67_000_000_000_000n, 32_000_000_000n, 1_006_000_000_000_000n), 'create');
    const s = t.stats(mint)!;
    expect(s.uniqueBuyers).toBe(0);
    expect(s.devTokens).toBe(67_000_000_000_000n);
    expect(s.baselinePrice).toBeCloseTo(32_000_000_000 / 1_006_000_000_000_000, 12);
    expect(s.virtualSolReserves).toBe(32_000_000_000n);
  });

  it('aggregates buyers, volume, sells, holders and dev sells', () => {
    const t = tracker();
    t.onTrade(trade(dev, true, 1_000_000_000n, 30n), 'create');
    t.onTrade(trade(wallets[0], true, 1_000_000_000n, 20n), 'a');
    t.onTrade(trade(wallets[1], true, 500_000_000n, 10n), 'b');
    t.onTrade(trade(wallets[1], true, 500_000_000n, 10n), 'c');
    t.onTrade(trade(wallets[2], false, 400_000_000n, 5n), 'd'); // продал больше, чем было — баланс не уходит в минус
    t.onTrade(trade(dev, false, 100_000_000n, 10n, 31_000_000_000n, 1_040_000_000_000_000n), 'e');
    const s = t.stats(mint)!;
    expect(s.uniqueBuyers).toBe(2);
    expect(s.buyVolumeSol).toBeCloseTo(2);
    expect(s.sellVolumeSol).toBeCloseTo(0.4);
    expect(s.largestBuyerPct).toBeCloseTo(50);
    expect(s.devSold).toBe(true);
    expect(s.devTokens).toBe(20n);
    expect(s.top10Tokens).toBe(60n); // dev 20 + 20 + 20
    expect(s.virtualTokenReserves).toBe(1_040_000_000_000_000n);
    t.unwatch(mint);
    expect(t.stats(mint)).toBeNull();
  });
});

const strict = loadConfig({ FILTER_PRESET: 'strict' });
const good: ActivityStats = {
  trades: 20,
  uniqueBuyers: 15,
  buyVolumeSol: 5,
  sellVolumeSol: 1,
  devSold: false,
  largestBuyerPct: 15,
  baselinePrice: 1,
  devTokens: 0n,
  top10Tokens: 0n,
  virtualSolReserves: VSOL,
  virtualTokenReserves: VTOK,
};

describe('checkActivity (strict)', () => {
  it('passes healthy activity', () => {
    expect(checkActivity(good, 1.5, strict)).toBeNull();
  });
  it.each([
    [{ devSold: true }, 1.5, 'разработчик'],
    [{ uniqueBuyers: 3 }, 1.5, 'мало покупателей'],
    [{ buyVolumeSol: 0.5 }, 1.5, 'малый объём'],
    [{ sellVolumeSol: 4 }, 1.5, 'много продаж'],
    [{ largestBuyerPct: 70 }, 1.5, 'один кошелёк'],
    [{}, 0.9, 'ниже старта'],
    [{}, 3, 'уже вырос'],
  ] as const)('rejects %o at price %s', (patch, price, reason) => {
    expect(checkActivity({ ...good, ...patch }, price, strict)).toContain(reason);
  });
  it('normal preset does not check activity', () => {
    const normal = loadConfig({ FILTER_PRESET: 'normal' });
    expect(checkActivity({ ...good, uniqueBuyers: 0, buyVolumeSol: 0, devSold: true }, 0.5, normal)).toBeNull();
  });
});
