# hidden funds · Aptos

Finds APT people left behind on Aptos: stake that finished unlocking but was never withdrawn, and unstake requests that matured but were never claimed. Read-only: the site never connects a wallet or asks for a signature.

- **Dashboard:** weekly aggregate snapshot per source. Only totals are published, never addresses.
- **Check:** paste addresses. Your browser reads Aptos mainnet directly; the addresses are not sent to this site.

What counts, how it is aged and how totals are computed: [docs/left-behind.md](docs/left-behind.md). Measurements behind each source: [docs/phase0-report.md](docs/phase0-report.md).

## Layout

| Path | What | Runs in |
|---|---|---|
| `src/shared` | Domain types, accounting, chain reader, per-source `read()` | browser + pipeline |
| `src/node` | Enumerators, keyed client, SQLite state, snapshot CLI | pipeline only |
| `src/web` | Astro pages and the check component | browser |
| `spikes` | Phase 0 measurement scripts | local only |

`tests/boundary.test.ts` fails if browser code reaches node-only code, the environment or the API key.

## Develop

Node 24.21.0 (`.nvmrc`), pnpm 9.

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
| `CLOUDFLARE_API_TOKEN` | token with Cloudflare Pages: Edit |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
