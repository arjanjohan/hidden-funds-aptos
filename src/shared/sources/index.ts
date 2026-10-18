import type { SourceDef } from '../types.ts';
import { amnisWithdrawals } from './amnis-withdrawals.ts';
import { delegation } from './delegation.ts';
import { delegationInactiveValidator } from './delegation-inactive.ts';
import { kofiWithdrawals } from './kofi-withdrawals.ts';
import { thalaVestingMatured, thalaVethlExpired } from './thala-thl.ts';
import { thalaUnstake } from './thala-unstake.ts';
import { tortugaTickets } from './tortuga-tickets.ts';

export const SOURCES: SourceDef<any>[] = [delegation, delegationInactiveValidator, thalaUnstake, kofiWithdrawals, tortugaTickets, amnisWithdrawals, thalaVethlExpired, thalaVestingMatured];
