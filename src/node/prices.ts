// Identity-bound USD prices. A quote older than 7 days is not a price.
import type { PriceBook } from '../shared/accounting.ts';
import { APT } from '../shared/sources/delegation.ts';

const MAX_QUOTE_AGE_SECS = 7 * 86_400;
const COINGECKO = [{ asset: APT, id: 'aptos', decimals: 8 }];

export async function fetchPrices(nowSecs: number): Promise<{ prices: PriceBook; errors: string[] }> {
  const prices: PriceBook = {};
  const errors: string[] = [];
  try {
    const ids = COINGECKO.map(c => c.id).join(',');
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_last_updated_at=true`,
      { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body: any = await res.json();
    for (const c of COINGECKO) {
      const q = body[c.id];
      if (!q?.usd || q.usd <= 0) { errors.push(`no quote for ${c.id}`); continue; }
      if (nowSecs - q.last_updated_at > MAX_QUOTE_AGE_SECS) { errors.push(`quote for ${c.id} older than 7 days`); continue; }
      prices[c.asset] = { usd: q.usd, decimals: c.decimals, at: new Date(q.last_updated_at * 1000).toISOString(), source: 'coingecko simple/price' };
    }
  } catch (err) {
    errors.push(`coingecko: ${String(err).slice(0, 200)}`);
  }
  return { prices, errors };
}
