# Phase 0 report — enumeration proofs and sizing

Run 2026-10-18 on Aptos mainnet, using the Geomi key and spikes in `spikes/`.

- Every number comes from `data/<source>/summary.json`. Request logs are in `data/logs/*.jsonl`.
- APT price was **$0.77** (CoinGecko, 2026-10-18). USD totals scale linearly with it.
- Rules are from [left-behind.md](left-behind.md). Age buckets are cumulative.

## Results

| Source | Shape | Counted? | Recoverable now | Headline (≥ 90 d, eligible age) | Owners ≥ 90 d (≥ $10 / ≥ $100) | Run time |
|---|---|---|---|---|---|---|
| Native delegation, unstaked + cooled down, not withdrawn | indexer staking table | yes | 3.42M APT · $2.64M · 8,496 positions · 7,822 owners | **886k APT · $683k** | 7,163 (1,451 / 142) | 6.5 min |
| Thala matured unstake requests not completed | entry-function history | yes | 38.4k APT · $29.6k · 1,095 requests · 951 owners | **35.8k APT · $27.6k** | 925 (85 / 15) | 30 s |
| Auro (Aptos) CDP collateral, debt-free | collection / object | **no** — experiment; no closure evidence | ~10.8k APT-equivalent in LSTs across 229 positions | — | 209 owners | 10 s |
| Econia idle market accounts (no open orders) | per-user account resource | **no** — experiment; no closure evidence | 25,375 accounts. Market 7 (APT/lzUSDC) alone: 3,329 APT + 29,076 lzUSDC (~$31.6k, ~$1.25 per account) | — | 25,156 owners | 5.3 min |
| Aries (wound down; reserves removed) | per-user resource → profile accounts → linked-table walk | yes, as `blocked` | 200-user sample: contract quote **$9.27** vs pre-drain face **$591.55** (1.6%) | never in headline | sample: 43 owners with debt-free deposits | 29 min enumeration, ~3 s per 200 users |

**Concentration matters:**

- Delegation: the single largest position, 2.06M APT, is 60% of "recoverable now". It is only 15 days old, so it is excluded from the headline.
- Thala: the largest request is 52% of the total.
- Most owners hold dust: only 1,451 of the 7,163 aged delegation owners have ≥ $10.

**Delegation age basis:**

- 8,377 positions are `onchain_maturity`.
- 103 are `position_interaction`: pending_inactive stake in a pool whose validator left the set. These are estimated and kept out of the headline (196k APT, of which 172k is one 14-day-old position).
- 16 are `unknown` (1.7k APT).

**Owner check:** the 40 largest aged delegation owners are all ordinary user accounts (authentication key = own address, 2–485 transactions). None are protocol resource accounts.

## Enumeration proofs

### 1. Indexer staking table — native delegation

- **Query:** `current_delegator_balances(where:{pool_type:{_eq:"inactive_shares"}, shares:{_gt:"0"}, delegator_address:{_gte:lo,_lt:hi}, _or:[keyset]})`, ordered by (delegator, pool, table_handle).
- **Pagination:** keyset over (delegator, pool, table_handle), with 16 address-prefix ranges run in parallel. **The page size is silently capped at 100**: `limit:5000` returns 100 rows without an error. Offset paging would be unstable on a live table.
- **Processor:** `stake_processor`. Its watermark lagged the chain by seconds before and after the run. Delegation reads are not ledger-pinned; views are pinned at version 7667961756.
- **Retention:** current-state table, so retention does not apply.
- **Volume:** 11,465 rows → 9,459 (delegator, pool) pairs across 89 pools. 123 pages in 16 s.
- **Stale rows:** **738 pairs (7.8%)** show shares in the indexer but `get_stake = 0`. When shares are fully redeemed the on-chain entry is deleted, and the indexer keeps the old row. Every row must be confirmed with a view read.
- **Verification:** `delegation_pool::get_stake` on 9,459 pairs took 32 s with 0 errors. Per pool: `can_withdraw_pending_inactive`, `stake::get_lockup_secs`, `stake::get_stake`.
- **Aging:**
  1. Latest `UnlockStake`/`UnlockStakeEvent` from `delegated_staking_activities`. Both event formats exist.
  2. Unlock timestamps fetched in batches of 100 from `user_transactions`.
  3. `StakePool.locked_until_secs` at the unlock version, read from the **archive** (`archive.mainnet.aptoslabs.com`; it needs the key, anonymous calls get 429).
  4. Archive reads are reused within [read time, locked_until] per pool: 1,290 archive reads, 7,087 reused.
  5. `claimableSince = max(locked_until, unlock time)`. This is a conservative bound: a validator leaving earlier only makes the stake claimable sooner.
- **Sanity check:** per pool, the sum of delegators' inactive stake ≤ `stake::get_stake(pool).inactive`. **66 pools, 0 violations.**
- **Cost:** 19,598 requests, 4.3 MB, 0 retries. 6.5 min total, of which aging is 6 min.
- **Completeness scope:** all `inactive_shares` rows with shares > 0 served by `stake_processor`. A delegator whose row is missing from the indexer would be missed; that gap is not measured.

### 2. Entry-function history — Thala unstake requests

- **Query:** `user_transactions(where:{entry_function_contract_address:{_eq}, entry_function_module_name:{_eq:"scripts"}, entry_function_function_name:{_eq:"request_unstake_APT"}, version:{_gt:cursor}}, order_by:{version:asc}, limit:100)`.
- **Filters that work:** only the three-column filter is fast (~0.3 s per page). `entry_function_id_str` alone and contract address alone **time out (408)**. Filtering by timestamp also times out.
- **Pagination:** version cursor; stable because versions are unique and only increase.
- **Processor:** `user_transaction_processor`, current. Its history goes back to version 338,879,432, the first Thala request, so retention is complete back to the protocol's start.
- **Volume:** 6,834 transactions → 2,466 senders → 961 accounts with open requests, 1,107 requests (1,095 matured). 69 pages in 22 s.
- **Verification:** `staking::user_unstake(account)`, 2,466 views in 8 s.
- **Storage:** per-user `UserUnstake` SmartTable. The `events` root is **deprecated** (HTTP 400), so event-based enumeration is not available.
- **Sanity check / scope gap:** found open requests total 53,229 APT, against `TLSD.apt_pending_withdrawal` = 54,620 APT. **Coverage is 97.5%.** The missing ~1,390 APT is requests created by other contracts calling `staking::request_unstake_APT`, plus rounding.
- **Completeness scope:** senders of `scripts::request_unstake_APT` entry calls.

### 3. Collection / object — Auro CDPs (experiment)

- **Query:** `current_token_ownerships_v2(where:{current_token_data:{collection_id:{_eq}}, amount:{_gt:"0"}, token_data_id:{_gt:cursor}})`, keyset on token_data_id.
- **Processor:** `token_v2_processor`, current.
- **Volume:** 346 position objects in 4 pages, 8.6 s. Verified in 1.2 s.
- **Ownership:** ObjectCore owner equals the indexer owner for **346 of 346**.
- **Positions:** 112 have debt (excluded under R4); 229 are debt-free with deposits.
- **Liquidity:** pool reserves cover debt-free collateral in every pool.
- **Status:** not counted. Zero debt does not satisfy R2 without closure evidence.

### 4. Account resource at scale — Econia (experiment)

- **Enumeration:** senders of `user::register_market_account` and `user::register_market_account_generic_base`. **52,040 transactions → 48,776 senders, 522 pages in 158 s.**
- **Verification:** `user::get_market_accounts`, **48,776 views in 157 s (~310 per second at concurrency 8), 0 errors.** This is the throughput figure for planning.
- **Result:** 50,109 market accounts; 25,472 funded; 97 with open orders (excluded under R4); 21 custodian accounts.
- **Status:** not counted. Market 7's ~$1.25 per account across 25k accounts looks like campaign farming. If Econia closure is evidenced, the payout is mostly lzUSDC, a bridged token that needs its own stranded/market check.

### 5. Aries — per-user resource and nested table walk

- **Enumeration:** senders of `controller::register_user` and `register_user_with_referrer`. **477,957 transactions → 454,936 senders, 4,781 pages in 29 min**, with one 408 retried. This is the cost driver.
  - Later runs only page versions newer than the stored cursor, so the full history scan happens once.
- **Sample:** 200 senders, deterministic Fisher-Yates (mulberry32, **seed 20261018**).
- **Verification:**
  1. `profile::Profiles` resource.
  2. Each profile account's `Profile` resource.
  3. `deposited_reserves` linked-table walk (`table_item` per non-tail entry).
  4. `profile::profile_deposit<T>(user, name)` now (contract quote), and at **version 5,912,026,998 (2026-06-25 00:00 UTC, before the first admin withdrawal)** via the archive (face).
  - The pre-drain version was found by binary search over archive timestamps; the indexer times out on timestamp filters.
- **Results:**
  - 198 users OK. 64 deposits; 15 on profiles with borrows (excluded under R4); 49 debt-free deposits across 43 owners.
  - **2 users (1%) error.** `profile_deposit` aborts with "Subtraction overflow" for a reserve whose recorded reserve amount exceeds loans plus cash. The contract cannot quote these at all. Phase 1 must record such a reserve as `blocked` (`reserve_accounting_negative`, quote unknown) per reserve, instead of failing the user.
- **Face vs recoverable (sample):** contract quote now **$9.27** vs pre-drain face **$591.55**, so **1.6%**. 4 deposits are unpriced.

| Asset | Contract quote now ÷ face |
|---|---|
| APT reserve | ~93% (1.39 vs 1.49 APT) |
| lzUSDT | 4% |
| lzUSDC | 1.2% |
| stAPT | 1% |
| aBTC | 0 now, 0 face |

- **Rough extrapolation** (×2,275, linear): face ~$1.35M, quote ~$21k. **Not reliable**: 200 of 455k is too small for heavy-tailed balances. A full verification is about 2.8 reads per user, ~1.3M reads, **~70 min** at the measured 310 reads per second.
- **Status:** `blocked` (`reserves_removed`). Even the contract quote is not proven payable: withdrawals hit stale oracle prices except for a profile's last reserve. Face and quote are both shown, and neither enters the headline.

## Sample simulation rate

Unsigned simulation (no signature, `@aptos-labs/ts-sdk` 7.3.0) of each recovery entry function, using a deterministic stratified sample:

- Per source and variant: smallest, median and largest payout, plus 7 seeded picks.
- mulberry32 PRNG, **seed 20261018**. The position IDs are in `data/simulation/summary.json`.

| Source / variant | Population | Sampled | Simulated OK | Payout = expected | Owner can't pay gas |
|---|---|---|---|---|---|
| delegation / inactive (`0x1::delegation_pool::withdraw`) | 8,393 | 10 | 10 | 10 | 1 |
| delegation / pending_inactive in an inactive pool | 103 | 10 | 10 | 10 | 1 |
| Thala / matured request (`scripts::complete_unstake_APT`) | 1,095 | 10 | 10 | 10 | 3 |

- This is a sample simulation rate, not a protocol-wide success rate.
- **5 of 30 sampled owners hold too little APT to pay gas.** For them the simulation succeeds only with a zero-address fee payer. Recovering dust positions therefore needs a sponsored transaction or a top-up. This matters for any later claim feature.
- For Thala the payout field is `CompleteUnstakeAPTEvent.unstaked_amount`; it matches the FA `Deposit`. `withdrawn_amount` is APT pulled from pools during the call, usually 0.

## Gotchas found

- The indexer silently caps page size at 100.
- There are no `_aggregate` roots, no `table_metadata`, and the `events` root is deprecated.
- Timestamp and `entry_function_id_str` filters time out. Use the (contract, module, function) filter.
- Indexer delegation rows go stale: 7.8% in this run.
- The archive is rate-limited without the key.
- Fullnode retention is about 150M versions; the oldest was 7,518,148,208. Older reads go to the archive.
- Geomi returns no compute-unit headers. Cost is measured as request count and bytes.

## Inputs for the post-Phase-0 decisions

**Data volume:**

- Counted sources so far hold about 9.6k positions. The full candidate set for the planned sources is probably below 100k positions.
- `positions.json` is 4.3 MB for delegation and 0.5 MB for Thala.
- Every check design option is cheap on storage.

**Live check cost per address** (option a, no published index):

| Source | Reads per address |
|---|---|
| Delegation | 1 indexer query (by `delegator_address`) + 1 `get_stake` per pool |
| Thala | 1 view |
| Econia | 1 view |
| Aries | ~3 reads, more per extra profile or reserve |

So about 5–20 reads per address across these sources. That fits in a browser on the anonymous limits for a handful of addresses. The aging reads (archive) would come from the snapshot, not live.

**Run time:**

| Run | Delegation | Thala | Econia | Aries | Total |
|---|---|---|---|---|---|
| First full run | 6.5 min | 30 s | 5.3 min | 29 min enumeration + ~70 min verification | ~2 h |
| Daily run | 6.5 min | under 1 min | ~3 min | ~70 min | **~1.5 h** |

- Daily runs page history only from the stored version cursor, so enumeration takes seconds.
- Every non-zero position is still re-read daily.
- Aries dominates the daily run. It could be revalidated less often for zero-deposit profiles, as the §3 revalidation rules allow.
- This fits a GitHub Actions job (6 h limit) only if the state — version cursors and known positions — persists outside the runner.

**Source priority for Phase 1** (by evidence and value):

1. Native delegation.
2. Thala matured requests.
3. Kofi tickets. Closure is evidenced on chain:
   - `config::is_winddown` became true at **version 6,429,705,721 (2026-07-24 07:55:53 UTC)**, set by a multisig transaction from `0xc0de3445…8923`. The previous version reads false. Found by binary search over archive views, which assumes the flag flipped once.
   - Deposits and staking are paused.
   - Tickets are per user, so this source uses sender enumeration.
4. Tortuga tickets.
5. Amnis withdrawal NFTs.
6. Aries (`blocked`).
7. Econia and Auro only once closure is evidenced.

## Decisions taken after Phase 0

- **Check design: (a) live reads, no published address index** (decided 2026-10-18).
  - The dashboard publishes aggregates only.
  - The check page reads the chain from the browser for pasted addresses. The Aptos fullnode/indexer see those addresses; we don't.
- **Hosting** (decided 2026-10-18):
  - GitHub Actions in a public repo runs the pipeline; Cloudflare Pages serves the static site. Both are $0.
  - Pipeline state is SQLite in the Actions cache. It is rebuildable from chain data, so a lost cache costs one full run.
  - A Thursday job restores the cache so it is not evicted under the 7-day rule.
- **Cadence:** weekly snapshot.
  - Every known non-zero position is re-read each run. Zero owners are re-read weekly, which under a weekly cadence is also every run.
  - Superseded 2026-10-20: newer sources re-read non-zero owners when their record changes and at least monthly (docs/left-behind.md, Snapshots).
  - Delegation ages are memoized per (owner, pool, amount), so only new or changed positions cost aging reads.
- **Sources in Phase 1:** native delegation and Thala. Aries is left out until the real Geomi cost per request is known, since it would be ~95% of requests.
- **Check page:** calls Aptos anonymously from the visitor's browser. CORS is verified on the fullnode, archive and indexer. Our key never ships to the browser.
- **API cost guard:** a per-run cap on keyed (paid) Aptos requests (default 100,000; `REQUEST_CAP` env or `--cap`). Hitting it marks the remaining Aptos sources degraded instead of overspending. Movement's public endpoints are free and not counted, so Movement sources still run.
- **Deviations from the plan:**
  - The layer boundary is enforced by `tests/boundary.test.ts` (source imports plus the built `dist/`) instead of ESLint and TS project references. Same guarantee, no extra tooling.
  - `@aptos-labs/ts-sdk` is a dev dependency used only by the spikes. Shared and browser code use plain `fetch`.
