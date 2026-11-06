import { describe, expect, it } from "vitest";
import { mapAccountToSnapshot, normalizeCurrency } from "./mapping";
import type { SimpleFinAccount, SimpleFinHolding } from "./simplefin";

function holding(overrides: Partial<SimpleFinHolding> & { symbol: string }): SimpleFinHolding {
  return { id: `h-${overrides.symbol}`, ...overrides };
}

function account(overrides: Partial<SimpleFinAccount> = {}): SimpleFinAccount {
  return { id: "acct-1", name: "Brokerage", balance: "0", ...overrides };
}

describe("normalizeCurrency", () => {
  it("upper-cases and trims ISO codes", () => {
    expect(normalizeCurrency(" cad ")).toBe("CAD");
  });

  it("falls back for missing, empty, or non-ISO values", () => {
    expect(normalizeCurrency(undefined)).toBe("USD");
    expect(normalizeCurrency("")).toBe("USD");
    // SimpleFIN allows a URL for custom/crypto currencies
    expect(normalizeCurrency("https://www.example.com/flight-miles.htm")).toBe("USD");
    expect(normalizeCurrency("US$")).toBe("USD");
    expect(normalizeCurrency("USDT")).toBe("USD");
  });

  it("uses the supplied fallback", () => {
    expect(normalizeCurrency(undefined, "EUR")).toBe("EUR");
  });
});

describe("mapAccountToSnapshot", () => {
  it("maps securities to positions with per-share average cost from total cost basis", () => {
    const snap = mapAccountToSnapshot(
      account({
        currency: "USD",
        balance: "15000.00",
        holdings: [
          holding({ symbol: "VTI", shares: "40", market_value: "10000", cost_basis: "8000" }),
          holding({ symbol: "VXUS", shares: "3", market_value: "5000", cost_basis: "100" }),
        ],
      }),
    );
    expect(snap.positions).toEqual([
      { symbol: "VTI", quantity: "40", currency: "USD", averageCost: "200" },
      // 100 / 3 rounded to cents
      { symbol: "VXUS", quantity: "3", currency: "USD", averageCost: "33.33" },
    ]);
    // balance fully explained by securities → no cash
    expect(snap.cashBalances).toEqual({});
  });

  it("derives cash as balance minus non-cash market value (covers uninvested sweep)", () => {
    const snap = mapAccountToSnapshot(
      account({
        currency: "USD",
        balance: "10250.55",
        holdings: [holding({ symbol: "VTI", shares: "40", market_value: "10000" })],
      }),
    );
    expect(snap.cashBalances).toEqual({ USD: "250.55" });
  });

  it("folds money-market funds into cash instead of tracking them as positions", () => {
    const snap = mapAccountToSnapshot(
      account({
        currency: "USD",
        balance: "11500",
        holdings: [
          holding({ symbol: "VTI", shares: "40", market_value: "10000" }),
          // case-insensitive match against the cash list
          holding({ symbol: "vmfxx", shares: "1500", market_value: "1500", cost_basis: "1500" }),
        ],
      }),
    );
    expect(snap.positions.map((p) => p.symbol)).toEqual(["VTI"]);
    expect(snap.cashBalances).toEqual({ USD: "1500" });
  });

  it("honours a custom cash symbol list", () => {
    const snap = mapAccountToSnapshot(
      account({
        balance: "300",
        holdings: [
          holding({ symbol: "VMFXX", shares: "100", market_value: "100" }),
          holding({ symbol: "MYCASH", shares: "200", market_value: "200" }),
        ],
      }),
      ["mycash"],
    );
    // VMFXX is no longer cash, so it is a position and is subtracted from balance
    expect(snap.positions.map((p) => p.symbol)).toEqual(["VMFXX"]);
    expect(snap.cashBalances).toEqual({ USD: "200" });
  });

  it("avoids float drift when subtracting market values", () => {
    const snap = mapAccountToSnapshot(
      account({
        balance: "0.3",
        holdings: [
          holding({ symbol: "A", shares: "1", market_value: "0.1" }),
          holding({ symbol: "B", shares: "1", market_value: "0.1" }),
        ],
      }),
    );
    // 0.3 - 0.1 - 0.1 = 0.09999999999999998 in IEEE754
    expect(snap.cashBalances).toEqual({ USD: "0.1" });
  });

  it("drops non-positive cash (e.g. margin debit) rather than writing a negative balance", () => {
    const snap = mapAccountToSnapshot(
      account({
        balance: "9000",
        holdings: [holding({ symbol: "VTI", shares: "40", market_value: "10000" })],
      }),
    );
    expect(snap.cashBalances).toEqual({});
  });

  it("uses the account currency when the account omits/garbles it, else defaults to USD", () => {
    const cad = mapAccountToSnapshot(
      account({
        currency: "cad",
        balance: "150",
        holdings: [holding({ symbol: "XEQT", shares: "4", market_value: "100" })],
      }),
    );
    expect(cad.positions[0].currency).toBe("CAD");
    expect(cad.cashBalances).toEqual({ CAD: "50" });

    // brokerages often send an empty currency
    const blank = mapAccountToSnapshot(
      account({ currency: "", balance: "5", holdings: [] }),
    );
    expect(blank.cashBalances).toEqual({ USD: "5" });
  });

  it("prefers a holding's own currency over the account currency", () => {
    const snap = mapAccountToSnapshot(
      account({
        currency: "USD",
        balance: "100",
        holdings: [holding({ symbol: "SHOP.TO", shares: "1", market_value: "100", currency: "CAD" })],
      }),
    );
    expect(snap.positions[0].currency).toBe("CAD");
  });

  it("omits average cost when it can't be derived", () => {
    const snap = mapAccountToSnapshot(
      account({
        balance: "0",
        holdings: [
          holding({ symbol: "NOCOST", shares: "10" }),
          holding({ symbol: "ZEROCOST", shares: "10", cost_basis: "0" }),
          holding({ symbol: "BADCOST", shares: "10", cost_basis: "n/a" }),
          holding({ symbol: "NOSHARES", shares: "0", cost_basis: "500" }),
        ],
      }),
    );
    for (const p of snap.positions) expect(p).not.toHaveProperty("averageCost");
  });

  it("skips holdings without a symbol and trims symbols", () => {
    const snap = mapAccountToSnapshot(
      account({
        balance: "0",
        holdings: [
          holding({ symbol: "  VTI  ", shares: "1" }),
          holding({ symbol: "", shares: "5" }),
          // the Bridge type says symbol is required, but don't trust it
          { id: "x", shares: "5" } as unknown as SimpleFinHolding,
        ],
      }),
    );
    expect(snap.positions.map((p) => p.symbol)).toEqual(["VTI"]);
  });

  it("treats a symbol-less holding's market value as cash (current behaviour)", () => {
    // Symbol-less holdings (some CDs/bonds) are skipped *before* their market
    // value is subtracted, so their value lands in the cash balance. This pins
    // the behaviour so a change to it is deliberate.
    const snap = mapAccountToSnapshot(
      account({
        balance: "1000",
        holdings: [holding({ symbol: "", shares: "1", market_value: "1000" })],
      }),
    );
    expect(snap.positions).toEqual([]);
    expect(snap.cashBalances).toEqual({ USD: "1000" });
  });

  it("defaults a missing share count to 0 and tolerates a non-numeric balance", () => {
    const snap = mapAccountToSnapshot(
      account({ balance: "", holdings: [holding({ symbol: "VTI", market_value: "abc" })] }),
    );
    expect(snap.positions).toEqual([{ symbol: "VTI", quantity: "0", currency: "USD" }]);
    expect(snap.cashBalances).toEqual({});
  });

  it("handles accounts without a holdings array", () => {
    expect(mapAccountToSnapshot(account({ balance: "42.10" }))).toEqual({
      positions: [],
      cashBalances: { USD: "42.1" },
    });
  });
});
