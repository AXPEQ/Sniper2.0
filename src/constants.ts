import { PublicKey } from '@solana/web3.js';

export const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
/** Mint authority pump.fun: участвует только в транзакциях создания токенов, не в сделках. */
export const PUMP_MINT_AUTHORITY = new PublicKey('TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM');
/** Бесплатный публичный WebSocket Solana — для подписок, чтобы не тратить кредиты RPC-провайдера. */
export const PUBLIC_WS_URL = 'wss://api.mainnet-beta.solana.com';
export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

export const LAMPORTS_PER_SOL = 1_000_000_000;
