// APT escrowed in expired Topaz NFT bids that were never cancelled. Topaz ceased operations on 2024-08-21; a bid's APT
// stays in Topaz's tables until the bidder cancels it, also after its deadline. A bid whose deadline has not passed can
// still be filled by calling the contract, so it is an open order (rule R4) and is not counted:
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

/** Expired: the deadline has passed, so the bid can no longer be filled. */
const expired = (ctx: ReadContext, deadline: number | undefined) => deadline !== undefined && deadline <= ctx.ledger.timestampSecs;

/** An expired bid's position; it ended on its deadline. */
function position(ctx: ReadContext, owner: string, kind: TopazKind, id: string, raw: string, deadline: number, confidence: Position['confidence']): Position {
  const k = TOPAZ_KINDS[kind];
  const locator = `${k.label}:${id}`;
  const value = [{ asset: APT, raw }];
  return {
    ...positionIds(SOURCE, owner, locator, 'principal'), source: SOURCE, owner, locator, positionKind: 'principal', asset: APT,
    claimableSince: confidence === 'indexer_only' ? undefined : iso(deadline),
    ageBasis: confidence === 'indexer_only' ? 'unknown' : 'onchain_maturity',
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
    const ended = kinds.flatMap(k => Object.entries(hint[k] ?? {}).filter(([, b]) => BigInt(b.raw) > 0n && expired(ctx, b.deadline)).map(([id, b]) => ({ k, id, b })));
    if (ended.reduce((s, e) => s + BigInt(e.b.raw), 0n) < TOPAZ_VERIFY_MIN) {
      const positions = ended.map(e => position(ctx, owner, e.k, e.id, e.b.raw, e.b.deadline!, 'indexer_only'));
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
      const indexed: string[] = (await ctx.chain.tableItem(tables[kind].index, 'address', 'vector<u64>', owner, version)) ?? [];
      const known = new Map(Object.entries(hint?.[kind] ?? {}));
      const ids = [...new Set([...indexed.map(String), ...known.keys()])];
      const found = await mapLimit(ids, 3, async (id): Promise<Position | null> => {
        try {
          const v = await ctx.chain.tableItem(tables[kind].store, 'u64', k.value, id, version);
          const raw = BigInt(kind === 'c' ? v?.coins?.value ?? 0 : v?.value ?? 0);
          if (raw === 0n) return null;
          // The deadline is read on chain: an indexed deadline only saves the read for token bids.
          const bid = kind === 'c' ? v : await ctx.chain.tableItem(tables.anyBids, 'u64', `${TOPAZ}::bid_any::Bid`, id, version);
          const deadline = bid?.deadline !== undefined ? Math.floor(Number(bid.deadline) / 1e6) : undefined;
          if (!expired(ctx, deadline)) return null;   // an open order (R4), or no deadline to tell
          return position(ctx, owner, kind, id, raw.toString(), deadline!, 'verified_view');
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
  title: 'Expired Topaz NFT bid never cancelled',
  summary: 'Topaz, an Aptos NFT marketplace, shut down in August 2024. APT you put into a bid stays in Topaz\'s contract after the bid expires, until you cancel it.',
  category: 'closed_app',
  inclusionRule: 'R2 ended position: the bid\'s deadline passed (and Topaz ceased operations on 2024-08-21). Bids not yet expired are open orders (R4) and are not counted.',
  protocolStatus: {
    state: 'closed',
    evidence: 'Topaz announced it ceased operations on 2024-08-21 (homepage notice; aptos.dev lists Topaz as deprecated). The contract still accepts cancels.',
    checkedAt: '2026-10-19',
    effectiveAt: '2024-08-21T00:00:00Z',
  },
  refresh: { nonZero: 'monthly', zero: 'monthly' },
  headlineAgeBases: ['onchain_maturity'],
  howTo: [
    'Topaz\'s site no longer works, so cancel from the bidding account directly:',
    `collection bids: call ${TOPAZ_KINDS.c.cancel}(bid id);`,
    `token bids: call ${TOPAZ_KINDS.a.cancel}(bid id).`,
  ],
  officialUrl: 'https://www.topaz.so',
  read,
};
