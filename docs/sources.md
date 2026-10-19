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
| `kofi-receipts` | primary stores holding kAPT / stkAPT | stranded receipt? market not checked → all `unknown` | 11,619 positions, 8,063 owners, ~$98K redemption value, none in headline | request step 38/38 ok; finalize = kofi-withdrawals sample |
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

## Sized and not added

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

- **Why it exists before the market test:** Kofi is winding down (evidenced). kAPT and stkAPT can still be redeemed for APT through a withdrawal ticket. They count as left behind only if stranded, and no quote provider is configured, so every position is `unknown` (`market_check_unavailable`) and never reaches the headline. Holders who check an address still see that they must redeem.
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

## Waiting on a decision

- **Kofi receipt market test:** with a Panora key, `kofi-receipts` positions with no usable market become `recoverable` and can reach the headline.
- **Aries** (blocked; pre-drain face ≈ 60× the current quote): 455K registered users. Per-user revalidation would cost ~285K reads a week, so it waits until the real Geomi cost per request is known.
