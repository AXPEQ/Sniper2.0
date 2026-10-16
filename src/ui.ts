/** Оформление консоли: цвета, эмодзи, рамки. Цвета отключаются через NO_COLOR или при выводе не в терминал. */

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const wrap = (code: string) => (s: string | number): string => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const c = {
  bold: wrap('1'),
  dim: wrap('2'),
  gray: wrap('90'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  cyan: wrap('36'),
  magenta: wrap('35'),
};

export const sol = (n: number, digits = 4): string => `${n.toFixed(digits)} SOL`;

/** +0.0123 SOL зелёным или −0.0123 SOL красным. */
export function signedSol(n: number): string {
  const s = `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(4)} SOL`;
  return n >= 0 ? c.green(s) : c.red(s);
}

/** +12.3% зелёным или −12.3% красным. */
export function signedPct(p: number): string {
  const s = `${p >= 0 ? '+' : '−'}${Math.abs(p).toFixed(1)}%`;
  return p >= 0 ? c.green(s) : c.red(s);
}

export const pctChange = (from: number, to: number): number => (from > 0 ? (to / from - 1) * 100 : 0);

export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}с`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}м ${s % 60}с`;
  return `${Math.floor(m / 60)}ч ${m % 60}м`;
}

/** Тикер фиксированной ширины, чтобы колонки в логе выравнивались. */
export function ticker(symbol: string, width = 10): string {
  const clean = symbol.replace(/\s+/g, ' ').trim() || '???';
  const cut = [...clean].length > width ? [...clean].slice(0, width - 1).join('') + '…' : clean;
  return c.bold(cut.padEnd(width));
}

export const pumpLink = (mint: string): string => c.dim(`https://pump.fun/coin/${mint}`);

/** Блок в рамке без правой границы (эмодзи ломают подсчёт ширины). */
export function box(title: string, rows: string[]): string {
  const line = c.gray('─'.repeat(Math.max(4, 44 - [...title].length)));
  return [`${c.gray('╭─')} ${c.bold(title)} ${line}`, ...rows.map((r) => `${c.gray('│')} ${r}`), c.gray('╰' + '─'.repeat(48))].join('\n');
}

/** Строка «метка  значение» с выравниванием метки. */
export const row = (label: string, value: string, width = 10): string => `${c.gray(label.padEnd(width))} ${value}`;

export function print(text: string): void {
  console.log(text);
}
