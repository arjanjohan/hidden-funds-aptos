// TruFin TruAPT unlock requests that became claimable but were never withdrawn.
// All requests live in one global SmartTable (staker::Unlocks), read once per run.
import { iso, positionIds } from '../accounting.ts';
import { normalizeAddress, once, transactionTime } from '../chain.ts';
import type { Position, ReadContext, ReadResult, SourceDef } from '../types.ts';
import { APT } from './delegation.ts';

export const TRUFIN = '0x6f8ca77dd0a4c65362f475adb1c26ae921b1d75aa6b70e53d0e340efd7d8bc80';
const SOURCE = 'trufin-unlocks';
const ENTRY = `vector<0x1::smart_table::Entry<u64, ${TRUFIN}::staker::UnlockRequest>>`;

export interface UnlockRow { nonce: string; user: string; amount: bigint; pool: string; olc: number }

/** Every pending request at the run's ledger version. A partial table is an error, never "no request". */
export function unlockTable(ctx: ReadContext): Promise<UnlockRow[]> {
  return once(ctx, `trufin-unlocks:${ctx.ledger.version}`, async () => {
    const res = await ctx.chain.resource(TRUFIN, `${TRUFIN}::staker::Unlocks`, ctx.ledger.version);
    if (!res) throw new Error('TruFin Unlocks resource missing');
    const table = res.unlocks;
    const rows: UnlockRow[] = [];
    for (let i = 0; i < Number(table.num_buckets); i++) {
      const bucket = await ctx.chain.tableItem(table.buckets.inner.handle, 'u64', ENTRY, String(i), ctx.ledger.version);
      for (const e of bucket ?? []) rows.push({ nonce: String(e.key), user: normalizeAddress(e.value.user), amount: BigInt(e.value.amount),
        pool: normalizeAddress(e.value.delegation_pool), olc: Number(e.value.olc) });
    }
    if (rows.length !== Number(table.size)) throw new Error(`TruFin unlock table read ${rows.length} of ${table.size} requests`);
    return rows;
  });
}

/** Time the pool's observed lockup cycle moved past `olc`: binary search over archive versions (the index only grows). */
async function cycleEnd(ctx: ReadContext, pool: string, olc: number): Promise<number | null> {
  const key = `${SOURCE}:olc-end:${pool}:${olc}`;
  const cached = await ctx.memo.get(key);
  if (cached) return Number(cached);
  const index = async (v: number) => {
    const p = await ctx.chain.archiveResource(pool, '0x1::delegation_pool::DelegationPool', String(v));
    return p ? Number(p.observed_lockup_cycle.index) : -1;
  };
  let lo = 0, hi = Number(ctx.ledger.version);
  if (await index(hi) <= olc) return null;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (await index(mid) > olc) hi = mid; else lo = mid + 1;
  }
  const secs = await transactionTime(ctx.chain, lo) ?? null;
  if (secs !== null) await ctx.memo.set(key, String(secs));
  return secs;
}

async function read(ctx: ReadContext, ownerInput: string): Promise<ReadResult> {
  const owner = normalizeAddress(ownerInput);
  const version = ctx.ledger.version;
  try {
    const mine = (await unlockTable(ctx)).filter(r => r.user === owner && r.amount > 0n);
    if (!mine.length) return { positions: [], complete: true, errors: [], ledgerVersion: version };
    const registry = await once(ctx, `trufin-whitelist:${version}`, async () =>
      normalizeAddress((await ctx.chain.view(`${TRUFIN}::staker::whitelist`, [], [], version))[0]));
    const [listed] = await ctx.chain.view(`${registry}::master_whitelist::is_whitelisted`, [owner], [], version);
    const positions: Position[] = [];
    for (const r of mine) {
      const [claimable] = await ctx.chain.view(`${TRUFIN}::staker::is_claimable`, [r.nonce], [], version);
      if (claimable !== true) continue;   // pool lockup not ended yet
      const since = await cycleEnd(ctx, r.pool, r.olc);
      const amount = [{ asset: APT, raw: r.amount.toString() }];
      positions.push({
        ...positionIds(SOURCE, owner, r.nonce, 'request'), source: SOURCE, owner, locator: r.nonce, positionKind: 'request',
        claimableSince: since === null ? undefined : iso(since), ageBasis: since === null ? 'unknown' : 'onchain_maturity',
        provenance: { reader: `${TRUFIN}::staker::Unlocks`, ledgerVersion: version },
        grossClaim: amount, expectedPayout: amount, payoutBasis: 'view',
        status: listed === true ? 'recoverable' : 'team_gated',
        blockers: listed === true ? [] : [{ code: 'not_whitelisted', detail: 'TruFin lets only whitelisted wallets withdraw; this wallet is not on its whitelist.' }],
        confidence: 'verified_view', observedAt: iso(ctx.ledger.timestampSecs),
        steps: [{ function: `${TRUFIN}::staker::withdraw`, arguments: [r.nonce], prerequisites: ['The wallet must be on TruFin\'s whitelist.'], expectedOutputs: amount }],
      });
    }
    return { positions, complete: true, errors: [], ledgerVersion: version };
  } catch (err) {
    return { positions: [], complete: false, errors: [String(err).slice(0, 300)], ledgerVersion: version };
  }
}

export const trufinUnlocks: SourceDef = {
  id: SOURCE,
  chain: 'aptos',
  title: 'TruFin unlock never withdrawn',
  summary: 'You unlocked TruAPT on TruFin. The validator lockup ended, but the APT was never withdrawn.',
  category: 'liquid_staking',
  inclusionRule: 'R2 ended position: unlock request claimable (staker::is_claimable), i.e. its pool lockup cycle ended.',
  protocolStatus: { state: 'live', evidence: 'TruFin staker module responds.', checkedAt: '2026-10-18' },
  refresh: { nonZero: 'every_run', zero: 'monthly' },
  headlineAgeBases: ['onchain_maturity'],
  howTo: [
    'Open TruFin and withdraw the finished unlock (whitelisted wallets only).',
    `Or call ${TRUFIN}::staker::withdraw(nonce) from the requesting account.`,
  ],
  officialUrl: 'https://app.trufin.io',
  read,
};
