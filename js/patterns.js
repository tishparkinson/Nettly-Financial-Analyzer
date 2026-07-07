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
 * Detects recurring "payday" deposits and compares spend in the days right
 * after payday vs. the rest of the pay cycle. Needs at least 3 confidently-
 * spaced income deposits to report — irregular income is left alone rather
 * than forcing a pattern onto it.
 */
export function paydayProximityEffect(transactions, windowDays, proximityDays = 3) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);

  const incomeTx = transactions
    .filter((tx) => tx.amount > 0 && tx.category === "Income" && inWindow(tx, cutoff))
    .sort((a, b) => a.date.localeCompare(b.date));

  if (incomeTx.length < 3) {
    return { available: false, reason: "Need at least 3 paycheck-style deposits in this window to detect a payday pattern." };
  }

  const gaps = [];
  for (let i = 1; i < incomeTx.length; i++) {
    gaps.push(daysBetween(incomeTx[i].date, incomeTx[i - 1].date));
  }
  const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const gapVariance = gaps.reduce((s, g) => s + (g - avgGap) ** 2, 0) / gaps.length;
  const gapStdev = Math.sqrt(gapVariance);

  if (avgGap === 0 || gapStdev / avgGap > 0.4) {
    return { available: false, reason: "Income deposits don't land on a regular enough schedule yet to detect a payday effect." };
  }

  const paydays = incomeTx.map((tx) => tx.date);
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
    avgGapDays: Math.round(avgGap),
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

  function shareByCategory(txs) {
    const total = txs.reduce((s, tx) => s + Math.abs(tx.amount), 0) || 1;
    const byCat = new Map();
    for (const tx of txs) byCat.set(tx.category, (byCat.get(tx.category) || 0) + Math.abs(tx.amount));
    const shares = new Map();
    for (const [cat, amt] of byCat) shares.set(cat, (amt / total) * 100);
    return shares;
  }

  const firstShares = shareByCategory(firstHalf);
  const secondShares = shareByCategory(secondHalf);
  const categories = new Set([...firstShares.keys(), ...secondShares.keys()]);

  const drift = [];
  for (const cat of categories) {
    const before = firstShares.get(cat) || 0;
    const after = secondShares.get(cat) || 0;
    drift.push({ category: cat, sharePctBefore: Math.round(before), sharePctAfter: Math.round(after), deltaPts: Math.round(after - before) });
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
    merchants: [...new Set(cluster.map((tx) => tx.merchant || tx.description.slice(0, 30)))]
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

  const summaries = [];
  if (dayOfWeek.available && dayOfWeek.summary) summaries.push(dayOfWeek.summary);
  if (payday.available && payday.summary) summaries.push(payday.summary);

  if (trends.available) {
    const top = trends.trends.find((t) => t.pctChange != null && Math.abs(t.pctChange) >= 15);
    if (top) {
      summaries.push(`${top.category} spending is ${fmtPct(top.pctChange)} ${top.pctChange >= 0 ? "higher" : "lower"} this month vs. your recent average.`);
    }
  }

  if (drift.available) {
    const top = drift.drift.find((d) => Math.abs(d.deltaPts) >= 5);
    if (top) {
      summaries.push(`${top.category} has gone from ${top.sharePctBefore}% to ${top.sharePctAfter}% of your total spending over this window.`);
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

  return { dayOfWeek, payday, trends, drift, volatility, anomalies, sprees, summaries, windowDays };
}
