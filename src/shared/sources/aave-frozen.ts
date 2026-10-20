// Aave v3 on Aptos: supply left in reserves that Aave froze. An Aave governance proposal (ARFC, filed 2026-07-29) winds
// down the Aptos deployment by freezing every reserve. On 2026-10-20 none is frozen yet, so this source counts nothing
// until one is (decided 2026-10-20): each run first reads the reserve flags. A frozen reserve takes no new supply or
// borrows, but lenders can still withdraw. Same rules as Echelon's frozen markets: a supplier with any Aave debt counts
// for nothing (R4), and each lender is counted for its pro-rata share of the reserve's cash.
import { iso, positionIds } from '../accounting.ts';
import { mapLimit, normalizeAddress, once, transactionTime } from '../chain.ts';
import type { Position, ReadContext, ReadResult, SourceDef } from '../types.ts';
import { APT } from './delegation.ts';

export const AAVE = '0x39ddcd9e1a39fa14f25e3f9ec8a86074d05cc0881cbf667df8a6ee70942016fb';
const SOURCE = 'aave-frozen-reserves';
export const USDT = '0x357b0b74bc833e95a115ad22604854d6b0fca151cecd94111770e5d6ffc9dc2b';
export const USDC = '0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b';
export const SUSDE = '0xb30a694a344edee467d9f82330bbe7c3b89f440a1ecd2da1f3bca266560fce69';
/** Every reserve was live (not frozen) at this version (2026-10-20); a freeze is searched for after it. */
export const AAVE_UNFROZEN_AT = 7_694_000_000n;
/** withdraw(asset, u256::MAX, to) withdraws the whole balance (simulated on a live reserve: paid exactly balance_of). */
const WITHDRAW_ALL = (2n ** 256n - 1n).toString();
/** Bit 57 of a reserve's configuration bitmap is its frozen flag (Aave v3 layout; bit 56 active, bit 60 paused). */
const FROZEN_BIT = 57n;

export interface AaveReserve {
  asset: string;
  symbol: string;
  /** What a withdrawal pays: the underlying fungible asset, or the APT coin for the APT reserve (0xa is its paired FA). */
  payoutAsset: string;
  aToken: string;
  debtToken: string;
  frozen: boolean;
  active: boolean;
  paused: boolean;
  /** Underlying held by the reserve: what lenders can take out now. */
  cash: bigint;
}

/** The reserves and their flags at the run's ledger version (one view, shared by every read in a run). */
export function aaveReserves(ctx: ReadContext): Promise<AaveReserve[]> {
  return once(ctx, `aave-reserves:${ctx.ledger.version}`, async () => {
    const [reserves] = await ctx.chain.view(`${AAVE}::ui_pool_data_provider_v3::get_reserves_data`, [], [], ctx.ledger.version);
    return (reserves as any[]).map(r => {
      const asset = normalizeAddress(r.underlying_asset);
      return { asset, symbol: r.symbol, payoutAsset: asset === normalizeAddress('0xa') ? APT : asset,
        aToken: normalizeAddress(r.a_token_address), debtToken: normalizeAddress(r.variable_debt_token_address),
        frozen: r.is_frozen, active: r.is_active, paused: r.is_paused, cash: BigInt(r.available_liquidity) };
    });
  });
}

/** What all lenders of a reserve are owed now (the aToken's total supply, interest included). */
function lentOut(ctx: ReadContext, r: AaveReserve): Promise<bigint> {
  return once(ctx, `aave-supply:${r.asset}:${ctx.ledger.version}`, async () =>
    BigInt((await ctx.chain.view(`${AAVE}::pool_data_provider::get_a_token_total_supply`, [r.asset], [], ctx.ledger.version))[0]));
}

/** When a reserve froze: the first version whose configuration has the frozen bit, by binary search on the archive node
 *  from AAVE_UNFROZEN_AT, and that transaction's time. Memoized. Undefined when it cannot be dated (then the age is
 *  unknown). Assumes a reserve stays frozen once frozen, as the wind-down intends. */
async function frozenSince(ctx: ReadContext, r: AaveReserve): Promise<string | undefined> {
  const key = `${SOURCE}:frozen-since:${r.asset}`;
  const cached = await ctx.memo.get(key);
  if (cached) return cached;
  return once(ctx, key, async () => {
    const [reserve] = await ctx.chain.view(`${AAVE}::pool::get_reserve_data`, [r.asset], [], ctx.ledger.version);
    const frozenAt = async (version: bigint) => {
      const data = await ctx.chain.archiveResource(reserve.inner, `${AAVE}::pool::ReserveData`, version.toString());
      if (!data) throw new Error(`Aave reserve data for ${r.symbol} missing at version ${version}`);
      return ((BigInt(data.configuration.data) >> FROZEN_BIT) & 1n) === 1n;
    };
    // A failed search leaves the age unknown for this run (the amounts still count) and is retried next run.
    try {
      let lo = AAVE_UNFROZEN_AT, hi = BigInt(ctx.ledger.version);
      if (await frozenAt(lo)) return undefined;
      while (hi - lo > 1n) {
        const mid = (lo + hi) / 2n;
        if (await frozenAt(mid)) hi = mid; else lo = mid;
      }
      const secs = await transactionTime(ctx.chain, hi.toString());
      if (secs === null) return undefined;
      await ctx.memo.set(key, iso(secs));
      return iso(secs);
    } catch {
      return undefined;
    }
  });
}

async function read(ctx: ReadContext, ownerInput: string): Promise<ReadResult> {
  const owner = normalizeAddress(ownerInput);
  const version = ctx.ledger.version;
  const none: ReadResult = { positions: [], complete: true, errors: [], ledgerVersion: version };
  try {
    const frozen = (await aaveReserves(ctx)).filter(r => r.frozen);
    if (!frozen.length) return none;
    // Total debt in the base currency: any debt makes the supplier a live borrower.
    const [, debt] = await ctx.chain.view(`${AAVE}::user_logic::get_user_account_data`, [owner], [], version);
    if (BigInt(debt) > 0n) return none;
    const found = await mapLimit(frozen, 2, async (r): Promise<Position[]> => {
      const coins = BigInt((await ctx.chain.view(`${AAVE}::a_token_factory::balance_of`, [owner, r.aToken], [], version))[0]);
      if (coins === 0n) return [];
      // The cash is shared by all lenders, so each is counted for its pro-rata share of it when the reserve is short; a
      // share that rounds to nothing is not a position.
      const supply = await lentOut(ctx, r);
      const withdrawable = r.cash >= supply || supply === 0n ? coins : coins * r.cash / supply;
      if (withdrawable === 0n && r.cash > 0n) return [];
      const since = await frozenSince(ctx, r);
      const gross = [{ asset: r.payoutAsset, raw: coins.toString() }];
      const payout = withdrawable > 0n ? [{ asset: r.payoutAsset, raw: withdrawable.toString() }] : [];
      const blockers = [
        ...(r.active ? [] : [{ code: 'inactive', detail: `Aave deactivated the ${r.symbol} reserve: withdrawals are disabled.` }]),
        ...(r.paused ? [{ code: 'paused', detail: `Aave paused the ${r.symbol} reserve: withdrawals are disabled until it is unpaused.` }] : []),
        ...(payout.length ? [] : [{ code: 'insufficient_cash', detail: 'The reserve has no cash to pay this out until borrowers repay.' }]),
      ];
      return [{
        ...positionIds(SOURCE, owner, r.symbol, 'principal', r.payoutAsset), source: SOURCE, owner, locator: r.symbol, positionKind: 'principal',
        asset: r.payoutAsset, claimableSince: since, ageBasis: since ? 'protocol_closure' : 'unknown',
        provenance: { reader: `${AAVE}::a_token_factory::balance_of`, ledgerVersion: version },
        grossClaim: gross, expectedPayout: payout, payoutBasis: 'view',
        status: blockers.length ? 'blocked' : 'recoverable', blockers,
        confidence: 'verified_view', observedAt: iso(ctx.ledger.timestampSecs),
        // The whole balance while the cash covers it: that is what the step pays (the position counts only the pro-rata
        // share). Otherwise the pro-rata amount; the whole balance would abort.
        steps: [coins <= r.cash
          ? { function: `${AAVE}::supply_logic::withdraw`, arguments: [r.asset, WITHDRAW_ALL, owner], prerequisites: [], expectedOutputs: gross }
          : { function: `${AAVE}::supply_logic::withdraw`, arguments: [r.asset, withdrawable.toString(), owner], prerequisites: [], expectedOutputs: payout }],
      }];
    });
    return { positions: found.flat(), complete: true, errors: [], ledgerVersion: version };
  } catch (err) {
    return { positions: [], complete: false, errors: [String(err).slice(0, 300)], ledgerVersion: version };
  }
}

export const aaveFrozenReserves: SourceDef = {
  id: SOURCE,
  chain: 'aptos',
  protocol: 'Aave',
  title: 'Aave supply left in frozen reserves',
  summary: 'Aave is winding down its Aptos markets by freezing every reserve. Supply left in a frozen reserve waits on the wind-down. Nothing is frozen yet, so this counts nothing until it is. Counted only for suppliers without Aave debt.',
  category: 'closed_app',
  inclusionRule: 'R2: Aave froze the reserve under its Aptos wind-down (ARFC, 2026-07-29); the freeze is the effective date. R4: suppliers with any Aave debt are left out. Decided 2026-10-20; counts nothing while no reserve is frozen.',
  protocolStatus: {
    state: 'deprecated',
    evidence: 'Aave governance ARFC (2026-07-29) winds down the Aptos deployment by freezing every reserve. On 2026-10-20 all 4 reserves (USDt, APT, sUSDe, USDC) are still live.',
    checkedAt: '2026-10-20',
  },
  refresh: { nonZero: 'monthly', zero: 'never' },
  headlineAgeBases: ['protocol_closure'],
  howTo: [
    'Withdraw in the Aave app (Aptos market), or',
    `call ${AAVE}::supply_logic::withdraw(asset, amount, your address) from the supplying account; an amount of 2^256 - 1 withdraws everything.`,
  ],
  officialUrl: 'https://app.aave.com',
  read,
};
