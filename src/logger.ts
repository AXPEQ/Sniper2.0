import { c } from './ui.js';

type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel: Level = 'info';

export function setLogLevel(level: string): void {
  if (level in ORDER) minLevel = level as Level;
}

function format(level: Level, msg: string): string {
  switch (level) {
    case 'debug':
      return c.gray(msg);
    case 'warn':
      return `⚠️  ${c.yellow(msg)}`;
    case 'error':
      return `❌ ${c.red(msg)}`;
    default:
      return msg;
  }
}

function write(level: Level, msg: string, extra?: unknown): void {
  if (ORDER[level] < ORDER[minLevel]) return;
  const ts = new Date().toTimeString().slice(0, 8);
  const tail = extra === undefined ? '' : ' ' + (extra instanceof Error ? extra.message : JSON.stringify(extra));
  const line = `${c.gray(ts)}  ${format(level, msg + tail)}`;
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
}

export const log = {
  debug: (msg: string, extra?: unknown) => write('debug', msg, extra),
  info: (msg: string, extra?: unknown) => write('info', msg, extra),
  warn: (msg: string, extra?: unknown) => write('warn', msg, extra),
  error: (msg: string, extra?: unknown) => write('error', msg, extra),
};
