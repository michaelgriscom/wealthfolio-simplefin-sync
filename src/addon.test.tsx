// @vitest-environment jsdom
import type { AddonContext, NetworkRequest, NetworkResponse } from "@wealthfolio/addon-sdk";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import enable from "./addon";
import type { SimpleFinAccount } from "./lib/simplefin";

// The host provides @wealthfolio/ui at runtime; plain elements are enough here.
vi.mock("@wealthfolio/ui", async () => {
  const { createElement } = await import("react");
  const passthrough = ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children);
  return {
    Page: passthrough,
    PageHeader: passthrough,
    PageContent: passthrough,
    Button: ({ children, onClick, disabled }: Record<string, never>) =>
      createElement("button", { onClick, disabled }, children),
    Icons: { Loader: () => null },
  };
});

const BASE_URL = "https://beta-bridge.simplefin.org/simplefin";
const ACCESS_URL = "https://demo:s3cret@beta-bridge.simplefin.org/simplefin";
const CLAIM_URL = "https://beta-bridge.simplefin.org/simplefin/claim/ONE-TIME";
const SETUP_TOKEN = btoa(CLAIM_URL);
const CREDENTIALS = btoa("demo:s3cret");

const SF_ACCOUNTS: SimpleFinAccount[] = [
  {
    id: "sf-taxable",
    name: "Vanguard Brokerage",
    org: { name: "Vanguard" },
    currency: "USD",
    balance: "2600",
    holdings: [
      { id: "h1", symbol: "VTI", shares: "10", market_value: "2000", cost_basis: "1500" },
      { id: "h2", symbol: "VMFXX", shares: "500", market_value: "500" },
    ],
  },
  {
    id: "sf-ira",
    name: "Fidelity IRA",
    org: { name: "Fidelity" },
    currency: "USD",
    balance: "1050",
    holdings: [
      { id: "h3", symbol: "VTI", shares: "5", market_value: "1000", cost_basis: "1000" },
    ],
  },
  {
    id: "sf-roth",
    name: "Schwab Roth",
    balance: "300",
    holdings: [{ id: "h4", symbol: "SCHB", shares: "3", market_value: "300" }],
  },
  // a cash account with no holdings: not offered for mapping
  { id: "sf-checking", name: "Checking", currency: "USD", balance: "999" },
];

interface HostOptions {
  storage?: Record<string, string>;
  secrets?: Record<string, string>;
  /** Every secrets call throws, as when no Secret Service provider is running. */
  keyringDown?: boolean;
  accounts?: SimpleFinAccount[];
  bridgeErrors?: string[];
}

/** A fake Wealthfolio host: in-memory storage/keyring and a scripted Bridge. */
function makeHost(opts: HostOptions = {}) {
  const storage = new Map(Object.entries(opts.storage ?? {}));
  const secrets = new Map(Object.entries(opts.secrets ?? {}));
  const state = { keyringDown: opts.keyringDown ?? false };
  const keyring = () => {
    if (state.keyringDown) throw new Error("org.freedesktop.secrets was not provided");
  };

  const bridge = vi.fn(async (req: NetworkRequest): Promise<NetworkResponse> => {
    if (req.method === "POST" && req.url === CLAIM_URL) {
      return { status: 200, headers: {}, body: ACCESS_URL };
    }
    if (req.method === "GET" && req.url.startsWith(`${BASE_URL}/accounts?`)) {
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          errors: opts.bridgeErrors ?? [],
          accounts: opts.accounts ?? SF_ACCOUNTS,
        }),
      };
    }
    return { status: 404, headers: {}, body: "not found" };
  });

  let route: ComponentType | undefined;
  const disableCallbacks: Array<() => void> = [];
  const sidebarItem = { remove: vi.fn() };

  const api = {
    storage: {
      get: vi.fn(async (k: string) => storage.get(k) ?? null),
      set: vi.fn(async (k: string, v: string) => void storage.set(k, v)),
      delete: vi.fn(async (k: string) => void storage.delete(k)),
    },
    secrets: {
      get: vi.fn(async (k: string) => (keyring(), secrets.get(k) ?? null)),
      set: vi.fn(async (k: string, v: string) => void (keyring(), secrets.set(k, v))),
      delete: vi.fn(async (k: string) => void (keyring(), secrets.delete(k))),
    },
    accounts: {
      getAll: vi.fn(async () => [
        { id: "wf-taxable", name: "Taxable", currency: "USD" },
        { id: "wf-retirement", name: "Retirement", currency: "USD" },
      ]),
    },
    snapshots: {
      save: vi.fn(
        async (
          _accountId: string,
          _positions: unknown[],
          _cash: Record<string, string>,
          _date: string,
        ): Promise<void> => undefined,
      ),
    },
    network: { request: bridge },
    toast: { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() },
  };
  const ctx = {
    ui: { root: document.body },
    sidebar: { addItem: vi.fn(() => sidebarItem) },
    router: { add: vi.fn((r: { component: ComponentType }) => void (route = r.component)) },
    onDisable: vi.fn((cb: () => void) => void disableCallbacks.push(cb)),
    api,
  };

  return {
    ctx: ctx as unknown as AddonContext,
    raw: ctx,
    api,
    storage,
    secrets,
    state,
    bridge,
    sidebarItem,
    disable: () => disableCallbacks.forEach((cb) => cb()),
    /** Enable the addon and render its page as the host would. */
    mount() {
      enable(ctx as unknown as AddonContext);
      const Page = route!;
      return render(<Page />);
    },
  };
}

type Host = ReturnType<typeof makeHost>;

const configured = (extra: HostOptions = {}): HostOptions => ({
  ...extra,
  storage: { bridge_base_url: BASE_URL, ...extra.storage },
  secrets: { bridge_credentials: CREDENTIALS, ...extra.secrets },
});

const accountRequests = (host: Host) =>
  host.bridge.mock.calls.filter(([req]) => req.method === "GET");
const claimRequests = (host: Host) =>
  host.bridge.mock.calls.filter(([req]) => req.method === "POST");

const tokenInput = () => screen.getByPlaceholderText(/paste/i);
const pasteAndSave = (value: string) => {
  fireEvent.change(tokenInput(), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: /^(save|retry save)$/i }));
};
const mapTo = (sfName: string, wfId: string) => {
  const row = screen.getByText(sfName).closest("li")!;
  fireEvent.change(within(row).getByRole("combobox"), { target: { value: wfId } });
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("addon registration", () => {
  it("registers the sidebar item and route, and removes the sidebar item on disable", () => {
    const host = makeHost();
    enable(host.ctx);
    expect(host.raw.sidebar.addItem).toHaveBeenCalledWith(
      expect.objectContaining({ id: "simplefin-sync", route: "/addon/simplefin-sync" }),
    );
    expect(host.raw.router.add).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/addon/simplefin-sync" }),
    );
    host.disable();
    expect(host.sidebarItem.remove).toHaveBeenCalledOnce();
  });
});

describe("initial load", () => {
  it("loads saved accounts through the broker using the named secret, never a raw credential", async () => {
    const host = makeHost(configured({ storage: { account_mapping: '{"sf-ira":"wf-retirement"}' } }));
    host.mount();

    await screen.findByText("Vanguard Brokerage");
    const [[req]] = accountRequests(host);
    expect(req.auth).toEqual({ type: "basic", secretKey: "bridge_credentials" });
    expect(JSON.stringify(req)).not.toContain(CREDENTIALS);
    expect(req.url).not.toContain("s3cret");

    // only accounts with holdings are offered for mapping
    expect(screen.queryByText("Checking")).toBeNull();
    // saved mapping is prepopulated
    const ira = screen.getByText("Fidelity IRA").closest("li")!;
    expect(within(ira).getByRole("combobox")).toHaveProperty("value", "wf-retirement");
    // a silent load doesn't toast
    expect(host.api.toast.success).not.toHaveBeenCalled();
  });

  it("does not contact the Bridge when only one half of the credential is stored", async () => {
    const host = makeHost({ storage: { bridge_base_url: BASE_URL } });
    host.mount();
    await waitFor(() => expect(host.api.secrets.get).toHaveBeenCalled());
    expect(host.bridge).not.toHaveBeenCalled();
    expect(tokenInput().getAttribute("placeholder")).not.toMatch(/saved/);
  });

  it("relays Bridge-reported errors as a warning", async () => {
    const host = makeHost(configured({ bridgeErrors: ["Connection to Vanguard may need attention"] }));
    host.mount();
    await waitFor(() =>
      expect(host.api.toast.warning).toHaveBeenCalledWith(
        "SimpleFIN reported: Connection to Vanguard may need attention",
      ),
    );
  });

  it("migrates pre-3.6 keyring state to base URL + credential + durable mapping", async () => {
    const legacyMapping = '{"sf-taxable":"wf-taxable"}';
    const host = makeHost({
      secrets: { access_url: ACCESS_URL, account_mapping: legacyMapping },
    });
    host.mount();

    await screen.findByText("Vanguard Brokerage");
    expect(host.storage.get("bridge_base_url")).toBe(BASE_URL);
    expect(host.secrets.get("bridge_credentials")).toBe(CREDENTIALS);
    expect(host.storage.get("account_mapping")).toBe(legacyMapping);
    expect(host.secrets.has("access_url")).toBe(false);
    expect(host.secrets.has("account_mapping")).toBe(false);
    const row = screen.getByText("Vanguard Brokerage").closest("li")!;
    expect(within(row).getByRole("combobox")).toHaveProperty("value", "wf-taxable");
  });

  it("keeps the legacy access URL if it can't be migrated", async () => {
    // a self-hosted bridge can't be reached from the sandbox; don't destroy it
    const legacy = "https://u:p@bridge.example.com/simplefin";
    const host = makeHost({ secrets: { access_url: legacy } });
    host.mount();
    await waitFor(() =>
      expect(host.api.logger.error).toHaveBeenCalledWith(
        expect.stringMatching(/Access URL migration failed/),
      ),
    );
    expect(host.secrets.get("access_url")).toBe(legacy);
    expect(host.storage.has("bridge_base_url")).toBe(false);
    expect(host.bridge).not.toHaveBeenCalled();
  });

  it("still loads the mapping and accounts list when the keyring is unavailable", async () => {
    const host = makeHost({
      keyringDown: true,
      storage: { bridge_base_url: BASE_URL, account_mapping: '{"sf-ira":"wf-retirement"}' },
    });
    host.mount();
    await screen.findByText("System keyring unavailable");
    expect(host.api.accounts.getAll).toHaveBeenCalled();
    expect(screen.getByText(/1 mapped/)).toBeTruthy();
    expect(host.bridge).not.toHaveBeenCalled();
  });
});

describe("saving credentials", () => {
  it("claims a setup token, splits it, and stores each half in the right place", async () => {
    const host = makeHost();
    host.mount();
    await waitFor(() => expect(host.api.secrets.get).toHaveBeenCalled());

    pasteAndSave(SETUP_TOKEN);

    await screen.findByText("Vanguard Brokerage");
    expect(claimRequests(host)).toEqual([[{ url: CLAIM_URL, method: "POST" }]]);
    expect(host.storage.get("bridge_base_url")).toBe(BASE_URL);
    expect(host.secrets.get("bridge_credentials")).toBe(CREDENTIALS);
    // the credential must never land in (unencrypted) durable storage
    expect([...host.storage.values()].join()).not.toContain(CREDENTIALS);
    expect([...host.storage.values()].join()).not.toContain("s3cret");
    expect(host.api.toast.success).toHaveBeenCalledWith("Token claimed and saved");
    expect(tokenInput()).toHaveProperty("value", "");
  });

  it("accepts a pasted access URL without claiming anything", async () => {
    const host = makeHost();
    host.mount();
    await waitFor(() => expect(host.api.secrets.get).toHaveBeenCalled());

    pasteAndSave(ACCESS_URL);

    await screen.findByText("Vanguard Brokerage");
    expect(claimRequests(host)).toHaveLength(0);
    expect(host.secrets.get("bridge_credentials")).toBe(CREDENTIALS);
    expect(host.api.toast.success).toHaveBeenCalledWith("SimpleFIN access URL saved");
  });

  it("refuses to spend a one-time token when the keyring is known to be unavailable", async () => {
    const host = makeHost({ keyringDown: true });
    host.mount();
    await screen.findByText("System keyring unavailable");

    pasteAndSave(SETUP_TOKEN);

    expect(host.bridge).not.toHaveBeenCalled();
    expect(screen.getAllByText(/can't reach a system keyring/).length).toBeGreaterThan(1);
  });

  it("explains a host-approval refusal from the broker", async () => {
    const host = makeHost();
    host.bridge.mockRejectedValueOnce(new Error("Network host not approved by user"));
    host.mount();
    await waitFor(() => expect(host.api.secrets.get).toHaveBeenCalled());

    pasteAndSave(SETUP_TOKEN);

    await screen.findByText(/approve the bridge host under “Network hosts”/);
  });

  it("holds a claimed credential when the keyring write fails, without re-spending the token", async () => {
    const host = makeHost();
    host.mount();
    await waitFor(() => expect(host.api.secrets.get).toHaveBeenCalled());

    host.state.keyringDown = true; // e.g. keyring locked after page load
    pasteAndSave(SETUP_TOKEN);

    await screen.findByRole("button", { name: "Retry save" });
    expect(screen.getByText(/already been consumed/)).toBeTruthy();
    expect(claimRequests(host)).toHaveLength(1);
    expect(host.secrets.has("bridge_credentials")).toBe(false);
  });

  // BUG: Retry save can't succeed, for two compounding reasons:
  //  1. The failed write flips `keyring` to "unavailable", and saveAccessUrl's
  //     "don't spend a token" guard then short-circuits every save, including
  //     the retry of an already-claimed credential, which would spend nothing.
  //  2. Even past that guard, the input still holds the consumed token (it is
  //     only cleared on success), and a non-empty input takes precedence over
  //     `pending` — so the retry would try to claim the spent token again.
  // A reload drops `pending`, so the access the token granted is lost. Both
  // must be fixed (skip the guard and prefer `pending` while one is held) for
  // this to pass; flip `it.fails` to `it` then.
  it.fails("lets Retry save persist the held credential once the keyring is back", async () => {
    const host = makeHost();
    host.mount();
    await waitFor(() => expect(host.api.secrets.get).toHaveBeenCalled());

    host.state.keyringDown = true;
    pasteAndSave(SETUP_TOKEN);
    const retry = await screen.findByRole("button", { name: "Retry save" });

    host.state.keyringDown = false;
    fireEvent.click(retry);

    await waitFor(() => expect(host.secrets.get("bridge_credentials")).toBe(CREDENTIALS), {
      timeout: 500,
    });
    expect(claimRequests(host)).toHaveLength(1);
  });
});

describe("refresh", () => {
  it("names the missing half when the credential is saved but the base URL is not", async () => {
    const host = makeHost({ secrets: { bridge_credentials: CREDENTIALS } });
    host.mount();
    await waitFor(() => expect(host.api.secrets.get).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: /refresh from simplefin/i }));

    await screen.findByText(/credential is saved but the Bridge URL is missing/);
    expect(host.bridge).not.toHaveBeenCalled();
  });

  it("asks for a token when nothing is saved", async () => {
    const host = makeHost();
    host.mount();
    await waitFor(() => expect(host.api.secrets.get).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /refresh from simplefin/i }));
    await screen.findByText("Save your SimpleFIN token first.");
  });

  it("shows Bridge HTTP errors", async () => {
    const host = makeHost(configured());
    host.bridge.mockResolvedValueOnce({ status: 403, headers: {}, body: "Forbidden" });
    host.mount();
    await screen.findByText("SimpleFIN request failed (HTTP 403). Forbidden");
  });
});

describe("account mapping", () => {
  it("persists mapping changes to durable storage, and unmapping removes the entry", async () => {
    const host = makeHost(configured());
    host.mount();
    await screen.findByText("Vanguard Brokerage");

    mapTo("Vanguard Brokerage", "wf-taxable");
    mapTo("Fidelity IRA", "wf-retirement");
    await waitFor(() =>
      expect(JSON.parse(host.storage.get("account_mapping")!)).toEqual({
        "sf-taxable": "wf-taxable",
        "sf-ira": "wf-retirement",
      }),
    );

    mapTo("Vanguard Brokerage", "");
    await waitFor(() =>
      expect(JSON.parse(host.storage.get("account_mapping")!)).toEqual({ "sf-ira": "wf-retirement" }),
    );
    // not a secret: must not touch the keyring
    expect(host.api.secrets.set).not.toHaveBeenCalled();
  });
});

describe("sync", () => {
  const syncButton = () => screen.getByRole("button", { name: /sync now/i });

  it("aggregates accounts mapped to the same Wealthfolio account into one dated snapshot", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-06T15:00:00Z"));
    const host = makeHost(
      configured({
        storage: {
          account_mapping: JSON.stringify({
            "sf-taxable": "wf-taxable",
            "sf-ira": "wf-taxable",
            "sf-roth": "wf-retirement",
          }),
        },
      }),
    );
    host.mount();
    await screen.findByText("Vanguard Brokerage");

    fireEvent.click(syncButton());

    await waitFor(() => expect(host.api.toast.success).toHaveBeenCalledWith("Synced 2 account(s)"));
    expect(host.api.snapshots.save).toHaveBeenCalledTimes(2);
    expect(host.api.snapshots.save).toHaveBeenCalledWith(
      "wf-taxable",
      // 10 @150 + 5 @200 → 15 @ 166.67; VMFXX folded into cash
      [{ symbol: "VTI", quantity: "15", currency: "USD", averageCost: "166.67" }],
      // (2600 - 2000) + (1050 - 1000)
      { USD: "650" },
      "2026-11-06",
    );
    expect(host.api.snapshots.save).toHaveBeenCalledWith(
      "wf-retirement",
      [{ symbol: "SCHB", quantity: "3", currency: "USD" }],
      {},
      "2026-11-06",
    );
  });

  it("only syncs mapped accounts and reports partial failure", async () => {
    const host = makeHost(
      configured({
        storage: {
          account_mapping: JSON.stringify({ "sf-taxable": "wf-taxable", "sf-roth": "wf-retirement" }),
        },
      }),
    );
    host.api.snapshots.save.mockImplementation(async (id) => {
      if (id === "wf-retirement") throw new Error("account is not in HOLDINGS mode");
    });
    host.mount();
    await screen.findByText("Vanguard Brokerage");

    fireEvent.click(syncButton());

    await waitFor(() =>
      expect(host.api.toast.warning).toHaveBeenCalledWith("Synced 1, failed 1. See logs."),
    );
    expect(host.api.snapshots.save.mock.calls.map((c) => c[0]).sort()).toEqual([
      "wf-retirement",
      "wf-taxable",
    ]);
    expect(host.api.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("account is not in HOLDINGS mode"),
    );
  });

  it("tells the user when nothing mapped is loaded", async () => {
    // mapping refers to an account the Bridge no longer returns
    const host = makeHost(configured({ storage: { account_mapping: '{"sf-gone":"wf-taxable"}' } }));
    host.mount();
    await screen.findByText("Vanguard Brokerage");

    fireEvent.click(syncButton());

    await waitFor(() =>
      expect(host.api.toast.info).toHaveBeenCalledWith(
        "No mapped accounts to sync. Map an account first.",
      ),
    );
    expect(host.api.snapshots.save).not.toHaveBeenCalled();
  });

  // BUG: the snapshot date is `new Date().toISOString().slice(0, 10)`, i.e. the
  // *UTC* date. West of UTC, an evening sync is written under tomorrow's date
  // (8:30pm in New York is already the next day in UTC), so a sync before and
  // after that hour lands on two different days. The sidecar has the same line.
  it.fails("dates the snapshot with the user's local calendar date", async () => {
    const originalTz = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-07T01:30:00Z")); // 8:30pm Nov 6 in New York
      const host = makeHost(configured({ storage: { account_mapping: '{"sf-roth":"wf-retirement"}' } }));
      host.mount();
      await screen.findByText("Schwab Roth");

      fireEvent.click(syncButton());

      await waitFor(() => expect(host.api.snapshots.save).toHaveBeenCalled());
      expect(host.api.snapshots.save.mock.calls[0][3]).toBe("2026-11-06");
    } finally {
      process.env.TZ = originalTz;
    }
  });

  // Possible gap: loadAccounts drops accounts with no holdings, so an account
  // that has been fully liquidated (holdings: []) disappears from the mapping UI
  // and is skipped by Sync — Wealthfolio keeps showing its last positions
  // instead of an all-cash snapshot. Depends on what the Bridge reports for an
  // emptied brokerage account, so left as a todo rather than asserted.
  it.todo("writes an all-cash snapshot for a mapped account whose holdings went to zero");
});
