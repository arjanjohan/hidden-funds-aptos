// Phase 0, shape 1: native delegation stake that finished unlocking but was never withdrawn.
//
// Enumerate:  indexer current_delegator_balances (inactive_shares, shares > 0), keyset-paged per address prefix.
// Verify:     0x1::delegation_pool::get_stake(pool, delegator) at one pinned ledger version. Indexer rows go stale:
//             a fully redeemed share entry is deleted on chain but can stay in the indexer with shares > 0.
// Age:        latest UnlockStake event for (delegator, pool) → StakePool.locked_until_secs at that version (archive)
//             → claimableSince = max(locked_until, unlock time). Inactive-validator early withdrawals are estimated.
//
// Usage: node --experimental-strip-types --no-warnings spikes/01-delegation.ts [--limit N] [--fresh]
import { existsSync, readFileSync } from 'node:fs';
import { aptUsd, archive, gql, ledger, mapLimit, normalize, processorWatermark, startLog, stats, view, writeJson } from './lib.ts';

const DIR = 'data/delegation';
const args = process.argv.slice(2);
const LIMIT = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity;
const FRESH = args.includes('--fresh');
const CONCURRENCY = 8;
const DAY = 86_400;

type Row = { delegator_address: string; pool_address: string; table_handle: string; parent_table_handle: string; shares: string; last_transaction_version: number };

const ENUM_QUERY = `query($lo:String!,$hi:String!,$d:String!,$p:String!,$t:String!){
  current_delegator_balances(
    where:{pool_type:{_eq:"inactive_shares"}, shares:{_gt:"0"}, delegator_address:{_gte:$lo,_lt:$hi},
      _or:[{delegator_address:{_gt:$d}}, {delegator_address:{_eq:$d}, pool_address:{_gt:$p}},
           {delegator_address:{_eq:$d}, pool_address:{_eq:$p}, table_handle:{_gt:$t}}]},
    order_by:[{delegator_address:asc},{pool_address:asc},{table_handle:asc}], limit:100){
    delegator_address pool_address table_handle parent_table_handle shares last_transaction_version } }`;

async function enumerate(): Promise<{ rows: Row[]; report: object }> {
  const cache = `${DIR}/rows.json`;
  if (!FRESH && existsSync(cache)) return JSON.parse(readFileSync(cache, 'utf8'));
  const before = await processorWatermark('stake_processor');
  const started = new Date().toISOString();
  const hex = '0123456789abcdef'.split('');
  // Address prefixes are paged in parallel; within a prefix the keyset (delegator, pool, table) is strictly increasing.
  const ranges = hex.map((h, i) => ['0x' + h, i < 15 ? '0x' + hex[i + 1] : '0xg']);
  let pages = 0;
  const parts = await mapLimit(ranges, 8, async ([lo, hi]) => {
    const out: Row[] = [];
    let cursor = { d: '', p: '', t: '' };
    for (;;) {
      const page: Row[] = (await gql(ENUM_QUERY, { lo, hi, ...cursor }, 'enumerate')).current_delegator_balances;
      pages++;
      out.push(...page);
      if (page.length < 100) return out;
      const last = page[page.length - 1];
      cursor = { d: last.delegator_address, p: last.pool_address, t: last.table_handle };
    }
  });
  const rows = parts.flat();
  const after = await processorWatermark('stake_processor');
  const report = { query: ENUM_QUERY, pageSize: 100, pages, rows: rows.length, enumerationStart: started, enumerationEnd: new Date().toISOString(),
    processor: 'stake_processor', watermarkBefore: before, watermarkAfter: after,
    scope: 'current_delegator_balances rows with pool_type=inactive_shares and shares>0, served by stake_processor' };
  writeJson(cache, { rows, report });
  return { rows, report };
}

// Latest unlock event for each (delegator, pool); both legacy handle events and module events exist.
async function latestUnlock(delegator: string, pool: string): Promise<number | null> {
  const d = await gql(`query($d:String!,$p:String!){ delegated_staking_activities(where:{delegator_address:{_eq:$d}, pool_address:{_eq:$p},
    event_type:{_in:["0x1::delegation_pool::UnlockStake","0x1::delegation_pool::UnlockStakeEvent"]}}, order_by:{transaction_version:desc}, limit:1){ transaction_version } }`,
    { d: delegator, p: pool }, 'unlock event');
  return d.delegated_staking_activities[0]?.transaction_version ?? null;
}

// Transaction timestamps (seconds) for many versions: indexer in batches of 100, archive for the rest.
async function timestamps(versions: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const unique = [...new Set(versions)];
  const batches = Array.from({ length: Math.ceil(unique.length / 100) }, (_, i) => unique.slice(i * 100, i * 100 + 100));
  await mapLimit(batches, 4, async batch => {
    const d = await gql(`query($v:[bigint!]!){ user_transactions(where:{version:{_in:$v}}, limit:100){ version timestamp } }`, { v: batch }, 'tx timestamps');
    for (const t of d.user_transactions) out.set(Number(t.version), Math.floor(Date.parse(t.timestamp + 'Z') / 1000));
  });
  await mapLimit(unique.filter(v => !out.has(v)), CONCURRENCY, async v => {
    out.set(v, Math.floor(Number((await archive(`/transactions/by_version/${v}`)).timestamp) / 1_000_000));
  });
  return out;
}

// StakePool.locked_until_secs at a past time. A read at time t returning L holds for every time in [t, L]:
// renewal only happens after L. Reads are reused within those intervals, per pool.
function lockupReader() {
  const intervals = new Map<string, { from: number; until: number }[]>();
  let reads = 0, reused = 0;
  return {
    async at(pool: string, version: number, secs: number): Promise<number> {
      const known = intervals.get(pool)?.find(i => i.from <= secs && secs <= i.until);
      if (known) { reused++; return known.until; }
      reads++;
      const until = Number((await archive(`/accounts/${pool}/resource/0x1::stake::StakePool?ledger_version=${version}`)).data.locked_until_secs);
      if (until >= secs) intervals.set(pool, [...(intervals.get(pool) ?? []), { from: secs, until }]);
      return until;
    },
    stats: () => ({ reads, reused }),
  };
}

async function main() {
  const log = startLog('01-delegation');
  const t0 = Date.now();
  const { rows, report: enumReport } = await enumerate();
  const enumMs = Date.now() - t0;

  const pairs = [...new Map(rows.map(r => [`${r.delegator_address}|${r.pool_address}`, r])).values()]
    .map(r => ({ delegator: normalize(r.delegator_address), pool: normalize(r.pool_address) }))
    .slice(0, LIMIT);
  const pools = [...new Set(pairs.map(p => p.pool))];

  const pinned = await ledger();
  const nowSecs = Number(BigInt(pinned.timestampUs) / 1_000_000n);
  const verifyStart = new Date().toISOString();
  const t1 = Date.now();

  // Pool state: early withdrawal allowed when the validator left the set; current lockup; pool totals for the sanity check.
  const poolInfo = new Map<string, { early: boolean | null; lockup: number | null; inactive: bigint | null; pendingInactive: bigint | null; error?: string }>();
  await mapLimit(pools, CONCURRENCY, async pool => {
    try {
      const [early] = await view('0x1::delegation_pool::can_withdraw_pending_inactive', [pool], [], pinned.version);
      const [lockup] = await view('0x1::stake::get_lockup_secs', [pool], [], pinned.version);
      const [, inactive, , pendingInactive] = await view('0x1::stake::get_stake', [pool], [], pinned.version);
      poolInfo.set(pool, { early, lockup: Number(lockup), inactive: BigInt(inactive), pendingInactive: BigInt(pendingInactive) });
    } catch (err) {
      poolInfo.set(pool, { early: null, lockup: null, inactive: null, pendingInactive: null, error: String(err).slice(0, 200) });
    }
  });

  let done = 0;
  const verified = await mapLimit(pairs, CONCURRENCY, async ({ delegator, pool }) => {
    if (++done % 500 === 0) console.error(`verified ${done}/${pairs.length}`);
    try {
      const [active, inactive, pendingInactive] = (await view('0x1::delegation_pool::get_stake', [pool, delegator], [], pinned.version)).map(BigInt);
      return { delegator, pool, active, inactive, pendingInactive };
    } catch (err) {
      return { delegator, pool, error: String(err).slice(0, 200) };
    }
  });
  const verifyMs = Date.now() - t1;

  // A position exists where stake is withdrawable now: inactive, or pending_inactive in a pool whose validator left the set.
  const positions: any[] = [];
  for (const v of verified as any[]) {
    if (v.error) continue;
    const pool = poolInfo.get(v.pool)!;
    if (v.inactive > 0n) positions.push({ ...v, kind: 'inactive', amount: v.inactive });
    if (v.pendingInactive > 0n && pool.early === true) positions.push({ ...v, kind: 'pending_inactive_early', amount: v.pendingInactive });
  }

  // Aging.
  const t2 = Date.now();
  await mapLimit(positions, CONCURRENCY, async p => {
    try {
      p.unlockVersion = await latestUnlock(p.delegator, p.pool);
      if (p.unlockVersion === null) { p.ageBasis = 'unknown'; p.ageNote = 'no unlock event indexed'; }
    } catch (err) { p.ageBasis = 'unknown'; p.ageNote = String(err).slice(0, 200); }
  });
  const withUnlock = positions.filter(p => p.unlockVersion != null);
  const times = await timestamps(withUnlock.map(p => p.unlockVersion));
  const lockups = lockupReader();
  // Sequential per pool, in unlock order, so lockup intervals are reused.
  const byPool = Map.groupBy(withUnlock.sort((a, b) => a.unlockVersion - b.unlockVersion), (p: any) => p.pool);
  await mapLimit([...byPool.values()], CONCURRENCY, async group => {
    for (const p of group) {
      try {
        p.unlockAt = times.get(p.unlockVersion);
        if (p.kind === 'inactive') {
          // Lockup expiry moves the stake to inactive at the next epoch; a later validator exit only makes it
          // claimable earlier, so this bound never overstates age.
          p.claimableSince = Math.max(await lockups.at(p.pool, p.unlockVersion, p.unlockAt), p.unlockAt);
          p.ageBasis = 'onchain_maturity';
        } else {
          // Claimable once the validator left the set; the exit time is not read here, so unlock time overstates age.
          p.claimableSince = p.unlockAt;
          p.ageBasis = 'position_interaction';
        }
      } catch (err) { p.ageBasis = 'unknown'; p.ageNote = String(err).slice(0, 200); }
    }
  });
  const lockupStats = lockups.stats();
  const ageMs = Date.now() - t2;

  const price = await aptUsd();
  const apt = (raw: bigint) => Number(raw) / 1e8;
  for (const p of positions) {
    p.apt = apt(p.amount);
    p.usd = p.apt * price.usd;
    p.ageDays = p.claimableSince ? (nowSecs - p.claimableSince) / DAY : null;
  }

  // Sanity: per pool, delegators' withdrawable inactive must not exceed the stake pool's inactive coins.
  const perPool = new Map<string, bigint>();
  for (const p of positions) if (p.kind === 'inactive') perPool.set(p.pool, (perPool.get(p.pool) ?? 0n) + p.amount);
  const sanityViolations = [...perPool].filter(([pool, sum]) => { const i = poolInfo.get(pool)!.inactive; return i !== null && sum > i + 1000n; })
    .map(([pool, sum]) => ({ pool, sumInactive: sum.toString(), poolInactive: poolInfo.get(pool)!.inactive!.toString() }));

  const sum = (ps: any[]) => ({ positions: ps.length, owners: new Set(ps.map(p => p.delegator)).size, apt: ps.reduce((a, p) => a + p.apt, 0), usd: ps.reduce((a, p) => a + p.usd, 0) });
  const headlineEligible = (p: any) => p.ageBasis === 'onchain_maturity';
  const aged = (days: number, eligible: (p: any) => boolean) => sum(positions.filter(p => eligible(p) && p.ageDays !== null && p.ageDays >= days));
  const owners10 = new Set(positions.filter(p => p.usd >= 10).map(p => p.delegator)).size;

  const summary = {
    source: 'native-delegation-unwithdrawn',
    ledgerVersion: pinned.version, ledgerTime: new Date(nowSecs * 1000).toISOString(),
    enumeration: { ...enumReport, ms: enumMs },
    verification: { start: verifyStart, end: new Date().toISOString(), ms: verifyMs, pairs: pairs.length, pools: pools.length,
      errors: (verified as any[]).filter(v => v.error).length, poolErrors: [...poolInfo.values()].filter(p => p.error).length,
      staleRows: (verified as any[]).filter(v => !v.error && v.inactive === 0n && v.pendingInactive === 0n).length },
    aging: { ms: ageMs, lockupArchiveReads: lockupStats, byBasis: Object.fromEntries(['onchain_maturity', 'protocol_closure', 'position_interaction', 'unknown'].map(b => [b, sum(positions.filter(p => p.ageBasis === b))])) },
    price: { source: 'coingecko simple/price', usd: price.usd, at: new Date(price.at * 1000).toISOString() },
    totals: {
      recoverableNow: sum(positions),
      byKind: { inactive: sum(positions.filter(p => p.kind === 'inactive')), pendingInactiveEarly: sum(positions.filter(p => p.kind === 'pending_inactive_early')) },
      ownersWithAtLeast10Usd: owners10,
      agedHeadlineEligible: { ge30: aged(30, headlineEligible), ge90: aged(90, headlineEligible), ge180: aged(180, headlineEligible) },
      agedEstimated: { ge30: aged(30, p => p.ageBasis === 'position_interaction'), ge90: aged(90, p => p.ageBasis === 'position_interaction'), ge180: aged(180, p => p.ageBasis === 'position_interaction') },
    },
    sanity: { check: 'per pool: sum of delegator inactive <= stake::get_stake(pool).inactive', pools: perPool.size, violations: sanityViolations },
    requests: stats, log,
    top: positions.sort((a, b) => b.usd - a.usd).slice(0, 20).map(p => ({ delegator: p.delegator, pool: p.pool, kind: p.kind, apt: p.apt, ageDays: p.ageDays, ageBasis: p.ageBasis })),
  };
  writeJson(`${DIR}/positions.json`, positions);
  writeJson(`${DIR}/summary.json`, summary);
  console.log(JSON.stringify({ ...summary, enumeration: { ...summary.enumeration, query: undefined } }, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2));
}

await main();
