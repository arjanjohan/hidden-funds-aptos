import { describe, expect, it } from 'vitest';
import { delegation } from '../src/shared/sources/delegation.ts';
import { THALA_LSD, thalaUnstake } from '../src/shared/sources/thala-unstake.ts';
import { addr, context, fakeChain, memoryMemo } from './fake-chain.ts';

const OWNER = addr('abc');
const POOL = addr('def');
const NOW = 1_800_000_000;

function delegationChain(stake: string[], opts: { early?: boolean; lockedUntil?: number; unlockSecs?: number; failArchive?: boolean } = {}) {
  return fakeChain({
    view: (fn) => {
      if (fn === '0x1::delegation_pool::get_stake') return stake;
      if (fn === '0x1::delegation_pool::can_withdraw_pending_inactive') return [opts.early ?? false];
      throw new Error(fn);
    },
    gql: (query) => {
      if (query.includes('delegated_staking_activities')) return { delegated_staking_activities: [{ transaction_version: 42 }] };
      if (query.includes('user_transactions')) return { user_transactions: [{ timestamp: new Date((opts.unlockSecs ?? NOW - 300 * 86_400) * 1000).toISOString().slice(0, -1) }] };
      throw new Error('unexpected gql');
    },
    archiveResource: () => {
      if (opts.failArchive) throw new Error('archive down');
      return { locked_until_secs: String(opts.lockedUntil ?? NOW - 290 * 86_400) };
    },
  });
}

describe('native delegation', () => {
  it('ignores a stale indexer row whose stake is zero on chain', async () => {
    const r = await delegation.read(context(delegationChain(['0', '0', '0'])), OWNER, { pools: [POOL] });
    expect(r.positions).toEqual([]);
    expect(r.complete).toBe(true);
  });

  it('dates inactive stake at the lockup end after the unlock', async () => {
    const lockedUntil = NOW - 290 * 86_400;
    const r = await delegation.read(context(delegationChain(['5', '700', '0'], { lockedUntil })), OWNER, { pools: [POOL] });
    expect(r.positions).toHaveLength(1);
    const [p] = r.positions;
    expect(p.expectedPayout).toEqual([{ asset: expect.any(String), raw: '700' }]);
    expect(p.ageBasis).toBe('onchain_maturity');
    expect(Date.parse(p.claimableSince!) / 1000).toBe(lockedUntil);
    expect(p.id).toBe(`native-delegation:${OWNER}:${POOL}/inactive:principal`);
  });

  it('dates early-withdrawable pending stake as estimated, and skips it while the validator is active', async () => {
    const early = await delegation.read(context(delegationChain(['0', '0', '900'], { early: true })), OWNER, { pools: [POOL] });
    expect(early.positions.map(p => p.ageBasis)).toEqual(['position_interaction']);
    const waiting = await delegation.read(context(delegationChain(['0', '0', '900'], { early: false })), OWNER, { pools: [POOL] });
    expect(waiting.positions).toEqual([]);
  });

  it('keeps amounts complete when only aging fails', async () => {
    const r = await delegation.read(context(delegationChain(['0', '700', '0'], { failArchive: true })), OWNER, { pools: [POOL] });
    expect(r.complete).toBe(true);
    expect(r.positions[0].ageBasis).toBe('unknown');
    expect(r.errors[0]).toMatch(/age/);
  });

  it('marks the read incomplete when a pool read fails', async () => {
    const chain = fakeChain({ view: () => { throw new Error('fullnode down'); } });
    const r = await delegation.read(context(chain), OWNER, { pools: [POOL] });
    expect(r.complete).toBe(false);
    expect(r.positions).toEqual([]);
  });

  it('memoizes claimableSince for an unchanged amount', async () => {
    const memo = memoryMemo();
    await delegation.read(context(delegationChain(['0', '700', '0']), undefined, memo), OWNER, { pools: [POOL] });
    const chain = delegationChain(['0', '700', '0']);
    await delegation.read(context(chain, undefined, memo), OWNER, { pools: [POOL] });
    expect(chain.calls.some(c => c.startsWith('archiveResource'))).toBe(false);
  });
});

describe('thala unstake', () => {
  const request = (id: number, endSec: number, amount = '1000') => ({ account: OWNER, request_id: String(id), start_sec: '0', end_sec: String(endSec), amount });
  const chain = (requests: unknown[], paused = false) => fakeChain({
    view: () => [requests],
    resource: (_a, type) => (type === `${THALA_LSD}::staking::PauseFlag` ? { paused } : null),
  });

  it('counts matured requests only, aged at end_sec', async () => {
    const r = await thalaUnstake.read(context(chain([request(1, NOW - 100), request(2, NOW + 100)])), OWNER);
    expect(r.positions.map(p => p.locator)).toEqual(['1']);
    expect(r.positions[0].ageBasis).toBe('onchain_maturity');
    expect(r.positions[0].status).toBe('recoverable');
  });

  it('blocks matured requests while paused', async () => {
    const r = await thalaUnstake.read(context(chain([request(1, NOW - 100)], true)), OWNER);
    expect(r.positions[0].status).toBe('blocked');
    expect(r.positions[0].blockers[0].code).toBe('paused');
  });

  it('marks the read incomplete when the view fails', async () => {
    const r = await thalaUnstake.read(context(fakeChain({ view: () => { throw new Error('down'); } })), OWNER);
    expect(r.complete).toBe(false);
  });
});
