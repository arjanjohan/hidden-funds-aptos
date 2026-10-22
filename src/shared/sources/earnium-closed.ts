// Earnium (Aptos AMM): liquidity left in Earnium pools, in the wallet or staked in its liquidity staking, after its
// frontend went away. earnium.io and app.earnium.io no longer resolve (2026-10-21) and no notice was found, so it is
// closed under the closed-frontend rule from that day. The contract still works: staked LP can be unstaked (which also
// pays any accrued rewards) and removed from the pool directly.
import { iso, positionIds } from '../accounting.ts';
import { mapLimit, normalizeAddress, once } from '../chain.ts';
import type { Amount, Position, ReadContext, ReadResult, SourceDef } from '../types.ts';
import { APT } from './delegation.ts';

export const EARNIUM = '0x12169b6e1bf75ab1a2b2d987d20f8dd4c191e5dbc2066cb7e9af40b1fa7fb659';
/** End of the day both domains were found without an address record (no notice found; the archived app was served
 *  until at least 2026-01). */
export const EARNIUM_CLOSED_AT = '2026-10-21T23:59:59Z';
/** `stake_and_lock` with no end: such LP can never be unstaked. */
const LOCKED_FOREVER = 18_446_744_073_709_551_615n;
/** Minimum outputs in the removal step: 1% below the computed payout, against reserve moves before it lands. */
const SLIPPAGE_BPS = 100n;
/** user_info aborts on long pool lists; this many pools a call reads fine. */
const POOLS_PER_CALL = 20;
const SOURCE = 'earnium-closed-lp';

/** Enumeration hint, per pool: when an Earnium call of the owner's last moved the pool's LP after the closure began
 *  (`moved`), and when the LP in its wallet last changed (`lps`, a transfer in included). */
export type EarniumHint = { moved?: Record<string, string>; lps?: Record<string, string> };

/** Every pool, once per ledger version. */
export const earniumPools = (ctx: ReadContext) => once(ctx, `earnium-pools:${ctx.ledger.version}`, async () =>
  ((await ctx.chain.view(`${EARNIUM}::liquidity_pool::pools`, [], [], ctx.ledger.version))[0] as { inner: string }[]).map(p => normalizeAddress(p.inner)));

/** A pool's two assets as removal pays them, and whether it is a stable pool. Earnium wraps coins in its own fungible
 *  assets; a wrapper's original is a coin type (APT's is AptosCoin, paid as APT's fungible asset). */
const poolInfo = (ctx: ReadContext, pool: string) => once(ctx, `earnium-pool:${pool}`, async () => {
  const [[assets], [stable]] = await Promise.all([
    ctx.chain.view(`${EARNIUM}::liquidity_pool::supported_inner_assets`, [pool], [], ctx.ledger.version),
    ctx.chain.view(`${EARNIUM}::liquidity_pool::is_stable`, [pool], [], ctx.ledger.version),
  ]);
  const inner = (assets as { inner: string }[]).map(a => normalizeAddress(a.inner));
  const paid = await Promise.all(inner.map(async a => {
    const [original] = await ctx.chain.view(`${EARNIUM}::coin_wrapper::get_original`, [a], [], ctx.ledger.version);
    const o = String(original);
    return /::aptos_coin::AptosCoin$/.test(o) ? APT : o.includes('::') ? o : normalizeAddress(o);
  }));
  return { inner, paid, stable: !!stable };
});

interface Holding { pool: string; wallet: bigint; staked: bigint; unlock: bigint }

async function holdings(ctx: ReadContext, owner: string): Promise<Holding[]> {
  const pools = await earniumPools(ctx);
  const out: Holding[] = [];
  for (let i = 0; i < pools.length; i += POOLS_PER_CALL) {
    const batch = pools.slice(i, i + POOLS_PER_CALL);
    const [info] = await ctx.chain.view(`${EARNIUM}::liquidity_stake_pool::user_info`, [owner, batch], [], ctx.ledger.version);
    (info as any[]).forEach((u, j) => {
      const h = { pool: batch[j], wallet: BigInt(u.wallet_balance), staked: BigInt(u.staked), unlock: BigInt(u.unlock_time) };
      if (h.wallet + h.staked > 0n) out.push(h);
    });
  }
  return out;
}

async function read(ctx: ReadContext, ownerInput: string, hint?: EarniumHint): Promise<ReadResult> {
  const owner = normalizeAddress(ownerInput);
  const version = ctx.ledger.version;
  const errors: string[] = [];
  let failed = 0;
  let held: Holding[];
  try { held = await holdings(ctx, owner); } catch (err) {
    return { positions: [], complete: false, errors: [`user_info: ${String(err).slice(0, 200)}`], ledgerVersion: version };
  }
  // The pools still take liquidity, so LP the owner moved after the closure is aged from that call, wallet LP from its
  // last change (LP received later is aged from then), and a stake that unlocked after the closure from its unlock.
  const latest = (...dates: (string | undefined)[]) => dates.filter((d): d is string => !!d).reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
  const found = await mapLimit(held, 4, async (h): Promise<Position[]> => {
    try {
      // LP locked with no end can never come out; a stake still locked is blocked until its unlock time.
      const stakedFree = h.unlock === LOCKED_FOREVER || BigInt(ctx.ledger.timestampSecs) < h.unlock ? 0n : h.staked;
      const lockedUntil = h.staked > 0n && stakedFree === 0n && h.unlock !== LOCKED_FOREVER ? h.unlock : null;
      const liquidity = h.wallet + stakedFree;
      const since = latest(EARNIUM_CLOSED_AT, hint?.moved?.[h.pool], h.wallet > 0n ? hint?.lps?.[h.pool] : undefined,
        stakedFree > 0n && h.unlock > 0n ? iso(Number(h.unlock)) : undefined);
      const p = await poolInfo(ctx, h.pool);
      const parts: { lp: bigint; blocked: boolean }[] = [
        ...(liquidity > 0n ? [{ lp: liquidity, blocked: false }] : []),
        ...(lockedUntil !== null ? [{ lp: h.staked, blocked: true }] : []),
      ];
      const positions: Position[] = [];
      for (const part of parts) {
        const [a1, a2] = (await ctx.chain.view(`${EARNIUM}::router::redeemable_liquidity`, [h.pool, part.lp.toString()], [], version)).map(x => BigInt(x));
        const outputs: Amount[] = [{ asset: p.paid[0], raw: a1.toString() }, { asset: p.paid[1], raw: a2.toString() }];
        const steps = [
          ...(!part.blocked && stakedFree > 0n ? [{ function: `${EARNIUM}::liquidity_stake_pool::unstake`, arguments: [h.pool, stakedFree.toString()],
            prerequisites: [], expectedOutputs: [] }] : []),
          { function: `${EARNIUM}::router::remove_liquidity_entry`,
            arguments: [p.inner[0], p.inner[1], String(p.stable), part.lp.toString(), (a1 * (10_000n - SLIPPAGE_BPS) / 10_000n).toString(),
              (a2 * (10_000n - SLIPPAGE_BPS) / 10_000n).toString(), owner],
            prerequisites: part.blocked ? [`unstake after ${iso(Number(lockedUntil))}`] : [], expectedOutputs: outputs },
        ];
        const blockers = part.blocked ? [{ code: 'locked', detail: `Staked with a lock until ${iso(Number(lockedUntil)).slice(0, 10)}.` }] : [];
        const locator = part.blocked ? `${h.pool}/locked` : h.pool;
        // One position per side, so a priced side still counts when the other asset has no price. One removal pays both,
        // so only the first side carries the steps: shown twice, they would tell the owner to remove the same LP twice.
        let first = true;
        for (const o of outputs) if (o.raw !== '0') positions.push({
          ...positionIds(SOURCE, owner, locator, 'principal', o.asset), source: SOURCE, owner, locator, positionKind: 'principal', asset: o.asset,
          claimableSince: since, ageBasis: 'protocol_closure',
          provenance: { reader: `${EARNIUM}::liquidity_stake_pool::user_info`, ledgerVersion: version },
          grossClaim: [o], expectedPayout: part.blocked ? [] : [o], payoutBasis: 'view',
          status: part.blocked ? 'blocked' : 'recoverable', blockers,
          confidence: 'verified_view', observedAt: iso(ctx.ledger.timestampSecs), steps: first ? (first = false, steps) : [],
        });
      }
      return positions;
    } catch (err) {
      failed++;
      errors.push(`${h.pool}: ${String(err).slice(0, 200)}`);
      return [];
    }
  });
  return { positions: found.flat(), complete: failed === 0, errors, ledgerVersion: version };
}

export const earniumClosedLp: SourceDef<EarniumHint> = {
  id: SOURCE,
  chain: 'aptos',
  protocol: 'Earnium',
  title: 'Earnium liquidity left after its frontend went away',
  summary: 'Earnium\'s website is gone, but its pools and liquidity staking still work. Liquidity left there, staked or not, can still be withdrawn directly.',
  category: 'closed_app',
  inclusionRule: 'R2: frontend gone (earnium.io and app.earnium.io have no address record, 2026-10-21; no notice found), closed under the closed-frontend rule (decided 2026-10-21). R4: an AMM position carries no debt; staking in a closed protocol counts.',
  protocolStatus: {
    state: 'closed',
    evidence: 'earnium.io and app.earnium.io have no address record (2026-10-21); the archived site was served until 2026-02 and the app until 2026-01. DefiLlama marks Earnium dead from 2026-10-10. No closure notice found.',
    checkedAt: '2026-10-21',
    effectiveAt: EARNIUM_CLOSED_AT,
  },
  // A holder's own calls after the closure re-date it through the hint; swaps only shift the split between the sides.
  refresh: { nonZero: 'monthly', zero: 'monthly' },
  headlineAgeBases: ['protocol_closure'],
  howTo: [
    `If the liquidity is staked: call ${EARNIUM}::liquidity_stake_pool::unstake(pool, amount) (it also pays accrued rewards).`,
    `Then call ${EARNIUM}::router::remove_liquidity_entry(asset 1, asset 2, is_stable, liquidity, minimum 1, minimum 2, your address).`,
  ],
  read,
};
