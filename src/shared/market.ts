// Market test for liquid receipt tokens (docs/left-behind.md, "Stranded liquid receipt tokens").
// A receipt counts as left behind only when no usable market exists for it.

export type Verdict = 'usable' | 'none' | 'unknown';

/** USD value buckets, by lower bound. A holder's reference amount is min($1k, its redemption value); each bucket is
 *  quoted at its lower bound. A smaller amount has less price impact, so this never calls a market unusable that a
 *  holder in the bucket could use (no stranded value is over-counted). The cost is the other way: a holder near the top
 *  of a bucket trades up to ~3.3× the quoted amount and may get a worse rate than the quote, so a market can be called
 *  usable that this holder could not use. The 3× steps keep that gap small. */
export const BUCKETS = [0.1, 0.3, 1, 3, 10, 30, 100, 300, 1000] as const;
/** A market is usable when the quote returns at least this share of the redemption value. */
export const USABLE_RATIO = 0.8;

export function bucketOf(usd: number): number {
  const ref = Math.min(usd, 1000);
  return [...BUCKETS].reverse().find(b => ref >= b) ?? BUCKETS[0];
}

export interface MarketQuery {
  asset: string;
  decimals: number;
  /** Native coin (APT) one whole token redeems for, e.g. 1.0856 for stkAPT. */
  redemptionPerToken: number;
}

export interface MarketProvider {
  /** Verdict for a holder whose redemption value is `native` whole native coins (APT). */
  verdict(q: MarketQuery, native: number): Promise<Verdict>;
  /** True when every bucket has a usable market: then no holder of this asset can be stranded. */
  allUsable(q: MarketQuery): Promise<boolean>;
}

/** Published verdicts: asset → bucket (lower bound, as string) → verdict with the quote's evidence. */
export type MarketTable = Record<string, Record<string, { verdict: Verdict; ratio?: number; quotedAt: string; detail?: string }>>;

/** A verdict older than this says nothing about the market today: it reads as unknown. */
export const MARKET_MAX_AGE_SECS = 7 * 86_400;

/** The verdicts still fresh at `nowSecs`; older ones are dropped. */
export function freshMarkets(table: MarketTable, nowSecs: number): MarketTable {
  const out: MarketTable = {};
  for (const [asset, buckets] of Object.entries(table)) {
    const fresh = Object.entries(buckets).filter(([, v]) => nowSecs - Date.parse(v.quotedAt) / 1000 <= MARKET_MAX_AGE_SECS);
    if (fresh.length) out[asset] = Object.fromEntries(fresh);
  }
  return out;
}

/** Provider for the browser: verdicts recorded by the last snapshot, while fresh; anything missing or stale is unknown. */
export function tableProvider(table: MarketTable | undefined, nativeUsd: number | null, nowSecs = Date.now() / 1000): MarketProvider {
  const fresh = freshMarkets(table ?? {}, nowSecs);
  const lookup = (asset: string, bucket: number): Verdict => fresh[asset]?.[String(bucket)]?.verdict ?? 'unknown';
  return {
    verdict: async (q, native) => (nativeUsd ? lookup(q.asset, bucketOf(native * nativeUsd)) : 'unknown'),
    allUsable: async q => BUCKETS.every(b => lookup(q.asset, b) === 'usable'),
  };
}
