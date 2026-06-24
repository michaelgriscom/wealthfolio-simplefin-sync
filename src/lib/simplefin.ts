/**
 * Minimal SimpleFIN Bridge client.
 *
 * The SimpleFIN protocol only documents balances + transactions, but the Bridge
 * also returns an undocumented `holdings` array for brokerage accounts, which is
 * what this addon relies on. See https://www.simplefin.org/protocol.html
 */

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
 * Split a SimpleFIN access URL (`https://user:pass@host/path`) into a base URL
 * and a Basic auth header. Browsers strip credentials from `fetch()` URLs, so
 * the credentials must be sent explicitly via the Authorization header (the
 * Bridge's CORS policy allows it).
 */
export function parseAccessUrl(accessUrl: string): { baseUrl: string; authHeader: string } {
  const u = new URL(accessUrl.trim());
  const user = decodeURIComponent(u.username);
  const pass = decodeURIComponent(u.password);
  u.username = "";
  u.password = "";
  let base = u.toString();
  if (base.endsWith("/")) base = base.slice(0, -1);
  return { baseUrl: base, authHeader: `Basic ${btoa(`${user}:${pass}`)}` };
}

/**
 * Fetch all accounts (with holdings) from the SimpleFIN Bridge.
 *
 * `start-date` is pinned to "now" so the response carries current holdings
 * without dragging in the full transaction history.
 */
export async function fetchAccounts(accessUrl: string): Promise<SimpleFinResponse> {
  const { baseUrl, authHeader } = parseAccessUrl(accessUrl);
  const startDate = Math.floor(Date.now() / 1000);
  const res = await fetch(`${baseUrl}/accounts?start-date=${startDate}`, {
    headers: { Authorization: authHeader },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`SimpleFIN request failed (HTTP ${res.status}). ${body}`.trim());
  }
  return (await res.json()) as SimpleFinResponse;
}
