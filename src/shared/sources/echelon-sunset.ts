// Echelon (Aptos) lending markets for bridge-wrapped assets that Echelon sunset. Echelon froze them (collateral factor
// 0 and borrow cap 0: no new borrowing, no use as collateral) on 2025-05-03 (lzUSDC, lzUSDT, Wormhole USDC) and
// 2025-05-17 (Wormhole WETH), as native USDC and USDT replaced the bridged ones. Lenders who never withdrew still hold
// supply there. Only markets with sunset evidence count (issue #10, option (a)); other frozen markets do not.
// A supply position in a frozen market is not collateral (factor 0), so withdrawing does not touch any debt.
import { iso, positionIds } from '../accounting.ts';
import { mapLimit, normalizeAddress, once } from '../chain.ts';
import type { Position, ReadContext, ReadResult, SourceDef } from '../types.ts';
import { LZ_BRIDGE } from './layerzero-claimable.ts';

export const ECHELON = '0xc6bc659f1649553c1a3fa05d9727433dc03843baac29473c817d06d39e7621ba';
export const WH_USDC = '0x5e156f1207d0ebfa19a9eeff00d62a282278fb8719f4fab3a586a0a2c0fffbea::coin::T';
export const WH_WETH = '0xcc8a89c8dce9693d354449f1f73e60e14e347417854f029db5bc8e7454008abb::coin::T';
const SOURCE = 'echelon-sunset-markets';

/** The sunset markets, with the time Echelon froze each (the admin transaction that set it to factor 0 / cap 0). */
export const SUNSET_MARKETS = [
  { label: 'lzUSDC', market: '0xa9c51ca3bcd93978d0c4aada7c4cf47c0791caced3cdc4e15f2c8e0797d1f93c', asset: `${LZ_BRIDGE}::asset::USDC`, frozenAt: '2025-05-03T04:56:05Z' },
  { label: 'lzUSDT', market: '0x447b3b516546f28e8c4f6825a6287b09161659e7c500c599c29c28a8492844b8', asset: `${LZ_BRIDGE}::asset::USDT`, frozenAt: '2025-05-03T04:56:11Z' },
  { label: 'whUSDC', market: '0xa76ebfb432982c864783fdb33cdf5a9edb18ac1b950deb8037f5cf8c984da3d2', asset: WH_USDC, frozenAt: '2025-05-03T04:56:16Z' },
  { label: 'whWETH', market: '0x114ee519ffa1e8697784bd1a350822cb37601a1476289051b8295165597a4538', asset: WH_WETH, frozenAt: '2025-05-17T03:22:06Z' },
];

/** A market's state: still frozen (a market Echelon reopened is live again and does not count), its cash (what
 *  lenders can take out now) and its supply value (cash + borrows - reserve: what all lenders are owed). */
function marketState(ctx: ReadContext, market: string): Promise<{ frozen: boolean; cash: bigint; supply: bigint }> {
  return once(ctx, `echelon-market:${market}:${ctx.ledger.version}`, async () => {
    const m = await ctx.chain.resource(market, `${ECHELON}::lending::Market`, ctx.ledger.version);
    if (!m) throw new Error(`Echelon market ${market} missing`);
    return { frozen: m.collateral_factor_bps === '0' && m.borrow_cap === '0', cash: BigInt(m.total_cash),
      supply: BigInt(m.total_cash) + BigInt(m.total_liability) - BigInt(m.total_reserve) };
  });
}

async function read(ctx: ReadContext, ownerInput: string): Promise<ReadResult> {
  const owner = normalizeAddress(ownerInput);
  const version = ctx.ledger.version;
  try {
    const vault = await ctx.chain.resource(owner, `${ECHELON}::lending::Vault`, version);
    const held = new Set<string>((vault?.collaterals?.data ?? []).filter((e: any) => BigInt(e.value) > 0n).map((e: any) => normalizeAddress(e.key.inner)));
    const markets = SUNSET_MARKETS.filter(m => held.has(m.market));
    const found = await mapLimit(markets, 2, async (m): Promise<Position | null> => {
      const market = await marketState(ctx, m.market);
      if (!market.frozen) return null;
      const [[coins], [allowed]] = await Promise.all([
        ctx.chain.view(`${ECHELON}::lending::account_coins`, [owner, m.market], [], version),
        ctx.chain.view(`${ECHELON}::lending::account_withdrawable_coins`, [owner, m.market], [], version),
      ]);
      if (BigInt(coins) === 0n) return null;
      // account_withdrawable_coins is a health limit (u64::MAX without debt), not a cash limit. The cash is shared by all
      // lenders, so each is counted for its pro-rata share of it (coins x cash / supply) when the market is short: the
      // payouts of all lenders together never exceed the cash. The rest waits on borrowers.
      const share = market.cash >= market.supply || market.supply === 0n ? BigInt(coins) : BigInt(coins) * market.cash / market.supply;
      const withdrawable = [BigInt(coins), BigInt(allowed), share].reduce((a, b) => (b < a ? b : a));
      const gross = [{ asset: m.asset, raw: String(coins) }];
      const payout = withdrawable > 0n ? [{ asset: m.asset, raw: withdrawable.toString() }] : [];
      return {
        ...positionIds(SOURCE, owner, m.label, 'principal', m.asset), source: SOURCE, owner, locator: m.label, positionKind: 'principal', asset: m.asset,
        claimableSince: m.frozenAt, ageBasis: 'protocol_closure',
        provenance: { reader: `${ECHELON}::lending::account_coins`, ledgerVersion: version },
        grossClaim: gross, expectedPayout: payout, payoutBasis: 'view',
        status: payout.length ? 'recoverable' : 'blocked',
        blockers: payout.length ? [] : [{ code: 'insufficient_cash', detail: 'The market has no cash to pay this out until borrowers repay.' }],
        confidence: 'verified_view', observedAt: iso(ctx.ledger.timestampSecs),
        steps: [{ function: `${ECHELON}::scripts::withdraw_all<${m.asset}>`, arguments: [m.market], prerequisites: [], expectedOutputs: payout }],
      };
    });
    return { positions: found.filter((p): p is Position => p !== null), complete: true, errors: [], ledgerVersion: version };
  } catch (err) {
    return { positions: [], complete: false, errors: [String(err).slice(0, 300)], ledgerVersion: version };
  }
}

export const echelonSunsetMarkets: SourceDef = {
  id: SOURCE,
  chain: 'aptos',
  protocol: 'Echelon',
  title: 'Echelon supply left in sunset bridged-asset markets',
  summary: 'Echelon sunset its lending markets for bridged USDC, USDT and WETH (LayerZero and Wormhole) in May 2025. Supply you never withdrew from them still sits there, earning next to nothing.',
  category: 'closed_app',
  inclusionRule: 'R2 protocol closure: Echelon froze these markets (collateral factor 0, borrow cap 0) when it sunset bridge-wrapped assets; the freeze is the effective date.',
  protocolStatus: {
    state: 'deprecated',
    evidence: 'Aptos Foundation: Echelon "helped sunset bridge-wrapped assets". On chain, admin transactions set the four markets to collateral factor 0 and borrow cap 0 on 2025-05-03 and 2025-05-17; still frozen on 2026-10-20.',
    checkedAt: '2026-10-20',
    effectiveAt: '2025-05-03T04:56:05Z',
  },
  refresh: { nonZero: 'monthly', zero: 'never' },
  headlineAgeBases: ['protocol_closure'],
  howTo: [
    'Withdraw in the Echelon app (Aptos; the market may be listed as deprecated), or',
    `call ${ECHELON}::scripts::withdraw_all<coin type>(market) from the supplying account.`,
  ],
  officialUrl: 'https://app.echelon.market',
  read,
};
