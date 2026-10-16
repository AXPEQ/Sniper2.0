import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendToLogFile, currentLogFile, setLogDir } from '../src/logfile.js';

describe('log file', () => {
  afterEach(() => setLogDir(null));

  it('writes lines without colour codes into a dated file', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'logs-')), 'logs');
    setLogDir(dir);
    appendToLogFile('\x1b[32m🤑 ПРОФИТ\x1b[0m +0.01 SOL');
    appendToLogFile('second');
    const file = currentLogFile()!;
    expect(file).toMatch(/bot-\d{4}-\d{2}-\d{2}\.log$/);
    expect(readFileSync(file, 'utf8')).toBe('🤑 ПРОФИТ +0.01 SOL\nsecond\n');
  });

  it('does nothing when disabled', () => {
    setLogDir(null);
    expect(currentLogFile()).toBeNull();
    expect(() => appendToLogFile('x')).not.toThrow();
  });
});
