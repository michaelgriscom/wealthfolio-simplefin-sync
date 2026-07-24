import { type AddonContext } from "@wealthfolio/addon-sdk";
import { Button, Icons, Page, PageContent, PageHeader } from "@wealthfolio/ui";
import { useEffect, useState } from "react";
import { aggregateSnapshots } from "./lib/aggregate";
import { mapAccountToSnapshot } from "./lib/mapping";
import {
  fetchAccounts,
  isAccessUrl,
  resolveAccessUrl,
  splitAccessUrl,
  type NetworkRequestFn,
  type SimpleFinAccount,
  type SplitAccessUrl,
} from "./lib/simplefin";

/**
 * Secret store key holding base64 `user:pass` for the Bridge. The host's network
 * broker reads it by name, so this must be the only home for the credential —
 * the broker refuses an addon-supplied `Authorization` header and refuses
 * credentials in the URL, leaving no alternative if the store is unavailable.
 */
const SECRET_CREDENTIALS = "bridge_credentials";
/** Pre-3.6 keyring keys, migrated on first load and then deleted. */
const LEGACY_SECRET_ACCESS_URL = "access_url";
const LEGACY_SECRET_MAPPING = "account_mapping";
/** Durable storage keys. Storage is SQLite-backed and needs no system keyring. */
const STORAGE_BASE_URL = "bridge_base_url";
const STORAGE_MAPPING = "account_mapping";

const ROUTE = "/addon/simplefin-sync";

const KEYRING_HELP =
  "Wealthfolio can't reach a system keyring on this machine, so the SimpleFIN " +
  "credential can't be stored. On Linux this usually means no Secret Service " +
  "provider is running — install and start gnome-keyring, KWallet, or KeePassXC " +
  "with Secret Service integration enabled, then reopen Wealthfolio.";

interface WfAccount {
  id: string;
  name: string;
  currency: string;
}

/** Whether the host's secret store is usable. Probed once on mount. */
type KeyringState = "probing" | "ok" | "unavailable";

/** Run an operation, reporting whether the secret store rejected it. */
async function trySecret<T>(op: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: Error }> {
  try {
    return { ok: true, value: await op() };
  } catch (e) {
    return { ok: false, error: e as Error };
  }
}

function SimpleFinSyncPage({ ctx }: { ctx: AddonContext }) {
  const [accessUrl, setAccessUrl] = useState("");
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [hasCredentials, setHasCredentials] = useState(false);
  const [keyring, setKeyring] = useState<KeyringState>("probing");
  /**
   * A claimed-but-not-yet-persisted credential. A SimpleFIN setup token is
   * consumed by the claim call, so if the secret store rejects the write
   * afterwards the token is already spent and re-pasting it won't work. Holding
   * the result here lets the user fix their keyring and retry the save without
   * losing access.
   */
  const [pending, setPending] = useState<SplitAccessUrl | null>(null);
  const [sfAccounts, setSfAccounts] = useState<SimpleFinAccount[]>([]);
  const [wfAccounts, setWfAccounts] = useState<WfAccount[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const request: NetworkRequestFn = (req) => ctx.api.network.request(req);

  useEffect(() => {
    void (async () => {
      // Storage first: it works even when the keyring is dead, so the account
      // mapping and Bridge URL always load and the page is never blank.
      try {
        const savedMapping = await ctx.api.storage.get(STORAGE_MAPPING);
        if (savedMapping) setMapping(JSON.parse(savedMapping) as Record<string, string>);
      } catch (e) {
        ctx.api.logger.error("Failed to read stored mapping: " + (e as Error).message);
      }

      let storedBaseUrl = await ctx.api.storage.get(STORAGE_BASE_URL).catch(() => null);

      try {
        const accounts = await ctx.api.accounts.getAll();
        setWfAccounts(accounts.map((a) => ({ id: a.id, name: a.name, currency: a.currency })));
      } catch (e) {
        ctx.api.logger.error("Failed to list Wealthfolio accounts: " + (e as Error).message);
      }

      // Probe the secret store. A throw here means the platform keyring is
      // unavailable (e.g. no D-Bus Secret Service on Linux), not a missing key.
      const probe = await trySecret(() => ctx.api.secrets.get(SECRET_CREDENTIALS));
      let credentials: string | null = null;

      if (probe.ok) {
        setKeyring("ok");
        credentials = probe.value;
        const migrated = await migrateLegacySecrets(storedBaseUrl, credentials);
        if (migrated) {
          storedBaseUrl = migrated.baseUrl;
          credentials = migrated.credentials;
        }
      } else {
        setKeyring("unavailable");
        ctx.api.logger.error("Secret store unavailable: " + probe.error.message);
      }

      setBaseUrl(storedBaseUrl);
      setHasCredentials(Boolean(credentials));

      // If credentials are already saved, load the SimpleFIN accounts so the
      // existing mapping shows up prepopulated instead of a blank screen.
      if (storedBaseUrl && credentials) {
        await loadAccounts(storedBaseUrl, { silent: true });
      }
    })();

    /**
     * Move pre-3.6 state onto the current layout: the single `access_url` secret
     * becomes a stored base URL plus a keyring credential, and the mapping moves
     * out of the keyring into durable storage.
     */
    async function migrateLegacySecrets(
      storedBaseUrl: string | null,
      credentials: string | null,
    ): Promise<{ baseUrl: string; credentials: string } | null> {
      const legacyMapping = await ctx.api.secrets.get(LEGACY_SECRET_MAPPING).catch(() => null);
      if (legacyMapping) {
        try {
          setMapping(JSON.parse(legacyMapping) as Record<string, string>);
          await ctx.api.storage.set(STORAGE_MAPPING, legacyMapping);
          await ctx.api.secrets.delete(LEGACY_SECRET_MAPPING);
          ctx.api.logger.info("Migrated account mapping from keyring to durable storage");
        } catch (e) {
          ctx.api.logger.error("Mapping migration failed: " + (e as Error).message);
        }
      }

      if (storedBaseUrl && credentials) return null;
      const legacyUrl = await ctx.api.secrets.get(LEGACY_SECRET_ACCESS_URL).catch(() => null);
      if (!legacyUrl) return null;
      try {
        const split = splitAccessUrl(legacyUrl);
        await ctx.api.storage.set(STORAGE_BASE_URL, split.baseUrl);
        await ctx.api.secrets.set(SECRET_CREDENTIALS, split.credentials);
        await ctx.api.secrets.delete(LEGACY_SECRET_ACCESS_URL);
        ctx.api.logger.info("Migrated SimpleFIN access URL to split base URL + credential");
        return split;
      } catch (e) {
        ctx.api.logger.error("Access URL migration failed: " + (e as Error).message);
        return null;
      }
    }
  }, [ctx]);

  /**
   * Persist the Bridge credential into the addon's secret store — the only place
   * the network broker will read it from. Throws with remediation text when the
   * store is unavailable, since there is no alternative location that would work.
   */
  async function persistCredentials(credentials: string): Promise<void> {
    const stored = await trySecret(() => ctx.api.secrets.set(SECRET_CREDENTIALS, credentials));
    if (stored.ok) {
      setKeyring("ok");
      return;
    }
    setKeyring("unavailable");
    ctx.api.logger.error("Secret store write failed: " + stored.error.message);
    throw new Error(KEYRING_HELP);
  }

  /** True when a credential is present and readable for the broker to resolve. */
  async function hasStoredCredentials(): Promise<boolean> {
    const stored = await trySecret(() => ctx.api.secrets.get(SECRET_CREDENTIALS));
    return stored.ok && Boolean(stored.value);
  }

  async function saveAccessUrl() {
    const value = accessUrl.trim();
    if (!value && !pending) return;

    // Claiming a setup token consumes it, so refuse before spending it when we
    // already know the credential has nowhere to go.
    if (keyring === "unavailable") {
      setError(KEYRING_HELP);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      // Accept either a paste of the access URL or the one-time setup token.
      const wasToken = Boolean(value) && !isAccessUrl(value);
      let split: SplitAccessUrl;
      if (value) {
        split = splitAccessUrl(await resolveAccessUrl(value, request));
        setPending(split);
      } else {
        split = pending!;
      }
      await ctx.api.storage.set(STORAGE_BASE_URL, split.baseUrl);
      await persistCredentials(split.credentials);
      setBaseUrl(split.baseUrl);
      setHasCredentials(true);
      setAccessUrl("");
      setPending(null);
      ctx.api.toast.success(wasToken ? "Token claimed and saved" : "SimpleFIN access URL saved");
      await loadAccounts(split.baseUrl);
    } catch (e) {
      setError((e as Error).message);
      ctx.api.logger.error("Save failed: " + (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function loadAccounts(url: string, opts: { silent?: boolean } = {}) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetchAccounts(url, SECRET_CREDENTIALS, request);
      const investment = response.accounts.filter((a) => (a.holdings?.length ?? 0) > 0);
      setSfAccounts(investment);
      if (response.errors?.length) {
        ctx.api.toast.warning(`SimpleFIN reported: ${response.errors.join("; ")}`);
      }
      if (!opts.silent) {
        ctx.api.toast.success(`Found ${investment.length} investment account(s) with holdings`);
      }
    } catch (e) {
      setError((e as Error).message);
      ctx.api.logger.error("Refresh failed: " + (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function refreshAccounts() {
    const url = baseUrl ?? (await ctx.api.storage.get(STORAGE_BASE_URL).catch(() => null));
    if (!url || !(await hasStoredCredentials())) {
      setError(keyring === "unavailable" ? KEYRING_HELP : "Save your SimpleFIN token first.");
      return;
    }
    await loadAccounts(url);
  }

  async function updateMapping(simplefinAccountId: string, wealthfolioAccountId: string) {
    const next = { ...mapping };
    if (wealthfolioAccountId) next[simplefinAccountId] = wealthfolioAccountId;
    else delete next[simplefinAccountId];
    setMapping(next);
    try {
      // Durable storage, not the keyring: the mapping isn't a secret, and this
      // keeps mapping usable on hosts with no Secret Service provider.
      await ctx.api.storage.set(STORAGE_MAPPING, JSON.stringify(next));
    } catch (e) {
      ctx.api.logger.error("Failed to persist mapping: " + (e as Error).message);
      setError("Couldn't save the account mapping: " + (e as Error).message);
    }
  }

  async function syncNow() {
    setBusy(true);
    setError(null);
    const date = new Date().toISOString().slice(0, 10);
    let synced = 0;
    let failed = 0;
    try {
      // Group SimpleFIN accounts by their target Wealthfolio account so several
      // mapped to the same account are aggregated into one snapshot (matching
      // the sidecar) instead of overwriting each other.
      const byWfAccount = new Map<string, SimpleFinAccount[]>();
      for (const account of sfAccounts) {
        const wfAccountId = mapping[account.id];
        if (!wfAccountId) continue;
        const group = byWfAccount.get(wfAccountId);
        if (group) group.push(account);
        else byWfAccount.set(wfAccountId, [account]);
      }
      for (const [wfAccountId, accounts] of byWfAccount) {
        const merged = aggregateSnapshots(accounts.map((a) => mapAccountToSnapshot(a)));
        try {
          await ctx.api.snapshots.save(wfAccountId, merged.positions, merged.cashBalances, date);
          synced += 1;
          ctx.api.logger.info(
            `Saved snapshot for ${accounts.length} account(s) → ${wfAccountId} ` +
              `(${merged.positions.length} positions) on ${date}`,
          );
        } catch (e) {
          failed += 1;
          ctx.api.logger.error(
            `Snapshot failed for ${wfAccountId}: ${(e as Error).message}`,
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

          {keyring === "unavailable" ? (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
              <p className="font-medium">System keyring unavailable</p>
              <p className="mt-1">{KEYRING_HELP}</p>
              <p className="mt-2">
                Wealthfolio's network broker only accepts a credential it can read from the
                secret store, so there is no alternative location the addon could use instead.
                Your account mapping is unaffected — it is kept in Wealthfolio's own database.
              </p>
            </div>
          ) : null}

          {/* Step 1 — credentials */}
          <section className="rounded-lg border p-4">
            <h2 className="mb-1 text-base font-semibold">1. SimpleFIN setup token</h2>
            <p className="text-muted-foreground mb-3 text-sm">
              Paste the setup token SimpleFIN gives you after connecting your accounts at{" "}
              <code>bridge.simplefin.org</code>. It is claimed once and stored in the system
              keyring, never in plain text. You can also paste an already-claimed{" "}
              <strong>access URL</strong> (<code>https://…@bridge.simplefin.org</code>) directly.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                type="password"
                className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
                placeholder={hasCredentials ? "•••••••• (saved — paste a new token to replace)" : "Paste your SimpleFIN setup token or access URL"}
                value={accessUrl}
                onChange={(e) => setAccessUrl(e.target.value)}
              />
              <Button onClick={saveAccessUrl} disabled={busy || (!accessUrl.trim() && !pending)}>
                {pending ? "Retry save" : "Save"}
              </Button>
            </div>
            {pending ? (
              <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
                Your token was claimed successfully but couldn’t be stored. It has already been
                consumed, so don’t paste it again — fix the keyring problem above, then click
                “Retry save”.
              </p>
            ) : null}
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
                No investment accounts loaded yet. Save your token, then click “Refresh from
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
 *
 * Wealthfolio 3.6 runs addons in a sandboxed iframe, so the page is handed to
 * the host as a component (the host owns the React root) rather than mounted
 * here, and the sidebar icon is a host icon name rather than a React node.
 */
export default function enable(ctx: AddonContext) {
  ctx.api.logger.info("SimpleFIN Sync addon enabling");
  const cleanup: Array<{ remove: () => void }> = [];

  try {
    const sidebarItem = ctx.sidebar.addItem({
      id: "simplefin-sync",
      label: "SimpleFIN Sync",
      icon: "plugs-connected",
      route: ROUTE,
      order: 210,
    });
    cleanup.push(sidebarItem);

    const RouteComponent = () => <SimpleFinSyncPage ctx={ctx} />;
    ctx.router.add({
      id: "simplefin-sync",
      path: ROUTE,
      title: "SimpleFIN Sync",
      component: RouteComponent,
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
