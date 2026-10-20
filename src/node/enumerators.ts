// Chain-wide candidate enumeration and source-level sanity checks (node-only: keyed indexer use).
import { mapLimit, normalizeAddress } from '../shared/chain.ts';
import { AMNIS, AMNIS_WITHDRAWAL_COLLECTION } from '../shared/sources/amnis-withdrawals.ts';
import { CANOPY_REWARDS, CANOPY_REWARDS_STATE } from '../shared/sources/canopy-rewards.ts';
import { KAPT, STKAPT } from '../shared/sources/kofi-receipts.ts';
import { KOFI } from '../shared/sources/kofi-withdrawals.ts';
import { CAKE, type ClaimableHint, claimableHandle, LZ_COINS } from '../shared/sources/layerzero-claimable.ts';
import { MKLP } from '../shared/sources/merkle-mklp.ts';
import { chefState, MASTERCHEF, MASTERCHEF_END_VERSION } from '../shared/sources/pancake-farm.ts';
import { poolState, SMART_CHEF, SYRUP_POOLS } from '../shared/sources/pancake-syrup.ts';
import { VEMKL_COLLECTION } from '../shared/sources/merkle-vemkl.ts';
import { THALA_VE, THALA_VEST } from '../shared/sources/thala-thl.ts';
import { THALA_LSD } from '../shared/sources/thala-unstake.ts';
import { TORTUGA, TORTUGA_STATE } from '../shared/sources/tortuga-tickets.ts';
import { TRUFIN, unlockTable } from '../shared/sources/trufin-unlocks.ts';
import { TOPAZ, type TopazBid, type TopazHint, type TopazKind, topazTables, u64Key } from '../shared/sources/topaz-bids.ts';
import type { Sanity } from '../shared/snapshot.ts';
import type { ChainReader, Ledger, Position } from '../shared/types.ts';

export interface Candidate { owner: string; hint?: unknown }

export interface Enumeration {
  candidates: Candidate[];
  cursor?: string;
  pages: number;
  /** True when every returned candidate had new activity since the stored cursor (so it is due for a read). */
  incremental?: boolean;
}

export interface Enumerator {
  sourceId: string;
  /** Indexer processor whose watermark bounds the enumeration; null when only the fullnode is read. */
  processor: string | null;
  /** Named enumeration scope; "complete" means complete within this, never chain-wide. */
  scope: string;
  run(chain: ChainReader, cursor: string | undefined): Promise<Enumeration>;
  sanity?(chain: ChainReader, ledger: Ledger, positions: Position[]): Promise<Sanity>;
}

const PAGE = 100;   // the indexer silently caps page size at 100

// Keyset over (delegator, pool, table_handle) inside 16 address-prefix ranges; offsets are unstable on a live table.
const DELEGATION_QUERY = `query($lo:String!,$hi:String!,$d:String!,$p:String!,$t:String!){
  current_delegator_balances(where:{pool_type:{_eq:"inactive_shares"}, shares:{_gt:"0"}, delegator_address:{_gte:$lo,_lt:$hi},
    _or:[{delegator_address:{_gt:$d}}, {delegator_address:{_eq:$d}, pool_address:{_gt:$p}},
         {delegator_address:{_eq:$d}, pool_address:{_eq:$p}, table_handle:{_gt:$t}}]},
    order_by:[{delegator_address:asc},{pool_address:asc},{table_handle:asc}], limit:${PAGE}){
    delegator_address pool_address table_handle last_transaction_version } }`;

const delegationEnumeratorFor = (sourceId: string): Enumerator => ({
  sourceId,
  processor: 'stake_processor',
  scope: 'current_delegator_balances rows with pool_type=inactive_shares and shares>0 (stake_processor)',
  async run(chain) {
    const hex = '0123456789abcdef';
    let pages = 0;
    const rows = (await mapLimit([...hex], 8, async (h, i) => {
      const out: any[] = [];
      let cursor = { d: '', p: '', t: '' };
      for (;;) {
        const page = (await chain.gql(DELEGATION_QUERY, { lo: '0x' + h, hi: i < 15 ? '0x' + hex[i + 1] : '0xg', ...cursor })).current_delegator_balances;
        pages++;
        out.push(...page);
        if (page.length < PAGE) return out;
        const last = page[page.length - 1];
        cursor = { d: last.delegator_address, p: last.pool_address, t: last.table_handle };
      }
    })).flat();
    const pools = new Map<string, { set: Set<string>; version: number }>();
    for (const r of rows) {
      const owner = normalizeAddress(r.delegator_address);
      const entry = pools.get(owner) ?? { set: new Set<string>(), version: 0 };
      entry.set.add(normalizeAddress(r.pool_address));
      entry.version = Math.max(entry.version, Number(r.last_transaction_version));
      pools.set(owner, entry);
    }
    // The latest row version is in the hint so that any change to an owner's rows marks the owner due.
    return { candidates: [...pools].map(([owner, e]) => ({ owner, hint: { pools: [...e.set].sort(), version: e.version } })), pages };
  },
  async sanity(chain, ledger, positions) {
    const perPool = new Map<string, bigint>();
    for (const p of positions) {
      if (!p.locator.endsWith('/inactive')) continue;
      const pool = p.locator.split('/')[0];
      perPool.set(pool, (perPool.get(pool) ?? 0n) + BigInt(p.grossClaim[0].raw));
    }
    const violations: string[] = [];
    await mapLimit([...perPool], 8, async ([pool, sum]) => {
      const [, inactive] = (await chain.view('0x1::stake::get_stake', [pool], [], ledger.version)).map(BigInt);
      if (sum > inactive + 1000n) violations.push(`${pool}: delegators ${sum} > pool inactive ${inactive}`);
    });
    return { check: 'per pool: sum of delegator inactive stake <= stake::get_stake(pool).inactive', ok: violations.length === 0,
      detail: violations.length ? violations.slice(0, 10).join('; ') : `${perPool.size} pools, 0 violations` };
  },
});
export const delegationEnumerator = delegationEnumeratorFor('native-delegation');
export const movementDelegationEnumerator = delegationEnumeratorFor('movement-native-delegation');

const SENDERS_QUERY = `query($c:String!,$m:String!,$f:String!,$after:bigint!,$until:bigint!){
  user_transactions(where:{entry_function_contract_address:{_eq:$c}, entry_function_module_name:{_eq:$m},
    entry_function_function_name:{_eq:$f}, version:{_gt:$after, _lte:$until}}, order_by:{version:asc}, limit:${PAGE}){ version sender } }`;

/** An entry function whose senders are candidates. `untilVersion` ends the scan where later calls cannot matter
 *  (for example deposits into pools that had already ended). */
type EntryFunction = { contract: string; module: string; name: string; untilVersion?: number };
const NO_LIMIT = '9223372036854775807';

/** New senders of entry functions since per-function version cursors (stored as one JSON object). Only the
 *  (contract, module, function) filter is indexed; entry_function_id_str alone times out. */
async function senders(chain: ChainReader, fns: EntryFunction[], cursor: string | undefined): Promise<Enumeration> {
  let cursors: Record<string, string> = {};
  try { cursors = cursor ? JSON.parse(cursor) : {}; } catch { /* unreadable cursor: rescan from the start */ }
  if (typeof cursors !== 'object' || cursors === null) cursors = {};
  const owners = new Set<string>();
  let pages = 0;
  for (const fn of fns) {
    const key = `${fn.contract}::${fn.module}::${fn.name}`;
    let after = cursors[key] ?? '0';
    for (;;) {
      const page = (await chain.gql(SENDERS_QUERY, { c: fn.contract, m: fn.module, f: fn.name, after, until: String(fn.untilVersion ?? NO_LIMIT) })).user_transactions;
      pages++;
      page.forEach((t: any) => owners.add(normalizeAddress(t.sender)));
      if (page.length) after = String(page[page.length - 1].version);
      if (page.length < PAGE) break;
    }
    cursors[key] = after;
  }
  return { candidates: [...owners].map(owner => ({ owner })), cursor: JSON.stringify(cursors), pages, incremental: true };
}

function entrySenders(sourceId: string, fns: EntryFunction[], sanity: Enumerator['sanity']): Enumerator {
  return {
    sourceId,
    processor: 'user_transaction_processor',
    scope: `senders of ${fns.map(f => `${f.contract}::${f.module}::${f.name}${f.untilVersion ? ` up to version ${f.untilVersion}` : ''}`).join(', ')} entry calls (calls made by other contracts excluded)`,
    run: (chain, cursor) => senders(chain, fns, cursor),
    sanity,
  };
}

const sumGross = (positions: Position[]) => positions.reduce((s, p) => s + BigInt(p.grossClaim[0].raw), 0n);
const pct = (part: bigint, whole: bigint) => (whole ? (Number(part * 10_000n / whole) / 100).toFixed(2) : '0') + '%';

export const thalaUnstakeEnumerator = entrySenders('thala-unstake',
  [{ contract: THALA_LSD, module: 'scripts', name: 'request_unstake_APT' }],
  async (chain, ledger, positions) => {
    const tlsd = await chain.resource(THALA_LSD, `${THALA_LSD}::staking::TLSD`, ledger.version);
    const held = BigInt(tlsd.apt_pending_withdrawal.value), matured = sumGross(positions);
    return { check: 'matured requests found <= TLSD.apt_pending_withdrawal (APT held for claims)', ok: matured <= held,
      detail: `matured ${matured} of ${held} held (${pct(matured, held)})` };
  });

export const kofiWithdrawalsEnumerator = entrySenders('kofi-withdrawals',
  [{ contract: KOFI, module: 'gateway', name: 'request_withdrawal_entry' },
   { contract: KOFI, module: 'gateway', name: 'unstake_and_request_withdrawal_entry' }],
  async (chain, ledger, positions) => {
    const [unlocked] = await chain.view(`${KOFI}::vault::get_unlocked_apt_balance`, [], [], ledger.version);
    const held = BigInt(unlocked), matured = sumGross(positions);
    // Not a hard ceiling: matured tickets can wait for APT still unlocking from validators.
    return { check: 'matured tickets found vs vault::get_unlocked_apt_balance (APT ready for withdrawals)', ok: null,
      detail: `matured ${matured} vs ${held} unlocked (${pct(matured, held)})` };
  });

export const tortugaTicketsEnumerator = entrySenders('tortuga-tickets',
  [{ contract: TORTUGA, module: 'stake_router', name: 'unstake' }],
  async (chain, ledger, positions) => {
    const status = await chain.resource(TORTUGA_STATE, `${TORTUGA}::stake_router::StakingStatus`, ledger.version);
    const outstanding = BigInt(status.total_claims_balance) - BigInt(status.total_claims_balance_cleared), found = sumGross(positions);
    return { check: 'tickets found <= outstanding claims (total_claims_balance - total_claims_balance_cleared)', ok: found <= outstanding,
      detail: `found ${found} of ${outstanding} outstanding (${pct(found, outstanding)})` };
  });

// Keyset on token_data_id; a token can only have one current owner with amount > 0 (non-fungible).
const COLLECTION_QUERY = `query($c:String!,$after:String!){ current_token_ownerships_v2(where:{current_token_data:{collection_id:{_eq:$c}},
  amount:{_gt:"0"}, token_data_id:{_gt:$after}}, order_by:{token_data_id:asc}, limit:${PAGE}){ token_data_id owner_address } }`;

/** Current owners of every token in a collection, with their token ids as the read hint. */
function collectionOwners(sourceId: string, collection: string, sanity: Enumerator['sanity']): Enumerator {
  return {
    sourceId,
    processor: 'token_v2_processor',
    scope: `current owners of tokens in collection ${collection} (current_token_ownerships_v2, amount > 0)`,
    async run(chain) {
      const tokens = new Map<string, string[]>();
      let after = '', pages = 0;
      for (;;) {
        const page = (await chain.gql(COLLECTION_QUERY, { c: collection, after })).current_token_ownerships_v2;
        pages++;
        for (const t of page) {
          const owner = normalizeAddress(t.owner_address);
          tokens.set(owner, [...(tokens.get(owner) ?? []), normalizeAddress(t.token_data_id)]);
        }
        if (page.length < PAGE) break;
        after = page[page.length - 1].token_data_id;
      }
      return { candidates: [...tokens].map(([owner, list]) => ({ owner, hint: { tokens: list.sort() } })), pages };
    },
    sanity,
  };
}

export const amnisWithdrawalsEnumerator = collectionOwners('amnis-withdrawals', AMNIS_WITHDRAWAL_COLLECTION,
  async (chain, ledger, positions) => {
    const [pending] = await chain.view(`${AMNIS}::withdrawal::total_pending_withdrawal`, [], [], ledger.version);
    const total = BigInt(pending), matured = sumGross(positions);
    return { check: 'matured withdrawal tokens found <= withdrawal::total_pending_withdrawal (all open tokens)', ok: matured <= total,
      detail: `matured ${matured} of ${total} pending (${pct(matured, total)})` };
  });

// Every delegation pool, then the active-stake delegators of pools whose validator is inactive.
const inactiveValidatorEnumeratorFor = (sourceId: string): Enumerator => ({
  sourceId,
  processor: 'stake_processor',
  scope: 'active_shares rows (shares > 0) in delegation pools whose validator state is inactive (4) at enumeration time',
  async run(chain) {
    let pages = 0, after = '';
    const pools: string[] = [];
    for (;;) {
      const page = (await chain.gql(`query($a:String!){ current_delegated_staking_pool_balances(where:{staking_pool_address:{_gt:$a}},
        order_by:{staking_pool_address:asc}, limit:${PAGE}){ staking_pool_address } }`, { a: after })).current_delegated_staking_pool_balances;
      pages++;
      pools.push(...page.map((p: any) => normalizeAddress(p.staking_pool_address)));
      if (page.length < PAGE) break;
      after = page[page.length - 1].staking_pool_address;
    }
    const ledger = await chain.ledger();
    const states = await mapLimit(pools, 8, async pool => Number((await chain.view('0x1::stake::get_validator_state', [pool], [], ledger.version))[0]));
    const inactive = pools.filter((_, i) => states[i] === 4);
    const owners = new Map<string, { pools: Set<string>; version: number }>();
    for (const pool of inactive) {
      let cursor = '';
      for (;;) {
        const rows = (await chain.gql(`query($p:String!,$a:String!){ current_delegator_balances(where:{pool_address:{_eq:$p}, pool_type:{_eq:"active_shares"},
          shares:{_gt:"0"}, delegator_address:{_gt:$a}}, order_by:{delegator_address:asc}, limit:${PAGE}){ delegator_address last_transaction_version } }`,
          { p: pool, a: cursor })).current_delegator_balances;
        pages++;
        for (const r of rows) {
          const owner = normalizeAddress(r.delegator_address);
          const entry = owners.get(owner) ?? { pools: new Set<string>(), version: 0 };
          entry.pools.add(pool);
          entry.version = Math.max(entry.version, Number(r.last_transaction_version));
          owners.set(owner, entry);
        }
        if (rows.length < PAGE) break;
        cursor = rows[rows.length - 1].delegator_address;
      }
    }
    return { candidates: [...owners].map(([owner, e]) => ({ owner, hint: { pools: [...e.pools].sort(), version: e.version } })), pages };
  },
  async sanity(chain, ledger, positions) {
    const perPool = new Map<string, bigint>();
    for (const p of positions) {
      const pool = p.locator.split('/')[0];
      perPool.set(pool, (perPool.get(pool) ?? 0n) + BigInt(p.grossClaim[0].raw));
    }
    const violations: string[] = [];
    await mapLimit([...perPool], 8, async ([pool, sum]) => {
      const [active] = (await chain.view('0x1::stake::get_stake', [pool], [], ledger.version)).map(BigInt);
      if (sum > active + 1000n) violations.push(`${pool}: delegators ${sum} > pool active ${active}`);
    });
    return { check: 'per pool: sum of delegator active stake <= stake::get_stake(pool).active', ok: violations.length === 0,
      detail: violations.length ? violations.slice(0, 10).join('; ') : `${perPool.size} pools, 0 violations` };
  },
});
export const inactiveValidatorEnumerator = inactiveValidatorEnumeratorFor('delegation-inactive-validator');
export const movementInactiveValidatorEnumerator = inactiveValidatorEnumeratorFor('movement-inactive-validator');

// One global table holds every TruFin unlock request; its owners are the candidates.
export const trufinUnlocksEnumerator: Enumerator = {
  sourceId: 'trufin-unlocks',
  processor: null,
  scope: `every entry of ${TRUFIN}::staker::Unlocks (one global SmartTable), read at a pinned ledger version`,
  async run(chain) {
    const ledger = await chain.ledger();
    const rows = await unlockTable({ chain, ledger, memo: { get: async () => undefined, set: async () => {} }, scratch: new Map() });
    return { candidates: [...new Set(rows.map(r => r.user))].map(owner => ({ owner, hint: { nonces: rows.filter(r => r.user === owner).map(r => r.nonce).sort() } })), pages: 1 };
  },
  async sanity(chain, ledger, positions) {
    const res = await chain.resource(TRUFIN, `${TRUFIN}::staker::Unlocks`, ledger.version);
    return { check: 'claimable requests found vs staker::Unlocks size (all pending requests)', ok: positions.length <= Number(res.unlocks.size),
      detail: `${positions.length} claimable of ${res.unlocks.size} pending` };
  },
};

// Every primary store holding Kofi kAPT or stkAPT, keyset-paged on storage_id.
export const kofiReceiptsEnumerator: Enumerator = {
  sourceId: 'kofi-receipts',
  processor: 'fungible_asset_processor',
  scope: 'primary stores holding Kofi kAPT or stkAPT (current_fungible_asset_balances, amount > 0)',
  async run(chain) {
    const holders = new Map<string, Record<string, number>>();
    let pages = 0;
    for (const asset of [KAPT, STKAPT]) {
      let after = '';
      for (;;) {
        const rows = (await chain.gql(`query($a:String!,$s:String!){ current_fungible_asset_balances(where:{asset_type:{_eq:$a}, is_primary:{_eq:true},
          amount:{_gt:"0"}, storage_id:{_gt:$s}}, order_by:{storage_id:asc}, limit:${PAGE}){ owner_address storage_id last_transaction_version } }`,
          { a: asset, s: after })).current_fungible_asset_balances;
        pages++;
        for (const r of rows) {
          const owner = normalizeAddress(r.owner_address);
          holders.set(owner, { ...(holders.get(owner) ?? {}), [asset]: Number(r.last_transaction_version) });
        }
        if (rows.length < PAGE) break;
        after = rows[rows.length - 1].storage_id;
      }
    }
    return { candidates: [...holders].map(([owner, versions]) => ({ owner, hint: { versions } })), pages };
  },
  async sanity(chain, ledger, positions) {
    const parts: string[] = [];
    let ok = true;
    for (const [asset, symbol] of [[KAPT, 'kAPT'], [STKAPT, 'stkAPT']]) {
      const [supply] = await chain.view('0x1::fungible_asset::supply', [asset], ['0x1::fungible_asset::Metadata'], ledger.version);
      const total = BigInt(supply.vec[0]), found = positions.filter(p => p.asset === asset).reduce((s, p) => s + BigInt(p.grossClaim[0].raw), 0n);
      ok &&= found <= total;
      parts.push(`${symbol} ${found} of ${total} supply (${pct(found, total)})`);
    }
    return { check: 'receipts found in user primary stores <= token supply', ok, detail: parts.join('; ') };
  },
};

// Every store holding Merkle MKLP, in Coin or paired-FA form.
export const merkleMklpEnumerator: Enumerator = {
  sourceId: 'merkle-mklp',
  processor: 'fungible_asset_processor',
  scope: 'stores holding Merkle MKLP (both collateral types, Coin and paired FA; current_fungible_asset_balances, amount > 0)',
  async run(chain) {
    const holders = new Map<string, Record<string, number>>();
    let pages = 0;
    for (const m of MKLP) {
      const [paired] = await chain.view('0x1::coin::paired_metadata', [], [m.coin]);
      const ids = [m.coin, ...(paired?.vec?.[0]?.inner ? [normalizeAddress(paired.vec[0].inner)] : [])];
      let after = '';
      for (;;) {
        const rows = (await chain.gql(`query($a:[String!]!,$s:String!){ current_fungible_asset_balances(where:{asset_type:{_in:$a}, amount:{_gt:"0"},
          storage_id:{_gt:$s}}, order_by:{storage_id:asc}, limit:${PAGE}){ owner_address storage_id last_transaction_version } }`, { a: ids, s: after })).current_fungible_asset_balances;
        pages++;
        for (const r of rows) {
          const owner = normalizeAddress(r.owner_address), prev = holders.get(owner) ?? {};
          holders.set(owner, { ...prev, [m.coin]: Math.max(prev[m.coin] ?? 0, Number(r.last_transaction_version)) });
        }
        if (rows.length < PAGE) break;
        after = rows[rows.length - 1].storage_id;
      }
    }
    return { candidates: [...holders].map(([owner, versions]) => ({ owner, hint: { versions } })), pages };
  },
  async sanity(chain, ledger, positions) {
    const parts: string[] = [];
    let ok = true;
    for (const m of MKLP) {
      const [supply] = await chain.view('0x1::coin::supply', [], [m.coin], ledger.version);
      const total = BigInt(supply.vec[0]), found = positions.filter(p => p.asset === m.coin).reduce((s, p) => s + BigInt(p.grossClaim[0].raw), 0n);
      ok &&= found <= total;
      parts.push(`${m.label} ${found} of ${total} supply (${pct(found, total)})`);
    }
    return { check: 'MKLP found in holder accounts <= MKLP supply', ok, detail: parts.join('; ') };
  },
};

export const merkleVemklEnumerator = collectionOwners('merkle-vemkl', VEMKL_COLLECTION,
  async () => ({ check: 'none', ok: null, detail: 'no contract total available: each lock holds its own stores' }));

// Receivers with a claimable entry in a LayerZero per-coin claimable table. Incremental: only entries written since
// the stored per-coin version cursor are fetched (a claim rewrites or deletes the entry, so it is seen too). The first
// run, with no cursor, reads every live entry.
export const layerzeroClaimableEnumerator: Enumerator = {
  sourceId: 'layerzero-claimable',
  processor: 'default_processor',
  scope: `entries of the LayerZero claimable tables (coin_bridge::CoinStore<T>.claimable_amt_ld, oft::CoinStore<T>.claimable_amount) for ${LZ_COINS.map(c => c.display).join(', ')} (current_table_items)`,
  async run(chain, cursor) {
    let cursors: Record<string, string> = {};
    try { cursors = cursor ? JSON.parse(cursor) : {}; } catch { /* unreadable cursor: full rescan */ }
    if (typeof cursors !== 'object' || cursors === null) cursors = {};
    const ledger = await chain.ledger();
    const ctx = { chain, ledger, memo: { get: async () => undefined, set: async () => {} }, scratch: new Map() };
    const owners = new Map<string, Required<ClaimableHint>>();
    let pages = 0;
    for (const c of LZ_COINS) {
      const handle = await claimableHandle(ctx, c);
      if (!handle) continue;
      const table = await tableRows(chain, handle, cursors[c.coin]);
      pages += table.pages;
      cursors[c.coin] = table.cursor;
      const verify = new Map<number, string[]>(); // write version → owners whose entry will be verified on chain
      for (const r of table.rows) {
        const owner = normalizeAddress(r.decoded_key);
        const amount = r.is_deleted ? '0' : String(r.decoded_value ?? 0);
        const hint = owners.get(owner) ?? { versions: {}, amounts: {}, times: {} };
        hint.versions[c.coin] = Number(r.last_transaction_version);
        hint.amounts[c.coin] = amount;
        owners.set(owner, hint);
        if (BigInt(amount) >= c.verifyMin) verify.set(hint.versions[c.coin], [...verify.get(hint.versions[c.coin]) ?? [], owner]);
      }
      // Credit times for the entries that will be verified, a page of versions per query instead of one per position.
      const { times, pages: timePages } = await versionTimes(chain, [...verify.keys()]);
      pages += timePages;
      for (const [v, list] of verify) for (const owner of list) if (times.has(v)) owners.get(owner)!.times[c.coin] = times.get(v)!;
    }
    return { candidates: [...owners].map(([owner, hint]) => ({ owner, hint })), cursor: JSON.stringify(cursors), pages, incremental: true };
  },
  sanity: async () => ({ check: 'none', ok: null, detail: 'no contract total: claimable amounts are minted on claim' }),
};

const HEX = '0123456789abcdef';

/** Rows of a table: all of them with a parallel keyset over 16 key-prefix ranges when `since` is undefined, else
 *  the rows written after version `since` (version keyset). Returns the highest version seen as the next cursor. */
async function tableRows(chain: ChainReader, handle: string, since: string | undefined): Promise<{ rows: any[]; cursor: string; pages: number }> {
  const rows: any[] = [];
  let pages = 0, cursor = since ?? '0';
  const fields = 'key decoded_key decoded_value is_deleted last_transaction_version';
  if (since === undefined) {
    await mapLimit([...HEX], 8, async (c, i) => {
      let after = `0x${c}`;
      const end = i < 15 ? `0x${HEX[i + 1]}` : '0xg';
      for (;;) {
        const page = (await chain.gql(`query($h:String!,$a:String!,$e:String!){ current_table_items(where:{table_handle:{_eq:$h},
          is_deleted:{_eq:false}, key:{_gt:$a, _lt:$e}}, order_by:{key:asc}, limit:${PAGE}){ ${fields} } }`, { h: handle, a: after, e: end })).current_table_items;
        pages++;
        rows.push(...page);
        if (page.length < PAGE) break;
        after = page[page.length - 1].key;
      }
    });
  } else {
    let k = '';
    for (;;) {
      const page = (await chain.gql(`query($h:String!,$v:bigint!,$k:String!){ current_table_items(where:{table_handle:{_eq:$h},
        _or:[{last_transaction_version:{_gt:$v}}, {last_transaction_version:{_eq:$v}, key:{_gt:$k}}]},
        order_by:[{last_transaction_version:asc},{key:asc}], limit:${PAGE}){ ${fields} } }`, { h: handle, v: cursor, k })).current_table_items;
      pages++;
      rows.push(...page);
      if (page.length) { cursor = String(page[page.length - 1].last_transaction_version); k = page[page.length - 1].key; }
      if (page.length < PAGE) break;
    }
  }
  for (const r of rows) if (BigInt(r.last_transaction_version) > BigInt(cursor)) cursor = String(r.last_transaction_version);
  return { rows, cursor, pages };
}

/** Current rows of a u64-keyed table for the given ids, a page of keys per query. Slow on large tables (no key index:
 *  seconds per query), so only for the few ids an incremental scan needs. */
async function rowsByIds(chain: ChainReader, handle: string, ids: string[]): Promise<{ rows: Map<string, any>; pages: number }> {
  const rows = new Map<string, any>();
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += 20) batches.push(ids.slice(i, i + 20));
  await mapLimit(batches, 4, async batch => {
    const page = (await chain.gql(`query($h:String!,$ks:[String!]!){ current_table_items(where:{table_handle:{_eq:$h}, key:{_in:$ks}},
      limit:${PAGE}){ decoded_key decoded_value is_deleted last_transaction_version } }`, { h: handle, ks: batch.map(id => u64Key(id)) })).current_table_items;
    for (const r of page) rows.set(String(r.decoded_key), r);
  });
  return { rows, pages: batches.length };
}

/** Write times (unix seconds) of transaction versions, a page of versions per query. */
async function versionTimes(chain: ChainReader, versions: number[]): Promise<{ times: Map<number, number>; pages: number }> {
  const times = new Map<number, number>();
  const unique = [...new Set(versions)];
  const batches: number[][] = [];
  for (let i = 0; i < unique.length; i += PAGE) batches.push(unique.slice(i, i + PAGE));
  await mapLimit(batches, 8, async batch => {
    const txs = (await chain.gql(`query($vs:[bigint!]!){ user_transactions(where:{version:{_in:$vs}}, limit:${PAGE}){ version timestamp } }`,
      { vs: batch.map(String) })).user_transactions;
    for (const t of txs) times.set(Number(t.version), Math.floor(Date.parse(t.timestamp + 'Z') / 1000));
  });
  return { times, pages: batches.length };
}

// Topaz bids with their bidder, escrowed APT and deadline, read from the bid tables themselves
// (collection_marketplace::Bids<APT>; bid_any::CoinEscrow<APT> joined to bid_any::Bids for the bidder). Rows are never
// deleted: a cancel or fill rewrites the bid with empty coins, so the per-table version cursors catch every change.
export const topazBidsEnumerator: Enumerator = {
  sourceId: 'topaz-bids',
  processor: 'default_processor',
  scope: `bids in ${TOPAZ}::collection_marketplace::Bids<APT> and ::bid_any::CoinEscrow<APT> (current_table_items)`,
  async run(chain, cursor) {
    let cursors: Record<string, string> = {};
    try { cursors = cursor ? JSON.parse(cursor) : {}; } catch { /* unreadable cursor: full rescan */ }
    if (typeof cursors !== 'object' || cursors === null) cursors = {};
    const ledger = await chain.ledger();
    const ctx = { chain, ledger, memo: { get: async () => undefined, set: async () => {} }, scratch: new Map() };
    const tables = await topazTables(ctx);
    const hints = new Map<string, TopazHint>();
    const add = (buyer: string, kind: TopazKind, id: string, bid: TopazBid) => {
      const owner = normalizeAddress(buyer);
      const hint = hints.get(owner) ?? {};
      hint[kind] = { ...hint[kind], [id]: bid };
      hints.set(owner, hint);
    };
    const full = !cursors.c && !cursors.a && !cursors.b;
    const deadlineOf = (v: any) => v?.deadline !== undefined ? Math.floor(Number(v.deadline) / 1e6) : undefined;
    let pages = 0;
    const scan = async (key: string, handle: string) => {
      const t = await tableRows(chain, handle, cursors[key]);
      pages += t.pages;
      cursors[key] = t.cursor;
      return t.rows.filter(r => !r.is_deleted);
    };

    for (const r of await scan('c', tables.c.store)) {
      const v = r.decoded_value;
      add(v.buyer, 'c', String(r.decoded_key), { raw: String(v.coins?.value ?? 0), deadline: deadlineOf(v) });
    }
    const escrow = await scan('a', tables.a.store);
    const details = new Map((await scan('b', tables.anyBids)).map(r => [String(r.decoded_key), r.decoded_value]));
    const missing = escrow.map(r => String(r.decoded_key)).filter(id => !details.has(id));
    if (missing.length) {
      const looked = await rowsByIds(chain, tables.anyBids, missing);
      pages += looked.pages;
      for (const [id, r] of looked.rows) if (!r.is_deleted) details.set(id, r.decoded_value);
    }
    for (const r of escrow) {
      const id = String(r.decoded_key), d = details.get(id);
      if (!d?.buyer) continue;   // bidder unknown: counted nowhere (the bid row is never deleted, so this should not happen)
      add(d.buyer, 'a', id, { raw: String(r.decoded_value?.value ?? 0), deadline: deadlineOf(d) });
    }
    // A full scan keeps only bidders with escrowed coins; an incremental one keeps every change (a cancel empties a bid).
    const owners = [...hints].filter(([, h]) => !full || Object.values(h).some(m => Object.values(m).some(b => BigInt(b.raw) > 0n)));
    return { candidates: owners.map(([owner, hint]) => ({ owner, hint })), cursor: JSON.stringify(cursors), pages, incremental: true };
  },
  sanity: async () => ({ check: 'none', ok: null, detail: 'no contract total: each bid holds its own coins' }),
};

// Canopy stakers on Movement: every key of multi_rewards' user_staked_balances table (staker → staked tokens). The
// table key is not decoded by the indexer; it is the staker's address. Incremental by version: a stake or withdraw
// rewrites the staker's row. Claims do not, so stakers are also re-read monthly.
export const canopyEndedRewardsEnumerator: Enumerator = {
  sourceId: 'canopy-ended-rewards',
  processor: 'default_processor',
  scope: `stakers in ${CANOPY_REWARDS}::multi_rewards (MultiRewardsModule.user_staked_balances, current_table_items)`,
  async run(chain, cursor) {
    const state = await chain.resource(CANOPY_REWARDS_STATE, `${CANOPY_REWARDS}::multi_rewards::MultiRewardsModule`);
    if (!state) throw new Error('Canopy MultiRewardsModule missing');
    const table = await tableRows(chain, normalizeAddress(state.user_staked_balances.handle), cursor || undefined);
    return { candidates: [...new Set(table.rows.map(r => normalizeAddress(r.key)))].map(owner => ({ owner })), cursor: table.cursor, pages: table.pages, incremental: true };
  },
  sanity: async () => ({ check: 'none', ok: null, detail: 'no contract total: earned rewards are computed per staker' }),
};

// Senders of smart_chef::deposit: everyone who staked in a PancakeSwap (Aptos) CAKE syrup pool.
// Deposits after the last CAKE pool ended (version ~444.55M, 2024-02-09 14:05 UTC) only went to the Gui Inu pools.
export const pancakeSyrupEnumerator = entrySenders('pancake-syrup-ended', [{ contract: SMART_CHEF, module: 'smart_chef', name: 'deposit', untilVersion: 444_552_000 }],
  async (chain, ledger, positions) => {
    const parts: string[] = [];
    let ok = true;
    const ctx = { chain, ledger, memo: { get: async () => undefined, set: async () => {} }, scratch: new Map() };
    for (const pool of SYRUP_POOLS) {
      const { staked } = await poolState(ctx, pool);
      const found = sumGross(positions.filter(p => p.locator === `pool-${pool.uid}` && p.positionKind === 'principal'));
      ok &&= found <= staked;
      if (staked > 0n) parts.push(`${pool.uid} ${pct(found, staked)}`);
    }
    return { check: 'stake found per pool <= pool total_staked_token', ok, detail: parts.join('; ') };
  });

// Senders of masterchef::deposit up to the end of emissions; a later deposit harvests, so later depositors have
// nothing pending.
export const pancakeFarmEnumerator = entrySenders('pancake-farm-ended-rewards',
  [{ contract: MASTERCHEF, module: 'masterchef', name: 'deposit', untilVersion: MASTERCHEF_END_VERSION }],
  async (chain, ledger, positions) => {
    const ctx = { chain, ledger, memo: { get: async () => undefined, set: async () => {} }, scratch: new Map() };
    const { cakeLeft } = await chefState(ctx);
    const found = sumGross(positions.filter(p => p.asset === CAKE));
    return { check: 'pending CAKE found <= CAKE held by MasterChef', ok: found <= cakeLeft, detail: `${found} of ${cakeLeft} (${pct(found, cakeLeft)})` };
  });

const noContractTotal: Enumerator['sanity'] = async () =>
  ({ check: 'none', ok: null, detail: 'no contract total available: balances are stored per account' });

export const thalaVethlEnumerator = entrySenders('thala-vethl-expired',
  [{ contract: THALA_VE, module: 'scripts', name: 'lock' }, { contract: THALA_VEST, module: 'farming_vesting', name: 'convert_to_vethl' }],
  noContractTotal);

export const thalaVestingEnumerator = entrySenders('thala-vesting-matured',
  [{ contract: THALA_VEST, module: 'farming_vesting', name: 'start_vesting' }],
  noContractTotal);

export const ENUMERATORS: Enumerator[] = [delegationEnumerator, thalaUnstakeEnumerator, kofiWithdrawalsEnumerator, tortugaTicketsEnumerator,
  amnisWithdrawalsEnumerator, thalaVethlEnumerator, thalaVestingEnumerator, inactiveValidatorEnumerator,
  trufinUnlocksEnumerator, movementDelegationEnumerator, movementInactiveValidatorEnumerator, kofiReceiptsEnumerator,
  merkleMklpEnumerator, merkleVemklEnumerator, layerzeroClaimableEnumerator, canopyEndedRewardsEnumerator, pancakeSyrupEnumerator, topazBidsEnumerator, pancakeFarmEnumerator];
