// Echelon (Aptos) lending markets that Echelon froze: collateral factor 0 and borrow cap 0, so no new borrowing and no
// use as collateral. Lenders' supply sits there earning little or nothing and waits on a wind-down at Echelon's
// discretion. Every frozen market counts (decision 2026-10-20, issue #10, option (b)), aged from its freeze. The bridged
// ones (lzUSDC, lzUSDT, Wormhole USDC and WETH) were sunset as native USDC and USDT replaced them.
// A supplier with any Echelon debt is a live borrower and none of its supply counts (R4, decided 2026-10-20): frozen
// markets can still be collateral in an efficiency mode (e.g. stAPT and sthAPT behind leveraged APT borrows).
import { iso, positionIds } from '../accounting.ts';
import { mapLimit, normalizeAddress, once } from '../chain.ts';
import type { Position, ReadContext, ReadResult, SourceDef } from '../types.ts';
import { THL } from './thala-thl.ts';

export const ECHELON = '0xc6bc659f1649553c1a3fa05d9727433dc03843baac29473c817d06d39e7621ba';
export const WH_USDC = '0x5e156f1207d0ebfa19a9eeff00d62a282278fb8719f4fab3a586a0a2c0fffbea::coin::T';
export const MOD = '0x6f986d146e4a90b828d8c12c14b6f4e003fdff11a8eecceceb63744363eaac01::mod_coin::MOD';
export const STAPT = '0x111ae3e5bc816a5e63c2da97d0aa3886519e0cd5e4b046659fa35796bd11542a::stapt_token::StakedApt';
export const STHAPT = '0xfaf4e633ae9eb31366c9ca24214231760926576c7b625313b3688b5e900731f6::staking::StakedThalaAPT';
/** The paired fungible asset of Amnis' amAPT coin (0x1::coin::paired_metadata), the same asset as the coin. */
export const AMAPT_FA = '0xa259be733b6a759909f92815927fa213904df6540519568692caf0b068fe8e62';
const SOURCE = 'echelon-frozen-markets';

/** Every market frozen on 2026-10-20, with the time it froze: the first of Echelon's collateral-factor / borrow-cap admin
 *  transactions from which the market is frozen (found on the archive node). A market created frozen dates from the
 *  first admin transaction after its creation, never earlier than the truth. `coin`: a Coin market (withdraw_all<T>);
 *  otherwise a fungible-asset market (withdraw_all_fa). */
export const FROZEN_MARKETS = [
  { label: 'lzUSDT', market: '0x447b3b516546f28e8c4f6825a6287b09161659e7c500c599c29c28a8492844b8', asset: '0xf22bede237a07e121b56d91a491eb7bcdfd1f5907926a9e58338f964a01b17fa::asset::USDT', coin: true, decimals: 6, frozenAt: '2025-05-03T04:56:11Z' },
  { label: 'lzUSDC', market: '0xa9c51ca3bcd93978d0c4aada7c4cf47c0791caced3cdc4e15f2c8e0797d1f93c', asset: '0xf22bede237a07e121b56d91a491eb7bcdfd1f5907926a9e58338f964a01b17fa::asset::USDC', coin: true, decimals: 6, frozenAt: '2025-05-03T04:56:05Z' },
  { label: 'MOD', market: '0xef2ae89796725d0eb363326ecb7df159feb949f6d1f400f76deeeebccbac00f1', asset: MOD, coin: true, decimals: 8, frozenAt: '2025-09-03T04:44:52Z' },
  { label: 'THL', market: '0x127ea5b4c450be695e488da1c3bc013e2e93d8cf00270ef90385189844bc9755', asset: THL, coin: true, decimals: 8, frozenAt: '2025-09-26T16:44:00Z' },
  { label: 'sthAPT', market: '0xed6bf9fe7e3f42c6831ffac91824a545c4b8bfcb40a59b3f4ccfe203cafb7f42', asset: STHAPT, coin: true, decimals: 8, frozenAt: '2026-04-09T17:25:06Z' },
  { label: 'whUSDC', market: '0xa76ebfb432982c864783fdb33cdf5a9edb18ac1b950deb8037f5cf8c984da3d2', asset: WH_USDC, coin: true, decimals: 6, frozenAt: '2025-05-03T04:56:16Z' },
  { label: 'whWETH', market: '0x114ee519ffa1e8697784bd1a350822cb37601a1476289051b8295165597a4538', asset: '0xcc8a89c8dce9693d354449f1f73e60e14e347417854f029db5bc8e7454008abb::coin::T', coin: true, decimals: 8, frozenAt: '2025-05-17T03:22:06Z' },
  { label: 'CAKE', market: '0x41b039e5518b1a3786ee798d895e0ddf3141fbbc20009284323fa51ea279c819', asset: '0x159df6b7689437016108a019fd5bef736bac692b6d4a1f10c941f6fbb9a74ca6::oft::CakeOFT', coin: true, decimals: 8, frozenAt: '2025-09-26T16:43:54Z' },
  { label: 'stAPT', market: '0xc3c9cc885a52004e0490f6a8291b3bc5854f0e42d931fb124736bd189c9f0f45', asset: STAPT, coin: true, decimals: 8, frozenAt: '2025-11-21T05:11:42Z' },
  { label: 'aBTC', market: '0xacb7262b33a147b47b950a3a26d7699e1a58bcaa475ef636cb0fea53fa0eb872', asset: '0x4e1854f6d332c9525e258fb6e66f84b6af8aba687bbcb832a24768c4e175feec::abtc::ABTC', coin: true, decimals: 10, frozenAt: '2025-10-15T21:40:44Z' },
  { label: 'STONE', market: '0x75c39f18c7bc00ac0f81a0f9ab7e319e23790d7d8c3df968d84a23699584bd9', asset: '0x543c5660aa4d496687e2068c11765f04607c4f4b639a83233a9333604fb8ce59::stakestone_ether::StakeStoneEther', coin: true, decimals: 8, frozenAt: '2025-05-17T03:23:08Z' },
  { label: 'truAPT', market: '0x7bd5be03df0fb3841fed337b8e7a353818b917cce6db28b807b691002a122d73', asset: '0xaef6a8c3182e076db72d64324617114cacf9a52f28325edc10b483f7f05da0e7', coin: false, decimals: 8, frozenAt: '2025-11-10T04:02:53Z' },
  { label: 'SBTC', market: '0x754114c656e26498a8c0b20fa24af663fed5e4b24acb471c103daea0f7006b40', asset: '0x5dee1d4b13fae338a1e1780f9ad2709a010e824388efd169171a26e3ea9029bb::stakestone_bitcoin::StakeStoneBitcoin', coin: true, decimals: 8, frozenAt: '2025-07-26T00:13:05Z' },
  { label: 'thLPT-1', market: '0x36e776a1d1c44ad7b80469c6eaa4bf2f186fe13aa4fa20f799d97c0264cb4ad8', asset: '0x335b730acf9259669924b1a703a710ef335e0bc90794d92de5e876bf0de70672', coin: false, decimals: 8, frozenAt: '2025-09-03T22:46:14Z' },
  { label: 'thLPT-2', market: '0x9c22785c5247e8bc491b2c19f25bbc313c5cd683a23a736bb358195bfbe81f1', asset: '0x35c3e420fa4fd925628366f1977865d62432c8856a2db147a1cb13f7207f6a79', coin: false, decimals: 8, frozenAt: '2026-01-18T18:18:17Z' },
  { label: 'thLPT-3', market: '0xf7ac9cc7d4ed921d2fbd19af3c45669eb454adf3343ba12544af2e114cbfe2ce', asset: '0x5b07f08f0c43104b1dcb747273c5fc13bd86074f6e8e591bf0d8c5b08720cbd4', coin: false, decimals: 8, frozenAt: '2026-01-18T18:18:23Z' },
  { label: 'kAPT', market: '0xd707f87b2eb0ec9e875a19f79862e236b828e08a3e8f2ddf976f36aa8a5c1fd2', asset: '0x821c94e69bc7ca058c913b7b5e6b0a5c9fd1523d58723a966fb8c1f5ea888105', coin: false, decimals: 8, frozenAt: '2026-04-24T06:02:51Z' },
  { label: 'stkAPT', market: '0x1ebbf16a319ed581b90cc675fd1c8ce3c93986e2504da18acb5fb621b0daef9', asset: '0x42556039b88593e768c97ab1a3ab0c6a17230825769304482dff8fdebe4c002b', coin: false, decimals: 8, frozenAt: '2025-11-21T05:12:06Z' },
  { label: 'amAPT', market: '0x2fd92f49a702eb647f5b1aa86d39ba95ca174c656d987fdc6b37877c083fa4c4', asset: AMAPT_FA, coin: false, decimals: 8, frozenAt: '2025-11-21T05:14:05Z' },
  { label: 'gstAPT', market: '0x3b45b499a1034b828100ef1b838fcce15b8a5cbaf829f0163d2c0a9a29ffdfb6', asset: '0x5b5c9ec5e88ddd6697b5b2f9f0a8e03eae1186c47fa4d934798632dc2987b249', coin: false, decimals: 8, frozenAt: '2026-01-11T05:21:18Z' },
  { label: 'sYUSD', market: '0x3d05e093d1f7d1a8eb45e5e0e7f440a84b1bcacaec9e1421126cb797f7c72a73', asset: '0x5763307032c1971376260ca48cc627eb7cfde4d021aabc6bce9ffb9c7aa30619', coin: false, decimals: 6, frozenAt: '2026-10-04T17:48:01Z' },
].map(m => ({ ...m, market: normalizeAddress(m.market) }));

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

/** Whether Echelon has a valid oracle price for a market's asset. A withdrawal prices every market the account still
 *  holds afterwards (simulated: an account holding THL, whose price is invalid, can withdraw its THL but nothing else). */
function priced(ctx: ReadContext, market: string): Promise<boolean> {
  return once(ctx, `echelon-price:${market}:${ctx.ledger.version}`, async () => {
    try {
      await ctx.chain.view(`${ECHELON}::lending::asset_price`, [market], [], ctx.ledger.version);
      return true;
    } catch (err) {
      if (/ERR_ORACLE_/.test(String(err))) return false;
      throw err;
    }
  });
}

const label = (market: string) => FROZEN_MARKETS.find(m => m.market === market)?.label ?? market;

async function read(ctx: ReadContext, ownerInput: string): Promise<ReadResult> {
  const owner = normalizeAddress(ownerInput);
  const version = ctx.ledger.version;
  try {
    const vault = await ctx.chain.resource(owner, `${ECHELON}::lending::Vault`, version);
    const inDebt = (vault?.liabilities?.data ?? []).some((e: any) => BigInt(e.value.principal) + BigInt(e.value.interest_accumulated) > 0n);
    if (inDebt) return { positions: [], complete: true, errors: [], ledgerVersion: version };
    const shares = new Map<string, bigint>((vault?.collaterals?.data ?? []).map((e: any) => [normalizeAddress(e.key.inner), BigInt(e.value)]));
    const held = [...shares].filter(([, n]) => n > 0n).map(([market]) => market);
    const supplied = (await mapLimit(FROZEN_MARKETS.filter(m => held.includes(m.market)), 2, async m => {
      const market = await marketState(ctx, m.market);
      if (!market.frozen) return null;
      const [coins] = await ctx.chain.view(`${ECHELON}::lending::account_coins`, [owner, m.market], [], version);
      return BigInt(coins) > 0n ? { ...m, ...market, coins: BigInt(coins) } : null;
    })).filter(m => m !== null);
    if (!supplied.length) return { positions: [], complete: true, errors: [], ledgerVersion: version };
    const unpriced = (await mapLimit(held, 2, async market => ((await priced(ctx, market)) ? null : market))).filter(m => m !== null);

    const positions = supplied.flatMap((m): Position[] => {
      // Without debt there is no health limit (account_withdrawable_coins is u64::MAX), only cash. The cash is shared by
      // all lenders, so each is counted for its pro-rata share of it (coins x cash / supply) when the market is short:
      // the payouts of all lenders together never exceed the cash. The rest waits on borrowers. A share that rounds to
      // nothing (a few raw units) is not a position.
      const withdrawable = m.cash >= m.supply || m.supply === 0n ? m.coins : m.coins * m.cash / m.supply;
      if (withdrawable === 0n && m.cash > 0n) return [];
      const gross = [{ asset: m.asset, raw: m.coins.toString() }];
      const payout = withdrawable > 0n ? [{ asset: m.asset, raw: withdrawable.toString() }] : [];
      // Another held market without a price blocks this withdrawal. With exactly one, withdrawing it first (all of it,
      // so it leaves the vault) unblocks this one; that needs this market priced and the other's cash to cover it.
      // An unpriced market whose cash is short of the claim only allows a partial withdrawal, which leaves it in the
      // vault, priced: blocked too.
      const others = unpriced.filter(u => u !== m.market);
      const first = others.length === 1 && !unpriced.includes(m.market) ? supplied.find(f => f.market === others[0] && f.coins <= f.cash) : undefined;
      const stuck = (others.length > 0 && !first) || (unpriced.includes(m.market) && m.coins > m.cash);
      const blockers = [
        ...(payout.length ? [] : [{ code: 'insufficient_cash', detail: 'The market has no cash to pay this out until borrowers repay.' }]),
        ...(stuck ? [{ code: 'stale_oracle', detail: `Echelon prices every market you still hold after a withdrawal and has no valid price for ${unpriced.map(label).join(', ')}.` }] : []),
      ];
      // withdraw_all takes the whole claim and aborts when the market's cash is short of it; withdraw takes shares.
      const step = m.coins <= m.cash
        ? { function: m.coin ? `${ECHELON}::scripts::withdraw_all<${m.asset}>` : `${ECHELON}::scripts::withdraw_all_fa`, arguments: [m.market] }
        : { function: m.coin ? `${ECHELON}::scripts::withdraw<${m.asset}>` : `${ECHELON}::scripts::withdraw_fa`,
            arguments: [m.market, (withdrawable * shares.get(m.market)! / m.coins).toString()] };
      return [{
        ...positionIds(SOURCE, owner, m.label, 'principal', m.asset), source: SOURCE, owner, locator: m.label, positionKind: 'principal', asset: m.asset,
        claimableSince: m.frozenAt, ageBasis: 'protocol_closure',
        provenance: { reader: `${ECHELON}::lending::account_coins`, ledgerVersion: version },
        grossClaim: gross, expectedPayout: payout, payoutBasis: 'view',
        status: blockers.length ? 'blocked' : 'recoverable', blockers,
        confidence: 'verified_view', observedAt: iso(ctx.ledger.timestampSecs),
        steps: [{ ...step, prerequisites: first ? [`Withdraw your ${first.label} first: Echelon has no valid price for it, which blocks other withdrawals while you hold it.`] : [],
          expectedOutputs: payout }],
      }];
    });
    return { positions, complete: true, errors: [], ledgerVersion: version };
  } catch (err) {
    return { positions: [], complete: false, errors: [String(err).slice(0, 300)], ledgerVersion: version };
  }
}

export const echelonFrozenMarkets: SourceDef = {
  id: SOURCE,
  chain: 'aptos',
  protocol: 'Echelon',
  title: 'Echelon supply left in frozen markets',
  summary: 'Echelon froze some of its Aptos lending markets: no new borrowing. Supply you left there earns little or nothing and waits on Echelon winding the market down. Counted only for suppliers without Echelon debt.',
  category: 'closed_app',
  inclusionRule: 'R2: Echelon froze the market (collateral factor 0, borrow cap 0), so the supply sits nearly idle until a wind-down; the freeze is the effective date (issue #10, option (b)). R4: suppliers with any Echelon debt are left out. Both decided 2026-10-20.',
  protocolStatus: {
    state: 'deprecated',
    evidence: '21 of 30 markets frozen on chain (collateral factor 0, borrow cap 0); the freeze dates come from Echelon\'s admin transactions, 2025-05-03 to 2026-10-04. Aptos Foundation: Echelon "helped sunset bridge-wrapped assets".',
    checkedAt: '2026-10-20',
  },
  refresh: { nonZero: 'monthly', zero: 'never' },
  headlineAgeBases: ['protocol_closure'],
  howTo: [
    'Withdraw in the Echelon app (Aptos), or',
    `call ${ECHELON}::scripts::withdraw_all<coin type>(market) for a Coin market, or ${ECHELON}::scripts::withdraw_all_fa(market) for a fungible-asset market, from the supplying account.`,
    'Holding THL, Wormhole WETH, STONE, SBTC or a Thala LPT on Echelon (no valid price) blocks every other withdrawal: withdraw that first.',
  ],
  officialUrl: 'https://app.echelon.market',
  read,
};
