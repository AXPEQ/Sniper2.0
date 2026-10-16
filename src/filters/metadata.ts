export interface TokenMetadata {
  name?: string;
  symbol?: string;
  description?: string;
  image?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
}

const DEFAULT_GATEWAYS = ['https://pump.mypinata.cloud/ipfs/', 'https://ipfs.filebase.io/ipfs/'];

/**
 * Список URL для загрузки метаданных. Для IPFS пробуем быстрые шлюзы по очереди
 * (публичный ipfs.io часто отвечает 429), исходный URL — последним.
 */
export function metadataUrls(uri: string, gateways: readonly string[] = DEFAULT_GATEWAYS): string[] {
  const cid = uri.startsWith('ipfs://') ? uri.slice('ipfs://'.length) : uri.match(/^https?:\/\/[^/]+\/ipfs\/(.+)$/)?.[1];
  if (!cid) return [uri];
  const urls = gateways.map((g) => `${g.replace(/\/?$/, '/')}${cid}`);
  if (!uri.startsWith('ipfs://')) urls.push(uri);
  return [...new Set(urls)];
}

export async function fetchMetadata(uri: string, timeoutMs: number, gateways?: readonly string[]): Promise<TokenMetadata> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: Error = new Error('нет URL');
  for (const url of metadataUrls(uri, gateways && gateways.length > 0 ? gateways : undefined)) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(left) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseMetadata((await res.json()) as Record<string, unknown>);
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastErr;
}

export function parseMetadata(json: Record<string, unknown>): TokenMetadata {
  const s = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
  // Некоторые лаунчеры кладут соцсети в extensions.
  const ext = (typeof json.extensions === 'object' && json.extensions !== null ? json.extensions : {}) as Record<string, unknown>;
  return {
    name: s(json.name),
    symbol: s(json.symbol),
    description: s(json.description),
    image: s(json.image),
    twitter: s(json.twitter) ?? s(ext.twitter),
    telegram: s(json.telegram) ?? s(ext.telegram),
    website: s(json.website) ?? s(ext.website),
  };
}

export function hasSocials(meta: TokenMetadata): boolean {
  return Boolean(meta.twitter || meta.telegram || meta.website);
}
