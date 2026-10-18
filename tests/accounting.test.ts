import { describe, expect, it } from 'vitest';
import { ageDays, assertUniqueIds, positionIds, sourceTotals, usd, type PriceBook } from '../src/shared/accounting.ts';
import { APT } from '../src/shared/sources/delegation.ts';
import type { AgeBasis, Position, Status } from '../src/shared/types.ts';
import { addr } from './fake-chain.ts';

const NOW = 1_800_000_000;
const DAY = 86_400;
const prices: PriceBook = { [APT]: { usd: 2, decimals: 8, at: '2026-10-18T00:00:00Z', source: 'test' } };

function pos(over: { owner?: string; locator?: string; apt?: number; days?: number | null; basis?: AgeBasis; status?: Status; asset?: string }): Position {
  const owner = over.owner ?? addr(1), locator = over.locator ?? 'pool/inactive';
  const amount = [{ asset: over.asset ?? APT, raw: String(Math.round((over.apt ?? 1) * 1e8)) }];
  return {
    ...positionIds('s', owner, locator, 'principal'), source: 's', owner, locator, positionKind: 'principal',
    claimableSince: over.days == null ? undefined : new Date((NOW - over.days * DAY) * 1000).toISOString(),
    ageBasis: over.basis ?? (over.days == null ? 'unknown' : 'onchain_maturity'),
    provenance: { reader: 'test', ledgerVersion: '1' }, grossClaim: amount, expectedPayout: amount, payoutBasis: 'view',
    status: over.status ?? 'recoverable', blockers: [], confidence: 'verified_view', observedAt: '2026-10-18T00:00:00Z', steps: [],
  };
}

const source = { headlineAgeBases: ['onchain_maturity', 'protocol_closure'] as AgeBasis[] };

describe('position ids', () => {
  it('keep principal, fees and per-asset rewards on one locator distinct', () => {
    const ids = [
      positionIds('s', addr(1), 'x', 'principal'), positionIds('s', addr(1), 'x', 'fees'),
      positionIds('s', addr(1), 'x', 'reward', 'a'), positionIds('s', addr(1), 'x', 'reward', 'b'),
    ];
    expect(new Set(ids.map(i => i.id)).size).toBe(4);
    expect(new Set(ids.map(i => i.parentId)).size).toBe(1);
  });

  it('reject duplicates in totals', () => {
    expect(() => assertUniqueIds([pos({}), pos({})])).toThrow(/Duplicate/);
  });
});

describe('aging', () => {
  it('has no age without a basis', () => {
    expect(ageDays(pos({ days: null }), NOW)).toBeNull();
  });

  it('buckets are cumulative and only count headline-eligible bases', () => {
    const t = sourceTotals(source, [
      pos({ locator: 'a', days: 200 }),
      pos({ locator: 'b', days: 100 }),
      pos({ locator: 'c', days: 40 }),
      pos({ locator: 'd', days: 400, basis: 'position_interaction' }),
      pos({ locator: 'e', days: null }),
    ], prices, NOW);
    expect(t.aged.ge30.positions).toBe(3);
    expect(t.aged.ge90.positions).toBe(2);
    expect(t.aged.ge180.positions).toBe(1);
    expect(t.headline.positions).toBe(2);
    expect(t.agedEstimated.ge90.positions).toBe(1);
    expect(t.byAgeBasis.unknown.positions).toBe(1);
  });

  it('keeps blocked and team-gated value out of the headline', () => {
    const t = sourceTotals(source, [
      pos({ locator: 'a', days: 200, status: 'blocked' }),
      pos({ locator: 'b', days: 200, status: 'team_gated' }),
    ], prices, NOW);
    expect(t.headline.usd).toBe(0);
    expect(t.face.usd).toBe(4);
    expect(t.byStatus.blocked.positions).toBe(1);
  });
});

describe('usd', () => {
  it('counts unpriced value separately, never as zero', () => {
    expect(usd([{ asset: 'unknown', raw: '1' }], prices)).toBeNull();
    const t = sourceTotals(source, [pos({ locator: 'a', days: 200, asset: 'unknown' })], prices, NOW);
    expect(t.headline.unpriced).toBe(1);
    expect(t.headline.usd).toBe(0);
  });

  it('counts owners per source with the $10 floor', () => {
    const t = sourceTotals(source, [
      pos({ owner: addr(1), locator: 'a', apt: 3, days: 200 }),
      pos({ owner: addr(1), locator: 'b', apt: 3, days: 200 }),
      pos({ owner: addr(2), locator: 'a', apt: 1, days: 200 }),
    ], prices, NOW);
    expect(t.headline.owners).toBe(2);
    expect(t.headline.ownersMin10).toBe(1);
  });
});
