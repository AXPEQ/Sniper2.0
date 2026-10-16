import { describe, expect, it } from 'vitest';
import { evaluateExit, type ExitRules } from '../src/positions.js';

const rules: ExitRules = { takeProfitPct: 100, stopLossPct: 30, trailingStopPct: 20, trailingActivationPct: 30, maxHoldSeconds: 300 };
const pos = (peak = 1) => ({ costSol: 1, peakValueSol: peak, openedAt: 0 });

describe('evaluateExit', () => {
  it('holds inside the range', () => {
    expect(evaluateExit(pos(), 1.1, 1000, rules)).toBeNull();
  });
  it('takes profit', () => {
    expect(evaluateExit(pos(2), 2.0, 1000, rules)).toBe('take_profit');
  });
  it('stops loss', () => {
    expect(evaluateExit(pos(), 0.7, 1000, rules)).toBe('stop_loss');
  });
  it('trails only after activation', () => {
    // пик +20% < активации +30% — трейлинг не работает
    expect(evaluateExit(pos(1.2), 0.9, 1000, rules)).toBeNull();
    // пик +60%, откат на 20% от пика (1.28) — выход
    expect(evaluateExit(pos(1.6), 1.28, 1000, rules)).toBe('trailing_stop');
    expect(evaluateExit(pos(1.6), 1.35, 1000, rules)).toBeNull();
  });
  it('trailing disabled when 0', () => {
    expect(evaluateExit(pos(1.6), 1.28, 1000, { ...rules, trailingStopPct: 0 })).toBeNull();
  });
  it('times out', () => {
    expect(evaluateExit(pos(), 1.0, 300_000, rules)).toBe('timeout');
    expect(evaluateExit(pos(), 1.0, 300_000, { ...rules, maxHoldSeconds: 0 })).toBeNull();
  });
});
