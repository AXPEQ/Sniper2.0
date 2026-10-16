import { Keypair, type Connection } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import type { ActivityStats } from '../src/activity.js';
import { loadConfig } from '../src/config.js';
import { TokenFilter } from '../src/filters/index.js';
import { deriveBondingCurve } from '../src/pump/bondingCurve.js';
import type { CreateEvent } from '../src/pump/events.js';

/** Подменный RPC, считающий запросы (каждый запрос к Helius = кредит). */
function fakeRpc(opts: { bundled?: number; devLamports?: number } = {}) {
  const calls: string[] = [];
  const conn = {
    getParsedAccountInfo: async () => {
      calls.push('getParsedAccountInfo');
      return { value: { data: { program: 'spl-token-2022', parsed: { type: 'mint', info: { mintAuthority: null, freezeAuthority: null } }, space: 0 } } };
    },
    getBalance: async () => {
      calls.push('getBalance');
      return opts.devLamports ?? 1_000_000_000;
    },
    getSignaturesForAddress: async () => {
      calls.push('getSignaturesForAddress');
      return [
        { signature: 'create', slot: 100, err: null },
        ...Array.from({ length: opts.bundled ?? 0 }, (_, i) => ({ signature: `b${i}`, slot: 100, err: null })),
        { signature: 'later', slot: 105, err: null },
      ];
    },
  };
  return { conn: conn as unknown as Connection, calls };
}

const mint = Keypair.generate().publicKey;
const event: CreateEvent = {
  name: 'Test',
  symbol: 'TST',
  uri: 'x',
  mint,
  bondingCurve: deriveBondingCurve(mint),
  user: Keypair.generate().publicKey,
  virtualSolReserves: 30_000_000_000n,
  virtualTokenReserves: 1_073_000_000_000_000n,
  tokenTotalSupply: 1_000_000_000_000_000n,
};

const healthy: ActivityStats = {
  trades: 20,
  uniqueBuyers: 15,
  buyVolumeSol: 6,
  sellVolumeSol: 1,
  devSold: false,
  devSoldPct: 0,
  largestBuyerPct: 15,
  baselinePrice: 30_000_000_000 / 1_073_000_000_000_000,
  devTokens: 10_000_000_000_000n, // 1%
  top10Tokens: 150_000_000_000_000n, // 15%
  // ~36 SOL capitalisation, price +30% vs start
  virtualSolReserves: 36_000_000_000n,
  virtualTokenReserves: 990_000_000_000_000n,
};

const cfg = loadConfig({ FILTER_PRESET: 'strict' });
const ctx = (activity: ActivityStats | null) => ({
  activity,
  metadata: Promise.resolve({ twitter: 'https://x.com/test', image: 'img' }),
  creationSignature: 'create',
  creationSlot: 100,
});

describe('deepCheck (strict) — credit usage', () => {
  it('rejects on stream data without any RPC call', async () => {
    const { conn, calls } = fakeRpc();
    const res = await new TokenFilter(conn, cfg).deepCheck(event, ctx({ ...healthy, uniqueBuyers: 2 }));
    expect(res.reason).toContain('мало покупателей');
    expect(calls).toEqual([]);
  });

  it('rejects on metadata without any RPC call', async () => {
    const { conn, calls } = fakeRpc();
    const res = await new TokenFilter(conn, cfg).deepCheck(event, { ...ctx(healthy), metadata: Promise.resolve({}) });
    expect(res.reason).toContain('соцсетей');
    expect(calls).toEqual([]);
  });

  it('rejects dev/top-10 concentration from stream data', async () => {
    const { conn, calls } = fakeRpc();
    const filter = new TokenFilter(conn, cfg);
    expect((await filter.deepCheck(event, ctx({ ...healthy, devTokens: 80_000_000_000_000n }))).reason).toContain('dev держит');
    expect((await filter.deepCheck(event, ctx({ ...healthy, top10Tokens: 400_000_000_000_000n }))).reason).toContain('топ-10');
    expect(calls).toEqual([]);
  });

  it('a finalist costs at most 3 RPC calls and gets a curve from the stream', async () => {
    const { conn, calls } = fakeRpc();
    const res = await new TokenFilter(conn, cfg).deepCheck(event, ctx(healthy));
    expect(res.reason).toBeUndefined();
    expect(res.curve?.virtualSolReserves).toBe(36_000_000_000n);
    expect(calls.length).toBeLessThanOrEqual(3);
  });

  it('detects bundles from signatures in the creation slot', async () => {
    const { conn } = fakeRpc({ bundled: 5 });
    expect((await new TokenFilter(conn, cfg).deepCheck(event, ctx(healthy))).reason).toContain('бандл: 5');
  });

  it('rejects an empty dev wallet', async () => {
    const { conn } = fakeRpc({ devLamports: 10_000_000 });
    expect((await new TokenFilter(conn, cfg).deepCheck(event, ctx(healthy))).reason).toContain('пустой кошелёк');
  });

  it('rejects a bonding curve that is not the pump.fun PDA', async () => {
    const { conn } = fakeRpc();
    const fake = { ...event, bondingCurve: Keypair.generate().publicKey };
    expect((await new TokenFilter(conn, cfg).deepCheck(fake, ctx(healthy))).reason).toContain('bonding curve');
  });
});
