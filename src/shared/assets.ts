// Display identity for assets that sources pay out. Identity is the exact id, never a ticker.
import { APT, MOVE } from './sources/delegation.ts';
import { KAPT, STKAPT } from './sources/kofi-receipts.ts';
import { THL } from './sources/thala-thl.ts';

export const ASSETS: Record<string, { symbol: string; decimals: number }> = {
  [APT]: { symbol: 'APT', decimals: 8 },
  [THL]: { symbol: 'THL', decimals: 8 },
  [MOVE]: { symbol: 'MOVE', decimals: 8 },
  [KAPT]: { symbol: 'kAPT', decimals: 8 },
  [STKAPT]: { symbol: 'stkAPT', decimals: 8 },
};
