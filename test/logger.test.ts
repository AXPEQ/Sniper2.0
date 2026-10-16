import { afterEach, describe, expect, it } from 'vitest';
import { installWsErrorHandler, wsStats } from '../src/logger.js';

describe('installWsErrorHandler', () => {
  const original = console.error;
  afterEach(() => {
    console.error = original;
  });

  it('counts web3.js websocket drops instead of printing the raw message', () => {
    installWsErrorHandler();
    const before = wsStats.drops;
    console.error('ws error:', 'Invalid WebSocket frame: invalid status code 1006');
    console.error('ws error:', 'again');
    expect(wsStats.drops).toBe(before + 2);
  });
});
