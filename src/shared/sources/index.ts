import type { SourceDef } from '../types.ts';
import { delegation } from './delegation.ts';
import { thalaUnstake } from './thala-unstake.ts';

export const SOURCES: SourceDef<any>[] = [delegation, thalaUnstake];
