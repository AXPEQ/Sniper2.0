import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

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
});
