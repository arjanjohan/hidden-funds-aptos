import type { SourceDef } from '../types.ts';
import { aaveFrozenReserves } from './aave-frozen.ts';
import { amnisWithdrawals } from './amnis-withdrawals.ts';
import { animeswapClosedLp } from './animeswap-closed.ts';
import { earniumClosedLp } from './earnium-closed.ts';
import { auroClosedPositions } from './auro-closed.ts';
import { canopyFrozenVaults } from './canopy-frozen.ts';
import { canopyEndedRewards } from './canopy-rewards.ts';
import { delegation, movementDelegation } from './delegation.ts';
import { echelonFrozenMarkets } from './echelon-frozen.ts';
import { econiaIdleAccounts } from './econia-idle.ts';
import { delegationInactiveValidator, movementInactiveValidator } from './delegation-inactive.ts';
import { kofiReceipts } from './kofi-receipts.ts';
import { kofiWithdrawals } from './kofi-withdrawals.ts';
import { layerzeroClaimable } from './layerzero-claimable.ts';
import { merkleMklp } from './merkle-mklp.ts';
import { merkleVemkl } from './merkle-vemkl.ts';
import { pancakeFarmEndedRewards } from './pancake-farm.ts';
import { pancakeSyrupEnded } from './pancake-syrup.ts';
import { thalaVestingMatured, thalaVethlExpired } from './thala-thl.ts';
import { thalaUnstake } from './thala-unstake.ts';
import { topazBids } from './topaz-bids.ts';
import { tortugaTickets } from './tortuga-tickets.ts';
import { trufinUnlocks } from './trufin-unlocks.ts';

export const SOURCES: SourceDef<any>[] = [delegation, delegationInactiveValidator, thalaUnstake, kofiWithdrawals, tortugaTickets, amnisWithdrawals, thalaVethlExpired, thalaVestingMatured, trufinUnlocks, kofiReceipts, merkleMklp, merkleVemkl, layerzeroClaimable, pancakeSyrupEnded, pancakeFarmEndedRewards, topazBids, echelonFrozenMarkets, aaveFrozenReserves, econiaIdleAccounts, auroClosedPositions, animeswapClosedLp, earniumClosedLp,
  movementDelegation, movementInactiveValidator, canopyEndedRewards, canopyFrozenVaults];
