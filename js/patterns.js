import { BUDGET_GUIDELINES, getSpendingTier } from "./categories.js";

// Client-side spending-pattern analysis. No external calls, no AI — just
// arithmetic over transactions already in the browser. Every function returns
// an `available` flag and, when false, a `reason` explaining why there isn't
// enough data yet. We never want to present a fluke as a confident pattern.

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Categories that represent money moving around rather than being spent.
const NON_SPEND_CATEGORIES = new Set([
  "Income", "Interest Income", "One-Time Income", "Safety Net Contribution",
  "Savings", "Transfer", "Transfer from Savings", "Transfer from Checking",
  "ATM Withdrawal / Cash"
]);

function daysBetween(a, b) {
  return Math.abs(new Date(a) - new Date(b)) / 86400000;
}

function inWindow(tx, cutoff) {
  return new Date(tx.date) >= cutoff;
}

function isSpendTx(tx) {
  return tx.amount < 0 && !NON_SPEND_CATEGORIES.has(tx.category);
}

function isDiscretionary(tx) {
  return isSpendTx(tx) && tx.needWant === "want";
}

function fmtPct(p) {
  return `${Math.abs(p)}%`;
}

/**
 * Average spend by day of week. Needs at least MIN_WEEKS of history in-window.
 */
export function dayOfWeekProfile(transactions, windowDays) {
  const MIN_WEEKS = 4;
  const MIN_TRANSACTIONS = 10;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);
  const spend = transactions.filter((tx) => isSpendTx(tx) && inWindow(tx, cutoff));

  if (spend.length === 0) {
    return { available: false, reason: "No spending in this window yet." };
  }
  if (spend.length < MIN_TRANSACTIONS) {
    return { available: false, reason: "Need more transactions in this window to spot day-of-week patterns." };
  }

  // Measure the actual span of data present, not the configured window size —
  // a year-long window with only two weeks of real transactions in it should
  // not be treated as a year of evidence.
  const oldestDate = spend.reduce((min, tx) => (tx.date < min ? tx.date : min), spend[0].date);
  const spanDays = daysBetween(new Date(), oldestDate);
  if (spanDays < MIN_WEEKS * 7) {
    return { available: false, reason: `Need at least ${MIN_WEEKS} weeks of history to spot day-of-week patterns.` };
  }

  const totals = new Array(7).fill(0);
  const counts = new Array(7).fill(0);
  for (const tx of spend) {
    const dow = new Date(tx.date + "T12:00:00").getDay();
    totals[dow] += Math.abs(tx.amount);
    counts[dow]++;
  }

  const weeksSpanned = spanDays / 7;
  const avgPerDay = totals.map((t) => t / weeksSpanned);
  const overallAvg = avgPerDay.reduce((a, b) => a + b, 0) / 7;

  const days = DAY_NAMES.map((name, i) => ({
    day: name,
    avgPerWeek: Math.round(avgPerDay[i]),
    count: counts[i],
    pctVsAverage: overallAvg > 0 ? Math.round(((avgPerDay[i] - overallAvg) / overallAvg) * 100) : 0
  }));

  const sorted = [...days].sort((a, b) => b.avgPerWeek - a.avgPerWeek);
  const highest = sorted[0];

  return {
    available: true,
    days,
    highest,
    lowest: sorted[6],
    summary: highest.avgPerWeek > 0
      ? `${highest.day}s run about ${fmtPct(highest.pctVsAverage)} above your daily average — your highest-spending day of the week.`
      : null
  };
}

/**
 * Detects a regular pay cycle from Income-category deposits. Returns null if
 * there isn't enough regularly-spaced income data to trust a cycle length —
 * callers should fall back to a fixed default window in that case rather
 * than forcing a cycle onto irregular income.
 */
function detectPayCycle(transactions, windowDays) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);

  const incomeTx = transactions
    .filter((tx) => tx.amount > 0 && tx.category === "Income" && inWindow(tx, cutoff))
    .sort((a, b) => a.date.localeCompare(b.date));

  if (incomeTx.length < 3) return null;

  const gaps = [];
  for (let i = 1; i < incomeTx.length; i++) {
    gaps.push(daysBetween(incomeTx[i].date, incomeTx[i - 1].date));
  }
  const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const gapVariance = gaps.reduce((s, g) => s + (g - avgGap) ** 2, 0) / gaps.length;
  const gapStdev = Math.sqrt(gapVariance);

  if (avgGap === 0 || gapStdev / avgGap > 0.4) return null;

  return { avgGapDays: avgGap, paydays: incomeTx.map((tx) => tx.date) };
}

/**
 * Detects recurring "payday" deposits and compares spend in the days right
 * after payday vs. the rest of the pay cycle. Needs at least 3 confidently-
 * spaced income deposits to report — irregular income is left alone rather
 * than forcing a pattern onto it.
 */
export function paydayProximityEffect(transactions, windowDays, proximityDays = 3) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);

  const cycle = detectPayCycle(transactions, windowDays);
  if (!cycle) {
    return { available: false, reason: "Need at least 3 regularly-spaced paycheck-style deposits in this window to detect a payday pattern." };
  }
  const { paydays } = cycle;

  const spend = transactions.filter((tx) => isSpendTx(tx) && inWindow(tx, cutoff));

  const dayIsPostPayday = (dateStr) => {
    for (const p of paydays) {
      const diff = (new Date(dateStr) - new Date(p)) / 86400000;
      if (diff >= 0 && diff < proximityDays) return true;
    }
    return false;
  };

  let postPaydaySpend = 0;
  let restSpend = 0;
  for (const tx of spend) {
    if (dayIsPostPayday(tx.date)) postPaydaySpend += Math.abs(tx.amount);
    else restSpend += Math.abs(tx.amount);
  }

  const totalSpanDays = daysBetween(new Date(), paydays[0]);
  const postPaydayTotalDays = paydays.length * proximityDays;
  const restTotalDays = Math.max(totalSpanDays - postPaydayTotalDays, 1);

  const postPaydayAvgPerDay = postPaydaySpend / postPaydayTotalDays;
  const restAvgPerDay = restSpend / restTotalDays;
  const pctDiff = restAvgPerDay > 0 ? Math.round(((postPaydayAvgPerDay - restAvgPerDay) / restAvgPerDay) * 100) : null;

  return {
    available: true,
    paydayCount: paydays.length,
    avgGapDays: Math.round(cycle.avgGapDays),
    postPaydayAvgPerDay: Math.round(postPaydayAvgPerDay),
    restOfCycleAvgPerDay: Math.round(restAvgPerDay),
    pctDiff,
    summary: pctDiff == null ? null :
      `In the ${proximityDays} days right after payday, spending runs about ${fmtPct(pctDiff)} ${pctDiff >= 0 ? "higher" : "lower"} than the rest of your pay cycle.`
  };
}

/**
 * Month-over-month trend per category, compared against a rolling up-to-3-
 * month baseline. Needs at least 2 full months in-window to report.
 */
/**
 * Estimates monthly-equivalent income from Income-category deposits within
 * the given window, scaled from whatever span of data is actually present.
 */
function estimateMonthlyIncome(transactions, windowDays) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);
  const income = transactions.filter((tx) => tx.amount > 0 && tx.category === "Income" && inWindow(tx, cutoff));
  if (!income.length) return null;
  const total = income.reduce((s, tx) => s + tx.amount, 0);
  const spanDays = Math.max(daysBetween(new Date(), cutoff), 1);
  return (total / spanDays) * 30;
}

/**
 * Compares spending in the most recent pay cycle vs. the one before it, per
 * category. Uses the person's own detected pay-cycle length (weekly,
 * biweekly, monthly, etc.) instead of a fixed window, since "this week vs.
 * last week" only makes sense for someone actually paid weekly. Falls back
 * to a 30-day cycle when no regular pay pattern is detected.
 */
export function paceComparison(transactions, windowDays) {
  const cycle = detectPayCycle(transactions, windowDays);
  const cycleDays = cycle ? Math.round(cycle.avgGapDays) : 30;

  const now = new Date();
  const currentStart = new Date(now); currentStart.setDate(currentStart.getDate() - cycleDays);
  const previousStart = new Date(now); previousStart.setDate(previousStart.getDate() - cycleDays * 2);

  const spend = transactions.filter(isSpendTx);
  const oldestDate = spend.reduce((min, tx) => (tx.date < min ? tx.date : min), spend[0]?.date || null);
  if (!oldestDate || daysBetween(new Date(), oldestDate) < cycleDays * 2) {
    return { available: false, reason: `Need at least two ${cycleDays}-day cycles of history to compare pace.`, cycleDays, usedDetectedCycle: Boolean(cycle) };
  }

  const byCategory = new Map();
  for (const tx of spend) {
    const d = new Date(tx.date);
    const bucket = d >= currentStart ? "current" : (d >= previousStart ? "previous" : null);
    if (!bucket) continue;
    if (!byCategory.has(tx.category)) byCategory.set(tx.category, { current: 0, previous: 0 });
    byCategory.get(tx.category)[bucket] += Math.abs(tx.amount);
  }

  const categories = [...byCategory.entries()].map(([category, v]) => {
    const deltaAmt = Math.round(v.current - v.previous);
    const deltaPct = v.previous > 0 ? Math.round(((v.current - v.previous) / v.previous) * 100) : (v.current > 0 ? 100 : null);
    return { category, currentAmt: Math.round(v.current), previousAmt: Math.round(v.previous), deltaAmt, deltaPct };
  }).sort((a, b) => Math.abs(b.deltaAmt) - Math.abs(a.deltaAmt));

  return { available: true, cycleDays, usedDetectedCycle: Boolean(cycle), categories };
}

/**
 * Finds the want-category furthest beyond its "Generous" guideline ceiling
 * as a % of income. Flags it purely on being over guideline — a steady,
 * unchanging habit still counts, since the point is surfacing overspending
 * itself, not just changes in it. The trend vs. the previous pay cycle is
 * still included in the message for context (worsening / holding steady /
 * improving-but-still-high), it just doesn't gate whether this appears.
 */
/**
 * Groups historical debit transactions by merchant to find recurring,
 * roughly-monthly-or-longer bills (average gap ≥20 days, reasonably
 * regular), then buckets each into "already happened this cycle" or
 * "expected before next payday but hasn't happened yet." This is the data
 * behind the Safe Spending Until Payday transparency dropdown — showing the
 * actual detected bills, not just a number, so the person can see for
 * themselves whether anything's missing from the calculation.
 */
export function billsThisCycle(transactions) {
  const cycle = detectPayCycle(transactions, 180);
  const cycleDays = cycle ? Math.round(cycle.avgGapDays) : 30;
  const now = new Date();

  let currentCycleStart, nextPayday;
  if (cycle && cycle.paydays.length) {
    let cursor = new Date(cycle.paydays.at(-1));
    // Walk forward from the last detected payday in cycle-length steps until
    // we find the cycle that contains today.
    for (let i = 0; i < 60; i++) {
      const next = new Date(cursor); next.setDate(next.getDate() + cycleDays);
      if (next > now) { currentCycleStart = cursor; nextPayday = next; break; }
      cursor = next;
    }
  }
  if (!currentCycleStart) {
    currentCycleStart = new Date(now); currentCycleStart.setDate(currentCycleStart.getDate() - cycleDays);
    nextPayday = new Date(now); nextPayday.setDate(nextPayday.getDate() + cycleDays);
  }

  const byMerchant = new Map();
  for (const tx of transactions) {
    if (tx.amount >= 0 || NON_SPEND_CATEGORIES.has(tx.category)) continue;
    const m = tx.merchant || tx.description;
    if (!byMerchant.has(m)) byMerchant.set(m, []);
    byMerchant.get(m).push(tx);
  }

  const paidThisCycle = [];
  const expectedNotYetPaid = [];

  for (const [merchant, txs] of byMerchant) {
    if (txs.length < 2) continue;
    const sorted = [...txs].sort((a, b) => a.date.localeCompare(b.date));
    const gaps = [];
    for (let i = 1; i < sorted.length; i++) gaps.push(daysBetween(sorted[i].date, sorted[i - 1].date));
    const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    if (avgGap < 20) continue; // too frequent to be a "bill" (e.g. daily coffee) — this is about recurring obligations
    const gapStdev = Math.sqrt(gaps.reduce((s, g) => s + (g - avgGap) ** 2, 0) / gaps.length);
    if (gapStdev / avgGap > 0.5) continue; // too irregular to call a bill with any confidence

    const last = sorted.at(-1);
    const lastDate = new Date(last.date);
    const expectedNext = new Date(lastDate); expectedNext.setDate(expectedNext.getDate() + Math.round(avgGap));

    const entry = { merchant, category: last.category, amount: Math.round(Math.abs(last.amount)), lastDate: last.date, avgGapDays: Math.round(avgGap) };

    if (lastDate >= currentCycleStart) {
      paidThisCycle.push(entry);
    } else if (expectedNext <= nextPayday) {
      expectedNotYetPaid.push({ ...entry, expectedDate: expectedNext.toISOString().slice(0, 10) });
    }
  }

  return {
    cycleDays,
    currentCycleStart: currentCycleStart.toISOString().slice(0, 10),
    nextPayday: nextPayday.toISOString().slice(0, 10),
    paidThisCycle: paidThisCycle.sort((a, b) => b.lastDate.localeCompare(a.lastDate)),
    expectedNotYetPaid: expectedNotYetPaid.sort((a, b) => a.expectedDate.localeCompare(b.expectedDate))
  };
}

/**
 * A RANGE, not a single precise number — deliberately. Forecasting exact
 * upcoming bills is inherently uncertain, and a false-precision number that
 * turns out wrong is worse than an honest range. Conservative end assumes
 * every detected upcoming bill lands at its usual amount; comfortable end
 * gives some slack for bills that might be lower or already covered.
 */
export function safeSpendingUntilPayday(transactions) {
  const bills = billsThisCycle(transactions);
  const now = new Date();
  const daysUntilPayday = Math.max(Math.ceil(daysBetween(bills.nextPayday, now)), 1);

  const currentStart = new Date(bills.currentCycleStart);
  const cycleTx = transactions.filter((tx) => { const d = new Date(tx.date); return d >= currentStart && d <= now; });

  const incomeSoFar = cycleTx.filter((tx) => tx.amount > 0 && tx.category === "Income").reduce((s, tx) => s + tx.amount, 0);
  const spentSoFar = cycleTx.filter((tx) => tx.amount < 0 && !NON_SPEND_CATEGORIES.has(tx.category)).reduce((s, tx) => s + Math.abs(tx.amount), 0);
  const expectedBillsTotal = bills.expectedNotYetPaid.reduce((s, b) => s + b.amount, 0);

  if (!incomeSoFar) {
    return { available: false, reason: "Add income transactions to estimate safe spending until payday.", bills };
  }

  const conservative = incomeSoFar - spentSoFar - expectedBillsTotal;
  const comfortable = incomeSoFar - spentSoFar - (expectedBillsTotal * 0.7);

  return {
    available: true,
    daysUntilPayday,
    nextPayday: bills.nextPayday,
    incomeSoFar: Math.round(incomeSoFar),
    spentSoFar: Math.round(spentSoFar),
    expectedBillsTotal: Math.round(expectedBillsTotal),
    rangeLow: Math.round(Math.max(conservative, 0)),
    rangeHigh: Math.round(Math.max(comfortable, conservative, 0)),
    bills
  };
}

/**
 * Finds the want-category furthest beyond its "Generous" guideline ceiling
 * as a % of income. Flags it purely on being over guideline — a steady,
 * unchanging habit still counts, since the point is surfacing overspending
 * itself, not just changes in it. The trend vs. the previous pay cycle is
 * still included in the message for context (worsening / holding steady /
 * improving-but-still-high), it just doesn't gate whether this appears.
 */
export function worstOffendingWantCategory(transactions, windowDays) {
  const pace = paceComparison(transactions, windowDays);
  if (!pace.available) return { available: false, reason: pace.reason };

  const monthlyIncome = estimateMonthlyIncome(transactions, windowDays);
  if (!monthlyIncome) {
    return { available: false, reason: "Add income transactions to compare category spending against guidelines." };
  }

  const cycleIncome = monthlyIncome * (pace.cycleDays / 30);
  const candidates = [];

  for (const c of pace.categories) {
    const guideline = BUDGET_GUIDELINES[c.category];
    if (!guideline) continue;
    if (c.currentAmt <= 0) continue;
    const monthlyEquivalentAmt = c.currentAmt * (30 / pace.cycleDays);
    const pctOfIncome = cycleIncome > 0 ? (c.currentAmt / cycleIncome) * 100 : (monthlyIncome > 0 ? (monthlyEquivalentAmt / monthlyIncome) * 100 : null);
    if (pctOfIncome == null) continue;
    const tier = getSpendingTier(pctOfIncome, guideline);
    if (tier.overGuideline) {
      candidates.push({
        category: c.category,
        currentAmt: c.currentAmt,
        deltaAmt: c.deltaAmt,
        deltaPct: c.deltaPct,
        pctOfIncome: Math.round(pctOfIncome),
        guidelineAim: guideline.aim,
        cycleDays: pace.cycleDays
      });
    }
  }

  if (!candidates.length) {
    return { available: false, reason: "No want-category is currently over its usual guideline." };
  }

  candidates.sort((a, b) => b.pctOfIncome - a.pctOfIncome);
  const worst = candidates[0];

  const cyclePeriod = worst.cycleDays >= 25 ? "month" : worst.cycleDays >= 12 ? "two weeks" : "week";
  const trendPhrase = worst.deltaAmt > 5
    ? `and trending higher (up ${fmtPct(worst.deltaPct)} from your last cycle)`
    : worst.deltaAmt < -5
      ? `though trending lower (down ${fmtPct(worst.deltaPct)} from your last cycle) — still worth a look`
      : "holding fairly steady vs. your last cycle";

  return {
    available: true,
    ...worst,
    summary: `${worst.category}: ${fmtMoney(worst.currentAmt)} this ${cyclePeriod} (${worst.pctOfIncome}% of income, above the usual ${worst.guidelineAim}% guideline) — ${trendPhrase}.`
  };
}

/**
 * Overall wants spending as a % of income, using the same Careful/Standard/
 * Generous tiers as individual categories. This is the always-visible
 * headline badge — individual category detail lives in the drill-down.
 */
export function overallWantsTier(transactions, windowDays = 30) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);

  const wants = transactions.filter((tx) =>
    tx.amount < 0 && tx.needWant === "want" && !tx.isOneTime && !NON_SPEND_CATEGORIES.has(tx.category) && inWindow(tx, cutoff)
  );
  const wantsTotal = wants.reduce((s, tx) => s + Math.abs(tx.amount), 0);
  const monthlyIncome = estimateMonthlyIncome(transactions, windowDays);

  if (!monthlyIncome) {
    return { available: false, reason: "Add income transactions to see your overall wants tier." };
  }

  const spanMonths = Math.max(Math.min(windowDays, daysBetween(new Date(), cutoff)) / 30, 0.1);
  const monthlyWants = wantsTotal / spanMonths;
  const pctOfIncome = (monthlyWants / monthlyIncome) * 100;
  const tier = getSpendingTier(pctOfIncome, BUDGET_GUIDELINES["Overall Wants"]);

  return { available: true, monthlyWants: Math.round(monthlyWants), pctOfIncome: Math.round(pctOfIncome), ...tier };
}

/**
 * Top want-category per calendar month, for the last N months — feeds the
 * "View history" toggle under the worst-offender alert. Collapsed/opt-in by
 * design: the headline stays focused on right now, history is a click away
 * for anyone who wants it, not competing for attention by default.
 */
export function topWantCategoryByMonth(transactions, monthsBack = 6) {
  const now = new Date();
  const results = [];

  for (let i = 0; i < monthsBack; i++) {
    const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
    const label = monthStart.toLocaleDateString("en-US", { month: "short", year: "numeric" });

    const monthTx = transactions.filter((tx) => {
      const d = new Date(tx.date);
      return d >= monthStart && d < monthEnd;
    });

    const income = monthTx
      .filter((tx) => tx.amount > 0 && tx.category === "Income")
      .reduce((s, tx) => s + tx.amount, 0);

    const wants = monthTx.filter((tx) => tx.amount < 0 && tx.needWant === "want" && !tx.isOneTime && !NON_SPEND_CATEGORIES.has(tx.category));
    const byCat = new Map();
    for (const tx of wants) byCat.set(tx.category, (byCat.get(tx.category) || 0) + Math.abs(tx.amount));
    const sorted = [...byCat.entries()].sort((a, b) => b[1] - a[1]);

    if (!sorted.length) {
      results.push({ label, available: false });
      continue;
    }
    const [topCategory, amount] = sorted[0];
    const pctOfIncome = income > 0 ? Math.round((amount / income) * 100) : null;
    results.push({ label, available: true, topCategory, amount: Math.round(amount), pctOfIncome });
  }

  return results;
}

/**
 * Overall Wants tier per calendar month, for the last N months — feeds the
 * "View history" toggle under the Wants tier badge.
 */
export function overallWantsTierByMonth(transactions, monthsBack = 6) {
  const now = new Date();
  const results = [];

  for (let i = 0; i < monthsBack; i++) {
    const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
    const label = monthStart.toLocaleDateString("en-US", { month: "short", year: "numeric" });

    const monthTx = transactions.filter((tx) => {
      const d = new Date(tx.date);
      return d >= monthStart && d < monthEnd;
    });

    const income = monthTx
      .filter((tx) => tx.amount > 0 && tx.category === "Income")
      .reduce((s, tx) => s + tx.amount, 0);

    const wants = monthTx
      .filter((tx) => tx.amount < 0 && tx.needWant === "want" && !tx.isOneTime && !NON_SPEND_CATEGORIES.has(tx.category))
      .reduce((s, tx) => s + Math.abs(tx.amount), 0);

    if (income <= 0) {
      results.push({ label, available: false });
      continue;
    }

    const pctOfIncome = (wants / income) * 100;
    const tier = getSpendingTier(pctOfIncome, BUDGET_GUIDELINES["Overall Wants"]);
    results.push({ label, available: true, amount: Math.round(wants), pctOfIncome: Math.round(pctOfIncome), ...tier });
  }

  return results;
}

// Categories that make up "the tax you pay for convenience" — dining out,
// fast food, coffee/convenience stops, and ATM/bank fees. Delivery services
// (DoorDash, Uber Eats, etc.) already fall under Dining Out via the merchant
// rules, so they're included here without any extra handling.
const CONVENIENCE_TAX_CATEGORIES = new Set(["Coffee & Convenience", "Fast Food", "Dining Out", "ATM & Bank Fees"]);

export function convenienceTax(transactions, windowDays = 30) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);
  const spend = transactions.filter((tx) => tx.amount < 0 && CONVENIENCE_TAX_CATEGORIES.has(tx.category) && inWindow(tx, cutoff));
  const total = spend.reduce((s, tx) => s + Math.abs(tx.amount), 0);

  if (total <= 0) return { available: false, reason: "No convenience-category spending in this window." };

  const monthlyIncome = estimateMonthlyIncome(transactions, windowDays);
  const spanMonths = Math.max(Math.min(windowDays, daysBetween(new Date(), cutoff)) / 30, 0.1);
  const monthlyAmt = total / spanMonths;
  const pctOfIncome = monthlyIncome ? Math.round((monthlyAmt / monthlyIncome) * 100) : null;

  const breakdown = [...CONVENIENCE_TAX_CATEGORIES]
    .map((cat) => ({ category: cat, monthlyAmt: Math.round((spend.filter((tx) => tx.category === cat).reduce((s, tx) => s + Math.abs(tx.amount), 0)) / spanMonths) }))
    .filter((b) => b.monthlyAmt > 0)
    .sort((a, b) => b.monthlyAmt - a.monthlyAmt);

  return { available: true, monthlyAmt: Math.round(monthlyAmt), pctOfIncome, breakdown };
}

const SAFETY_NET_STARTER_GOAL = 1000; // a common "starter emergency fund" benchmark
const SUGGESTION_CUT_PCT = 0.20;
const MIN_MONTHLY_FREED = 10;
const MAX_MONTHS_TO_GOAL = 36;

/**
/**
 * Generates concrete "cut category X by 20% → frees $Y/cycle → reaches a
 * $1,000 starter emergency fund in Z months" suggestions, one per top
 * want-category from the previous pay cycle. Uses the person's own detected
 * pay-cycle length (weekly/biweekly/monthly) rather than calendar months —
 * most people living paycheck to paycheck think in terms of "until my next
 * payday," not "this calendar month." Doesn't ask the person to pick one —
 * shows whichever ones are still realistic THIS cycle. A suggestion is
 * dropped (not just flagged) if this cycle's spending in that category has
 * already exceeded what a 20%-lower cycle would allow — no point suggesting
 * a cut that's already off the table.
 */
export function safetyNetBuilderSuggestions(transactions) {
  const cycle = detectPayCycle(transactions, 180);
  const cycleDays = cycle ? Math.round(cycle.avgGapDays) : 30;

  const now = new Date();
  const currentStart = new Date(now); currentStart.setDate(currentStart.getDate() - cycleDays);
  const previousStart = new Date(now); previousStart.setDate(previousStart.getDate() - cycleDays * 2);

  const previousCycleTx = transactions.filter((tx) => { const d = new Date(tx.date); return d >= previousStart && d < currentStart; });
  if (!previousCycleTx.some((tx) => tx.amount < 0)) {
    return { available: false, reason: `Need at least one full ${cycleDays}-day pay cycle of history to generate suggestions.` };
  }

  const currentCycleTx = transactions.filter((tx) => new Date(tx.date) >= currentStart);

  const isWantSpend = (tx) => tx.amount < 0 && tx.needWant === "want" && !tx.isOneTime && !NON_SPEND_CATEGORIES.has(tx.category);

  const wantsByCat = new Map();
  for (const tx of previousCycleTx) if (isWantSpend(tx)) wantsByCat.set(tx.category, (wantsByCat.get(tx.category) || 0) + Math.abs(tx.amount));

  const currentByCat = new Map();
  for (const tx of currentCycleTx) if (isWantSpend(tx)) currentByCat.set(tx.category, (currentByCat.get(tx.category) || 0) + Math.abs(tx.amount));

  const monthlyIncome = estimateMonthlyIncome(transactions, 90);
  const cyclePeriod = cycleDays >= 25 ? "month" : cycleDays >= 12 ? "two weeks" : "week";
  const candidates = [];

  for (const [category, baselineAmt] of wantsByCat) {
    const monthlyEquivBaseline = baselineAmt * (30 / cycleDays);
    const freedAmt = baselineAmt * SUGGESTION_CUT_PCT; // per cycle
    const monthlyEquivFreed = monthlyEquivBaseline * SUGGESTION_CUT_PCT;
    if (monthlyEquivFreed < MIN_MONTHLY_FREED) continue;

    const reducedTarget = baselineAmt * (1 - SUGGESTION_CUT_PCT);
    const currentAmt = currentByCat.get(category) || 0;
    if (currentAmt > reducedTarget) continue; // already spent past the reduced target — not reachable this cycle

    const monthsToGoal = Math.ceil(SAFETY_NET_STARTER_GOAL / monthlyEquivFreed);
    if (monthsToGoal > MAX_MONTHS_TO_GOAL) continue;

    const guideline = BUDGET_GUIDELINES[category];
    let tier = null, overGuideline = false;
    if (guideline && monthlyIncome) {
      const pctOfIncome = (monthlyEquivBaseline / monthlyIncome) * 100;
      const t = getSpendingTier(pctOfIncome, guideline);
      tier = t.tier; overGuideline = t.overGuideline;
    }

    const cutPctLabel = Math.round(SUGGESTION_CUT_PCT * 100);
    candidates.push({
      category,
      baselineAmt: Math.round(baselineAmt),
      currentAmt: Math.round(currentAmt),
      cutPct: cutPctLabel,
      freedAmt: Math.round(freedAmt),
      monthsToGoal,
      tier,
      overGuideline,
      cycleDays,
      summary: `Cutting ${category} by ${cutPctLabel}% this ${cyclePeriod} would free about ${fmtMoney(freedAmt)} — enough to build a $${SAFETY_NET_STARTER_GOAL} starter emergency fund in about ${monthsToGoal} month${monthsToGoal !== 1 ? "s" : ""}.`
    });
  }

  candidates.sort((a, b) => b.baselineAmt - a.baselineAmt);
  const top = candidates.slice(0, 3);

  return {
    available: top.length > 0,
    suggestions: top,
    goal: SAFETY_NET_STARTER_GOAL,
    reason: top.length ? null : "No want-category has meaningful room to cut this month, or the realistic cuts are already used up for this cycle."
  };
}

/**
 * "Where did the raise go?" — when income has risen vs. the recent baseline,
 * breaks down whether the increase went to needs/bills, convenience
 * spending, other wants, or savings/unspent. Needs a meaningful income
 * increase to report anything at all.
 */
export function incomeAllocationTrend(transactions) {
  const cycle = detectPayCycle(transactions, 180);
  const cycleDays = cycle ? Math.round(cycle.avgGapDays) : 30;
  const now = new Date();

  const currentStart = new Date(now); currentStart.setDate(currentStart.getDate() - cycleDays);
  // Compare against up to 3 prior cycles, same length, immediately before the current one.
  const baselineCycles = [1, 2, 3].map((i) => {
    const start = new Date(now); start.setDate(start.getDate() - cycleDays * (i + 1));
    const end = new Date(now); end.setDate(end.getDate() - cycleDays * i);
    return { start, end };
  });

  const sumIn = (start, end, filterFn) =>
    transactions.filter((tx) => { const d = new Date(tx.date); return d >= start && d < end && filterFn(tx); })
      .reduce((s, tx) => s + Math.abs(tx.amount), 0);

  const isIncome = (tx) => tx.amount > 0 && tx.category === "Income";
  const isNeedSpend = (tx) => tx.amount < 0 && tx.needWant === "need" && !NON_SPEND_CATEGORIES.has(tx.category);
  const isConvenience = (tx) => tx.amount < 0 && CONVENIENCE_TAX_CATEGORIES.has(tx.category);
  const isOtherWant = (tx) => tx.amount < 0 && tx.needWant === "want" && !CONVENIENCE_TAX_CATEGORIES.has(tx.category) && !NON_SPEND_CATEGORIES.has(tx.category);

  const currentIncome = sumIn(currentStart, now, isIncome);
  const baselineIncomes = baselineCycles.map((c) => sumIn(c.start, c.end, isIncome)).filter((v) => v > 0);
  const baselineIncome = baselineIncomes.length ? baselineIncomes.reduce((a, b) => a + b, 0) / baselineIncomes.length : 0;

  const deltaIncome = currentIncome - baselineIncome;
  if (!baselineIncome || deltaIncome < 50) {
    return { available: false, reason: "No significant income increase detected to trace." };
  }

  const cyclesWithData = baselineCycles.filter((c) =>
    transactions.some((tx) => { const d = new Date(tx.date); return d >= c.start && d < c.end; })
  );
  const avgOver = (filterFn) =>
    cyclesWithData.length ? cyclesWithData.reduce((s, c) => s + sumIn(c.start, c.end, filterFn), 0) / cyclesWithData.length : 0;

  const deltaNeeds = sumIn(currentStart, now, isNeedSpend) - avgOver(isNeedSpend);
  const deltaConvenience = sumIn(currentStart, now, isConvenience) - avgOver(isConvenience);
  const deltaOtherWants = sumIn(currentStart, now, isOtherWant) - avgOver(isOtherWant);
  const deltaSavingsOrUnspent = deltaIncome - deltaNeeds - deltaConvenience - deltaOtherWants;

  const cyclePeriod = cycleDays >= 25 ? "month" : cycleDays >= 12 ? "two weeks" : "week";
  const parts = [];
  if (Math.abs(deltaConvenience) >= 10) parts.push(`${fmtMoney(deltaConvenience)} to convenience spending`);
  if (Math.abs(deltaOtherWants) >= 10) parts.push(`${fmtMoney(deltaOtherWants)} to other wants`);
  if (Math.abs(deltaNeeds) >= 10) parts.push(`${fmtMoney(deltaNeeds)} to needs/bills`);
  if (Math.abs(deltaSavingsOrUnspent) >= 10) parts.push(`${fmtMoney(deltaSavingsOrUnspent)} to savings or left unspent`);

  return {
    available: true,
    cycleDays,
    deltaIncome: Math.round(deltaIncome),
    deltaNeeds: Math.round(deltaNeeds),
    deltaConvenience: Math.round(deltaConvenience),
    deltaOtherWants: Math.round(deltaOtherWants),
    deltaSavingsOrUnspent: Math.round(deltaSavingsOrUnspent),
    summary: `Income is up ${fmtMoney(deltaIncome)} this ${cyclePeriod} vs. your recent average${parts.length ? ` — ${parts.join(", ")}.` : "."}`
  };
}

/**
 * Small-purchase blindness — totals of everything at or under the threshold,
 * this week and this month. Purely informational: these add up fast and are
 * easy to lose track of individually.
 */
export function smallPurchaseBlindness(transactions, threshold = 15) {
  const now = new Date();
  const weekCutoff = new Date(now); weekCutoff.setDate(weekCutoff.getDate() - 7);
  const monthCutoff = new Date(now); monthCutoff.setDate(monthCutoff.getDate() - 30);

  const small = transactions.filter((tx) => tx.amount < 0 && Math.abs(tx.amount) <= threshold && !NON_SPEND_CATEGORIES.has(tx.category));
  const weekTx = small.filter((tx) => new Date(tx.date) >= weekCutoff);
  const monthTx = small.filter((tx) => new Date(tx.date) >= monthCutoff);

  return {
    available: monthTx.length > 0,
    threshold,
    weekCount: weekTx.length,
    weekTotal: Math.round(weekTx.reduce((s, tx) => s + Math.abs(tx.amount), 0)),
    monthCount: monthTx.length,
    monthTotal: Math.round(monthTx.reduce((s, tx) => s + Math.abs(tx.amount), 0))
  };
}

function fmtMoney(n) {
  return `$${Math.round(Math.abs(n)).toLocaleString()}`;
}

export function categoryTrends(transactions, windowDays) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);
  const spend = transactions.filter((tx) => isSpendTx(tx) && tx.category !== "Unknown" && inWindow(tx, cutoff));

  if (spend.length === 0) {
    return { available: false, reason: "No spending in this window yet." };
  }

  const byMonth = new Map();
  for (const tx of spend) {
    const ym = tx.date.slice(0, 7);
    if (!byMonth.has(ym)) byMonth.set(ym, new Map());
    const catMap = byMonth.get(ym);
    catMap.set(tx.category, (catMap.get(tx.category) || 0) + Math.abs(tx.amount));
  }

  const months = [...byMonth.keys()].sort();
  if (months.length < 2) {
    return { available: false, reason: "Need at least 2 full months of history to show a trend." };
  }

  // Guard against "2 distinct calendar-month labels" that are really just a
  // few days apart (e.g. June 28 + July 1) — require real elapsed time too.
  const oldestDate = spend.reduce((min, tx) => (tx.date < min ? tx.date : min), spend[0].date);
  const spanDays = daysBetween(new Date(), oldestDate);
  const MIN_SPAN_DAYS = 50;
  if (spanDays < MIN_SPAN_DAYS) {
    return { available: false, reason: "Need at least ~2 months of elapsed history to show a trend." };
  }

  const currentMonth = months.at(-1);
  const baselineMonths = months.slice(0, -1).slice(-3);

  // Require a minimum number of transactions in the current month bucket —
  // otherwise a single stray purchase can look like a huge "trend."
  const MIN_CURRENT_MONTH_TX = 2;
  const currentMonthTxCount = spend.filter((tx) => tx.date.slice(0, 7) === currentMonth).length;
  if (currentMonthTxCount < MIN_CURRENT_MONTH_TX) {
    return { available: false, reason: "Need a few more transactions this month before comparing trends." };
  }

  const categories = new Set();
  for (const m of byMonth.values()) for (const cat of m.keys()) categories.add(cat);

  const trends = [];
  for (const cat of categories) {
    const current = byMonth.get(currentMonth).get(cat) || 0;
    const baselineVals = baselineMonths.map((m) => byMonth.get(m).get(cat) || 0);
    const baselineAvg = baselineVals.reduce((a, b) => a + b, 0) / (baselineVals.length || 1);
    if (baselineAvg === 0 && current === 0) continue;
    const pctChange = baselineAvg > 0 ? Math.round(((current - baselineAvg) / baselineAvg) * 100) : null;
    trends.push({
      category: cat,
      current: Math.round(current),
      baselineAvg: Math.round(baselineAvg),
      pctChange,
      baselineMonthCount: baselineVals.length
    });
  }

  trends.sort((a, b) => Math.abs(b.pctChange || 0) - Math.abs(a.pctChange || 0));

  return { available: true, currentMonth, baselineMonths, trends };
}

/**
 * How much of total spend each category represents, and whether that share
 * grew or shrank across the window (first half vs. second half).
 */
export function categoryShareDrift(transactions, windowDays) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);
  const spend = transactions.filter((tx) => isSpendTx(tx) && tx.category !== "Unknown" && inWindow(tx, cutoff));

  if (spend.length < 10) {
    return { available: false, reason: "Need more spending history in this window to measure category drift." };
  }

  const midpoint = new Date();
  midpoint.setDate(midpoint.getDate() - windowDays / 2);

  const firstHalf = spend.filter((tx) => new Date(tx.date) < midpoint);
  const secondHalf = spend.filter((tx) => new Date(tx.date) >= midpoint);
  const halfSpanMonths = Math.max((windowDays / 2) / 30, 0.1);

  function shareByCategory(txs) {
    const total = txs.reduce((s, tx) => s + Math.abs(tx.amount), 0) || 1;
    const byCat = new Map();
    for (const tx of txs) byCat.set(tx.category, (byCat.get(tx.category) || 0) + Math.abs(tx.amount));
    const shares = new Map();
    const amounts = new Map();
    for (const [cat, amt] of byCat) {
      shares.set(cat, (amt / total) * 100);
      amounts.set(cat, amt / halfSpanMonths); // monthly-equivalent $ for fair comparison
    }
    return { shares, amounts };
  }

  const first = shareByCategory(firstHalf);
  const second = shareByCategory(secondHalf);
  const categories = new Set([...first.shares.keys(), ...second.shares.keys()]);

  const drift = [];
  for (const cat of categories) {
    const before = first.shares.get(cat) || 0;
    const after = second.shares.get(cat) || 0;
    const amtBefore = first.amounts.get(cat) || 0;
    const amtAfter = second.amounts.get(cat) || 0;
    drift.push({
      category: cat,
      sharePctBefore: Math.round(before),
      sharePctAfter: Math.round(after),
      deltaPts: Math.round(after - before),
      amtBeforeMonthly: Math.round(amtBefore),
      amtAfterMonthly: Math.round(amtAfter),
      deltaAmtMonthly: Math.round(amtAfter - amtBefore)
    });
  }
  drift.sort((a, b) => Math.abs(b.deltaPts) - Math.abs(a.deltaPts));

  return { available: true, drift };
}

/**
 * Coefficient-of-variation "steadiness" score per category. Higher = more
 * erratic month to month; lower = more predictable. Needs 3+ transactions
 * in a category to compute.
 */
export function categoryVolatility(transactions, windowDays) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);
  const spend = transactions.filter((tx) => isSpendTx(tx) && tx.category !== "Unknown" && inWindow(tx, cutoff));

  const byCat = new Map();
  for (const tx of spend) {
    if (!byCat.has(tx.category)) byCat.set(tx.category, []);
    byCat.get(tx.category).push(Math.abs(tx.amount));
  }

  const results = [];
  for (const [cat, amounts] of byCat) {
    if (amounts.length < 3) continue;
    const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const variance = amounts.reduce((s, a) => s + (a - mean) ** 2, 0) / amounts.length;
    const stdev = Math.sqrt(variance);
    const cv = mean > 0 ? Math.round((stdev / mean) * 100) / 100 : 0;
    results.push({ category: cat, mean: Math.round(mean), stdev: Math.round(stdev), cv, count: amounts.length });
  }
  results.sort((a, b) => b.cv - a.cv);

  return {
    available: results.length > 0,
    results,
    reason: results.length ? null : "Not enough repeated spending yet in any category."
  };
}

/**
 * Flags individual transactions well above that merchant's own historical
 * average. Needs at least 3 prior instances of a merchant to establish a
 * baseline — compares each purchase to its own merchant's pattern, not a
 * generic category average.
 */
export function detectAnomalies(transactions, windowDays) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);
  const spend = transactions
    .filter((tx) => isSpendTx(tx) && inWindow(tx, cutoff))
    .sort((a, b) => a.date.localeCompare(b.date));

  const byMerchant = new Map();
  const anomalies = [];

  for (const tx of spend) {
    const m = tx.merchant || tx.description;
    const history = byMerchant.get(m) || [];
    if (history.length >= 3) {
      const mean = history.reduce((a, b) => a + b, 0) / history.length;
      const variance = history.reduce((s, a) => s + (a - mean) ** 2, 0) / history.length;
      const stdev = Math.sqrt(variance);
      const amt = Math.abs(tx.amount);
      const threshold = Math.max(mean + 2 * stdev, mean * 1.75);
      if (amt > threshold && amt > mean * 1.3) {
        anomalies.push({
          id: tx.id,
          date: tx.date,
          merchant: m,
          amount: amt,
          usualAvg: Math.round(mean),
          pctAboveUsual: Math.round(((amt - mean) / mean) * 100)
        });
      }
    }
    history.push(Math.abs(tx.amount));
    byMerchant.set(m, history);
  }

  anomalies.sort((a, b) => b.date.localeCompare(a.date));

  return {
    available: anomalies.length > 0,
    anomalies: anomalies.slice(0, 10),
    reason: anomalies.length ? null : "No unusual charges detected relative to your own history."
  };
}

/**
 * Clusters of 3+ discretionary ("want") purchases within a short window.
 * Purely informational — no judgment implied, just a pattern surfaced.
 */
export function detectSpendingSprees(transactions, windowDays, clusterHours = 48, minCount = 3) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);
  const wants = transactions
    .filter((tx) => isDiscretionary(tx) && inWindow(tx, cutoff))
    .sort((a, b) => a.date.localeCompare(b.date));

  const sprees = [];
  let cluster = [];
  for (const tx of wants) {
    if (cluster.length === 0) {
      cluster.push(tx);
      continue;
    }
    const hoursSince = daysBetween(tx.date, cluster.at(-1).date) * 24;
    if (hoursSince <= clusterHours) {
      cluster.push(tx);
    } else {
      if (cluster.length >= minCount) sprees.push(summarizeCluster(cluster));
      cluster = [tx];
    }
  }
  if (cluster.length >= minCount) sprees.push(summarizeCluster(cluster));

  return {
    available: sprees.length > 0,
    sprees,
    reason: sprees.length ? null : "No spending clusters detected in this window."
  };
}

function summarizeCluster(cluster) {
  return {
    startDate: cluster[0].date,
    endDate: cluster.at(-1).date,
    count: cluster.length,
    total: Math.round(cluster.reduce((s, tx) => s + Math.abs(tx.amount), 0)),
    merchants: [...new Set(cluster.map((tx) => tx.merchant || tx.description.slice(0, 30)))],
    txIds: cluster.map((tx) => tx.id).filter(Boolean),
    anyTagged: cluster.some((tx) => (tx.tags || []).length > 0)
  };
}

/**
 * Runs every pattern analysis and returns one structured result, plus a flat
 * list of plain-English summary sentences for whichever patterns had enough
 * data to report. Pure arithmetic — no AI, no external calls.
 */
export function analyzeSpendingPatterns(transactions, windowDays = 365) {
  const dayOfWeek = dayOfWeekProfile(transactions, windowDays);
  const payday = paydayProximityEffect(transactions, windowDays);
  const trends = categoryTrends(transactions, windowDays);
  const drift = categoryShareDrift(transactions, windowDays);
  const volatility = categoryVolatility(transactions, windowDays);
  const anomalies = detectAnomalies(transactions, windowDays);
  const sprees = detectSpendingSprees(transactions, windowDays);
  const pace = paceComparison(transactions, windowDays);
  const worstOffender = worstOffendingWantCategory(transactions, windowDays);

  const summaries = [];
  if (dayOfWeek.available && dayOfWeek.summary) summaries.push(dayOfWeek.summary);
  if (payday.available && payday.summary) summaries.push(payday.summary);

  if (trends.available) {
    const top = trends.trends.find((t) => t.pctChange != null && Math.abs(t.pctChange) >= 15);
    if (top) {
      const deltaAmt = top.current - top.baselineAvg;
      summaries.push(`${top.category} spending is ${fmtMoney(deltaAmt)}/mo ${deltaAmt >= 0 ? "higher" : "lower"} (${fmtPct(top.pctChange)}) this month vs. your recent average.`);
    }
  }

  if (drift.available) {
    const top = drift.drift.find((d) => Math.abs(d.deltaPts) >= 5);
    if (top) {
      summaries.push(`${top.category} has gone from ${fmtMoney(top.amtBeforeMonthly)}/mo to ${fmtMoney(top.amtAfterMonthly)}/mo (${top.sharePctBefore}% → ${top.sharePctAfter}% of your total spending) over this window.`);
    }
  }

  if (volatility.available && volatility.results[0]?.cv >= 0.6) {
    summaries.push(`${volatility.results[0].category} is your least predictable spending category — it swings a lot from month to month.`);
  }

  if (anomalies.available) {
    summaries.push(`${anomalies.anomalies.length} charge${anomalies.anomalies.length > 1 ? "s stand" : " stands"} out as unusually high compared to your normal spending at that merchant.`);
  }

  if (sprees.available) {
    summaries.push(`${sprees.sprees.length} spending cluster${sprees.sprees.length > 1 ? "s" : ""} detected — 3+ discretionary purchases within 48 hours of each other.`);
  }

  return { dayOfWeek, payday, trends, drift, volatility, anomalies, sprees, pace, worstOffender, summaries, windowDays };
}
