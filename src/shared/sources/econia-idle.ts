// Econia (Aptos order book): coins left in Econia market accounts. Econia Labs archived the protocol's repository on
// 2025-09-08 (GitHub banner), the last order was placed on 2025-09-01 and the last deposit on 2025-07-24; since then the
// only activity is users withdrawing. Counted as deprecated from the archive date (decided 2026-10-20). Since Econia is
// closed, coins resting in open orders count too (R4, decided 2026-10-21): cancel the orders, then withdraw. Only
// accounts the owner controls (custodian 0) count: custodian accounts (Fliq, Kana) need their custodian to withdraw.
import { iso, positionIds } from '../accounting.ts';
import { normalizeAddress, once } from '../chain.ts';
import type { Position, ReadContext, ReadResult, SourceDef } from '../types.ts';
import { APT } from './delegation.ts';
import { WH_USDC } from './echelon-frozen.ts';
import { LZ_BRIDGE } from './layerzero-claimable.ts';

export const ECONIA = '0xc0deb00c405f84c85dc13442e305df75d1288100cdd82675695f6148c7ece51c';
/** Kana Labs' Econia trading wrapper: registers and deposits into the caller's own (custodian 0) market accounts. */
export const KANA_ECONIA_WRAPPER = '0x9538c839fe490ccfaf32ad9f7491b5e84e610ff6edc110ff883f06ebde82463d';
const SOURCE = 'econia-idle-accounts';
/** Econia's coin markets (ids 1 to 13; from 14 on every market has a generic base: Kana perps, then Fliq questions). */
export const ECONIA_COIN_MARKETS = Array.from({ length: 13 }, (_, i) => String(i + 1));
export const GUI = '0xe4ccb6d39136469f376242c31b34d10515c8eaaa38092f804db8e08a8f53c5b2::assets_v1::EchoCoin002';
export const EDOG = '0x5e975e7f36f2658d4cf146142899c659464a3e0d90f0f4d5f8b2447173c06ef6::EDOG::EDOG';
/** Every coin those markets trade, as recorded in positions (registry, 2026-10-20). */
export const ECONIA_COINS = [APT, WH_USDC, `${LZ_BRIDGE}::asset::USDC`, `${LZ_BRIDGE}::asset::USDT`, `${LZ_BRIDGE}::asset::WETH`, GUI, EDOG];
/** End of the day Econia Labs archived the repository (the banner gives the date only), so the age is never overstated. */
export const ECONIA_ARCHIVED_AT = '2025-09-08T23:59:59Z';
const APT_COIN = `${normalizeAddress('0x1')}::aptos_coin::AptosCoin`;

interface MarketInfo { base?: string; quote: string }

const coinType = (t: { package_address: string; module_name: string; type_name: string }) =>
  `${normalizeAddress(t.package_address)}::${t.module_name}::${t.type_name}`;
/** The asset a withdrawal pays: the coin type, or APT for the APT coin (prices and totals key APT by its 0xa asset). */
const payoutAsset = (coin: string) => (coin === APT_COIN ? APT : coin);

/** A market's base and quote coin types; a market with a generic (non-coin) base has no base coin. */
function marketInfo(ctx: ReadContext, id: string): Promise<MarketInfo> {
  return once(ctx, `econia-market:${id}`, async () => {
    const [m] = await ctx.chain.view(`${ECONIA}::registry::get_market_info`, [id], [], ctx.ledger.version);
    return { base: m.base_name_generic ? undefined : coinType(m.base_type), quote: coinType(m.quote_type) };
  });
}

/** Enumeration hint: the time of the run that saw the owner act (a deposit, withdrawal or order of its own). */
export interface EconiaHint { since?: string }

async function read(ctx: ReadContext, ownerInput: string, hint?: EconiaHint): Promise<ReadResult> {
  const owner = normalizeAddress(ownerInput);
  const version = ctx.ledger.version;
  // A balance that changed after the archive date has been idle only since then: the latest of the dates that apply.
  // Without the enumeration hint (the check page) a later change cannot be ruled out, so the age is unknown.
  const since = hint && (hint.since && Date.parse(hint.since) > Date.parse(ECONIA_ARCHIVED_AT) ? hint.since : ECONIA_ARCHIVED_AT);
  try {
    const [accounts] = await ctx.chain.view(`${ECONIA}::user::get_market_accounts`, [owner], [], version);
    const own = (accounts as any[]).filter(a => a.custodian_id === '0');
    const positions: Position[] = [];
    for (const a of own) {
      const market = await marketInfo(ctx, a.market_id);
      // Totals include coins resting in open orders; cancelling them (asks: side true, bids: false) frees them first.
      const cancels = [...(a.asks.length ? [true] : []), ...(a.bids.length ? [false] : [])].map(side => ({
        function: `${ECONIA}::market::cancel_all_orders_user`, arguments: [a.market_id, String(side)], prerequisites: [], expectedOutputs: [] }));
      const sides = [{ coin: market.base, amount: BigInt(a.base_total) }, { coin: market.quote, amount: BigInt(a.quote_total) }];
      for (const { coin, amount } of sides) {
        if (!coin || amount === 0n) continue;
        const asset = payoutAsset(coin);
        const value = [{ asset, raw: amount.toString() }];
        const locator = `market-${a.market_id}`;
        positions.push({
          ...positionIds(SOURCE, owner, locator, 'principal', asset), source: SOURCE, owner, locator, positionKind: 'principal', asset,
          claimableSince: since, ageBasis: hint ? 'protocol_closure' : 'unknown',
          provenance: { reader: `${ECONIA}::user::get_market_accounts`, ledgerVersion: version },
          grossClaim: value, expectedPayout: value, payoutBasis: 'view',
          status: 'recoverable', blockers: [],
          confidence: 'verified_view', observedAt: iso(ctx.ledger.timestampSecs),
          // Arguments are (market id, amount): simulated; the reverse order aborts.
          steps: [...cancels, { function: `${ECONIA}::user::withdraw_to_coinstore<${coin}>`, arguments: [a.market_id, amount.toString()], prerequisites: [], expectedOutputs: value }],
        });
      }
    }
    return { positions, complete: true, errors: [], ledgerVersion: version };
  } catch (err) {
    return { positions: [], complete: false, errors: [String(err).slice(0, 300)], ledgerVersion: version };
  }
}

export const econiaIdleAccounts: SourceDef<EconiaHint> = {
  id: SOURCE,
  chain: 'aptos',
  protocol: 'Econia',
  title: 'Econia market accounts left behind',
  summary: 'Econia, an on-chain order book, is no longer maintained: its team archived the code in September 2025 and nobody has traded since. Coins you deposited into an Econia market account, or left in open orders, are still there.',
  category: 'closed_app',
  inclusionRule: 'R2: Econia is deprecated (Econia Labs archived the repository on 2025-09-08; no order since 2025-09-01); the archive date is the effective date (decided 2026-10-20). R4: coins in open orders count since Econia is closed (decided 2026-10-21); accounts run by a custodian are left out.',
  protocolStatus: {
    state: 'deprecated',
    evidence: 'github.com/econia-labs/econia: "This repository was archived by the owner on Sep 8, 2025." Last limit order 2025-07-25, last market order 2025-09-01, last deposit 2025-07-24; only withdrawals since (checked 2026-10-20). PitchBook lists Econia Labs as out of business.',
    checkedAt: '2026-10-20',
  },
  refresh: { nonZero: 'monthly', zero: 'never' },
  headlineAgeBases: ['protocol_closure'],
  howTo: [
    `If the account has open orders, call ${ECONIA}::market::cancel_all_orders_user(market id, side) first (asks: true, bids: false).`,
    `Then call ${ECONIA}::user::withdraw_to_coinstore<coin type>(market id, amount) from the account, once per coin and market.`,
  ],
  officialUrl: 'https://github.com/econia-labs/econia',
  read,
};
