import type { Connection, TransactionError, VersionedTransaction } from '@solana/web3.js';
import { sleep } from '../utils.js';

/** Транзакция отправлена, но подтверждение не дождались: она ещё может пройти. */
export class TxTimeoutError extends Error {
  constructor(readonly signature: string, timeoutMs: number) {
    super(`транзакция ${signature} не подтверждена за ${timeoutMs / 1000}с`);
  }
}

export interface SendResult {
  signature: string;
  err: TransactionError | null;
}

/**
 * Отправляет подписанную транзакцию и ждёт подтверждения, периодически переотправляя её
 * (так транзакции реже теряются при перегрузке сети). По таймауту бросает TxTimeoutError.
 */
export async function sendAndConfirm(
  connection: Connection,
  tx: VersionedTransaction,
  timeoutMs = 60_000,
): Promise<SendResult> {
  const raw = tx.serialize();
  const send = () => connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
  const signature = await send();
  const deadline = Date.now() + timeoutMs;
  let lastResend = Date.now();

  while (Date.now() < deadline) {
    await sleep(800);
    let status;
    try {
      status = (await connection.getSignatureStatuses([signature])).value[0];
    } catch {
      continue; // сбой RPC не означает, что транзакция не прошла — продолжаем ждать
    }
    if (status?.err) return { signature, err: status.err };
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      return { signature, err: null };
    }
    if (Date.now() - lastResend > 2_000) {
      lastResend = Date.now();
      send().catch(() => undefined);
    }
  }
  throw new TxTimeoutError(signature, timeoutMs);
}
