import type { Commitment } from '@solana/web3.js';
import { PUBLIC_WS_URL } from './constants.js';

export type FilterPreset = 'strict' | 'normal';

export interface Config {
  rpcUrl: string;
  /** WebSocket для подписок (создания токенов, сделки на наблюдении, цены позиций). */
  wsUrl: string;
  privateKey: string | undefined;
  dryRun: boolean;
  logLevel: string;
  /** Печатать каждый отсеянный токен (по умолчанию только сводка раз в минуту). */
  showRejected: boolean;
  journalPath: string;

  // Покупка
  buyAmountSol: number;
  buySlippagePct: number;
  sellSlippagePct: number;
  priorityFeeSol: number;
  simulateBeforeSend: boolean;
  /** Окно наблюдения после создания токена: бот копит статистику сделок, потом проверяет и покупает. */
  buyDelayMs: number;
  maxOpenPositions: number;
  maxTotalSpentSol: number;
  minSolReserve: number;
  maxConcurrentChecks: number;
  listenCommitment: Commitment;

  // Выход из позиции
  takeProfitPct: number;
  stopLossPct: number;
  trailingStopPct: number;
  trailingActivationPct: number;
  maxHoldSeconds: number;
  pricePollMs: number;
  sellOnExit: boolean;

  // Фильтры: базовые
  filterPreset: FilterPreset;
  skipMayhem: boolean;
  requireSocials: boolean;
  requireTwitter: boolean;
  requireImage: boolean;
  metadataTimeoutMs: number;
  ipfsGateways: string[];
  nameBlacklist: string[];
  nameWhitelist: string[];
  creatorBlacklist: string[];
  skipDuplicateNames: boolean;
  duplicateWindowMinutes: number;
  minMarketCapSol: number;
  maxMarketCapSol: number;
  maxDevHoldingPct: number;
  maxTop10HoldingPct: number;
  minDevSolBalance: number;
  /** Проверять mint через RPC (1 кредит на финалиста). Для токенов pump.fun избыточно. */
  checkMint: boolean;

  // Фильтры: активность торгов за окно наблюдения (работают при BUY_DELAY_MS > 0)
  minUniqueBuyers: number;
  minBuyVolumeSol: number;
  maxSellRatio: number;
  rejectDevSell: boolean;
  maxSingleBuyerPct: number;
  /** Макс. покупателей в одном слоте с созданием (бандл/инсайдеры). -1 — не проверять. */
  maxBundledBuyers: number;
  minPriceChangePct: number;
  maxPriceChangePct: number;

  // Бумажная торговля (DRY_RUN=true)
  paperBalanceSol: number;
  paperStatePath: string;
  paperReset: boolean;
  simLatencyMs: number;
  simAccountRentSol: number;
  simFeePct: number;
}

type Env = Record<string, string | undefined>;

/** Значения по умолчанию, зависящие от пресета. Любое можно переопределить своей переменной в .env. */
const PRESETS: Record<FilterPreset, Record<string, number | boolean>> = {
  normal: {
    BUY_DELAY_MS: 0,
    REQUIRE_TWITTER: false,
    REQUIRE_IMAGE: false,
    MIN_MARKET_CAP_SOL: 20,
    MAX_MARKET_CAP_SOL: 60,
    MAX_DEV_HOLDING_PCT: 10,
    MAX_TOP10_HOLDING_PCT: 0,
    MIN_DEV_SOL_BALANCE: 0,
    MIN_UNIQUE_BUYERS: 0,
    MIN_BUY_VOLUME_SOL: 0,
    MAX_SELL_RATIO: 0,
    REJECT_DEV_SELL: false,
    MAX_SINGLE_BUYER_PCT: 0,
    MAX_BUNDLED_BUYERS: -1,
    MIN_PRICE_CHANGE_PCT: -100,
    MAX_PRICE_CHANGE_PCT: 0,
  },
  strict: {
    BUY_DELAY_MS: 6000,
    REQUIRE_TWITTER: true,
    REQUIRE_IMAGE: true,
    MIN_MARKET_CAP_SOL: 25,
    MAX_MARKET_CAP_SOL: 70,
    MAX_DEV_HOLDING_PCT: 5,
    MAX_TOP10_HOLDING_PCT: 30,
    MIN_DEV_SOL_BALANCE: 0.1,
    MIN_UNIQUE_BUYERS: 8,
    MIN_BUY_VOLUME_SOL: 2,
    MAX_SELL_RATIO: 0.5,
    REJECT_DEV_SELL: true,
    MAX_SINGLE_BUYER_PCT: 35,
    MAX_BUNDLED_BUYERS: 3,
    MIN_PRICE_CHANGE_PCT: 0,
    MAX_PRICE_CHANGE_PCT: 150,
  },
};

function str(env: Env, key: string, def?: string): string | undefined {
  const v = env[key]?.trim();
  return v === undefined || v === '' ? def : v;
}

function num(env: Env, key: string, def: number): number {
  const raw = str(env, key);
  if (raw === undefined) return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${key}: ожидается число, получено "${raw}"`);
  return n;
}

function bool(env: Env, key: string, def: boolean): boolean {
  const raw = str(env, key);
  if (raw === undefined) return def;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  throw new Error(`${key}: ожидается true/false, получено "${raw}"`);
}

function list(env: Env, key: string): string[] {
  return (str(env, key) ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(env: Env = process.env): Config {
  const listenCommitment = str(env, 'LISTEN_COMMITMENT', 'processed') as Commitment;
  if (!['processed', 'confirmed', 'finalized'].includes(listenCommitment)) {
    throw new Error('LISTEN_COMMITMENT: допустимо processed | confirmed | finalized');
  }
  const filterPreset = str(env, 'FILTER_PRESET', 'strict') as FilterPreset;
  if (!(filterPreset in PRESETS)) throw new Error('FILTER_PRESET: допустимо strict | normal');
  const preset = PRESETS[filterPreset];
  const pnum = (key: string) => num(env, key, preset[key] as number);
  const pbool = (key: string) => bool(env, key, preset[key] as boolean);

  // HELIUS_API_KEY — короткий способ подключиться к Helius без ручной сборки URL.
  const heliusKey = str(env, 'HELIUS_API_KEY');
  const rpcUrl = str(env, 'RPC_URL') ?? (heliusKey ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}` : 'https://api.mainnet-beta.solana.com');
  // Подписки по умолчанию идут через бесплатный публичный WebSocket: Helius берёт кредиты за объём потока.
  const wsUrl = str(env, 'STREAM_WS_URL') ?? str(env, 'WS_URL') ?? PUBLIC_WS_URL;

  const cfg: Config = {
    rpcUrl,
    wsUrl,
    privateKey: str(env, 'PRIVATE_KEY'),
    dryRun: bool(env, 'DRY_RUN', true),
    logLevel: str(env, 'LOG_LEVEL', 'info')!,
    showRejected: bool(env, 'SHOW_REJECTED', false),
    journalPath: str(env, 'JOURNAL_PATH', 'data/trades.jsonl')!,

    buyAmountSol: num(env, 'BUY_AMOUNT_SOL', 0.05),
    buySlippagePct: num(env, 'BUY_SLIPPAGE_PCT', 25),
    sellSlippagePct: num(env, 'SELL_SLIPPAGE_PCT', 30),
    priorityFeeSol: num(env, 'PRIORITY_FEE_SOL', 0.0005),
    simulateBeforeSend: bool(env, 'SIMULATE_BEFORE_SEND', true),
    buyDelayMs: pnum('BUY_DELAY_MS'),
    maxOpenPositions: num(env, 'MAX_OPEN_POSITIONS', 3),
    maxTotalSpentSol: num(env, 'MAX_TOTAL_SPENT_SOL', 0.5),
    minSolReserve: num(env, 'MIN_SOL_RESERVE', 0.02),
    maxConcurrentChecks: num(env, 'MAX_CONCURRENT_CHECKS', 10),
    listenCommitment,

    takeProfitPct: num(env, 'TAKE_PROFIT_PCT', 100),
    stopLossPct: num(env, 'STOP_LOSS_PCT', 30),
    trailingStopPct: num(env, 'TRAILING_STOP_PCT', 0),
    trailingActivationPct: num(env, 'TRAILING_ACTIVATION_PCT', 30),
    maxHoldSeconds: num(env, 'MAX_HOLD_SECONDS', 300),
    pricePollMs: num(env, 'PRICE_POLL_MS', 30_000),
    sellOnExit: bool(env, 'SELL_ON_EXIT', false),

    filterPreset,
    skipMayhem: bool(env, 'SKIP_MAYHEM', true),
    requireSocials: bool(env, 'REQUIRE_SOCIALS', true),
    requireTwitter: pbool('REQUIRE_TWITTER'),
    requireImage: pbool('REQUIRE_IMAGE'),
    metadataTimeoutMs: num(env, 'METADATA_TIMEOUT_MS', 2500),
    ipfsGateways: list(env, 'IPFS_GATEWAYS'),
    nameBlacklist: list(env, 'NAME_BLACKLIST').map((s) => s.toLowerCase()),
    nameWhitelist: list(env, 'NAME_WHITELIST').map((s) => s.toLowerCase()),
    creatorBlacklist: list(env, 'CREATOR_BLACKLIST'),
    skipDuplicateNames: bool(env, 'SKIP_DUPLICATE_NAMES', true),
    duplicateWindowMinutes: num(env, 'DUPLICATE_WINDOW_MINUTES', 60),
    minMarketCapSol: pnum('MIN_MARKET_CAP_SOL'),
    maxMarketCapSol: pnum('MAX_MARKET_CAP_SOL'),
    maxDevHoldingPct: pnum('MAX_DEV_HOLDING_PCT'),
    maxTop10HoldingPct: pnum('MAX_TOP10_HOLDING_PCT'),
    minDevSolBalance: pnum('MIN_DEV_SOL_BALANCE'),
    checkMint: bool(env, 'CHECK_MINT', false),

    minUniqueBuyers: pnum('MIN_UNIQUE_BUYERS'),
    minBuyVolumeSol: pnum('MIN_BUY_VOLUME_SOL'),
    maxSellRatio: pnum('MAX_SELL_RATIO'),
    rejectDevSell: pbool('REJECT_DEV_SELL'),
    maxSingleBuyerPct: pnum('MAX_SINGLE_BUYER_PCT'),
    maxBundledBuyers: pnum('MAX_BUNDLED_BUYERS'),
    minPriceChangePct: pnum('MIN_PRICE_CHANGE_PCT'),
    maxPriceChangePct: pnum('MAX_PRICE_CHANGE_PCT'),

    paperBalanceSol: num(env, 'PAPER_BALANCE_SOL', 5),
    paperStatePath: str(env, 'PAPER_STATE_PATH', 'data/paper-wallet.json')!,
    paperReset: bool(env, 'PAPER_RESET', false),
    simLatencyMs: num(env, 'SIM_LATENCY_MS', 800),
    simAccountRentSol: num(env, 'SIM_ACCOUNT_RENT_SOL', 0.0021),
    simFeePct: num(env, 'SIM_FEE_PCT', 1.75),
  };

  if (cfg.buyAmountSol <= 0) throw new Error('BUY_AMOUNT_SOL должен быть > 0');
  if (cfg.stopLossPct <= 0 || cfg.stopLossPct >= 100) throw new Error('STOP_LOSS_PCT должен быть в диапазоне (0, 100)');
  if (cfg.takeProfitPct <= 0) throw new Error('TAKE_PROFIT_PCT должен быть > 0');
  if (cfg.trailingStopPct < 0 || cfg.trailingStopPct >= 100) throw new Error('TRAILING_STOP_PCT должен быть в диапазоне [0, 100)');
  if (cfg.maxOpenPositions < 1) throw new Error('MAX_OPEN_POSITIONS должен быть >= 1');
  if (cfg.maxConcurrentChecks < 1) throw new Error('MAX_CONCURRENT_CHECKS должен быть >= 1');
  if (cfg.pricePollMs < 1000) throw new Error('PRICE_POLL_MS должен быть >= 1000');
  if (cfg.buyDelayMs < 0) throw new Error('BUY_DELAY_MS должен быть >= 0');
  if (cfg.paperBalanceSol <= 0) throw new Error('PAPER_BALANCE_SOL должен быть > 0');
  if (!cfg.dryRun && !cfg.privateKey) throw new Error('Для DRY_RUN=false нужен PRIVATE_KEY');

  return cfg;
}

/** Настройки, которые заметно жгут кредиты RPC-провайдера: предупреждаем при запуске. */
export function costWarnings(cfg: Config): string[] {
  const warnings: string[] = [];
  if (cfg.pricePollMs < 10_000) {
    const perDay = Math.round(86_400_000 / cfg.pricePollMs).toLocaleString('ru-RU');
    warnings.push(`PRICE_POLL_MS=${cfg.pricePollMs}: до ${perDay} запросов в сутки при открытых позициях — поставьте 30000 (цена и так приходит по подписке)`);
  }
  if (cfg.wsUrl.includes('helius')) {
    warnings.push('подписки идут через Helius WebSocket — это 2 кредита за 0.1 МБ; уберите STREAM_WS_URL/WS_URL, чтобы использовать бесплатный публичный');
  }
  return warnings;
}

/** RPC URL без API-ключа — для логов. */
export function redactUrl(url: string): string {
  return url.replace(/(api[-_]?key=)[^&]+/i, '$1***');
}
