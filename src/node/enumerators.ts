// Chain-wide candidate enumeration and source-level sanity checks (node-only: keyed indexer use).
import { mapLimit, normalizeAddress } from '../shared/chain.ts';
import { AMNIS, AMNIS_WITHDRAWAL_COLLECTION } from '../shared/sources/amnis-withdrawals.ts';
import { KOFI } from '../shared/sources/kofi-withdrawals.ts';
import { THALA_VE, THALA_VEST } from '../shared/sources/thala-thl.ts';
import { THALA_LSD } from '../shared/sources/thala-unstake.ts';
import { TORTUGA, TORTUGA_STATE } from '../shared/sources/tortuga-tickets.ts';
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
  processor: string;
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

export const delegationEnumerator: Enumerator = {
  sourceId: 'native-delegation',
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
};

const SENDERS_QUERY = `query($c:String!,$m:String!,$f:String!,$after:bigint!){
  user_transactions(where:{entry_function_contract_address:{_eq:$c}, entry_function_module_name:{_eq:$m},
    entry_function_function_name:{_eq:$f}, version:{_gt:$after}}, order_by:{version:asc}, limit:${PAGE}){ version sender } }`;

type EntryFunction = { contract: string; module: string; name: string };

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
      const page = (await chain.gql(SENDERS_QUERY, { c: fn.contract, m: fn.module, f: fn.name, after })).user_transactions;
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
    scope: `senders of ${fns.map(f => `${f.contract}::${f.module}::${f.name}`).join(', ')} entry calls (calls made by other contracts excluded)`,
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

const noContractTotal: Enumerator['sanity'] = async () =>
  ({ check: 'none', ok: null, detail: 'no contract total available: balances are stored per account' });

export const thalaVethlEnumerator = entrySenders('thala-vethl-expired',
  [{ contract: THALA_VE, module: 'scripts', name: 'lock' }, { contract: THALA_VEST, module: 'farming_vesting', name: 'convert_to_vethl' }],
  noContractTotal);

export const thalaVestingEnumerator = entrySenders('thala-vesting-matured',
  [{ contract: THALA_VEST, module: 'farming_vesting', name: 'start_vesting' }],
  noContractTotal);

export const ENUMERATORS: Enumerator[] = [delegationEnumerator, thalaUnstakeEnumerator, kofiWithdrawalsEnumerator, tortugaTicketsEnumerator,
  amnisWithdrawalsEnumerator, thalaVethlEnumerator, thalaVestingEnumerator];
