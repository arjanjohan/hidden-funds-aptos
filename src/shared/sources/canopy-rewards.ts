// Canopy (Movement) staking rewards earned in reward periods that have ended and were never claimed. Canopy's
// multi_rewards pools stream a reward token to stakers subscribed to the pool until the period's finish time; what a
// staker earned stays in the pool until claimed. Rewards of a pool whose period is still running are live and excluded.
import { iso, positionIds } from '../accounting.ts';
import { normalizeAddress, once } from '../chain.ts';
import type { Position, ReadContext, ReadResult, SourceDef } from '../types.ts';

export const CANOPY_REWARDS = '0x113a1769acc5ce21b5ece6f9533eef6dd34c758911fa5235124c87ff1298633b';
const CANOPY_REWARDS_VIEWS = '0x707462571715301b063d79c2cdb57c3bd1cfe2189889793b00077ceed86e0219';
/** Resource account holding MultiRewardsModule (user_staked_balances: staker → staked tokens). */
export const CANOPY_REWARDS_STATE = '0x9ffd3dc838ac548abc68c83b4052c7332807ccb88dc47bbab3e8e5a42ff47ee0';
const SOURCE = 'canopy-ended-rewards';

/** Reward token metadata → asset id. Movement asset ids carry a chain prefix so they never mix with Aptos ones. */
const assetOf = (metadata: string) => `movement:${normalizeAddress(metadata)}`;

/** pool → reward token → period finish (unix seconds), for every registered pool. */
export function rewardPeriods(ctx: ReadContext): Promise<Map<string, Map<string, number>>> {
  return once(ctx, `canopy-periods:${ctx.ledger.version}`, async () => {
    const [pools] = await ctx.chain.view(`${CANOPY_REWARDS_VIEWS}::rewards_view::get_all_pool_list`, [], [], ctx.ledger.version);
    const out = new Map<string, Map<string, number>>();
    for (const p of pools as { inner: string }[]) {
      const [details] = await ctx.chain.view(`${CANOPY_REWARDS_VIEWS}::rewards_view::get_reward_token_details`, [p.inner], [], ctx.ledger.version);
      out.set(normalizeAddress(p.inner), new Map((details as any[]).map(d => [normalizeAddress(d.token.inner), Number(d.period_finish)])));
    }
    return out;
  });
}

async function read(ctx: ReadContext, ownerInput: string): Promise<ReadResult> {
  const owner = normalizeAddress(ownerInput);
  const version = ctx.ledger.version;
  try {
    const [rows] = await ctx.chain.view(`${CANOPY_REWARDS_VIEWS}::rewards_view::get_user_pool_positions`, [owner, { vec: [] }, { vec: [] }], [], version);
    const earning = (rows as any[]).filter(r => r.rewards.some((w: any) => BigInt(w.earned_amount) > 0n));
    if (!earning.length) return { positions: [], complete: true, errors: [], ledgerVersion: version };
    const periods = await rewardPeriods(ctx);
    const positions: Position[] = [];
    for (const r of earning) {
      const pool = normalizeAddress(r.pool.inner), stakingToken = normalizeAddress(r.pool_staking_token.inner);
      for (const w of r.rewards) {
        const raw = BigInt(w.earned_amount), token = normalizeAddress(w.reward_token.inner);
        const finish = periods.get(pool)?.get(token);
        // Still streaming (or no period yet): a live reward, not left behind.
        if (raw === 0n || !finish || finish > ctx.ledger.timestampSecs) continue;
        const asset = assetOf(token), value = [{ asset, raw: raw.toString() }];
        const locator = `${pool}:${token}`;
        positions.push({
          ...positionIds(SOURCE, owner, locator, 'reward', asset), source: SOURCE, owner, locator, positionKind: 'reward', asset,
          claimableSince: iso(finish), ageBasis: 'onchain_maturity',
          provenance: { reader: `${CANOPY_REWARDS_VIEWS}::rewards_view::get_user_pool_positions`, ledgerVersion: version },
          grossClaim: value, expectedPayout: value, payoutBasis: 'view',
          // Only subscribed stakes can claim; an unsubscribed accrual has no claim route.
          status: r.is_subscribed ? 'recoverable' : 'blocked',
          blockers: r.is_subscribed ? [] : [{ code: 'unsubscribed', detail: 'You left this reward pool; Canopy\'s claim only pays pools you are subscribed to.' }],
          confidence: 'verified_view', observedAt: iso(ctx.ledger.timestampSecs),
          steps: [{ function: `${CANOPY_REWARDS}::multi_rewards::claim_reward`, arguments: [stakingToken],
            prerequisites: ['Claims every pool you are subscribed to for this staking token, including pools still running.'], expectedOutputs: value }],
        });
      }
    }
    return { positions, complete: true, errors: [], ledgerVersion: version };
  } catch (err) {
    return { positions: [], complete: false, errors: [String(err).slice(0, 300)], ledgerVersion: version };
  }
}

export const canopyEndedRewards: SourceDef = {
  id: SOURCE,
  chain: 'movement',
  protocol: 'Canopy',
  title: 'Canopy staking rewards never claimed',
  summary: 'You staked on Canopy (Movement). A reward period you earned in has ended, but the rewards were never claimed.',
  category: 'staking',
  inclusionRule: 'R2 ended position: the pool\'s reward period finished; what you earned waits in the pool until claimed.',
  protocolStatus: { state: 'live', evidence: 'Canopy multi_rewards pools still stream rewards (22 of 56 pools live on 2026-10-19).', checkedAt: '2026-10-19' },
  refresh: { nonZero: 'monthly', zero: 'monthly' },
  headlineAgeBases: ['onchain_maturity'],
  howTo: [
    'Claim in the Canopy app (Rewards), or',
    `call ${CANOPY_REWARDS}::multi_rewards::claim_reward(staking token) from the staking account.`,
  ],
  officialUrl: 'https://app.canopyhub.xyz',
  read,
};
