// Native delegation stake that finished unlocking but was never withdrawn. Same framework module on Aptos and
// Movement. Evidence and measurements: docs/phase0-report.md §1.
import { iso, positionIds } from '../accounting.ts';
import { mapLimit, normalizeAddress, once, transactionTime } from '../chain.ts';
import { ownedPools } from '../owned.ts';
import type { Position, ReadContext, ReadResult, SourceDef } from '../types.ts';

export const APT = '0x000000000000000000000000000000000000000000000000000000000000000a';
/** Native MOVE is also FA 0xa, on Movement; the prefix keeps it apart from APT in prices and totals. */
export const MOVE = 'movement:0x000000000000000000000000000000000000000000000000000000000000000a';

/** Native coin per chain: asset id, symbol and the user-facing chain name. */
export const NATIVE = {
  aptos: { asset: APT, symbol: 'APT', name: 'Aptos' },
  movement: { asset: MOVE, symbol: 'MOVE', name: 'Movement' },
} as const;

export type DelegationHint = { pools: string[]; version?: number };

const UNLOCK_QUERY = `query($d:String!,$p:String!){ delegated_staking_activities(where:{delegator_address:{_eq:$d}, pool_address:{_eq:$p},
  event_type:{_in:["0x1::delegation_pool::UnlockStake","0x1::delegation_pool::UnlockStakeEvent"]}},
  order_by:{transaction_version:desc}, limit:1){ transaction_version } }`;

/** StakePool.locked_until_secs at a past moment. A read at time t returning L holds for all of [t, L]: renewal only
 *  happens after L, so reads are reused within those intervals per pool. */
async function lockedUntilAt(ctx: ReadContext, pool: string, version: number, secs: number): Promise<number> {
  const intervals = await once(ctx, `lockups:${pool}`, async () => [] as { from: number; until: number }[]);
  const known = intervals.find(i => i.from <= secs && secs <= i.until);
  if (known) return known.until;
  const stakePool = await ctx.chain.archiveResource(pool, '0x1::stake::StakePool', String(version));
  if (!stakePool) throw new Error(`StakePool missing at version ${version}`);
  const until = Number(stakePool.locked_until_secs);
  if (until >= secs) intervals.push({ from: secs, until });
  return until;
}

type Age = { claimableSince?: string; ageBasis: Position['ageBasis'] };

async function age(ctx: ReadContext, source: string, owner: string, pool: string, kind: 'inactive' | 'pending_inactive', raw: bigint): Promise<Age> {
  // claimableSince never changes while the amount is unchanged, so it is memoized across runs.
  const key = `${source}:age:${owner}:${pool}:${kind}:${raw}`;
  const cached = await ctx.memo.get(key);
  if (cached) return JSON.parse(cached);
  const event = (await ctx.chain.gql(UNLOCK_QUERY, { d: owner, p: pool })).delegated_staking_activities[0];
  if (!event) return { ageBasis: 'unknown' };
  const version = Number(event.transaction_version);
  const unlockSecs = await transactionTime(ctx.chain, version);
  if (unlockSecs === null) return { ageBasis: 'unknown' };
  let result: Age;
  if (kind === 'inactive') {
    // Lockup expiry moves unlocked stake to inactive; a validator leaving the set earlier only makes it claimable
    // sooner, so this never overstates age.
    result = { claimableSince: iso(Math.max(await lockedUntilAt(ctx, pool, version, unlockSecs), unlockSecs)), ageBasis: 'onchain_maturity' };
  } else {
    // Claimable once the validator left the set; that time is not read, so the unlock time can overstate age.
    result = { claimableSince: iso(unlockSecs), ageBasis: 'position_interaction' };
  }
  await ctx.memo.set(key, JSON.stringify(result));
  return result;
}

async function read(ctx: ReadContext, SOURCE: string, asset: string, ownerInput: string, hint?: DelegationHint): Promise<ReadResult> {
  const owner = normalizeAddress(ownerInput);
  const version = ctx.ledger.version;
  const errors: string[] = [];
  let failedPools = 0;
  // Indexer rows only name candidate pools; amounts always come from get_stake.
  const pools: string[] = hint?.pools.map(normalizeAddress) ?? await ownedPools(ctx, owner, 'inactive_shares');

  const perPool = await mapLimit(pools, 4, async pool => {
    try {
      const [, inactive, pendingInactive] = (await ctx.chain.view('0x1::delegation_pool::get_stake', [pool, owner], [], version)).map(BigInt);
      const early = inactive === 0n && pendingInactive === 0n ? false
        : await once(ctx, `early:${pool}:${version}`, async () =>
          (await ctx.chain.view('0x1::delegation_pool::can_withdraw_pending_inactive', [pool], [], version))[0] === true);
      const out: Position[] = [];
      const add = async (kind: 'inactive' | 'pending_inactive', raw: bigint) => {
        const locator = `${pool}/${kind}`;
        const amount = [{ asset, raw: raw.toString() }];
        let aged: Age;
        try { aged = await age(ctx, SOURCE, owner, pool, kind, raw); }
        catch (err) { errors.push(`age ${locator}: ${String(err).slice(0, 200)}`); aged = { ageBasis: 'unknown' }; }
        out.push({
          ...positionIds(SOURCE, owner, locator, 'principal'), source: SOURCE, owner, locator, positionKind: 'principal',
          ...aged, provenance: { reader: '0x1::delegation_pool::get_stake', ledgerVersion: version },
          grossClaim: amount, expectedPayout: amount, payoutBasis: 'view', status: 'recoverable', blockers: [],
          confidence: 'verified_view', observedAt: iso(ctx.ledger.timestampSecs),
          steps: [{ function: '0x1::delegation_pool::withdraw', arguments: [pool, raw.toString()], prerequisites: [], expectedOutputs: amount }],
        });
      };
      if (inactive > 0n) await add('inactive', inactive);
      // Pending-inactive stake is only withdrawable early when the validator has left the set.
      if (pendingInactive > 0n && early) await add('pending_inactive', pendingInactive);
      return out;
    } catch (err) {
      failedPools++;
      errors.push(`pool ${pool}: ${String(err).slice(0, 200)}`);
      return [];
    }
  });
  // An aging failure leaves the age unknown (excluded from age totals) but the amounts are complete.
  return { positions: perPool.flat(), complete: failedPools === 0, errors, ledgerVersion: version };
}

function nativeDelegation(chain: keyof typeof NATIVE, id: string): SourceDef<DelegationHint> {
  const { asset, symbol, name } = NATIVE[chain];
  return {
    id,
    chain,
    protocol: `${name} native staking`,
    title: `Unstaked ${symbol} never withdrawn`,
    summary: `You unstaked ${symbol} from ${name === 'Aptos' ? 'an' : 'a'} ${name} delegation pool. The lockup ended and the ${symbol} is withdrawable, but it was never withdrawn.`,
    category: 'staking',
    inclusionRule: 'R2 ended position: unlock completed (stake is inactive, or pending-inactive in a pool whose validator left the set).',
    protocolStatus: { state: 'live', evidence: `${name} framework module 0x1::delegation_pool.`, checkedAt: '2026-10-19' },
    refresh: { nonZero: 'every_run', zero: 'monthly' },
    headlineAgeBases: ['onchain_maturity'],
    howTo: [
      'Open the delegation pool in your wallet\'s staking view and withdraw.',
      'Or call 0x1::delegation_pool::withdraw(pool, amount) from the account that delegated.',
    ],
    read: (ctx, owner, hint) => read(ctx, id, asset, owner, hint),
  };
}

export const delegation = nativeDelegation('aptos', 'native-delegation');
export const movementDelegation = nativeDelegation('movement', 'movement-native-delegation');
