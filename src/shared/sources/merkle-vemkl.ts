// Merkle Trade vote-escrowed MKL locks (veMKL) never unlocked after the wind-down. Since the wind-down, unlock
// works regardless of the lock's unlock_time (simulated 2026-10-19). MKL has no fresh quote (CoinGecko last updated
// 2026-05-04), so amounts stay unpriced.
import { iso, positionIds } from '../accounting.ts';
import { mapLimit, normalizeAddress } from '../chain.ts';
import type { Position, ReadContext, ReadResult, SourceDef } from '../types.ts';
import { MERKLE } from './merkle-mklp.ts';

export const VEMKL_COLLECTION = '0xe101e80f4edf81e21bad1f03974736f360bec063f230677be6b7d43c0e483216';
export const MKL = '0x878370592f9129e14b76558689a4b570ad22678111df775befbfcbc9fb3d90ab';
export const ESMKL = '0x03b5200e090d188c274e06b0d64b3f66638fb996fb0b350499975ff36b1f4595';
/** Locked PreMKL is paid out as MKL on unlock (1:1, from Merkle's community pool; simulated 2026-10-19). */
export const PREMKL = '0x0892b4d9fa26054943da2e08c82dbb8b6791adc398e6a427d5ace188575085b3';
const SOURCE = 'merkle-vemkl';
const WINDDOWN_SECS = Date.parse('2026-02-12T00:00:00Z') / 1000;

export type TokensHint = { tokens: string[] };

const TOKENS_QUERY = `query($o:String!,$c:String!){ current_token_ownerships_v2(where:{owner_address:{_eq:$o}, amount:{_gt:"0"},
  current_token_data:{collection_id:{_eq:$c}}}, limit:100){ token_data_id } }`;

async function read(ctx: ReadContext, ownerInput: string, hint?: TokensHint): Promise<ReadResult> {
  const owner = normalizeAddress(ownerInput);
  const version = ctx.ledger.version;
  const errors: string[] = [];
  let failed = 0;
  const tokens: string[] = hint?.tokens ??
    (await ctx.chain.gql(TOKENS_QUERY, { o: owner, c: VEMKL_COLLECTION })).current_token_ownerships_v2.map((t: any) => t.token_data_id);
  const found = await mapLimit(tokens.map(normalizeAddress), 4, async (token): Promise<Position | null> => {
    try {
      const [core, lock] = await Promise.all([
        ctx.chain.resource(token, '0x1::object::ObjectCore', version),
        ctx.chain.resource(token, `${MERKLE}::staking::VoteEscrowedMKL`, version),
      ]);
      // Unlocked locks are burned; a lock that moved belongs to its new owner's read.
      if (!core || !lock || normalizeAddress(core.owner) !== owner) return null;
      const stores = await Promise.all([lock.mkl_token.inner, lock.esmkl_token.inner].map(async s =>
        ctx.chain.resource(normalizeAddress(s), '0x1::fungible_asset::FungibleStore', version)));
      const amounts = stores.filter(s => s && BigInt(s.balance) > 0n)
        .map(s => ({ asset: normalizeAddress(s.metadata.inner), raw: String(s.balance) }));
      if (!amounts.length) return null;
      const mkl = amounts.filter(a => a.asset === MKL || a.asset === PREMKL).reduce((sum, a) => sum + BigInt(a.raw), 0n);
      const payout = [...(mkl > 0n ? [{ asset: MKL, raw: mkl.toString() }] : []), ...amounts.filter(a => a.asset !== MKL && a.asset !== PREMKL)];
      return {
        ...positionIds(SOURCE, owner, token, 'principal'), source: SOURCE, owner, locator: token, positionKind: 'principal',
        claimableSince: iso(Math.max(WINDDOWN_SECS, Number(lock.lock_time))), ageBasis: 'protocol_closure',
        provenance: { reader: `${MERKLE}::staking::VoteEscrowedMKL`, ledgerVersion: version },
        grossClaim: amounts, expectedPayout: payout, payoutBasis: 'derived',
        status: 'recoverable', blockers: [], confidence: 'verified_view', observedAt: iso(ctx.ledger.timestampSecs),
        steps: [{ function: `${MERKLE}::managed_staking::unlock`, arguments: [token], prerequisites: [], expectedOutputs: payout }],
      };
    } catch (err) {
      failed++;
      errors.push(`token ${token}: ${String(err).slice(0, 200)}`);
      return null;
    }
  });
  return { positions: found.filter((p): p is Position => p !== null), complete: failed === 0, errors, ledgerVersion: version };
}

export const merkleVemkl: SourceDef<TokensHint> = {
  id: SOURCE,
  chain: 'aptos',
  protocol: 'Merkle Trade',
  title: 'Merkle Trade staked MKL (veMKL) never unlocked',
  summary: 'Merkle Trade wound down in February 2026. Locked MKL can be unlocked at any time since then, but these locks were never unlocked.',
  category: 'closed_app',
  inclusionRule: 'Protocol wound down (2026-02); veMKL unlock works regardless of unlock_time since the wind-down.',
  protocolStatus: {
    state: 'wound_down',
    evidence: 'Wind-down announced 2026-02-03 (final distribution 02-12, "staked MKL can be redeemed after that"); unlock of a lock due 2026-12-03 simulated successfully on 2026-10-19.',
    checkedAt: '2026-10-19',
    effectiveAt: '2026-02-12T00:00:00Z',
  },
  refresh: { nonZero: 'monthly', zero: 'monthly' },
  headlineAgeBases: ['protocol_closure'],
  howTo: [
    'Open Merkle Trade staking if it is still online and unlock your veMKL.',
    `Or call ${MERKLE}::managed_staking::unlock(veMKL token address) from the holding account.`,
  ],
  officialUrl: 'https://app.merkle.trade',
  read,
};
