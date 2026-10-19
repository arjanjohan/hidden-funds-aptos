// Kofi (kAPT/stkAPT) withdrawal tickets that unlocked but were never finalized. Kofi is winding down.
import { iso, positionIds } from '../accounting.ts';
import { normalizeAddress, once } from '../chain.ts';
import type { Position, ReadContext, ReadResult, SourceDef } from '../types.ts';
import { APT } from './delegation.ts';

export const KOFI = '0x2cc52445acc4c5e5817a0ac475976fbef966fedb6e30e7db792e10619c76181f';
const SOURCE = 'kofi-withdrawals';

function withdrawalsPaused(ctx: ReadContext): Promise<boolean> {
  return once(ctx, `kofi-paused:${ctx.ledger.version}`, async () => {
    const config = await ctx.chain.resource(KOFI, `${KOFI}::config::GlobalConfig`, ctx.ledger.version);
    if (!config) throw new Error('Kofi GlobalConfig missing');
    return config.gateway_config.withdrawals_paused === true;
  });
}

async function read(ctx: ReadContext, ownerInput: string): Promise<ReadResult> {
  const owner = normalizeAddress(ownerInput);
  const version = ctx.ledger.version;
  try {
    const [tickets] = await ctx.chain.view(`${KOFI}::withdrawal_manager::get_user_tickets`, [owner], [], version);
    const matured = (tickets as any[]).filter(t => Number(t.unlock_timestamp) <= ctx.ledger.timestampSecs && BigInt(t.apt_amount) > 0n);
    const paused = matured.length ? await withdrawalsPaused(ctx) : false;
    const positions: Position[] = matured.map(t => {
      if (normalizeAddress(t.user) !== owner) throw new Error(`Ticket ${t.ticket_id} belongs to ${t.user}`);
      const locator = String(t.ticket_id);
      const gross = [{ asset: APT, raw: String(t.apt_amount) }];
      const payout = [{ asset: APT, raw: String(BigInt(t.apt_amount) - BigInt(t.withdraw_fees)) }];
      return {
        ...positionIds(SOURCE, owner, locator, 'request'), source: SOURCE, owner, locator, positionKind: 'request',
        claimableSince: iso(Number(t.unlock_timestamp)), ageBasis: 'onchain_maturity',
        provenance: { reader: `${KOFI}::withdrawal_manager::get_user_tickets`, ledgerVersion: version },
        grossClaim: gross, expectedPayout: payout, payoutBasis: 'view',
        status: paused ? 'blocked' : 'recoverable',
        blockers: paused ? [{ code: 'paused', detail: 'Kofi withdrawals are paused.' }] : [],
        confidence: 'verified_view', observedAt: iso(ctx.ledger.timestampSecs),
        steps: [{ function: `${KOFI}::gateway::finalize_withdrawals_entry`, arguments: [`[${locator}]`], prerequisites: [], expectedOutputs: payout }],
      };
    });
    return { positions, complete: true, errors: [], ledgerVersion: version };
  } catch (err) {
    return { positions: [], complete: false, errors: [String(err).slice(0, 300)], ledgerVersion: version };
  }
}

export const kofiWithdrawals: SourceDef = {
  id: SOURCE,
  chain: 'aptos',
  protocol: 'Kofi',
  title: 'Kofi withdrawal never finalized',
  summary: 'You asked Kofi to turn kAPT into APT. The ticket unlocked, but the APT was never collected. Kofi is winding down.',
  category: 'closed_app',
  inclusionRule: 'R2 ended position: withdrawal ticket unlocked (unlock_timestamp passed); the protocol is also winding down.',
  protocolStatus: {
    state: 'wound_down',
    evidence: 'config::is_winddown became true at version 6,429,705,721 (multisig transaction); deposits and staking paused.',
    checkedAt: '2026-10-18',
    effectiveAt: '2026-07-24T07:55:53Z',
  },
  refresh: { nonZero: 'every_run', zero: 'monthly' },
  headlineAgeBases: ['onchain_maturity'],
  howTo: [
    'Open the Kofi app while it is still online and finalize the unlocked withdrawal.',
    `Or call ${KOFI}::gateway::finalize_withdrawals_entry([ticket_id]) from the account that requested it.`,
  ],
  officialUrl: 'https://app.kofi.finance',
  read,
};
