# Plan: hiddenfunds for Aptos (Movement later)

## Context

hiddenfunds.xyz shows funds people left behind: a daily per-source dashboard ("Lido withdrawal not claimed: $69.9M, 7,980 wallets") plus an address check. It accepts Aptos addresses but has **zero Aptos sources**.

`aptos-script` (a separate private multi-chain portfolio scanner, Python + React) has an ABI-verified Aptos catalog, ~6k lines of Aptos/Movement readers and dated evidence on dead/drained/blocked apps (Aries, Aptin, Moar, Kana, Tortuga, Superposition, GUI lottery...). Here it is used as a **spec**, not as code we copy.

Decisions:
- We build it regardless of market size; there is no go/no-go gate.
- Snapshot dashboard + check. **Read-only.** Claims are out of the initial architecture.
- TypeScript. Geomi API key for the indexer and fullnode, used by the pipeline only.
- Headline age cutoff: **90 days**. 30, 90 and 180 are all reported.
- Liquid receipt tokens count **only if stranded**.

## 1. Definition of "left behind" (written first: `docs/left-behind.md`)

A position counts only if **all** of these hold:
- **R1 Action required.** Value reaches the owner as a spendable standard asset only through a transaction (owner or team). It is not already a liquid balance.
- **R2 Not ordinary active.** Either the protocol is closed, wound down or deprecated (with written evidence), or the position has ended: stake cooled down, request matured, lock expired, vesting released, stream or rewards ended.
- **R3 Recoverable to the owner.** The payout goes to the owner, not to a strategy or third party.
- **R4 No debt and no live use.** No outstanding borrow, not posted as collateral, not deployed in a live strategy, no open orders.
- **Stranded liquid receipt.** Counts only if the protocol is closed or deprecated, redemption needs an owner action, and there is no usable market. It is valued at redemption payout. The market test:
  - Provider: Panora quote API (as in aptos-script `app/swaps.py`). Input is the exact catalog asset identity (FA metadata address or Coin type), never a ticker. Output is APT.
  - Reference input = min($1k, the holder's redemption value). Quotes are cached per (asset, amount bucket), and each stores its quote timestamp.
  - Usable market = a well-formed quote whose output is ≥ 80% of the redemption value of the input.
  - A well-formed "no route" response, or output < 80%, counts as no usable market.
  - Errors, timeouts or malformed responses → `unknown`, never "no market".
- **Aging.** `claimableSince` plus `ageBasis`, taken from the first one available:
  1. The on-chain maturity or unlock time (lockup-cycle end, request maturity, lock expiry, vesting release).
  2. The effective time of protocol closure or deprecation, with evidence.
  3. The last protocol interaction *for this specific position* (its object, ticket or profile). Never the wallet's general activity. This is an **estimated** age: the last interaction does not prove the position was claimable then. It is displayed separately and excluded from the main headline, unless the source documents why it is a valid conservative bound.
  4. Otherwise the age is `unknown`, and the position is excluded from all age-bucketed headlines.
- The buckets are **cumulative**: ≥ 30, ≥ 90 and ≥ 180 days. The headline uses ≥ 90 days, counting only `onchain_maturity` and `protocol_closure` ages (plus `position_interaction` where the source documents it as a conservative bound). Each bucket is reported per `ageBasis`.
- Everything else is excluded: active stake, pending-but-not-matured requests, live LP/lending, wallet tokens with a market.

## 2. Accounting model

Per position:
- `id = source:owner:locator:positionKind[:asset]`. The locator is the pool, object, ticket id or market id. `positionKind` is principal, fees, reward or request. This keeps principal, fees and several rewards on one locator distinct.
- `parentId = source:owner:locator`: the stable ID for grouping.
- `owner`: the 32-byte address that can sign recovery. Profiles and subaccounts map to their owner. Object-held positions resolve through the ObjectCore owner chain:
  - Cycle detection.
  - Depth limit of 8.
  - An owner without a signer path (resource account, deleted object, unknown type) → `unknown` with blocker `unsupported_owner`.
- `grossClaim[]`: what the contract records as owed (raw units per asset).
- `expectedPayout[]`: what recovery pays now (reserve-limited, net of fees). `payoutBasis` is view, derived or simulated.
- `recoverableUsd` = expectedPayout × price. Store `priceSource` and `priceAt`. The 7-day stale-quote rule applies. Unpriced value is counted separately, never as 0.
- `status`, exactly one per position:
  - `recoverable`
  - `team_gated`: needs an operator signature or packet.
  - `blocked`: carries `blockers[{code, detail}]`, e.g. `reserves_removed`, `stale_oracle`, `paused`.
  - `unknown`
- The display groups follow from `status`, so no position appears in two groups.
- `confidence`: `verified_view`, `derived_math` or `indexer_only`. `indexer_only` never enters totals.
- Dedupe rules:
  - Asset rows use the key `canonicalAssetId + storageId`. A Coin row and its paired-FA row for the same physical store count once. Different stores of the same asset are summed. This matches aptos-script `merge_balances`.
  - A receipt and its underlying are counted once, at the position.
  - Wallet counts are unique owners, reported per source **and** globally across sources.
- Headline = `recoverableUsd` where `status=recoverable`, age ≥ 90 days, and `ageBasis` is headline-eligible per §1. Face value, `blocked`, `team_gated` and estimated-age value are shown separately, never in the headline.
- Sanity checks only where meaningful, each stated per source:
  - Delegation: the per-pool sum of inactive stake must not exceed the pool's inactive coins.
  - Tortuga: tickets compared with the reserve.
  - Otherwise the source says "no contract total available".

## 3. Snapshot model (not atomic)

Per source, record:
- Indexer processor and its `last_success_version`.
- Enumeration start and end.
- The fullnode ledger range used for verification.
- Verification start and end.
- Completeness: `complete`, or `degraded` with reasons. "Complete" always means complete **within a named enumeration scope**, never chain-wide. Example: "all senders to packages X and Y, versions A..B, served by processor P".

The output is presented as per-source "as of" times, never as one snapshot moment.

Revalidation rules:
- Every known non-zero position is re-read on **every run**. (Changed 2026-10-20: re-read when the record changes and at least monthly; see docs/left-behind.md.)
- New candidates are read immediately.
- Zero and unknown candidates are re-read on a slower cadence (weekly).
- Recent activity only sets the read order. It never decides correctness, because time unlocks, admin and reserve changes, oracle expiry and object-level activity all change positions without owner activity.

## 4. Phase 0 — discovery only (no product scaffold)

Throwaway TS spike scripts in `spikes/`. Code that works later moves into `src/node`.

**Prove enumeration on 5 storage shapes:**

| Shape | Source | Enumeration |
|---|---|---|
| Indexer staking table | Native delegation, cooled-down stake not withdrawn | `current_delegator_balances` → `delegation_pool::get_stake` and the pool's inactive lockup-cycle state |
| History by entry function | Thala matured unstake requests | `user_transactions` by `entry_function_contract_address`, version cursor → `staking::user_unstake` |
| Collection/object | Auro (Aptos) CDPs — **enumeration experiment only, not counted** | `current_token_ownerships_v2` by `collection_id` → `auro_view::position_info` |
| Account resource | Econia market accounts — **enumeration experiment only, not counted** | sender history on the Econia package → `user::MarketAccounts` |
| Global registry walk | Aries profiles: counted as `blocked`. Wind-down is evidenced: the admin multisig moved the reserves out, 2026-06-26..08-17 (`docs/ARIES_DECIBEL_VIEWS.md` §3.5.1) | `profile::Profiles` table walk → `profile_deposit` and reserve state |

Auro and Econia only test the shape: zero debt or zero open orders does not satisfy R2. They become counted sources only if Phase 0 finds closure or deprecation evidence with an effective date.

**For each shape, record:**
- The exact GraphQL query.
- Pagination semantics: cursor vs offset, ordering stability, max limit.
- Which processor serves it, and how its watermark behaves.
- Oldest version retained.
- Candidate → unique-owner dedupe ratio.
- Full-run and revalidation runtime.
- Geomi compute units used.
- Output size.
- Completeness.

**For each source, measure:**
- Face value.
- Recoverable now.
- Unique wallets with ≥ $10 recoverable.
- Recoverable value aged 30, 90 and 180 days.
- Unpriced share.
- Breakdown by `ageBasis`, including the share with unknown age.
- **Sample simulation rate.** Unsigned simulation (no signature, as in aptos-script `scripts/simulate.mjs`) of the recovery entry function. The sample is deterministic and stratified:
  - Small, median and large payouts.
  - Every status and blocker variant.
  - Every payload variant.
  - The fixed seed and the selected position IDs are recorded in the report.
  - Never call it a protocol-wide success rate unless the sample is statistically meaningful.

**Deliverable:** `docs/phase0-report.md`. It drives these decisions, each made after Phase 0:
- **Check and dataset design.** Never call any of these options "private"; each states exactly what it exposes.
  - (a) No published address index: the check does live reads from pasted addresses, and the dashboard publishes aggregates only.
  - (b) Hashed-address shards. Offline enumeration is still possible.
  - (c) A compressed local index.
  - (d) An API with explicit privacy terms.
- Hosting and pipeline runner, **including state persistence**. SQLite must not live on an ephemeral CI runner. Choose one: a committed state artifact, object storage, a CI cache with backup, or a persistent runner.
- Source priority for Phase 1.

## 5. Phase 1 — read-only product

**Hard layer boundary:**
- `src/shared/`: domain types, catalog, `read()` logic (ts-sdk views) and accounting. Browser-safe: no `process.env`, no node imports, no indexer key.
- `src/node/`: enumerators, the indexer client holding the Geomi key, the pipeline, and state in SQLite via built-in `node:sqlite` (durable, no extra dependency).
- `src/web/`: Astro static pages plus a React island for the check.
- Enforcement:
  - TS project references: `web` may import `shared`, never `node`.
  - ESLint `no-restricted-imports`.
  - A build test that fails if `dist/` contains node-only modules or the key's environment variable name.

**Source contract:**

```ts
// shared
interface SourceDef {
  id; chain; category; inclusionRule;                 // which R-rule makes it left behind
  protocolStatus: { state; evidence; checkedAt };     // + cheap liveness probe in pipeline
  refresh: { nonZero: 'every_run'; zero: 'weekly' };
  read(ctx, owner, hint?): Promise<{ positions: Position[]; complete: boolean; errors; ledgerVersion }>;
}
interface Position {
  id: string;                    // source:owner:locator:positionKind[:asset]
  parentId: string;              // source:owner:locator
  source: string;
  owner: string;
  locator: string;
  positionKind: 'principal' | 'fees' | 'reward' | 'request';
  asset?: string;                // canonical asset id
  claimableSince?: string;       // ISO time
  ageBasis: 'onchain_maturity' | 'protocol_closure' | 'position_interaction' | 'unknown';
  provenance;                    // enumerator, query, processor version, ledger version
  grossClaim; expectedPayout; payoutBasis; status; blockers; confidence; observedAt;
  steps: Step[];  // ordered recovery stages: function id, prerequisites, wait, expected outputs — descriptive only
}
// node
interface Enumerator { sourceId; run(ctx): AsyncIterable<Candidate>; report(): EnumerationReport }
```

**Pipeline:** enumerate → merge into SQLite → revalidate per §3 → price → derive status and aging → write per-source JSON. It runs daily.

**Site pages:**
- Dashboard: headline plus face, recoverable, team-gated and blocked, split by age bucket.
- Per-source pages, built as HTML for link previews.
- Check page.
- Every page shows the per-source "as of" time, the last successful run and a degraded flag. A banner appears if the last success is older than 48 hours.

**Versions:**
- Pin exact current stable versions in the lockfile at scaffold time. Do not copy them from aptos-script.
- Pin the Node version in `engines` and `.nvmrc` to one verified to ship `node:sqlite` without flags.

**Source candidates**, each classified against §1 before inclusion. Protocol status needs written evidence.

| Source | Expected status | aptos-script reference |
|---|---|---|
| Native delegation, cooled-down stake (also pending_inactive in an inactive pool) | recoverable | `aptos-script-reader-gaps/app/protocols/native_staking.py` |
| Matured LST requests: Amnis NFTs, Thala, Kofi, TruFin, Tortuga tickets | recoverable / blocked (reserve) | `staking.py`, `trufin.py`, `tortuga.py` |
| tAPT and other receipts | only if stranded per §1 | `tortuga.py`, `prices.py::_derive` |
| Auro CDP collateral (zero debt); Auro rewards | only if closure is evidenced; rewards blocked `stale_oracle` | `staking.py::_auro` |
| Econia (no open orders) | only if closure is evidenced | `other.py` |
| Fliq settled predictions | recoverable (ended position) | `other.py` |
| Thala: expired veTHL, vested-unclaimed, legacy farm, v1 LP if deprecated | recoverable | `thala_products.py` |
| Hyperion releasable fridge withdrawals | recoverable | `hyperion.py` |
| Goblin, Meso | only if closed status is evidenced | `staking.py::_goblin`, `lending.py::_meso` |
| Moar farm rewards | recoverable | `aptos_lending.py` |
| Aries, Aptin, Kana | blocked | `aries.py`, `aptos_lending.py`, `other.py` |
| Superposition, GUI lottery | team_gated | `moveposition.py`, `other.py` |

Reference material:
- `app/catalog.json`: packages including routers, Coin/FA pairs, coingeckoId, priceFrom.
- `app/discovery.py`: paging and `merge_balances`.
- `app/prices.py`.
- `investigation/collect_history.py`: version-cursor paging and watermark check.
- `tests/fixtures/catalog_abis`.
- `docs/*_VIEWS.md`.
- Gotchas:
  - Match router and event-type packages, not just core packages.
  - Some positions live off the wallet (Kana, Auro rewards).
  - `current_*` tables cannot be pinned to a ledger version.
  - Fullnode prunes history after about 11 days.
  - The Geomi key must never be sent to Movement hosts.

## 6. Later (separate decisions)

- **Backlog sources** (status research first): AUX, Animeswap, legacy Liquidswap and PancakeSwap Aptos LPs, Abel, Ditto, Topaz escrow, bridged wrapped assets, `staking_contract`/vesting.
- **Movement:** a mini Phase 0 on the Movement indexer (schema compatibility, no key), then sources. Candidates include unfinished withdrawals on Movement's native bridge.
- **Claims**, only after Phase 1 and only with release controls:
  - A fresh simulation immediately before signing.
  - Show the exact package, module, function, arguments, expected asset changes and max gas.
  - An allowlist of package bytecode/ABI hashes; abort on any change.
  - A per-action kill switch.
  - Enablement that expires.
  - Independent review for each action.
  - Acceptance rule: a fresh successful simulation on ≥ N public positions plus review. A signed claim from our own wallet is a bonus, not a requirement.

## Verification

**Phase 0:**
- Every spike can be rerun.
- Report numbers can be reproduced from saved query logs.
- 10 positions per source are spot-checked by direct `curl` to `/v1/view` and in the explorer.

**Phase 1:**
- vitest for accounting: dedupe (Coin/FA same store vs different stores), aging basis order (unknown excluded), position-ID uniqueness, the ObjectCore owner chain (cycle, depth, unsupported owner), status derivation and the headline filter.
- Explicit tests for degraded and partial runs:
  - Indexer error mid-enumeration.
  - Watermark behind.
  - View failures during revalidation.
  - Price provider down.
  - Stranded-market quote error → `unknown`.
  - Expected behaviour: totals exclude what is unknown, and sources show `degraded` with reasons.
- Per-source `read()` tests on recorded fixtures.
- The layer-boundary build test.
- `pnpm snapshot --source <id> --limit N` on a subset.
- The site build shows as-of and staleness.
- The check page returns expected results for one known public address per source.
