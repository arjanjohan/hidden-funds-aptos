// Amnis withdrawal NFTs (amAPT → APT) whose lockup ended but were never redeemed.
import { iso, positionIds } from '../accounting.ts';
import { mapLimit, normalizeAddress } from '../chain.ts';
import { ownedIn } from '../owned.ts';
import type { Position, ReadContext, ReadResult, SourceDef } from '../types.ts';
import { APT } from './delegation.ts';

export const AMNIS = '0x111ae3e5bc816a5e63c2da97d0aa3886519e0cd5e4b046659fa35796bd11542a';
/** "Amnis Withdrawal Tokens", created by the Amnis package. */
export const AMNIS_WITHDRAWAL_COLLECTION = '0x40fb9ce6950a90c3677b9c4e1fcd75d2ac2933ae86efdb768955adc6730c6b8d';
const SOURCE = 'amnis-withdrawals';

export type TokensHint = { tokens: string[] };

async function read(ctx: ReadContext, ownerInput: string, hint?: TokensHint): Promise<ReadResult> {
  const owner = normalizeAddress(ownerInput);
  const version = ctx.ledger.version;
  const errors: string[] = [];
  let failed = 0;
  const tokens: string[] = hint?.tokens ?? await ownedIn(ctx, owner, AMNIS_WITHDRAWAL_COLLECTION);
  const found = await mapLimit(tokens.map(normalizeAddress), 4, async (token): Promise<Position | null> => {
    try {
      const [core, withdrawal] = await Promise.all([
        ctx.chain.resource(token, '0x1::object::ObjectCore', version),
        ctx.chain.resource(token, `${AMNIS}::withdrawal::WithdrawalToken`, version),
      ]);
      // Redeemed tokens are burned; a token that moved since indexing belongs to its new owner's read.
      if (!core || !withdrawal || normalizeAddress(core.owner) !== owner) return null;
      const lockedUntil = Number(withdrawal.locked_until_secs), amount = BigInt(withdrawal.amapt.value);
      if (lockedUntil > ctx.ledger.timestampSecs || amount === 0n) return null;
      const value = [{ asset: APT, raw: amount.toString() }];
      return {
        ...positionIds(SOURCE, owner, token, 'request'), source: SOURCE, owner, locator: token, positionKind: 'request',
        claimableSince: iso(lockedUntil), ageBasis: 'onchain_maturity',
        provenance: { reader: `${AMNIS}::withdrawal::WithdrawalToken`, ledgerVersion: version },
        // amAPT redeems 1:1 for APT; confirmed by sample simulation (docs/sources.md).
        grossClaim: value, expectedPayout: value, payoutBasis: 'derived',
        status: 'recoverable', blockers: [], confidence: 'verified_view', observedAt: iso(ctx.ledger.timestampSecs),
        steps: [{ function: `${AMNIS}::router::withdraw_entry`, arguments: [token], prerequisites: [], expectedOutputs: value }],
      };
    } catch (err) {
      failed++;
      errors.push(`token ${token}: ${String(err).slice(0, 200)}`);
      return null;
    }
  });
  return { positions: found.filter((p): p is Position => p !== null), complete: failed === 0, errors, ledgerVersion: version };
}

export const amnisWithdrawals: SourceDef<TokensHint> = {
  id: SOURCE,
  chain: 'aptos',
  protocol: 'Amnis',
  title: 'Amnis withdrawal never redeemed',
  summary: 'You asked Amnis to turn amAPT into APT and received a withdrawal NFT. The lockup ended, but the APT was never redeemed.',
  category: 'liquid_staking',
  inclusionRule: 'R2 ended position: withdrawal token lockup passed (locked_until_secs).',
  protocolStatus: { state: 'live', evidence: 'Amnis liquid staking is operating.', checkedAt: '2026-10-18' },
  refresh: { nonZero: 'every_run', zero: 'monthly' },
  headlineAgeBases: ['onchain_maturity'],
  howTo: [
    'Open Amnis, go to your withdrawals and redeem the finished withdrawal NFT.',
    `Or call ${AMNIS}::router::withdraw_entry(token) from the account holding the "Amnis Withdrawal Tokens" NFT.`,
  ],
  officialUrl: 'https://stake.amnis.finance',
  read,
};
