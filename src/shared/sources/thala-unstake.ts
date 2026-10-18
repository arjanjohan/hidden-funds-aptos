// Thala thAPT → APT unstake requests that matured but were never completed.
// Evidence and measurements: docs/phase0-report.md §2.
import { iso, positionIds } from '../accounting.ts';
import { normalizeAddress, once } from '../chain.ts';
import type { Position, ReadContext, ReadResult, SourceDef } from '../types.ts';
import { APT } from './delegation.ts';

export const THALA_LSD = '0xfaf4e633ae9eb31366c9ca24214231760926576c7b625313b3688b5e900731f6';
const SOURCE = 'thala-unstake';

function paused(ctx: ReadContext): Promise<boolean> {
  return once(ctx, `thala-paused:${ctx.ledger.version}`, async () => {
    const flag = await ctx.chain.resource(THALA_LSD, `${THALA_LSD}::staking::PauseFlag`, ctx.ledger.version);
    if (!flag) throw new Error('Thala PauseFlag missing');
    return flag.paused === true;
  });
}

async function read(ctx: ReadContext, ownerInput: string): Promise<ReadResult> {
  const owner = normalizeAddress(ownerInput);
  const version = ctx.ledger.version;
  try {
    const [requests] = await ctx.chain.view(`${THALA_LSD}::staking::user_unstake`, [owner], [], version);
    const matured = (requests as any[]).filter(r => Number(r.end_sec) <= ctx.ledger.timestampSecs && BigInt(r.amount) > 0n);
    const isPaused = matured.length ? await paused(ctx) : false;
    const positions: Position[] = matured.map(r => {
      if (normalizeAddress(r.account) !== owner) throw new Error(`Request ${r.request_id} belongs to ${r.account}`);
      const locator = String(r.request_id);
      const amount = [{ asset: APT, raw: String(r.amount) }];
      return {
        ...positionIds(SOURCE, owner, locator, 'request'), source: SOURCE, owner, locator, positionKind: 'request',
        claimableSince: iso(Number(r.end_sec)), ageBasis: 'onchain_maturity',
        provenance: { reader: `${THALA_LSD}::staking::user_unstake`, ledgerVersion: version },
        grossClaim: amount, expectedPayout: amount, payoutBasis: 'view',
        status: isPaused ? 'blocked' : 'recoverable',
        blockers: isPaused ? [{ code: 'paused', detail: 'Thala liquid staking PauseFlag is set.' }] : [],
        confidence: 'verified_view', observedAt: iso(ctx.ledger.timestampSecs),
        steps: [{ function: `${THALA_LSD}::scripts::complete_unstake_APT`, arguments: [locator], prerequisites: [], expectedOutputs: amount }],
      };
    });
    return { positions, complete: true, errors: [], ledgerVersion: version };
  } catch (err) {
    return { positions: [], complete: false, errors: [String(err).slice(0, 300)], ledgerVersion: version };
  }
}

export const thalaUnstake: SourceDef = {
  id: SOURCE,
  chain: 'aptos',
  title: 'Thala APT unstake never claimed',
  summary: 'You asked Thala to turn thAPT back into APT. The 14-day wait ended, but the APT was never claimed.',
  category: 'liquid_staking',
  inclusionRule: 'R2 ended position: unstake request matured (end_sec passed).',
  protocolStatus: { state: 'live', evidence: 'Thala liquid staking PauseFlag false on 2026-10-18.', checkedAt: '2026-10-18' },
  refresh: { nonZero: 'every_run', zero: 'monthly' },
  headlineAgeBases: ['onchain_maturity'],
  howTo: [
    'Open Thala liquid staking and claim the finished unstake request.',
    `Or call ${THALA_LSD}::scripts::complete_unstake_APT(request_id) from the requesting account.`,
  ],
  officialUrl: 'https://app.thala.fi',
  read,
};
