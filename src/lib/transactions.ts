import type { ActivityCreate } from "@wealthfolio/addon-sdk";
import { normalizeCurrency } from "./mapping";
import type { SimpleFinAccount, SimpleFinTransaction } from "./simplefin";

/**
 * Transaction sync for cash and credit card accounts.
 *
 * Brokerage accounts stay on holdings snapshots: SimpleFIN brokerage
 * transactions are free text with no symbol, quantity or price, so they can't
 * become trustworthy BUY/SELL activities. Card and bank transactions carry
 * everything Wealthfolio needs (date, signed amount, payee), so they map
 * straight to cash activities.
 */

/** Wealthfolio account fields that decide how a mapped account is synced. */
export interface WfAccountInfo {
  id: string;
  name: string;
  currency: string;
  accountType?: string;
  trackingMode?: string;
}

export type SyncMode = "holdings" | "transactions";

/**
 * Credit cards are always transaction-synced (a card holds no positions).
 * Cash accounts are transaction-synced when they track transactions; a cash
 * account in HOLDINGS mode keeps getting balance snapshots as before.
 */
export function syncModeFor(account: WfAccountInfo | undefined): SyncMode {
  if (account?.accountType === "CREDIT_CARD") return "transactions";
  if (account?.accountType === "CASH" && account.trackingMode === "TRANSACTIONS") {
    return "transactions";
  }
  return "holdings";
}

/** `sourceSystem` stamped on every activity this addon creates. */
export const SOURCE_SYSTEM = "SIMPLEFIN";

/**
 * Fields the host accepts on create but SDK 3.6's `ActivityCreate` type omits.
 * The backend uses `sourceRecordId` in its duplicate key and honours an
 * explicit `idempotencyKey`, which is what makes re-syncing the same window
 * safe and keeps two identical same-day charges from colliding.
 */
export type SyncActivityCreate = ActivityCreate & {
  sourceSystem: string;
  sourceRecordId: string;
  idempotencyKey: string;
};

/** A payment received by a card, e.g. "AUTOPAY PAYMENT - THANK YOU", "DIRECTPAY FULL BALANCE". */
const CARD_PAYMENT =
  /\b(payment|autopay|auto[\s-]?pay|directpay|e-?pay(ment)?|pymt|pmt|thank\s*you)\b|internet\s*(payment|transfer)/i;
/**
 * A bank-side payment to a card, e.g. "CHASE CREDIT CRD AUTOPAY",
 * "CAPITAL ONE CRCARDPMT", "CITI CARD ONLINE PAYMENT". Only a hint: legs are
 * paired by amount (see pairTransfers), so a missed descriptor still pairs.
 * Bare "autopay" is not enough; utilities and insurers use it too.
 */
const PAYMENT_TO_CARD =
  /crcardpmt|\bcredit\s*(card|crd)\b|\b(card|crd)\b.{0,20}\b(payment|pymt|pmt|e-?pay(ment)?|autopay)\b|\b(amex|american\s*express|discover|capital\s*one|synchrony|barclay(card|s)?|applecard)\b.{0,20}\b(payment|pymt|pmt|e-?pay(ment)?)\b/i;
const INTEREST = /\b(interest|finance\s*charge)\b/i;
const FEE = /\b(fee|service\s*charge)\b/i;

function signedAmount(txn: SimpleFinTransaction): number {
  const n = Number.parseFloat(txn.amount);
  return Number.isFinite(n) ? n : 0;
}

/** The text used to classify a transaction and shown as its comment. */
export function describe(txn: SimpleFinTransaction): string {
  const parts = [txn.payee, txn.description].map((s) => s?.trim()).filter(Boolean) as string[];
  // Payee is often a cleaned-up copy of the description; don't repeat it.
  if (parts.length === 2 && parts[1].toUpperCase().includes(parts[0].toUpperCase())) {
    return parts[1];
  }
  return parts.join(" — ");
}

/**
 * The Wealthfolio activity type for a transaction, or null to skip it.
 *
 * SimpleFIN amounts are signed from the account holder's side: negative is
 * money out of a bank account, or a new charge on a card.
 *
 * Card:  charge → WITHDRAWAL (FEE / INTEREST when the text says so),
 *        payment → TRANSFER_IN, refund or other credit → CREDIT.
 * Cash:  money in → DEPOSIT (INTEREST when the text says so),
 *        money out → WITHDRAWAL (FEE when the text says so),
 *        a payment to a card → TRANSFER_OUT, so it can pair with the card side.
 */
export function classify(txn: SimpleFinTransaction, accountType: string | undefined): string | null {
  const amount = signedAmount(txn);
  if (amount === 0) return null;
  const text = describe(txn);

  if (accountType === "CREDIT_CARD") {
    if (amount < 0) {
      if (INTEREST.test(text)) return "INTEREST";
      if (FEE.test(text)) return "FEE";
      return "WITHDRAWAL";
    }
    return CARD_PAYMENT.test(text) ? "TRANSFER_IN" : "CREDIT";
  }

  if (amount > 0) return INTEREST.test(text) ? "INTEREST" : "DEPOSIT";
  if (PAYMENT_TO_CARD.test(text)) return "TRANSFER_OUT";
  return FEE.test(text) ? "FEE" : "WITHDRAWAL";
}

/**
 * Unix seconds → calendar date (YYYY-MM-DD, by UTC). Banks report dates, not
 * times; a bare date lets Wealthfolio place it on that day in the user's own
 * timezone instead of shifting midnight-UTC back a day for US users.
 */
function calendarDate(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

/**
 * Stable per-transaction key. SimpleFIN ids are only unique within an account,
 * and the key includes the Wealthfolio account so remapping a SimpleFIN
 * account writes its transactions to the new account instead of treating them
 * as already synced.
 */
export function idempotencyKey(wfAccountId: string, sfAccountId: string, txnId: string): string {
  return `simplefin:${wfAccountId}:${sfAccountId}:${txnId}`;
}

/**
 * Convert one SimpleFIN transaction into a Wealthfolio activity, or null when
 * it shouldn't be recorded (pending, zero amount).
 *
 * Pending transactions are skipped rather than synced and later corrected:
 * their ids, amounts and descriptions can change when they post, and a
 * pending row that never posts would linger forever.
 */
export function toActivity(
  txn: SimpleFinTransaction,
  sfAccount: SimpleFinAccount,
  wfAccount: WfAccountInfo,
): SyncActivityCreate | null {
  if (txn.pending) return null;
  if (!txn.posted) return null;
  const activityType = classify(txn, wfAccount.accountType);
  if (!activityType) return null;

  const currency = normalizeCurrency(sfAccount.currency, wfAccount.currency || "USD");
  const comment = describe(txn) || undefined;
  return {
    accountId: wfAccount.id,
    activityType,
    activityDate: calendarDate(txn.transacted_at ?? txn.posted),
    amount: String(Math.abs(signedAmount(txn))),
    currency,
    comment,
    metadata: {
      simplefin: {
        accountId: sfAccount.id,
        transactionId: txn.id,
        posted: txn.posted,
        ...(txn.memo ? { memo: txn.memo } : {}),
      },
    },
    sourceSystem: SOURCE_SYSTEM,
    sourceRecordId: txn.id,
    idempotencyKey: idempotencyKey(wfAccount.id, sfAccount.id, txn.id),
  };
}

/** Max days between the two legs of a card payment (ACH can take a few). */
const TRANSFER_WINDOW_DAYS = 5;

/** The two legs of one card payment, linked by a shared `sourceGroupId`. */
export interface TransferPair {
  out: SyncActivityCreate;
  in: SyncActivityCreate;
}

/**
 * Link the bank-side and card-side legs of card payments, so Wealthfolio
 * treats each as one internal transfer instead of an expense on the bank side.
 *
 * Legs pair by amount, currency and date (within a few days), not wording:
 * bank descriptors for card payments vary too much to recognize reliably. The
 * out leg is a cash-account outflow, the in leg a card inflow. At least one of
 * them must already look like a transfer (TRANSFER_OUT / TRANSFER_IN), so two
 * coincidentally equal amounts (a purchase and a refund) don't pair. A paired
 * WITHDRAWAL becomes TRANSFER_OUT and a paired CREDIT becomes TRANSFER_IN.
 * Each leg pairs once, most transfer-like and closest in date first.
 *
 * The group id comes from both legs' keys, so it is the same on every sync.
 * Groups are only assigned here; whether they are written is up to the caller,
 * which must not leave one leg grouped when the other already exists.
 */
export function pairTransfers(
  activities: SyncActivityCreate[],
  isCard: (accountId: string) => boolean,
): TransferPair[] {
  const outs = activities.filter(
    (a) =>
      !isCard(a.accountId) &&
      !a.sourceGroupId &&
      (a.activityType === "TRANSFER_OUT" || a.activityType === "WITHDRAWAL"),
  );
  const ins = activities.filter(
    (a) =>
      isCard(a.accountId) &&
      !a.sourceGroupId &&
      (a.activityType === "TRANSFER_IN" || a.activityType === "CREDIT"),
  );
  const day = (a: SyncActivityCreate) => new Date(a.activityDate as string).getTime() / 86_400_000;
  const candidates: Array<TransferPair & { penalty: number; gap: number }> = [];
  for (const out of outs) {
    for (const inn of ins) {
      if (inn.amount !== out.amount || inn.currency !== out.currency) continue;
      const penalty =
        (out.activityType === "TRANSFER_OUT" ? 0 : 1) + (inn.activityType === "TRANSFER_IN" ? 0 : 1);
      if (penalty > 1) continue;
      const gap = Math.abs(day(inn) - day(out));
      if (gap <= TRANSFER_WINDOW_DAYS) candidates.push({ out, in: inn, penalty, gap });
    }
  }
  candidates.sort((a, b) => a.penalty - b.penalty || a.gap - b.gap);
  const pairs: TransferPair[] = [];
  for (const c of candidates) {
    if (c.out.sourceGroupId || c.in.sourceGroupId) continue;
    const group = `simplefin-transfer:${[c.out.idempotencyKey, c.in.idempotencyKey].sort().join("|")}`;
    c.out.activityType = "TRANSFER_OUT";
    c.in.activityType = "TRANSFER_IN";
    c.out.sourceGroupId = group;
    c.in.sourceGroupId = group;
    pairs.push({ out: c.out, in: c.in });
  }
  return pairs;
}

/** True when the host rejected a create because the activity already exists. */
export function isDuplicateError(error: unknown): boolean {
  return /duplicate activity detected/i.test((error as Error)?.message ?? String(error));
}
