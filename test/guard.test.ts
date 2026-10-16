import { Keypair, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { assertTransactionShape } from '../src/trader/guard.js';

const wallet = Keypair.generate().publicKey;

function tx(payer: typeof wallet, ixs: TransactionInstruction[]): VersionedTransaction {
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: '11111111111111111111111111111111', instructions: ixs }).compileToV0Message();
  return new VersionedTransaction(msg);
}

const transfer = SystemProgram.transfer({ fromPubkey: wallet, toPubkey: Keypair.generate().publicKey, lamports: 1 });

describe('assertTransactionShape', () => {
  it('accepts allowed programs paid by our wallet', () => {
    expect(() => assertTransactionShape(tx(wallet, [transfer]), wallet)).not.toThrow();
  });
  it('rejects a foreign fee payer', () => {
    expect(() => assertTransactionShape(tx(Keypair.generate().publicKey, [transfer]), wallet)).toThrow('fee payer');
  });
  it('rejects unknown programs', () => {
    const evil = new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [{ pubkey: wallet, isSigner: true, isWritable: true }], data: Buffer.alloc(0) });
    expect(() => assertTransactionShape(tx(wallet, [transfer, evil]), wallet)).toThrow('неизвестную программу');
  });
});
