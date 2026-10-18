// Chain-wide candidate enumeration and source-level sanity checks (node-only: keyed indexer use).
import { mapLimit, normalizeAddress } from '../shared/chain.ts';
import { KOFI } from '../shared/sources/kofi-withdrawals.ts';
import { THALA_LSD } from '../shared/sources/thala-unstake.ts';
import type { Sanity } from '../shared/snapshot.ts';
import type { ChainReader, Ledger, Position } from '../shared/types.ts';

export interface Candidate { owner: string; hint?: unknown }

export interface Enumeration {
  candidates: Candidate[];
  cursor?: string;
  pages: number;
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
    delegator_address pool_address table_handle } }`;

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
    const pools = new Map<string, Set<string>>();
    for (const r of rows) {
      const owner = normalizeAddress(r.delegator_address);
      if (!pools.has(owner)) pools.set(owner, new Set());
      pools.get(owner)!.add(normalizeAddress(r.pool_address));
    }
    return { candidates: [...pools].map(([owner, set]) => ({ owner, hint: { pools: [...set].sort() } })), pages };
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
  return { candidates: [...owners].map(owner => ({ owner })), cursor: JSON.stringify(cursors), pages };
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

export const ENUMERATORS: Enumerator[] = [delegationEnumerator, thalaUnstakeEnumerator, kofiWithdrawalsEnumerator];
