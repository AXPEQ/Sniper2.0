import { describe, expect, it } from 'vitest';
import { costWarnings, loadConfig, redactUrl } from '../src/config.js';

describe('loadConfig', () => {
  it('defaults to dry run', () => {
    const cfg = loadConfig({});
    expect(cfg.dryRun).toBe(true);
    expect(cfg.buyAmountSol).toBe(0.05);
  });
  it('requires a key for live mode', () => {
    expect(() => loadConfig({ DRY_RUN: 'false' })).toThrow('PRIVATE_KEY');
  });
  it('validates numbers and ranges', () => {
    expect(() => loadConfig({ BUY_AMOUNT_SOL: 'abc' })).toThrow('BUY_AMOUNT_SOL');
    expect(() => loadConfig({ STOP_LOSS_PCT: '100' })).toThrow('STOP_LOSS_PCT');
  });
  it('parses lists', () => {
    expect(loadConfig({ NAME_BLACKLIST: ' Rug , SCAM,,' }).nameBlacklist).toEqual(['rug', 'scam']);
  });
  it('uses the strict preset by default and allows overrides', () => {
    const cfg = loadConfig({});
    expect(cfg.filterPreset).toBe('strict');
    expect(cfg.buyDelayMs).toBe(6000);
    expect(cfg.minUniqueBuyers).toBe(8);
    expect(loadConfig({ MIN_UNIQUE_BUYERS: '20' }).minUniqueBuyers).toBe(20);
    expect(loadConfig({ FILTER_PRESET: 'normal' }).buyDelayMs).toBe(0);
    expect(() => loadConfig({ FILTER_PRESET: 'yolo' })).toThrow('FILTER_PRESET');
  });
  it('builds Helius urls from HELIUS_API_KEY and redacts them', () => {
    const cfg = loadConfig({ HELIUS_API_KEY: 'k123' });
    expect(cfg.rpcUrl).toBe('https://mainnet.helius-rpc.com/?api-key=k123');
    // подписки по умолчанию — через бесплатный публичный WebSocket, а не Helius
    expect(cfg.wsUrl).toBe('wss://api.mainnet-beta.solana.com');
    expect(loadConfig({ HELIUS_API_KEY: 'k', STREAM_WS_URL: 'wss://x' }).wsUrl).toBe('wss://x');
    expect(redactUrl(cfg.rpcUrl)).toBe('https://mainnet.helius-rpc.com/?api-key=***');
    expect(loadConfig({ HELIUS_API_KEY: 'k', RPC_URL: 'https://my.rpc' }).rpcUrl).toBe('https://my.rpc');
  });
  it('warns about settings that burn RPC credits', () => {
    expect(costWarnings(loadConfig({}))).toEqual([]);
    expect(costWarnings(loadConfig({ PRICE_POLL_MS: '2000' }))[0]).toContain('PRICE_POLL_MS=2000');
    expect(costWarnings(loadConfig({ STREAM_WS_URL: 'wss://mainnet.helius-rpc.com/?api-key=k' }))[0]).toContain('Helius WebSocket');
  });
});
