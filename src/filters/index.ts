import { PublicKey, type Connection, type ParsedAccountData } from '@solana/web3.js';
import type { Config } from '../config.js';
import { TOKEN_PROGRAM_ID } from '../constants.js';
import {
  decodeBondingCurve,
  deriveAssociatedTokenAddress,
  marketCapSol,
  type BondingCurveState,
} from '../pump/bondingCurve.js';
import type { CreateEvent } from '../pump/events.js';
import { withRetry } from '../utils.js';
import { fetchMetadata, hasSocials } from './metadata.js';

export interface DeepCheckResult {
  reason?: string;
  curve?: BondingCurveState;
}

/** Расширения Token-2022, при которых токен может быть заморожен/изъят/обложен налогом. */
const DANGEROUS_EXTENSIONS = new Set([
  'permanentDelegate',
  'transferHook',
  'transferFeeConfig',
  'nonTransferable',
  'pausableConfig',
]);

export class TokenFilter {
  private readonly recentNames = new Map<string, number>();

  constructor(
    private readonly connection: Connection,
    private readonly cfg: Config,
  ) {}

  /** Быстрые проверки только по данным события, без сети. Возвращает причину отказа или null. */
  quickCheck(ev: CreateEvent): string | null {
    const isDuplicate = this.checkAndRememberName(ev);
    const text = `${ev.name} ${ev.symbol}`.toLowerCase();

    if (this.cfg.skipMayhem && ev.isMayhemMode) return 'mayhem mode';
    if (this.cfg.creatorBlacklist.includes(ev.user.toBase58()) || (ev.creator && this.cfg.creatorBlacklist.includes(ev.creator.toBase58()))) {
      return 'создатель в чёрном списке';
    }
    const banned = this.cfg.nameBlacklist.find((w) => text.includes(w));
    if (banned) return `стоп-слово "${banned}"`;
    if (this.cfg.nameWhitelist.length > 0 && !this.cfg.nameWhitelist.some((w) => text.includes(w))) {
      return 'нет ключевых слов из NAME_WHITELIST';
    }
    if (this.cfg.skipDuplicateNames && isDuplicate) return 'дубликат имени/тикера (копикэт)';
    return null;
  }

  /** Проверки с запросами к RPC и метаданным. Любая ошибка = отказ (fail-closed). */
  async deepCheck(ev: CreateEvent): Promise<DeepCheckResult> {
    const [meta, mintInfo, curve, devTokens] = await Promise.all([
      this.cfg.requireSocials
        ? fetchMetadata(ev.uri, this.cfg.metadataTimeoutMs, this.cfg.ipfsGateways).catch((err: Error) => err)
        : Promise.resolve(null),
      withRetry(() => this.connection.getParsedAccountInfo(ev.mint)),
      withRetry(async () => {
        const acc = await this.connection.getAccountInfo(ev.bondingCurve);
        if (!acc) throw new Error('bonding curve ещё не виден');
        return decodeBondingCurve(acc.data);
      }),
      this.devHoldings(ev),
    ]);

    if (meta instanceof Error) return { reason: `метаданные недоступны: ${meta.message}` };
    if (meta && !hasSocials(meta)) return { reason: 'нет соцсетей в метаданных' };

    const mintReason = checkMint(mintInfo.value);
    if (mintReason) return { reason: mintReason };

    if (curve.complete) return { reason: 'кривая уже заполнена (миграция)' };
    const mcap = marketCapSol(curve);
    if (mcap < this.cfg.minMarketCapSol) return { reason: `mcap ${mcap.toFixed(1)} SOL < MIN_MARKET_CAP_SOL` };
    if (this.cfg.maxMarketCapSol > 0 && mcap > this.cfg.maxMarketCapSol) {
      return { reason: `mcap ${mcap.toFixed(1)} SOL > MAX_MARKET_CAP_SOL` };
    }

    const supply = curve.tokenTotalSupply;
    if (this.cfg.maxDevHoldingPct > 0 && supply > 0n) {
      const devPct = pct(devTokens, supply);
      if (devPct > this.cfg.maxDevHoldingPct) return { reason: `dev держит ${devPct.toFixed(1)}%` };
    }

    if (this.cfg.maxTop10HoldingPct > 0 && supply > 0n) {
      const tokenProgram = ev.tokenProgram ?? mintInfo.value?.owner ?? TOKEN_PROGRAM_ID;
      const curveAta = deriveAssociatedTokenAddress(ev.bondingCurve, ev.mint, tokenProgram);
      const largest = await withRetry(() => this.connection.getTokenLargestAccounts(ev.mint));
      const top10 = largest.value
        .filter((a) => !a.address.equals(curveAta))
        .slice(0, 10)
        .reduce((sum, a) => sum + BigInt(a.amount), 0n);
      const topPct = pct(top10, supply);
      if (topPct > this.cfg.maxTop10HoldingPct) return { reason: `топ-10 держат ${topPct.toFixed(1)}%` };
    }

    return { curve };
  }

  private async devHoldings(ev: CreateEvent): Promise<bigint> {
    if (this.cfg.maxDevHoldingPct <= 0) return 0n;
    const owners = [ev.user];
    if (ev.creator && !ev.creator.equals(ev.user)) owners.push(ev.creator);
    const balances = await Promise.all(owners.map((o) => tokenBalance(this.connection, o, ev.mint)));
    return balances.reduce((a, b) => a + b, 0n);
  }

  private checkAndRememberName(ev: CreateEvent): boolean {
    const now = Date.now();
    const windowMs = this.cfg.duplicateWindowMinutes * 60_000;
    const keys = [`n:${ev.name.trim().toLowerCase()}`, `s:${ev.symbol.trim().toLowerCase()}`];
    const duplicate = keys.some((k) => {
      const seen = this.recentNames.get(k);
      return seen !== undefined && now - seen < windowMs;
    });
    for (const k of keys) this.recentNames.set(k, now);
    if (this.recentNames.size > 20_000) {
      for (const [k, t] of this.recentNames) if (now - t >= windowMs) this.recentNames.delete(k);
    }
    return duplicate;
  }
}

/** Сумма токенов mint на всех токен-аккаунтах владельца (работает и для SPL Token, и для Token-2022). */
export async function tokenBalance(connection: Connection, owner: PublicKey, mint: PublicKey): Promise<bigint> {
  const res = await withRetry(() => connection.getParsedTokenAccountsByOwner(owner, { mint }));
  return res.value.reduce((sum, acc) => sum + BigInt(acc.account.data.parsed.info.tokenAmount.amount as string), 0n);
}

type ParsedMintAccount = Awaited<ReturnType<Connection['getParsedAccountInfo']>>['value'];

export function checkMint(account: ParsedMintAccount): string | null {
  if (!account) return 'mint не найден';
  const data = account.data as ParsedAccountData | Buffer;
  if (Buffer.isBuffer(data) || data.parsed?.type !== 'mint') return 'аккаунт не является mint';
  const info = data.parsed.info as {
    mintAuthority: string | null;
    freezeAuthority: string | null;
    extensions?: { extension: string; state?: { accountState?: string } }[];
  };
  if (info.mintAuthority) return 'mint authority не отозван';
  if (info.freezeAuthority) return 'freeze authority не отозван';
  for (const ext of info.extensions ?? []) {
    if (DANGEROUS_EXTENSIONS.has(ext.extension)) return `опасное расширение Token-2022: ${ext.extension}`;
    if (ext.extension === 'defaultAccountState' && ext.state?.accountState === 'frozen') {
      return 'новые аккаунты по умолчанию заморожены';
    }
  }
  return null;
}

function pct(part: bigint, total: bigint): number {
  return Number((part * 1_000_000n) / total) / 10_000;
}
