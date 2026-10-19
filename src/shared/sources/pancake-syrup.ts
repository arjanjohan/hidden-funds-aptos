// PancakeSwap (Aptos) syrup pools whose reward period ended while users stayed staked. Every smart_chef pool ended in
// 2023-2024; the staked tokens and the final pending reward wait in the pool until the staker withdraws.
// smart_chef has no views: the pending reward follows its own math, final because each pool's accumulator was last
// updated at or after its end (pending = amount * acc_token_per_share / precision_factor - reward_debt).
import { iso, positionIds } from '../accounting.ts';
import { mapLimit, normalizeAddress, once } from '../chain.ts';
import type { Position, ReadContext, ReadResult, SourceDef } from '../types.ts';
import { APT } from './delegation.ts';
import { CAKE } from './layerzero-claimable.ts';

export const SMART_CHEF = '0xfd1d8a523f1be89277ac0787ae3469312667e3d0b3f75a5f01bfc95530a2dc91';
const UIDS = '0x9936836587ca33240d3d3f91844651b16cb07802faf5e34514ed6f78580deb0a::uints';
export const GUI = '0xe4ccb6d39136469f376242c31b34d10515c8eaaa38092f804db8e08a8f53c5b2::assets_v1::EchoCoin002';
const SOURCE = 'pancake-syrup-ended';

/** Every pool smart_chef created (create_pool_event counter = 10 on 2026-10-19): stake, reward and pool-id types. */
export const SYRUP_POOLS = [
  { uid: 'U0', stake: CAKE, reward: '0xd11107bdf0d6d7040c6c0bfbdecb6545191fdf13e8d8d259952f53e1713f61b5::staked_coin::StakedAptos' },
  { uid: 'U1', stake: CAKE, reward: '0x8d87a65ba30e09357fa2edea2c80dbac296e5dec2b18287113500b902942929d::celer_coin_manager::UsdcCoin' },
  { uid: 'U2', stake: CAKE, reward: '0x27fafcc4e39daac97556af8a803dbb52bcb03f0821898dc845ac54225b9793eb::move_coin::MoveCoin' },
  { uid: 'U3', stake: CAKE, reward: '0x25a64579760a4c64be0d692327786a6375ec80740152851490cfd0b53604cf95::coin::ETERN' },
  { uid: 'U4', stake: CAKE, reward: '0xfbab9fb68bd2103925317b6a540baa20087b1e7a7a4eb90badee04abb6b5a16f::blt::Blt' },
  { uid: 'U5', stake: CAKE, reward: '0x25a64579760a4c64be0d692327786a6375ec80740152851490cfd0b53604cf95::coin::ETERN' },
  { uid: 'U6', stake: GUI, reward: '0x1::aptos_coin::AptosCoin' },
  { uid: 'U7', stake: GUI, reward: '0x1::aptos_coin::AptosCoin' },
  { uid: 'U8', stake: GUI, reward: '0x1::aptos_coin::AptosCoin' },
  { uid: 'U9', stake: GUI, reward: '0x1::aptos_coin::AptosCoin' },
].map(p => ({ ...p, types: `${p.stake}, ${p.reward}, ${UIDS}::${p.uid}` }));

type Pool = (typeof SYRUP_POOLS)[number];
export interface PoolState { end: number; acc: bigint; precision: bigint; rewardLeft: bigint; staked: bigint; settled: boolean }

/** A pool's state; `settled` when its accumulator was last updated at or after the pool's end. */
export function poolState(ctx: ReadContext, pool: Pool): Promise<PoolState> {
  return once(ctx, `syrup-pool:${pool.uid}:${ctx.ledger.version}`, async () => {
    const p = await ctx.chain.resource(SMART_CHEF, `${SMART_CHEF}::smart_chef::PoolInfo<${pool.types}>`, ctx.ledger.version);
    if (!p) throw new Error(`smart_chef pool ${pool.uid} missing`);
    return { end: Number(p.end_timestamp), acc: BigInt(p.acc_token_per_share), precision: BigInt(p.precision_factor),
      rewardLeft: BigInt(p.total_reward_token.value), staked: BigInt(p.total_staked_token.value),
      settled: Number(p.last_reward_timestamp) >= Number(p.end_timestamp) };
  });
}

// Asset ids are the Coin types, except APT, which is identified by its fungible-asset address.
const assetOf = (coin: string) => coin === '0x1::aptos_coin::AptosCoin' ? APT : coin;

async function read(ctx: ReadContext, ownerInput: string): Promise<ReadResult> {
  const owner = normalizeAddress(ownerInput);
  const version = ctx.ledger.version;
  try {
    // A staker's UserInfo pools are learned once: the pools ended, so nobody joins them anymore. Keyed by the pool
    // count so a new pool makes everyone be read in full again.
    const memoKey = `${SOURCE}:pools:${SYRUP_POOLS.length}:${owner}`;
    const known = await ctx.memo.get(memoKey);
    const pools = known ? SYRUP_POOLS.filter(p => (JSON.parse(known) as string[]).includes(p.uid)) : SYRUP_POOLS;
    const infos = await mapLimit(pools, 4, async pool =>
      ({ pool, info: await ctx.chain.resource(owner, `${SMART_CHEF}::smart_chef::UserInfo<${pool.types}>`, version) }));
    const held = infos.filter(x => x.info);
    if (!known) await ctx.memo.set(memoKey, JSON.stringify(held.map(x => x.pool.uid)));
    const positions: Position[] = [];
    for (const { pool, info } of held) {
      const amount = BigInt(info.amount);
      if (amount === 0n) continue;
      const state = await poolState(ctx, pool);
      if (!state.settled || state.end > ctx.ledger.timestampSecs) continue;   // still running: a live stake
      const pending = amount * state.acc / state.precision - BigInt(info.reward_debt);
      const funded = pending <= state.rewardLeft;
      const stake = [{ asset: assetOf(pool.stake), raw: amount.toString() }];
      const reward = pending > 0n ? [{ asset: assetOf(pool.reward), raw: pending.toString() }] : [];
      // withdraw pays the stake and the reward; when the pool cannot pay the reward it aborts, and only
      // emergency_withdraw (stake only) is left.
      const steps = funded
        ? [{ function: `${SMART_CHEF}::smart_chef::withdraw<${pool.types}>`, arguments: [amount.toString()], prerequisites: [], expectedOutputs: [...stake, ...reward] }]
        : [{ function: `${SMART_CHEF}::smart_chef::emergency_withdraw<${pool.types}>`, arguments: [], prerequisites: ['Gives up the pending reward, which the pool cannot pay.'], expectedOutputs: stake }];
      const locator = `pool-${pool.uid}`;
      const base = { source: SOURCE, owner, locator, claimableSince: iso(state.end), ageBasis: 'onchain_maturity' as const,
        provenance: { reader: `${SMART_CHEF}::smart_chef::UserInfo`, ledgerVersion: version }, payoutBasis: 'derived' as const,
        confidence: 'derived_math' as const, observedAt: iso(ctx.ledger.timestampSecs), steps };
      positions.push({ ...positionIds(SOURCE, owner, locator, 'principal', stake[0].asset), ...base, positionKind: 'principal', asset: stake[0].asset,
        grossClaim: stake, expectedPayout: stake, status: 'recoverable', blockers: [] });
      if (reward.length) positions.push({ ...positionIds(SOURCE, owner, locator, 'reward', reward[0].asset), ...base, positionKind: 'reward', asset: reward[0].asset,
        grossClaim: reward, expectedPayout: funded ? reward : [], status: funded ? 'recoverable' : 'blocked',
        blockers: funded ? [] : [{ code: 'reward_unfunded', detail: 'The pool holds less reward than you are owed.' }] });
    }
    return { positions, complete: true, errors: [], ledgerVersion: version };
  } catch (err) {
    return { positions: [], complete: false, errors: [String(err).slice(0, 300)], ledgerVersion: version };
  }
}

export const pancakeSyrupEnded: SourceDef = {
  id: SOURCE,
  chain: 'aptos',
  title: 'PancakeSwap syrup pool ended, still staked',
  summary: 'You staked CAKE (or GUI) in a PancakeSwap syrup pool on Aptos. The pool\'s rewards ended in 2023-2024, but your stake and the last rewards are still in the pool.',
  category: 'staking',
  inclusionRule: 'R2 ended position: the pool\'s reward period ended; the stake earns nothing and waits for a withdraw.',
  protocolStatus: { state: 'live', evidence: 'smart_chef pools all ended (last on 2024-04-16); withdraw still works (simulated).', checkedAt: '2026-10-19' },
  refresh: { nonZero: 'monthly', zero: 'monthly' },
  headlineAgeBases: ['onchain_maturity'],
  howTo: [
    'Withdraw in the PancakeSwap app (Aptos, Pools, show finished pools), or',
    `call ${SMART_CHEF}::smart_chef::withdraw<stake, reward, pool id>(amount) from the staking account.`,
  ],
  officialUrl: 'https://aptos.pancakeswap.finance/pools',
  read,
};
