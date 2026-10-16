import { PublicKey } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, LAMPORTS_PER_SOL, PUMP_PROGRAM_ID } from '../constants.js';

export interface BondingCurveState {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  /** true — кривая заполнена, токен мигрировал в AMM (PumpSwap). */
  complete: boolean;
  creator?: PublicKey;
}

export function deriveBondingCurve(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), mint.toBuffer()], PUMP_PROGRAM_ID)[0];
}

export function deriveAssociatedTokenAddress(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

/** Раскладка аккаунта: discriminator(8) + 5×u64 + bool complete + creator pubkey (+ новые поля). */
export function decodeBondingCurve(data: Buffer): BondingCurveState {
  if (data.length < 49) throw new Error(`bonding curve account too short: ${data.length} bytes`);
  const state: BondingCurveState = {
    virtualTokenReserves: data.readBigUInt64LE(8),
    virtualSolReserves: data.readBigUInt64LE(16),
    realTokenReserves: data.readBigUInt64LE(24),
    realSolReserves: data.readBigUInt64LE(32),
    tokenTotalSupply: data.readBigUInt64LE(40),
    complete: data[48] === 1,
  };
  if (data.length >= 81) state.creator = new PublicKey(data.subarray(49, 81));
  return state;
}

type Reserves = Pick<BondingCurveState, 'virtualSolReserves' | 'virtualTokenReserves'>;

/** Капитализация в SOL: цена (vSol/vToken) × total supply. */
export function marketCapSol(state: Reserves & Pick<BondingCurveState, 'tokenTotalSupply'>): number {
  if (state.virtualTokenReserves === 0n) return 0;
  const lamports = (state.virtualSolReserves * state.tokenTotalSupply) / state.virtualTokenReserves;
  return Number(lamports) / LAMPORTS_PER_SOL;
}

const BPS = 10_000n;
const pctToBps = (pct: number): bigint => BigInt(Math.round(pct * 100));

/** Сколько токенов (raw) получим за solInLamports по формуле constant product, комиссия берётся с SOL. */
export function quoteBuy(state: Reserves, solInLamports: bigint, feePct: number): bigint {
  const solAfterFee = (solInLamports * (BPS - pctToBps(feePct))) / BPS;
  if (solAfterFee <= 0n) return 0n;
  const k = state.virtualSolReserves * state.virtualTokenReserves;
  const newTokenReserves = k / (state.virtualSolReserves + solAfterFee) + 1n;
  const out = state.virtualTokenReserves - newTokenReserves;
  return out > 0n ? out : 0n;
}

/** Сколько lamports получим за продажу tokenAmount (raw), за вычетом комиссии. */
export function quoteSell(state: Reserves, tokenAmount: bigint, feePct: number): bigint {
  if (tokenAmount <= 0n) return 0n;
  const solOut = (tokenAmount * state.virtualSolReserves) / (state.virtualTokenReserves + tokenAmount);
  return (solOut * (BPS - pctToBps(feePct))) / BPS;
}
