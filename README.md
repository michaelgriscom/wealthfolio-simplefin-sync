# SimpleFIN Sync for Wealthfolio

A [Wealthfolio](https://wealthfolio.app) addon that pulls your current investment
holdings from the [SimpleFIN Bridge](https://beta-bridge.simplefin.org) and writes
them into Wealthfolio as **dated holdings snapshots** — so your asset allocation
stays up to date without manual data entry.

Money-market / sweep funds (VMFXX, SPAXX, FDRXX, …) are folded into the account's
cash balance instead of being tracked as securities, so allocation treats them as
cash.

The addon syncs **on demand** while its page is open — it can't run unattended due to architectural limitations with addons.

For automatic daily sync, you can use:
**[this sidecar docker container](https://github.com/michaelgriscom/wealthfolio-simplefin-sidecar)** instead.
It runs the same SimpleFIN → snapshot logic as its own container against
Wealthfolio's REST API, configured by a JSON file.

## Requirements

- Wealthfolio **3.5+** (desktop or self-hosted server mode).
- A SimpleFIN Bridge **setup token** (from *Connect your bank* at `bridge.simplefin.org`).

## Usage

1. Install the addon (see **Install** below) and open **SimpleFIN Sync** from the sidebar.
2. **Step 1** — paste your SimpleFIN setup token and click *Save*. It is claimed once and the
   resulting access stored in the system keyring via the addon's private secrets store.
3. **Step 2** — click *Refresh from SimpleFIN* to list brokerage accounts that report
   holdings, then map each one to a HOLDINGS-mode Wealthfolio account.
4. **Step 3** — click *Sync now* to write today's snapshot for every mapped account.

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

## License

MIT
