import { PublicKey, type Connection, type ParsedAccountData } from '@solana/web3.js';
import type { Config } from '../config.js';
import { deriveBondingCurve, marketCapSol, type BondingCurveState } from '../pump/bondingCurve.js';
import type { CreateEvent } from '../pump/events.js';
import { checkActivity, type ActivityStats } from '../activity.js';
import { lamportsToSol, withRetry } from '../utils.js';
import { fetchMetadata, hasSocials, isTwitterUrl, type TokenMetadata } from './metadata.js';

export interface DeepCheckContext {
  activity: ActivityStats | null;
  metadata: Promise<TokenMetadata | Error | null>;
  creationSignature: string;
  creationSlot: number;
}

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
    if (banned) return `стоп-слово: ${banned}`;
    if (this.cfg.nameWhitelist.length > 0 && !this.cfg.nameWhitelist.some((w) => text.includes(w))) {
      return 'нет слов из NAME_WHITELIST';
    }
    if (this.cfg.skipDuplicateNames && isDuplicate) return 'копия чужого имени';
    return null;
  }

  /** Нужно ли грузить метаданные при текущих настройках. */
  get needsMetadata(): boolean {
    return this.cfg.requireSocials || this.cfg.requireTwitter || this.cfg.requireImage;
  }

  /** Загрузка метаданных; можно начать сразу при обнаружении токена, пока идёт окно наблюдения. */
  fetchMetadata(ev: CreateEvent): Promise<TokenMetadata | Error | null> {
    if (!this.needsMetadata) return Promise.resolve(null);
    return fetchMetadata(ev.uri, this.cfg.metadataTimeoutMs, this.cfg.ipfsGateways).catch((err: Error) => err);
  }

  /**
   * Глубокая проверка. Сначала всё, что можно посчитать бесплатно (метаданные и поток сделок),
   * и только финалисты идут в RPC (~3 запроса). Любая ошибка = отказ (fail-closed).
   */
  async deepCheck(ev: CreateEvent, ctx: DeepCheckContext): Promise<DeepCheckResult> {
    // 1. Бесплатно: метаданные (HTTP к IPFS) и данные потока сделок.
    const meta = await ctx.metadata;
    if (meta instanceof Error) return { reason: `метаданные недоступны: ${meta.message}` };
    if (meta) {
      const metaReason = checkMetadata(meta, this.cfg);
      if (metaReason) return { reason: metaReason };
    }
    if (!ev.bondingCurve.equals(deriveBondingCurve(ev.mint))) return { reason: 'неверный адрес bonding curve' };

    const a = ctx.activity;
    const curve = curveFromStream(ev, a);
    const mcap = marketCapSol(curve);
    if (mcap < this.cfg.minMarketCapSol) return { reason: `mcap ниже минимума: ${mcap.toFixed(1)} SOL` };
    if (this.cfg.maxMarketCapSol > 0 && mcap > this.cfg.maxMarketCapSol) {
      return { reason: `mcap выше максимума: ${mcap.toFixed(1)} SOL` };
    }
    if (a && this.cfg.buyDelayMs > 0) {
      const currentPrice = Number(curve.virtualSolReserves) / Number(curve.virtualTokenReserves);
      const activityReason = checkActivity(a, currentPrice, this.cfg);
      if (activityReason) return { reason: activityReason };
    }
    const supply = curve.tokenTotalSupply;
    if (a && supply > 0n) {
      const devPct = pct(a.devTokens, supply);
      if (this.cfg.maxDevHoldingPct > 0 && devPct > this.cfg.maxDevHoldingPct) {
        return { reason: `dev держит много: ${devPct.toFixed(1)}%` };
      }
      const topPct = pct(a.top10Tokens, supply);
      if (this.cfg.maxTop10HoldingPct > 0 && topPct > this.cfg.maxTop10HoldingPct) {
        return { reason: `топ-10 держат много: ${topPct.toFixed(1)}%` };
      }
    }

    // 2. RPC — только для прошедших всё остальное (по 1 кредиту за запрос).
    const checkBundle = this.cfg.maxBundledBuyers >= 0 && this.cfg.buyDelayMs > 0;
    const [mintInfo, devLamports, signatures] = await Promise.all([
      this.cfg.checkMint ? withRetry(() => this.connection.getParsedAccountInfo(ev.mint)) : Promise.resolve(null),
      this.cfg.minDevSolBalance > 0 ? withRetry(() => this.connection.getBalance(ev.user)) : Promise.resolve(null),
      checkBundle
        ? withRetry(() => this.connection.getSignaturesForAddress(ev.bondingCurve, { limit: 1000 }, 'confirmed'))
        : Promise.resolve(null),
    ]);

    const mintReason = mintInfo ? checkMint(mintInfo.value) : null;
    if (mintReason) return { reason: mintReason };
    if (devLamports !== null && lamportsToSol(devLamports) < this.cfg.minDevSolBalance) {
      return { reason: `пустой кошелёк dev: ${lamportsToSol(devLamports).toFixed(3)} SOL` };
    }
    if (signatures) {
      // Транзакции в том же слоте, что и создание (кроме неё самой), — бандл или инсайдеры.
      const bundled = signatures.filter((s) => s.slot === ctx.creationSlot && s.signature !== ctx.creationSignature && !s.err).length;
      if (bundled > this.cfg.maxBundledBuyers) return { reason: `бандл: ${bundled} покупок в блоке создания` };
    }

    return { curve };
  }

  private checkAndRememberName(ev: CreateEvent): boolean {
    const now = Date.now();
    const windowMs = this.cfg.duplicateWindowMinutes * 60_000;
    // Только по имени: одинаковые тикеры (CAT, AI…) у разных монет — обычное дело, копии же повторяют имя.
    const key = ev.name.trim().toLowerCase().replace(/\s+/g, ' ');
    const seen = this.recentNames.get(key);
    const duplicate = seen !== undefined && now - seen < windowMs;
    this.recentNames.set(key, now);
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

const INITIAL_VSOL = 30_000_000_000n;
const INITIAL_VTOK = 1_073_000_000_000_000n;
const DEFAULT_SUPPLY = 1_000_000_000_000_000n;

/** Состояние кривой по данным потока: резервы после последней сделки или исходные из события создания. */
export function curveFromStream(ev: CreateEvent, a: ActivityStats | null): BondingCurveState {
  const initialVSol = ev.virtualSolReserves ?? INITIAL_VSOL;
  const initialVTok = ev.virtualTokenReserves ?? INITIAL_VTOK;
  const vSol = a?.virtualSolReserves ?? initialVSol;
  const vTok = a?.virtualTokenReserves ?? initialVTok;
  const realTokStart = ev.realTokenReserves ?? initialVTok - 280_000_000_000_000n;
  return {
    virtualSolReserves: vSol,
    virtualTokenReserves: vTok,
    realSolReserves: vSol > initialVSol ? vSol - initialVSol : 0n,
    realTokenReserves: realTokStart - (initialVTok - vTok),
    tokenTotalSupply: ev.tokenTotalSupply ?? DEFAULT_SUPPLY,
    complete: false,
  };
}

export function checkMetadata(
  meta: TokenMetadata,
  rules: Pick<Config, 'requireSocials' | 'requireTwitter' | 'requireImage'>,
): string | null {
  if (rules.requireSocials && !hasSocials(meta)) return 'нет соцсетей в метаданных';
  if (rules.requireTwitter && !(meta.twitter && isTwitterUrl(meta.twitter))) return 'нет ссылки на X/Twitter';
  if (rules.requireImage && !meta.image) return 'нет картинки в метаданных';
  return null;
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
