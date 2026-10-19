# What counts as "left behind"

This is the contract every source and every total follows. A source that cannot meet it is not counted.

## Inclusion rules

A position counts only if **all** hold:

- **R1 Action required.** Value reaches the owner as a spendable standard asset only through a transaction (owner or team). Liquid balances already in the wallet do not count.
- **R2 Not ordinary active.** Either:
  - the protocol is closed, wound down or deprecated, with written evidence and an effective date; or
  - the position has ended: stake cooled down, request matured, lock expired, vesting released, stream or rewards ended.
- **R3 Recoverable to the owner.** Payout goes to the owner, not to a strategy or third party.
- **R4 No debt, no live use.** No outstanding borrow, not posted as collateral, not deployed in a live strategy, no open orders.

Excluded: active stake, requests that have not matured, live LP/lending, wallet tokens that have a market.

### Stranded liquid receipt tokens

A wallet-held receipt token counts only if all of these hold:

- Its protocol is closed or deprecated.
- Redemption needs an owner action.
- It has no usable market.

It is valued at redemption payout.

The market test:

- Provider: Panora quote API.
- Input: the exact asset identity (FA metadata address or Coin type), never a ticker. Output: APT.
- Reference input = min($1k, the holder's redemption value). Holders fall into buckets with lower bounds $0.10 / $1 / $10 / $100 / $1k. Each bucket is quoted once per run at its lower bound: a smaller amount has less price impact, so a market that is usable for some holder in the bucket is never called unusable. Each quote stores its time.
- Usable market = a well-formed quote with output ≥ 80% of the input's redemption value.
- No usable market = a well-formed "no route" response, or output < 80%.
- An error, timeout or malformed response → `unknown`, never "no market".

## Aging

Each position has a `claimableSince` and an `ageBasis`, taken from the first one available:

| `ageBasis` | Meaning | Headline |
|---|---|---|
| `onchain_maturity` | On-chain unlock, maturity, lock expiry or vesting release time | yes |
| `protocol_closure` | Effective time of protocol closure or deprecation, with evidence | yes |
| `position_interaction` | Last protocol interaction **with this position** (its object, ticket or profile); never general wallet activity | no — estimated; shown separately unless the source documents it as a conservative bound |
| `unknown` | None of the above | no — excluded from all age buckets |

The age buckets are cumulative: **≥ 30, ≥ 90, ≥ 180 days**. The headline uses ≥ 90 days.

## Accounting

Per position:

| Field | Meaning |
|---|---|
| `id` | `source:owner:locator:positionKind[:asset]` |
| `parentId` | `source:owner:locator`, used for grouping |
| `owner` | 32-byte address that can sign recovery. Objects resolve through the ObjectCore owner chain (cycle detection, depth ≤ 8). An owner with no signer path → `unknown` with blocker `unsupported_owner`. |
| `positionKind` | `principal`, `fees`, `reward` or `request` |
| `grossClaim[]` | What the contract records as owed, raw units per asset |
| `expectedPayout[]` | What recovery pays now (reserve-limited, net of fees); `payoutBasis` is `view`, `derived` or `simulated` |
| `recoverableUsd` | expectedPayout × price. `priceSource` and `priceAt` are stored; quotes older than 7 days are unpriced; unpriced value is counted separately, never as 0. |
| `status` | Exactly one of `recoverable`, `team_gated` (needs an operator signature or packet), `blocked` (with `blockers[{code, detail}]`), `unknown` |
| `confidence` | `verified_view`, `derived_math` or `indexer_only`. `indexer_only` never enters totals. |

**Dedupe:**

- Asset rows use the key `canonicalAssetId + storageId`. A Coin row and its paired-FA row for the same store count once. Different stores of the same asset are summed.
- A receipt and its underlying are counted once, at the position.
- Owners are counted per source and globally.

**Headline** = `recoverableUsd` where all of these hold:

- `status = recoverable`.
- Age ≥ 90 days.
- `ageBasis` is headline-eligible.

Face value, `blocked`, `team_gated`, estimated-age and unpriced value are reported separately.

## Snapshots

Snapshots are not atomic. Each source records:

- The indexer processor and its watermark.
- Enumeration start and end.
- The fullnode ledger range used for verification.
- Verification start and end.
- Completeness.

"Complete" means complete within a **named enumeration scope**, never chain-wide.

Every known non-zero position is re-read on every run. Recent activity only sets the order of reads, never whether a position is correct.
