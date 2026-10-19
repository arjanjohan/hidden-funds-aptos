// Thala THL left behind: expired veTHL locks never unlocked, and matured farm-reward vesting claims never claimed.
import { iso, positionIds } from '../accounting.ts';
import { normalizeAddress, once } from '../chain.ts';
import type { Position, ReadContext, ReadResult, SourceDef } from '../types.ts';

export const THL = '0x07fd500c11216f0fe3095d0c4b8aa4d64a4e2e04f83758462f2b127255643615::thl_coin::THL';
export const THALA_VE = '0x167f411fc5a678fb40d86e0af646fa8f62458b686ad8996215248447037af40c';
export const THALA_VEST = '0x3c4a58b4a8dffe6d14448072efcdd5a0e0089a22c6837b94f1d7e8bb1552137f';

const failed = (version: string, err: unknown): ReadResult =>
  ({ positions: [], complete: false, errors: [String(err).slice(0, 300)], ledgerVersion: version });

// ---- expired veTHL locks --------------------------------------------------------------------------------------

const VETHL = 'thala-vethl-expired';

async function readLock(ctx: ReadContext, ownerInput: string): Promise<ReadResult> {
  const owner = normalizeAddress(ownerInput);
  const version = ctx.ledger.version;
  try {
    // One resource read per owner; epoch values are shared per run. can_unlock<THL> is now_epoch >= unlockable_epoch.
    const store = await ctx.chain.resource(owner, `${THALA_VE}::vetoken::VeTokenStore<${THL}>`, version);
    const locked = BigInt(store?.vetoken.locked.value ?? 0);
    if (locked === 0n) return { positions: [], complete: true, errors: [], ledgerVersion: version };
    const epoch = (fn: string) => once(ctx, `vethl-${fn}:${version}`, async () =>
      Number((await ctx.chain.view(`${THALA_VE}::vetoken::${fn}`, [], [THL], version))[0]));
    const unlockable = Number(store.vetoken.unlockable_epoch);
    if (unlockable > await epoch('now_epoch')) return { positions: [], complete: true, errors: [], ledgerVersion: version };
    const unlockAt = unlockable * await epoch('seconds_in_epoch');
    const value = [{ asset: THL, raw: locked.toString() }];
    const position: Position = {
      ...positionIds(VETHL, owner, 'THL', 'principal'), source: VETHL, owner, locator: 'THL', positionKind: 'principal',
      claimableSince: iso(unlockAt), ageBasis: 'onchain_maturity',
      provenance: { reader: `${THALA_VE}::vetoken::VeTokenStore<THL>`, ledgerVersion: version },
      grossClaim: value, expectedPayout: value, payoutBasis: 'view', status: 'recoverable', blockers: [],
      confidence: 'verified_view', observedAt: iso(ctx.ledger.timestampSecs),
      steps: [{ function: `${THALA_VE}::scripts::unlock<${THL}>`, arguments: [],
        prerequisites: ['Claim any veTHL dividends first; unlocking ends the lock and its voting power.'], expectedOutputs: value }],
    };
    return { positions: [position], complete: true, errors: [], ledgerVersion: version };
  } catch (err) {
    return failed(version, err);
  }
}

export const thalaVethlExpired: SourceDef = {
  id: VETHL,
  chain: 'aptos',
  protocol: 'Thala',
  title: 'Expired veTHL lock never unlocked',
  summary: 'You locked THL for veTHL on Thala. The lock period ended, but the THL is still sitting in the lock.',
  category: 'closed_app',
  inclusionRule: 'R2 ended position: vote-escrow lock expired (unlockable_epoch reached, as in vetoken::can_unlock<THL>).',
  protocolStatus: { state: 'live', evidence: 'Thala vote-escrow is operating.', checkedAt: '2026-10-18' },
  refresh: { nonZero: 'every_run', zero: 'monthly' },
  headlineAgeBases: ['onchain_maturity'],
  howTo: [
    'Open Thala, go to veTHL and unlock the expired lock (claim dividends first).',
    `Or call ${THALA_VE}::scripts::unlock<${THL}>() from the locking account.`,
  ],
  officialUrl: 'https://app.thala.fi',
  read: readLock,
};

// ---- matured farm-reward vesting claims ---------------------------------------------------------------------

const VESTING = 'thala-vesting-matured';

async function readVesting(ctx: ReadContext, ownerInput: string): Promise<ReadResult> {
  const owner = normalizeAddress(ownerInput);
  const version = ctx.ledger.version;
  try {
    const beneficiary = await ctx.chain.resource(owner, `${THALA_VEST}::farming_vesting::VestingBeneficiary`, version);
    if (!beneficiary?.claim_ids?.length) return { positions: [], complete: true, errors: [], ledgerVersion: version };
    const [claims] = await ctx.chain.view(`${THALA_VEST}::farming_vesting::all_claims`, [owner], [], version);
    const positions: Position[] = [];
    for (const c of claims as any[]) {
      if (normalizeAddress(c.beneficiary) !== owner) throw new Error(`Claim ${c.claim_id} belongs to ${c.beneficiary}`);
      const ready = BigInt(c.claimable_amount), total = BigInt(c.total_amount), end = Number(c.end_sec);
      // Before end_sec a claim is still vesting (claiming early forfeits the rest): not left behind.
      if (end > ctx.ledger.timestampSecs || ready === 0n) continue;
      const locator = String(c.claim_id);
      positions.push({
        ...positionIds(VESTING, owner, locator, 'reward'), source: VESTING, owner, locator, positionKind: 'reward',
        claimableSince: iso(end), ageBasis: 'onchain_maturity',
        provenance: { reader: `${THALA_VEST}::farming_vesting::all_claims`, ledgerVersion: version },
        grossClaim: [{ asset: THL, raw: total.toString() }], expectedPayout: [{ asset: THL, raw: ready.toString() }],
        payoutBasis: 'view', status: 'recoverable', blockers: [], confidence: 'verified_view', observedAt: iso(ctx.ledger.timestampSecs),
        steps: [{ function: `${THALA_VEST}::farming_vesting_scripts::claim`, arguments: [locator], prerequisites: [],
          expectedOutputs: [{ asset: THL, raw: ready.toString() }] }],
      });
    }
    return { positions, complete: true, errors: [], ledgerVersion: version };
  } catch (err) {
    return failed(version, err);
  }
}

export const thalaVestingMatured: SourceDef = {
  id: VESTING,
  chain: 'aptos',
  protocol: 'Thala',
  title: 'Vested THL never claimed',
  summary: 'Thala farm rewards you put into vesting finished vesting, but the THL was never claimed.',
  category: 'closed_app',
  inclusionRule: 'R2 ended position: vesting claim reached end_sec with a claimable amount.',
  protocolStatus: { state: 'live', evidence: 'Thala farming vesting is operating.', checkedAt: '2026-10-18' },
  refresh: { nonZero: 'every_run', zero: 'monthly' },
  headlineAgeBases: ['onchain_maturity'],
  howTo: [
    'Open Thala, go to vesting and claim the finished vesting.',
    `Or call ${THALA_VEST}::farming_vesting_scripts::claim(claim_id) from the beneficiary account.`,
  ],
  officialUrl: 'https://app.thala.fi',
  read: readVesting,
};
