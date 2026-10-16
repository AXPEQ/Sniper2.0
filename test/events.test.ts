import { describe, expect, it } from 'vitest';
import { CREATE_EVENT_DISCRIMINATOR, decodeCreateEvent, extractCreateEvents } from '../src/pump/events.js';

// Реальные логи mainnet (CreateV2, Token-2022), пойманные через logsSubscribe.
const NORMAL =
  'G3KpTd7rY3YJAAAA5a6u55m+6JCsCwAAAEdPTkcgQkFJV0FOQAAAAGh0dHBzOi8vbWV0YS51eGVudG8uaW8vZGF0YS80ZjQyNTJiMy0yNmFjLTRiN2EtOWVjOC05NzYwMWUzZTJjYmYsKk/yNH5d9nmm2eoMTfs5gYn4Rh1NYEn5D2QYSJhxj/hjbJPRWELIgbUu/7NCO2IkkpcMFpcT0g+LsxMsmqQnie2PKdVScRq4L/jhpL0jkBMeJD5/P74+irPPj20jbs6tyA1xvI9dmQwDONczONbb+qi5gDzIDf8nIqhY6Wr8BKsV0moAAAAAABDYR+PPAwAArCP8BgAAAAB4xftR0QIAAIDGpH6NAwAG3fbh7nWP3hhCXbzkbM3athr8TYO5DSf+vfko2KGL/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAArCP8BgAAAAAAAAAAAAAAAQA=';
const MAYHEM =
  'G3KpTd7rY3YJAAAAU211ZyBTcHVkBAAAAFNQVURQAAAAaHR0cHM6Ly9pcGZzLmlvL2lwZnMvYmFma3JlaWZhanRxcnQ3Z3dxbWF0bWV0YWZmbjVmbjdzZGtnMnN3YnVueHF1MnV1amdic3R3d3J5ZmnW/9LJ6UtJ4pWvQl5q/uXaz1HHYXYqZY0HZOkQG5lk34kI8zkAR2i2Ir31c7Wad6okd1bwksHFg+urFz5qMPntatEgyFvInPzil4k0R7iCzLulXrNHW7Qfpyp+3iiZRTRx1un8EOymhOiKADw/6IEgB5lRN2mMFYSZgoepzXmn16sV0moAAAAAABDYR+PPAwAArCP8BgAAAAB4xftR0QIAAIDGpH6NAwAG3fbh7nWP3hhCXbzkbM3athr8TYO5DSf+vfko2KGL/AEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAArCP8BgAAAAAAAAAAAAAAAQA=';
// TradeEvent из той же транзакции — должен игнорироваться.
const TRADE = 'vdt/007mYe4sKk/yNH5d9nmm2eoMTfs5gYn4Rh1NYEn5D2QYSJhxj2HRvHUAAAAAozFzWEk8AAAB';

describe('CreateEvent', () => {
  it('has the anchor discriminator pump.fun emits', () => {
    expect([...CREATE_EVENT_DISCRIMINATOR]).toEqual([27, 114, 169, 77, 222, 235, 99, 118]);
  });

  it('decodes a real CreateV2 event', () => {
    const ev = decodeCreateEvent(Buffer.from(NORMAL, 'base64'))!;
    expect(ev.name).toBe('宮百萬');
    expect(ev.symbol).toBe('GONG BAIWAN');
    expect(ev.uri).toBe('https://meta.uxento.io/data/4f4252b3-26ac-4b7a-9ec8-97601e3e2cbf');
    expect(ev.mint.toBase58()).toBe('3yQMsikaczBsdawtSoeaWQRc6BUXTFG8L1kgKLNXpump');
    expect(ev.bondingCurve.toBase58()).toBe('Hic3LQE9wAHBiW3kpqZ2GMdFKtDAgkr5wUxpHEkJ1Jog');
    expect(ev.user.toBase58()).toBe('AHQxHWL1AFQJvi7kmrw67u6H3cayMNRATcwqa7wr61Kb');
    expect(ev.creator?.toBase58()).toBe('ChNTdf6JQ4W29Gvsx4BT5CQmEiHSVJY5ijYEEqhThzxj');
    expect(ev.virtualSolReserves).toBe(30_000_000_000n);
    expect(ev.virtualTokenReserves).toBe(1_073_000_000_000_000n);
    expect(ev.tokenTotalSupply).toBe(1_000_000_000_000_000n);
    expect(ev.tokenProgram?.toBase58()).toBe('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
    expect(ev.isMayhemMode).toBe(false);
  });

  it('reads the mayhem mode flag', () => {
    expect(decodeCreateEvent(Buffer.from(MAYHEM, 'base64'))?.isMayhemMode).toBe(true);
  });

  it('accepts the legacy layout that ends after user', () => {
    const full = Buffer.from(NORMAL, 'base64');
    // discriminator + 3 строки + 3 pubkey
    const nameLen = full.readUInt32LE(8);
    const symLen = full.readUInt32LE(12 + nameLen);
    const uriLen = full.readUInt32LE(16 + nameLen + symLen);
    const legacy = full.subarray(0, 20 + nameLen + symLen + uriLen + 96);
    const ev = decodeCreateEvent(legacy)!;
    expect(ev.user.toBase58()).toBe('AHQxHWL1AFQJvi7kmrw67u6H3cayMNRATcwqa7wr61Kb');
    expect(ev.creator).toBeUndefined();
  });

  it('rejects truncated data instead of throwing', () => {
    expect(decodeCreateEvent(Buffer.from(NORMAL, 'base64').subarray(0, 60))).toBeNull();
  });

  it('extracts only create events from logs', () => {
    const logs = [
      'Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]',
      'Program log: Instruction: CreateV2',
      `Program data: ${NORMAL}`,
      `Program data: ${TRADE}`,
      'Program log: Instruction: BuyV2',
    ];
    const events = extractCreateEvents(logs);
    expect(events).toHaveLength(1);
    expect(events[0]!.symbol).toBe('GONG BAIWAN');
  });
});
