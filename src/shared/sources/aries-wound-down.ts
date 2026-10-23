// Aries Markets (Aptos lending): deposits left in Aries after its wind-down. app.ariesmarkets.xyz serves only a notice
// ("Aries Markets was wound down in July 2026"), and Aries's admin multisig moved most reserves' cash out between
// 2026-06-26 and 2026-08-17. The contract still quotes each deposit at its reserve's LP rate, far below what was deposited
// for most reserves, and a withdrawal aborts when the reserve lacks the cash or when the profile still supplies another
// reserve whose oracle price is stale (nobody updates them). Check-only (decided 2026-10-22): re-reading all ~455K
// profiles each run would cost ~285K reads, so the pipeline does not enumerate it and it has no dashboard totals.
import { iso, positionIds } from '../accounting.ts';
import { normalizeAddress, once } from '../chain.ts';
import type { Amount, Position, ReadContext, ReadResult, SourceDef } from '../types.ts';
import { assetOf } from './animeswap-closed.ts';

export const ARIES = '0x9770fa9c725cbd97eb50b2be5f7416efdfd1f1554beb0750d4dae4c64e860da3';
/** End of July 2026: the notice gives only the month. */
export const ARIES_CLOSED_AT = '2026-07-31T23:59:59Z';
/** Profiles read per owner (an owner can name several; nearly all have one). */
const MAX_PROFILES = 32;
const U64_MAX = '18446744073709551615';
const KEY_TYPE = '0x1::type_info::TypeInfo';
const SOURCE = 'aries-wound-down';

const utf8 = (hex: string) => new TextDecoder().decode(Uint8Array.from(hex.slice(2).match(/../g) ?? [], h => parseInt(h, 16)));
const hex = (text: string) => '0x' + [...new TextEncoder().encode(text)].map(b => b.toString(16).padStart(2, '0')).join('');

/** A reserve's coin type from its `TypeInfo` key (module and struct names are hex); framework types keep `0x1`. */
export function reserveType(info: { account_address: string; module_name: string; struct_name: string }): string {
  const a = normalizeAddress(info.account_address);
  return `${a === normalizeAddress('0x1') ? '0x1' : a}::${utf8(info.module_name)}::${utf8(info.struct_name)}`;
}

/** The reserve types in one of a profile's linked tables (`deposited_reserves` or `borrowed_reserves`), head to tail.
 *  The tail's own entry is not fetched: it has no successor. */
async function walk(ctx: ReadContext, table: any, struct: 'Deposit' | 'Loan'): Promise<string[]> {
  const length = Number(table.inner.length);
  if (!length) return [];
  const handle = table.inner.inner.handle, tail = table.tail.vec[0];
  const valueType = `${ARIES}::iterable_table::IterableValue<${KEY_TYPE}, ${ARIES}::profile::${struct}>`;
  const out: string[] = [];
  let key = table.head.vec[0];
  for (let i = 0; i < length; i++) {
    if (!key) throw new Error('Aries reserve table ends before its length');
    out.push(reserveType(key));
    if (i === length - 1) break;
    const entry = await ctx.chain.tableItem(handle, KEY_TYPE, valueType, key, ctx.ledger.version);
    key = entry?.next?.vec?.[0];
  }
  if (!tail || out.at(-1) !== reserveType(tail)) throw new Error('Aries reserve table does not end at its tail');
  return out;
}

/** A reserve's payout asset: the fungible asset behind an Aries wrapper coin, else the coin itself. */
const assetOfReserve = (ctx: ReadContext, type: string) => once(ctx, `aries-asset:${type}`, async () => {
  if (!type.startsWith(`${ARIES}::`)) return assetOf(type);
  const info = await ctx.chain.resource(ARIES, `${ARIES}::fa_to_coin_wrapper::WrapperCoinInfo<${type}>`, ctx.ledger.version);
  if (!info) throw new Error(`Aries wrapper ${type} missing`);
  return normalizeAddress(info.metadata.inner ?? info.metadata);
});

/** The first version after the wind-down's end of day (the block at 2026-08-01 00:00:00 UTC, read from the archive). */
const ARIES_CLOSED_VERSION = '6554002069';
const LATE_TXS_QUERY = `query($o:String!,$v:bigint!,$before:bigint!){ user_transactions(where:{sender:{_eq:$o}, version:{_gte:$v, _lt:$before}},
  order_by:{version:desc}, limit:100){ version entry_function_id_str } }`;
const DEPOSITS = new Set(['deposit', 'deposit_fa'].map(f => `${ARIES}::controller::${f}`));
/** Owners with more transactions since the wind-down than this many pages are not searched: their age is unknown. */
const LATE_PAGES = 10;

/** Whether the owner deposited into Aries after the wind-down (Aries still takes deposits): its deposits are then not all
 *  from before it, so their ages are unknown. Its transactions since then, newest first (filtering by function
 *  times out; by sender and version it does not). */
async function depositedLate(ctx: ReadContext, owner: string): Promise<boolean> {
  let before = String(BigInt(ctx.ledger.version) + 1n);
  for (let page = 0; page < LATE_PAGES; page++) {
    const rows: { version: string; entry_function_id_str: string | null }[] =
      (await ctx.chain.gql(LATE_TXS_QUERY, { o: owner, v: ARIES_CLOSED_VERSION, before })).user_transactions;
    if (rows.some(r => r.entry_function_id_str && DEPOSITS.has(r.entry_function_id_str))) return true;
    if (rows.length < 100) return false;
    before = String(rows[rows.length - 1].version);
  }
  return true;
}

const reserveState = (ctx: ReadContext, type: string) => once(ctx, `aries-reserve:${type}:${ctx.ledger.version}`, async () => {
  const [s] = await ctx.chain.view(`${ARIES}::reserve::reserve_state`, [], [type], ctx.ledger.version);
  return { cash: BigInt(s.total_cash_available), redeem: !!s.reserve_config.allow_redeem };
});

/** Whether Aries's oracle still prices the reserve: false on its stale-price abort; any other failure is an error. */
const priced = (ctx: ReadContext, type: string) => once(ctx, `aries-price:${type}:${ctx.ledger.version}`, () =>
  ctx.chain.view(`${ARIES}::oracle::get_reserve_price`, [], [type], ctx.ledger.version).then(() => true, err => {
    if (/EORACLE_PRICE_STALE/.test(String(err))) return false;
    throw err;
  }));

async function read(ctx: ReadContext, ownerInput: string): Promise<ReadResult> {
  const owner = normalizeAddress(ownerInput);
  const version = ctx.ledger.version;
  const errors: string[] = [];
  const positions: Position[] = [];
  try {
    const registry = await ctx.chain.resource(owner, `${ARIES}::profile::Profiles`, version);
    const rows: { key: string; value: { account: string } }[] = registry?.profile_signers?.data ?? [];
    if (rows.length > MAX_PROFILES) errors.push(`only ${MAX_PROFILES} of ${rows.length} Aries profiles read`);
    for (const row of rows.slice(0, MAX_PROFILES)) {
      // Profile names are stored with a "profile" prefix; the views and the withdrawal take the bare name.
      const name = row.key.startsWith('profile') ? row.key.slice('profile'.length) : null;
      if (name === null) { errors.push(`unrecognised Aries profile key ${row.key}`); continue; }
      const profile = await ctx.chain.resource(row.value.account, `${ARIES}::profile::Profile`, version);
      if (!profile) { errors.push(`Aries profile ${name} missing`); continue; }
      // R4: a profile with any debt is left out (its deposits are collateral).
      let debt = false;
      for (const type of await walk(ctx, profile.borrowed_reserves, 'Loan')) {
        const [share] = await ctx.chain.view(`${ARIES}::profile::profile_loan`, [owner, name], [type], version);
        if (BigInt(share) > 0n) { debt = true; break; }
      }
      if (debt) continue;
      // Each reserve is read on its own: one that fails leaves the others readable.
      const supplied: { type: string; quote: bigint | null }[] = [];
      // Reserves whose deposit could not be read: still supplied as far as the oracle check below knows.
      const unread: string[] = [];
      for (const type of await walk(ctx, profile.deposited_reserves, 'Deposit')) {
        try {
          const [lp, underlying] = await ctx.chain.view(`${ARIES}::profile::profile_deposit`, [owner, name], [type], version);
          if (BigInt(lp) > 0n) supplied.push({ type, quote: BigInt(underlying) });
        } catch (err) {
          // The quote overflows where the reserve records more than its loans plus cash: the contract cannot quote it,
          // or pay it (phase 0: 2 of ~200 sampled users).
          if (/overflow|ARITHMETIC_ERROR/i.test(String(err))) supplied.push({ type, quote: null });
          else { unread.push(type); errors.push(`Aries ${name || '(main)'}/${type}: ${String(err).slice(0, 200)}`); }
        }
      }
      for (const { type, quote } of supplied) {
        if (quote === 0n) continue;
        try {
          const [asset, state] = await Promise.all([assetOfReserve(ctx, type), reserveState(ctx, type)]);
          // After a withdrawal the contract values what the profile still supplies: only the last reserve left leaves
          // without a fresh price.
          const others = [...supplied.filter(s => s.type !== type).map(s => s.type), ...unread];
          const stale = (await Promise.all(others.map(t => priced(ctx, t)))).some(p => !p);
          const blocker = quote === null ? { code: 'reserve_accounting_negative', detail: 'Aries cannot quote this deposit: the reserve records more than its loans plus cash, so the quote (and a withdrawal) aborts.' }
            : !state.redeem ? { code: 'paused', detail: 'Redemption is disabled for this reserve.' }
            : state.cash < quote ? { code: 'reserves_removed', detail: 'Aries\'s admin moved this reserve\'s cash out (2026-06-26 to 08-17); it holds less than this deposit\'s quote.' }
            : stale ? { code: 'stale_oracle', detail: 'This profile also supplies a reserve whose oracle price is stale; withdrawing aborts until only this reserve is left.' }
            : null;
          const value: Amount[] = quote === null ? [] : [{ asset, raw: quote.toString() }];
          const locator = `${name || '(main)'}/${type}`;
          positions.push({
            ...positionIds(SOURCE, owner, locator, 'principal', asset), source: SOURCE, owner, locator, positionKind: 'principal', asset,
            claimableSince: ARIES_CLOSED_AT, ageBasis: 'protocol_closure',
            provenance: { reader: `${ARIES}::profile::profile_deposit`, ledgerVersion: version },
            grossClaim: value, expectedPayout: blocker ? [] : value, payoutBasis: 'view',
            status: blocker ? 'blocked' : 'recoverable', blockers: blocker ? [blocker] : [],
            confidence: 'verified_view', observedAt: iso(ctx.ledger.timestampSecs),
            // u64 max withdraws everything the profile supplies to the reserve.
            steps: [{ function: `${ARIES}::controller::${type.startsWith(`${ARIES}::`) ? 'withdraw_fa' : 'withdraw'}<${type}>`,
              arguments: [hex(name), U64_MAX, 'false'], prerequisites: [], expectedOutputs: blocker ? [] : value }],
          });
        } catch (err) {
          errors.push(`Aries ${name || '(main)'}/${type}: ${String(err).slice(0, 200)}`);
        }
      }
    }
    // Aged from the wind-down, unless the owner deposited after it (also when the lookup fails: unknown, not wrong).
    if (positions.length && await depositedLate(ctx, owner).catch(() => true))
      for (const p of positions) Object.assign(p, { claimableSince: undefined, ageBasis: 'unknown' });
  } catch (err) {
    return { positions, complete: false, errors: [...errors, String(err).slice(0, 300)], ledgerVersion: version };
  }
  return { positions, complete: errors.length === 0, errors, ledgerVersion: version };
}

export const ariesWoundDown: SourceDef = {
  id: SOURCE,
  chain: 'aptos',
  protocol: 'Aries Markets',
  title: 'Aries deposits left after its wind-down',
  summary: 'Aries Markets wound down in July 2026 and its admin moved most of the lending reserves\' cash out. Deposits are still recorded, but most can no longer be withdrawn.',
  category: 'closed_app',
  inclusionRule: 'R2: Aries wound down in July 2026 (official notice at app.ariesmarkets.xyz). R4: profiles with any debt are left out. Check-only (decided 2026-10-22): no dashboard totals.',
  protocolStatus: {
    state: 'closed',
    evidence: 'app.ariesmarkets.xyz serves only "Aries Markets was wound down in July 2026" (read 2026-10-07). The admin multisig moved reserve cash out in 26 transactions, 2026-06-26 to 08-17 (fungible_asset_activities).',
    checkedAt: '2026-10-22',
    effectiveAt: ARIES_CLOSED_AT,
  },
  refresh: { nonZero: 'monthly', zero: 'monthly' },
  headlineAgeBases: ['protocol_closure'],
  checkOnly: true,
  howTo: [
    `Call ${ARIES}::controller::withdraw<reserve coin>(profile name, ${U64_MAX}, false) for each reserve (withdraw_fa for Aries's wrapped fungible assets); u64 max withdraws everything the profile supplies there.`,
    'It pays the protocol\'s current quote, which for most reserves is a fraction of what was deposited; it aborts where the reserve lacks the cash.',
  ],
  read,
};
