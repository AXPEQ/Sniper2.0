import type { Config } from './config.js';
import { wsStats } from './logger.js';
import { redactUrl } from './config.js';
import type { PositionManager } from './positions.js';
import type { Sniper } from './sniper.js';
import type { PaperWallet } from './trader/paper.js';
import { box, c, duration, pctChange, row, signedPct, signedSol, sol, ticker } from './ui.js';

export interface DashboardContext {
  cfg: Config;
  sniper: Sniper;
  positions: PositionManager;
  paperWallet: PaperWallet | null;
  rpcStats: { calls: number; byMethod: Map<string, number> };
  startedAt: number;
}

function streamLabel(url: string): string {
  if (url.includes('api.mainnet-beta.solana.com')) return `публичный WebSocket Solana ${c.green('(бесплатно)')}`;
  if (url.includes('helius')) return `Helius WebSocket ${c.yellow('(тратит кредиты: 2 за 0.1 МБ)')}`;
  try {
    return new URL(url).host;
  } catch {
    return redactUrl(url);
  }
}

/** Расход RPC-запросов: всего и в пересчёте на час/сутки. */
function rpcLine(ctx: DashboardContext): string {
  const hours = Math.max((Date.now() - ctx.startedAt) / 3_600_000, 1 / 60);
  const perHour = ctx.rpcStats.calls / hours;
  const who = ctx.cfg.rpcUrl.includes('helius') ? 'Helius' : 'RPC';
  const top = [...ctx.rpcStats.byMethod.entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, 3)
    .map(([m, n]) => `${m} ${n}`)
    .join(', ');
  return c.gray(
    `📡 ${who}: ${ctx.rpcStats.calls} запросов (≈ кредитов) · ≈ ${Math.round(perHour)}/час · ≈ ${Math.round(perHour * 24).toLocaleString('ru-RU')}/сутки` +
      (top ? ` · ${top}` : '') +
      (wsStats.drops > 0 ? ` · обрывов WebSocket ${wsStats.drops} (переподключался сам)` : ''),
  );
}

function rpcLabel(url: string): string {
  if (url.includes('helius')) return `Helius ${c.green('✓')}`;
  if (url.includes('api.mainnet-beta.solana.com')) return `${c.yellow('публичный RPC')} ${c.gray('(медленный, режет запросы)')}`;
  try {
    return new URL(url).host;
  } catch {
    return redactUrl(url);
  }
}

/** Рамка с настройками при запуске. */
export function renderBanner(cfg: Config, mode: { paper?: PaperWallet; address?: string; balanceSol?: number }): string {
  const modeLine = mode.paper
    ? `📝 ${c.cyan('бумажная торговля')} ${c.gray('·')} виртуальный кошелёк ${c.bold(sol(mode.paper.balance))}`
    : `🔥 ${c.red(c.bold('БОЕВОЙ РЕЖИМ'))} ${c.gray('·')} ${mode.address} ${c.gray('·')} ${c.bold(sol(mode.balanceSol ?? 0))}`;

  const exit = [
    `🎯 ${c.green(`+${cfg.takeProfitPct}%`)}`,
    `🛑 ${c.red(`−${cfg.stopLossPct}%`)}`,
    ...(cfg.trailingStopPct > 0 ? [`📉 трейлинг ${cfg.trailingStopPct}% после +${cfg.trailingActivationPct}%`] : []),
    ...(cfg.maxHoldSeconds > 0 ? [`⏰ ${duration(cfg.maxHoldSeconds)}`] : []),
  ].join(c.gray(' · '));

  const dot = c.gray(' · ');
  const filters: string[] = [`🛡  ${c.bold(cfg.filterPreset.toUpperCase())}${cfg.buyDelayMs > 0 ? `${dot}наблюдаю ${cfg.buyDelayMs / 1000}с перед входом` : `${dot}вход сразу`}`];
  if (cfg.buyDelayMs > 0) {
    filters.push(
      [
        `👥 ≥ ${cfg.minUniqueBuyers} покупателей`,
        `объём ≥ ${cfg.minBuyVolumeSol} SOL`,
        ...(cfg.maxSellRatio > 0 ? [`продажи ≤ ${cfg.maxSellRatio * 100}%`] : []),
        ...(cfg.maxSingleBuyerPct > 0 ? [`один кошелёк ≤ ${cfg.maxSingleBuyerPct}%`] : []),
        ...(cfg.maxBundledBuyers >= 0 ? [`бандл ≤ ${cfg.maxBundledBuyers}`] : []),
        ...(cfg.maxDevSoldPct < 100 ? [`dev продал ≤ ${cfg.maxDevSoldPct}%`] : []),
      ].join(dot),
    );
  }
  filters.push(
    [
      `mcap ${cfg.minMarketCapSol}–${cfg.maxMarketCapSol} SOL`,
      `dev ≤ ${cfg.maxDevHoldingPct}%`,
      ...(cfg.maxTop10HoldingPct > 0 ? [`топ-10 ≤ ${cfg.maxTop10HoldingPct}%`] : []),
      ...(cfg.requireTwitter ? ['есть X/Twitter'] : cfg.requireSocials ? ['есть соцсети'] : []),
      ...(cfg.requireImage ? ['есть картинка'] : []),
    ].join(dot),
  );

  return box('🎯 SNIPER 2.0', [
    row('Режим', modeLine),
    row('RPC', rpcLabel(cfg.rpcUrl)),
    row('Подписки', streamLabel(cfg.wsUrl)),
    row(
      'Вход',
      `${sol(cfg.buyAmountSol, 2)} на сделку${dot}до ${cfg.maxOpenPositions} позиций` +
        (mode.paper ? '' : `${dot}бюджет ${cfg.maxTotalSpentSol > 0 ? sol(cfg.maxTotalSpentSol, 2) : 'без лимита'}`),
    ),
    row('Выход', exit),
    ...filters.map((f, i) => row(i === 0 ? 'Фильтры' : '', f)),
  ]);
}

function tradesLine(ctx: DashboardContext): string {
  const { positions } = ctx;
  const closed = positions.closedCount;
  const winRate = closed > 0 ? ` (${Math.round((positions.winCount / closed) * 100)}%)` : '';
  return `💵 сделок ${c.bold(closed)}${c.gray(' · ')}в плюс ${c.bold(positions.winCount)}${winRate}${c.gray(' · ')}PnL сессии ${signedSol(positions.realizedPnlSol)}`;
}

/** Капитал = свободные SOL + текущая оценка открытых позиций. */
function walletLine(w: PaperWallet, positions: PositionManager): string {
  const s = w.stats;
  const inPositions = positions.snapshot().reduce((sum, p) => sum + p.valueSol, 0);
  const equity = s.balanceSol + inPositions;
  const parts = inPositions > 0 ? c.gray(` (свободно ${sol(s.balanceSol)} + в позициях ${sol(inPositions)})`) : '';
  return (
    `💼 капитал ${c.bold(sol(equity))} ${signedSol(equity - s.startBalanceSol)} ${c.gray('·')} ${signedPct(pctChange(s.startBalanceSol, equity))} ` +
    `${c.gray(`с начала (старт ${s.startBalanceSol} SOL)`)}${parts}`
  );
}

/** Сводка раз в минуту. */
export function renderStatus(ctx: DashboardContext): string {
  const { sniper, positions, paperWallet, cfg } = ctx;
  const s = sniper.stats;
  const dot = c.gray(' · ');
  const rows = [
    `👀 новых токенов ${c.bold(s.seen)}${dot}🚫 отсеяно ${c.bold(s.quickRejected + s.deepRejected)}${dot}🛒 куплено ${c.bold(s.bought)}` +
      (s.buyFailed > 0 ? `${dot}${c.yellow(`не прошло покупок ${s.buyFailed}`)}` : ''),
    tradesLine(ctx),
  ];
  if (paperWallet) rows.push(walletLine(paperWallet, positions));

  const open = positions.snapshot();
  if (open.length === 0) {
    rows.push(c.gray(`📂 открытых позиций нет (лимит ${cfg.maxOpenPositions})`));
  } else {
    rows.push(`📂 открыто ${open.length}/${cfg.maxOpenPositions}:`);
    for (const p of open) {
      const icon = p.selling ? '⏳' : p.pnlPct >= 0 ? '📈' : '📉';
      rows.push(`   ${icon} ${ticker(p.symbol)} ${signedPct(p.pnlPct).padEnd(8)} ${c.gray(`${sol(p.valueSol)} · ${duration(p.ageSeconds)}`)}`);
    }
  }
  const reasons = sniper.topRejectReasons();
  if (reasons) rows.push(`🔍 чаще всего отсеиваем: ${reasons}`);
  rows.push(rpcLine(ctx));
  if (s.seen === 0) rows.push(c.yellow('⚠️  новых токенов не было — проверь интернет и ключ RPC'));

  return box(`📊 СТАТУС · работаю ${duration((Date.now() - ctx.startedAt) / 1000)}`, rows);
}

/** Итог при остановке. */
export function renderSummary(ctx: DashboardContext, leftOpen: number): string {
  const { sniper, paperWallet, positions } = ctx;
  const s = sniper.stats;
  const dot = c.gray(' · ');
  const rows = [`👀 новых токенов ${c.bold(s.seen)}${dot}🛒 куплено ${c.bold(s.bought)}`, tradesLine(ctx)];
  if (paperWallet) rows.push(walletLine(paperWallet, positions));
  if (leftOpen > 0) rows.push(c.yellow(`⚠️  не проданы ${leftOpen} позиций (включи SELL_ON_EXIT=true, чтобы продавать при остановке)`));
  const reasons = sniper.topRejectReasons(6);
  if (reasons) rows.push(`🔍 чаще всего отсеивали: ${reasons}`);
  rows.push(rpcLine(ctx));
  rows.push(c.gray('📄 подробный отчёт: npm run report'));
  return box(`🏁 ИТОГ СЕССИИ · ${duration((Date.now() - ctx.startedAt) / 1000)}`, rows);
}
