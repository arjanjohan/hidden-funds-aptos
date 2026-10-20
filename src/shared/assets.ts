// Display identity for assets that sources pay out. Identity is the exact id, never a ticker.
import { APT, MOVE } from './sources/delegation.ts';
import { WH_USDC, WH_WETH } from './sources/echelon-sunset.ts';
import { KAPT, STKAPT } from './sources/kofi-receipts.ts';
import { LZ_COINS } from './sources/layerzero-claimable.ts';
import { MKLP } from './sources/merkle-mklp.ts';
import { ESMKL, MKL, PREMKL } from './sources/merkle-vemkl.ts';
import { THL } from './sources/thala-thl.ts';

export const ASSETS: Record<string, { symbol: string; decimals: number }> = {
  ...Object.fromEntries(LZ_COINS.map(c => [c.coin, { symbol: c.display, decimals: c.decimals }])),
  [APT]: { symbol: 'APT', decimals: 8 },
  [THL]: { symbol: 'THL', decimals: 8 },
  [MOVE]: { symbol: 'MOVE', decimals: 8 },
  [WH_USDC]: { symbol: 'whUSDC', decimals: 6 },
  [WH_WETH]: { symbol: 'whWETH', decimals: 8 },
  [KAPT]: { symbol: 'kAPT', decimals: 8 },
  [STKAPT]: { symbol: 'stkAPT', decimals: 8 },
  [MKLP[0].coin]: { symbol: 'MKLP', decimals: 6 },
  [MKLP[1].coin]: { symbol: 'MKLP', decimals: 6 },
  [MKL]: { symbol: 'MKL', decimals: 6 },
  [ESMKL]: { symbol: 'esMKL', decimals: 6 },
  [PREMKL]: { symbol: 'PreMKL', decimals: 6 },
};
