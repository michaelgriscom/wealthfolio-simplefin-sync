/**
 * Minimal SimpleFIN Bridge client.
 *
 * The SimpleFIN protocol only documents balances + transactions, but the Bridge
 * also returns an undocumented `holdings` array for brokerage accounts, which is
 * what this addon relies on. See https://www.simplefin.org/protocol.html
 *
 * Since Wealthfolio 3.6 addons run in a sandboxed, opaque-origin iframe where
 * `fetch()` to external hosts is blocked by CSP. Every request here goes through
 * the host's network broker (`ctx.api.network.request`), which only permits the
 * hosts declared under `network.allowedHosts` in manifest.json.
 */

import type { NetworkRequest, NetworkResponse } from "@wealthfolio/addon-sdk";

/** The brokered request function, i.e. `ctx.api.network.request`. */
export type NetworkRequestFn = (request: NetworkRequest) => Promise<NetworkResponse>;

/** Bridge hosts this addon may reach. Must stay in sync with `network.allowedHosts`. */
export const ALLOWED_BRIDGE_HOSTS = ["bridge.simplefin.org", "beta-bridge.simplefin.org"];

/** A single investment position as returned by the SimpleFIN Bridge. */
export interface SimpleFinHolding {
  id: string;
  created?: number;
  currency?: string;
  cost_basis?: string;
  description?: string;
  market_value?: string;
  purchase_price?: string;
  shares?: string;
  symbol: string;
}

/** A SimpleFIN account (cash or investment). `holdings` is present for brokerages. */
export interface SimpleFinAccount {
  org?: { name?: string; domain?: string };
  id: string;
  name: string;
  /** ISO currency code, a crypto URL, or empty (brokerages often omit it). */
  currency?: string;
  balance: string;
  "available-balance"?: string;
  "balance-date"?: number;
  holdings?: SimpleFinHolding[];
}

export interface SimpleFinResponse {
  errors: string[];
  accounts: SimpleFinAccount[];
}

/**
 * A SimpleFIN access URL split into the parts this addon stores separately: the
 * credential-free base URL and the base64 `user:pass` the Bridge expects as HTTP
 * Basic auth. Keeping them apart lets the base URL live in durable storage while
 * the credential goes to the system keyring.
 */
export interface SplitAccessUrl {
  baseUrl: string;
  /** base64 of `user:pass`, i.e. the value after `Basic ` in the auth header. */
  credentials: string;
}

/** Thrown when a URL points somewhere the manifest's allowlist doesn't cover. */
export class DisallowedHostError extends Error {
  constructor(host: string) {
    super(
      `This addon can only reach ${ALLOWED_BRIDGE_HOSTS.join(" and ")}, but the ` +
        `URL points at ${host}. Wealthfolio's addon sandbox only allows hosts ` +
        `declared in the addon manifest, so self-hosted SimpleFIN bridges are ` +
        `not supported yet.`,
    );
    this.name = "DisallowedHostError";
  }
}

/**
 * Turn a brokered-request failure into something the user can act on.
 *
 * The host refuses requests to hosts the user hasn't approved, and the approval
 * lives in the addon's permissions dialog rather than anywhere near the error.
 * Left unexplained, "not approved" is a dead end.
 */
export function explainRequestError(error: unknown): string {
  const message = (error as Error)?.message ?? String(error);
  if (/not approved/i.test(message)) {
    return (
      "Wealthfolio hasn't approved network access to the SimpleFIN Bridge yet. " +
      "Open Settings → Addons, open the SimpleFIN Sync permissions, then approve " +
      "the bridge host under “Network hosts” and save."
    );
  }
  return message;
}

/** Reject any URL the host broker would refuse, so the error is actionable. */
function assertAllowedHost(url: string): URL {
  const parsed = new URL(url);
  if (!ALLOWED_BRIDGE_HOSTS.includes(parsed.hostname)) {
    throw new DisallowedHostError(parsed.hostname);
  }
  return parsed;
}

/**
 * Split a SimpleFIN access URL (`https://user:pass@host/path`) into a base URL
 * and base64-encoded Basic credentials.
 */
export function splitAccessUrl(accessUrl: string): SplitAccessUrl {
  const u = assertAllowedHost(accessUrl.trim());
  const user = decodeURIComponent(u.username);
  const pass = decodeURIComponent(u.password);
  u.username = "";
  u.password = "";
  let base = u.toString();
  if (base.endsWith("/")) base = base.slice(0, -1);
  return { baseUrl: base, credentials: btoa(`${user}:${pass}`) };
}

/** True if the input is already an access URL (vs. a base64 setup token). */
export function isAccessUrl(input: string): boolean {
  return /^https?:\/\//i.test(input.trim());
}

/** Turn a brokered response into an error when the Bridge rejected the request. */
function assertOk(res: NetworkResponse, what: string, hint?: string): void {
  if (res.status < 200 || res.status >= 300) {
    throw new Error(
      [`${what} (HTTP ${res.status}).`, hint, res.body?.trim()].filter(Boolean).join(" "),
    );
  }
}

/**
 * Exchange a one-time SimpleFIN setup token (base64 of a claim URL) for a
 * long-lived access URL. The token is consumed on success.
 */
export async function claimToken(token: string, request: NetworkRequestFn): Promise<string> {
  let claimUrl: string;
  try {
    claimUrl = atob(token.trim());
  } catch {
    throw new Error("That doesn't look like a valid SimpleFIN token (not base64).");
  }
  if (!/^https?:\/\//i.test(claimUrl)) {
    throw new Error("Decoded token is not a claim URL.");
  }
  assertAllowedHost(claimUrl);
  const res = await request({ url: claimUrl, method: "POST" });
  assertOk(res, "SimpleFIN claim failed", "The token may already have been used.");
  const accessUrl = res.body.trim();
  if (!isAccessUrl(accessUrl)) {
    throw new Error("SimpleFIN claim did not return an access URL.");
  }
  return accessUrl;
}

/** Accept either a setup token or an access URL and return an access URL. */
export async function resolveAccessUrl(
  input: string,
  request: NetworkRequestFn,
): Promise<string> {
  const value = input.trim();
  return isAccessUrl(value) ? value : claimToken(value, request);
}

/**
 * Fetch all accounts (with holdings) from the SimpleFIN Bridge.
 *
 * The credential is named, never passed: the host broker resolves `secretKey`
 * out of the addon's own secret store and injects the `Authorization` header
 * itself, so the credential never enters addon code. This is the *only* way an
 * addon can authenticate — the broker rejects an addon-supplied `Authorization`
 * header ("must use request.auth.secretKey") and rejects credentials embedded in
 * the URL, so there is no path around a secret store that isn't working.
 *
 * `start-date` is pinned to "now" so the response carries current holdings
 * without dragging in the full transaction history.
 */
export async function fetchAccounts(
  baseUrl: string,
  secretKey: string,
  request: NetworkRequestFn,
): Promise<SimpleFinResponse> {
  assertAllowedHost(baseUrl);
  const startDate = Math.floor(Date.now() / 1000);
  const res = await request({
    url: `${baseUrl}/accounts?start-date=${startDate}`,
    method: "GET",
    auth: { type: "basic", secretKey },
  });
  assertOk(res, "SimpleFIN request failed");
  try {
    return JSON.parse(res.body) as SimpleFinResponse;
  } catch {
    throw new Error("SimpleFIN returned a response that wasn't valid JSON.");
  }
}
