// PancakeSwap (Aptos) farm rewards never harvested. MasterChef stopped CAKE emissions on 2025-03-16 (end_timestamp;
// every pool's alloc point is 0). CAKE a staked LP earned until then, and the APT incentive paid alongside it, wait in
// MasterChef until the farmer harvests (withdraw<LP>(0)). The staked LP itself is live liquidity (R4) and not counted.
// pending CAKE = amount * acc_cake_per_share / 1e12 - reward_debt (pending_cake is public but not a view); the APT
// incentive comes from the get_pending_apt view.
import { iso, positionIds } from '../accounting.ts';
import { mapLimit, normalizeAddress, once } from '../chain.ts';
import type { Position, ReadContext, ReadResult, SourceDef } from '../types.ts';
import { APT } from './delegation.ts';
import { CAKE } from './layerzero-claimable.ts';

export const MASTERCHEF = '0x7968a225eba6c99f5f1070aeec1b405757dee939eabcfda43ba91588bf5fccf3';
const ACC_PRECISION = 10n ** 12n;
const SOURCE = 'pancake-farm-ended-rewards';

export interface ChefState { end: number; lps: string[]; acc: bigint[]; cakeLeft: bigint; aptLeft: bigint }

export function chefState(ctx: ReadContext): Promise<ChefState> {
  return once(ctx, `masterchef:${ctx.ledger.version}`, async () => {
    const v = ctx.ledger.version;
    const [mc, [cake], [apt]] = await Promise.all([
      ctx.chain.resource(MASTERCHEF, `${MASTERCHEF}::masterchef::MasterChef`, v),
      ctx.chain.view('0x1::coin::balance', [MASTERCHEF], [CAKE], v),
      ctx.chain.view('0x1::coin::balance', [MASTERCHEF], ['0x1::aptos_coin::AptosCoin'], v),
    ]);
    if (!mc) throw new Error('MasterChef state missing');
    return { end: Number(mc.end_timestamp), lps: mc.lps, acc: mc.pool_info.map((p: any) => BigInt(p.acc_cake_per_share)),
      cakeLeft: BigInt(cake), aptLeft: BigInt(apt) };
  });
}

async function read(ctx: ReadContext, ownerInput: string): Promise<ReadResult> {
  const owner = normalizeAddress(ownerInput);
  const version = ctx.ledger.version;
  try {
    const info = await ctx.chain.resource(owner, `${MASTERCHEF}::masterchef::PoolUserInfo`, version);
    if (!info) return { positions: [], complete: true, errors: [], ledgerVersion: version };
    const chef = await chefState(ctx);
    if (chef.end > ctx.ledger.timestampSecs) return { positions: [], complete: true, errors: [], ledgerVersion: version };   // still emitting
    const found = await mapLimit(info.pids as string[], 3, async (pid): Promise<Position[]> => {
      const user = await ctx.chain.tableItem(info.pid_to_user_info.inner.handle, 'u64', `${MASTERCHEF}::masterchef::UserInfo`, pid, version);
      const amount = BigInt(user?.amount ?? 0);
      if (amount === 0n) return [];   // a full withdraw harvests
      const lp = chef.lps[Number(pid)];
      const cake = amount * chef.acc[Number(pid)] / ACC_PRECISION - BigInt(user.reward_debt);
      const [apt] = await ctx.chain.view(`${MASTERCHEF}::masterchef::get_pending_apt`, [owner], [lp], version);
      const rewards = [
        ...(cake > 0n ? [{ asset: CAKE, raw: cake.toString(), left: chef.cakeLeft, basis: 'derived_math' as const }] : []),
        ...(BigInt(apt) > 0n ? [{ asset: APT, raw: String(apt), left: chef.aptLeft, basis: 'verified_view' as const }] : []),
      ];
      const outputs = rewards.map(r => ({ asset: r.asset, raw: r.raw }));
      const locator = `pool-${pid}`;
      // One harvest pays both rewards; if MasterChef cannot pay either, the whole transaction aborts.
      const funded = rewards.every(r => BigInt(r.raw) <= r.left);
      return rewards.map(r => {
        const value = [{ asset: r.asset, raw: r.raw }];
        return {
          ...positionIds(SOURCE, owner, locator, 'reward', r.asset), source: SOURCE, owner, locator, positionKind: 'reward', asset: r.asset,
          claimableSince: iso(chef.end), ageBasis: 'onchain_maturity',
          provenance: { reader: `${MASTERCHEF}::masterchef::PoolUserInfo`, ledgerVersion: version },
          grossClaim: value, expectedPayout: funded ? value : [], payoutBasis: r.basis === 'verified_view' ? 'view' : 'derived',
          status: funded ? 'recoverable' : 'blocked',
          blockers: funded ? [] : [{ code: 'reward_unfunded', detail: 'MasterChef holds less CAKE or APT than this harvest pays, so the harvest fails.' }],
          confidence: r.basis, observedAt: iso(ctx.ledger.timestampSecs),
          steps: [{ function: `${MASTERCHEF}::masterchef::withdraw<${lp}>`, arguments: ['0'],
            prerequisites: ['Withdrawing 0 harvests the rewards and leaves your LP staked.'], expectedOutputs: outputs }],
        };
      });
    });
    return { positions: found.flat(), complete: true, errors: [], ledgerVersion: version };
  } catch (err) {
    return { positions: [], complete: false, errors: [String(err).slice(0, 300)], ledgerVersion: version };
  }
}

export const pancakeFarmEndedRewards: SourceDef = {
  id: SOURCE,
  chain: 'aptos',
  protocol: 'PancakeSwap',
  title: 'PancakeSwap farm rewards never harvested',
  summary: 'PancakeSwap on Aptos stopped farm rewards on 2025-03-16. The CAKE (and APT incentive) your staked LP earned until then is still in the farm until you harvest.',
  category: 'staking',
  inclusionRule: 'R2 ended position: farm emissions ended (MasterChef end_timestamp 2025-03-16). Only the rewards count; the staked LP is live liquidity.',
  protocolStatus: { state: 'live', evidence: 'MasterChef end_timestamp 2025-03-16 and every alloc point 0 (read 2026-10-19); harvest still works (simulated).', checkedAt: '2026-10-19' },
  // Nothing accrues after the end: an owner with nothing pending can only stay at nothing.
  refresh: { nonZero: 'monthly', zero: 'never' },
  headlineAgeBases: ['onchain_maturity'],
  howTo: [
    'Harvest in the PancakeSwap app (Aptos, Farms, show finished farms), or',
    `call ${MASTERCHEF}::masterchef::withdraw<LP type>(0) from the farming account: it pays the rewards and leaves the LP staked.`,
  ],
  officialUrl: 'https://aptos.pancakeswap.finance/farms',
  read,
};
