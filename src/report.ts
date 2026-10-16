import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';

/** Отчёт по журналу сделок: `npm run report [путь к trades.jsonl]`. */
interface SellEntry {
  type: 'sell';
  mode: string;
  symbol: string;
  reason: string;
  costSol: number;
  solReceived: number;
  pnlSol: number;
  holdSeconds: number;
}

const path = process.argv[2] ?? process.env.JOURNAL_PATH ?? 'data/trades.jsonl';
if (!existsSync(path)) {
  console.log(`Журнал ${path} не найден — сначала запустите бота (npm start).`);
  process.exit(0);
}

const entries = readFileSync(path, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as { type: string; mode?: string });
const buys = entries.filter((e) => e.type === 'buy');
const sells = entries.filter((e): e is SellEntry => e.type === 'sell');

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const fmt = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(4)}`;

console.log(`Журнал: ${path}`);
console.log(`Покупок: ${buys.length}, закрытых сделок: ${sells.length}, открыто: ${buys.length - sells.length}`);
if (sells.length === 0) process.exit(0);

const pnl = sum(sells.map((s) => s.pnlSol));
const invested = sum(sells.map((s) => s.costSol));
const wins = sells.filter((s) => s.pnlSol > 0);
console.log(`Итоговый PnL: ${fmt(pnl)} SOL (${((pnl / invested) * 100).toFixed(1)}% от вложенного ${invested.toFixed(4)} SOL)`);
console.log(`В плюс: ${wins.length}/${sells.length} (${((wins.length / sells.length) * 100).toFixed(0)}%)`);
console.log(`Средняя сделка: ${fmt(pnl / sells.length)} SOL, среднее удержание ${Math.round(sum(sells.map((s) => s.holdSeconds)) / sells.length)}с`);

console.log('\nПо причинам выхода:');
const byReason = new Map<string, SellEntry[]>();
for (const s of sells) byReason.set(s.reason, [...(byReason.get(s.reason) ?? []), s]);
for (const [reason, list] of [...byReason].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${reason.padEnd(14)} ${String(list.length).padStart(4)} сделок, PnL ${fmt(sum(list.map((s) => s.pnlSol)))} SOL`);
}

const sorted = [...sells].sort((a, b) => b.pnlSol - a.pnlSol);
console.log('\nЛучшие:', sorted.slice(0, 3).map((s) => `${s.symbol} ${fmt(s.pnlSol)}`).join(', '));
console.log('Худшие:', sorted.slice(-3).reverse().map((s) => `${s.symbol} ${fmt(s.pnlSol)}`).join(', '));
