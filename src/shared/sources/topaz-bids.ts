// APT escrowed in Topaz NFT bids that were never cancelled. Topaz ceased operations on 2024-08-21; a bid's APT stays in
// Topaz's tables until the bidder cancels it, also after its deadline. Expired bids have ended (aged from the deadline).
// Bids not yet expired are open orders, which count too since Topaz is closed (R4, decided 2026-10-21): aged from the
// shutdown when placed before it, unknown otherwise (bid ids are sequential, so the id tells):
// - collection bids: collection_marketplace::Bids<APT> (bid id → Bid with its coins), cancel<APT>(bid id);
// - token bids: bid_any::CoinEscrow<APT> (bid id → coins), cancel_bid<APT>(bid id).
// Each module keeps an Index (bidder → bid ids), so a bidder's bids are found on chain without the indexer.
import { iso, positionIds } from '../accounting.ts';
import { mapLimit, normalizeAddress, once } from '../chain.ts';
import type { Position, ReadContext, ReadResult, SourceDef } from '../types.ts';
import { APT } from './delegation.ts';

export const TOPAZ = '0x2c7bccf7b31baf770fdbcc768d9e9cb3d87805e255355df5db32ac9a669010a2';
const APT_COIN = '0x1::aptos_coin::AptosCoin';
const SOURCE = 'topaz-bids';
/** A bidder whose indexed bids total less than this (0.25 APT, about $1) is not verified on chain: listed as
 *  indexer_only, which keeps them out of every total. Most bids are dust. */
export const TOPAZ_VERIFY_MIN = 25_000_000n;
/** End of the day Topaz's notice names (it gives a date only). */
export const TOPAZ_CLOSED_AT = '2024-08-21T23:59:59Z';
/** Each module's MarketplaceData.nonce at version 1,642,611,992 (the shutdown day): bid ids below it were placed before;
 *  bids placed later that day have higher ids, so their age stays unknown. */
export const TOPAZ_NONCE_AT_CLOSE = { c: 312_038n, a: 271_091n };

export const TOPAZ_KINDS = {
  c: { label: 'collection-bid', index: `${TOPAZ}::collection_marketplace::Index`, store: `${TOPAZ}::collection_marketplace::Bids<${APT_COIN}>`,
    storeField: 'bids', value: `${TOPAZ}::collection_marketplace::Bid<${APT_COIN}>`, cancel: `${TOPAZ}::collection_marketplace::cancel<${APT_COIN}>` },
  a: { label: 'token-bid', index: `${TOPAZ}::bid_any::Index`, store: `${TOPAZ}::bid_any::CoinEscrow<${APT_COIN}>`,
    storeField: 'coins', value: `0x1::coin::Coin<${APT_COIN}>`, cancel: `${TOPAZ}::bid_any::cancel_bid<${APT_COIN}>` },
} as const;
export type TopazKind = keyof typeof TOPAZ_KINDS;

/** A bid as the indexer last saw it: escrowed raw APT and deadline (unix seconds). */
export type TopazBid = { raw: string; deadline?: number };
/** The bidder's bids per module, by bid id. Topaz never deletes a bid row (a cancel or fill empties its coins), so an
 *  incremental scan's per-bid delta merges into the stored hint. */
export type TopazHint = Partial<Record<TopazKind, Record<string, TopazBid>>>;

/** Table handles of a module's bidder index, its bid store and (token bids) its bid details, zero-padded. */
export function topazTables(ctx: ReadContext): Promise<Record<TopazKind, { index: string; store: string }> & { anyBids: string }> {
  return once(ctx, `topaz-tables:${ctx.ledger.version}`, async () => {
    const r = (type: string) => ctx.chain.resource(TOPAZ, type, ctx.ledger.version);
    const [ci, cs, ai, as, ab] = await Promise.all([r(TOPAZ_KINDS.c.index), r(TOPAZ_KINDS.c.store), r(TOPAZ_KINDS.a.index), r(TOPAZ_KINDS.a.store), r(`${TOPAZ}::bid_any::Bids`)]);
    if (!ci || !cs || !ai || !as || !ab) throw new Error('Topaz tables missing');
    return { c: { index: normalizeAddress(ci.bids.handle), store: normalizeAddress(cs.bids.handle) },
      a: { index: normalizeAddress(ai.bids.handle), store: normalizeAddress(as.coins.handle) }, anyBids: normalizeAddress(ab.bids.handle) };
  });
}

/** BCS key of a u64 table key, as the indexer stores it. */
export const u64Key = (id: string | bigint) => '0x' + BigInt(id).toString(16).padStart(16, '0').match(/../g)!.reverse().join('');

/** Deadlines are microseconds, but some bids store milliseconds, which read as 1970: a deadline before Topaz existed
 *  (2022) is not a usable date, and the bid is treated as having none (open, aged from the shutdown). */
const TOPAZ_FIRST_DEADLINE = Date.parse('2022-01-01T00:00:00Z') / 1000;
/** Expired: the deadline has passed, so the bid can no longer be filled. */
const expired = (ctx: ReadContext, deadline: number | undefined) =>
  deadline !== undefined && deadline >= TOPAZ_FIRST_DEADLINE && deadline <= ctx.ledger.timestampSecs;   // 0: none set

/** A bid's age: an expired bid ended on its deadline; an open one counts from the shutdown if placed before it. */
function age(ctx: ReadContext, kind: TopazKind, id: string, deadline: number | undefined): Pick<Position, 'claimableSince' | 'ageBasis'> {
  if (expired(ctx, deadline)) return { claimableSince: iso(deadline!), ageBasis: 'onchain_maturity' };
  return BigInt(id) < TOPAZ_NONCE_AT_CLOSE[kind] ? { claimableSince: TOPAZ_CLOSED_AT, ageBasis: 'protocol_closure' } : { claimableSince: undefined, ageBasis: 'unknown' };
}

/** A funded bid's position. */
function position(ctx: ReadContext, owner: string, kind: TopazKind, id: string, raw: string, deadline: number | undefined, confidence: Position['confidence']): Position {
  const k = TOPAZ_KINDS[kind];
  const locator = `${k.label}:${id}`;
  const value = [{ asset: APT, raw }];
  return {
    ...positionIds(SOURCE, owner, locator, 'principal'), source: SOURCE, owner, locator, positionKind: 'principal', asset: APT,
    ...(confidence === 'indexer_only' ? { claimableSince: undefined, ageBasis: 'unknown' as const } : age(ctx, kind, id, deadline)),
    provenance: { reader: confidence === 'indexer_only' ? 'indexer current_table_items' : `${k.store}`, ledgerVersion: ctx.ledger.version },
    grossClaim: value, expectedPayout: value, payoutBasis: 'view', status: 'recoverable', blockers: [],
    confidence, observedAt: iso(ctx.ledger.timestampSecs),
    steps: [{ function: k.cancel, arguments: [id], prerequisites: [], expectedOutputs: value }],
  };
}

async function read(ctx: ReadContext, ownerInput: string, hint?: TopazHint): Promise<ReadResult> {
  const owner = normalizeAddress(ownerInput);
  const version = ctx.ledger.version;
  const kinds = Object.keys(TOPAZ_KINDS) as TopazKind[];
  if (hint) {
    const funded = kinds.flatMap(k => Object.entries(hint[k] ?? {}).filter(([, b]) => BigInt(b.raw) > 0n).map(([id, b]) => ({ k, id, b })));
    if (funded.reduce((s, e) => s + BigInt(e.b.raw), 0n) < TOPAZ_VERIFY_MIN) {
      const positions = funded.map(e => position(ctx, owner, e.k, e.id, e.b.raw, e.b.deadline, 'indexer_only'));
      return { positions, complete: true, errors: [], ledgerVersion: version };
    }
  }
  const errors: string[] = [];
  let failed = 0;
  const positions: Position[] = [];
  try {
    const tables = await topazTables(ctx);
    for (const kind of kinds) {
      const k = TOPAZ_KINDS[kind];
      // With the enumeration hint, only the bids it lists as funded are read (escrow only shrinks). Without one (the
      // check page), the bidder's ids come from Topaz's own index.
      const candidates: { id: string; deadline?: number }[] = hint
        ? Object.entries(hint[kind] ?? {}).filter(([, b]) => BigInt(b.raw) > 0n).map(([id, b]) => ({ id, deadline: b.deadline }))
        : ((await ctx.chain.tableItem(tables[kind].index, 'address', 'vector<u64>', owner, version)) ?? []).map((id: unknown) => ({ id: String(id) }));
      const found = await mapLimit(candidates, 3, async ({ id, deadline: known }): Promise<Position | null> => {
        try {
          const v = await ctx.chain.tableItem(tables[kind].store, 'u64', k.value, id, version);
          const raw = BigInt(kind === 'c' ? v?.coins?.value ?? 0 : v?.value ?? 0);
          if (raw === 0n) return null;
          let deadline = known, buyer: string | undefined = kind === 'c' ? v?.buyer : undefined;
          if (deadline === undefined) {
            const bid = kind === 'c' ? v : await ctx.chain.tableItem(tables.anyBids, 'u64', `${TOPAZ}::bid_any::Bid`, id, version);
            deadline = bid?.deadline !== undefined ? Math.floor(Number(bid.deadline) / 1e6) : undefined;
            buyer = bid?.buyer;
          }
          // Topaz's per-bidder index lists some ids under the wrong bidder (ids 1, 4 and 9 under several), so a bid
          // counts only when its own record names this owner. Hinted token bids carry their buyer from enumeration.
          if (buyer !== undefined ? normalizeAddress(buyer) !== owner : !hint) return null;
          return position(ctx, owner, kind, id, raw.toString(), deadline, 'verified_view');
        } catch (err) {
          failed++;
          errors.push(`${k.label} ${id}: ${String(err).slice(0, 200)}`);
          return null;
        }
      });
      positions.push(...found.filter((p): p is Position => p !== null));
    }
  } catch (err) {
    return { positions: [], complete: false, errors: [String(err).slice(0, 300)], ledgerVersion: version };
  }
  return { positions, complete: failed === 0, errors, ledgerVersion: version };
}

export const topazBids: SourceDef<TopazHint> = {
  id: SOURCE,
  chain: 'aptos',
  protocol: 'Topaz',
  title: 'Topaz NFT bid never cancelled',
  summary: 'Topaz, an Aptos NFT marketplace, shut down in August 2024. APT you put into a bid stays in Topaz\'s contract, expired or not, until you cancel it.',
  category: 'closed_app',
  inclusionRule: 'R2: Topaz ceased operations on 2024-08-21. Expired bids have ended (aged from the deadline); bids not yet expired are open orders in a closed protocol, which count (R4, decided 2026-10-21), aged from the shutdown when placed before it.',
  protocolStatus: {
    state: 'closed',
    evidence: 'Topaz announced it ceased operations on 2024-08-21 (homepage notice; aptos.dev lists Topaz as deprecated). The contract still accepts cancels.',
    checkedAt: '2026-10-19',
    effectiveAt: TOPAZ_CLOSED_AT,
  },
  refresh: { nonZero: 'monthly', zero: 'monthly' },
  // Version 2 (2026-10-21): open bids count. Stored bidders are all re-read once.
  version: 2,
  headlineAgeBases: ['onchain_maturity', 'protocol_closure'],
  howTo: [
    'Topaz\'s site no longer works, so cancel from the bidding account directly:',
    `collection bids: call ${TOPAZ_KINDS.c.cancel}(bid id);`,
    `token bids: call ${TOPAZ_KINDS.a.cancel}(bid id).`,
  ],
  officialUrl: 'https://www.topaz.so',
  read,
};
