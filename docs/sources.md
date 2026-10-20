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
- Owners holding something are re-read every run (native staking, LST requests, Thala, Amnis, Tortuga, TruFin, Kofi withdrawals), or at least monthly in the newer sources, spread over four weekly runs.
- Any owner is re-read in the run after enumeration shows a change. A change is a new entry-function call since the cursor (deposits, and also withdrawals, claims and unsubscribes where a source tracks them), a changed table row or hint, or an owner with positions dropping out of a full scan.
- Owners holding nothing are re-read monthly, or never where nothing can accrue any more (PancakeSwap farms after emissions ended), unless enumeration reports them again.
- A position counts as "not re-read" only once it is older than its source's own refresh window.

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
- **Re-read schedule:** monthly, or when a stake changes or the staker claims or unsubscribes. First run: 12.6K requests, all to Movement's public endpoints.

## Sized and not added

- **Echelon farming rewards (Aptos):** 5 of 7 reward programs have ended: USDC 2025-08-23, Amnis amAPT 2025-10-13, Kofi kAPT 2026-02-21, Goblin stAPT 2026-04-12, Thala sthAPT 2026-08-17. Unclaimed amounts are bounded by what the package holds to pay them: 3,540 USDC and 95 kAPT (~$3.6K). Reading every Echelon supplier for that is not worth it. Skipped.
- **Echelon farming rewards (Movement):** the only reward ("Move Coin") last ran 2026-05-18 → 06-02, so every unclaimed reward is from an ended period. But Echelon holds only 296K MOVE (~$2.1K) to pay them, which caps the total. Too small for a new enumerator (stakers are senders of Echelon's `scripts::supply*`).
- **Meridian farming (Movement):** staked LP is live principal; the extra rewards are MOVE. Not sized further.
- **AUX Exchange:** the team ceased development on 2023-03-17 (status update in its GitHub repo), but aux.exchange still loads. Its 69 AMM pools hold ~2,400 APT plus small stablecoin and meme-coin reserves (~$5K in total), and the CLOB vault took only 2,796 deposits ever. LP stays withdrawable and the site is up, so it is not stranded. Skipped.
- **Mirage Protocol (Aptos and Movement, mUSD vaults):** the team reportedly announced its closure (Cryptorank, pointing to mirage.money/vaults). DefiLlama shows ~$714 of TVL left. Skipped.
- **Yuzu (Movement):** the only whitelisted reward token is MOVE; incentives are worth too little to track.
- **Echelon frozen markets (Movement, 2026-10-20):** 3 of 11 markets in the core package (`0x6a01…`) are frozen (collateral factor 0, borrow cap 0): Lombard LBTC, SolvBTC and KelpDao rsETH. Together they hold ~0.01 rsETH (~$40). Not worth a source. The isolated-pairs package (`0x452b…`) has no frozen-market concept.
- **MovePosition (Movement) and Superposition (Aptos):** withdrawals need a packet signed by the protocol's service, and both services still issue packets (aptos-script, 2026-10-08). Live protocols, not left behind.
- **Fliq (Aptos prediction markets):** winnings on a settled question that were never redeemed are an ended position (R2), and `connector::redeem` needs no operator. But the collateral wrapper's account holds 4,200 USDt in total (2026-10-20). That backs every open position, free collateral and unredeemed winning together, so unredeemed winnings are only a part of ~$4.2K. Skipped.
- **Joule:** live. Withdrawals need fresh Pyth price updates, which require a paid Pyth key; that is a cost of using it, not a closure.
- **No closure notice found (web search, 2026-10-20):** Auro Finance (Aptos CDP), AnimeSwap, Abel Finance, BlueMove (its Sei marketplace closed in 2023; Aptos was not affected).
- **Argo, Laminar Markets:** no closure notice found (Laminar was merged into Econia in 2023).
- **Amnis AMI vesting** (`0xbc99…::token_vesting`, buckets airdrop / KOL / seed / private / team / …): vested AMI that claimers never took (e.g. the KOL bucket, 156 claimers, fully vested 2025-12-23) would count. But AMI trades at $0.00084 (market cap ~$515K), so even millions of unclaimed AMI are worth a few thousand dollars. Skipped. The AMI lock pools from the June 2025 campaign were not found on chain.
- **ThalaSwap v1:** no deprecation notice and still trading, so v1 LP is live liquidity (R4).
- **Hyperion fridge** (delayed LP withdrawals): `fridge::asset_unclaimed_all()` reports 4.70 APT in total across all users, about $3.50. Too small to maintain.
- **Superposition** (Aptos lending): not left behind. Its markets are unpaused and still used (last deposit 2026-10-14). Operator-signed packets are its normal app flow, not closure evidence.
- **Validator-owned stake pools** (not delegation pools; re-sized 2026-10-20, 378 pools):
  - Two resource-account pools outside the validator set hold **14.4M and 4.1M APT** of active stake, with lockups ending 2026-10-31 and 10-22. They look like institutional `staking_contract`/vesting pools between validator setups, not abandoned funds, and would roughly double the headline. Not counted without evidence of abandonment.
  - Active validators hold small withdrawable inactive stakes (334–3,410 APT each): normal operator flow.
  - About 30 small pools outside the set hold 1.5–855 APT each, with lockups that ended in 2023–2026. Owners are `staking_contract` or vesting resource accounts (the owner rule makes them `unknown`); tracing each to its staker or shareholders is not worth it at this size.
- **Moar farming rewards:** paid in Moar's own token, which has no CoinGecko price, so the value would be unpriced. Skipped.
- **Amnis "$AMI Claim" NFTs:** a marker with an `is_claimed` flag; the tokens were paid through an off-chain claim portal. No on-chain claim exists.
- **"Amnis Reward Voucher" NFTs:** phishing. They point to `pamnis.com`, and the creator account has no contract.

- **Tapp Exchange** (wound down; reported full operation until 2026-05-31): the router has every hook paused (`paused_hooks = 0x020304`), so liquidity removal is blocked.
  - Of 5,022 pools, most are meme-token launch pools.
  - The main stable and APT pools hold under $20 (USDt/USDC ~$4; APT/USDC ~10 APT + 8 USDC).
  - A full sizing needs ~5,000 single-pool reads, because the paginated view hits the read limit, and could only ever add to `blocked`. Skipped.
- **Econia:** now a source (`econia-idle-accounts`), after new closure evidence on 2026-10-20.

- **Echo lending:** reports describe Echo moving BTC-bridge liquidity off Aptos, but no closure or withdrawal deadline was found. Not R2.
- **Kana perps** (`blocked`, payout $0): every market is deprecated and the collateral stores hold no USDt, so recorded balances are face value only. There are 13,408 depositors (senders of `perpetual_scripts::deposit*`), and sizing them needs ~3 reads each (~40K requests) for value that never reaches a total besides "may not work". Skipped; Aptin is treated the same way.

## kofi-receipts

- **Market test (2026-10-19, Panora public API key):** quotes into APT per value bucket (quoted at each bucket's lower bound; cached per run; valid 7 days; since 2026-10-20 in 3× steps from $0.10 to $1k). Every bucket was usable for both tokens:
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
- **Re-read schedule:** every run (owners with positions) and weekly (others), because positions rest on market quotes that are valid for 7 days. While every bucket has a usable market, holders are not read at all; once a market dries up, a run reads ~11.6K holders.
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

- **Aave on Aptos:** see `aave-frozen-reserves` (dormant until a reserve freezes).
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
- **Published (CI run, 2026-10-19):** complete. **$263.7K** recoverable and left behind 90+ days, 41,461 receivers, 3,772 with ≥ $10. Top receiver: 0.8%. Not verified (dust): 215,187 entries, $31.8K. First run: 89,849 requests.
- **Per coin (local run on the same day, 99% of receivers read):**

  | Coin | Positions | Value |
  |---|---|---|
  | lzUSDC | 15,576 | $79.5K |
  | lzUSDT | 12,277 | $60.5K |
  | lzWETH | 9,202 | $92.3K (38.6 WETH) |
  | BTC.b | 5,043 | $24.4K (0.30 BTC.b) |
  | CAKE | 199 | $4.5K (2,092 CAKE) |
  | lzUSDD | 4 | unpriced (320 USDD) |

  - 1 position is held by a resource account (`unknown`).
- **Simulation (anonymous fullnode, seed 20261018):** 48/48 recoverable samples succeed and pay exactly the expected amount, across all 6 coins. 28 need gas. The resource-account position aborts (no signer), as expected.
- **Re-read schedule:** monthly, or when an entry changes (a claim always rewrites it).

## pancake-syrup-ended

- **What:** PancakeSwap (Aptos) CAKE syrup pools (`0xfd1d…::smart_chef`). All 10 pools the contract created ended between 2023-01-19 and 2024-04-16; the 6 CAKE pools by 2024-02-09. Stakers who never withdrew still have their stake and the final reward in the pool.
- **Status:** PancakeSwap Aptos is live; the pools are not. Each pool's reward accumulator was last updated at or after its end, so the pending reward is final.
- **Size (pool totals, 2026-10-19):**
  - CAKE staked in the 6 CAKE pools: **60,052 CAKE (~$130K at $2.17)**, 49,547 of it in the MoveCoin-reward pool that ended 2024-02-09.
  - Gui Inu staked in the 4 GUI pools: 441.7M GUI (~$66; CoinGecko's quote is stale) with ~2.75 APT of rewards. Those pools are left out: not worth 4 reads per depositor.
  - Rewards left in the CAKE pools: unpriced Blt, ETERN, MoveCoin (BlueMove), Ditto stAPT and Celer USDC.
- **Enumeration:** senders of `smart_chef::deposit` (incremental by version), plus senders of `withdraw` and `emergency_withdraw` at any time, so a staker who exits drops out in the next run.
- **Read:** the staker's `UserInfo<stake, reward, pool id>` for each CAKE pool (6 reads the first time, then only the pools the staker was found in, kept in memo), and `PoolInfo` once per run. Pending reward = `amount × acc_token_per_share / precision_factor − reward_debt` (`derived_math`; smart_chef has no views).
  - When a pool holds less reward than the staker is owed, `withdraw` would abort, so the step is `emergency_withdraw` (stake only) and the reward is `blocked` (`reward_unfunded`).
  - A staker who deposits into a pool not in their memo after the first read would be missed. The pools are over, so nobody has a reason to join one.
- **Sanity:** stake found per pool ≤ the pool's `total_staked_token`.
- **Spot check (anonymous public endpoint, 2026-10-19):** of 14 depositors sampled from older deposits, 11 still hold CAKE in pool U2 (0.02–8.2 CAKE each). Simulated `withdraw` for 3 of them: 3/3 succeed and pay exactly the derived stake and reward.
- **Enumeration size (anonymous indexer, 2026-10-19):** 32,900 deposits by 14,589 depositors up to version 444,552,000, when the last CAKE pool ended. Later deposits only went to the Gui Inu pools. The first run reads 6 `UserInfo` per depositor (~88K requests), so it needs its own run; later runs read only the pools each depositor was found in.
- **Sample (the earliest 400 depositors):** 40 still hold CAKE (10%), 1,720 CAKE in total, median 1.5 CAKE, 13 of 40 with ≥ $10. That suggests ~1,500 stakers across all depositors; the sample leans to the early pools.
- **Published (CI run, 2026-10-19):** complete. **$130.3K** of CAKE, 3,781 stakers, 377 with ≥ $10; the largest holds 28%. 7,675 positions: 3,844 stakes plus 3,831 pending rewards in unpriced tokens. Sanity: stake found per pool = 99.98–100% of each pool's `total_staked_token`. First run: ~93.8K requests (330 indexer pages, 14,589 depositors).

## pancake-farm-ended-rewards

- **What:** PancakeSwap (Aptos) farm rewards never harvested. MasterChef (`0x7968…::masterchef`) stopped CAKE emissions on 2025-03-16 (`end_timestamp`; every pool's alloc point is 0). The CAKE a staked LP earned until then, and the APT incentive paid with it, wait in MasterChef until the farmer harvests.
  - Only the rewards count. The staked LP is live liquidity (R4).
- **Read:** the farmer's `PoolUserInfo` (pids and a `UserInfo` table), then per staked pool:
  - pending CAKE = `amount × acc_cake_per_share / 1e12 − reward_debt` (`derived_math`; `pending_cake` is public but not a view). The 1e12 precision checks out: farmers who harvested after the end come out at exactly 0.
  - the APT incentive from the `get_pending_apt<LP>` view.
  - A reward MasterChef cannot pay (more than its CAKE or APT balance) is `blocked` (`reward_unfunded`).
- **Recovery:** `masterchef::withdraw<LP>(0)` harvests and leaves the LP staked. Simulated: it paid exactly the computed 78,858 raw CAKE and the 33,565 raw APT from `get_pending_apt`.
- **Enumeration:** senders of `masterchef::deposit`, `withdraw` and `emergency_withdraw` at any time. A deposit or withdrawal after the end harvests (a harvest is `withdraw(0)`), so the farmer is re-read in the next run. A depositor with nothing pending is read once and never again.
- **Size:** bounded by what MasterChef holds: 5,771 CAKE (~$12.5K) and 12,988 APT (~$9.9K).
  - Sample (394 depositors across its history, 2026-10-19): 57 (14%) have rewards, 57.5 CAKE + 111.3 APT. Scaled to an estimated ~25K depositors, that's roughly 3,600 CAKE and 7,000 APT (~$13K).
- **Cost:** ~3.9 requests per depositor for those with LP staked (fewer for the rest), so the first run is ~100K+ requests and needs its own run. Nothing accrues after the end, so an owner with nothing pending is never re-read (`zero: 'never'`); owners with rewards are re-read monthly.
- **Published (CI run, 2026-10-20):** complete. **$16.1K** (CAKE plus the APT incentive) in 13,126 positions, 5,581 farmers, 165 with ≥ $10. Sanity: pending CAKE found = 5,526 of the 5,771 CAKE MasterChef holds (95.8%). First run: 45.8K requests (14,219 depositors, 1,090 indexer pages).

## echelon-frozen-markets

- **What:** supply left in Echelon's (Aptos) lending markets that Echelon froze. A frozen market has collateral factor 0 and borrow cap 0: no new borrowing, no use as normal collateral. Its supply earns little or nothing and waits on Echelon winding the market down.
- **Rules (decided 2026-10-20):**
  - Every frozen market counts (issue #10, option (b)), not only the bridged-asset ones with a public sunset notice (Aptos Foundation: Echelon "helped sunset bridge-wrapped assets"). The supply sits idle, and a frozen market is likelier to be shut down than a live one. The freeze is the effective date and the age (`protocol_closure`). A market Echelon reopens stops counting.
  - A supplier with any Echelon debt, even dust or interest only, is a live borrower: none of its supply counts (R4). Frozen markets can still be collateral in an efficiency mode: stAPT and sthAPT sit behind leveraged APT borrows (one sampled account: 49K stAPT and 7.9K sthAPT against 51.9K APT of debt).
- **Markets (21 of 30, 2026-10-20):** the freeze date is the first collateral-factor / borrow-cap admin transaction from which the market is frozen (archive node).
  - 2025-05: lzUSDC, lzUSDT, Wormhole USDC (05-03); Wormhole WETH, STONE (05-17).
  - 2025-07 to 2025-11: SBTC (07-26), MOD (09-03), Thala staked LPT 1 (09-03), THL and CAKE (09-26), aBTC (10-15), truAPT (11-10), stAPT, stkAPT and amAPT (11-21).
  - 2026: gstAPT (01-11), Thala staked LPT 2 and 3 (01-18), sthAPT (04-09), kAPT (04-24), sYUSD (10-04).
- **Read:** the supplier's `lending::Vault` (one resource: every market's shares, the debts and the efficiency mode). Without debt, `account_coins` per frozen market held.
  - Payout = min(coins, the lender's pro-rata share of the market's cash). The share is coins × cash / supply when the market is short, so all lenders' payouts together never exceed the cash. A share that rounds to nothing (a few raw units) is not a position. No cash at all means `blocked` (`insufficient_cash`).
  - **Prices:** a withdrawal prices every market the account still holds afterwards. Echelon has no valid price for THL, Wormhole WETH, STONE or SBTC (`lending::asset_price` aborts with `ERR_ORACLE_INVALID_PRICE`; the Thala LPT oracles are uninitialized), so holding any of them blocks withdrawals from every other market. The market itself can still be withdrawn: `withdraw_all` removes it from the vault (simulated).
    - One such market held: it is withdrawn directly, and every other position gets the prerequisite "withdraw your THL first". Both need its cash to cover the whole claim: a partial withdrawal leaves it in the vault, so otherwise the account is `blocked` (`stale_oracle`).
    - Two or more: no withdrawal order works, so all of the account's positions are `blocked` (`stale_oracle`).
- **Recovery:** `scripts::withdraw_all<coin type>(market)` for a Coin market, `scripts::withdraw_all_fa(market)` for a fungible-asset market (truAPT, the Thala LPTs, kAPT, stkAPT, amAPT, gstAPT, sYUSD). `withdraw_all` takes the whole claim and aborts when the market's cash is short of it (simulated: `ERR_LENDING_INSUFFICIENT_UNDERLYING_BALANCE`); then the step is `withdraw` / `withdraw_fa` with the share amount for the payout (the amount is in shares, simulated).
- **Enumeration:** senders of `scripts::supply` and `supply_fa` at any time (a frozen market still accepts supply), plus `withdraw*` senders as change events. `borrow*` and `repay*` senders are change events too (a supplier that borrows stops counting; one that repays starts), scanned from version 7,694,000,000 (2026-10-20): every supplier's first read comes after that, so earlier calls cannot matter. A supplier with nothing counted is read once and never again. Known gap: a borrower whose debt is cleared by a liquidation (the liquidator sends that transaction) is not re-read.
- **Sanity:** supply found per market ≤ the market's supply, with coverage shown. Coverage stays well below 100%: suppliers in debt are left out, and so is supply held by contracts that never call `scripts::supply*` themselves.
- **Prices:** CoinGecko ids checked against the exact asset: THL, CAKE, lzUSDC, lzUSDT, Wormhole USDC, MOD (`move-dollar`), kAPT (`kofi-aptos`), amAPT (`amnis-aptos`, listed for the amAPT coin; the market holds its paired fungible asset). stAPT has an id (`amnis-staked-aptos-coin`), but its last quote is from 2026-09-03, older than 7 days; stAPT and sthAPT are valued at redemption instead (on-chain rate × APT: 1 stAPT = 1.2171 amAPT, 1 sthAPT = 1.278 thAPT less Thala's 0.15% unstake fee, on 2026-10-20). The other tokens have no verified id and are unpriced.
- **Upper bound (on chain, 2026-10-20, debt included):** cash in the largest markets: 1.85M THL (~$18K), 662K stAPT, 69K sthAPT, 61.8K lzUSDC, 21.7K lzUSDT, 7.9K MOD, 5.9K stkAPT, 1.7K CAKE; sYUSD 998K, frozen only since 2026-10-04 (under 30 days).
- **Sample (2026-10-20, seeded):** 20 evenly spaced pages each of `supply` and `supply_fa` calls (by offset), 4,000 calls from 2,085 suppliers, every supplier read with this source.
  - 346 suppliers (17%) have counted positions: $195 priced (whUSDC $125, lzUSDC $63, THL $3, MOD $3), plus 3,205 stAPT (2,805 of it one holder), 280 sthAPT and 16 stkAPT unpriced. 41 positions need "withdraw THL first"; none is blocked by two unpriced markets.
  - Before the debt rule the same sample counted 8.9K stAPT, 10.8K sthAPT and 17.4K THL: most frozen-market supply sits in accounts that borrow.
- **Simulation (Geomi fullnode, unsigned, 2026-10-20):** per market the smallest, median and largest sampled position. All 26 direct withdrawals succeed and pay between the read payout and the claim (the claim when the cash covers it). All 6 positions that need THL out first abort with `ERR_ORACLE_INVALID_PRICE`, as expected; withdrawing the THL first succeeds and empties it from the vault.
- **Cost:** ~1M supply and withdraw calls (supply ~370K, withdraw ~270K, supply_fa ~150K, the rest smaller), so the first run is ~10K indexer pages (~2.2 h at 0.8 s/page). Scanning the ~520K borrow and repay calls from the start would add ~5K pages for nothing. `distinct_on: sender` puts `supply` alone at ~114K distinct senders (300 senders cover the first 0.26% of the address space). Reads take ~1.5 requests per supplier, so the first full pass is ~200K+ requests: two to three runs at the 100K cap. Later runs read only suppliers with new calls.

## aave-frozen-reserves (dormant)

- **What:** supply left in Aave v3's Aptos reserves once Aave freezes them. An Aave governance proposal (ARFC, filed 2026-07-29) winds down the Aptos deployment by freezing every reserve. A frozen reserve takes no new supply or borrows; lenders can still withdraw.
- **State (2026-10-20):** all 4 reserves (USDt, APT, sUSDe, USDC) are live, so the source counts nothing. Each run reads the reserve flags first (one view) and does nothing else while none is frozen. Supplied: ~456K APT (~6K borrowed), ~21K USDC, ~18.6K USDt, ~2K sUSDe.
- **Rules (decided 2026-10-20, option A):** same as `echelon-frozen-markets`. A frozen reserve counts, aged from its freeze. A supplier with any Aave debt (`user_logic::get_user_account_data` total debt > 0) counts for nothing (R4).
- **Freeze date:** the indexer's `events` table is deprecated, so the first version with the frozen bit (bit 57 of the reserve configuration) is found by binary search on the archive node, from version 7,694,000,000 (every reserve live), and dated by that transaction. ~30 archive reads once per reserve: the enumerator dates it, keeps the date in its cursor and passes it to each holder in the hint. If it cannot be dated, or the archive lookup fails, the amount still counts but the age is unknown, so the position stays out of the headline. The date is then null in the hint and retried each run; the run that dates it changes the hints, so its holders are re-read at once. Assumes a reserve stays frozen once frozen.
- **Read:** `a_token_factory::balance_of(owner, aToken)` per frozen reserve. Payout = min(balance, pro-rata share of the reserve's cash: balance × available liquidity / aToken total supply). Paused or inactive reserves are `blocked`. The APT reserve pays fungible APT (0xa), the paired asset of the APT coin, so it is valued as APT.
- **Recovery:** `supply_logic::withdraw(asset, 2^256 − 1, owner)` withdraws everything (simulated on a live reserve: paid exactly `balance_of`) while the reserve's cash covers the balance; the position still counts only the pro-rata share. When the cash is short of the balance, the step withdraws the pro-rata amount instead.
- **Enumeration:** holders of frozen reserves' aTokens, from each aToken's `token_base` user table (a SmartTable) read bucket by bucket from the fullnode. The indexer's copy misses buckets (sUSDe: 0 of 5). A run fails unless every holder is read. Each holder's hint is its scaled balances in the frozen aTokens and in every debt token, so supply, withdrawals, borrows and repayments trigger a re-read, and accruing interest does not.
- **Prices:** CoinGecko `tether`, `usd-coin`, `ethena-staked-usde`, each listed with this exact Aptos address; APT as APT.
- **Rehearsal (2026-10-20, all reserves treated as frozen):** 921 holders, 385 requests to enumerate (95 also owe). Every tenth holder read: 93/93 complete, 94 positions. The 4 largest simulated withdrawals succeed and pay the full balance.
- **Cost once frozen:** ~400 requests per run to enumerate, plus ~2 per changed holder.

## econia-idle-accounts

- **What:** coins left idle in Econia market accounts. Econia is an on-chain order book on Aptos.
- **Status (checked 2026-10-20):** deprecated, counted from the archive date (decided 2026-10-20). Until then the docs listed it as "no public closure notice". The new evidence:
  - Econia Labs archived the repository: "This repository was archived by the owner on Sep 8, 2025" (github.com/econia-labs/econia; emojicoin's repo is archived too). PitchBook lists the company as out of business.
  - On chain: last limit order 2025-07-25, last market order 2025-09-01, last deposit 2025-07-24. Since then the only activity is users withdrawing (latest 2026-09-24) and one swap.
- **Age:** from 2025-09-08 23:59:59 UTC. The banner gives only the date, so the end of that day is used and the age is never overstated. A balance that changed later is aged from the run that saw the change, which is later than the change itself: the owner's own deposit, withdrawal or order dates all of its balances (the indexer does not say which market a call touched); a resting order dates only the market it rests in, so its fill frees a balance aged from the run after.
- **Rules:** only accounts the owner controls (custodian 0) and without open orders count. Custodian accounts (Fliq, Kana) need their custodian to withdraw; open orders are live use (R4). A market with a generic (non-coin) base counts only its quote.
- **Read:** `user::get_market_accounts(owner)` (one view per owner), plus `registry::get_market_info` once per market for the coin types. Payout = each side's available amount. The APT coin is recorded as APT (0xa). Every coin of the coin markets has display metadata (EchoCoin002 is Gui Inu, GUI).
- **Recovery:** `user::withdraw_to_coinstore<coin type>(market id, amount)`, per coin and market. The order is (market id, amount): simulated, and the reverse aborts (Kana's integration README lists it the other way round).
- **Enumeration:** senders of `user::register_market_account` and `register_market_account_generic_base` (Phase 0: 52,040 calls, 48,776 senders, 522 pages), plus senders of Kana Labs' Econia wrapper (`0x9538…::wrapper`), whose `deposit_and_register_*` and deposit-and-order entries register the caller's own accounts (used until mid-2025). Known gap: an integration that registers accounts through other entry functions is missed until it is listed.
  - **Makers:** a fill of a resting order is sent by the taker, so the maker would never be re-read. Each run reads the open orders of the 13 coin markets (from market 14 on every base is generic: Kana perps, then Fliq's 130K question markets) and re-reads current makers and last run's makers. An account with open orders does not count; the run after its order fills, it is read again. On 2026-10-20: 185 owner-controlled orders from 142 makers. Deposits, withdrawals and order calls are change events, directly and through Kana's wrapper (its no-deposit order entries and `cancel_all_orders`), scanned from version 7,696,900,000 (2026-10-20): every owner's first read comes after that.
- **Size (Phase 0, 2026-10-18):** 25,354 idle owner-controlled accounts. Market 7 (APT/lzUSDC) holds nearly all of it: 25,012 accounts, 3,329 APT and 29,076 lzUSDC (~$31.6K, ~$1.25 per account; it looks like campaign farming). The other 9 markets hold a few dollars each, plus Echo's unpriced EchoCoin002.
- **Rehearsal (2026-10-20):** 104 owners (the 3 largest plus every 250th): 104/104 reads complete, 128 positions. 12 of 12 withdrawals simulated with the generated steps succeed and pay exactly the counted amount. Before building, 19 of 19 direct simulations across 10 markets also succeeded.
- **Cost:** first run ~522 indexer pages + ~48.8K views + an owner-kind lookup per owner with value (~25K): ~75K requests. Later runs read only owners with new calls.

## topaz-bids

- **What:** APT escrowed in expired Topaz NFT bids. Topaz ceased operations on 2024-08-21 (homepage notice; aptos.dev lists it as deprecated). A bid's APT stays in Topaz's tables, also after its deadline, until the bidder cancels.
  - Collection bids: `collection_marketplace::Bids<APT>` (bid → coins, deadline, buyer); `cancel<APT>(bid id)`.
  - Token bids: `bid_any::CoinEscrow<APT>` (bid → coins), with buyer and deadline in `bid_any::Bids`; `cancel_bid<APT>(bid id)`.
- **Rule:** only expired bids count (R2: the order ended on its deadline; age = the deadline). A bid whose deadline has not passed can still be filled by calling the contract directly, so it is an open order (R4) and is left out, even though Topaz is closed. A deadline of 0 means none was set: also an open order.
- **Enumeration:** the three bid tables themselves (~850K rows, 16 key ranges in parallel; 8,576 indexer pages). Rows are never deleted (a cancel or fill empties the coins), so later runs only fetch changed rows.
  - Indexer `key: {_in: …}` lookups on these tables take 6–46 s (no key index), so they are used only for the few token bids an incremental run cannot join.
- **Read:** with the enumeration hint, only the bids it lists as funded and expired are read on chain (one table read each).
  - Without a hint (the check page), the bidder's ids come from Topaz's per-bidder `Index`. That index lists some ids under the wrong bidder (ids 1, 4 and 9 appear under several), so a bid counts only when its own record names the owner as buyer. Walking the index without that check counted 32 bids twice.
- **Dust:** a bidder whose expired bids total under 0.25 APT (~$0.20) is not read on chain: `indexer_only`, out of totals.
- **Published (CI run, 2026-10-20):** complete. $3.9K left behind 90+ days, 1,736 bidders; 203,617 dust bids not counted. First run: 16.8K requests (8,576 indexer pages, 67,290 bidders).
- **Result (2026-10-19, local run with the pipeline code):** complete. **5,120 APT (~$3.9K) in 4,155 expired bids, 1,736 bidders**, 71 with ≥ $10; the largest holds 138 APT. Dust: 203,617 bids, 1,002 APT. Most of the 30.5K APT in collection bids sits in bids whose deadlines are years away (R4).
- **Cost:** first run 8.6K indexer pages + ~6.6K table reads. The first version walked every bidder's index and used 176K requests; reading only hinted expired bids gives the same result (minus the 32 double counts) for 6.7K.
- **Simulation (anonymous fullnode, seed 20261018):** 18/18 sampled cancels succeed and return exactly the escrowed APT, across both bid kinds; 9 need gas.
- **Re-read schedule:** monthly (spread over four weekly runs), or when a bid row changes.

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
