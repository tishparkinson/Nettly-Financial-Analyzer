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
    if (!groups.has(m)) groups.set(m, { merchant: m, count: 0, sample: tx.description });
    groups.get(m).count++;
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

export function averageNeedsSpending(transactions, days = 90) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const needs = transactions.filter((tx) => {
    if (tx.amount >= 0) return false;
    if (tx.isReimbursement) return false;
    if (tx.category === "Safety Net Contribution" || tx.category === "Savings") return false;
    return tx.needWant === "need" || isNeedCategory(tx.category);
  });
  const inWindow = needs.filter((tx) => new Date(tx.date) >= cutoff);
  const total = inWindow.reduce((s, tx) => s + Math.abs(tx.amount), 0);
  const months = days / 30;
  return months > 0 ? total / months : 0;
}

export function computeMonthsCovered(safetyNetBalance, avgNeedsMonthly) {
  if (!avgNeedsMonthly || avgNeedsMonthly <= 0) return null;
  return safetyNetBalance / avgNeedsMonthly;
}

export function needsVsWants(transactions, days = 90) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  let needs = 0;
  let wants = 0;
  for (const tx of transactions) {
    if (tx.amount >= 0) continue;
    if (new Date(tx.date) < cutoff) continue;
    if (tx.category === "Safety Net Contribution") continue;
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

/** Filter transactions for couples dashboard view. */
export function filterByPerson(transactions, accountOwners, filter, partners) {
  if (!filter || filter === "combined") return transactions;
  return transactions.filter((tx) => {
    const owner = accountOwners[tx.account] || "primary";
    if (filter === "primary") return owner === "primary" || owner === "joint";
    if (filter === "secondary") return owner === "secondary" || owner === "joint";
    return true;
  });
}

/** Sum spending per tag (absolute debits). */
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
