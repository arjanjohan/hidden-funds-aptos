import { describe, expect, it } from 'vitest';
import { assess, decide, issueBody, issueTitle, markedCodes, tvlChange, watched, type TvlSeries } from '../src/node/watch.ts';
import type { ProtocolEntry } from '../src/shared/protocols.ts';

const DAY = 86_400;
const entry = (over: Partial<ProtocolEntry> = {}): ProtocolEntry => ({ id: 'x', name: 'X', chains: ['aptos'], category: 'Lending',
  status: 'not_left_behind', reason: 'Live.', checkedAt: '2026-10-20', defillama: 'x', ...over });
const series = (then: number, now: number, chain = 'Aptos'): TvlSeries => ({ [chain]: [
  { date: 1_000 * DAY, totalLiquidityUSD: then }, { date: 1_015 * DAY, totalLiquidityUSD: (then + now) / 2 }, { date: 1_030 * DAY, totalLiquidityUSD: now }] });

describe('wind-down watch', () => {
  it('watches live entries with a DefiLlama slug, and implemented ones only when every source is on a live protocol', () => {
    const ids = watched([entry({ id: 'a' }), entry({ id: 'b', status: 'too_small' }), entry({ id: 'c', defillama: undefined }),
      entry({ id: 'd', status: 'implemented', sources: ['native-delegation'] }), entry({ id: 'e', status: 'implemented', sources: ['echo-wound-down'] })]).map(e => e.id);
    expect(ids).toEqual(['a', 'd']);
  });

  it('flags a TVL drop of 80% or more in 30 days from at least $10K, summed over the entry\'s chains', () => {
    expect(assess(entry(), undefined, series(100_000, 20_000), 'ok').map(s => s.code)).toEqual(['tvl_drop']);
    expect(assess(entry(), undefined, series(100_000, 21_000), 'ok')).toEqual([]);
    expect(assess(entry(), undefined, series(9_000, 0), 'ok')).toEqual([]);
    const both = { ...series(60_000, 5_000), ...series(60_000, 60_000, 'Movement') };
    expect(tvlChange(entry({ chains: ['aptos', 'movement'] }), both)).toEqual({ now: 65_000, then: 120_000 });
    expect(assess(entry({ chains: ['aptos', 'movement'] }), undefined, both, 'ok')).toEqual([]);
  });

  it('flags a dead mark the registry does not record yet, and a site whose domain no longer resolves', () => {
    expect(assess(entry(), { slug: 'x', deadFrom: '2026-10-10', deadUrl: true }, undefined, 'unchecked')[0].detail).toMatch(/dead from 2026-10-10/);
    expect(assess(entry({ dead: '2026-10-10' }), { slug: 'x', deadFrom: '2026-10-10' }, undefined, 'unchecked')).toEqual([]);
    expect(assess(entry(), { slug: 'x', url: 'https://app.x.fi/' }, undefined, 'missing')[0]).toMatchObject({ code: 'site_down', detail: expect.stringMatching(/app\.x\.fi/) });
    expect(assess(entry(), { slug: 'x', url: 'https://app.x.fi/' }, undefined, 'unchecked')).toEqual([]);
  });

  it('updates the open issue, respects a closed one that covers the signals, and opens one for a new kind of signal', () => {
    const e = entry({ name: 'Goblin' });
    const tvl = [{ code: 'tvl_drop' as const, detail: 'TVL fell.' }], site = [{ code: 'site_down' as const, detail: 'Gone.' }];
    const closed = { number: 7, title: issueTitle(e), state: 'closed' as const, body: issueBody(e, tvl, '2026-10-26') };
    expect(markedCodes(closed.body)).toEqual(new Set(['tvl_drop']));
    expect(decide(e, tvl, [{ number: 9, title: issueTitle(e), state: 'open' }, closed])).toEqual({ action: 'update', issue: 9 });
    expect(decide(e, tvl, [closed])).toEqual({ action: 'acknowledged', issue: 7 });
    expect(decide(e, [...tvl, ...site], [closed])).toEqual({ action: 'create' });
    expect(decide(e, tvl, [])).toEqual({ action: 'create' });
  });

  it('writes one issue per protocol, titled by name', () => {
    const e = entry({ name: 'Goblin' });
    expect(issueTitle(e)).toBe('Possible wind-down: Goblin');
    expect(issueBody(e, [{ code: 'tvl_drop', detail: 'TVL fell.' }], '2026-10-26')).toMatch(/- TVL fell\.[\s\S]*Last flagged 2026-10-26/);
  });
});
