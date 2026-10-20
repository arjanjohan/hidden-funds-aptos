import { describe, expect, it } from 'vitest';
import { bucketOf, freshMarkets, tableProvider } from '../src/shared/market.ts';

describe('market buckets', () => {
  it('caps the reference amount at $1k and uses bucket lower bounds in 3× steps', () => {
    expect(bucketOf(0.05)).toBe(0.1);
    expect(bucketOf(0.5)).toBe(0.3);
    expect(bucketOf(5)).toBe(3);
    expect(bucketOf(450)).toBe(300);
    expect(bucketOf(999)).toBe(300);
    expect(bucketOf(25_000)).toBe(1000);
  });
});

describe('published verdicts', () => {
  const NOW = Date.parse('2026-10-20T00:00:00Z') / 1000;
  const fresh = '2026-10-19T00:00:00Z', stale = '2026-10-01T00:00:00Z';
  const table = { tok: { '0.1': { verdict: 'usable' as const, quotedAt: fresh }, '1': { verdict: 'none' as const, quotedAt: fresh },
    '3': { verdict: 'usable' as const, quotedAt: stale } } };
  const q = { asset: 'tok', decimals: 8, redemptionPerToken: 1 };

  it('applies the verdict of the holder\'s bucket, and unknown where none was recorded', async () => {
    const market = tableProvider(table, 2, NOW);
    expect(await market.verdict(q, 0.1)).toBe('usable');   // $0.20
    expect(await market.verdict(q, 1)).toBe('none');       // $2
    expect(await market.verdict(q, 100)).toBe('unknown');  // $200, not quoted
    expect(await market.allUsable(q)).toBe(false);
  });

  it('reads a verdict older than 7 days as unknown', async () => {
    expect(await tableProvider(table, 2, NOW).verdict(q, 2)).toBe('unknown');   // $4 → bucket 3, quoted 19 days ago
    expect(Object.keys(freshMarkets(table, NOW).tok).sort()).toEqual(['0.1', '1']);
  });

  it('is unknown without a native price', async () => {
    expect(await tableProvider(table, null, NOW).verdict(q, 1)).toBe('unknown');
  });
});
