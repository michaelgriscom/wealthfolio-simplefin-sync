# SimpleFIN Sync for Wealthfolio

A [Wealthfolio](https://wealthfolio.app) addon that pulls your current investment
holdings from the [SimpleFIN Bridge](https://beta-bridge.simplefin.org) and writes
them into Wealthfolio as **dated holdings snapshots** — so your asset allocation
stays up to date without manual data entry.

Money-market / sweep funds (VMFXX, SPAXX, FDRXX, …) are folded into the account's
cash balance instead of being tracked as securities, so allocation treats them as
cash.

Credit card and bank accounts can be synced too: their posted transactions become
Wealthfolio activities (charges, payments, refunds, deposits, fees, interest), so
they show up in Wealthfolio's spending views. See **Transaction sync** below.

The addon syncs **on demand** while its page is open — it can't run unattended due to architectural limitations with addons.

For automatic daily sync, you can use:
**[this sidecar docker container](https://github.com/michaelgriscom/wealthfolio-simplefin-sidecar)** instead.
It runs the same SimpleFIN → snapshot logic as its own container against
Wealthfolio's REST API, configured by a JSON file.

## Requirements

- Wealthfolio **3.6.1+** (desktop or self-hosted server mode).
- A SimpleFIN Bridge **setup token** (from *Connect your bank* at `bridge.simplefin.org`).

## Usage

1. Install the addon (see **Install** below) and open **SimpleFIN Sync** from the sidebar.
2. **Step 1** — paste your SimpleFIN setup token and click *Save*. It is claimed once and the
   resulting credential stored in the system keyring via the addon's private secrets store.
3. **Step 2** — click *Refresh from SimpleFIN* to list your accounts, then map each
   brokerage account to a HOLDINGS-mode Wealthfolio account, and each card or bank
   account to a Credit Card or transaction-tracked Cash account.
4. **Step 3** — click *Sync now* to write today's snapshot for every mapped brokerage
   account and the new transactions for every mapped card or bank account.

## Transaction sync

Which path an account takes depends on the Wealthfolio account it's mapped to:

| Wealthfolio account | What's synced |
|---|---|
| Credit Card | Posted transactions |
| Cash, tracking transactions | Posted transactions |
| Anything else (HOLDINGS mode) | Holdings snapshot |

Each sync reads the last 30 days of **posted** transactions; pending ones are
skipped until they post. Every activity carries its SimpleFIN transaction id, so
transactions already synced are recognized and not added again.

SimpleFIN amounts are signed, but they don't say what kind of transaction they are,
so the type is inferred:

- **Card:** a charge becomes a withdrawal (a fee or interest when the description says
  so); a credit becomes a payment (*Transfer in*) when the description looks like one
  ("PAYMENT", "AUTOPAY", "THANK YOU"), otherwise a refund (*Credit*).
- **Bank:** money in is a deposit (or interest); money out is a withdrawal (or a fee),
  or a *Transfer out* when it looks like a card payment ("CREDIT CRD", "AUTOPAY").

When the bank-side and card-side legs of a card payment both come through in the same
sync (same amount, within 5 days), they are linked as one transfer, so the payment
isn't also counted as spending.

Limitations:

- Only the last 30 days are imported. Wealthfolio's account balance is built from
  activities, so it won't match the bank until earlier history is added, e.g. with
  Wealthfolio's CSV import.
- Inferred types can be wrong; fix them in Wealthfolio. A leg whose counterpart posts
  in a later sync isn't linked automatically; link it in Wealthfolio.
- Brokerage transactions aren't synced: SimpleFIN doesn't give their symbol, quantity
  or price.

## Troubleshooting

### "System keyring unavailable"

Wealthfolio stores addon secrets in your OS keyring. On Linux that requires a
D-Bus Secret Service provider; without one you'll see
`org.freedesktop.DBus.Error.ServiceUnknown: The name is not activatable` in the
logs and the addon can't save your SimpleFIN credential. Install and start one of
gnome-keyring, KWallet, or KeePassXC (with Secret Service integration enabled),
then reopen Wealthfolio.

This affects the desktop app only.

### Network access prompt

On install, and again after each update, you must approve network access to `bridge.simplefin.org` and
`beta-bridge.simplefin.org`. To allow the sites, first navigate to Settings → Addons → hover over the SimpleFIN Sync card → click the eye icon, then check the boxes at the bottom of the pop-up

## Install

Download the `.zip` from the [latest release](../../releases/latest) and load it via
Wealthfolio's addon manager, or build it yourself (below).

## Development

```bash
pnpm install
pnpm build      # bundle to dist/addon.js
pnpm bundle     # build + package dist/wealthfolio-simplefin-sync-<version>.zip
pnpm type-check # tsc --noEmit
pnpm test       # unit tests (pnpm test:coverage adds coverage)
```

For live reload against a local Wealthfolio dev build, see the
[addon dev guide](https://wealthfolio.app/docs/addons/getting-started/).

## License

MIT
