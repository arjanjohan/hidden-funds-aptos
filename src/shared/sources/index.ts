import type { SourceDef } from '../types.ts';
import { amnisWithdrawals } from './amnis-withdrawals.ts';
import { delegation, movementDelegation } from './delegation.ts';
import { delegationInactiveValidator, movementInactiveValidator } from './delegation-inactive.ts';
import { kofiReceipts } from './kofi-receipts.ts';
import { kofiWithdrawals } from './kofi-withdrawals.ts';
import { merkleMklp } from './merkle-mklp.ts';
import { thalaVestingMatured, thalaVethlExpired } from './thala-thl.ts';
import { thalaUnstake } from './thala-unstake.ts';
import { tortugaTickets } from './tortuga-tickets.ts';
import { trufinUnlocks } from './trufin-unlocks.ts';

export const SOURCES: SourceDef<any>[] = [delegation, delegationInactiveValidator, thalaUnstake, kofiWithdrawals, tortugaTickets, amnisWithdrawals, thalaVethlExpired, thalaVestingMatured, trufinUnlocks, kofiReceipts, merkleMklp,
  movementDelegation, movementInactiveValidator];
