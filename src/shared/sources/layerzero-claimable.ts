// LayerZero (v1) transfers to Aptos that arrived but were never claimed. When a receiver could not take the coin at
// delivery (no CoinStore registered), the app credits a claimable table and the receiver collects it later:
// - LayerZero Aptos Bridge (lzUSDC, lzUSDT, lzWETH…): coin_bridge::CoinStore<T>.claimable_amt_ld, coin_bridge::claim_coin<T>;
// - OFT coins on LayerZero's shared OFT module (CAKE, BTC.b): oft::CoinStore<T>.claimable_amount at T's address, oft::claim<T>.
import { iso, positionIds } from '../accounting.ts';
import { mapLimit, normalizeAddress, once, transactionTime } from '../chain.ts';
import type { Position, ReadContext, ReadResult, SourceDef } from '../types.ts';

export const LZ_BRIDGE = '0xf22bede237a07e121b56d91a491eb7bcdfd1f5907926a9e58338f964a01b17fa';
const LZ_OFT = '0x43d8cad89263e6936921a0adb8d5d49f0e236c229460f01b14dca073114df2b9';
export const CAKE = '0x159df6b7689437016108a019fd5bef736bac692b6d4a1f10c941f6fbb9a74ca6::oft::CakeOFT';
export const BTCB = '0x8b107b816356295ea62750020edea701bfc6d11575953d0e146c20d7b9409300::oft::BTCbOFT';
const SOURCE = 'layerzero-claimable';

/** A coin with a claimable table. `verifyMin` (raw units, roughly $1): smaller indexed entries are not verified on
 *  chain (most of the tables is dust) and are listed as indexer_only, which keeps them out of every total. */
export type LzCoin = { symbol: string; display: string; coin: string; decimals: number; verifyMin: bigint;
  store: { address: string; type: string; field: string }; claim: string };

const bridgeCoin = (symbol: string, verifyMin: bigint): LzCoin => {
  const coin = `${LZ_BRIDGE}::asset::${symbol}`;
  return { symbol, display: `lz${symbol}`, coin, decimals: 6, verifyMin,
    store: { address: LZ_BRIDGE, type: `${LZ_BRIDGE}::coin_bridge::CoinStore<${coin}>`, field: 'claimable_amt_ld' },
    claim: `${LZ_BRIDGE}::coin_bridge::claim_coin<${coin}>` };
};
const oftCoin = (symbol: string, coin: string, verifyMin: bigint): LzCoin => ({ symbol, display: symbol, coin, decimals: 8, verifyMin,
  store: { address: coin.split('::')[0], type: `${LZ_OFT}::oft::CoinStore<${coin}>`, field: 'claimable_amount' },
  claim: `${LZ_OFT}::oft::claim<${coin}>` });

export const LZ_COINS: LzCoin[] = [
  bridgeCoin('USDC', 1_000_000n), bridgeCoin('USDT', 1_000_000n), bridgeCoin('WETH', 500n), bridgeCoin('WBTC', 20n), bridgeCoin('USDD', 1_000_000n),
  oftCoin('CAKE', CAKE, 50_000_000n), oftCoin('BTC.b', BTCB, 1_000n),
];

/** coin type → version at which the receiver's claimable entry was last written, its indexed amount, and the
 *  write's time (unix seconds; only for entries above verifyMin). */
export type ClaimableHint = { versions: Record<string, number>; amounts?: Record<string, string>; times?: Record<string, number> };

/** Short address form, as the indexer's decoded_key stores it. */
export const shortAddress = (a: string) => '0x' + (normalizeAddress(a).slice(2).replace(/^0+/, '') || '0');

/** The coin's claimable table handle, zero-padded to 64 hex digits: the indexer stores handles that way and the
 *  fullnode returns them without leading zeros. */
export function claimableHandle(ctx: ReadContext, c: LzCoin): Promise<string | null> {
  return once(ctx, `lz-claimable:${c.coin}:${ctx.ledger.version}`, async () => {
    const handle = (await ctx.chain.resource(c.store.address, c.store.type, ctx.ledger.version))?.[c.store.field]?.handle;
    return handle ? normalizeAddress(handle) : null;
  });
}

const ENTRY_QUERY = `query($h:String!,$k:jsonb){ current_table_items(where:{table_handle:{_eq:$h}, decoded_key:{_eq:$k}, is_deleted:{_eq:false}}){ last_transaction_version } }`;

async function read(ctx: ReadContext, ownerInput: string, hint?: ClaimableHint): Promise<ReadResult> {
  const owner = normalizeAddress(ownerInput);
  const version = ctx.ledger.version;
  const errors: string[] = [];
  let failed = 0;
  const coins = hint ? LZ_COINS.filter(c => hint.versions[c.coin] !== undefined) : LZ_COINS;
  const found = await mapLimit(coins, 3, async (c): Promise<Position | null> => {
    try {
      const indexed = hint?.amounts?.[c.coin];
      if (indexed === '0') return null; // claimed: the indexer saw the entry deleted
      if (indexed !== undefined && BigInt(indexed) < c.verifyMin) {
        const dust = [{ asset: c.coin, raw: indexed }];
        return {
          ...positionIds(SOURCE, owner, c.symbol, 'principal', c.coin), source: SOURCE, owner, locator: c.symbol, positionKind: 'principal', asset: c.coin,
          ageBasis: 'unknown', provenance: { reader: 'indexer current_table_items', ledgerVersion: version },
          grossClaim: dust, expectedPayout: dust, payoutBasis: 'view', status: 'recoverable', blockers: [],
          confidence: 'indexer_only', observedAt: iso(ctx.ledger.timestampSecs),
          steps: [{ function: c.claim, arguments: [], prerequisites: [], expectedOutputs: dust }],
        };
      }
      const handle = await claimableHandle(ctx, c);
      if (!handle) return null;
      const raw = await ctx.chain.tableItem(handle, 'address', 'u64', owner, version);
      const amount = BigInt(raw ?? 0);
      if (amount === 0n) return null;
      // Credited when the bridge wrote the entry; later credits move the date forward, never back.
      const written = hint?.versions[c.coin] ??
        (await ctx.chain.gql(ENTRY_QUERY, { h: handle, k: shortAddress(owner) })).current_table_items[0]?.last_transaction_version;
      const since = hint?.times?.[c.coin] ?? (written !== undefined ? await transactionTime(ctx.chain, written) : null);
      const value = [{ asset: c.coin, raw: amount.toString() }];
      return {
        ...positionIds(SOURCE, owner, c.symbol, 'principal', c.coin), source: SOURCE, owner, locator: c.symbol, positionKind: 'principal', asset: c.coin,
        claimableSince: since !== null ? iso(since) : undefined, ageBasis: since !== null ? 'onchain_maturity' : 'unknown',
        provenance: { reader: `${c.store.type}.${c.store.field}`, ledgerVersion: version },
        grossClaim: value, expectedPayout: value, payoutBasis: 'view', status: 'recoverable', blockers: [],
        confidence: 'verified_view', observedAt: iso(ctx.ledger.timestampSecs),
        steps: [{ function: c.claim, arguments: [], prerequisites: [], expectedOutputs: value }],
      };
    } catch (err) {
      failed++;
      errors.push(`${c.symbol}: ${String(err).slice(0, 200)}`);
      return null;
    }
  });
  return { positions: found.filter((p): p is Position => p !== null), complete: failed === 0, errors, ledgerVersion: version };
}

export const layerzeroClaimable: SourceDef<ClaimableHint> = {
  id: SOURCE,
  chain: 'aptos',
  protocol: 'LayerZero',
  title: 'LayerZero bridge transfer never claimed',
  summary: 'Tokens bridged to Aptos through LayerZero (lzUSDC, lzUSDT, lzWETH… on the LayerZero Aptos Bridge; CAKE and BTC.b) arrived but could not be delivered, so the bridge holds them until you claim.',
  category: 'bridge',
  inclusionRule: 'R2 ended position: the bridge transfer completed on Aptos and is waiting in the app\'s claimable storage.',
  protocolStatus: { state: 'live', evidence: 'LayerZero Aptos Bridge coin_bridge and LayerZero OFT modules respond.', checkedAt: '2026-10-19' },
  // A claim always rewrites the table entry, which the incremental scan picks up; nothing changes on its own in between.
  refresh: { nonZero: 'monthly', zero: 'monthly' },
  headlineAgeBases: ['onchain_maturity'],
  howTo: [
    'Claim in the LayerZero Aptos Bridge app (lz coins), or',
    `call the claim function from the receiving account: ${LZ_BRIDGE}::coin_bridge::claim_coin<coin type>() for lz coins, ${LZ_OFT}::oft::claim<coin type>() for CAKE and BTC.b.`,
  ],
  officialUrl: 'https://theaptosbridge.com',
  read,
};
