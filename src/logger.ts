type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const COLOR: Record<Level, string> = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };
const RESET = '\x1b[0m';

let minLevel: Level = 'info';

export function setLogLevel(level: string): void {
  if (level in ORDER) minLevel = level as Level;
}

function write(level: Level, msg: string, extra?: unknown): void {
  if (ORDER[level] < ORDER[minLevel]) return;
  const ts = new Date().toISOString().slice(11, 23);
  const tail = extra === undefined ? '' : ' ' + (extra instanceof Error ? extra.message : JSON.stringify(extra));
  const line = `${COLOR[level]}${ts} ${level.toUpperCase().padEnd(5)}${RESET} ${msg}${tail}`;
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
}

export const log = {
  debug: (msg: string, extra?: unknown) => write('debug', msg, extra),
  info: (msg: string, extra?: unknown) => write('info', msg, extra),
  warn: (msg: string, extra?: unknown) => write('warn', msg, extra),
  error: (msg: string, extra?: unknown) => write('error', msg, extra),
};
