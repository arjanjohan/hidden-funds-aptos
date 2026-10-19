// Market test for liquid receipt tokens (docs/left-behind.md, "Stranded liquid receipt tokens").
// A receipt counts as left behind only when no usable market exists for it.

export type Verdict = 'usable' | 'none' | 'unknown';

/** USD value buckets, by lower bound. A holder's reference amount is min($1k, its redemption value); each bucket is
 *  quoted at its lower bound — a smaller amount has less price impact, so this never calls a market unusable that a
 *  holder in the bucket could actually use. */
export const BUCKETS = [0.1, 1, 10, 100, 1000] as const;
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

/** Provider for the browser: verdicts recorded by the last snapshot; anything missing is unknown. */
export function tableProvider(table: MarketTable | undefined, nativeUsd: number | null): MarketProvider {
  const lookup = (asset: string, bucket: number): Verdict => table?.[asset]?.[String(bucket)]?.verdict ?? 'unknown';
  return {
    verdict: async (q, native) => (nativeUsd ? lookup(q.asset, bucketOf(native * nativeUsd)) : 'unknown'),
    allUsable: async q => BUCKETS.every(b => lookup(q.asset, b) === 'usable'),
  };
}
