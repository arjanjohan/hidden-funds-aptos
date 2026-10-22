// What an owner holds, from three broad indexer queries that every source looking it up shares. The check page reads all
// sources for an address, and one query per kind costs far less of the public per-IP indexer budget than one narrow
// query per source (measured 2026-10-22: 18 against 10 small wallets per 5-minute window, 23 against 2 large ones).
// Memoized per owner and ledger version for the read. Rows are indexer state: sources still verify amounts on chain.
// The collection ids live with their sources; they are only read inside these functions, so the modules' mutual
// imports resolve in either order.
import { gqlAll, normalizeAddress, once } from './chain.ts';
import { AMNIS_WITHDRAWAL_COLLECTION } from './sources/amnis-withdrawals.ts';
import { AURO_COLLECTION } from './sources/auro-closed.ts';
import { VEMKL_COLLECTION } from './sources/merkle-vemkl.ts';
import type { ReadContext } from './types.ts';

export interface OwnedBalance { asset_type: string; storage_id: string; is_primary: boolean; amount: string; last_transaction_timestamp: string; last_transaction_version: string }

const BALANCES_QUERY = `query($o:String!,$after:String!){ current_fungible_asset_balances(where:{owner_address:{_eq:$o}, amount:{_gt:"0"},
  storage_id:{_gt:$after}}, order_by:{storage_id:asc}, limit:100){ asset_type storage_id is_primary amount last_transaction_timestamp last_transaction_version } }`;

/** A balance row's asset: a fungible asset's address at full length; a Coin's type as filed. */
export const assetId = (assetType: string) => (assetType.includes('::') ? assetType : normalizeAddress(assetType));

/** Every non-empty fungible-asset store the owner holds (Coin stores are filed under their coin type). */
export const ownedBalances = (ctx: ReadContext, owner: string) => once(ctx, `owned-balances:${owner}:${ctx.ledger.version}`, () =>
  gqlAll<OwnedBalance>(ctx.chain, BALANCES_QUERY, { o: owner }, 'current_fungible_asset_balances', 'storage_id'));

const TOKENS_QUERY = `query($o:String!,$c:[String!]!,$after:String!){ current_token_ownerships_v2(where:{owner_address:{_eq:$o}, amount:{_gt:"0"},
  current_token_data:{collection_id:{_in:$c}}, token_data_id:{_gt:$after}}, order_by:{token_data_id:asc}, limit:100){ token_data_id current_token_data{ collection_id } } }`;

/** The owner's tokens in the collections sources read (Amnis withdrawal tickets, Merkle veMKL locks, Auro positions). */
export const ownedTokens = (ctx: ReadContext, owner: string) => once(ctx, `owned-tokens:${owner}:${ctx.ledger.version}`, async () =>
  (await gqlAll(ctx.chain, TOKENS_QUERY, { o: owner, c: [AMNIS_WITHDRAWAL_COLLECTION, VEMKL_COLLECTION, AURO_COLLECTION] }, 'current_token_ownerships_v2', 'token_data_id'))
    .map((t: any) => ({ token: normalizeAddress(t.token_data_id), collection: normalizeAddress(t.current_token_data.collection_id) })));

/** The owner's tokens in one collection. */
export const ownedIn = async (ctx: ReadContext, owner: string, collection: string) =>
  (await ownedTokens(ctx, owner)).filter(t => t.collection === normalizeAddress(collection)).map(t => t.token);

const DELEGATIONS_QUERY = `query($d:String!,$after:String!){ current_delegator_balances(where:{delegator_address:{_eq:$d}, shares:{_gt:"0"},
  pool_address:{_gt:$after}}, order_by:[{pool_address:asc},{pool_type:asc}], limit:100){ pool_address pool_type } }`;

/** The owner's delegation pool shares (`active_shares`, `inactive_shares`), one row per pool and type. Indexer rows go
 *  stale (a redeemed entry can stay indexed), so they only name candidate pools. */
export const ownedDelegations = (ctx: ReadContext, owner: string) => once(ctx, `owned-delegations:${owner}:${ctx.ledger.version}`, async () => {
  const out: { pool: string; type: string }[] = [];
  let after = '';
  for (;;) {
    const rows: { pool_address: string; pool_type: string }[] = (await ctx.chain.gql(DELEGATIONS_QUERY, { d: owner, after })).current_delegator_balances;
    // A pool's rows (one per type) can straddle a full page's end: keep whole pools and resume after the last of them.
    const whole = rows.length < 100 ? rows : rows.filter(r => r.pool_address !== rows[rows.length - 1].pool_address);
    out.push(...whole.map(r => ({ pool: normalizeAddress(r.pool_address), type: r.pool_type })));
    if (rows.length < 100) return out;
    if (!whole.length) throw new Error('a delegations page holds a single pool');
    after = whole[whole.length - 1].pool_address;
  }
});

/** The pools the owner holds shares of a given type in. */
export const ownedPools = async (ctx: ReadContext, owner: string, type: 'active_shares' | 'inactive_shares') =>
  [...new Set((await ownedDelegations(ctx, owner)).filter(d => d.type === type).map(d => d.pool))];
