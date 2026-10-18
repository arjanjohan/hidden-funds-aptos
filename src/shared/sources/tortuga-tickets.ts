// Tortuga tAPT unstake tickets past their cooldown that were never claimed.
// stake_router has no views; claimability follows stake_router::claim (cooldown passed, and the ticket's queue
// position is within reserve + cleared claims, and the reserve covers the amount).
import { iso, positionIds } from '../accounting.ts';
import { normalizeAddress, once } from '../chain.ts';
import type { Position, ReadContext, ReadResult, SourceDef } from '../types.ts';
import { APT } from './delegation.ts';

export const TORTUGA = '0x8f396e4246b2ba87b51c0739ef5ea4f26515a98375308c31ac2ec1e42142a57f';
/** Account that holds Tortuga's protocol state. */
export const TORTUGA_STATE = '0x84d7aeef42d38a5ffc3ccef853e1b82e4958659d16a7de736a29c55fbbeb0114';
const SOURCE = 'tortuga-tickets';

export interface TortugaState { claims: bigint; cleared: bigint; reserve: bigint; cooldown: number }

export function tortugaState(ctx: ReadContext): Promise<TortugaState> {
  return once(ctx, `tortuga-state:${ctx.ledger.version}`, async () => {
    const [status, reserve] = await Promise.all([
      ctx.chain.resource(TORTUGA_STATE, `${TORTUGA}::stake_router::StakingStatus`, ctx.ledger.version),
      ctx.chain.resource(TORTUGA_STATE, `${TORTUGA}::validator_router::AptosCoinReserve`, ctx.ledger.version),
    ]);
    if (!status || !reserve) throw new Error('Tortuga protocol state missing');
    return { claims: BigInt(status.total_claims_balance), cleared: BigInt(status.total_claims_balance_cleared),
      reserve: BigInt(reserve.coin.value), cooldown: Number(status.cooldown_period) };
  });
}

async function read(ctx: ReadContext, ownerInput: string): Promise<ReadResult> {
  const owner = normalizeAddress(ownerInput);
  const version = ctx.ledger.version;
  try {
    const store = await ctx.chain.resource(owner, `${TORTUGA}::stake_router::TicketStore`, version);
    const tickets: any[] = store?.tickets ?? [];
    if (!tickets.length) return { positions: [], complete: true, errors: [], ledgerVersion: version };
    const state = await tortugaState(ctx);
    const positions: Position[] = [];
    tickets.forEach((t, index) => {
      const id = BigInt(t.id), amount = BigInt(t.amount), unlockAt = Number(t.timestamp) + state.cooldown;
      if (unlockAt > ctx.ledger.timestampSecs || amount === 0n) return;   // still cooling down
      const funded = id <= state.reserve + state.cleared && amount <= state.reserve;
      const locator = id.toString();
      const value = [{ asset: APT, raw: amount.toString() }];
      positions.push({
        ...positionIds(SOURCE, owner, locator, 'request'), source: SOURCE, owner, locator, positionKind: 'request',
        claimableSince: iso(unlockAt), ageBasis: 'onchain_maturity',
        provenance: { reader: `${TORTUGA}::stake_router::TicketStore`, ledgerVersion: version },
        grossClaim: value, expectedPayout: value, payoutBasis: 'derived',
        status: funded ? 'recoverable' : 'blocked',
        blockers: funded ? [] : [{ code: 'reserve_short', detail: 'Tortuga\'s reserve does not cover this ticket\'s place in the claim queue yet.' }],
        confidence: 'derived_math', observedAt: iso(ctx.ledger.timestampSecs),
        steps: [{ function: `${TORTUGA}::stake_router::claim`, arguments: [String(index)],
          prerequisites: ['The argument is the ticket\'s index in your ticket list; indexes shift after each claim, so re-check before claiming another.'],
          expectedOutputs: value }],
      });
    });
    return { positions, complete: true, errors: [], ledgerVersion: version };
  } catch (err) {
    return { positions: [], complete: false, errors: [String(err).slice(0, 300)], ledgerVersion: version };
  }
}

export const tortugaTickets: SourceDef = {
  id: SOURCE,
  chain: 'aptos',
  title: 'Tortuga unstake ticket never claimed',
  summary: 'You unstaked tAPT on Tortuga. The cooldown ended, but the APT ticket was never claimed.',
  category: 'liquid_staking',
  inclusionRule: 'R2 ended position: ticket cooldown passed. Tickets the reserve cannot cover yet are blocked.',
  protocolStatus: { state: 'live', evidence: 'Contracts still respond; no closure notice verified. Reserve is short of outstanding tickets.', checkedAt: '2026-10-18' },
  refresh: { nonZero: 'every_run', zero: 'weekly' },
  headlineAgeBases: ['onchain_maturity'],
  howTo: [
    'Open the Tortuga app if it is online and claim the ticket.',
    `Or call ${TORTUGA}::stake_router::claim(index) from the account that unstaked, where index is the ticket's position in your ticket list (0 = first).`,
  ],
  officialUrl: 'https://tortuga.finance',
  read,
};
