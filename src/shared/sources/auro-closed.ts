// Auro Finance (Aptos CDP): collateral left in Auro positions after the team shut the website down. The team told users
// to withdraw everything before April 30, 2026 (Pyth deprecated its push feeds on Aptos) and shut the website down by
// the end of April; auro.finance no longer resolves. Closed under the closed-frontend rule (decided 2026-10-21), aged
// from 2026-04-30. A position with debt does not count (R4). Positions are NFTs in Auro's CDP collection.
import { iso, positionIds } from '../accounting.ts';
import { gqlAll, mapLimit, normalizeAddress, once } from '../chain.ts';
import type { Position, ReadContext, ReadResult, SourceDef } from '../types.ts';

export const AURO = '0x50a340a19e6ada1be07192c042786ca6a9651d5c845acc8727e8c6416a56a32c';
export const AURO_ROUTER = '0xd039ef33e378c10544491855a2ef99cd77bf1a610fd52cc43117cd96e1c73465';
export const AURO_COLLECTION = '0x0bc8b183a8bfbd127e2a7a53944c10fd7d22f34e20d336c9a85f375f552ef951';
/** The account holding every pool's reserves (traced from a simulated withdrawal's stores, 2026-10-21). */
export const AURO_DAO = '0xafe4f68733d3d9ad07a717d2fed2fdd5743a71c529ddfa8dfa70bff540f4c690';
export const AMAPT_COIN = '0x111ae3e5bc816a5e63c2da97d0aa3886519e0cd5e4b046659fa35796bd11542a::amapt_token::AmnisApt';
/** End of the day the team's notice set as the last day to withdraw (the website shut down by the end of April). */
export const AURO_CLOSED_AT = '2026-04-30T23:59:59Z';
const SOURCE = 'auro-closed-positions';

/** Enumeration hint: the owner's position NFTs, and its last repayment after the shutdown (a position that had debt then
 *  qualifies only from its repayment). */
export type AuroHint = { tokens: string[]; repaidAt?: string };

interface Pool { token: string; coin: boolean; supply: bigint; totalShares: bigint; available: bigint; paused: boolean }

/** A pool's share accounting and what the DAO account actually holds of its token (pools can be short of it). */
function pool(ctx: ReadContext, address: string): Promise<Pool> {
  return once(ctx, `auro-pool:${address}:${ctx.ledger.version}`, async () => {
    const version = ctx.ledger.version;
    const [state, lending] = await Promise.all([
      ctx.chain.resource(address, `${AURO}::lending_pool::State`, version),
      ctx.chain.resource(address, `${AURO}::lending_pool::LendingPool`, version),
    ]);
    if (!state || !lending) throw new Error(`Auro pool ${address} missing`);
    const token: string = lending.token;
    const coin = token.includes('::');
    // The pool holds its reserves as `fungible_asset`: the token itself, or for a coin pool a fungible asset Auro wraps
    // the coin in (not the coin's paired asset).
    const [held] = await ctx.chain.view('0x1::primary_fungible_store::balance', [AURO_DAO, normalizeAddress(lending.fungible_asset.inner)],
      ['0x1::fungible_asset::Metadata'], version);
    return { token: coin ? token : normalizeAddress(token), coin, available: BigInt(held), paused: state.is_paused,
      supply: BigInt(state.total_reserves_amount) + BigInt(state.total_debt_amount) - BigInt(state.total_fees),
      totalShares: BigInt(state.total_supply_shares) };
  });
}

const TOKENS_QUERY = `query($o:String!,$c:String!,$after:String!){ current_token_ownerships_v2(where:{owner_address:{_eq:$o}, amount:{_gt:"0"},
  current_token_data:{collection_id:{_eq:$c}}, token_data_id:{_gt:$after}}, order_by:{token_data_id:asc}, limit:100){ token_data_id } }`;

async function read(ctx: ReadContext, ownerInput: string, hint?: AuroHint): Promise<ReadResult> {
  const owner = normalizeAddress(ownerInput);
  const version = ctx.ledger.version;
  const errors: string[] = [];
  let failed = 0;
  const tokens: string[] = hint?.tokens ??
    (await gqlAll(ctx.chain, TOKENS_QUERY, { o: owner, c: AURO_COLLECTION }, 'current_token_ownerships_v2', 'token_data_id')).map((t: any) => t.token_data_id);
  const found = await mapLimit(tokens.map(normalizeAddress), 4, async (token): Promise<Position[]> => {
    try {
      const [core, position] = await Promise.all([
        ctx.chain.resource(token, '0x1::object::ObjectCore', version),
        ctx.chain.resource(token, `${AURO}::lending_pool::UserPosition`, version),
      ]);
      // A burned position or one that moved belongs to nobody's or its new owner's read; any debt excludes it (R4).
      if (!core || !position || normalizeAddress(core.owner) !== owner) return [];
      if (position.debt_shares.data.some((d: any) => BigInt(d.value) > 0n)) return [];
      // The contract still takes deposits and repayments: a position topped up after the shutdown is aged from that
      // deposit, and one whose owner repaid after it (it had debt, so it did not qualify) from that repayment. The check
      // page reads without the enumeration's repayment history, so there the age is unknown.
      const since = hint ? [AURO_CLOSED_AT, iso(Number(position.last_deposited_times ?? 0)), hint.repaidAt]
        .filter((d): d is string => !!d).reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a)) : undefined;
      return await Promise.all(position.deposit_shares.data.filter((d: any) => BigInt(d.value) > 0n).map(async (d: any): Promise<Position> => {
        const p = await pool(ctx, normalizeAddress(d.key.inner));
        const shares = BigInt(d.value);
        // The exact amount that burns every share (rounded up), and what it pays (rounded down).
        const requested = (shares * p.supply + p.totalShares - 1n) / p.totalShares;
        const received = shares * p.supply / p.totalShares;
        // Each holder is counted for its share of what the pool really holds (the stkAPT pool holds ~37% of its books).
        const share = p.available >= p.supply ? received : received * p.available / p.supply;
        const gross = [{ asset: p.token, raw: received.toString() }];
        const payout = share > 0n ? [{ asset: p.token, raw: share.toString() }] : [];
        // A partial withdrawal checks the position's health with a Pyth price that no longer updates on Aptos (aborts,
        // simulated); a full one does not. So a position can be withdrawn only whole, and only while the pool covers it.
        const blockers = [
          ...(p.paused ? [{ code: 'paused', detail: 'Auro paused this pool.' }] : []),
          ...(received > p.available ? [{ code: 'insufficient_cash', detail: 'The pool holds less than this position; a partial withdrawal needs a fresh Pyth price, which no longer updates on Aptos.' }] : []),
        ];
        const locator = `${token}/${normalizeAddress(d.key.inner)}`;
        return {
          ...positionIds(SOURCE, owner, locator, 'principal', p.token), source: SOURCE, owner, locator, positionKind: 'principal', asset: p.token,
          claimableSince: since, ageBasis: since ? 'protocol_closure' : 'unknown',
          provenance: { reader: `${AURO}::lending_pool::UserPosition`, ledgerVersion: version },
          grossClaim: gross, expectedPayout: payout, payoutBasis: 'derived',
          status: blockers.length ? 'blocked' : 'recoverable', blockers,
          confidence: 'verified_view', observedAt: iso(ctx.ledger.timestampSecs),
          steps: [{ function: p.coin ? `${AURO_ROUTER}::auro_router::withdraw_coin_entry<${p.token}>` : `${AURO_ROUTER}::auro_router::withdraw_entry`,
            arguments: [token, requested.toString()], prerequisites: [], expectedOutputs: gross }],
        };
      }));
    } catch (err) {
      failed++;
      errors.push(`position ${token}: ${String(err).slice(0, 200)}`);
      return [];
    }
  });
  return { positions: found.flat(), complete: failed === 0, errors, ledgerVersion: version };
}

export const auroClosedPositions: SourceDef<AuroHint> = {
  id: SOURCE,
  chain: 'aptos',
  protocol: 'Auro Finance',
  title: 'Auro Finance collateral left after the shutdown',
  summary: 'Auro Finance shut its website down at the end of April 2026 and asked users to withdraw. Collateral left in debt-free Auro positions is still there.',
  category: 'closed_app',
  inclusionRule: 'R2: website shut down by 2026-04-30 (team notice), closed under the closed-frontend rule (decided 2026-10-21). R4: positions with debt are left out.',
  protocolStatus: {
    state: 'closed',
    evidence: 'Team notice on X: "withdraw all funds before April 30 ... permanently shut down the website by the end of April" (Pyth deprecated its push feeds on Aptos on 2026-04-30). auro.finance and app.auro.finance no longer resolve (2026-10-21).',
    checkedAt: '2026-10-21',
    effectiveAt: AURO_CLOSED_AT,
  },
  // Withdrawals, repayments and the pools' shared reserves change positions without changing who holds the NFTs, and
  // the whole collection is ~715 requests: every owner is re-read every run.
  refresh: { nonZero: 'every_run', zero: 'weekly' },
  headlineAgeBases: ['protocol_closure'],
  howTo: [
    `Call ${AURO_ROUTER}::auro_router::withdraw_coin_entry<coin type>(position, amount) for a coin pool, or withdraw_entry(position, amount) for a fungible-asset pool, from the account holding the position NFT, with the full amount.`,
  ],
  read,
};
