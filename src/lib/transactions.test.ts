import { describe, expect, it } from "vitest";
import type { SimpleFinAccount, SimpleFinTransaction } from "./simplefin";
import {
  classify,
  describe as describeTxn,
  isDuplicateError,
  pairTransfers,
  syncModeFor,
  toActivity,
  type SyncActivityCreate,
} from "./transactions";

const txn = (amount: string, description: string, extra: Partial<SimpleFinTransaction> = {}) => ({
  id: "t1",
  posted: Date.UTC(2026, 10, 2) / 1000,
  amount,
  description,
  ...extra,
});

describe("syncModeFor", () => {
  it("syncs cards and transaction-tracked cash accounts as transactions", () => {
    expect(syncModeFor({ id: "a", name: "", currency: "USD", accountType: "CREDIT_CARD" })).toBe("transactions");
    expect(
      syncModeFor({ id: "a", name: "", currency: "USD", accountType: "CASH", trackingMode: "TRANSACTIONS" }),
    ).toBe("transactions");
  });

  it("keeps everything else on holdings snapshots", () => {
    expect(
      syncModeFor({ id: "a", name: "", currency: "USD", accountType: "CASH", trackingMode: "HOLDINGS" }),
    ).toBe("holdings");
    expect(syncModeFor({ id: "a", name: "", currency: "USD", accountType: "SECURITIES" })).toBe("holdings");
    expect(syncModeFor({ id: "a", name: "", currency: "USD" })).toBe("holdings");
    expect(syncModeFor(undefined)).toBe("holdings");
  });
});

describe("classify", () => {
  it.each([
    ["-23.40", "TRADER JOE'S #552", "WITHDRAWAL"],
    ["-18.22", "PURCHASE INTEREST CHARGE", "INTEREST"],
    ["-95.00", "ANNUAL MEMBERSHIP FEE", "FEE"],
    ["-4.50", "STARBUCKS COFFEE", "WITHDRAWAL"], // "coffee" is not a fee
    ["500.00", "AUTOPAY PAYMENT - THANK YOU", "TRANSFER_IN"],
    ["250.00", "Payment Thank You-Mobile", "TRANSFER_IN"],
    ["19.99", "AMAZON.COM REFUND", "CREDIT"],
  ])("card %s %s → %s", (amount, description, expected) => {
    expect(classify(txn(amount, description), "CREDIT_CARD")).toBe(expected);
  });

  it.each([
    ["3000.00", "PAYROLL ACME CORP", "DEPOSIT"],
    ["1.23", "INTEREST PAYMENT", "INTEREST"],
    ["-80.00", "CITY WATER UTILITY", "WITHDRAWAL"],
    ["-12.00", "MONTHLY SERVICE FEE", "FEE"],
    ["-500.00", "CHASE CREDIT CRD AUTOPAY", "TRANSFER_OUT"],
    ["-300.00", "AMEX EPAYMENT ACH PMT", "WITHDRAWAL"], // no card wording: left as spending
  ])("cash %s %s → %s", (amount, description, expected) => {
    expect(classify(txn(amount, description), "CASH")).toBe(expected);
  });

  it("skips zero and unparseable amounts", () => {
    expect(classify(txn("0.00", "AUTH HOLD"), "CREDIT_CARD")).toBeNull();
    expect(classify(txn("", "?"), "CASH")).toBeNull();
  });
});

describe("describe", () => {
  it("drops a payee already contained in the description", () => {
    expect(describeTxn(txn("-1", "SQ *BLUE BOTTLE OAKLAND", { payee: "Blue Bottle" }))).toBe(
      "SQ *BLUE BOTTLE OAKLAND",
    );
  });
  it("joins a payee that adds information", () => {
    expect(describeTxn(txn("-1", "POS 1234", { payee: "Hardware Store" }))).toBe("Hardware Store — POS 1234");
  });
});

describe("toActivity", () => {
  const sf: SimpleFinAccount = { id: "sf-card", name: "Card", currency: "USD", balance: "-1" };
  const wf = { id: "wf-card", name: "Card", currency: "USD", accountType: "CREDIT_CARD" };

  it("maps a charge with positive amount, source ids and an idempotency key", () => {
    expect(toActivity(txn("-45.10", "COFFEE", { id: "abc", memo: "note" }), sf, wf)).toEqual({
      accountId: "wf-card",
      activityType: "WITHDRAWAL",
      activityDate: "2026-11-02T00:00:00.000Z",
      amount: "45.1",
      currency: "USD",
      comment: "COFFEE",
      metadata: {
        simplefin: { accountId: "sf-card", transactionId: "abc", posted: Date.UTC(2026, 10, 2) / 1000, memo: "note" },
      },
      sourceSystem: "SIMPLEFIN",
      sourceRecordId: "abc",
      idempotencyKey: "simplefin:sf-card:abc",
    });
  });

  it("prefers transacted_at over posted for the date", () => {
    const a = toActivity(txn("-1", "X", { transacted_at: Date.UTC(2026, 9, 30) / 1000 }), sf, wf);
    expect(a?.activityDate).toBe("2026-10-30T00:00:00.000Z");
  });

  it("skips pending transactions", () => {
    expect(toActivity(txn("-1", "X", { pending: true }), sf, wf)).toBeNull();
    expect(toActivity(txn("-1", "X", { posted: 0 }), sf, wf)).toBeNull();
  });

  it("falls back to the Wealthfolio account currency", () => {
    const a = toActivity(txn("-1", "X"), { ...sf, currency: "" }, { ...wf, currency: "CAD" });
    expect(a?.currency).toBe("CAD");
  });
});

describe("pairTransfers", () => {
  const leg = (
    key: string,
    accountId: string,
    activityType: string,
    day: number,
    amount = "500",
  ): SyncActivityCreate => ({
    accountId,
    activityType,
    activityDate: new Date(Date.UTC(2026, 10, day)).toISOString(),
    amount,
    currency: "USD",
    sourceSystem: "SIMPLEFIN",
    sourceRecordId: key,
    idempotencyKey: key,
  });

  it("links a bank payment and a card payment of the same amount", () => {
    const out = leg("k1", "bank", "TRANSFER_OUT", 2);
    const inn = leg("c1", "card", "TRANSFER_IN", 3);
    pairTransfers([out, inn]);
    expect(out.sourceGroupId).toBe("simplefin-transfer:c1|k1");
    expect(inn.sourceGroupId).toBe(out.sourceGroupId);
  });

  it("does not link different amounts, the same account, or legs too far apart", () => {
    const legs = [
      leg("k1", "bank", "TRANSFER_OUT", 2),
      leg("c1", "card", "TRANSFER_IN", 2, "499"),
      leg("k2", "bank", "TRANSFER_IN", 2),
      leg("c2", "card", "TRANSFER_IN", 12),
    ];
    pairTransfers(legs);
    expect(legs.every((l) => !l.sourceGroupId)).toBe(true);
  });

  it("pairs each leg once, closest dates first", () => {
    const out = leg("k1", "bank", "TRANSFER_OUT", 5);
    const far = leg("c1", "card", "TRANSFER_IN", 1);
    const near = leg("c2", "card", "TRANSFER_IN", 6);
    pairTransfers([out, far, near]);
    expect(near.sourceGroupId).toBe(out.sourceGroupId);
    expect(far.sourceGroupId).toBeUndefined();
  });
});

describe("isDuplicateError", () => {
  it("recognizes the host's duplicate message", () => {
    expect(isDuplicateError(new Error("Duplicate activity detected. A matching activity already exists."))).toBe(true);
    expect(isDuplicateError(new Error("Account not found"))).toBe(false);
  });
});
