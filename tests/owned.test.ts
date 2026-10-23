import { describe, expect, it } from 'vitest';
import { assetId, ownedBalances, ownedDelegations, ownedIn, ownedPools } from '../src/shared/owned.ts';
import { AMNIS_WITHDRAWAL_COLLECTION } from '../src/shared/sources/amnis-withdrawals.ts';
import { VEMKL_COLLECTION } from '../src/shared/sources/merkle-vemkl.ts';
import { addr, context, fakeChain } from './fake-chain.ts';

const OWNER = addr('abc');

describe('owned lookups', () => {
  it('runs each broad query once per owner, however many sources ask', async () => {
    const queries: string[] = [];
    const ctx = context(fakeChain({ gql: (q: string) => {
      queries.push(q.slice(0, 40));
      return q.includes('current_token_ownerships_v2')
        ? { current_token_ownerships_v2: [{ token_data_id: addr('f1'), current_token_data: { collection_id: AMNIS_WITHDRAWAL_COLLECTION } },
          { token_data_id: addr('f2'), current_token_data: { collection_id: VEMKL_COLLECTION } }] }
        : { current_fungible_asset_balances: [{ asset_type: '0x1::aptos_coin::AptosCoin', storage_id: addr('s1'), is_primary: true, amount: '5' }] };
    } }));
    expect(await ownedIn(ctx, OWNER, AMNIS_WITHDRAWAL_COLLECTION)).toEqual([addr('f1')]);
    expect(await ownedIn(ctx, OWNER, VEMKL_COLLECTION)).toEqual([addr('f2')]);
    await Promise.all([ownedBalances(ctx, OWNER), ownedBalances(ctx, OWNER)]);
    expect(queries).toHaveLength(2);
  });

  it('names Coin types as filed and fungible assets by full address', () => {
    expect(assetId('0x1::aptos_coin::AptosCoin')).toBe('0x1::aptos_coin::AptosCoin');
    expect(assetId('0xa')).toBe(addr('a'));
  });

  it('keeps a pool whose rows straddle a full page whole, and splits pools by share type', async () => {
    // Page 1: 99 rows for pools 1..99 (active), then pool 100's active row; page 2 resumes after pool 99.
    const pool = (n: number) => addr((0x100 + n).toString(16));
    const ctx = context(fakeChain({ gql: (_q: string, vars: any) => ({ current_delegator_balances: vars.after === ''
      ? [...Array.from({ length: 99 }, (_, i) => ({ pool_address: pool(i + 1), pool_type: 'active_shares' })), { pool_address: pool(100), pool_type: 'active_shares' }]
      : vars.after === pool(99) ? [{ pool_address: pool(100), pool_type: 'active_shares' }, { pool_address: pool(100), pool_type: 'inactive_shares' }] : [] }) }));
    const rows = await ownedDelegations(ctx, OWNER);
    expect(rows.filter(r => r.pool === pool(100))).toEqual([{ pool: pool(100), type: 'active_shares' }, { pool: pool(100), type: 'inactive_shares' }]);
    expect(await ownedPools(ctx, OWNER, 'inactive_shares')).toEqual([pool(100)]);
    expect(await ownedPools(ctx, OWNER, 'active_shares')).toHaveLength(100);
  });
});
