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

- Wealthfolio **3.6.1+** (desktop or self-hosted server mode). Wealthfolio 3.6 runs
  addons in a sandboxed iframe; this addon targets that sandbox and will not load
  on 3.5.x. If you are still on 3.5, use the **1.0.0** release.
- A SimpleFIN Bridge **setup token** (from *Connect your bank* at `bridge.simplefin.org`).

## Usage

1. Install the addon (see **Install** below) and open **SimpleFIN Sync** from the sidebar.
2. **Step 1** — paste your SimpleFIN setup token and click *Save*. It is claimed once and the
   resulting credential stored in the system keyring via the addon's private secrets store.
3. **Step 2** — click *Refresh from SimpleFIN* to list brokerage accounts that report
   holdings, then map each one to a HOLDINGS-mode Wealthfolio account.
4. **Step 3** — click *Sync now* to write today's snapshot for every mapped account.

## Troubleshooting

### "System keyring unavailable"

Wealthfolio stores addon secrets in your OS keyring. On Linux that requires a
D-Bus Secret Service provider; without one you'll see
`org.freedesktop.DBus.Error.ServiceUnknown: The name is not activatable` in the
logs and the addon can't save your SimpleFIN credential. Install and start one of
gnome-keyring, KWallet, or KeePassXC (with Secret Service integration enabled),
then reopen Wealthfolio.

Your account mapping is unaffected — it lives in Wealthfolio's own database, not
the keyring. If you'd rather not run a keyring at all, the addon offers an
explicit opt-in to store the SimpleFIN credential in that database instead. It is
kept **in plain text** and replicated to your paired devices, so only take that
option if you accept the trade-off.

### Self-hosted SimpleFIN bridges

The 3.6 sandbox only permits outbound requests to hosts declared in
`manifest.json`, so this addon can reach `bridge.simplefin.org` and
`beta-bridge.simplefin.org` only. A bridge on any other domain is rejected with a
clear error rather than failing opaquely.

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
