import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';

/** Событие CreateEvent программы pump.fun (Anchor `emit!`, лог "Program data: <base64>"). */
export interface CreateEvent {
  name: string;
  symbol: string;
  uri: string;
  mint: PublicKey;
  bondingCurve: PublicKey;
  /** Подписант транзакции создания (обычно делает и первую dev-покупку). */
  user: PublicKey;
  /** Создатель, которому идут creator fees (может отличаться от user). */
  creator?: PublicKey;
  timestamp?: number;
  virtualTokenReserves?: bigint;
  virtualSolReserves?: bigint;
  realTokenReserves?: bigint;
  tokenTotalSupply?: bigint;
  tokenProgram?: PublicKey;
  isMayhemMode?: boolean;
}

const anchorEventDiscriminator = (name: string): Buffer =>
  createHash('sha256').update(`event:${name}`).digest().subarray(0, 8);

export const CREATE_EVENT_DISCRIMINATOR = anchorEventDiscriminator('CreateEvent');

const PROGRAM_DATA_PREFIX = 'Program data: ';

class Reader {
  private offset = 0;
  constructor(private readonly buf: Buffer) {}

  get remaining(): number {
    return this.buf.length - this.offset;
  }

  private take(n: number): Buffer {
    if (this.remaining < n) throw new RangeError('unexpected end of event data');
    const out = this.buf.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  string(): string {
    const len = this.take(4).readUInt32LE(0);
    return this.take(len).toString('utf8');
  }
  pubkey(): PublicKey {
    return new PublicKey(this.take(32));
  }
  u64(): bigint {
    return this.take(8).readBigUInt64LE(0);
  }
  i64(): bigint {
    return this.take(8).readBigInt64LE(0);
  }
  bool(): boolean {
    return this.take(1)[0] === 1;
  }
}

/**
 * Разбирает CreateEvent. Обязательны поля до `user`; остальные pump.fun добавлял
 * со временем, поэтому читаем их только если байты есть (совместимость со старыми/новыми версиями).
 */
export function decodeCreateEvent(data: Buffer): CreateEvent | null {
  if (data.length < 8 || !data.subarray(0, 8).equals(CREATE_EVENT_DISCRIMINATOR)) return null;
  const r = new Reader(data.subarray(8));
  try {
    const ev: CreateEvent = {
      name: r.string(),
      symbol: r.string(),
      uri: r.string(),
      mint: r.pubkey(),
      bondingCurve: r.pubkey(),
      user: r.pubkey(),
    };
    if (r.remaining >= 32) ev.creator = r.pubkey();
    if (r.remaining >= 8) ev.timestamp = Number(r.i64());
    if (r.remaining >= 32) {
      ev.virtualTokenReserves = r.u64();
      ev.virtualSolReserves = r.u64();
      ev.realTokenReserves = r.u64();
      ev.tokenTotalSupply = r.u64();
    }
    if (r.remaining >= 32) ev.tokenProgram = r.pubkey();
    if (r.remaining >= 1) ev.isMayhemMode = r.bool();
    return ev;
  } catch {
    return null;
  }
}

/** Событие сделки на bonding curve (TradeEvent). Читаем только нужные боту поля. */
export interface TradeEvent {
  mint: PublicKey;
  solAmount: bigint;
  tokenAmount: bigint;
  isBuy: boolean;
  user: PublicKey;
  timestamp: number;
  /** Резервы кривой ПОСЛЕ сделки. */
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
}

export const TRADE_EVENT_DISCRIMINATOR = anchorEventDiscriminator('TradeEvent');

export function decodeTradeEvent(data: Buffer): TradeEvent | null {
  if (data.length < 8 || !data.subarray(0, 8).equals(TRADE_EVENT_DISCRIMINATOR)) return null;
  const r = new Reader(data.subarray(8));
  try {
    return {
      mint: r.pubkey(),
      solAmount: r.u64(),
      tokenAmount: r.u64(),
      isBuy: r.bool(),
      user: r.pubkey(),
      timestamp: Number(r.i64()),
      virtualSolReserves: r.u64(),
      virtualTokenReserves: r.u64(),
    };
  } catch {
    return null;
  }
}

export type ProgramEvent = { kind: 'create'; event: CreateEvent } | { kind: 'trade'; event: TradeEvent };

/**
 * Достаёт события pump.fun из логов транзакции в порядке появления.
 * isTradeWanted(mintBase58) позволяет не разбирать сделки по неинтересным токенам
 * (их десятки в секунду): mint читается прямо из байтов до полного разбора.
 * Сделки по токенам, созданным в этой же транзакции (dev-покупка), отдаются всегда.
 */
export function parseProgramEvents(logs: readonly string[], isTradeWanted: (mint: string) => boolean = () => true): ProgramEvent[] {
  const out: ProgramEvent[] = [];
  const createdHere = new Set<string>();
  for (const line of logs) {
    if (!line.startsWith(PROGRAM_DATA_PREFIX)) continue;
    const data = Buffer.from(line.slice(PROGRAM_DATA_PREFIX.length), 'base64');
    if (data.length < 8) continue;
    const disc = data.subarray(0, 8);
    if (disc.equals(CREATE_EVENT_DISCRIMINATOR)) {
      const event = decodeCreateEvent(data);
      if (event) {
        out.push({ kind: 'create', event });
        createdHere.add(event.mint.toBase58());
      }
    } else if (disc.equals(TRADE_EVENT_DISCRIMINATOR) && data.length >= 40) {
      const mint = new PublicKey(data.subarray(8, 40)).toBase58();
      if (!createdHere.has(mint) && !isTradeWanted(mint)) continue;
      const event = decodeTradeEvent(data);
      if (event) out.push({ kind: 'trade', event });
    }
  }
  return out;
}

/** Достаёт все CreateEvent из логов транзакции. */
export function extractCreateEvents(logs: readonly string[]): CreateEvent[] {
  return parseProgramEvents(logs, () => false).flatMap((e) => (e.kind === 'create' ? [e.event] : []));
}
