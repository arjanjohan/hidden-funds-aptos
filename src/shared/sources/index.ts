import type { SourceDef } from '../types.ts';
import { delegation } from './delegation.ts';
import { kofiWithdrawals } from './kofi-withdrawals.ts';
import { thalaUnstake } from './thala-unstake.ts';
import { tortugaTickets } from './tortuga-tickets.ts';

export const SOURCES: SourceDef<any>[] = [delegation, thalaUnstake, kofiWithdrawals, tortugaTickets];
