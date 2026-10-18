# Sources — evidence log

Every counted source passes the same gate before it is added:

1. Enumeration proven, with a named scope.
2. A sanity check against the contract's own total, where one exists.
3. A deterministic, stratified **sample simulation** of the recovery call, using `spikes/07-simulate-state.ts`, seed 20261018. Results are a sample rate, not a protocol-wide success rate.

Measurement runs use a fresh local state (`node src/node/snapshot.ts --source <id> --state <tmp>`). APT was $0.77 on 2026-10-18.

| Source | Shape | Status rule | Measured (2026-10-18) | Sample simulation |
|---|---|---|---|---|
| `native-delegation` | indexer staking table | ended position (unlock done) | headline $680K, 7,163 owners | 20/20 ok, payout = expected; 2 owners need gas |
| `thala-unstake` | entry-function senders | ended position (request matured) | headline $27.5K, 925 owners | 10/10 ok, payout = expected; 3 need gas |
| `kofi-withdrawals` | entry-function senders | ended position; protocol winding down | headline $12.8K, 287 owners | 10/10 ok, payout = expected; 1 needs gas |
| `amnis-withdrawals` | collection owners (`Amnis Withdrawal Tokens`) | ended position (lockup passed) | headline $938K, 397 owners; one wallet = 88% | 10/10 ok, payout = expected; 1 needs gas |
| `thala-vethl-expired` | entry-function senders (`vetoken scripts::lock`, `farming_vesting::convert_to_vethl`) | ended position (lock expired) | headline $13.7K, 4,852 owners (97 ≥ $10) | 10/10 ok, payout = expected |
| `thala-vesting-matured` | entry-function senders (`farming_vesting::start_vesting`) | ended position (vesting reached end_sec) | headline $6.2K, 2,642 owners (16 ≥ $10) | 10/10 ok, payout = expected; 1 needs gas |
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
