import { describe, expect, it } from 'vitest';
import { ownerKind } from '../src/shared/owners.ts';
import { delegation, MOVE, movementDelegation } from '../src/shared/sources/delegation.ts';
import { delegationInactiveValidator } from '../src/shared/sources/delegation-inactive.ts';
import { KAPT, kofiReceipts, STKAPT } from '../src/shared/sources/kofi-receipts.ts';
import { kofiWithdrawals } from '../src/shared/sources/kofi-withdrawals.ts';
import { thalaVestingMatured, thalaVethlExpired } from '../src/shared/sources/thala-thl.ts';
import { THALA_LSD, thalaUnstake } from '../src/shared/sources/thala-unstake.ts';
import { tortugaTickets } from '../src/shared/sources/tortuga-tickets.ts';
import { trufinUnlocks } from '../src/shared/sources/trufin-unlocks.ts';
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

describe('kofi withdrawals', () => {
  const ticket = (id: number, unlock: number, apt = '1000', fees = '0') =>
    ({ ticket_id: String(id), user: OWNER, kapt_amount: apt, apt_amount: apt, unlock_timestamp: String(unlock), withdraw_fees: fees });
  const chain = (tickets: unknown[], paused = false) => fakeChain({
    view: () => [tickets],
    resource: (_a, type) => (type.endsWith('::config::GlobalConfig') ? { gateway_config: { withdrawals_paused: paused } } : null),
  });

  it('counts unlocked tickets only, aged at unlock_timestamp, net of withdrawal fees', async () => {
    const r = await kofiWithdrawals.read(context(chain([ticket(1, NOW - 100, '1000', '30'), ticket(2, NOW + 100)])), OWNER);
    expect(r.positions.map(p => p.locator)).toEqual(['1']);
    expect(r.positions[0].grossClaim[0].raw).toBe('1000');
    expect(r.positions[0].expectedPayout[0].raw).toBe('970');
    expect(r.positions[0].claimableSince).toBe(new Date((NOW - 100) * 1000).toISOString());
  });

  it('blocks unlocked tickets while withdrawals are paused', async () => {
    const r = await kofiWithdrawals.read(context(chain([ticket(1, NOW - 100)], true)), OWNER);
    expect(r.positions[0].status).toBe('blocked');
  });
});

describe('tortuga tickets', () => {
  // Outstanding queue: cleared up to 1000, reserve 500 → queue positions up to 1500 are funded.
  const chain = (tickets: unknown[]) => fakeChain({
    resource: (_a, type) => type.endsWith('::stake_router::TicketStore') ? { tickets }
      : type.endsWith('::stake_router::StakingStatus') ? { total_claims_balance: '2000', total_claims_balance_cleared: '1000', cooldown_period: '3600' }
      : type.endsWith('::validator_router::AptosCoinReserve') ? { coin: { value: '500' } } : null,
  });
  const ticket = (id: number, amount: number, created: number) => ({ id: String(id), amount: String(amount), timestamp: String(created) });

  it('splits cooled-down tickets into funded (recoverable) and queued behind the reserve (blocked)', async () => {
    const r = await tortugaTickets.read(context(chain([ticket(1400, 100, NOW - 7200), ticket(1900, 100, NOW - 7200), ticket(1950, 50, NOW - 60)])), OWNER);
    expect(r.positions.map(p => [p.locator, p.status])).toEqual([['1400', 'recoverable'], ['1900', 'blocked']]);
    expect(r.positions[1].blockers[0].code).toBe('reserve_short');
    expect(r.positions[0].claimableSince).toBe(new Date((NOW - 7200 + 3600) * 1000).toISOString());
  });

  it('claims by index in the owner\'s ticket list', async () => {
    const r = await tortugaTickets.read(context(chain([ticket(1950, 50, NOW - 60), ticket(1400, 100, NOW - 7200)])), OWNER);
    expect(r.positions[0].steps[0].arguments).toEqual(['1']);
  });

  it('reads nothing more for an account without tickets', async () => {
    const r = await tortugaTickets.read(context(fakeChain({ resource: () => null })), OWNER);
    expect(r).toMatchObject({ positions: [], complete: true });
  });
});

describe('owner kind', () => {
  it('classifies resource accounts, objects and ordinary accounts, once', async () => {
    const zero = '0x' + '0'.repeat(64);
    const chain = fakeChain({
      account: a => (a === addr(1) ? { authentication_key: zero, sequence_number: '0' } : a === addr(2) ? { authentication_key: addr(2), sequence_number: '3' } : null),
      resource: a => (a === addr(3) ? { owner: addr(2) } : null),
    });
    const ctx = context(chain);
    expect(await ownerKind(ctx, addr(1))).toBe('resource_account');
    expect(await ownerKind(ctx, addr(2))).toBe('user');
    expect(await ownerKind(ctx, addr(3))).toBe('object');
    expect(await ownerKind(ctx, addr(4))).toBe('user');
    const before = chain.calls.length;
    await ownerKind(ctx, addr(1));
    expect(chain.calls.length).toBe(before);
  });
});

describe('thala THL', () => {
  it('counts a THL lock once its unlockable epoch is reached, aged at the epoch start', async () => {
    const chain = (unlockable: number) => fakeChain({
      resource: () => ({ vetoken: { locked: { value: '500' }, unlockable_epoch: String(unlockable) } }),
      view: fn => (fn.endsWith('::now_epoch') ? ['100'] : fn.endsWith('::seconds_in_epoch') ? ['604800'] : []),
    });
    const expired = await thalaVethlExpired.read(context(chain(90)), OWNER);
    expect(expired.positions).toHaveLength(1);
    expect(expired.positions[0].claimableSince).toBe(new Date(90 * 604800 * 1000).toISOString());
    expect((await thalaVethlExpired.read(context(chain(101)), OWNER)).positions).toEqual([]);
  });

  it('counts matured vesting claims at their claimable amount and skips accounts without claims', async () => {
    const claim = (id: number, end: number, ready: string) =>
      ({ claim_id: String(id), beneficiary: OWNER, total_amount: '1000', claimable_amount: ready, end_sec: String(end) });
    const chain = fakeChain({ resource: () => ({ claim_ids: ['1', '2'] }), view: () => [[claim(1, NOW - 10, '1000'), claim(2, NOW + 10, '400')]] });
    const r = await thalaVestingMatured.read(context(chain), OWNER);
    expect(r.positions.map(p => [p.locator, p.expectedPayout[0].raw])).toEqual([['1', '1000']]);
    const none = fakeChain({ resource: () => ({ claim_ids: [] }) });
    expect((await thalaVestingMatured.read(context(none), OWNER)).positions).toEqual([]);
    expect(none.calls.some(c => c.startsWith('view'))).toBe(false);
  });
});

describe('delegation with an inactive validator', () => {
  const STOP = NOW - 200 * 86_400;
  const chain = (opts: { state?: number; active?: string; pending?: string; rewards?: boolean; addedAt?: number }) => fakeChain({
    view: fn => fn === '0x1::stake::get_validator_state' ? [String(opts.state ?? 4)]
      : fn === '0x1::delegation_pool::get_stake' ? [opts.active ?? '5000000000', '0', opts.pending ?? '0'] : [],
    gql: (query, vars) => query.includes('DistributeRewards') ? { delegated_staking_activities: opts.rewards === false ? [] : [{ transaction_version: 10 }] }
      : query.includes('AddStake') ? { delegated_staking_activities: opts.addedAt ? [{ transaction_version: 20 }] : [] }
      : query.includes('block_metadata_transactions') ? { block_metadata_transactions: [{ timestamp: new Date(((vars as any).v === '20' ? opts.addedAt! : STOP) * 1000).toISOString().slice(0, -1) }] }
      : { current_delegator_balances: [] },
  });
  const read = (opts: Parameters<typeof chain>[0]) => delegationInactiveValidator.read(context(chain(opts)), OWNER, { pools: [POOL] });

  it('ignores pools whose validator is active', async () => {
    expect((await read({ state: 2 })).positions).toEqual([]);
  });

  it('dates idle stake at the validator\'s last reward, or at a later add', async () => {
    expect((await read({})).positions[0]).toMatchObject({ ageBasis: 'protocol_closure', claimableSince: new Date(STOP * 1000).toISOString(), status: 'recoverable' });
    const later = NOW - 100 * 86_400;
    expect((await read({ addedAt: later })).positions[0].claimableSince).toBe(new Date(later * 1000).toISOString());
  });

  it('leaves the age unknown when no reward is indexed for the pool', async () => {
    expect((await read({ rewards: false })).positions[0].ageBasis).toBe('unknown');
  });

  it('blocks stake below the 10 APT unlock minimum', async () => {
    const p = (await read({ active: '500000000' })).positions[0];
    expect(p.status).toBe('blocked');
    expect(p.blockers[0].code).toBe('below_unlock_minimum');
    expect((await read({ active: '500000000', pending: '600000000' })).positions[0].status).toBe('recoverable');
  });
});

describe('trufin unlocks', () => {
  const POOL2 = addr('0901');
  const row = (nonce: number, user: string) => ({ key: String(nonce), value: { user, amount: '2000', delegation_pool: POOL2, olc: '5' } });
  const chain = (opts: { listed?: boolean; claimable?: boolean; size?: number }) => fakeChain({
    resource: () => ({ unlocks: { size: String(opts.size ?? 2), num_buckets: '1', buckets: { inner: { handle: '0xh' } } } }),
    tableItem: () => [row(1, OWNER), row(2, addr(7))],
    view: fn => fn.endsWith('::staker::whitelist') ? [addr('aa')] : fn.endsWith('::is_whitelisted') ? [opts.listed ?? true]
      : fn.endsWith('::is_claimable') ? [opts.claimable ?? true] : [],
    archiveResource: () => ({ observed_lockup_cycle: { index: '9' } }),
    gql: () => ({ user_transactions: [{ timestamp: '2026-07-25T22:34:03' }] }),
  });

  it('lists only the owner\'s claimable requests, whitelisted as recoverable', async () => {
    const r = await trufinUnlocks.read(context(chain({})), OWNER);
    expect(r.positions.map(p => [p.locator, p.status])).toEqual([['1', 'recoverable']]);
  });

  it('marks requests of wallets off the whitelist as needing the team', async () => {
    const r = await trufinUnlocks.read(context(chain({ listed: false })), OWNER);
    expect(r.positions[0].status).toBe('team_gated');
  });

  it('refuses a partial table instead of reporting no request', async () => {
    const r = await trufinUnlocks.read(context(chain({ size: 3 })), OWNER);
    expect(r.complete).toBe(false);
  });
});

describe('movement delegation', () => {
  it('reads the same framework module but prices MOVE apart from APT', async () => {
    const chain = fakeChain({
      view: fn => (fn === '0x1::delegation_pool::get_stake' ? ['0', '700', '0'] : [false]),
      gql: query => query.includes('delegated_staking_activities') ? { delegated_staking_activities: [] } : {},
    });
    const r = await movementDelegation.read(context(chain), OWNER, { pools: [POOL] });
    expect(movementDelegation.chain).toBe('movement');
    expect(r.positions[0].expectedPayout[0].asset).toBe(MOVE);
    expect(r.positions[0].id.startsWith('movement-native-delegation:')).toBe(true);
  });
});

describe('kofi receipts', () => {
  const chain = (balances: Record<string, string>, changedAt: number) => fakeChain({
    view: (fn, args) => fn.endsWith('::get_exchange_rate') ? ['108560114']
      : fn === '0x1::primary_fungible_store::balance' ? [balances[(args as string[])[1]] ?? '0'] : [],
    gql: () => ({ user_transactions: [{ timestamp: new Date(changedAt * 1000).toISOString().slice(0, -1) }] }),
  });
  const versions = { [KAPT]: 10, [STKAPT]: 11 };

  it('values kAPT 1:1 and stkAPT at the live rate, and never counts them while the market is unchecked', async () => {
    const r = await kofiReceipts.read(context(chain({ [KAPT]: '100000000', [STKAPT]: '100000000' }, 1_700_000_000)), OWNER, { versions });
    expect(r.positions.map(p => [p.locator, p.expectedPayout[0].raw])).toEqual([['kAPT', '100000000'], ['stkAPT', '108560114']]);
    expect(r.positions.every(p => p.status === 'unknown' && p.blockers[0].code === 'market_check_unavailable')).toBe(true);
  });

  it('dates holdings from the wind-down, or from a later balance change', async () => {
    const early = await kofiReceipts.read(context(chain({ [KAPT]: '5' }, 1_700_000_000)), OWNER, { versions: { [KAPT]: 10 } });
    expect(early.positions[0].claimableSince).toBe('2026-07-24T07:55:53.000Z');
    const later = NOW - 10 * 86_400;
    const late = await kofiReceipts.read(context(chain({ [KAPT]: '5' }, later)), OWNER, { versions: { [KAPT]: 10 } });
    expect(late.positions[0].claimableSince).toBe(new Date(later * 1000).toISOString());
  });
});
