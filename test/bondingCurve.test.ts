import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { decodeBondingCurve, deriveBondingCurve, marketCapSol, quoteBuy, quoteSell } from '../src/pump/bondingCurve.js';

const INITIAL = {
  virtualTokenReserves: 1_073_000_000_000_000n,
  virtualSolReserves: 30_000_000_000n,
  tokenTotalSupply: 1_000_000_000_000_000n,
};

describe('bonding curve', () => {
  it('derives the PDA for a real mint', () => {
    const mint = new PublicKey('3yQMsikaczBsdawtSoeaWQRc6BUXTFG8L1kgKLNXpump');
    expect(deriveBondingCurve(mint).toBase58()).toBe('Hic3LQE9wAHBiW3kpqZ2GMdFKtDAgkr5wUxpHEkJ1Jog');
  });

  it('decodes account data', () => {
    const data = Buffer.alloc(81);
    data.writeBigUInt64LE(1n, 8);
    data.writeBigUInt64LE(2n, 16);
    data.writeBigUInt64LE(3n, 24);
    data.writeBigUInt64LE(4n, 32);
    data.writeBigUInt64LE(5n, 40);
    data[48] = 1;
    const s = decodeBondingCurve(data);
    expect(s).toMatchObject({ virtualTokenReserves: 1n, virtualSolReserves: 2n, realTokenReserves: 3n, realSolReserves: 4n, tokenTotalSupply: 5n, complete: true });
    expect(s.creator).toBeDefined();
  });

  it('computes initial market cap (~28 SOL)', () => {
    expect(marketCapSol(INITIAL)).toBeCloseTo(27.96, 2);
  });

  it('quotes a buy close to the pump.fun curve', () => {
    // 1 SOL без комиссии на старте кривой ≈ 34.6M токенов
    const out = quoteBuy(INITIAL, 1_000_000_000n, 0);
    expect(Number(out) / 1e12).toBeCloseTo(34.6, 1);
    expect(quoteBuy(INITIAL, 1_000_000_000n, 1.25)).toBeLessThan(out);
  });

  it('buy then immediate sell loses roughly two fees', () => {
    const fee = 1.25;
    const tokens = quoteBuy(INITIAL, 1_000_000_000n, fee);
    const after = {
      virtualSolReserves: INITIAL.virtualSolReserves + (1_000_000_000n * 9875n) / 10000n,
      virtualTokenReserves: INITIAL.virtualTokenReserves - tokens,
    };
    const back = Number(quoteSell(after, tokens, fee)) / 1e9;
    expect(back).toBeGreaterThan(0.97);
    expect(back).toBeLessThan(0.98);
  });

  it('returns zero for empty input', () => {
    expect(quoteSell(INITIAL, 0n, 1)).toBe(0n);
    expect(quoteBuy(INITIAL, 0n, 1)).toBe(0n);
  });
});
