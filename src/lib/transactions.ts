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

const CARD_PAYMENT = /\b(payment|autopay|auto[\s-]?pay|pymt|pmt|thank\s*you)\b/i;
/** A cash-side transfer to a card issuer, e.g. "CHASE CREDIT CRD AUTOPAY". */
const PAYMENT_TO_CARD =
  /\b(credit\s*(card|crd)|card\s*(payment|pymt|pmt)|crd\s*(epay|pymt|pmt)|autopay|auto[\s-]?pay)\b/i;
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

/** Unix seconds → ISO timestamp. */
function isoDate(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/** Stable per-transaction key; SimpleFIN ids are only unique within an account. */
export function idempotencyKey(sfAccountId: string, txnId: string): string {
  return `simplefin:${sfAccountId}:${txnId}`;
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
    activityDate: isoDate(txn.transacted_at ?? txn.posted),
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
    idempotencyKey: idempotencyKey(sfAccount.id, txn.id),
  };
}

/** Max days between the two legs of a card payment (ACH can take a few). */
const TRANSFER_WINDOW_DAYS = 5;

/**
 * Give matching card-payment legs a shared `sourceGroupId`, so Wealthfolio
 * treats them as one internal transfer instead of an expense on the bank
 * side. A leg is a cash-account TRANSFER_OUT and a card TRANSFER_IN with the
 * same amount and currency within a few days of each other; each leg pairs at
 * most once, closest dates first.
 *
 * The group id is derived from both transaction ids, so it comes out the same
 * on every sync that sees both legs. A leg already written before its
 * counterpart posted stays unpaired: creates never touch existing activities.
 */
export function pairTransfers(activities: SyncActivityCreate[]): void {
  const outs = activities.filter((a) => a.activityType === "TRANSFER_OUT" && !a.sourceGroupId);
  const ins = activities.filter((a) => a.activityType === "TRANSFER_IN" && !a.sourceGroupId);
  const time = (a: SyncActivityCreate) => new Date(a.activityDate).getTime();
  const candidates: Array<{ out: SyncActivityCreate; in: SyncActivityCreate; gap: number }> = [];
  for (const out of outs) {
    for (const inn of ins) {
      if (inn.accountId === out.accountId) continue;
      if (inn.amount !== out.amount || inn.currency !== out.currency) continue;
      const gap = Math.abs(time(inn) - time(out));
      if (gap <= TRANSFER_WINDOW_DAYS * 86_400_000) candidates.push({ out, in: inn, gap });
    }
  }
  candidates.sort((a, b) => a.gap - b.gap);
  for (const c of candidates) {
    if (c.out.sourceGroupId || c.in.sourceGroupId) continue;
    const group = `simplefin-transfer:${[c.out.idempotencyKey, c.in.idempotencyKey].sort().join("|")}`;
    c.out.sourceGroupId = group;
    c.in.sourceGroupId = group;
  }
}

/** True when the host rejected a create because the activity already exists. */
export function isDuplicateError(error: unknown): boolean {
  return /duplicate/i.test((error as Error)?.message ?? String(error));
}
