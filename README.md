# hidden funds · Aptos + Movement

Finds funds people left behind on Aptos and Movement. Read-only: the site never connects a wallet or asks for a signature.

Sources (evidence for each in [docs/sources.md](docs/sources.md)):

| Source | Chain | What is left behind |
|---|---|---|
| `native-delegation` | Aptos | Unstaked APT whose lockup ended, never withdrawn |
| `delegation-inactive-validator` | Aptos | APT still staked with a validator that left the set (earns nothing, withdrawable now) |
| `amnis-withdrawals` | Aptos | Amnis withdrawal NFTs past their lockup, never redeemed |
| `thala-unstake` | Aptos | Thala APT unstake requests matured, never completed |
| `kofi-withdrawals` | Aptos | Kofi withdrawal tickets unlocked, never finalized (Kofi is winding down) |
| `tortuga-tickets` | Aptos | Tortuga unstake tickets past cooldown, never claimed |
| `thala-vethl-expired` | Aptos | Expired veTHL locks never unlocked |
| `thala-vesting-matured` | Aptos | Vested THL farm rewards never claimed |
| `trufin-unlocks` | Aptos | TruFin unlock requests claimable, never withdrawn |
| `kofi-receipts` | Aptos | kAPT / stkAPT still held after Kofi's wind-down, counted only when no market buys them for ≥ 80% of redemption (Panora quote) |
| `merkle-mklp` | Aptos | Merkle Trade LP left after the wind-down (needs the Merkle team) |
| `merkle-vemkl` | Aptos | Merkle Trade staked MKL never unlocked (unlock works any time since the wind-down) |
| `pancake-syrup-ended` | Aptos | CAKE still staked in PancakeSwap syrup pools that ended in 2023-2024 |
| `pancake-farm-ended-rewards` | Aptos | CAKE and APT that PancakeSwap farms paid until emissions ended in March 2025, never harvested |
| `echelon-frozen-markets` | Aptos | Supply left in the 21 Echelon lending markets that Echelon froze (May 2025 to October 2026), by suppliers without Echelon debt |
| `aave-frozen-reserves` | Aptos | Supply left in Aave's Aptos reserves once Aave freezes them under its wind-down; counts nothing until then |
| `econia-idle-accounts` | Aptos | Coins left idle in Econia market accounts after Econia Labs archived the order book (September 2025) |
| `auro-closed-positions` | Aptos | Collateral left in debt-free Auro Finance positions after the website shut down (April 2026) |
| `animeswap-closed-lp` | Aptos | Liquidity left in AnimeSwap pools after its frontend went away (October 2026) |
| `topaz-bids` | Aptos | APT still escrowed in bids on Topaz, an NFT marketplace that closed in August 2024 |
| `layerzero-claimable` | Aptos | Tokens bridged in through LayerZero (lzUSDC, lzUSDT, lzWETH, lzWBTC, lzUSDD, CAKE, BTC.b) that arrived but were never claimed |
| `movement-native-delegation` | Movement | Unstaked MOVE whose lockup ended, never withdrawn |
| `movement-inactive-validator` | Movement | MOVE still staked with a validator that left the set |
| `canopy-ended-rewards` | Movement | Canopy staking rewards from reward periods that ended, never claimed |

- **Dashboard:** weekly aggregate snapshot per source. Only totals are published, never addresses.
- **Protocol coverage** (`/coverage`): every Aptos and Movement protocol we know of (DefiLlama's list plus a few it misses) with its status: counted, dormant, needs a decision, blocked, too small, nothing left behind, not checked yet, or out of scope. The list is `src/shared/protocols.ts`; tests keep it in sync with the sources.
- **Check:** paste addresses. Your browser reads Aptos mainnet directly; the addresses are not sent to this site.

What counts, how it is aged and how totals are computed: [docs/left-behind.md](docs/left-behind.md). Measurements behind each source: [docs/phase0-report.md](docs/phase0-report.md) and [docs/sources.md](docs/sources.md).

## Layout

| Path | What | Runs in |
|---|---|---|
| `src/shared` | Domain types, accounting, chain reader, per-source `read()` | browser + pipeline |
| `src/node` | Enumerators, keyed client, SQLite state, snapshot CLI | pipeline only |
| `src/web` | Astro pages and the check component | browser |
| `spikes` | Phase 0 measurement scripts | local only |

`tests/boundary.test.ts` fails if browser code reaches node-only code, the environment or the API key.

## Develop

Node 24.22.1 (`.nvmrc`), pnpm 9.

```sh
pnpm install
pnpm test && pnpm typecheck
GEOMI_API_KEY=… pnpm snapshot --limit 50   # small run; writes snapshot/latest.json, state in state/
pnpm dev
```

## CI

`.github/workflows/pipeline.yml`: weekly snapshot (Monday), commit `snapshot/latest.json`, build, deploy to Cloudflare Pages.

Repository secrets:

| Secret | Purpose |
|---|---|
| `GEOMI_API_KEY` | Aptos API key, pipeline only |
| `PANORA_API_KEY` | Panora quote API key for the receipt-token market test; without it, Kofi receipt positions are `unknown` and the run is degraded |
| `CLOUDFLARE_API_TOKEN` | token with Cloudflare Pages: Edit |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
