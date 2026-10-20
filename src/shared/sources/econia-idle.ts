// Econia (Aptos order book): coins left idle in Econia market accounts. Econia Labs archived the protocol's repository
// on 2025-09-08 (GitHub banner), the last order was placed on 2025-09-01 and the last deposit on 2025-07-24; since then
// the only activity is users withdrawing. Counted as deprecated from the archive date (decided 2026-10-20).
// Only accounts the owner controls (custodian 0) and without open orders count (R4): custodian accounts (Fliq, Kana)
// need their custodian to withdraw, and open orders are live use.
import { iso, positionIds } from '../accounting.ts';
import { normalizeAddress, once } from '../chain.ts';
import type { Position, ReadContext, ReadResult, SourceDef } from '../types.ts';
import { APT } from './delegation.ts';

export const ECONIA = '0xc0deb00c405f84c85dc13442e305df75d1288100cdd82675695f6148c7ece51c';
/** Kana Labs' Econia trading wrapper: registers and deposits into the caller's own (custodian 0) market accounts. */
export const KANA_ECONIA_WRAPPER = '0x9538c839fe490ccfaf32ad9f7491b5e84e610ff6edc110ff883f06ebde82463d';
const SOURCE = 'econia-idle-accounts';
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

async function read(ctx: ReadContext, ownerInput: string): Promise<ReadResult> {
  const owner = normalizeAddress(ownerInput);
  const version = ctx.ledger.version;
  try {
    const [accounts] = await ctx.chain.view(`${ECONIA}::user::get_market_accounts`, [owner], [], version);
    const idle = (accounts as any[]).filter(a => a.custodian_id === '0' && !a.asks.length && !a.bids.length);
    const positions: Position[] = [];
    for (const a of idle) {
      const market = await marketInfo(ctx, a.market_id);
      const sides = [{ coin: market.base, amount: BigInt(a.base_available) }, { coin: market.quote, amount: BigInt(a.quote_available) }];
      for (const { coin, amount } of sides) {
        if (!coin || amount === 0n) continue;
        const asset = payoutAsset(coin);
        const value = [{ asset, raw: amount.toString() }];
        const locator = `market-${a.market_id}`;
        positions.push({
          ...positionIds(SOURCE, owner, locator, 'principal', asset), source: SOURCE, owner, locator, positionKind: 'principal', asset,
          claimableSince: ECONIA_ARCHIVED_AT, ageBasis: 'protocol_closure',
          provenance: { reader: `${ECONIA}::user::get_market_accounts`, ledgerVersion: version },
          grossClaim: value, expectedPayout: value, payoutBasis: 'view',
          status: 'recoverable', blockers: [],
          confidence: 'verified_view', observedAt: iso(ctx.ledger.timestampSecs),
          // Arguments are (market id, amount): simulated; the reverse order aborts.
          steps: [{ function: `${ECONIA}::user::withdraw_to_coinstore<${coin}>`, arguments: [a.market_id, amount.toString()], prerequisites: [], expectedOutputs: value }],
        });
      }
    }
    return { positions, complete: true, errors: [], ledgerVersion: version };
  } catch (err) {
    return { positions: [], complete: false, errors: [String(err).slice(0, 300)], ledgerVersion: version };
  }
}

export const econiaIdleAccounts: SourceDef = {
  id: SOURCE,
  chain: 'aptos',
  protocol: 'Econia',
  title: 'Econia market accounts left idle',
  summary: 'Econia, an on-chain order book, is no longer maintained: its team archived the code in September 2025 and nobody has traded since. Coins you deposited into an Econia market account and never withdrew are still there.',
  category: 'closed_app',
  inclusionRule: 'R2: Econia is deprecated (Econia Labs archived the repository on 2025-09-08; no order since 2025-09-01); the archive date is the effective date. R4: accounts with open orders, and accounts run by a custodian, are left out. Decided 2026-10-20.',
  protocolStatus: {
    state: 'deprecated',
    evidence: 'github.com/econia-labs/econia: "This repository was archived by the owner on Sep 8, 2025." Last limit order 2025-07-25, last market order 2025-09-01, last deposit 2025-07-24; only withdrawals since (checked 2026-10-20). PitchBook lists Econia Labs as out of business.',
    checkedAt: '2026-10-20',
  },
  refresh: { nonZero: 'monthly', zero: 'never' },
  headlineAgeBases: ['protocol_closure'],
  howTo: [
    `Call ${ECONIA}::user::withdraw_to_coinstore<coin type>(market id, amount) from the account, once per coin and market.`,
  ],
  officialUrl: 'https://github.com/econia-labs/econia',
  read,
};
