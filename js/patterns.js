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
export function detectPayCycle(transactions, windowDays) {
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

  // A cycle this short doesn't leave enough transactions in a single window
  // for pace comparisons to mean much — and can also be an artifact of two
  // household earners on staggered schedules producing a deceptively
  // regular-looking combined gap pattern (tested: neither gap-timing nor
  // paycheck-amount consistency reliably tells these two cases apart, so
  // this floor is a pragmatic safety net, not a precise detector).
  if (avgGap < 6) return null;

  return { avgGapDays: avgGap, paydays: incomeTx.map((tx) => tx.date) };
}

/**
 * Predicts upcoming payday DATES directly from day-of-month history, rather
 * than computing one "cycle length" number and adding it to the last
 * payday. This sidesteps the multi-earner problem entirely: two staggered
 * earners just show up as two separate recurring day-of-month clusters
 * (e.g. "around the 1st" and "around the 10th"), each correctly detected
 * and projected forward on its own — no need to force everything into one
 * interval that doesn't represent anyone's actual pay schedule.
 */
// U.S. federal holidays, also observed by banks — computed per year rather
// than hardcoded, since several float (nth weekday of month).
function getBankHolidays(year) {
  const nthWeekday = (y, month, weekday, n) => {
    const d = new Date(y, month, 1);
    let count = 0;
    while (true) {
      if (d.getDay() === weekday) { count++; if (count === n) return new Date(d); }
      d.setDate(d.getDate() + 1);
    }
  };
  const lastWeekday = (y, month, weekday) => {
    const d = new Date(y, month + 1, 0);
    while (d.getDay() !== weekday) d.setDate(d.getDate() - 1);
    return new Date(d);
  };
  const dates = [
    new Date(year, 0, 1),               // New Year's Day
    nthWeekday(year, 0, 1, 3),          // MLK Day — 3rd Monday of Jan
    nthWeekday(year, 1, 1, 3),          // Presidents Day — 3rd Monday of Feb
    lastWeekday(year, 4, 1),            // Memorial Day — last Monday of May
    new Date(year, 5, 19),              // Juneteenth
    new Date(year, 6, 4),               // Independence Day
    nthWeekday(year, 8, 1, 1),          // Labor Day — 1st Monday of Sept
    nthWeekday(year, 9, 1, 2),          // Columbus Day — 2nd Monday of Oct
    new Date(year, 10, 11),             // Veterans Day
    nthWeekday(year, 10, 4, 4),         // Thanksgiving — 4th Thursday of Nov
    new Date(year, 11, 25)              // Christmas
  ];
  return new Set(dates.map((d) => d.toISOString().slice(0, 10)));
}

function isWeekendOrHoliday(dateStr) {
  const d = new Date(dateStr + "T12:00:00");
  const day = d.getDay();
  if (day === 0 || day === 6) return true;
  return getBankHolidays(d.getFullYear()).has(dateStr);
}

function shiftToBusinessDay(dateStr, direction) {
  let d = new Date(dateStr + "T12:00:00");
  const step = direction === "after" ? 1 : -1;
  let guard = 0;
  while (isWeekendOrHoliday(d.toISOString().slice(0, 10)) && guard < 10) {
    d.setDate(d.getDate() + step);
    guard++;
  }
  return d.toISOString().slice(0, 10);
}

export function predictUpcomingPaydays(transactions, weeksAhead = 4, previousJobLastPaycheckDate = null) {
  const incomeTx = transactions.filter((tx) => tx.amount > 0 && tx.category === "Income");
  if (incomeTx.length < 2) {
    return { available: false, reason: "Need at least a couple of income deposits in history to predict paydays." };
  }

  const dayBuckets = new Map();
  for (const tx of incomeTx) {
    const day = new Date(tx.date + "T12:00:00").getDate();
    if (!dayBuckets.has(day)) dayBuckets.set(day, []);
    dayBuckets.get(day).push({ date: tx.date, amount: tx.amount });
  }

  const sortedDays = [...dayBuckets.keys()].sort((a, b) => a - b);
  const clusters = [];
  for (const day of sortedDays) {
    const last = clusters.at(-1);
    if (last && day - last.days.at(-1) <= 3) {
      last.days.push(day);
      last.entries.push(...dayBuckets.get(day));
    } else {
      clusters.push({ days: [day], entries: [...dayBuckets.get(day)] });
    }
  }

  const today = new Date();
  const recurring = clusters.filter((c) => {
    if (new Set(c.entries.map((e) => e.date.slice(0, 7))).size < 2) return false;
    const mostRecent = c.entries.map((e) => e.date).sort().at(-1);
    // Explicit override wins immediately, even inside the 45-day window the
    // automatic heuristic would otherwise still trust — this is exactly the
    // gap a very recent job change falls into.
    if (previousJobLastPaycheckDate && mostRecent <= previousJobLastPaycheckDate) return false;
    // Drop stale patterns — if the most recent instance is far older than a
    // typical pay interval, treat this as no longer active (e.g. a former
    // job) rather than keep predicting it forever.
    return daysBetween(today, mostRecent) <= 45;
  });
  if (!recurring.length) {
    return { available: false, reason: "No recurring, currently-active payday pattern detected yet — need at least 2 months of consistent income deposits." };
  }

  const patterns = recurring.map((c) => {
    // Use the mode (most common single day), not the mean — a single
    // weekend/holiday shift shouldn't drag a clean pattern off-center.
    const counts = new Map();
    for (const e of c.entries) {
      const d = new Date(e.date + "T12:00:00").getDate();
      counts.set(d, (counts.get(d) || 0) + 1);
    }
    const modeDay = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];

    // Learn the employer's actual shift convention from evidence: for each
    // real payment, check whether the "natural" date (modeDay applied to
    // that occurrence's month) would have landed on a weekend/holiday, and
    // if so, which direction the real payment actually shifted.
    let beforeVotes = 0, afterVotes = 0;
    for (const e of c.entries) {
      const d = new Date(e.date + "T12:00:00");
      const naturalDate = new Date(d.getFullYear(), d.getMonth(), modeDay);
      const naturalStr = naturalDate.toISOString().slice(0, 10);
      if (isWeekendOrHoliday(naturalStr) && naturalStr !== e.date) {
        if (e.date < naturalStr) beforeVotes++;
        else if (e.date > naturalStr) afterVotes++;
      }
    }
    // Default to "before" (the more common convention) when there's no
    // direct evidence either way in this person's own history yet.
    const shiftDirection = afterVotes > beforeVotes ? "after" : "before";

    const amounts = c.entries.map((e) => e.amount);
    const avgAmount = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const amtVariance = amounts.reduce((s, a) => s + (a - avgAmount) ** 2, 0) / amounts.length;
    const amtStdev = Math.sqrt(amtVariance);
    // Only worth showing as a range if the variance is meaningful relative
    // to the average — a salaried paycheck that's identical every time
    // should show as one clean number, not a manufactured range.
    const isVariable = avgAmount > 0 && amtStdev / avgAmount > 0.05;

    return {
      dayOfMonth: modeDay,
      avgAmount: Math.round(avgAmount),
      amountLow: isVariable ? Math.round(Math.max(avgAmount - amtStdev, 0)) : Math.round(avgAmount),
      amountHigh: isVariable ? Math.round(avgAmount + amtStdev) : Math.round(avgAmount),
      isVariable,
      shiftDirection
    };
  });

  const endDate = new Date(today); endDate.setDate(endDate.getDate() + weeksAhead * 7);

  const predicted = [];
  let cursor = new Date(today.getFullYear(), today.getMonth(), 1);
  for (let m = 0; m < 3; m++) {
    for (const p of patterns) {
      const lastDayOfCursorMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
      const naturalDate = new Date(cursor.getFullYear(), cursor.getMonth(), Math.min(p.dayOfMonth, lastDayOfCursorMonth));
      let dateStr = naturalDate.toISOString().slice(0, 10);
      const wasShifted = isWeekendOrHoliday(dateStr);
      if (wasShifted) dateStr = shiftToBusinessDay(dateStr, p.shiftDirection);

      if (dateStr >= today.toISOString().slice(0, 10) && dateStr <= endDate.toISOString().slice(0, 10)) {
        predicted.push({
          date: dateStr,
          expectedAmount: p.avgAmount,
          amountLow: p.amountLow,
          amountHigh: p.amountHigh,
          isVariable: p.isVariable,
          wasShifted
        });
      }
    }
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  }
  predicted.sort((a, b) => a.date.localeCompare(b.date));

  return { available: predicted.length > 0, paydays: predicted };
}

function predictBillsInWindow(transactions, startDate, endDate) {
  const byMerchant = new Map();
  for (const tx of transactions) {
    if (tx.amount >= 0 || tx.needWant !== "need" || NON_SPEND_CATEGORIES.has(tx.category)) continue;
    const m = tx.merchant || tx.description;
    if (!byMerchant.has(m)) byMerchant.set(m, []);
    byMerchant.get(m).push(tx);
  }

  const results = [];
  for (const [merchant, txs] of byMerchant) {
    if (txs.length < 2) continue;
    const sorted = [...txs].sort((a, b) => a.date.localeCompare(b.date));
    const gaps = [];
    for (let i = 1; i < sorted.length; i++) gaps.push(daysBetween(sorted[i].date, sorted[i - 1].date));
    const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    if (avgGap < 20) continue;
    const gapStdev = Math.sqrt(gaps.reduce((s, g) => s + (g - avgGap) ** 2, 0) / gaps.length);
    if (gapStdev / avgGap > 0.5) continue;

    const last = sorted.at(-1);
    // A bill that's gone quiet for well beyond its own typical interval is
    // probably no longer active — moved, switched providers, paid off,
    // canceled, whatever the reason. This is proportional to the bill's own
    // rhythm (not a fixed day count), since "quiet too long" means
    // something different for a monthly bill than a quarterly one.
    if (daysBetween(startDate, last.date) > avgGap * 2) continue;

    let expectedNext = new Date(last.date);
    for (let i = 0; i < 6; i++) {
      if (expectedNext >= new Date(startDate)) break;
      expectedNext = new Date(expectedNext); expectedNext.setDate(expectedNext.getDate() + Math.round(avgGap));
    }
    if (expectedNext >= new Date(startDate) && expectedNext < new Date(endDate)) {
      const range = amountRange(sorted.map((tx) => Math.abs(tx.amount)));
      results.push({
        merchant,
        amount: Math.round(Math.abs(last.amount)),
        amountLow: range.low, amountHigh: range.high, isVariable: range.isVariable,
        expectedDate: expectedNext.toISOString().slice(0, 10)
      });
    }
  }

  return results.sort((a, b) => a.expectedDate.localeCompare(b.expectedDate));
}

/**
 * Builds the rolling "next N weeks" paycheck-to-paycheck timeline: segments
 * between predicted paydays, each with expected income, bills expected due
 * in that window, and a simple "room to work with" figure. Naturally comes
 * out weekly-ish for a two-income household and biweekly/monthly for a
 * single earner, without ever needing to detect or label "the cycle."
 */
export function buildPaycheckTimeline(transactions, weeksAhead = 4, previousJobLastPaycheckDate = null) {
  const paydayResult = predictUpcomingPaydays(transactions, weeksAhead, previousJobLastPaycheckDate);
  if (!paydayResult.available) return { available: false, reason: paydayResult.reason };

  const today = new Date().toISOString().slice(0, 10);

  // The very first segment (today until the next predicted payday) isn't
  // "new" income — it's money already received from the most recent actual
  // payday(s), still being spent down. Find those so the first segment
  // reflects real current standing instead of showing $0.
  const incomeTx = transactions.filter((tx) => tx.amount > 0 && tx.category === "Income" && tx.date < today);
  const last30 = incomeTx.filter((tx) => daysBetween(today, tx.date) <= 20).sort((a, b) => b.date.localeCompare(a.date));
  const onHandAmount = Math.round(last30.reduce((s, tx) => s + tx.amount, 0));

  const boundaries = [today, ...paydayResult.paydays.map((p) => p.date)];
  const uniqueBoundaries = [...new Set(boundaries)].sort();

  const segments = [];
  for (let i = 0; i < uniqueBoundaries.length; i++) {
    const start = uniqueBoundaries[i];
    const end = uniqueBoundaries[i + 1] || (() => {
      const d = new Date(start); d.setDate(d.getDate() + 14); return d.toISOString().slice(0, 10);
    })();
    if (start === end) continue;

    const paydaysInSegment = paydayResult.paydays.filter((p) => p.date >= start && p.date < end);
    const isFirstSegment = i === 0;
    const incomeExpected = isFirstSegment
      ? onHandAmount + paydaysInSegment.reduce((s, p) => s + p.expectedAmount, 0)
      : paydaysInSegment.reduce((s, p) => s + p.expectedAmount, 0);
    const incomeLow = isFirstSegment
      ? onHandAmount + paydaysInSegment.reduce((s, p) => s + p.amountLow, 0)
      : paydaysInSegment.reduce((s, p) => s + p.amountLow, 0);
    const incomeHigh = isFirstSegment
      ? onHandAmount + paydaysInSegment.reduce((s, p) => s + p.amountHigh, 0)
      : paydaysInSegment.reduce((s, p) => s + p.amountHigh, 0);
    const hasVariableIncome = paydaysInSegment.some((p) => p.isVariable);
    const bills = predictBillsInWindow(transactions, start, end);
    const billsTotal = bills.reduce((s, b) => s + b.amount, 0);
    const billsLow = bills.reduce((s, b) => s + b.amountLow, 0);
    const billsHigh = bills.reduce((s, b) => s + b.amountHigh, 0);
    const hasVariableBills = bills.some((b) => b.isVariable);

    segments.push({
      start,
      end,
      isFirstSegment,
      alreadyOnHand: isFirstSegment ? onHandAmount : 0,
      paydaysInSegment,
      incomeExpected,
      incomeLow,
      incomeHigh,
      hasVariableIncome,
      bills,
      billsTotal,
      billsLow,
      billsHigh,
      hasVariableBills,
      roomToWorkWith: Math.round(incomeExpected - billsTotal),
      // Conservative (roomLow) assumes the worst realistic case: income
      // comes in low AND bills come in high. Comfortable (roomHigh) assumes
      // the opposite. Genuinely bill-specific, not a flat discount.
      roomLow: Math.round(incomeLow - billsHigh),
      roomHigh: Math.round(incomeHigh - billsLow)
    });
  }

  return { available: true, segments, weeksAhead };
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
/**
 * Flags a want-merchant where visit COUNT has jumped, not just dollar
 * total — frequency is often a more honest signal of a forming habit than
 * a dollar figure, which can be muddied by one big purchase. Uses the same
 * detected pay-cycle length as pace comparisons, for the same reason.
 */
export function visitFrequencyChange(transactions, windowDays) {
  const cycle = detectPayCycle(transactions, windowDays);
  const cycleDays = cycle ? Math.round(cycle.avgGapDays) : 30;

  const now = new Date();
  const currentStart = new Date(now); currentStart.setDate(currentStart.getDate() - cycleDays);
  const previousStart = new Date(now); previousStart.setDate(previousStart.getDate() - cycleDays * 2);

  const wantSpend = transactions.filter((tx) => tx.needWant === "want" && isSpendTx(tx));
  const oldestDate = wantSpend.reduce((min, tx) => (tx.date < min ? tx.date : min), wantSpend[0]?.date || null);
  if (!oldestDate || daysBetween(new Date(), oldestDate) < cycleDays * 2) {
    return { available: false, reason: `Need at least two ${cycleDays}-day cycles of history to compare visit frequency.` };
  }

  const byMerchant = new Map();
  for (const tx of wantSpend) {
    const d = new Date(tx.date);
    const bucket = d >= currentStart ? "current" : (d >= previousStart ? "previous" : null);
    if (!bucket) continue;
    const m = tx.merchant || (tx.description || "").slice(0, 40);
    if (!byMerchant.has(m)) byMerchant.set(m, { current: 0, previous: 0 });
    byMerchant.get(m)[bucket]++;
  }

  const candidates = [...byMerchant.entries()]
    .map(([merchant, v]) => ({ merchant, currentVisits: v.current, previousVisits: v.previous, deltaVisits: v.current - v.previous }))
    .filter((c) => c.previousVisits >= 1 && c.deltaVisits >= 2) // meaningful jump, not noise
    .sort((a, b) => b.deltaVisits - a.deltaVisits);

  if (!candidates.length) {
    return { available: false, reason: "No meaningful increase in visit frequency detected right now." };
  }

  const top = candidates[0];
  const cyclePeriod = cycleDays >= 25 ? "month" : cycleDays >= 12 ? "two weeks" : "week";

  return {
    available: true,
    merchant: top.merchant,
    currentVisits: top.currentVisits,
    previousVisits: top.previousVisits,
    deltaVisits: top.deltaVisits,
    cycleDays,
    summary: `You've visited ${top.merchant} ${top.currentVisits} times this ${cyclePeriod}, up from ${top.previousVisits} last cycle — worth noticing, whatever the reason.`
  };
}

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

  const byMerchant = new Map();
  for (const tx of spend) {
    const d = new Date(tx.date);
    const bucket = d >= currentStart ? "current" : (d >= previousStart ? "previous" : null);
    if (!bucket) continue;
    const m = tx.merchant || (tx.description || "").slice(0, 40);
    if (!byMerchant.has(m)) byMerchant.set(m, { current: 0, previous: 0 });
    byMerchant.get(m)[bucket] += Math.abs(tx.amount);
  }

  const merchants = [...byMerchant.entries()].map(([merchant, v]) => {
    const deltaAmt = Math.round(v.current - v.previous);
    const deltaPct = v.previous > 0 ? Math.round(((v.current - v.previous) / v.previous) * 100) : (v.current > 0 ? 100 : null);
    return { merchant, currentAmt: Math.round(v.current), previousAmt: Math.round(v.previous), deltaAmt, deltaPct };
  }).sort((a, b) => Math.abs(b.deltaAmt) - Math.abs(a.deltaAmt));

  return { available: true, cycleDays, usedDetectedCycle: Boolean(cycle), merchants };
}

/**
 * Finds the merchant with the biggest spending increase vs. the previous
 * pay cycle, among merchants confirmed as "want" spending. No guideline
 * comparison — just "what's trending up the most right now" — since there's
 * no reasonable "normal %" for an individual merchant the way there is for
 * a category. Names the actual merchant (e.g. "Fixxology"), which is more
 * actionable than a category bucket anyway.
 */
export function worstOffendingWantMerchant(transactions, windowDays) {
  const pace = paceComparison(transactions, windowDays);
  if (!pace.available) return { available: false, reason: pace.reason };

  const wantMerchants = new Set(
    transactions.filter((tx) => tx.needWant === "want" && isSpendTx(tx)).map((tx) => tx.merchant || (tx.description || "").slice(0, 40))
  );

  const candidates = pace.merchants.filter((m) => wantMerchants.has(m.merchant) && m.currentAmt > 0 && m.deltaAmt > 5);
  if (!candidates.length) {
    return { available: false, reason: "No want merchant is trending up right now." };
  }

  candidates.sort((a, b) => b.deltaAmt - a.deltaAmt);
  const worst = candidates[0];
  const cyclePeriod = pace.cycleDays >= 25 ? "month" : pace.cycleDays >= 12 ? "two weeks" : "week";

  return {
    available: true,
    merchant: worst.merchant,
    currentAmt: worst.currentAmt,
    previousAmt: worst.previousAmt,
    deltaAmt: worst.deltaAmt,
    deltaPct: worst.deltaPct,
    cycleDays: pace.cycleDays,
    summary: `${worst.merchant}: ${fmtMoney(worst.currentAmt)} this ${cyclePeriod}, up ${fmtMoney(worst.deltaAmt)} (${fmtPct(worst.deltaPct)}) from your last cycle.`
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
/**
 * Groups historical debit transactions by merchant to find recurring,
 * roughly-monthly-or-longer bills (average gap ≥20 days, reasonably
 * regular), then buckets each into "already happened this cycle" or
 * "expected before next payday but hasn't happened yet." This is the data
 * behind the Safe Spending Until Payday transparency dropdown — showing the
 * actual detected bills, not just a number, so the person can see for
 * themselves whether anything's missing from the calculation.
 */
/**
 * Shared variance-aware range helper: a bill (or paycheck) that's been
 * consistent historically gets a clean single number; one that's genuinely
 * varied gets an honest range instead of a false-precision point estimate.
 */
function amountRange(amounts) {
  const avg = amounts.reduce((a, b) => a + b, 0) / amounts.length;
  const variance = amounts.reduce((s, a) => s + (a - avg) ** 2, 0) / amounts.length;
  const stdev = Math.sqrt(variance);
  const isVariable = avg > 0 && stdev / avg > 0.05;
  return {
    typical: Math.round(avg),
    low: isVariable ? Math.round(Math.max(avg - stdev, 0)) : Math.round(avg),
    high: isVariable ? Math.round(avg + stdev) : Math.round(avg),
    isVariable
  };
}

/**
 * Tiered options for how much to set aside toward the Safety Net this
 * cycle — Easy Win / Solid Progress / Fast Track — scaled off typical
 * wants spending for the cycle, same percentage basis as the Safety Net
 * Builder Suggestions cut tiers, just applied to "redirect this much"
 * instead of "cut this merchant by this much."
 *
 * Below 3 months covered: treated as urgent — the caller bakes a default
 * tier's amount directly into Safe Spending Until Payday, same as a Need,
 * so the number shown is genuinely already safe once wants spending is
 * done. 3–6 months: still encouraged, shown as an option rather than
 * pre-reserved. 6+ months: goal reached, not pushed.
 */
export function safetyNetReservationSuggestions(transactions, monthsCovered) {
  if (monthsCovered != null && monthsCovered >= 6) {
    return { applicable: false, isUrgent: false, reason: "Six months covered — Safety Net goal already reached. Contributions from here are optional." };
  }

  const cycle = detectPayCycle(transactions, 180);
  const cycleDays = cycle ? Math.round(cycle.avgGapDays) : 30;
  const now = new Date();
  const cycleStart = new Date(now); cycleStart.setDate(cycleStart.getDate() - cycleDays);

  const wantsSpend = transactions
    .filter((tx) => tx.amount < 0 && tx.needWant === "want" && !tx.isOneTime && !NON_SPEND_CATEGORIES.has(tx.category) && new Date(tx.date) >= cycleStart)
    .reduce((s, tx) => s + Math.abs(tx.amount), 0);

  const isUrgent = monthsCovered == null || monthsCovered < 3;

  if (wantsSpend < 20) {
    return { applicable: false, isUrgent, reason: "Not enough typical wants spending detected yet to suggest a reservation amount." };
  }

  const cyclePeriod = cycleDays >= 25 ? "month" : cycleDays >= 12 ? "two weeks" : "week";

  const tiers = [
    { key: "easy", label: "Easy Win", tagline: "This won't hurt.", pct: 0.10 },
    { key: "solid", label: "Solid Progress", tagline: "I'm making real headway.", pct: 0.25 },
    { key: "fast", label: "Fast Track", tagline: "I want to reach my goal sooner.", pct: 0.40 }
  ].map((t) => ({ ...t, amount: Math.round(wantsSpend * t.pct) }));

  return { applicable: true, isUrgent, cyclePeriod, cycleDays, wantsSpend: Math.round(wantsSpend), tiers, defaultTier: tiers[0] };
}

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
    // Same staleness safeguard as the timeline predictor — a bill quiet for
    // well beyond its own typical interval is probably no longer active.
    if (daysBetween(now, last.date) > avgGap * 2) continue;
    const expectedNext = new Date(lastDate); expectedNext.setDate(expectedNext.getDate() + Math.round(avgGap));

    const range = amountRange(sorted.map((tx) => Math.abs(tx.amount)));
    const entry = {
      merchant, category: last.category,
      amount: Math.round(Math.abs(last.amount)),
      amountLow: range.low, amountHigh: range.high, isVariable: range.isVariable,
      lastDate: last.date, avgGapDays: Math.round(avgGap)
    };

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
  // Conservative end assumes every variable bill comes in at its own
  // historical high; comfortable end assumes typical/low — genuinely
  // bill-specific, not one flat discount applied across everything.
  const expectedBillsHigh = bills.expectedNotYetPaid.reduce((s, b) => s + b.amountHigh, 0);
  const expectedBillsLow = bills.expectedNotYetPaid.reduce((s, b) => s + b.amountLow, 0);

  if (!incomeSoFar) {
    return { available: false, reason: "Add income transactions to estimate safe spending until payday.", bills };
  }

  const conservative = incomeSoFar - spentSoFar - expectedBillsHigh;
  const comfortable = incomeSoFar - spentSoFar - expectedBillsLow;

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
 * Overall wants spending as a % of income, using the Careful/Standard/
 * Generous tiers. This is the always-visible headline badge.
 */
/**
 * Needs as a % of income — purely informational, no guideline/tier judgment
 * attached, since there's no "cut this" advice to give about needs the way
 * there is for wants. Still valuable to see plainly: if needs alone eat
 * most of income, that's important context no amount of trimming wants can
 * fully solve.
 */
export function overallNeedsShare(transactions, windowDays = 30) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);

  const needs = transactions.filter((tx) =>
    tx.amount < 0 && tx.needWant === "need" && !tx.isOneTime && !NON_SPEND_CATEGORIES.has(tx.category) && inWindow(tx, cutoff)
  );
  const needsTotal = needs.reduce((s, tx) => s + Math.abs(tx.amount), 0);
  const monthlyIncome = estimateMonthlyIncome(transactions, windowDays);

  if (!monthlyIncome) {
    return { available: false, reason: "Add income transactions to see needs as a share of income." };
  }

  const spanMonths = Math.max(Math.min(windowDays, daysBetween(new Date(), cutoff)) / 30, 0.1);
  const monthlyNeeds = needsTotal / spanMonths;
  const pctOfIncome = Math.round((monthlyNeeds / monthlyIncome) * 100);

  return { available: true, monthlyNeeds: Math.round(monthlyNeeds), pctOfIncome, remainingPct: Math.max(100 - pctOfIncome, 0) };
}

// Keyword patterns for fee-type charges — matched directly against the
// transaction description, not category, so this works regardless of
// whether a merchant rule happens to recognize the specific bank's wording.
const FEE_PATTERNS = {
  "ATM Fee": /atm (fee|w\/d)/i,
  "Overdraft Fee": /overdraft|nsf fee|insufficient funds/i,
  "Late Fee": /late fee|late payment/i,
  "Interest Charged": /interest (charge|charged)|finance charge/i
};

/**
 * Totals up fee-type charges (ATM, overdraft, late, interest) by matching
 * description keywords directly — no category dependency, works the same
 * regardless of how any given bank labels these.
 */
export function feesSummary(transactions, windowDays = 90) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);

  const byType = {};
  let total = 0;
  for (const tx of transactions) {
    if (tx.amount >= 0) continue;
    if (!inWindow(tx, cutoff)) continue;
    for (const [label, re] of Object.entries(FEE_PATTERNS)) {
      if (re.test(tx.description || "")) {
        const amt = Math.abs(tx.amount);
        byType[label] = (byType[label] || 0) + amt;
        total += amt;
        break; // don't double-count a single charge against multiple fee types
      }
    }
  }

  const items = Object.entries(byType).map(([label, amt]) => ({ label, amount: Math.round(amt) })).sort((a, b) => b.amount - a.amount);
  return { available: items.length > 0, total: Math.round(total), items, windowDays };
}

/**
 * Average days between purchases at each merchant — "Merchant Velocity."
 * Needs 3+ purchases from a merchant to compute a meaningful average gap.
 */
export function merchantVelocity(transactions, topN = 10) {
  const spend = transactions.filter(isSpendTx).sort((a, b) => a.date.localeCompare(b.date));
  const byMerchant = new Map();
  for (const tx of spend) {
    const m = tx.merchant || (tx.description || "").slice(0, 40);
    if (!byMerchant.has(m)) byMerchant.set(m, []);
    byMerchant.get(m).push(tx.date);
  }

  const results = [];
  for (const [merchant, dates] of byMerchant) {
    if (dates.length < 3) continue;
    const gaps = [];
    for (let i = 1; i < dates.length; i++) gaps.push(daysBetween(dates[i], dates[i - 1]));
    const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    results.push({ merchant, avgDays: Math.round(avgGap * 10) / 10, count: dates.length });
  }

  results.sort((a, b) => a.avgDays - b.avgDays); // most frequent first
  return { available: results.length > 0, items: results.slice(0, topN) };
}

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
 * Top want-merchant per calendar month, for the last N months — feeds the
 * "View history" toggle under the worst-offender alert. Collapsed/opt-in by
 * design: the headline stays focused on right now, history is a click away
 * for anyone who wants it, not competing for attention by default.
 */
export function topWantMerchantByMonth(transactions, monthsBack = 6) {
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
    const byMerchant = new Map();
    for (const tx of wants) {
      const m = tx.merchant || (tx.description || "").slice(0, 40);
      byMerchant.set(m, (byMerchant.get(m) || 0) + Math.abs(tx.amount));
    }
    const sorted = [...byMerchant.entries()].sort((a, b) => b[1] - a[1]);

    if (!sorted.length) {
      results.push({ label, available: false });
      continue;
    }
    const [topMerchant, amount] = sorted[0];
    const pctOfIncome = income > 0 ? Math.round((amount / income) * 100) : null;
    results.push({ label, available: true, topMerchant, amount: Math.round(amount), pctOfIncome });
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

const SAFETY_NET_STARTER_GOAL = 1000; // a common "starter emergency fund" benchmark
const CUT_TIERS = [
  { key: "small", label: "Small", pct: 0.10 },
  { key: "medium", label: "Medium", pct: 0.25 },
  { key: "large", label: "Large", pct: 0.50 }
];
const MIN_MONTHLY_FREED = 5; // lower floor than before, since the "small" tier is intentionally modest
const MAX_MONTHS_TO_GOAL = 36;

/**
 * Generates "cut spending at merchant X by [small/medium/large] → frees
 * $Y/cycle → reaches a $1,000 starter emergency fund in Z months" options,
 * one set per top want-merchant from the previous pay cycle — three
 * aggressiveness levels per merchant so the person picks how much they want
 * to change, not just one fixed number. Uses the person's own detected
 * pay-cycle length (weekly/biweekly/monthly) rather than calendar months —
 * most people living paycheck to paycheck think in terms of "until my next
 * payday," not "this calendar month." A tier is dropped (not just flagged)
 * if this cycle's spending has already exceeded what that tier's reduced
 * target would allow — no point suggesting a cut that's already off the
 * table for this cycle, though a smaller tier might still be reachable even
 * when a larger one isn't.
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
  const merchantOf = (tx) => tx.merchant || (tx.description || "").slice(0, 40);

  const wantsByMerchant = new Map();
  for (const tx of previousCycleTx) if (isWantSpend(tx)) {
    const m = merchantOf(tx);
    wantsByMerchant.set(m, (wantsByMerchant.get(m) || 0) + Math.abs(tx.amount));
  }

  const currentByMerchant = new Map();
  for (const tx of currentCycleTx) if (isWantSpend(tx)) {
    const m = merchantOf(tx);
    currentByMerchant.set(m, (currentByMerchant.get(m) || 0) + Math.abs(tx.amount));
  }

  const cyclePeriod = cycleDays >= 25 ? "month" : cycleDays >= 12 ? "two weeks" : "week";
  const candidates = [];

  for (const [merchant, baselineAmt] of wantsByMerchant) {
    const currentAmt = currentByMerchant.get(merchant) || 0;
    const monthlyEquivBaseline = baselineAmt * (30 / cycleDays);

    const tiers = [];
    for (const t of CUT_TIERS) {
      const freedAmt = baselineAmt * t.pct; // per cycle
      const monthlyEquivFreed = monthlyEquivBaseline * t.pct;
      if (monthlyEquivFreed < MIN_MONTHLY_FREED) continue;

      const monthsToGoal = Math.ceil(SAFETY_NET_STARTER_GOAL / monthlyEquivFreed);
      if (monthsToGoal > MAX_MONTHS_TO_GOAL) continue;

      const reducedTarget = baselineAmt * (1 - t.pct);
      const reachable = currentAmt <= reducedTarget;

      tiers.push({
        tier: t.key,
        label: t.label,
        cutPct: Math.round(t.pct * 100),
        freedAmt: Math.round(freedAmt),
        monthsToGoal,
        reachable
      });
    }

    // Only worth surfacing this merchant if at least the smallest tier is
    // still realistic this cycle — no point offering three options when
    // even the gentlest one is already off the table.
    if (!tiers.length || !tiers[0].reachable) continue;

    candidates.push({
      merchant,
      baselineAmt: Math.round(baselineAmt),
      currentAmt: Math.round(currentAmt),
      cycleDays,
      cyclePeriod,
      tiers
    });
  }

  candidates.sort((a, b) => b.baselineAmt - a.baselineAmt);
  const top = candidates.slice(0, 3);

  return {
    available: top.length > 0,
    suggestions: top,
    goal: SAFETY_NET_STARTER_GOAL,
    reason: top.length ? null : "No want merchant has meaningful room to cut this month, or the realistic cuts are already used up for this cycle."
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
  const isWantSpend = (tx) => tx.amount < 0 && tx.needWant === "want" && !NON_SPEND_CATEGORIES.has(tx.category);

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
  const deltaWants = sumIn(currentStart, now, isWantSpend) - avgOver(isWantSpend);
  const deltaSavingsOrUnspent = deltaIncome - deltaNeeds - deltaWants;

  const cyclePeriod = cycleDays >= 25 ? "month" : cycleDays >= 12 ? "two weeks" : "week";
  const parts = [];
  if (Math.abs(deltaWants) >= 10) parts.push(`${fmtMoney(deltaWants)} to wants`);
  if (Math.abs(deltaNeeds) >= 10) parts.push(`${fmtMoney(deltaNeeds)} to needs/bills`);
  if (Math.abs(deltaSavingsOrUnspent) >= 10) parts.push(`${fmtMoney(deltaSavingsOrUnspent)} to savings or left unspent`);

  return {
    available: true,
    cycleDays,
    deltaIncome: Math.round(deltaIncome),
    deltaNeeds: Math.round(deltaNeeds),
    deltaWants: Math.round(deltaWants),
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
  const anomalies = detectAnomalies(transactions, windowDays);
  const sprees = detectSpendingSprees(transactions, windowDays);
  const pace = paceComparison(transactions, windowDays);
  const worstOffender = worstOffendingWantMerchant(transactions, windowDays);

  const summaries = [];
  if (dayOfWeek.available && dayOfWeek.summary) summaries.push(dayOfWeek.summary);
  if (payday.available && payday.summary) summaries.push(payday.summary);

  if (worstOffender.available) summaries.push(worstOffender.summary);

  if (anomalies.available) {
    summaries.push(`${anomalies.anomalies.length} charge${anomalies.anomalies.length > 1 ? "s stand" : " stands"} out as unusually high compared to your normal spending at that merchant.`);
  }

  if (sprees.available) {
    summaries.push(`${sprees.sprees.length} spending cluster${sprees.sprees.length > 1 ? "s" : ""} detected — 3+ discretionary purchases within 48 hours of each other.`);
  }

  return { dayOfWeek, payday, anomalies, sprees, pace, worstOffender, summaries, windowDays };
}
