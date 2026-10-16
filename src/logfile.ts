import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** Запись консольного вывода в файл data/logs/bot-ГГГГ-ММ-ДД.log (новый файл каждый день, без цветовых кодов). */
let logDir: string | null = null;
const ANSI = /\x1b\[[0-9;]*m/g;

export function setLogDir(dir: string | null): void {
  if (dir) mkdirSync(dir, { recursive: true });
  logDir = dir;
}

export function currentLogFile(): string | null {
  if (!logDir) return null;
  const day = new Date().toLocaleDateString('sv-SE'); // ГГГГ-ММ-ДД по местному времени
  return join(logDir, `bot-${day}.log`);
}

export function appendToLogFile(text: string): void {
  const file = currentLogFile();
  if (!file) return;
  try {
    appendFileSync(file, text.replace(ANSI, '') + '\n');
  } catch {
    // нет места/прав — не роняем бота из-за логов
  }
}
