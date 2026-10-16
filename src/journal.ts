import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { log } from './logger.js';
import { errorMessage } from './utils.js';

/** Журнал сделок в формате JSON Lines — удобно анализировать результаты симуляции. */
export class Journal {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  write(entry: Record<string, unknown>): void {
    const line = JSON.stringify({ time: new Date().toISOString(), ...entry }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    try {
      appendFileSync(this.path, line + '\n');
    } catch (err) {
      log.warn(`Не удалось записать журнал: ${errorMessage(err)}`);
    }
  }
}
