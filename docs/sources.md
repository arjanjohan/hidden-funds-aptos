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

Native delegation and Thala are documented in [phase0-report.md](phase0-report.md).

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
