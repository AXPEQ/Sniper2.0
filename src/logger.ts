import { appendToLogFile } from './logfile.js';
import { c } from './ui.js';

type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel: Level = 'info';

// Свои ссылки на консоль: console.error ниже подменяется, чтобы перехватывать сообщения web3.js.
const stdout = console.log.bind(console);
const stderr = console.error.bind(console);

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
  const line = stamp(format(level, msg + (extra === undefined ? '' : ' ' + (extra instanceof Error ? extra.message : JSON.stringify(extra)))));
  (level === 'error' || level === 'warn' ? stderr : stdout)(line);
  appendToLogFile(line);
}

const stamp = (text: string): string => `${c.gray(new Date().toTimeString().slice(0, 8))}  ${text}`;

export const log = {
  debug: (msg: string, extra?: unknown) => write('debug', msg, extra),
  info: (msg: string, extra?: unknown) => write('info', msg, extra),
  warn: (msg: string, extra?: unknown) => write('warn', msg, extra),
  error: (msg: string, extra?: unknown) => write('error', msg, extra),
  /** Только в файл лога, не в консоль (например, отсеянные токены). */
  file: (msg: string) => appendToLogFile(stamp(msg)),
};

/** Сколько раз обрывалось WebSocket-соединение (показывается в статусе). */
export const wsStats = { drops: 0 };

/**
 * web3.js печатает обрывы WebSocket как «ws error: ...» и сам переподключается с восстановлением подписок.
 * Заменяем сырое сообщение на понятное и не спамим им чаще раза в 30 секунд.
 */
export function installWsErrorHandler(): void {
  let lastShown = 0;
  console.error = (...args: unknown[]) => {
    if (args[0] === 'ws error:') {
      wsStats.drops++;
      if (Date.now() - lastShown > 30_000) {
        lastShown = Date.now();
        write('warn', 'связь с WebSocket оборвалась — переподключаюсь автоматически, подписки восстановятся');
      }
      return;
    }
    stderr(...args);
  };
}
