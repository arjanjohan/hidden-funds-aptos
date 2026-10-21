// AnimeSwap (Aptos AMM): liquidity left in AnimeSwap V1 pools after its frontend went away. animeswap.org and
// app.animeswap.org no longer resolve (2026-10-21) and no notice was found, so it is closed under the closed-frontend
// rule from that day. The pools still work (aggregators still route swaps through them), so an LP holder can remove
// liquidity directly. LP is a Coin (`LPCoinV1::LPCoin<X, Y>`), held in a CoinStore or its paired fungible-asset store.
import { iso, positionIds } from '../accounting.ts';
import { gqlAll, mapLimit, normalizeAddress, once } from '../chain.ts';
import type { Amount, ChainReader, Position, ReadContext, ReadResult, SourceDef } from '../types.ts';
import { APT } from './delegation.ts';

export const ANIMESWAP = '0x16fe2df00ea7dde4a63409201f7f4e536bde7bb7335526a35d05111e68aa322c';
/** The resource account holding every pool and publishing the LP coin module. */
export const ANIMESWAP_POOLS = '0x796900ebe1a1a54ff9e932f19c548f5c1af5c6e7d34965857ac2f7b1d1ab2cbf';
export const ANIMESWAP_LP_PREFIX = `${ANIMESWAP_POOLS}::LPCoinV1::LPCoin<`;
/** End of the day both domains were found without an address record (no notice found; the archived app was served
 *  until at least 2026-08). */
export const ANIMESWAP_CLOSED_AT = '2026-10-21T23:59:59Z';
/** Minimum outputs in the removal step: 1% below the computed payout, against reserve moves before it lands. */
const SLIPPAGE_BPS = 100n;
const SOURCE = 'animeswap-closed-lp';

/** Enumeration hint: each LP coin type the owner holds, with the time its store last changed (indexer). */
export type AnimeswapHint = { lps: Record<string, string> };

/** `LPCoin<X, Y>` → [X, Y], splitting on the top-level comma (pool coins can be generic themselves). */
export function pairOf(lp: string): [string, string] {
  const inner = lp.slice(lp.indexOf('<') + 1, -1);
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '<') depth++;
    else if (inner[i] === '>') depth--;
    else if (inner[i] === ',' && depth === 0) return [inner.slice(0, i).trim(), inner.slice(i + 1).trim()];
  }
  throw new Error(`Not an AnimeSwap LP type: ${lp}`);
}

const utf8 = (hex: string) => new TextDecoder().decode(Uint8Array.from(hex.slice(2).match(/../g) ?? [], h => parseInt(h, 16)));

/** Every pool's LP coin type, from the pair registry (`PairInfo.pair_list`, hex-encoded `TypeInfo`s). The names keep the
 *  chain's own rendering, which is how the indexer files them. */
export async function animeswapLps(chain: ChainReader, version?: string): Promise<string[]> {
  const info = await chain.resource(ANIMESWAP_POOLS, `${ANIMESWAP}::AnimeSwapPoolV1::PairInfo`, version);
  if (!info) throw new Error('AnimeSwap PairInfo missing');
  return info.pair_list.map((p: any) => `${p.lp_coin.account_address}::${utf8(p.lp_coin.module_name)}::${utf8(p.lp_coin.struct_name)}`);
}

/** A pool coin's asset id (APT is keyed by its fungible-asset address). */
export const assetOf = (coin: string) => (coin === '0x1::aptos_coin::AptosCoin' ? APT : coin);

/** Integer square root, rounded down (the contract's Babylonian `sqrt_128`). */
export function isqrt(y: bigint): bigint {
  if (y < 4n) return y === 0n ? 0n : 1n;
  let z = y, x = y / 2n + 1n;
  while (x < z) { z = x; x = (y / x + x) / 2n; }
  return z;
}

interface Pool { reserveX: bigint; reserveY: bigint; supply: bigint; kLast: bigint; locked: boolean }

/** What removing `liquidity` pays, as `burn` computes it: the DAO's fee is first minted in LP (when √k grew since the
 *  last mint), then each side pays `liquidity × reserve / supply`, rounded down. */
export function removal(pool: Pool, liquidity: bigint, admin: { feeOn: boolean; daoFee: bigint }): [bigint, bigint] {
  let supply = pool.supply;
  if (admin.feeOn && pool.kLast !== 0n) {
    const rootK = isqrt(pool.reserveX * pool.reserveY), rootKLast = isqrt(pool.kLast);
    if (rootK > rootKLast) supply += supply * (rootK - rootKLast) / (rootK * admin.daoFee + rootKLast);
  }
  return [liquidity * pool.reserveX / supply, liquidity * pool.reserveY / supply];
}

const admin = (ctx: ReadContext) => once(ctx, `animeswap-admin:${ctx.ledger.version}`, async () => {
  const data = await ctx.chain.resource(ANIMESWAP_POOLS, `${ANIMESWAP}::AnimeSwapPoolV1::AdminData`, ctx.ledger.version);
  if (!data) throw new Error('AnimeSwap AdminData missing');
  return { feeOn: !!data.dao_fee_on, daoFee: BigInt(data.dao_fee) };
});

const pool = (ctx: ReadContext, lp: string) => once<Pool>(ctx, `animeswap-pool:${lp}:${ctx.ledger.version}`, async () => {
  const [x, y] = pairOf(lp);
  const version = ctx.ledger.version;
  const [state, [supply]] = await Promise.all([
    ctx.chain.resource(ANIMESWAP_POOLS, `${ANIMESWAP}::AnimeSwapPoolV1::LiquidityPool<${x}, ${y}>`, version),
    // coin::supply counts the Coin and its paired fungible asset; CoinInfo alone misses LP that migrated.
    ctx.chain.view('0x1::coin::supply', [], [lp], version),
  ]);
  if (!state || !supply?.vec?.length) throw new Error(`AnimeSwap pool ${lp} missing`);
  return { reserveX: BigInt(state.coin_x_reserve.value), reserveY: BigInt(state.coin_y_reserve.value), supply: BigInt(supply.vec[0]),
    locked: !!state.locked, kLast: BigInt(state.k_last) };
});

const LPS_QUERY = `query($o:String!,$p:String!,$after:String!){ current_fungible_asset_balances(where:{owner_address:{_eq:$o},
  asset_type:{_like:$p}, amount:{_gt:"0"}, storage_id:{_gt:$after}}, order_by:{storage_id:asc}, limit:100){ asset_type storage_id last_transaction_timestamp } }`;

/** The owner's LP coin types and when each store last changed, from the indexer (the check page has no hint). The
 *  indexer files a migrated store under its coin type too. */
async function lpsOf(ctx: ReadContext, owner: string): Promise<Record<string, string>> {
  const rows = await gqlAll(ctx.chain, LPS_QUERY, { o: owner, p: `${ANIMESWAP_LP_PREFIX}%` }, 'current_fungible_asset_balances', 'storage_id');
  const lps: Record<string, string> = {};
  for (const r of rows) {
    const at = new Date(r.last_transaction_timestamp + 'Z').toISOString();
    if (!lps[r.asset_type] || at > lps[r.asset_type]) lps[r.asset_type] = at;
  }
  return lps;
}

async function read(ctx: ReadContext, ownerInput: string, hint?: AnimeswapHint): Promise<ReadResult> {
  const owner = normalizeAddress(ownerInput);
  const version = ctx.ledger.version;
  const errors: string[] = [];
  let failed = 0;
  const lps = hint?.lps ?? await lpsOf(ctx, owner);
  const found = await mapLimit(Object.entries(lps), 4, async ([lp, changedAt]): Promise<Position[]> => {
    try {
      const [[held], p, a] = await Promise.all([
        // coin::balance covers both the CoinStore and the paired fungible-asset store.
        ctx.chain.view('0x1::coin::balance', [owner], [lp], version), pool(ctx, lp), admin(ctx)]);
      const liquidity = BigInt(held);
      if (liquidity === 0n) return [];
      const [x, y] = pairOf(lp);
      const [ax, ay] = removal(p, liquidity, a);
      // The pool keeps working, so LP added or received after the shutdown is aged from that change.
      const since = Date.parse(changedAt) > Date.parse(ANIMESWAP_CLOSED_AT) ? changedAt : ANIMESWAP_CLOSED_AT;
      const blockers = [
        ...(p.locked ? [{ code: 'paused', detail: 'The pool is locked.' }] : []),
        // burn aborts when either side rounds to zero (ERR_INSUFFICIENT_LIQUIDITY_BURN).
        ...(ax === 0n || ay === 0n ? [{ code: 'below_minimum', detail: 'Too little LP: removal aborts when either side rounds to zero.' }] : []),
      ];
      const outputs: Amount[] = [{ asset: assetOf(x), raw: ax.toString() }, { asset: assetOf(y), raw: ay.toString() }];
      const step = { function: `${ANIMESWAP}::AnimeSwapPoolV1::remove_liquidity_entry<${x}, ${y}>`,
        arguments: [liquidity.toString(), (ax * (10_000n - SLIPPAGE_BPS) / 10_000n).toString(), (ay * (10_000n - SLIPPAGE_BPS) / 10_000n).toString()],
        prerequisites: [], expectedOutputs: outputs };
      // One position per side, so a priced side still counts when the other coin has no price; one removal pays both.
      return outputs.filter(o => o.raw !== '0').map((o): Position => ({
        ...positionIds(SOURCE, owner, lp, 'principal', o.asset), source: SOURCE, owner, locator: lp, positionKind: 'principal', asset: o.asset,
        claimableSince: since, ageBasis: 'protocol_closure',
        provenance: { reader: '0x1::coin::balance', ledgerVersion: version },
        grossClaim: [o], expectedPayout: blockers.length ? [] : [o], payoutBasis: 'derived',
        status: blockers.length ? 'blocked' : 'recoverable', blockers,
        confidence: 'verified_view', observedAt: iso(ctx.ledger.timestampSecs), steps: [step],
      }));
    } catch (err) {
      failed++;
      errors.push(`${lp}: ${String(err).slice(0, 200)}`);
      return [];
    }
  });
  return { positions: found.flat(), complete: failed === 0, errors, ledgerVersion: version };
}

export const animeswapClosedLp: SourceDef<AnimeswapHint> = {
  id: SOURCE,
  chain: 'aptos',
  protocol: 'AnimeSwap',
  title: 'AnimeSwap liquidity left after its frontend went away',
  summary: 'AnimeSwap\'s website is gone, but its pools still work. Liquidity left in them can still be removed directly.',
  category: 'closed_app',
  inclusionRule: 'R2: frontend gone (animeswap.org and app.animeswap.org have no address record, 2026-10-21; no notice found), closed under the closed-frontend rule (decided 2026-10-21). R4: an AMM position carries no debt.',
  protocolStatus: {
    state: 'closed',
    evidence: 'animeswap.org and app.animeswap.org have no address record (2026-10-21), though the domain was renewed on 2026-09-24; the archived app was served until at least 2026-08. DefiLlama marks AnimeSwap dead. No closure notice found.',
    checkedAt: '2026-10-21',
    effectiveAt: ANIMESWAP_CLOSED_AT,
  },
  // Swaps (aggregators still route through the pools) move every holder's payout without changing their LP.
  refresh: { nonZero: 'every_run', zero: 'monthly' },
  headlineAgeBases: ['protocol_closure'],
  howTo: [
    `Call ${ANIMESWAP}::AnimeSwapPoolV1::remove_liquidity_entry<X, Y>(liquidity, minimum X, minimum Y) from the account holding the LP, with the pool's coin types in the LP type's order.`,
  ],
  read,
};
