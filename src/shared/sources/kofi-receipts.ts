// Kofi kAPT / stkAPT still held after Kofi's wind-down. They count as left behind only if stranded (no usable market,
// docs/left-behind.md). The market test runs per value bucket: usable → not counted; none → recoverable at redemption
// value; quote failed or no provider → unknown (market_check_unavailable).
import { iso, positionIds } from '../accounting.ts';
import { mapLimit, normalizeAddress, once, transactionTime } from '../chain.ts';
import type { Position, ReadContext, ReadResult, SourceDef } from '../types.ts';
import { APT } from './delegation.ts';
import { KOFI } from './kofi-withdrawals.ts';

export const KAPT = '0x821c94e69bc7ca058c913b7b5e6b0a5c9fd1523d58723a966fb8c1f5ea888105';
export const STKAPT = '0x42556039b88593e768c97ab1a3ab0c6a17230825769304482dff8fdebe4c002b';
const SOURCE = 'kofi-receipts';
const WINDDOWN_SECS = Date.parse('2026-07-24T07:55:53Z') / 1000;
const RATE_SCALE = 100_000_000n;   // rewards_manager::get_exchange_rate: kAPT per stkAPT, 1e8-scaled

/** Last version at which each receipt store changed, from enumeration; used to date positions acquired later. */
export type ReceiptHint = { versions: Record<string, number> };

const STORES_QUERY = `query($o:String!){ current_fungible_asset_balances(where:{owner_address:{_eq:$o}, is_primary:{_eq:true},
  asset_type:{_in:["${KAPT}","${STKAPT}"]}}){ asset_type last_transaction_version } }`;

const TOKENS = [
  { asset: KAPT, symbol: 'kAPT', entry: 'request_withdrawal_entry' },
  { asset: STKAPT, symbol: 'stkAPT', entry: 'unstake_and_request_withdrawal_entry' },
] as const;

async function read(ctx: ReadContext, ownerInput: string, hint?: ReceiptHint): Promise<ReadResult> {
  const owner = normalizeAddress(ownerInput);
  const version = ctx.ledger.version;
  try {
    const versions: Record<string, number> = hint?.versions ?? Object.fromEntries(
      (await ctx.chain.gql(STORES_QUERY, { o: owner })).current_fungible_asset_balances
        .map((r: any) => [normalizeAddress(r.asset_type), Number(r.last_transaction_version)]));
    const rate = await once(ctx, `kofi-rate:${version}`, async () =>
      BigInt((await ctx.chain.view(`${KOFI}::rewards_manager::get_exchange_rate`, [], [], version))[0]));
    const query = (asset: string) => ({ asset, decimals: 8, redemptionPerToken: asset === KAPT ? 1 : Number(rate) / Number(RATE_SCALE) });
    // When every value bucket has a usable market, no holder can be stranded: nothing to read.
    if (ctx.market && (await Promise.all(TOKENS.map(t => ctx.market!.allUsable(query(t.asset))))).every(Boolean)) {
      return { positions: [], complete: true, errors: [], ledgerVersion: version };
    }
    const found = await mapLimit([...TOKENS], 2, async (t): Promise<Position | null> => {
      if (versions[t.asset] === undefined) return null;
      // Entry functions spend from the primary store only.
      const held = BigInt((await ctx.chain.view('0x1::primary_fungible_store::balance', [owner, t.asset], ['0x1::fungible_asset::Metadata'], version))[0]);
      if (held === 0n) return null;
      const redeemable = t.asset === KAPT ? held : held * rate / RATE_SCALE;
      const memo = `${SOURCE}:since:${owner}:${t.asset}:${versions[t.asset]}`;
      let since = Number(await ctx.memo.get(memo) ?? NaN);
      if (Number.isNaN(since)) {
        since = Math.max(WINDDOWN_SECS, await transactionTime(ctx.chain, versions[t.asset]) ?? Infinity);
        if (Number.isFinite(since)) await ctx.memo.set(memo, String(since));
      }
      const payout = [{ asset: APT, raw: redeemable.toString() }];
      const verdict = ctx.market ? await ctx.market.verdict(query(t.asset), Number(redeemable) / 1e8) : 'unknown';
      if (verdict === 'usable') return null;   // a wallet token with a usable market is not left behind
      return {
        ...positionIds(SOURCE, owner, t.symbol, 'principal', t.asset), source: SOURCE, owner, locator: t.symbol, positionKind: 'principal', asset: t.asset,
        claimableSince: Number.isFinite(since) ? iso(since) : undefined, ageBasis: Number.isFinite(since) ? 'protocol_closure' : 'unknown',
        provenance: { reader: '0x1::primary_fungible_store::balance', ledgerVersion: version },
        grossClaim: [{ asset: t.asset, raw: held.toString() }], expectedPayout: payout, payoutBasis: 'derived',
        status: verdict === 'none' ? 'recoverable' : 'unknown',
        blockers: verdict === 'none' ? [] : [{ code: 'market_check_unavailable',
          detail: 'Counts only if no market pays at least 80% of redemption value; the market quote could not be obtained.' }],
        confidence: 'verified_view', observedAt: iso(ctx.ledger.timestampSecs),
        steps: [
          { function: `${KOFI}::gateway::${t.entry}`, arguments: [held.toString()], prerequisites: [], expectedOutputs: [] },
          { function: `${KOFI}::gateway::finalize_withdrawals_entry`, arguments: ['[ticket_id]'],
            prerequisites: ['After the withdrawal period (14 days), finalize the new ticket.'], expectedOutputs: payout },
        ],
      };
    });
    return { positions: found.filter((p): p is Position => p !== null), complete: true, errors: [], ledgerVersion: version };
  } catch (err) {
    return { positions: [], complete: false, errors: [String(err).slice(0, 300)], ledgerVersion: version };
  }
}

export const kofiReceipts: SourceDef<ReceiptHint> = {
  id: SOURCE,
  chain: 'aptos',
  protocol: 'Kofi',
  title: 'kAPT / stkAPT still held after Kofi\'s wind-down',
  summary: 'Kofi is winding down. kAPT and stkAPT can still be redeemed for APT through a withdrawal ticket. Counted only if no market pays close to redemption value.',
  category: 'closed_app',
  inclusionRule: 'Stranded receipt: protocol wound down, redemption needs an owner action, and no market pays at least 80% of redemption value (Panora quote).',
  protocolStatus: {
    state: 'wound_down',
    evidence: 'config::is_winddown became true at version 6,429,705,721 (multisig transaction); deposits and staking paused.',
    checkedAt: '2026-10-19',
    effectiveAt: '2026-07-24T07:55:53Z',
  },
  // Never in the headline; a changed balance (new hint version) still makes the holder due at once.
  // Positions rest on market quotes that expire after 7 days (MARKET_MAX_AGE_SECS), so holders are re-read within that
  // window. While every bucket has a usable market the read is skipped, so this costs nothing until markets dry up.
  refresh: { nonZero: 'every_run', zero: 'weekly' },
  version: 2,   // 2: market test applied (usable market → not counted)
  headlineAgeBases: ['protocol_closure'],
  howTo: [
    'In the Kofi app, redeem kAPT (or unstake stkAPT) for APT; after the 14-day withdrawal period, finalize the ticket.',
    `Or call ${KOFI}::gateway::request_withdrawal_entry(amount) for kAPT / gateway::unstake_and_request_withdrawal_entry(amount) for stkAPT, then gateway::finalize_withdrawals_entry([ticket_id]).`,
  ],
  officialUrl: 'https://app.kofi.finance',
  read,
};
