import { Connection, Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { checkMetadata, checkMint, TokenFilter } from '../src/filters/index.js';
import { isTwitterUrl, metadataUrls, parseMetadata } from '../src/filters/metadata.js';
import type { CreateEvent } from '../src/pump/events.js';

const event = (name: string, symbol: string, extra: Partial<CreateEvent> = {}): CreateEvent => ({
  name,
  symbol,
  uri: 'https://example.com/meta.json',
  mint: Keypair.generate().publicKey,
  bondingCurve: Keypair.generate().publicKey,
  user: Keypair.generate().publicKey,
  ...extra,
});

const makeFilter = (env: Record<string, string> = {}) =>
  new TokenFilter(new Connection('http://127.0.0.1:1'), loadConfig(env));

describe('quickCheck', () => {
  it('passes a normal token', () => {
    expect(makeFilter().quickCheck(event('Doge Moon', 'DMOON'))).toBeNull();
  });
  it('skips mayhem mode by default', () => {
    expect(makeFilter().quickCheck(event('A', 'A', { isMayhemMode: true }))).toBe('mayhem mode');
    expect(makeFilter({ SKIP_MAYHEM: 'false' }).quickCheck(event('A', 'A', { isMayhemMode: true }))).toBeNull();
  });
  it('applies blacklist and whitelist', () => {
    const f = makeFilter({ NAME_BLACKLIST: 'rug,scam', NAME_WHITELIST: 'cat,dog' });
    expect(f.quickCheck(event('Super Rug', 'SR'))).toContain('rug');
    expect(f.quickCheck(event('Frog', 'FRG'))).toContain('NAME_WHITELIST');
    expect(f.quickCheck(event('Cat King', 'CATK'))).toBeNull();
  });
  it('rejects copycats by name, not by a shared ticker', () => {
    const f = makeFilter();
    expect(f.quickCheck(event('Pepe 2', 'PEPE2'))).toBeNull();
    expect(f.quickCheck(event(' pepe  2 ', 'OTHER'))).toContain('копия');
    expect(f.quickCheck(event('Different', 'PEPE2'))).toBeNull();
  });
  it('rejects blacklisted creators', () => {
    const user = Keypair.generate().publicKey;
    const f = makeFilter({ CREATOR_BLACKLIST: user.toBase58() });
    expect(f.quickCheck(event('X', 'X', { user }))).toContain('чёрном');
  });
});

const mintAccount = (info: Record<string, unknown>) =>
  ({ data: { program: 'spl-token-2022', parsed: { type: 'mint', info }, space: 0 }, executable: false, lamports: 1, owner: Keypair.generate().publicKey }) as never;

describe('checkMint', () => {
  it('accepts a revoked pump.fun mint', () => {
    expect(checkMint(mintAccount({ mintAuthority: null, freezeAuthority: null, extensions: [{ extension: 'metadataPointer' }] }))).toBeNull();
  });
  it('rejects live authorities', () => {
    expect(checkMint(mintAccount({ mintAuthority: 'abc', freezeAuthority: null }))).toContain('mint authority');
    expect(checkMint(mintAccount({ mintAuthority: null, freezeAuthority: 'abc' }))).toContain('freeze authority');
  });
  it('rejects dangerous Token-2022 extensions', () => {
    expect(checkMint(mintAccount({ mintAuthority: null, freezeAuthority: null, extensions: [{ extension: 'permanentDelegate' }] }))).toContain('permanentDelegate');
    expect(checkMint(mintAccount({ mintAuthority: null, freezeAuthority: null, extensions: [{ extension: 'defaultAccountState', state: { accountState: 'frozen' } }] }))).toContain('заморожены');
  });
  it('rejects missing account', () => {
    expect(checkMint(null)).toBe('mint не найден');
  });
});

describe('metadataUrls', () => {
  it('leaves non-ipfs uris alone', () => {
    expect(metadataUrls('https://meta.example/x')).toEqual(['https://meta.example/x']);
  });
  it('tries fast gateways before the original ipfs.io url', () => {
    expect(metadataUrls('https://ipfs.io/ipfs/bafy')).toEqual([
      'https://pump.mypinata.cloud/ipfs/bafy',
      'https://ipfs.filebase.io/ipfs/bafy',
      'https://ipfs.io/ipfs/bafy',
    ]);
  });
  it('supports custom gateways and the ipfs:// scheme', () => {
    expect(metadataUrls('ipfs://bafy', ['https://gw.example/ipfs'])).toEqual(['https://gw.example/ipfs/bafy']);
  });
});

describe('parseMetadata', () => {
  it('reads socials from top level and extensions', () => {
    expect(parseMetadata({ twitter: ' https://x.com/a ' }).twitter).toBe('https://x.com/a');
    expect(parseMetadata({ extensions: { telegram: 't.me/a' } }).telegram).toBe('t.me/a');
    expect(parseMetadata({ twitter: '' }).twitter).toBeUndefined();
  });
});

describe('checkMetadata', () => {
  const strict = { requireSocials: true, requireTwitter: true, requireImage: true };
  it('accepts full metadata', () => {
    expect(checkMetadata({ twitter: 'https://x.com/coin', image: 'https://img' }, strict)).toBeNull();
  });
  it('requires a real X/Twitter link and an image in strict mode', () => {
    expect(checkMetadata({ telegram: 't.me/a', image: 'i' }, strict)).toContain('X/Twitter');
    expect(checkMetadata({ twitter: 'https://example.com/x', image: 'i' }, strict)).toContain('X/Twitter');
    expect(checkMetadata({ twitter: 'https://x.com/a' }, strict)).toContain('картинки');
    expect(checkMetadata({}, strict)).toContain('соцсетей');
  });
  it('recognises twitter url variants', () => {
    expect(isTwitterUrl('https://twitter.com/abc/status/1')).toBe(true);
    expect(isTwitterUrl('x.com/abc')).toBe(true);
    expect(isTwitterUrl('https://x.com/')).toBe(false);
  });
});
