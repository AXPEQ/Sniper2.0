import type { Commitment } from '@solana/web3.js';

export interface Config {
  rpcUrl: string;
  wsUrl: string | undefined;
  privateKey: string | undefined;
  dryRun: boolean;
  logLevel: string;
  journalPath: string;

  // Покупка
  buyAmountSol: number;
  buySlippagePct: number;
  sellSlippagePct: number;
  priorityFeeSol: number;
  simulateBeforeSend: boolean;
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

  // Фильтры
  skipMayhem: boolean;
  requireSocials: boolean;
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

  // Симуляция
  simFeePct: number;
}

type Env = Record<string, string | undefined>;

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

  const cfg: Config = {
    rpcUrl: str(env, 'RPC_URL', 'https://api.mainnet-beta.solana.com')!,
    wsUrl: str(env, 'WS_URL'),
    privateKey: str(env, 'PRIVATE_KEY'),
    dryRun: bool(env, 'DRY_RUN', true),
    logLevel: str(env, 'LOG_LEVEL', 'info')!,
    journalPath: str(env, 'JOURNAL_PATH', 'data/trades.jsonl')!,

    buyAmountSol: num(env, 'BUY_AMOUNT_SOL', 0.05),
    buySlippagePct: num(env, 'BUY_SLIPPAGE_PCT', 25),
    sellSlippagePct: num(env, 'SELL_SLIPPAGE_PCT', 30),
    priorityFeeSol: num(env, 'PRIORITY_FEE_SOL', 0.0005),
    simulateBeforeSend: bool(env, 'SIMULATE_BEFORE_SEND', true),
    buyDelayMs: num(env, 'BUY_DELAY_MS', 0),
    maxOpenPositions: num(env, 'MAX_OPEN_POSITIONS', 3),
    maxTotalSpentSol: num(env, 'MAX_TOTAL_SPENT_SOL', 0.5),
    minSolReserve: num(env, 'MIN_SOL_RESERVE', 0.02),
    maxConcurrentChecks: num(env, 'MAX_CONCURRENT_CHECKS', 5),
    listenCommitment,

    takeProfitPct: num(env, 'TAKE_PROFIT_PCT', 100),
    stopLossPct: num(env, 'STOP_LOSS_PCT', 30),
    trailingStopPct: num(env, 'TRAILING_STOP_PCT', 0),
    trailingActivationPct: num(env, 'TRAILING_ACTIVATION_PCT', 30),
    maxHoldSeconds: num(env, 'MAX_HOLD_SECONDS', 300),
    pricePollMs: num(env, 'PRICE_POLL_MS', 2000),
    sellOnExit: bool(env, 'SELL_ON_EXIT', false),

    skipMayhem: bool(env, 'SKIP_MAYHEM', true),
    requireSocials: bool(env, 'REQUIRE_SOCIALS', true),
    metadataTimeoutMs: num(env, 'METADATA_TIMEOUT_MS', 2500),
    ipfsGateways: list(env, 'IPFS_GATEWAYS'),
    nameBlacklist: list(env, 'NAME_BLACKLIST').map((s) => s.toLowerCase()),
    nameWhitelist: list(env, 'NAME_WHITELIST').map((s) => s.toLowerCase()),
    creatorBlacklist: list(env, 'CREATOR_BLACKLIST'),
    skipDuplicateNames: bool(env, 'SKIP_DUPLICATE_NAMES', true),
    duplicateWindowMinutes: num(env, 'DUPLICATE_WINDOW_MINUTES', 60),
    minMarketCapSol: num(env, 'MIN_MARKET_CAP_SOL', 20),
    maxMarketCapSol: num(env, 'MAX_MARKET_CAP_SOL', 60),
    maxDevHoldingPct: num(env, 'MAX_DEV_HOLDING_PCT', 10),
    maxTop10HoldingPct: num(env, 'MAX_TOP10_HOLDING_PCT', 0),

    simFeePct: num(env, 'SIM_FEE_PCT', 1.75),
  };

  if (cfg.buyAmountSol <= 0) throw new Error('BUY_AMOUNT_SOL должен быть > 0');
  if (cfg.stopLossPct <= 0 || cfg.stopLossPct >= 100) throw new Error('STOP_LOSS_PCT должен быть в диапазоне (0, 100)');
  if (cfg.takeProfitPct <= 0) throw new Error('TAKE_PROFIT_PCT должен быть > 0');
  if (cfg.trailingStopPct < 0 || cfg.trailingStopPct >= 100) throw new Error('TRAILING_STOP_PCT должен быть в диапазоне [0, 100)');
  if (cfg.maxOpenPositions < 1) throw new Error('MAX_OPEN_POSITIONS должен быть >= 1');
  if (cfg.maxConcurrentChecks < 1) throw new Error('MAX_CONCURRENT_CHECKS должен быть >= 1');
  if (cfg.pricePollMs < 250) throw new Error('PRICE_POLL_MS должен быть >= 250');
  if (!cfg.dryRun && !cfg.privateKey) throw new Error('Для DRY_RUN=false нужен PRIVATE_KEY');

  return cfg;
}
