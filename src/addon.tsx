import { type AddonContext } from "@wealthfolio/addon-sdk";
import { Button, Icons, Page, PageContent, PageHeader } from "@wealthfolio/ui";
import React, { useEffect, useState } from "react";
import { mapAccountToSnapshot } from "./lib/mapping";
import { fetchAccounts, isAccessUrl, resolveAccessUrl, type SimpleFinAccount } from "./lib/simplefin";

const SECRET_ACCESS_URL = "access_url";
const SECRET_MAPPING = "account_mapping";
const ROUTE = "/addon/simplefin-sync";

interface WfAccount {
  id: string;
  name: string;
  currency: string;
}

function SimpleFinSyncPage({ ctx }: { ctx: AddonContext }) {
  const [accessUrl, setAccessUrl] = useState("");
  const [hasSavedUrl, setHasSavedUrl] = useState(false);
  const [sfAccounts, setSfAccounts] = useState<SimpleFinAccount[]>([]);
  const [wfAccounts, setWfAccounts] = useState<WfAccount[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const savedUrl = await ctx.api.secrets.get(SECRET_ACCESS_URL);
        setHasSavedUrl(Boolean(savedUrl));
        const savedMapping = await ctx.api.secrets.get(SECRET_MAPPING);
        if (savedMapping) setMapping(JSON.parse(savedMapping) as Record<string, string>);
        const accounts = await ctx.api.accounts.getAll();
        setWfAccounts(
          accounts.map((a) => ({ id: a.id, name: a.name, currency: a.currency })),
        );
      } catch (e) {
        ctx.api.logger.error("Failed to load saved state: " + (e as Error).message);
      }
    })();
  }, [ctx]);

  async function saveAccessUrl() {
    const value = accessUrl.trim();
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      // Accept either a paste of the access URL or the one-time setup token.
      const wasToken = !isAccessUrl(value);
      const accessUrl = await resolveAccessUrl(value);
      await ctx.api.secrets.set(SECRET_ACCESS_URL, accessUrl);
      setHasSavedUrl(true);
      setAccessUrl("");
      ctx.api.toast.success(wasToken ? "Token claimed and saved" : "SimpleFIN access URL saved");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function refreshAccounts() {
    setBusy(true);
    setError(null);
    try {
      const url = await ctx.api.secrets.get(SECRET_ACCESS_URL);
      if (!url) {
        setError("Save your SimpleFIN access URL first.");
        return;
      }
      const response = await fetchAccounts(url);
      const investment = response.accounts.filter((a) => (a.holdings?.length ?? 0) > 0);
      setSfAccounts(investment);
      if (response.errors?.length) {
        ctx.api.toast.warning(`SimpleFIN reported: ${response.errors.join("; ")}`);
      }
      ctx.api.toast.success(`Found ${investment.length} investment account(s) with holdings`);
    } catch (e) {
      setError((e as Error).message);
      ctx.api.logger.error("Refresh failed: " + (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function updateMapping(simplefinAccountId: string, wealthfolioAccountId: string) {
    const next = { ...mapping };
    if (wealthfolioAccountId) next[simplefinAccountId] = wealthfolioAccountId;
    else delete next[simplefinAccountId];
    setMapping(next);
    try {
      await ctx.api.secrets.set(SECRET_MAPPING, JSON.stringify(next));
    } catch (e) {
      ctx.api.logger.error("Failed to persist mapping: " + (e as Error).message);
    }
  }

  async function syncNow() {
    setBusy(true);
    setError(null);
    const date = new Date().toISOString().slice(0, 10);
    let synced = 0;
    let failed = 0;
    try {
      for (const account of sfAccounts) {
        const wfAccountId = mapping[account.id];
        if (!wfAccountId) continue;
        const { positions, cashBalances } = mapAccountToSnapshot(account);
        try {
          await ctx.api.snapshots.save(wfAccountId, positions, cashBalances, date);
          synced += 1;
          ctx.api.logger.info(
            `Saved snapshot for "${account.name}" (${positions.length} positions) on ${date}`,
          );
        } catch (e) {
          failed += 1;
          ctx.api.logger.error(
            `Snapshot failed for "${account.name}": ${(e as Error).message}`,
          );
        }
      }
      if (synced === 0 && failed === 0) {
        ctx.api.toast.info("No mapped accounts to sync. Map an account first.");
      } else if (failed === 0) {
        ctx.api.toast.success(`Synced ${synced} account(s)`);
      } else {
        ctx.api.toast.warning(`Synced ${synced}, failed ${failed}. See logs.`);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const mappedCount = Object.keys(mapping).length;

  return (
    <Page>
      <PageHeader>
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold sm:text-xl">SimpleFIN Sync</h1>
          </div>
          <p className="text-muted-foreground text-sm sm:text-base">
            Pull current investment holdings from the SimpleFIN Bridge and write them as dated
            snapshots to your Wealthfolio HOLDINGS-mode accounts.
          </p>
        </div>
      </PageHeader>
      <PageContent>
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
          {error ? (
            <div className="text-destructive rounded-md border border-red-200 bg-red-50 p-3 text-sm dark:border-red-800 dark:bg-red-950">
              {error}
            </div>
          ) : null}

          {/* Step 1 — credentials */}
          <section className="rounded-lg border p-4">
            <h2 className="mb-1 text-base font-semibold">1. SimpleFIN setup token</h2>
            <p className="text-muted-foreground mb-3 text-sm">
              Paste the setup token SimpleFIN gives you after connecting your accounts at{" "}
              <code>bridge.simplefin.org</code>. It is claimed once and stored in the system
              keyring, never in plain text.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                type="password"
                className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
                placeholder={hasSavedUrl ? "•••••••• (saved — paste a new token to replace)" : "Paste your SimpleFIN setup token"}
                value={accessUrl}
                onChange={(e) => setAccessUrl(e.target.value)}
              />
              <Button onClick={saveAccessUrl} disabled={busy || !accessUrl.trim()}>
                Save
              </Button>
            </div>
          </section>

          {/* Step 2 — discover + map */}
          <section className="rounded-lg border p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold">2. Map accounts</h2>
              <Button variant="outline" onClick={refreshAccounts} disabled={busy}>
                {busy ? <Icons.Loader className="mr-2 h-4 w-4 animate-spin" /> : null}
                Refresh from SimpleFIN
              </Button>
            </div>
            {sfAccounts.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No investment accounts loaded yet. Save your access URL, then click “Refresh from
                SimpleFIN”.
              </p>
            ) : (
              <ul className="flex flex-col gap-3">
                {sfAccounts.map((account) => (
                  <li
                    key={account.id}
                    className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{account.name}</p>
                      <p className="text-muted-foreground text-xs">
                        {account.org?.name ?? "SimpleFIN"} · {account.holdings?.length ?? 0} holdings
                      </p>
                    </div>
                    <select
                      className="border-input bg-background rounded-md border px-2 py-1.5 text-sm"
                      value={mapping[account.id] ?? ""}
                      onChange={(e) => updateMapping(account.id, e.target.value)}
                    >
                      <option value="">— not synced —</option>
                      {wfAccounts.map((wf) => (
                        <option key={wf.id} value={wf.id}>
                          {wf.name}
                        </option>
                      ))}
                    </select>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-muted-foreground mt-3 text-xs">
              Map each SimpleFIN account to a Wealthfolio account that uses HOLDINGS tracking mode.
              Create those accounts in Wealthfolio first if they don’t exist yet.
            </p>
          </section>

          {/* Step 3 — sync */}
          <section className="rounded-lg border p-4">
            <h2 className="mb-1 text-base font-semibold">3. Sync</h2>
            <p className="text-muted-foreground mb-3 text-sm">
              Writes today’s holdings snapshot for each mapped account ({mappedCount} mapped).
            </p>
            <Button onClick={syncNow} disabled={busy || mappedCount === 0}>
              {busy ? <Icons.Loader className="mr-2 h-4 w-4 animate-spin" /> : null}
              Sync now
            </Button>
          </section>
        </div>
      </PageContent>
    </Page>
  );
}

/**
 * SimpleFIN Sync addon entry point.
 *
 * Registers a sidebar item and a page that lets you pull investment holdings
 * from the SimpleFIN Bridge and store them as Wealthfolio holdings snapshots.
 */
export default function enable(ctx: AddonContext) {
  ctx.api.logger.info("SimpleFIN Sync addon enabling");
  const cleanup: Array<{ remove: () => void }> = [];

  try {
    const sidebarItem = ctx.sidebar.addItem({
      id: "simplefin-sync",
      label: "SimpleFIN Sync",
      icon: <Icons.RefreshCw className="h-5 w-5" />,
      route: ROUTE,
      order: 210,
    });
    cleanup.push(sidebarItem);

    ctx.router.add({
      path: ROUTE,
      component: React.lazy(() =>
        Promise.resolve({ default: () => <SimpleFinSyncPage ctx={ctx} /> }),
      ),
    });

    ctx.api.logger.info("SimpleFIN Sync addon enabled");
  } catch (e) {
    ctx.api.logger.error("Failed to enable SimpleFIN Sync: " + (e as Error).message);
    throw e;
  }

  ctx.onDisable(() => {
    cleanup.forEach((item) => {
      try {
        item.remove();
      } catch (e) {
        ctx.api.logger.error("Cleanup error: " + (e as Error).message);
      }
    });
    ctx.api.logger.info("SimpleFIN Sync addon disabled");
  });
}
