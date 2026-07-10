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
export function cashGapSummary(transactions, windowDays = 30) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);
  const inWindow = (tx) => new Date(tx.date) >= cutoff;

  const withdrawals = transactions.filter((tx) => tx.category === "ATM Withdrawal / Cash" && tx.amount < 0 && inWindow(tx));
  const cashWithdrawn = withdrawals.reduce((s, tx) => s + Math.abs(tx.amount), 0);

  const logged = transactions.filter((tx) => tx.accountType === "Cash" && tx.amount < 0 && inWindow(tx));
  const cashLogged = logged.reduce((s, tx) => s + Math.abs(tx.amount), 0);

  const cashGap = Math.max(cashWithdrawn - cashLogged, 0);
  const gapPct = cashWithdrawn > 0 ? Math.round((cashGap / cashWithdrawn) * 100) : null;

  return {
    cashWithdrawn: Math.round(cashWithdrawn),
    cashLogged: Math.round(cashLogged),
    cashGap: Math.round(cashGap),
    gapPct,
    hasWithdrawals: cashWithdrawn > 0,
    windowDays
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
export function completeFinancialPicture(transactions, confirmedMerchants = {}) {
  const spendTx = transactions.filter((tx) => tx.amount < 0 && !NON_SPEND_CATEGORIES.has(tx.category));
  const totalSpend = spendTx.reduce((s, tx) => s + Math.abs(tx.amount), 0);
  const merchantKey = (tx) => tx.merchant || (tx.description || "").slice(0, 40);
  const unconfirmedSpend = spendTx
    .filter((tx) => !confirmedMerchants[merchantKey(tx)])
    .reduce((s, tx) => s + Math.abs(tx.amount), 0);

  const cashGap = cashGapSummary(transactions);

  const totalMoneyOut = totalSpend + cashGap.cashGap;
  const knownMoneyOut = totalSpend - unconfirmedSpend;

  const pct = totalMoneyOut > 0 ? Math.round((knownMoneyOut / totalMoneyOut) * 100) : 100;

  return {
    pct,
    totalSpend: Math.round(totalSpend),
    unconfirmedSpend: Math.round(unconfirmedSpend),
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

/**
 * A celebratory summary of Safety Net growth — total growth since starting,
 * the most recent single contribution, and the current growth streak.
 * Rewards the behavior directly: shows how much and how often, not just a
 * bare streak count.
 */
export function safetyNetGrowthSummary(history) {
  if (!history || history.length < 1) return { available: false };
  const first = history[0];
  const latest = history.at(-1);
  const totalGrowth = latest.balance - first.balance;
  const lastContribution = history.length >= 2 ? latest.balance - history.at(-2).balance : null;
  const streak = computeGrowthStreak(history);
  return {
    available: true,
    totalGrowth: Math.round(totalGrowth),
    lastContribution: lastContribution != null ? Math.round(lastContribution) : null,
    streak,
    updatesCount: history.length
  };
}

/**
 * Groups spend transactions by merchant for a lightweight Need/Want-only
 * review — no category picking required. Category is still assigned
 * automatically in the background by categorizeMerchant(); this only tracks
 * which merchants the person has explicitly confirmed as Need or Want.
 * Excludes merchants already confirmed (tracked in confirmedMerchants, a
 * merchant -> "need"|"want" map).
 */
/**
 * Merchant candidates for the guided Needs wizard: every spend merchant not
 * yet confirmed, with a simple recurring flag (appears in 2+ distinct
 * calendar months present in the data) so monthly bills like rent and
 * utilities naturally sort to the top — exactly the ones people need to
 * find fastest when working through Housing, Utilities, etc.
 */
export function candidateMerchantsForWizard(transactions, confirmedMerchants = {}) {
  const merchantKey = (tx) => tx.merchant || (tx.description || "").slice(0, 40);
  const groups = new Map();

  for (const tx of transactions) {
    if (tx.amount >= 0) continue;
    if (NON_SPEND_CATEGORIES.has(tx.category)) continue;
    const m = merchantKey(tx);
    if (confirmedMerchants[m]) continue;
    if (!groups.has(m)) groups.set(m, { merchant: m, count: 0, total: 0, maxAmount: 0, months: new Set() });
    const g = groups.get(m);
    const amt = Math.abs(tx.amount);
    g.count++;
    g.total += amt;
    if (amt > g.maxAmount) g.maxAmount = amt;
    g.months.add(tx.date.slice(0, 7));
  }

  return [...groups.values()]
    .map((g) => ({
      merchant: g.merchant,
      count: g.count,
      total: Math.round(g.total),
      maxAmount: Math.round(g.maxAmount),
      isRecurring: g.months.size >= 2
    }))
    .sort((a, b) => {
      if (a.isRecurring !== b.isRecurring) return a.isRecurring ? -1 : 1;
      return b.maxAmount - a.maxAmount;
    });
}

/**
 * How much you spend at each merchant, on average, per day/week/month —
 * a simple, concrete number that's hard to get a feel for from a raw
 * transaction list. Uses the actual span of imported data as the
 * denominator (not each merchant's own first-to-last visit span), so every
 * merchant's rate is directly comparable on the same footing.
 */
export function merchantSpendRates(transactions, topN = 15) {
  const spendTx = transactions.filter((tx) => tx.amount < 0 && !NON_SPEND_CATEGORIES.has(tx.category));
  if (!spendTx.length) return { available: false, reason: "No spending yet to break down.", rates: [] };

  const dates = spendTx.map((tx) => tx.date).sort();
  const spanDays = Math.max((new Date(dates.at(-1)) - new Date(dates[0])) / 86400000, 1);

  const byMerchant = new Map();
  for (const tx of spendTx) {
    const m = tx.merchant || (tx.description || "").slice(0, 40);
    if (!byMerchant.has(m)) byMerchant.set(m, { merchant: m, total: 0, count: 0 });
    const g = byMerchant.get(m);
    g.total += Math.abs(tx.amount);
    g.count++;
  }

  const rates = [...byMerchant.values()]
    .map((g) => {
      const perDay = g.total / spanDays;
      return {
        merchant: g.merchant,
        total: Math.round(g.total),
        count: g.count,
        perDay: Math.round(perDay * 100) / 100,
        perWeek: Math.round(perDay * 7 * 100) / 100,
        perMonth: Math.round(perDay * 30)
      };
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, topN);

  return { available: true, spanDays: Math.round(spanDays), rates };
}

export function merchantsNeedingNeedWantReview(transactions, confirmedMerchants = {}) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const groups = new Map();
  for (const tx of transactions) {
    if (tx.amount >= 0) continue;
    if (NON_SPEND_CATEGORIES.has(tx.category)) continue;
    const m = tx.merchant || (tx.description || "").slice(0, 40);
    if (confirmedMerchants[m]) continue;
    if (!groups.has(m)) groups.set(m, { merchant: m, count: 0, total: 0, thisMonthTotal: 0 });
    const g = groups.get(m);
    g.count++;
    g.total += Math.abs(tx.amount);
    if (new Date(tx.date) >= monthStart) g.thisMonthTotal += Math.abs(tx.amount);
  }

  return [...groups.values()]
    .map((g) => ({ ...g, total: Math.round(g.total), thisMonthTotal: Math.round(g.thisMonthTotal) }))
    .sort((a, b) => b.count - a.count);
}

export function unconfirmedNeedWantSummary(transactions, confirmedMerchants = {}, options = {}) {
  const pctThreshold = options.pctThreshold ?? 3;
  const merchantCountThreshold = options.merchantCountThreshold ?? 5;

  const spendTx = transactions.filter((tx) => tx.amount < 0 && !NON_SPEND_CATEGORIES.has(tx.category));
  const totalSpend = spendTx.reduce((s, tx) => s + Math.abs(tx.amount), 0);

  const merchantKey = (tx) => tx.merchant || (tx.description || "").slice(0, 40);
  const unconfirmedTx = spendTx.filter((tx) => !confirmedMerchants[merchantKey(tx)]);
  const unconfirmedSpend = unconfirmedTx.reduce((s, tx) => s + Math.abs(tx.amount), 0);
  const unconfirmedMerchants = new Set(unconfirmedTx.map(merchantKey));

  const pctOfSpend = totalSpend > 0 ? (unconfirmedSpend / totalSpend) * 100 : 0;

  return {
    unconfirmedTxCount: unconfirmedTx.length,
    unconfirmedMerchantCount: unconfirmedMerchants.size,
    unconfirmedSpend: Math.round(unconfirmedSpend),
    pctOfSpend: Math.round(pctOfSpend * 10) / 10,
    shouldHighlight: unconfirmedTx.length > 0 && (pctOfSpend >= pctThreshold || unconfirmedMerchants.size >= merchantCountThreshold)
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

/**
 * Recurring want-classified charges — a general, merchant-regularity-based
 * replacement for category-dependent subscription detection. Uses the
 * isRecurring/recurringInterval flags already computed at import time
 * (regular interval + consistent amount from the same merchant), so it
 * catches a local gym membership or storage unit exactly as well as
 * Netflix — no lookup list of known subscription services required.
 * Need-classified recurring charges (rent, insurance, etc.) are
 * intentionally excluded — those are already accounted for as known
 * necessary bills, not something to "audit."
 */
export function recurringWantCharges(transactions) {
  const recurring = transactions.filter((tx) =>
    tx.amount < 0 && tx.isRecurring && !tx.isOneTime && tx.needWant === "want" && !NON_SPEND_CATEGORIES.has(tx.category)
  );

  const byMerchant = new Map();
  for (const tx of recurring) {
    const m = tx.merchant || (tx.description || "").slice(0, 40);
    if (!byMerchant.has(m)) byMerchant.set(m, { merchant: m, amounts: [], interval: tx.recurringInterval || "monthly" });
    byMerchant.get(m).amounts.push(Math.abs(tx.amount));
  }

  const intervalMultiplier = { weekly: 4.33, biweekly: 2.17, monthly: 1 };
  const items = [...byMerchant.values()].map((g) => {
    const avgAmt = g.amounts.reduce((a, b) => a + b, 0) / g.amounts.length;
    const monthlyEquiv = avgAmt * (intervalMultiplier[g.interval] || 1);
    return { merchant: g.merchant, avgAmt: Math.round(avgAmt), interval: g.interval, monthlyEquiv: Math.round(monthlyEquiv) };
  }).sort((a, b) => b.monthlyEquiv - a.monthlyEquiv);

  const totalMonthly = items.reduce((s, i) => s + i.monthlyEquiv, 0);
  return { available: items.length > 0, count: items.length, totalMonthly, items };
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
  const subs = recurringWantCharges(transactions);
  if (subs.count > 0) {
    insights.push(`Observed ${subs.count} recurring want-charge${subs.count > 1 ? "s" : ""} (~$${subs.totalMonthly.toFixed(0)}/mo combined).`);
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
