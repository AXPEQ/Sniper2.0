import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, type Connection } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import type { BondingCurveState } from '../src/pump/bondingCurve.js';
import { PaperExecutor, PaperWallet } from '../src/trader/paper.js';

const curve = (vSol: bigint, vTok: bigint): BondingCurveState => ({
  virtualSolReserves: vSol,
  virtualTokenReserves: vTok,
  realSolReserves: 0n,
  realTokenReserves: 0n,
  tokenTotalSupply: 1_000_000_000_000_000n,
  complete: false,
});
const START = curve(30_000_000_000n, 1_073_000_000_000_000n);

function curveData(c: BondingCurveState): Buffer {
  const d = Buffer.alloc(81);
  d.writeBigUInt64LE(c.virtualTokenReserves, 8);
  d.writeBigUInt64LE(c.virtualSolReserves, 16);
  d.writeBigUInt64LE(c.tokenTotalSupply, 40);
  d[48] = c.complete ? 1 : 0;
  return d;
}

/** Подменный RPC: getAccountInfo возвращает заданное «будущее» состояние кривой. */
function fakeConnection(next: () => BondingCurveState): Connection {
  return { getAccountInfo: async () => ({ data: curveData(next()) }) } as unknown as Connection;
}

const opts = { feePct: 1.75, priorityFeeSol: 0.001, latencyMs: 0, accountRentSol: 0.002, buySlippagePct: 25, sellSlippagePct: 30 };
const walletFile = () => join(mkdtempSync(join(tmpdir(), 'paper-')), 'wallet.json');

describe('PaperWallet', () => {
  it('persists balance between runs and can be reset', () => {
    const file = walletFile();
    const w = new PaperWallet(file, 5, false);
    w.recordBuy(1);
    expect(new PaperWallet(file, 5, false).balance).toBe(4);
    expect(JSON.parse(readFileSync(file, 'utf8')).buys).toBe(1);
    expect(new PaperWallet(file, 5, true).balance).toBe(5);
  });
});

describe('PaperExecutor', () => {
  const mint = Keypair.generate().publicKey;

  it('buys at the price after latency and charges all costs', async () => {
    const wallet = new PaperWallet(walletFile(), 1, true);
    const ex = new PaperExecutor(fakeConnection(() => START), wallet, opts);
    const res = await ex.buy(mint, 0.1, START);
    expect(res.solSpent).toBeCloseTo(0.103);
    expect(res.tokenAmount).toBeGreaterThan(0n);
    expect(wallet.balance).toBeCloseTo(0.897);
  });

  it('fails like a real tx when the price ran away beyond slippage', async () => {
    const wallet = new PaperWallet(walletFile(), 1, true);
    // за время «полёта» транзакции цена выросла в ~2 раза
    const ex = new PaperExecutor(fakeConnection(() => curve(42_000_000_000n, 766_000_000_000_000n)), wallet, opts);
    await expect(ex.buy(mint, 0.1, START)).rejects.toThrow('проскальзывание');
    expect(wallet.balance).toBeCloseTo(0.999); // списана только комиссия
  });

  it('rejects buys beyond the virtual balance', async () => {
    const wallet = new PaperWallet(walletFile(), 0.05, true);
    const ex = new PaperExecutor(fakeConnection(() => START), wallet, opts);
    await expect(ex.buy(mint, 0.1, START)).rejects.toThrow('недостаточно виртуальных SOL');
  });

  it('round trip on a flat curve loses fees, rent and priority fees', async () => {
    const wallet = new PaperWallet(walletFile(), 1, true);
    let state = START;
    const ex = new PaperExecutor(fakeConnection(() => state), wallet, opts);
    const buy = await ex.buy(mint, 0.1, state);
    state = curve(state.virtualSolReserves + 98_250_000n, state.virtualTokenReserves - buy.tokenAmount);
    const sell = await ex.sell(mint, buy.tokenAmount, state);
    expect(sell.solReceived).toBeGreaterThan(0.094);
    expect(sell.solReceived).toBeLessThan(0.097);
    expect(wallet.balance).toBeCloseTo(1 - 0.103 + sell.solReceived, 6);
  });
});
