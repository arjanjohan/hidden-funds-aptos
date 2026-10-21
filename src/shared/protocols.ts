// Every Aptos and Movement protocol we know of, with what we did about it. Seeded from DefiLlama's protocol list
// (2026-10-20: 91 on Aptos, 8 on Movement) plus protocols DefiLlama does not list. Evidence for implemented sources and
// sized candidates lives in docs/sources.md; this is the index. `not_checked` means nobody has looked yet.

export type ProtocolStatus =
  | 'implemented'     // has sources (listed)
  | 'dormant'         // a source exists but counts nothing until a trigger
  | 'needs_decision'  // waiting on a rule decision (issue)
  | 'blocked'         // funds may be left behind, but cannot be read or recovered usefully
  | 'too_small'       // sized; below what is worth a source
  | 'not_left_behind' // checked; nothing qualifies (live protocol, nothing ended, or nothing held for users)
  | 'out_of_scope'    // not a protocol that holds users' on-chain positions (custodial exchanges)
  | 'not_checked';

export interface ProtocolEntry {
  id: string;
  name: string;
  chains: ('aptos' | 'movement')[];
  category: string;
  status: ProtocolStatus;
  /** One sentence: why this status. */
  reason: string;
  /** When the status was last checked (absent while not checked). */
  checkedAt?: string;
  sources?: string[];
  issue?: number;
  /** DefiLlama slug, for its page. */
  defillama?: string;
  /** DefiLlama marks the protocol dead (with its date when it gives one). */
  dead?: string;
}

const A = ['aptos'] as const, M = ['movement'] as const;
const cex = (id: string, name: string): ProtocolEntry => ({ id, name, chains: [...A], category: 'CEX', status: 'out_of_scope',
  reason: 'Custodial exchange: balances are held by the exchange, not in an on-chain position.', checkedAt: '2026-10-20', defillama: id });

export const PROTOCOLS: ProtocolEntry[] = [
  // Implemented
  { id: 'aptos-native-staking', name: 'Aptos native staking', chains: [...A], category: 'Staking', status: 'implemented', checkedAt: '2026-10-20',
    reason: 'Unstaked APT whose lockup ended, and stake left with validators that left the set.', sources: ['native-delegation', 'delegation-inactive-validator'] },
  { id: 'thala-lsd', name: 'Thala LSD', chains: [...A], category: 'Liquid Staking', status: 'implemented', checkedAt: '2026-10-20',
    reason: 'Matured unstake requests never claimed.', sources: ['thala-unstake'], defillama: 'thala-lsd' },
  { id: 'thala-vethl', name: 'Thala veTHL', chains: [...A], category: 'Liquid Staking', status: 'implemented', checkedAt: '2026-10-20',
    reason: 'Expired veTHL locks never unlocked.', sources: ['thala-vethl-expired'], defillama: 'thala-vethl' },
  { id: 'thalaswap', name: 'ThalaSwap', chains: [...A], category: 'Dexs', status: 'implemented', checkedAt: '2026-10-20',
    reason: 'Vested farm rewards never claimed. v1 LP itself still trades (live liquidity).', sources: ['thala-vesting-matured'], defillama: 'thalaswap' },
  { id: 'kofi-finance', name: 'Kofi Finance', chains: [...A], category: 'Liquid Staking', status: 'implemented', checkedAt: '2026-10-20',
    reason: 'Wound down: matured withdrawal tickets, and kAPT/stkAPT still held without a market.', sources: ['kofi-withdrawals', 'kofi-receipts'], defillama: 'kofi-finance' },
  { id: 'tortuga', name: 'Tortuga', chains: [...A], category: 'Liquid Staking', status: 'implemented', checkedAt: '2026-10-20',
    reason: 'Unstake tickets never claimed.', sources: ['tortuga-tickets'], defillama: 'tortuga', dead: 'yes' },
  { id: 'amnis-finance', name: 'Amnis Finance', chains: [...A], category: 'Liquid Staking', status: 'implemented', checkedAt: '2026-10-20',
    reason: 'Withdrawal NFTs whose lockup ended, never redeemed.', sources: ['amnis-withdrawals'], defillama: 'amnis-finance' },
  { id: 'trustake', name: 'TruStake (TruFin)', chains: [...A], category: 'Liquid Staking', status: 'implemented', checkedAt: '2026-10-20',
    reason: 'Unlock requests claimable, never withdrawn.', sources: ['trufin-unlocks'], defillama: 'trustake' },
  { id: 'merkle-trade', name: 'Merkle Trade', chains: [...A], category: 'Derivatives', status: 'implemented', checkedAt: '2026-10-20',
    reason: 'Wound down in February 2026: LP left behind, and staked MKL never unlocked.', sources: ['merkle-mklp', 'merkle-vemkl'], defillama: 'merkle-trade', dead: '2026-02-03' },
  { id: 'layerzero-aptos-bridge', name: 'LayerZero Aptos Bridge', chains: [...A], category: 'Bridge', status: 'implemented', checkedAt: '2026-10-20',
    reason: 'Tokens bridged in that arrived but were never claimed.', sources: ['layerzero-claimable'] },
  { id: 'pancakeswap-amm', name: 'PancakeSwap', chains: [...A], category: 'Dexs', status: 'implemented', checkedAt: '2026-10-20',
    reason: 'CAKE left in syrup pools that ended in 2023-2024, and farm rewards never harvested after emissions ended.', sources: ['pancake-syrup-ended', 'pancake-farm-ended-rewards'], defillama: 'pancakeswap-amm' },
  { id: 'topaz', name: 'Topaz', chains: [...A], category: 'NFT Marketplace', status: 'implemented', checkedAt: '2026-10-20',
    reason: 'Closed in August 2024: APT escrowed in expired bids.', sources: ['topaz-bids'] },
  { id: 'echelon-market', name: 'Echelon (Aptos)', chains: [...A], category: 'Lending', status: 'implemented', checkedAt: '2026-10-20',
    reason: 'Supply left in the 21 frozen markets, by suppliers without debt.', sources: ['echelon-frozen-markets'], defillama: 'echelon-market' },
  { id: 'econia', name: 'Econia', chains: [...A], category: 'Dexs', status: 'implemented', checkedAt: '2026-10-20',
    reason: 'Repository archived 2025-09-08 and no trading since: coins left idle in market accounts.', sources: ['econia-idle-accounts'], defillama: 'econia', dead: '2025-09-08' },
  { id: 'movement-native-staking', name: 'Movement native staking', chains: [...M], category: 'Staking', status: 'implemented', checkedAt: '2026-10-20',
    reason: 'Unstaked MOVE whose lockup ended, and stake left with validators that left the set.', sources: ['movement-native-delegation', 'movement-inactive-validator'] },
  { id: 'canopy', name: 'Canopy', chains: [...M], category: 'Yield Aggregator', status: 'implemented', checkedAt: '2026-10-20',
    reason: 'Staking rewards from reward periods that ended, never claimed.', sources: ['canopy-ended-rewards'], defillama: 'canopy' },

  // Dormant
  { id: 'aave-aptos', name: 'Aave (Aptos)', chains: [...A], category: 'Lending', status: 'dormant', checkedAt: '2026-10-20',
    reason: 'Aave is winding down Aptos by freezing every reserve; the source counts supply once a reserve freezes. None is frozen yet.', sources: ['aave-frozen-reserves'], defillama: 'aave-aptos' },

  // Waiting on a decision
  { id: 'aries-markets', name: 'Aries Markets', chains: [...A], category: 'Lending', status: 'needs_decision', checkedAt: '2026-10-19', issue: 3,
    reason: 'Reserves were moved out in 2026; deposits can only show as "may not work", at ~285K reads a week.', defillama: 'aries-markets' },
  { id: 'portal', name: 'Wormhole (Portal)', chains: [...A], category: 'Bridge', status: 'needs_decision', checkedAt: '2026-10-19', issue: 1,
    reason: 'Transfers to Aptos never redeemed: a check-page lookup via the Wormhole API, or a pipeline source?', defillama: 'portal' },
  { id: 'layerzero-v2', name: 'LayerZero v2 OFTs and Stargate', chains: [...A, ...M], category: 'Bridge', status: 'needs_decision', checkedAt: '2026-10-19', issue: 2,
    reason: 'Messages that failed delivery: a check-page lookup via LayerZero Scan, or a pipeline source?' },

  // Blocked
  { id: 'aptin-finance', name: 'Aptin Finance', chains: [...A], category: 'Lending', status: 'blocked', checkedAt: '2026-10-07',
    reason: 'Every withdrawal aborts on stale prices (operator prices not updated since 2026-07-25); value could only show as "may not work".', defillama: 'aptin-finance-v2' },
  { id: 'kana-perps', name: 'Kana perps', chains: [...A], category: 'Derivatives', status: 'blocked', checkedAt: '2026-10-19',
    reason: 'Every market is deprecated and the collateral stores hold no USDt: recorded balances are face value only.' },
  { id: 'tapp-exchange', name: 'Tapp Exchange', chains: [...A], category: 'Dexs', status: 'blocked', checkedAt: '2026-10-19',
    reason: 'Wound down 2026-05-31; every router hook is paused, so liquidity cannot be removed.', defillama: 'tapp-exchange', dead: '2026-05-31' },
  { id: 'gui-lottery', name: 'GUI lottery', chains: [...A], category: 'Yield Lottery', status: 'blocked', checkedAt: '2026-10-07',
    reason: 'A claim needs a voucher signed by the operator.' },

  // Too small
  { id: 'fliq', name: 'Fliq', chains: [...A], category: 'Prediction market', status: 'too_small', checkedAt: '2026-10-20',
    reason: 'Unredeemed winnings would count, but all Fliq collateral is 4,200 USDt.' },
  { id: 'mirage-protocol', name: 'Mirage Protocol', chains: [...A, ...M], category: 'Derivatives', status: 'too_small', checkedAt: '2026-10-19',
    reason: 'Reportedly closed; ~$714 of TVL left.', defillama: 'mirage-protocol' },
  { id: 'aux-exchange', name: 'AUX Exchange', chains: [...A], category: 'Dexs', status: 'too_small', checkedAt: '2026-10-19',
    reason: 'Development ceased 2023-03-17; about $5K left in its pools.', defillama: 'aux-exchange' },
  { id: 'hyperion', name: 'Hyperion', chains: [...A], category: 'Dexs', status: 'too_small', checkedAt: '2026-10-19',
    reason: 'Live DEX; its delayed LP withdrawals (fridge) hold 4.70 APT unclaimed in total.', defillama: 'hyperion' },
  { id: 'cellana-finance', name: 'Cellana Finance', chains: [...A], category: 'Dexs', status: 'too_small', checkedAt: '2026-10-19',
    reason: 'CELL is quoted at $0.00006 (stale): expired veCELL locks are worth nothing.', defillama: 'cellana-finance', dead: 'yes' },
  { id: 'moar-market', name: 'Moar Market', chains: [...A], category: 'Leveraged Farming', status: 'too_small', checkedAt: '2026-10-20',
    reason: 'About $0 TVL; farming rewards are paid in a token without a price.', defillama: 'moar-market' },
  { id: 'yuzu-finance', name: 'Yuzu Finance', chains: [...M], category: 'Dexs', status: 'too_small', checkedAt: '2026-10-19',
    reason: 'Rewards are MOVE only, worth too little to track; LP is live liquidity.', defillama: 'yuzu-finance' },
  { id: 'echelon-movement', name: 'Echelon (Movement)', chains: [...M], category: 'Lending', status: 'too_small', checkedAt: '2026-10-20',
    reason: 'The 3 frozen markets (LBTC, SolvBTC, rsETH) hold ~$40 in total.', defillama: 'echelon-market' },
  { id: 'echelon-farming', name: 'Echelon farming rewards', chains: [...A, ...M], category: 'Lending', status: 'too_small', checkedAt: '2026-10-19',
    reason: 'Ended reward programs; Echelon holds only ~$3.6K (Aptos) and ~$2.1K of MOVE (Movement) to pay them.' },

  // Not left behind
  { id: 'superposition', name: 'Superposition', chains: [...A], category: 'Lending', status: 'not_left_behind', checkedAt: '2026-10-19',
    reason: 'Markets unpaused and still used; withdrawals take a packet its service still signs.', defillama: 'superposition' },
  { id: 'moveposition', name: 'MovePosition', chains: [...M], category: 'Lending', status: 'not_left_behind', checkedAt: '2026-10-20',
    reason: 'Live: its service still signs withdrawal packets.', defillama: 'moveposition' },
  { id: 'joule-finance', name: 'Joule Finance', chains: [...A], category: 'Lending', status: 'not_left_behind', checkedAt: '2026-10-20',
    reason: 'Live; withdrawals need paid Pyth price updates, a cost of using it, not a closure.', defillama: 'joule-finance' },
  { id: 'ditto', name: 'Ditto', chains: [...A], category: 'Liquid Staking', status: 'not_left_behind', checkedAt: '2026-10-19',
    reason: 'Unstake queue empty and redemption still works, so stAPT is not stranded.', defillama: 'ditto', dead: 'yes' },
  { id: 'thalaswap-v2', name: 'ThalaSwap V2', chains: [...A], category: 'Dexs', status: 'not_left_behind', checkedAt: '2026-10-19',
    reason: 'Live DEX: LP is live liquidity.', defillama: 'thalaswap-v2' },
  { id: 'thalaswap-v3', name: 'ThalaSwap V3', chains: [...A], category: 'Dexs', status: 'not_left_behind', checkedAt: '2026-10-19',
    reason: 'Live DEX: LP is live liquidity.', defillama: 'thalaswap-v3' },
  { id: 'meridian-amm', name: 'Meridian', chains: [...M], category: 'Dexs', status: 'not_left_behind', checkedAt: '2026-10-19',
    reason: 'Live DEX; staked LP is live principal and extra rewards are MOVE.', defillama: 'meridian-amm' },
  { id: 'near-intents', name: 'NEAR Intents', chains: [...A], category: 'Bridge', status: 'not_left_behind', checkedAt: '2026-10-19',
    reason: 'Swaps settled by solvers: nothing is held for the user on Aptos.', defillama: 'near-intents' },
  { id: 'bridges-settled', name: 'Meson, Gas.zip, ChangeNOW, Swapspace, Panora, CashmereLabs', chains: [...A], category: 'Bridge', status: 'not_left_behind', checkedAt: '2026-10-19',
    reason: 'Swaps settled by liquidity providers: nothing is held for the user on Aptos.' },
  { id: 'movement-framework-bridges', name: 'Movement framework bridges', chains: [...M], category: 'Bridge', status: 'not_left_behind', checkedAt: '2026-10-19',
    reason: 'atomic_bridge and native_bridge were never used on mainnet: event counters 0, transfer tables empty.' },
  { id: 'tradeport', name: 'TradePort', chains: [...A], category: 'NFT Marketplace', status: 'not_left_behind', checkedAt: '2026-10-19',
    reason: 'Left Aptos; every bid is gone.' },
  { id: 'validator-owned-pools', name: 'Validator-owned stake pools', chains: [...A], category: 'Staking', status: 'not_left_behind', checkedAt: '2026-10-20',
    reason: 'The large pools (14.4M and 4.1M APT) look institutional, between validator setups; no evidence of abandonment.' },
  { id: 'amnis-ami', name: 'Amnis AMI vesting and claims', chains: [...A], category: 'Liquid Staking', status: 'not_left_behind', checkedAt: '2026-10-19',
    reason: 'Vesting buckets belong to the team and investors; "AMI Claim" NFTs were paid off chain.' },

  // No closure evidence found (checked, nothing ended)
  { id: 'thala-cdp', name: 'Thala CDP (MOD)', chains: [...A], category: 'CDP', status: 'not_left_behind', checkedAt: '2026-10-19',
    reason: 'No closure notice found.', defillama: 'thala-cdp' },
  { id: 'auro-finance', name: 'Auro Finance', chains: [...A], category: 'CDP', status: 'implemented', checkedAt: '2026-10-21',
    reason: 'Website shut down by 2026-04-30 (team notice): collateral left in debt-free positions.', sources: ['auro-closed-positions'], defillama: 'auro-finance' },
  { id: 'echo', name: 'Echo (lending, liquid staking, strategy)', chains: [...A], category: 'Lending', status: 'not_left_behind', checkedAt: '2026-10-19',
    reason: 'No closure or withdrawal notice found.', defillama: 'echo-lending' },
  { id: 'souffl3', name: 'Souffl3', chains: [...A], category: 'NFT Marketplace', status: 'not_left_behind', checkedAt: '2026-10-19',
    reason: 'No closure evidence found.' },
  { id: 'celer-cbridge', name: 'Celer cBridge', chains: [...A], category: 'Bridge', status: 'not_left_behind', checkedAt: '2026-10-19',
    reason: 'No closure evidence; the peg bridge still mints.' },
  { id: 'argo', name: 'Argo', chains: [...A], category: 'CDP', status: 'not_left_behind', checkedAt: '2026-10-19',
    reason: 'No closure notice found.', defillama: 'argo', dead: 'yes' },
  { id: 'goblin', name: 'Goblin', chains: [...A], category: 'Yield Aggregator', status: 'not_left_behind', checkedAt: '2026-10-20',
    reason: 'No closure notice found (vaults run on Hyperion).', defillama: 'goblin' },
  { id: 'animeswap', name: 'AnimeSwap', chains: [...A], category: 'Dexs', status: 'implemented', checkedAt: '2026-10-21',
    reason: 'Frontend gone (no address record for animeswap.org, 2026-10-21): LP left in its pools, which still work.', sources: ['animeswap-closed-lp'], defillama: 'animeswap', dead: 'yes' },
  { id: 'abel-finance', name: 'ABEL Finance', chains: [...A], category: 'Lending', status: 'not_left_behind', checkedAt: '2026-10-21',
    reason: 'Still used despite DefiLlama\'s dead flag: mints, borrows and redemptions until 2026-10-17, liquidations 2026-10-16.', defillama: 'abel-finance', dead: 'yes' },
  { id: 'meso-finance', name: 'Meso Finance', chains: [...A], category: 'Lending', status: 'not_left_behind', checkedAt: '2026-10-20',
    reason: 'Still used despite DefiLlama\'s dead flag: deposits until 2026-09-23, withdrawals until 2026-09-14, all pools unpaused and accruing.', defillama: 'meso-finance', dead: 'yes' },
  { id: 'emojicoin.fun', name: 'Emojicoin.fun', chains: [...A], category: 'Launchpad', status: 'too_small', checkedAt: '2026-10-21',
    reason: 'Closed (frontend decommissioned 2025-09-04), so its LP and Arena escrows count, but they are small: LP worth ~748 APT on its APT side (427 holdings, 333 owners; one holds 423 APT) plus unpriced emojicoins, and Arena escrows ~182 APT of emojicoins.', defillama: 'emojicoin.fun', dead: 'yes' },
  { id: 'earnium', name: 'Earnium', chains: [...A], category: 'Dexs', status: 'implemented', checkedAt: '2026-10-21',
    reason: 'Frontend gone (no address record for earnium.io, 2026-10-21): LP left in its pools and liquidity staking, which still work.', sources: ['earnium-closed-lp'], defillama: 'earnium', dead: '2026-10-10' },
  { id: 'arche-protocol', name: 'Arche Protocol (MSD)', chains: [...M], category: 'CDP', status: 'too_small', checkedAt: '2026-10-21', defillama: 'arche-protocol', dead: 'yes',
    reason: 'Closed: archeprotocol.xyz (its listed site) is for sale; last served 2026-04 (Wayback), last contract call 2025-09-28. Its 501K MOVE (~$3.8K) back open MSD loans (538 positions, R4); the 26 debt-free positions hold 39 MOVE.' },

  { id: 'mole', name: 'Mole', chains: [...A], category: 'Yield', status: 'not_checked', defillama: 'mole',
    reason: 'Frontend down (app.mole.fi empty in Wayback\'s 2026-10-20 capture, no response 2026-10-21) and its GitHub repo deleted; no notice found, so closure dates from 2026-10-20. Lending vaults are nearly empty (~51 APT, ~400 USDC; interest last accrued 2024). DefiLlama\'s $203K counts worker LP counters above 100% of their pool\'s supply; the one plausible holding is ~3.7% of PancakeSwap APT/USDC (~$15K), before excluding positions with debt. Whether closing a position needs a stopped Pyth price is not checked.' },
  { id: 'aptoswap', name: 'Aptoswap', chains: [...A], category: 'Dexs', status: 'not_left_behind', checkedAt: '2026-10-21', defillama: 'aptoswap', dead: 'yes',
    reason: 'Live despite DefiLlama\'s dead flag: aptoswap.net is up and its APT pool last traded 2026-10-20.' },
  { id: 'mosaic-amm', name: 'Mosaic', chains: [...M], category: 'Dexs', status: 'not_left_behind', checkedAt: '2026-10-21', defillama: 'mosaic-amm',
    reason: 'Frontend up (app.mosaic.ag) and no closure evidence; DefiLlama TVL $3.5K.' },
  { id: 'interest-protocol', name: 'Interest Protocol (Curve, DEX)', chains: [...M], category: 'Dexs', status: 'too_small', checkedAt: '2026-10-21', defillama: 'interest-curve',
    reason: 'Frontend up, and its 11 pools hold ~1.5 MOVE plus dust (lens::getAllPools).' },
  { id: 'thetis-perps', name: 'Thetis Perps', chains: [...A], category: 'Derivatives', status: 'not_checked', defillama: 'thetis-perps', dead: 'yes',
    reason: 'Frontend gone (thetis.market parked for sale, 2026-10-21); holdings not sized (DefiLlama TVL $1.3K).' },

  { id: 'collex', name: 'Collex', chains: [...A], category: 'Physical TCG', status: 'too_small', checkedAt: '2026-10-21', defillama: 'collex', dead: 'yes',
    reason: 'collex.fun no longer resolves (served until at least 2026-02). Users can claim at most ~$2.3K: its USD token supply is 1,135 and cards are valued at $1,229 (15% cash-out fee); the rest of the treasury\'s 19.5K USDt is the protocol\'s.' },

  { id: 'baptswap', name: 'BaptSwap (V1, V2, V2.1)', chains: [...A], category: 'Dexs', status: 'too_small', checkedAt: '2026-10-21', defillama: 'baptswap-v2.1', dead: 'yes',
    reason: 'Closed (none of its domains resolve, 2026-10-21), but its 12 pools hold ~91 APT and ~$40 of stablecoins (~$190).' },
  { id: 'atodex', name: 'AtoDEX', chains: [...A], category: 'Dexs', status: 'too_small', checkedAt: '2026-10-21', defillama: 'atodex', dead: 'yes',
    reason: 'Its 8 pools hold ~15 APT on their APT sides.' },
  { id: 'aptoslaunch', name: 'AptosLaunch', chains: [...A], category: 'Launchpad', status: 'too_small', checkedAt: '2026-10-21', defillama: 'aptoslaunch', dead: 'yes',
    reason: 'Closed (aptoslaunch.io redirects to an unrelated site), but its lock-bond pools hold its own ALT token, which has no market price (not on CoinGecko), so nothing can be valued.' },
  { id: 'lotto-run', name: 'Lotto Run', chains: [...A], category: 'Yield Lottery', status: 'too_small', checkedAt: '2026-10-21', defillama: 'lotto-run', dead: 'yes',
    reason: 'Its 4 lottery pots hold 14 APT.' },
  { id: 'movepump', name: 'MovePump', chains: [...A], category: 'Launchpad', status: 'not_left_behind', checkedAt: '2026-10-21', defillama: 'movepump', dead: 'yes',
    reason: 'Bonding curves (175, 757.5 APT): holders keep the tokens in their wallets, and the curve is their market (R1).' },
  { id: 'movegpt', name: 'MoveGPT', chains: [...A], category: 'Launchpad', status: 'too_small', checkedAt: '2026-10-21', defillama: 'movegpt', dead: '2026-03-05',
    reason: 'Its two staking pools hold ~477K MGPT, ~$6 at CoinGecko\'s price.' },

  // Not checked yet, with DefiLlama's TVL (2026-10-21) as a hint for priority only: TVL is what the adapter counts,
  // not a ceiling on what a protocol owes (claim tables and ended rewards can sit outside it).
  ...([
    ['poly-network', 'Poly Network', A, 'Bridge', '2024-09-30', 0],
    ['agdex', 'AGDEX', A, 'Derivatives', undefined, 86],
    ['obric', 'Obric', A, 'Dexs', undefined, 1487],
    ['bridgers', 'Bridgers', A, 'Dexs', undefined, 688],
    ['jujube-finance', 'Jujube Finance', A, 'Dexs', 'yes', 29],
    ['bluemove-staking', 'BlueMove Staking', A, 'NFT Marketplace', 'yes', 0],
    ['streamflow', 'Streamflow', A, 'Payments', undefined, 4],
    ['moveflow', 'MoveFlow', A, 'Payments', undefined, 3],
    ['mosquitos-finance', 'Mosquitos Finance', A, 'Yield', '2023-03-09', 0],
  ] as [string, string, readonly ('aptos' | 'movement')[], string, string | undefined, number][]).map(([id, name, chains, category, dead, tvl]): ProtocolEntry => ({
    id, name, chains: [...chains], category, status: 'not_checked',
    reason: `Not checked yet (DefiLlama TVL $${tvl.toLocaleString('en-US')} on 2026-10-21).`,
    defillama: id, ...(dead ? { dead } : {}),
  })),

  // Not checked yet (DefiLlama, 2026-10-20)
  ...([
    ['yield-ai', 'Yield AI', A, 'AI Agents'],
    ['decibel', 'Decibel', A, 'Derivatives'],
    ['tsunamix', 'TsunamiX (Tsunami Finance)', A, 'Derivatives', 'yes'],
    ['liquidswap', 'LiquidSwap', A, 'Dexs'],
    ['cetus-clmm', 'Cetus CLMM', A, 'Dexs'],
    ['houstonswap', 'HoustonSwap', A, 'Dexs', 'yes'],
    ['sushi-aptos', 'Sushi (Aptos)', A, 'Dexs'],
    ['movefast', 'MoveFast', A, 'Launchpad'],
    ['goapt', 'GoAPT', A, 'Liquid Staking'],
    ['kaio', 'KAIO', A, 'RWA'],
    ['propbase', 'Propbase', A, 'RWA'],
    ['newrlrwa', 'NewrlRWA', A, 'RWA'],
    ['eternal-finance', 'Eternal Finance', A, 'Yield'],
    ['moneyfi-v1', 'MoneyFi', A, 'Yield Aggregator'],
  ] as [string, string, readonly ('aptos' | 'movement')[], string, string?][]).map(([id, name, chains, category, dead]): ProtocolEntry => ({
    id, name, chains: [...chains], category, status: 'not_checked', reason: 'Not checked yet.', defillama: id, ...(dead ? { dead } : {}),
  })),

  // Out of scope: custodial exchanges DefiLlama lists with Aptos reserves
  ...([['binance-cex', 'Binance'], ['bybit', 'Bybit'], ['okx', 'OKX'], ['gate', 'Gate'], ['mexc', 'MEXC'], ['kucoin', 'KuCoin'],
    ['hashkey-exchange', 'HashKey Exchange'], ['flipster', 'Flipster'], ['backpack', 'Backpack'], ['weex', 'WEEX'], ['bitfinex', 'Bitfinex'],
    ['blofin', 'BloFin'], ['bitkub', 'Bitkub'], ['gate-us', 'Gate US'], ['fastex', 'Fastex'], ['bitlo', 'Bitlo']] as const).map(([id, name]) => cex(id, name)),
];
