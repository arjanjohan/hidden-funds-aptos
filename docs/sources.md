# Sources — evidence log

Every counted source passes the same gate before it is added:

1. Enumeration proven, with a named scope.
2. A sanity check against the contract's own total, where one exists.
3. A deterministic, stratified **sample simulation** of the recovery call, using `spikes/07-simulate-state.ts`, seed 20261018. Results are a sample rate, not a protocol-wide success rate.

Measurement runs use a fresh local state (`node src/node/snapshot.ts --source <id> --state <tmp>`). APT was $0.77 on 2026-10-18.

| Source | Shape | Status rule | Measured (2026-10-18) | Sample simulation |
|---|---|---|---|---|
| `native-delegation` | indexer staking table | ended position (unlock done) | headline $680K, 7,163 owners | 20/20 ok, payout = expected; 2 owners need gas |
| `delegation-inactive-validator` | all pools → inactive validators → active-stake delegators | ended position (validator left the set); age = last reward epoch | headline $7.41M, 4,017 owners (1,451 ≥ $10); top wallet 12.6% | unlock 10/10 exact; 2 need gas (withdraw step: see native-delegation early-withdraw sample) |
| `thala-unstake` | entry-function senders | ended position (request matured) | headline $27.5K, 925 owners | 10/10 ok, payout = expected; 3 need gas |
| `kofi-withdrawals` | entry-function senders | ended position; protocol winding down | headline $12.8K, 287 owners | 10/10 ok, payout = expected; 1 needs gas |
| `amnis-withdrawals` | collection owners (`Amnis Withdrawal Tokens`) | ended position (lockup passed) | headline $938K, 397 owners; one wallet = 88% | 10/10 ok, payout = expected; 1 needs gas |
| `thala-vethl-expired` | entry-function senders (`vetoken scripts::lock`, `farming_vesting::convert_to_vethl`) | ended position (lock expired) | headline $13.7K, 4,852 owners (97 ≥ $10) | 10/10 ok, payout = expected |
| `thala-vesting-matured` | entry-function senders (`farming_vesting::start_vesting`) | ended position (vesting reached end_sec) | headline $6.2K, 2,642 owners (16 ≥ $10) | 10/10 ok, payout = expected; 1 needs gas |
| `trufin-unlocks` | one global table (`staker::Unlocks`) | ended position (request claimable); off-whitelist → team_gated | 1 request, $1.8K, 85 days old (not yet in headline) | 1/1 ok, payout = expected |
| `movement-native-delegation` | indexer staking table (Movement indexer) | ended position (unlock done) | headline $2.2K, 57 owners (MOVE $0.0073) | 10/10 ok, payout = expected |
| `movement-inactive-validator` | all pools → inactive validators (Movement) | ended position | none: no inactive Movement pool holds active stake | — |
| `kofi-receipts` | primary stores holding kAPT / stkAPT | stranded receipt only if no usable market (Panora) | 0 positions: both tokens have usable markets in every bucket (97–100% of redemption) | request step 38/38 ok; finalize = kofi-withdrawals sample |
| `merkle-mklp` | stores holding MKLP (Coin + paired FA) | wound down; exits deprecated → team_gated | 9,152 team_gated positions (9,088 owners), 4 recoverable; MKLP units, unpriced | whitelisted release 4/4 ok; every team_gated sample aborts as classified |
| `merkle-vemkl` | collection owners (veMKL) | wound down; unlock works any time → recoverable | 1,340 locks (unpriced: ~496K MKL, 74K PreMKL, 15K esMKL) | 10/10 ok, payout = expected (PreMKL paid as MKL) |
| `tortuga-tickets` | entry-function senders → per-user `TicketStore` | ended position (cooldown passed); reserve-queued tickets blocked | headline $12.2K, 818 owners; blocked $172 | recoverable 10/10 exact; blocked 4/4 abort `EFUND_NOT_AVAILABLE_YET` as predicted |

Native delegation and Thala are documented in [phase0-report.md](phase0-report.md).

**Owner rule (all sources):** after each read, the pipeline classifies the owner once and memoizes it.
- An account with a zero authentication key is a **resource account**, controlled by a program.
- An address with no account resource but with `ObjectCore` is an **object**.
- Positions held by either type stay listed but become `unknown`, with blocker `unsupported_owner`, so they never reach the headline.
- The cost is 1 request per ordinary owner, ever.

Each source page also states the largest single wallet's share of its 90+ day total. No address is published.

**Re-read schedule (all sources):**
- Owners holding something are re-read every run.
- Owners holding nothing are re-read monthly, or immediately when enumeration shows activity. Activity means a new entry-function call since the cursor, or a changed hint (delegation row version, token list).
- A position counts as "not re-read" only once it is older than its source's own refresh window.
- This keeps weekly cost proportional to non-zero positions.

## kofi-withdrawals

- **Status:** wound down.
  - `config::is_winddown` became true at version 6,429,705,721 (2026-07-24 07:55:53 UTC), set by a multisig transaction. Found by binary search over archive views.
  - Deposits and staking are paused. Withdrawals and unstaking still work.
- **Enumeration:** senders of `gateway::request_withdrawal_entry` and `gateway::unstake_and_request_withdrawal_entry`, using one version cursor per function.
  - 1,258 senders, 24 pages.
  - First full run: 24 s, 1,288 requests.
- **Read:** `withdrawal_manager::get_user_tickets(owner)`.
  - A ticket counts once `unlock_timestamp` (seconds) has passed.
  - Expected payout = `apt_amount − withdraw_fees`.
  - `GlobalConfig.gateway_config.withdrawals_paused` → `blocked` (`paused`).
- **Result:** 504 unlocked tickets never finalized. $12.9K recoverable now, $12.8K waiting ≥ 90 days. 287 headline owners, 23 of them with ≥ $10. 443 tickets are under $1.
- **Sanity:** the matured tickets found total 16.8K APT. `vault::get_unlocked_apt_balance` holds 289.5K APT (5.8% coverage), so payout is covered.
  - This is informational, not a hard ceiling: tickets can also be paid from APT still unlocking from validators.
- **Recovery:** `gateway::finalize_withdrawals_entry([ticket_id])`. 10 of 10 sampled simulations paid exactly the expected amount into the owner's APT primary store.
- **Gotcha:** event JSON prints addresses without leading zeros. Normalize addresses before comparing stores.

## tortuga-tickets

- **Status:** contracts respond; no closure notice verified.
  - The reserve (15,867.8 APT) is ~220 APT short of outstanding claims (16,087.8 APT).
  - `stake_router` has no view functions. Claimability is derived from `stake_router::claim`: the cooldown (3,600 s) has passed, the ticket's queue position is ≤ reserve + cleared claims, and its amount is ≤ the reserve.
- **Enumeration:** senders of `stake_router::unstake`. 4,460 senders, 112 pages.
  - First full run: 1 min 56 s, 4,579 requests.
- **Read:** the per-user `stake_router::TicketStore` resource.
  - Claimable since = ticket timestamp + cooldown.
  - Funded tickets → `recoverable`; unfunded → `blocked` (`reserve_short`).
  - Confidence is `derived_math`, because the result comes from the contract's arithmetic, not a view.
- **Result:** 835 recoverable tickets, $12.2K, all aged ≥ 90 days, 818 owners (79 with ≥ $10). 4 blocked tickets, $172.
- **Sanity:** the tickets found total 16,087.83 APT, against outstanding claims of 16,087.85 APT: **99.99%**. The enumeration scope captures essentially every ticket.
- **Recovery:** `stake_router::claim(index)`, where `index` is the ticket's position in the owner's list and shifts after each claim.
  - Sample simulation: recoverable 10/10, paying exactly the expected amount.
  - Blocked 4/4 abort with `EFUND_NOT_AVAILABLE_YET(0xd0005)`, exactly as classified.
- **Not counted:** wallet-held tAPT. It has a market (quoted ~11% below redemption), so it is not stranded under the rules.

## amnis-withdrawals

- **Status:** Amnis is live. Withdrawal tokens are NFTs in the collection "Amnis Withdrawal Tokens" (`0x40fb9ce6…6b8d`), created by the Amnis package.
- **Enumeration:** current owners of that collection, via `current_token_ownerships_v2` keyset-paged on `token_data_id` (5 pages, 455 owners). The token ids are passed as the read hint.
- **Read:** for each token:
  - `ObjectCore.owner` must equal the owner, otherwise the token moved and is skipped.
  - `withdrawal::WithdrawalToken` gives `amapt.value` and `locked_until_secs`.
  - Matured tokens count, payout amAPT 1:1 in APT (confirmed by simulation).
- **Result (with the owner rule):** $944K recoverable, of which **$938K is aged ≥ 90 days**, across 397 owners (267 with ≥ $10).
  - The largest wallet, an ordinary account with 415 transactions, holds 1.08M APT matured since 2025-11-26: **88% of the headline**.
  - 4 positions (~$304K, mostly one resource account at 388K APT) are `unknown` (`unsupported_owner`).
- **Sanity:** matured tokens found = 1,634,658 APT, which is **99.08%** of `withdrawal::total_pending_withdrawal` (all open tokens, matured or not).
- **Recovery:** `router::withdraw_entry(token)`. 10 of 10 sampled simulations, including the largest token, paid exactly the expected amount.
- **Backlog spotted:** the same wallets hold "Amnis Season 2 Airdrop" ($AMI Claim) and "Amnis Reward Voucher" NFTs. These are possible unclaimed-airdrop sources; their status needs research.

## thala-vethl-expired

- **Read:** one `vetoken::VeTokenStore<THL>` resource per owner (locked amount, `unlockable_epoch`). Two shared views per run: `now_epoch` and `seconds_in_epoch`.
  - A lock counts when `unlockable_epoch <= now_epoch`, as in `can_unlock<THL>`.
  - Claimable since = `unlockable_epoch × seconds_in_epoch`.
  - Only THL locks are counted. Locks of LP tokens need LP pricing and are not covered.
- **Equivalence:** the resource-based read was checked against the four-view read (`is_account_registered`, `locked_coin_amount`, `can_unlock`, `unlockable_epoch`). Both give the same 4,914 positions with identical amounts. Revalidation costs 4,922 requests instead of ~20k.
- **Enumeration:** senders of `vetoken scripts::lock<T>` and `farming_vesting::convert_to_vethl`. 10,745 senders, 139 pages. The first full run took 35,288 requests with the view-based read.
- **Result:** 4,914 expired locks: $16.3K now, **$13.7K aged ≥ 90 days**, 4,852 owners.
  - Value is mostly dust: 4,317 locks are under $1, and 97 owners have ≥ $10.
  - THL was $0.0099 on 2026-10-18.
- **Sanity:** no contract total exists, because locks are held per account.
- **Recovery:** `scripts::unlock<THL>()`, after claiming veTHL dividends. Sample simulation: 10/10 paid exactly the locked THL.

## thala-vesting-matured

- **Read:** the `farming_vesting::VestingBeneficiary` resource. With no claim ids, nothing more is read. Otherwise `farming_vesting::all_claims(owner)`.
  - A claim counts once `end_sec` has passed and `claimable_amount > 0`.
  - A claim still vesting is not counted, because claiming it early forfeits the rest.
  - Escrowed THL is not counted: it is not a claim until vesting starts.
- **Enumeration:** senders of `farming_vesting::start_vesting`. 4,960 senders, 261 pages; first full run 12,826 requests.
- **Result:** 3,676 matured claims: **$6.2K aged ≥ 90 days**, 2,642 owners (16 with ≥ $10). Nearly all are under $1.
- **Sanity:** no contract total exists, because claims are stored per id.
- **Recovery:** `farming_vesting_scripts::claim(claim_id)`. Sample simulation: 10/10 paid exactly the claimable THL.

## delegation-inactive-validator

- **What:** APT still staked (active) in a delegation pool whose validator has left the set (`stake::get_validator_state = 4`).
  - Inactive validators earn no rewards.
  - With the validator out of the set, `unlock` followed by `withdraw` returns the stake immediately. `can_withdraw_pending_inactive` is true.
- **Size of the problem (2026-10-18):** 124 of 174 delegation pools have an inactive validator.
  - 43 of them still hold active stake: 15.4M APT.
  - 30 of those pools show a last `DistributeRewards` event (2025-06 to 2026-10); 13 show none in the indexer.
- **Enumeration:**
  - Every pool (`current_delegated_staking_pool_balances`, 2 pages).
  - Validator state per pool (174 views).
  - For inactive pools, the `active_shares` delegators, keyset-paged.
  - Totals: 6,822 candidates, 187 pages.
- **Read:** `delegation_pool::get_stake(pool, owner)`, with the validator state re-read once per pool per run.
- **Age (`protocol_closure`):** the pool's last `0x1::stake::DistributeRewards` event (block time), or the owner's last `AddStake` in that pool if later, since stake added to an idle pool is idle only from then.
  - Memoized per (owner, pool, amount, stop time).
  - Pools with no reward event get `unknown` age and are not in the headline.
- **Blocked:** unlock aborts with `EDELEGATOR_PENDING_INACTIVE_BALANCE_TOO_LOW` when the delegator's resulting pending_inactive would be below 10 APT (`MIN_COINS_ON_SHARES_POOL`). Such positions are `blocked` (`below_unlock_minimum`): add stake to reach 10 APT, then unlock and withdraw everything. That is 12 positions, $2.
- **Result:** $11.0M claimable now. **$7.41M has been idle ≥ 90 days**, across 4,017 owners (1,451 with ≥ $10).
  - The largest wallet holds 12.6% of the headline.
  - ≥ 180 days is only $96K, because most of the value sits in pools that stopped in 2026.
  - 3 positions held by resource accounts ($359K) are `unknown`.
  - 2,123 positions ($313K) have unknown age.
- **Concentration:** the largest pool (`0x52561f4a…`, 9.76M APT, last reward 2026-06-12) has 66 delegators. 11 ordinary accounts with similar profiles (4–7 transactions each, 0.48–1.26M APT) hold 98% of it, which looks like one institution's wallets.
- **Sanity:** per pool, the delegators' active stake found does not exceed `stake::get_stake(pool).active`. 43 pools, 0 violations.
- **Recovery:** `delegation_pool::unlock(pool, amount)`, then `delegation_pool::withdraw(pool, amount)`.
  - Sample simulation of the unlock step (`spikes/08-simulate-unlock.ts`, seed 20261018): 10/10 unlocked exactly the active amount, including the largest position (2.03M APT). 2 owners need gas.
  - The withdraw step after an unlock in an inactive pool is the `pending_inactive_early` case of `native-delegation`, sampled 10/10.
- **Cost:** the first run takes 23,776 requests (ages and owner kinds). Re-reading costs 7,423.

## trufin-unlocks

- **Shape:** global table. Every TruFin unlock request sits in `staker::Unlocks`, one SmartTable read bucket by bucket at a pinned version. A read that does not reach `size` entries is an error, never "no request".
- **Read:** `staker::is_claimable(nonce)`.
  - Withdrawal requires TruFin's whitelist (`master_whitelist::is_whitelisted`). Owners off it are `team_gated` (`not_whitelisted`).
- **Age:** the moment the request's pool lockup cycle (`olc`) ended, i.e. the first version whose `DelegationPool.observed_lockup_cycle.index > olc`.
  - Found by binary search over archive reads; valid because that index only grows.
  - Memoized per (pool, olc).
- **Result (2026-10-18):** 1 pending request, 2,411.4 APT ($1.8K), claimable since 2026-07-25, whitelisted. It enters the 90-day headline after 2026-10-23.
- **Cost:** 49 requests on the first run, about 10 after that.
- **Recovery:** `staker::withdraw(nonce)`. Simulation 1/1, exact payout.

## Movement

- The native delegation and inactive-validator sources are the same code as on Aptos, with chain-specific endpoints and asset ids.
  - Movement reads use its public fullnode and indexer, with no credentials. The Geomi key goes to Aptos Labs hosts only.
  - Movement's fullnode keeps full history (oldest version 0), so it also serves the historical reads used for aging.
- **Asset identity:** native MOVE is FA `0xa` on Movement, the same address as APT on Aptos. It is stored as `movement:0x…0a` so prices and totals never mix. Priced via CoinGecko `movement`.
- **movement-native-delegation (2026-10-19):** 121 candidates, 112 withdrawable positions, $2.4K now, **$2.2K aged ≥ 90 days**, 57 owners.
  - 4 positions ($481) held by resource accounts are `unknown`.
  - Sanity: 4 pools, 0 violations. First run: 572 requests.
- **movement-inactive-validator:** no Movement pool with an inactive validator holds active stake. The source stays, so new cases are picked up.
- **Simulation:** Movement credits the native coin through legacy `0x1::coin::DepositEvent` handle events, identified only by the owner's event handle; the simulator accepts those for the native coin. Recoverable 10/10 exact, plus 4/4 resource-account positions (which simulate, but cannot be signed).

## canopy-ended-rewards (Movement)

- **What:** staking rewards on Canopy (`0x113a…::multi_rewards`) earned in a reward period that has ended and were never claimed. Each pool streams a reward token until its `period_finish`; what a staker earned stays in the pool until claimed. Rewards of pools still streaming are excluded.
- **Status:** live. Movement acquired Canopy in May 2026. On 2026-10-19, 22 of 56 registered pools are streaming and 34 have ended. All rewards are MOVE.
- **Enumeration:** every key of `MultiRewardsModule.user_staked_balances` (the staker's address; the indexer does not decode it), incremental by version. 7,497 stakers in 82 pages on Movement's public indexer.
- **Read:** one view per staker, `rewards_view::get_user_pool_positions`, with each pool's reward periods (`get_reward_token_details`, read once per run).
  - A staker who left a pool (`is_subscribed = false`) cannot claim its accrual through `claim_reward`: `blocked` (`unsubscribed`). None found.
- **Result (2026-10-19):** 5,620 `recoverable` positions, 4,925 stakers, **$4.8K** (MOVE at $0.0072), all aged ≥ 90 days; 15 stakers with ≥ $10. Sanity: the ended pools hold 669K MOVE; the earned amounts are part of that.
- **Recovery:** `multi_rewards::claim_reward(staking token)`. It claims every subscribed pool of that staking token, live ones included. Sample simulation: 12/12, paying exactly the expected MOVE; 1 needs gas.
- **Re-read schedule:** monthly, or when a stake changes. First run: 12.6K requests, all to Movement's public endpoints.

## Sized and not added

- **Echelon farming rewards (Aptos):** 5 of 7 reward programs have ended: USDC 2025-08-23, Amnis amAPT 2025-10-13, Kofi kAPT 2026-02-21, Goblin stAPT 2026-04-12, Thala sthAPT 2026-08-17. Unclaimed amounts are bounded by what the package holds to pay them: 3,540 USDC and 95 kAPT (~$3.6K). Reading every Echelon supplier for that is not worth it. Skipped.
- **Echelon farming rewards (Movement):** the only reward ("Move Coin") last ran 2026-05-18 → 06-02, so every unclaimed reward is from an ended period. But Echelon holds only 296K MOVE (~$2.1K) to pay them, which caps the total. Too small for a new enumerator (stakers are senders of Echelon's `scripts::supply*`).
- **Meridian farming (Movement):** staked LP is live principal; the extra rewards are MOVE. Not sized further.
- **PancakeSwap (Aptos) MasterChef farms:** CAKE emissions ended 2025-03-16 (`end_timestamp`; every pool's alloc point is 0). The CAKE single-stake pool is empty. The other 28 pools hold LP, which is live liquidity (R4). Only the unclaimed CAKE rewards and APT incentive count, and they are bounded by what MasterChef still holds: 5,771 CAKE (~$12.5K) and 12,988 APT (~$9.9K). 10 of 10 sampled farmers had already withdrawn. Finding the rest means reading ~30K depositors (60–100K requests) for at most ~$22K. Deferred.
- **AUX Exchange:** the team ceased development on 2023-03-17 (status update in its GitHub repo), but aux.exchange still loads. Its 69 AMM pools hold ~2,400 APT plus small stablecoin and meme-coin reserves (~$5K in total), and the CLOB vault took only 2,796 deposits ever. LP stays withdrawable and the site is up, so it is not stranded. Skipped.
- **Mirage Protocol (Aptos and Movement, mUSD vaults):** the team reportedly announced its closure (Cryptorank, pointing to mirage.money/vaults). DefiLlama shows ~$714 of TVL left. Skipped.
- **Yuzu (Movement):** the only whitelisted reward token is MOVE; incentives are worth too little to track.
- **Argo, Laminar Markets:** no closure notice found (Laminar was merged into Econia in 2023).
- **Hyperion fridge** (delayed LP withdrawals): `fridge::asset_unclaimed_all()` reports 4.70 APT in total across all users, about $3.50. Too small to maintain.
- **Superposition** (Aptos lending): not left behind. Its markets are unpaused and still used (last deposit 2026-10-14). Operator-signed packets are its normal app flow, not closure evidence.
- **Validator-owned stake pools** (not delegation pools): 43.6K APT of withdrawable inactive stake in 13 pools, plus 13.4K APT active in pools whose validator stopped. Owners are `staking_contract` or vesting resource accounts, which the owner rule makes `unknown`.
- **Moar farming rewards:** paid in Moar's own token, which has no CoinGecko price, so the value would be unpriced. Skipped.
- **Amnis "$AMI Claim" NFTs:** a marker with an `is_claimed` flag; the tokens were paid through an off-chain claim portal. No on-chain claim exists.
- **"Amnis Reward Voucher" NFTs:** phishing. They point to `pamnis.com`, and the creator account has no contract.

- **Tapp Exchange** (wound down; reported full operation until 2026-05-31): the router has every hook paused (`paused_hooks = 0x020304`), so liquidity removal is blocked.
  - Of 5,022 pools, most are meme-token launch pools.
  - The main stable and APT pools hold under $20 (USDt/USDC ~$4; APT/USDC ~10 APT + 8 USDC).
  - A full sizing needs ~5,000 single-pool reads, because the paginated view hits the read limit, and could only ever add to `blocked`. Skipped.
- **Econia:** no public closure notice found (2026-10-18). The idle market accounts (~$31K, mostly lzUSDC) stay excluded under R2.

- **Echo lending:** reports describe Echo moving BTC-bridge liquidity off Aptos, but no closure or withdrawal deadline was found. Not R2.
- **Kana perps** (`blocked`, payout $0): every market is deprecated and the collateral stores hold no USDt, so recorded balances are face value only. There are 13,408 depositors (senders of `perpetual_scripts::deposit*`), and sizing them needs ~3 reads each (~40K requests) for value that never reaches a total besides "may not work". Skipped; Aptin is treated the same way.

## kofi-receipts

- **Market test (2026-10-19, Panora public API key):** quotes into APT per value bucket (quoted at each bucket's lower bound; cached per run). Every bucket is usable for both tokens:
  - kAPT: 99.91–99.99% of redemption value.
  - stkAPT: 97.0–99.93%.
- Under the rules, a wallet token with a usable market is not left behind, so the source currently yields **0 positions**.
- When every bucket is usable, the run skips reading holders altogether: 124 requests instead of ~11.7K. If the markets dry up, holders are read again and those without a usable market become `recoverable` (stranded).
- The verdicts are published in `snapshot.markets`; the check page applies them without calling Panora.
- **History:** before the market test, every position was `unknown` (`market_check_unavailable`).
- **Why it was added before the test:** Kofi is winding down (evidenced). kAPT and stkAPT can still be redeemed for APT through a withdrawal ticket. They count as left behind only if stranded, and no quote provider is configured, so every position is `unknown` (`market_check_unavailable`) and never reaches the headline. Holders who check an address still see that they must redeem.
- **Enumeration:** primary stores (the only stores entry functions spend) holding kAPT or stkAPT, keyset-paged on `storage_id`. 117 pages, 8,063 owners. The hint carries each store's last change version.
- **Read:** `primary_fungible_store::balance`.
  - Redemption value: kAPT 1:1 in APT; stkAPT × `rewards_manager::get_exchange_rate` / 1e8 (1.0856 on 2026-10-19).
- **Age (`protocol_closure`):** the later of the wind-down (2026-07-24 07:55:53 UTC) and the holder's last balance change. A holder who bought after the wind-down is dated from the purchase.
- **Result (2026-10-19):** 11,619 positions, ~$98K redemption value. Sanity: user primary stores hold 89.11% of the kAPT supply and 99.77% of the stkAPT supply.
- **Re-read schedule:** monthly, plus immediately when a holder's store changes. Never in the headline, so a weekly re-read (11.6K requests) is not worth it.
- **Recovery:** `gateway::request_withdrawal_entry(amount)` for kAPT, or `gateway::unstake_and_request_withdrawal_entry(amount)` for stkAPT. Then `finalize_withdrawals_entry([ticket])` after 14 days.
  - Request step sample: 38/38 succeed across the four variants.
  - The finalize step is the `kofi-withdrawals` sample (10/10 exact).
- **To count it:** a market test, Panora per the rules, which needs the owner's decision on a key.

## merkle-mklp

- **Status:** Merkle Trade wound down.
  - Announced 2026-02-03: new positions disabled 02-06, force-closed 02-10, final distribution 02-12 (secondary reports: Whale Alert, The Defiant).
  - On chain (simulated 2026-10-19): `managed_house_lp::withdraw` and `redeem` abort `E_DEPRECATED`. The last user `withdraw` was on 2026-03-06.
- **Routes left:**
  - MKLP (USDC, `fa_box::W_USDC`): `release_mklp<W_USDC>` works only for wallets the team whitelisted (`house_lp::get_release_mklp_whitelist_amount > 0`). It succeeded in 4/4 whitelisted samples and aborted for every non-whitelisted one.
  - MKLP (lzUSDC): no user route. `release_mklp<lzUSDC>` aborts `E_DEPRECATED`, and both conversions to the USDC MKLP (`convert_mklp_type`, `migrate_all_zmklp_to_mklp`) are admin-only (`E_NOT_AUTHORIZED`). Always `team_gated` (`admin_migration_required`).
- **Value:** MKLP units only. The protocol's `highest_price` is a historical high-water mark, not current backing, and the vault's backing per MKLP is not read, so positions are unpriced rather than guessed.
- **Enumeration:** stores holding either MKLP type, in Coin or paired-FA form. 93 pages, 9,132 owners.
- **Result (2026-10-19):**
  - 9,152 `team_gated` positions (9,088 owners). 4 `recoverable` (whitelisted). 41 `unknown` (contract-held).
  - Sanity: holders hold 99.89% of the MKLP (lzUSDC) supply but only 10.47% of the MKLP (USDC) supply; the rest is held elsewhere.
- **Re-read schedule:** monthly, or when a holder's store changes. The first run took 45.8K requests; a re-read takes 10K.

## merkle-vemkl

- **Status:** Merkle Trade wound down (see merkle-mklp). The announcement says staked MKL can be redeemed after the final distribution (2026-02-12).
  - On chain, `managed_staking::unlock` succeeds even for a lock whose `unlock_time` is still in the future (one due 2026-12-03, simulated 2026-10-19). Every remaining lock is recoverable now.
- **Enumeration:** owners in the veMKL collection (`0xe101e80f…3216`), keyset-paged on token id. 14 pages, 1,366 locks, one per owner.
- **Read:** `staking::VoteEscrowedMKL` per token (owner checked through ObjectCore), and the lock's two fungible stores.
  - Locked PreMKL is paid out 1:1 as MKL from Merkle's community pool (`mkl_token::MklClaimEve`). The gross claim stays in PreMKL; the expected payout is in MKL.
- **Value:** unpriced. CoinGecko's MKL quote was last updated 2026-05-04, older than the 7-day rule.
- **Result (2026-10-19):** 1,340 `recoverable` locks. 26 contract-held locks are `unknown`. They hold about 496K MKL, 74K PreMKL and 15K esMKL.
- **Age:** from the wind-down (2026-02-12), or the lock time if later.
- **Recovery:** `managed_staking::unlock(token)`. Sample simulation: 10/10, paying exactly the expected MKL (and esMKL); 2 owners need gas.
- **Re-read schedule:** monthly, or when the collection's owner list changes. The first run took 6.8K requests.

- **Aave on Aptos:** an Aave governance proposal (ARFC, filed 2026-07-29) winds down the Aptos deployment by freezing every reserve. On 2026-10-19 (checked twice) all 4 Aptos reserves (USDt, APT, sUSDe, USDC) are still unfrozen and active with borrowing enabled, so it is not closed on chain yet. It becomes a source once the reserves freeze; the freeze is the effective date.
- **Ditto (stAPT):** no closure notice; last social activity in Dec 2023. stAPT is backed by 45.7K APT (`DittoPool.total_aptos`). The delayed-unstake queue is empty: 13 requests ever, `total_pending_claim` 0, 0.22 APT in `claim_pool`. Redemption still works through `delayed_unstake` plus permissionless `update_ditto_state`/`distribute_unstaked_coins`, so stAPT is not stranded under R2.
- **Cellana (veCELL):** CELL is quoted at $0.00006 (stale), so expired locks are worth nothing. Skipped.
- **Celer cBridge tokens:** no closure evidence found; the peg bridge still mints.

- **Merkle protocol rewards** (`protocol_reward::EpochReward<T>` tables, read through `current_table_items`): only 1,003 MKLP (USDC) units are unclaimed across 3 epochs (Jan–Feb 2026), paid in MKLP, which itself needs the team. Too small to add.
- **Thala MOD** (CDP vaults and stability pool): no deprecation notice found.

## layerzero-claimable

- **What:** LayerZero v1 transfers to Aptos that arrived while the receiver could not take the coin (no CoinStore registered). The app credits a claimable table instead; the receiver collects with a claim call.
  - LayerZero Aptos Bridge (`0xf22b…::coin_bridge`): lzUSDC, lzUSDT, lzWETH, lzWBTC, lzUSDD. Table `CoinStore<T>.claimable_amt_ld`; claim `coin_bridge::claim_coin<T>()`.
  - Shared OFT module (`0x43d8…::oft`): CAKE and BTC.b. Table `oft::CoinStore<T>.claimable_amount` at the coin's address; claim `oft::claim<T>()`.
- **Status:** live. Claims still work (see simulation).
- **Enumeration:** every entry of the 7 claimable tables (`current_table_items`), incremental per table by version. 254,920 receivers, 3,135 pages; the first full scan takes ~15 min (16 key ranges in parallel).
  - The indexer stores table handles zero-padded to 64 hex digits; the fullnode returns them without leading zeros. Unpadded, CAKE's table looked empty.
  - The indexer keeps some claimed entries as live (2 of the top 20 BTC.b entries were already claimed on chain), so every counted entry is re-read on chain.
- **Dust:** entries under ~$1 (`verifyMin` per coin) are not read on chain. They are listed as `indexer_only` and stay out of every total: $31.6K across ~213K entries.
- **Age:** the time the bridge wrote the entry (`onchain_maturity`). Write times are fetched 100 versions per query. All verified entries were written 2022–2025.
- **Result (2026-10-19; 252.7K of 254.9K receivers read before the Geomi credit ran out):**

  | Coin | Positions | Value |
  |---|---|---|
  | lzUSDC | 15,576 | $79.5K |
  | lzUSDT | 12,277 | $60.5K |
  | lzWETH | 9,202 | $92.3K (38.6 WETH) |
  | BTC.b | 5,043 | $24.4K (0.30 BTC.b) |
  | CAKE | 199 | $4.5K (2,092 CAKE) |
  | lzUSDD | 4 | unpriced (320 USDD) |

  - Total ~$261K recoverable, 41,019 receivers, 3,739 with ≥ $10. Top receiver: $2.2K (0.8%).
  - 1 position is held by a resource account (`unknown`).
- **Simulation (anonymous fullnode, seed 20261018):** 48/48 recoverable samples succeed and pay exactly the expected amount, across all 6 coins. 28 need gas. The resource-account position aborts (no signer), as expected.
- **Re-read schedule:** monthly, or when an entry changes (a claim always rewrites it).

## pancake-syrup-ended

- **What:** PancakeSwap (Aptos) syrup pools (`0xfd1d…::smart_chef`). All 10 pools the contract created ended between 2023-01-19 and 2024-04-16. Stakers who never withdrew still have their stake and the final reward in the pool.
- **Status:** PancakeSwap Aptos is live; the pools are not. Each pool's reward accumulator was last updated at or after its end, so the pending reward is final.
- **Size (pool totals, 2026-10-19):**
  - CAKE staked in the 6 CAKE pools: **60,052 CAKE (~$130K at $2.17)**, 49,547 of it in the MoveCoin-reward pool that ended 2024-02-09.
  - Gui Inu staked in the 4 GUI pools: 441.7M GUI (~$66; CoinGecko's quote is stale) with ~2.75 APT of rewards. Those pools are left out: not worth 4 reads per depositor.
  - Rewards left in the CAKE pools: unpriced Blt, ETERN, MoveCoin (BlueMove), Ditto stAPT and Celer USDC.
- **Enumeration:** senders of `smart_chef::deposit` (incremental by version).
- **Read:** the staker's `UserInfo<stake, reward, pool id>` for each CAKE pool (6 reads the first time, then only the pools the staker was found in, kept in memo), and `PoolInfo` once per run. Pending reward = `amount × acc_token_per_share / precision_factor − reward_debt` (`derived_math`; smart_chef has no views).
  - When a pool holds less reward than the staker is owed, `withdraw` would abort, so the step is `emergency_withdraw` (stake only) and the reward is `blocked` (`reward_unfunded`).
  - A staker who deposits into a pool not in their memo after the first read would be missed. The pools are over, so nobody has a reason to join one.
- **Sanity:** stake found per pool ≤ the pool's `total_staked_token`.
- **Spot check (anonymous public endpoint, 2026-10-19):** of 14 depositors sampled from older deposits, 11 still hold CAKE in pool U2 (0.02–8.2 CAKE each). Simulated `withdraw` for 3 of them: 3/3 succeed and pay exactly the derived stake and reward.
- **Enumeration size (anonymous indexer, 2026-10-19):** 32,900 deposits by 14,589 depositors up to version 444,552,000, when the last CAKE pool ended. Later deposits only went to the Gui Inu pools. The first run reads 6 `UserInfo` per depositor (~88K requests), so it needs its own run; later runs read only the pools each depositor was found in.
- **Sample (the earliest 400 depositors):** 40 still hold CAKE (10%), 1,720 CAKE in total, median 1.5 CAKE, 13 of 40 with ≥ $10. That suggests ~1,500 stakers across all depositors; the sample leans to the early pools.
- **Not measured per staker yet:** the full run needs the Geomi key (anonymously, ~200 depositors per 9 minutes).

## topaz-bids (built, not enabled)

- **What:** APT escrowed in Topaz NFT bids. Topaz ceased operations on 2024-08-21 (homepage notice; aptos.dev lists it as deprecated). The bid's APT stays in Topaz's tables until the bidder cancels.
  - Collection bids: `collection_marketplace::Bids<APT>` (bid → coins, deadline, bidder); `cancel<APT>(bid id)`.
  - Token bids: `bid_any::CoinEscrow<APT>` (bid → coins), bidder and deadline in `bid_any::Bids`; `cancel_bid<APT>(bid id)`.
- **Size (indexer, 2026-10-19):** 30,567 APT in 22,879 collection bids (17,880 bidders, 1,084 with ≥ 1 APT, top bidder 11,266 APT), plus 7,617 APT in 190,176 token-bid escrows (mostly dust). About $29K at $0.76/APT. 64/64 sampled bids match the chain.
- **Simulation:** a collection bid with a 2058 deadline cancels and returns exactly its 33.33 APT. Expired token bids not simulated yet.
- **Rule:** only expired bids count (R2: the order ended on its deadline). A bid whose deadline has not passed can still be filled by calling the contract directly, so it is an open order (R4) and is left out, even though Topaz is closed. Age: the deadline.
- **Not enabled yet:** the measurement run stopped when the Geomi credit ran out (the anonymous limit, 40,000 compute units per 5 minutes, is about 73 indexer pages). Indexer `key: {_in: …}` lookups on these tables take 6–46 s (no key index), so the enumerator pages the bid tables themselves (~850K rows).

## Other bridges and NFT marketplaces checked

- **TradePort** (left Aptos): every bid is gone. v1 has 1 collection bid left; v2 inserted 128,323 collection bids, and 92,113 were deleted plus 36,210 accepted, leaving 0. Token bids also net to 0.
- **Souffl3:** no closure evidence found.

## Bridges (Aptos and Movement)

Bridges listed for Aptos (official directory, 2026-10-19): Wormhole (Portal), NEAR Intents, Meson, CashmereLabs, Gas.zip, Panora, ChangeNOW, Swapspace. Also used: the LayerZero Aptos Bridge (zUSDC/zUSDT/zWETH), Celer cBridge, Circle CCTP (native USDC) and Stargate. Movement's canonical bridge is LayerZero-powered (MOVE, USDC, USDT, WETH, WBTC to and from Ethereum).

A bridge leaves funds behind when a transfer arrived but was never claimed or completed. Per bridge:

| Bridge | What can be left behind | Where it is recorded | Status |
|---|---|---|---|
| LayerZero Aptos Bridge (v1 `coin_bridge`: lzUSDC, lzUSDT, lzWETH, lzWBTC, lzUSDD) | coins credited to a receiver that could not take them, waiting for `claim_coin<T>` | on Aptos: `coin_bridge::CoinStore<T>.claimable_amt_ld` | **source `layerzero-claimable`** |
| LayerZero v1 OFTs on the shared `0x43d8…::oft` module (CAKE, BTC.b) | same, waiting for `oft::claim<T>` | on Aptos: `oft::CoinStore<T>.claimable_amount` at the coin's address | **source `layerzero-claimable`**. The other coins named `oft::…` are copies with under 3 tokens claimable; the older `0x54ad…::oft` module has one send ever |
| LayerZero v1 blocked messages (`lzapp::StoredPayload`) | a delivery that failed and waits for a retry | on Aptos | empty for the bridge, CAKE and BTC.b (2026-10-19) |
| Wormhole Portal → Aptos | transfers never redeemed on Aptos (VAA not submitted) | off-chain (Wormholescan); `state::vaa_is_consumed` is not a view function | Wormholescan's history listing for Aptos returns only recent operations, so no chain-wide total; possible as a per-address check |
| Celer cBridge (`0x8d87…::peg_bridge`, `vault`) | large transfers held 6 hours (`delayed_transfer` map), then executed by anyone | on Aptos | delay map has never held an entry; peg bridge live (last mint 2026-10-16), vault paused. Refunds of failed transfers go through cBridge's API: not built |
| Circle CCTP → Aptos | USDC burned on another chain, never minted on Aptos | source-chain burns + Circle attestation API | needs cross-chain indexing; not built |
| LayerZero v2 OFTs and Stargate (Aptos, Movement) | messages that failed delivery | LayerZero Scan | per-address check possible; not built. Successful deliveries go straight to the receiver's fungible store, so nothing waits on chain |
| Movement canonical bridge (LayerZero) | inbound credits arrive directly; outbound transfers wait out a security delay on Ethereum | Ethereum | needs EVM support; not built |
| Movement framework bridges (`atomic_bridge`, `native_bridge`) | — | on Movement | never used on mainnet: all event counters 0, transfer tables empty (2026-10-19) |
| NEAR Intents | balances held in NEAR's intents contract | NEAR | needs NEAR support; not built |
| Meson, Gas.zip, ChangeNOW, Swapspace, Panora, CashmereLabs | swaps settled by liquidity providers; nothing held for the user on Aptos | — | nothing to claim |

## Waiting on a decision
- **Aries** (blocked; pre-drain face ≈ 60× the current quote): 455K registered users. Per-user revalidation would cost ~285K reads a week, so it waits until the real Geomi cost per request is known.
