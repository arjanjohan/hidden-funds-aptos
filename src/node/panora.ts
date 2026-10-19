// Panora-backed market test: quote the receipt token into APT, cached per (asset, bucket) for the run.
import { BUCKETS, bucketOf, USABLE_RATIO, type MarketProvider, type MarketQuery, type MarketTable, type Verdict } from '../shared/market.ts';

const PANORA = 'https://api.panora.exchange/swap';
const APT_FA = '0xa';
// Quotes are price discovery only; no wallet is involved.
const QUOTE_WALLET = '0x0000000000000000000000000000000000000000000000000000000000000001';

export function panoraProvider(apiKey: string, aptUsd: number | null): { provider: MarketProvider; table: MarketTable } {
  const table: MarketTable = {};
  const pending = new Map<string, Promise<Verdict>>();

  async function quote(q: MarketQuery, bucket: number): Promise<Verdict> {
    const record = (verdict: Verdict, ratio?: number, detail?: string) => {
      (table[q.asset] ??= {})[String(bucket)] = { verdict, ratio, quotedAt: new Date().toISOString(), detail };
      return verdict;
    };
    if (!aptUsd) return record('unknown', undefined, 'no APT price');
    // Bucket lower bound in USD → tokens of the receipt.
    const tokens = bucket / (aptUsd * q.redemptionPerToken);
    const amount = tokens.toFixed(q.decimals);
    try {
      const url = `${PANORA}?chainId=1&fromTokenAddress=${q.asset}&toTokenAddress=${APT_FA}&fromTokenAmount=${amount}&toWalletAddress=${QUOTE_WALLET}`;
      const res = await fetch(url, { method: 'POST', headers: { 'x-api-key': apiKey }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) return record('unknown', undefined, `HTTP ${res.status}`);
      const body: any = await res.json();
      if (body?.fromToken?.address?.toLowerCase().replace(/^0x0+/, '0x') !== q.asset.toLowerCase().replace(/^0x0+/, '0x')) {
        return record('unknown', undefined, 'quote is for a different input asset');
      }
      if (!Array.isArray(body.quotes)) return record('unknown', undefined, 'malformed response');
      // A well-formed answer without a route means no market.
      if (body.quotes.length === 0) return record('none', 0, 'no route');
      const out = Number(body.quotes[0].toTokenAmount);
      if (!Number.isFinite(out)) return record('unknown', undefined, 'malformed quote');
      const ratio = out / (Number(amount) * q.redemptionPerToken);
      return record(ratio >= USABLE_RATIO ? 'usable' : 'none', ratio);
    } catch (err) {
      return record('unknown', undefined, String(err).slice(0, 120));
    }
  }

  const cached = (q: MarketQuery, bucket: number) => {
    const key = `${q.asset}:${bucket}`;
    if (!pending.has(key)) pending.set(key, quote(q, bucket));
    return pending.get(key)!;
  };

  return {
    table,
    provider: {
      verdict: async (q, native) => (aptUsd ? cached(q, bucketOf(native * aptUsd)) : 'unknown'),
      allUsable: async q => (await Promise.all(BUCKETS.map(b => cached(q, b)))).every(v => v === 'usable'),
    },
  };
}
