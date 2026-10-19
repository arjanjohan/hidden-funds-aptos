import { describe, expect, it } from 'vitest';
import { bucketOf, tableProvider } from '../src/shared/market.ts';

describe('market buckets', () => {
  it('caps the reference amount at $1k and uses bucket lower bounds', () => {
    expect(bucketOf(0.05)).toBe(0.1);
    expect(bucketOf(5)).toBe(1);
    expect(bucketOf(450)).toBe(100);
    expect(bucketOf(25_000)).toBe(1000);
  });
});

describe('published verdicts', () => {
  const table = { tok: { '0.1': { verdict: 'usable' as const, quotedAt: '' }, '1': { verdict: 'none' as const, quotedAt: '' } } };
  const q = { asset: 'tok', decimals: 8, redemptionPerToken: 1 };

  it('applies the verdict of the holder\'s bucket, and unknown where none was recorded', async () => {
    const market = tableProvider(table, 2);
    expect(await market.verdict(q, 0.1)).toBe('usable');   // $0.20
    expect(await market.verdict(q, 1)).toBe('none');       // $2
    expect(await market.verdict(q, 100)).toBe('unknown');  // $200, not quoted
    expect(await market.allUsable(q)).toBe(false);
  });

  it('is unknown without a native price', async () => {
    expect(await tableProvider(table, null).verdict(q, 1)).toBe('unknown');
  });
});
