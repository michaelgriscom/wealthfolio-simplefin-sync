# SimpleFIN Sync for Wealthfolio

A [Wealthfolio](https://wealthfolio.app) addon that pulls your current investment
holdings from the [SimpleFIN Bridge](https://beta-bridge.simplefin.org) and writes
them into Wealthfolio as **dated holdings snapshots** — so your asset allocation
stays up to date without manual data entry.

## Why snapshots?

The SimpleFIN Bridge returns a current `holdings` array for brokerage accounts
(symbol, shares, market value, cost basis). Wealthfolio's HOLDINGS tracking mode
accepts a point-in-time snapshot of positions + cash, which is a direct match —
no need to reconstruct a buy/sell transaction history.

Money-market / sweep funds (VMFXX, SPAXX, FDRXX, …) are folded into the account's
cash balance instead of being tracked as securities, so allocation treats them as
cash.

## Requirements

- Wealthfolio **3.5+** (desktop or self-hosted server mode).
- A SimpleFIN Bridge **setup token** (from *Connect your bank* at `bridge.simplefin.org`).
- One Wealthfolio account per brokerage, set to **HOLDINGS** tracking mode.

## Usage

1. Install the addon (see **Install** below) and open **SimpleFIN Sync** from the sidebar.
2. **Step 1** — paste your SimpleFIN setup token and click *Save*. It is claimed once and the
   resulting access stored in the system keyring via the addon's private secrets store, never in plain text.
3. **Step 2** — click *Refresh from SimpleFIN* to list brokerage accounts that report
   holdings, then map each one to a HOLDINGS-mode Wealthfolio account.
4. **Step 3** — click *Sync now* to write today's snapshot for every mapped account.

### Scheduling note

The addon syncs **on demand** while its page is open — it can't run unattended. It
also maps SimpleFIN accounts **1:1**, so it can't merge several SimpleFIN accounts
into one Wealthfolio account. For automatic, unattended sync (and many-to-one
aggregation), use the **sync daemon** below.

## Automated sync daemon

`sync/` contains a small Node daemon that runs the same SimpleFIN → snapshot logic
unattended against Wealthfolio's server REST API. It reuses `src/lib/{simplefin,mapping}.ts`
(which have no runtime third-party imports), so the container only needs `tsx`.

**Config file** (`/config/config.json`, mounted; keep it out of version control):

```json
{
  "simplefinAccessUrl": "https://user:pass@bridge.simplefin.org/simplefin",
  "mapping": {
    "<wealthfolio-account-id>": ["<simplefin-account-id>", "..."]
  }
}
```

Each Wealthfolio account maps to one or more SimpleFIN accounts; multiple sources are
**aggregated** (duplicate tickers summed with quantity-weighted average cost, cash
summed per currency).

**Environment:**

| Var | Default | Purpose |
| --- | --- | --- |
| `WF_BASE_URL` | `http://wealthfolio:8088` | Wealthfolio server API base |
| `WF_PASSWORD` | — (required) | Wealthfolio login password |
| `SYNC_AT` | `04:00` | Daily run time (24h local) |
| `RUN_ON_START` | `false` | Sync once on startup |
| `CASH_SYMBOLS` | built-in list | Comma-separated tickers to treat as cash |
| `CONFIG_FILE` | `/config/config.json` | Path to the config file |
| `PORT` | `8080` | Health/status/trigger HTTP port |

**Run:**

```bash
docker build -t wealthfolio-simplefin-sync:local .
# scheduled daemon:
docker run -v ./config.json:/config/config.json:ro -e WF_PASSWORD=… wealthfolio-simplefin-sync:local
# one-shot (exits non-zero on any failure):
docker run … wealthfolio-simplefin-sync:local tsx sync/main.ts --once
```

HTTP endpoints: `GET /` (health), `GET /status` (last run), `POST /sync` (trigger now).

## Install

Download the `.zip` from the [latest release](../../releases/latest) and load it via
Wealthfolio's addon manager, or build it yourself (below).

## Development

```bash
pnpm install
pnpm build      # bundle to dist/addon.js
pnpm bundle     # build + package dist/wealthfolio-simplefin-sync-<version>.zip
pnpm type-check # tsc --noEmit
```

For live reload against a local Wealthfolio dev build, see the
[addon dev guide](https://wealthfolio.app/docs/addons/getting-started/).

## Releases

Releases are automated with [release-please](https://github.com/googleapis/release-please).
Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`,
`docs:`, …); merging the release PR tags a version, bumps `package.json` +
`manifest.json`, and attaches the built `.zip` to the GitHub release.

## License

MIT
