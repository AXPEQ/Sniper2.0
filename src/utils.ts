export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(fn: () => Promise<T>, attempts = 3, delayMs = 300): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await sleep(delayMs * (i + 1));
    }
  }
  throw lastErr;
}

export const lamportsToSol = (lamports: bigint | number): number => Number(lamports) / 1_000_000_000;
export const solToLamports = (sol: number): bigint => BigInt(Math.round(sol * 1_000_000_000));

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
