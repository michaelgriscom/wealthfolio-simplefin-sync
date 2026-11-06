import { describe, expect, it } from "vitest";
import { aggregateSnapshots } from "./aggregate";
import type { MappedSnapshot } from "./mapping";

const snap = (
  positions: MappedSnapshot["positions"],
  cashBalances: MappedSnapshot["cashBalances"] = {},
): MappedSnapshot => ({ positions, cashBalances });

describe("aggregateSnapshots", () => {
  it("returns an empty snapshot for no input", () => {
    expect(aggregateSnapshots([])).toEqual({ positions: [], cashBalances: {} });
  });

  it("passes a single snapshot through unchanged", () => {
    const one = snap(
      [{ symbol: "VTI", quantity: "10", currency: "USD", averageCost: "200" }],
      { USD: "12.5" },
    );
    expect(aggregateSnapshots([one])).toEqual(one);
  });

  it("merges a ticker across accounts with a quantity-weighted cost", () => {
    const merged = aggregateSnapshots([
      snap([{ symbol: "VTSAX", quantity: "10", currency: "USD", averageCost: "100" }]),
      snap([{ symbol: "vtsax", quantity: "30", currency: "USD", averageCost: "120" }]),
    ]);
    // (10*100 + 30*120) / 40 = 115
    expect(merged.positions).toEqual([
      { symbol: "VTSAX", quantity: "40", currency: "USD", averageCost: "115" },
    ]);
  });

  it("keeps distinct tickers separate, in first-seen order", () => {
    const merged = aggregateSnapshots([
      snap([{ symbol: "VTI", quantity: "1", currency: "USD" }]),
      snap([
        { symbol: "BND", quantity: "2", currency: "USD" },
        { symbol: "VTI", quantity: "3", currency: "USD" },
      ]),
    ]);
    expect(merged.positions).toEqual([
      { symbol: "VTI", quantity: "4", currency: "USD" },
      { symbol: "BND", quantity: "2", currency: "USD" },
    ]);
  });

  it("drops average cost if any lot lacks one, in either order", () => {
    const withCost = { symbol: "VTI", quantity: "10", currency: "USD", averageCost: "100" };
    const noCost = { symbol: "VTI", quantity: "10", currency: "USD" };
    for (const order of [
      [withCost, noCost],
      [noCost, withCost],
    ]) {
      const merged = aggregateSnapshots(order.map((p) => snap([p])));
      expect(merged.positions).toEqual([{ symbol: "VTI", quantity: "20", currency: "USD" }]);
    }
  });

  it("omits average cost when the merged quantity is zero", () => {
    const merged = aggregateSnapshots([
      snap([{ symbol: "X", quantity: "0", currency: "USD", averageCost: "5" }]),
    ]);
    expect(merged.positions[0]).not.toHaveProperty("averageCost");
  });

  it("rounds share sums to 6dp", () => {
    const merged = aggregateSnapshots([
      snap([{ symbol: "FXAIX", quantity: "0.1", currency: "USD" }]),
      snap([{ symbol: "FXAIX", quantity: "0.2", currency: "USD" }]),
      snap([{ symbol: "FXAIX", quantity: "1.0000004", currency: "USD" }]),
    ]);
    expect(merged.positions[0].quantity).toBe("1.3");
  });

  it("treats unparseable quantities as zero", () => {
    const merged = aggregateSnapshots([
      snap([{ symbol: "VTI", quantity: "", currency: "USD" }]),
      snap([{ symbol: "VTI", quantity: "5", currency: "USD" }]),
    ]);
    expect(merged.positions[0].quantity).toBe("5");
  });

  it("sums cash per currency, rounds to cents, and drops currencies that net to zero", () => {
    const merged = aggregateSnapshots([
      snap([], { USD: "0.1", CAD: "5" }),
      snap([], { USD: "0.2", CAD: "-5" }),
      snap([], { EUR: "garbage" }),
    ]);
    expect(merged.cashBalances).toEqual({ USD: "0.3" });
  });
});
