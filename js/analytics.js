import { categorizeMerchant, isNeedCategory, normalizeMerchant } from "./categories.js";

export function applyCategories(transactions, merchantMemory, categoryNeedWant = {}) {
  return transactions.map((tx) => {
    const { category, confidence, merchant, reimbursement } = categorizeMerchant(tx.description, merchantMemory);
    const needWant = categoryNeedWant[category] || (isNeedCategory(category, categoryNeedWant) ? "need" : "want");
    return {
      ...tx,
      merchant,
      category,
      confidence,
      needWant,
      isReimbursement: Boolean(reimbursement),
      tags: tx.tags || []
    };
  });
}

export function merchantsNeedingReview(transactions, threshold = 0.8) {
  const groups = new Map();
  for (const tx of transactions) {
    if (tx.confidence >= threshold) continue;
    const m = tx.merchant || normalizeMerchant(tx.description);
    if (!groups.has(m)) groups.set(m, { merchant: m, count: 0, sample: tx.description, category: tx.category || "Unknown" });
    groups.get(m).count++;
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

export function detectRecurring45(transactions) {
  const debits = transactions
    .filter((tx) => tx.amount < 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  const groups = new Map();
  for (const tx of debits) {
    const amt = Math.abs(tx.amount);
    const merchant = tx.merchant || (tx.description || "").slice(0, 30).toUpperCase();
    let matched = false;
    for (const [key, g] of groups) {
      if (g.merchant !== merchant) continue;
      const diff = Math.abs(g.refAmt - amt);
      if (diff <= 2 || diff / g.refAmt <= 0.05) {
        g.entries.push({ id: tx.id, date: tx.date, amt });
        matched = true;
        break;
      }
    }
    if (!matched) {
      const key = `${merchant}|${Math.round(amt)}`;
      groups.set(key, { merchant, refAmt: amt, entries: [{ id: tx.id, date: tx.date, amt }] });
    }
  }

  const INTERVALS = [
    { name: "monthly",   min: 25, max: 35 },
    { name: "biweekly",  min: 12, max: 16 },
    { name: "weekly",    min:  6, max:  8 },
  ];

  const result = new Map();

  for (const g of groups.values()) {
    if (g.entries.length < 2) continue;
    const sorted = g.entries.sort((a, b) => a.date.localeCompare(b.date));

    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      const days = (new Date(curr.date) - new Date(prev.date)) / 86400000;
      const interval = INTERVALS.find((iv) => days >= iv.min && days <= iv.max);
      if (interval) {
        result.set(curr.id, {
          isRecurring: true,
          interval: interval.name,
          lastDate: prev.date,
          lastAmt: prev.amt,
        });
        if (!result.has(prev.id)) {
          result.set(prev.id, {
            isRecurring: true,
            interval: interval.name,
            lastDate: null,
            lastAmt: null,
          });
        }
      }
    }
  }

  return result;
}

// Categories that represent money moving around (or being withdrawn as cash
// whose ultimate destination is unknown) rather than being spent on
// something identifiable. ATM Withdrawal / Cash is treated the same as an
// internal transfer: the withdrawal itself isn't a purchase — the purchase
// happens later, invisibly, unless logged manually.
const NON_SPEND_CATEGORIES = new Set([
  "Safety Net Contribution", "Savings", "Transfer from Savings", "Transfer from Checking",
  "Transfer", "ATM Withdrawal / Cash", "Income", "Interest Income", "One-Time Income"
]);

export function averageNeedsSpending(transactions, days = 45) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const needs = transactions.filter((tx) => {
    if (tx.amount >= 0) return false;
    if (tx.isReimbursement) return false;
    if (tx.isOneTime) return false;
    if (NON_SPEND_CATEGORIES.has(tx.category)) return false;
    return tx.needWant === "need" || isNeedCategory(tx.category);
  });
  const inWindow = needs.filter((tx) => new Date(tx.date) >= cutoff);
  const total = inWindow.reduce((s, tx) => s + Math.abs(tx.amount), 0);
  const months = days / 30;
  return months > 0 ? total / months : 0;
}

/**
 * Same idea as averageNeedsSpending, but includes both needs AND wants —
 * i.e. normal everyday spending, not just bare-essentials survival spending.
 * This is the basis for the headline Months Covered figure: "how long could
 * I keep living normally" rather than "how long could I merely survive."
 */
export function averageTotalSpending(transactions, days = 45) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const spend = transactions.filter((tx) => {
    if (tx.amount >= 0) return false;
    if (tx.isReimbursement) return false;
    if (tx.isOneTime) return false;
    if (NON_SPEND_CATEGORIES.has(tx.category)) return false;
    return true;
  });
  const inWindow = spend.filter((tx) => new Date(tx.date) >= cutoff);
  const total = inWindow.reduce((s, tx) => s + Math.abs(tx.amount), 0);
  const months = days / 30;
  return months > 0 ? total / months : 0;
}

/**
 * Summarizes how much of a person's spending is still sitting in "Unknown."
 * Counts distinct MERCHANTS, not raw transactions — one categorization
 * decision resolves every duplicate of that merchant at once, so merchant
 * count is what actually reflects "how many decisions are left," not
 * transaction count (which can look huge with many months of history even
 * though most of it collapses into a handful of repeat merchants).
 * "Miscellaneous" doesn't count here — that's a deliberate catch-all choice,
 * not an unresolved one.
 */
/**
 * Compares total cash withdrawn (ATM Withdrawal / Cash category) against
 * total cash purchases actually logged (any transaction under a "Cash"
 * account type — covers both the manual entry form and a pasted Cash
 * account). The gap is money that left the bank with no visible destination.
 */
export function cashGapSummary(transactions) {
  const withdrawals = transactions.filter((tx) => tx.category === "ATM Withdrawal / Cash" && tx.amount < 0);
  const cashWithdrawn = withdrawals.reduce((s, tx) => s + Math.abs(tx.amount), 0);

  const logged = transactions.filter((tx) => tx.accountType === "Cash" && tx.amount < 0);
  const cashLogged = logged.reduce((s, tx) => s + Math.abs(tx.amount), 0);

  const cashGap = Math.max(cashWithdrawn - cashLogged, 0);
  const gapPct = cashWithdrawn > 0 ? Math.round((cashGap / cashWithdrawn) * 100) : null;

  return {
    cashWithdrawn: Math.round(cashWithdrawn),
    cashLogged: Math.round(cashLogged),
    cashGap: Math.round(cashGap),
    gapPct,
    hasWithdrawals: cashWithdrawn > 0
  };
}

/**
 * A single dollar-weighted % describing how complete someone's financial
 * picture is — combining (a) how much of their real spending is still
 * "Unknown" and (b) how much withdrawn cash has no logged destination.
 * Deliberately scoped to bookkeeping completeness, not financial health —
 * someone can be at 100% here while still overspending on wants, and that's
 * fine; this measures whether the picture is visible, not whether it's good.
 */
export function completeFinancialPicture(transactions) {
  const spendTx = transactions.filter((tx) => tx.amount < 0 && !NON_SPEND_CATEGORIES.has(tx.category));
  const totalSpend = spendTx.reduce((s, tx) => s + Math.abs(tx.amount), 0);
  const unknownSpend = spendTx.filter((tx) => tx.category === "Unknown").reduce((s, tx) => s + Math.abs(tx.amount), 0);

  const cashGap = cashGapSummary(transactions);

  const totalMoneyOut = totalSpend + cashGap.cashGap;
  const knownMoneyOut = totalSpend - unknownSpend;

  const pct = totalMoneyOut > 0 ? Math.round((knownMoneyOut / totalMoneyOut) * 100) : 100;

  return {
    pct,
    totalSpend: Math.round(totalSpend),
    unknownSpend: Math.round(unknownSpend),
    cashWithdrawn: cashGap.cashWithdrawn,
    cashLogged: cashGap.cashLogged,
    cashGap: cashGap.cashGap,
    cashGapPct: cashGap.gapPct
  };
}

/**
 * Counts consecutive most-recent Safety Net updates where the balance grew.
 * Computed fresh from history each time rather than incrementally stored,
 * so it can never drift out of sync with the actual data.
 */
export function computeGrowthStreak(history) {
  if (!history || history.length < 2) return 0;
  let streak = 0;
  for (let i = history.length - 1; i > 0; i--) {
    if (history[i].balance > history[i - 1].balance) streak++;
    else break;
  }
  return streak;
}

export function uncategorizedSummary(transactions, options = {}) {
  const pctThreshold = options.pctThreshold ?? 3;
  const merchantCountThreshold = options.merchantCountThreshold ?? 5;

  const spendTx = transactions.filter((tx) => tx.amount < 0);
  const totalSpend = spendTx.reduce((s, tx) => s + Math.abs(tx.amount), 0);

  const unknownTx = spendTx.filter((tx) => tx.category === "Unknown");
  const unknownSpend = unknownTx.reduce((s, tx) => s + Math.abs(tx.amount), 0);
  const unknownMerchants = new Set(unknownTx.map((tx) => tx.merchant || tx.description));

  const pctOfSpend = totalSpend > 0 ? (unknownSpend / totalSpend) * 100 : 0;

  return {
    unknownTxCount: unknownTx.length,
    unknownMerchantCount: unknownMerchants.size,
    unknownSpend: Math.round(unknownSpend),
    pctOfSpend: Math.round(pctOfSpend * 10) / 10,
    shouldHighlight: unknownTx.length > 0 && (pctOfSpend >= pctThreshold || unknownMerchants.size >= merchantCountThreshold)
  };
}

export function computeMonthsCovered(safetyNetBalance, avgSpendingMonthly) {
  if (!avgSpendingMonthly || avgSpendingMonthly <= 0) return null;
  return safetyNetBalance / avgSpendingMonthly;
}

export function needsVsWants(transactions, days = 90) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  let needs = 0;
  let wants = 0;
  for (const tx of transactions) {
    if (tx.amount >= 0) continue;
    if (new Date(tx.date) < cutoff) continue;
    if (tx.isOneTime) continue;
    if (NON_SPEND_CATEGORIES.has(tx.category)) continue;
    const abs = Math.abs(tx.amount);
    if (tx.needWant === "need") needs += abs;
    else wants += abs;
  }
  const total = needs + wants || 1;
  return {
    needs,
    wants,
    needsPct: Math.round((needs / total) * 100),
    wantsPct: Math.round((wants / total) * 100)
  };
}

export function detectRecurring(transactions, minOccurrences = 3) {
  const debits = transactions.filter((tx) => tx.amount < 0);
  const groups = new Map();
  for (const tx of debits) {
    const key = `${tx.merchant}|${Math.round(Math.abs(tx.amount))}`;
    if (!groups.has(key)) {
      groups.set(key, { merchant: tx.merchant, category: tx.category, amounts: [], dates: [] });
    }
    const g = groups.get(key);
    g.amounts.push(Math.abs(tx.amount));
    g.dates.push(tx.date);
  }
  const bills = [];
  for (const g of groups.values()) {
    if (g.dates.length < minOccurrences) continue;
    g.dates.sort();
    const span = (new Date(g.dates.at(-1)) - new Date(g.dates[0])) / (86400000 * 30);
    if (span < 2) continue;
    const current = g.amounts.at(-1);
    const oneMonthAgo = avgNear(g.amounts, g.dates, 30);
    const threeMonthsAgo = avgNear(g.amounts, g.dates, 90);
    bills.push({
      label: g.merchant,
      category: g.category,
      current,
      oneMonthAgo,
      threeMonthsAgo,
      change1: current - oneMonthAgo,
      change3: current - threeMonthsAgo
    });
  }
  return bills.sort((a, b) => Math.abs(b.change3) - Math.abs(a.change3));
}

function avgNear(amounts, dates, daysBack) {
  const target = new Date();
  target.setDate(target.getDate() - daysBack);
  let sum = 0;
  let n = 0;
  for (let i = 0; i < dates.length; i++) {
    const d = new Date(dates[i]);
    if (Math.abs(d - target) < 20 * 86400000) {
      sum += amounts[i];
      n++;
    }
  }
  return n ? sum / n : amounts[0] || 0;
}

export function subscriptionSummary(transactions) {
  const subs = transactions.filter((tx) => tx.category === "Subscriptions" && tx.amount < 0);
  const byMerchant = new Map();
  for (const tx of subs) {
    const m = tx.merchant;
    if (!byMerchant.has(m)) byMerchant.set(m, Math.abs(tx.amount));
  }
  const monthly = [...byMerchant.values()].reduce((a, b) => a + b, 0);
  return { count: byMerchant.size, monthly, merchants: [...byMerchant.keys()] };
}

export function stabilityLabel(history) {
  if (history.length < 2) return "Stable";
  const recent = history.slice(-3).map((h) => h.monthsCovered);
  const delta = recent.at(-1) - recent[0];
  if (delta > 0.15) return "Growing";
  if (delta < -0.15) return "Shrinking";
  if (Math.abs(delta) <= 0.05) return "Stable";
  return "Shifting";
}

export function simpleInsights(transactions) {
  const insights = [];
  const nw = needsVsWants(transactions);
  if (nw.wants > 0 && nw.needs > 0) {
    insights.push(`Recent spending split: ${nw.needsPct}% toward needs and ${nw.wantsPct}% toward wants.`);
  }
  const subs = subscriptionSummary(transactions);
  if (subs.count > 0) {
    insights.push(`Observed ${subs.count} recurring subscription-style charges (~$${subs.monthly.toFixed(0)}/mo combined).`);
  }
  const income = transactions.filter((tx) => tx.amount > 0 && tx.category === "Income");
  if (income.length >= 2) {
    insights.push("Paycheck-style deposits appear in your history — useful for contribution streak tracking.");
  }
  return insights.slice(0, 4);
}

export function updateStreaks(state, didUpload) {
  const today = new Date().toISOString().slice(0, 10);
  const streaks = { ...state.streaks };

  if (didUpload) {
    const last = streaks.lastCheckIn;
    if (!last) {
      streaks.weeklyCheckIn = 1;
    } else {
      const diff = (new Date(today) - new Date(last)) / 86400000;
      streaks.weeklyCheckIn = diff <= 8 ? (streaks.weeklyCheckIn || 0) + 1 : 1;
    }
    streaks.lastCheckIn = today;
  }

  return streaks;
}

export function updateRecords(state, monthsCovered, safetyNetBalance) {
  const records = { ...state.personalRecords };
  if (monthsCovered != null && monthsCovered > (records.bestMonthsCovered || 0)) {
    records.bestMonthsCovered = monthsCovered;
    records.bestMonthsDate = new Date().toISOString().slice(0, 10);
  }
  if (safetyNetBalance > (records.largestSafetyNet || 0)) {
    records.largestSafetyNet = safetyNetBalance;
  }
  if ((state.streaks?.weeklyCheckIn || 0) > (records.longestCheckInStreak || 0)) {
    records.longestCheckInStreak = state.streaks.weeklyCheckIn;
  }
  return records;
}

export function filterByPerson(transactions, accountOwners, filter, partners) {
  if (!filter || filter === "combined") return transactions;
  return transactions.filter((tx) => {
    const owner = accountOwners[tx.account] || "primary";
    if (filter === "primary") return owner === "primary" || owner === "joint";
    if (filter === "secondary") return owner === "secondary" || owner === "joint";
    return true;
  });
}

export function tagSummaries(transactions, days = 90) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const sums = new Map();
  for (const tx of transactions) {
    if (tx.amount >= 0) continue;
    if (new Date(tx.date) < cutoff) continue;
    for (const tag of tx.tags || []) {
      sums.set(tag, (sums.get(tag) || 0) + Math.abs(tx.amount));
    }
  }
  return [...sums.entries()]
    .map(([tag, total]) => ({ tag, total }))
    .sort((a, b) => b.total - a.total);
}
