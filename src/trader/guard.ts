import { PublicKey, type Connection, type VersionedTransaction } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '../constants.js';
import { lamportsToSol } from '../utils.js';

/** Программы, которые могут встречаться в транзакциях PumpPortal на верхнем уровне. */
export const ALLOWED_PROGRAMS = new Set(
  [
    '11111111111111111111111111111111', // System
    'ComputeBudget111111111111111111111111111111',
    ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
    TOKEN_PROGRAM_ID.toBase58(),
    TOKEN_2022_PROGRAM_ID.toBase58(),
    PUMP_PROGRAM_ID.toBase58(),
    'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', // PumpSwap AMM
    'FAdo9NCw1ssek6Z6yeWzWjhLVsr8uiCwcWNUnKgzTnHe', // роутер PumpPortal (CPI в pump.fun + комиссия 0.5%)
  ],
);

/** Статическая проверка транзакции, собранной сторонним сервисом, до подписи. */
export function assertTransactionShape(tx: VersionedTransaction, wallet: PublicKey, extraPrograms: readonly string[] = []): void {
  const keys = tx.message.staticAccountKeys;
  if (!keys[0]?.equals(wallet)) throw new Error('fee payer транзакции — не наш кошелёк');
  for (const ix of tx.message.compiledInstructions) {
    const program = keys[ix.programIdIndex]?.toBase58();
    if (!program || (!ALLOWED_PROGRAMS.has(program) && !extraPrograms.includes(program))) {
      throw new Error(`транзакция вызывает неизвестную программу ${program ?? '?'} — отказ`);
    }
  }
}

/**
 * Симулирует транзакцию и проверяет, что она не падает и кошелёк теряет не больше maxLossSol.
 * Возвращает изменение баланса кошелька в SOL.
 */
export async function simulateAndCheck(
  connection: Connection,
  tx: VersionedTransaction,
  wallet: PublicKey,
  maxLossSol: number,
): Promise<number> {
  const [pre, sim] = await Promise.all([
    connection.getBalance(wallet, 'processed'),
    connection.simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'processed',
      accounts: { encoding: 'base64', addresses: [wallet.toBase58()] },
    }),
  ]);
  if (sim.value.err) {
    const tail = (sim.value.logs ?? []).slice(-3).join(' | ');
    throw new Error(`симуляция упала: ${JSON.stringify(sim.value.err)} ${tail}`);
  }
  const post = sim.value.accounts?.[0]?.lamports;
  if (post === undefined) throw new Error('симуляция не вернула баланс кошелька');
  const delta = lamportsToSol(post - pre);
  if (-delta > maxLossSol) {
    throw new Error(`симуляция: кошелёк теряет ${(-delta).toFixed(6)} SOL > лимита ${maxLossSol.toFixed(6)} — отказ`);
  }
  return delta;
}
