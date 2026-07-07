import { CATEGORIES, DEFAULT_TAGS, CLOTHING_TAGS, TRANSPORTATION_TAGS, ATM_CASH_TAGS, normalizeMerchant, BUDGET_GUIDELINES, getSpendingTier } from "./categories.js";
import { parseTransactions, dedupeTransactions } from "./parser.js";
import {
  applyCategories,
  merchantsNeedingReview,
  averageNeedsSpending,
  averageTotalSpending,
  computeMonthsCovered,
  needsVsWants,
  detectRecurring,
  detectRecurring45,
  subscriptionSummary,
  stabilityLabel,
  simpleInsights,
  updateStreaks,
  updateRecords,
  tagSummaries,
  uncategorizedSummary,
  cashGapSummary,
  completeFinancialPicture,
  computeGrowthStreak
} from "./analytics.js";
import {
  analyzeSpendingPatterns,
  overallWantsTier,
  worstOffendingWantCategory,
  topWantCategoryByMonth,
  overallWantsTierByMonth,
  convenienceTax,
  safetyNetBuilderSuggestions,
  incomeAllocationTrend,
  smallPurchaseBlindness,
  detectSpendingSprees,
  safeSpendingUntilPayday
} from "./patterns.js";
import {
  loadState,
  saveState,
  clearState,
  importSnapshot,
  downloadSnapshot,
  computeSafetyNetBalance,
  defaultState
} from "./store.js";
import { ensureAccess, unlockWithKey } from "./access.js";

let state = loadState();
let pendingPaste = [];
let overlapFlag = false;
let activeTag = null;

const screens = {
  gate: document.getElementById("screen-gate"),
  home: document.getElementById("screen-home"),
  upload: document.getElementById("screen-upload"),
  merchants: document.getElementById("screen-merchants"),
  review: document.getElementById("screen-review"),
  safety: document.getElementById("screen-safety"),
  dashboard: document.getElementById("screen-dashboard")
};

function show(name) {
  Object.values(screens).forEach((el) => el && el.classList.remove("active"));
  if (screens[name]) screens[name].classList.add("active");
  if (name === "upload") {
    updateLastImportedHint();
    const hint = document.getElementById("cutoff-date-hint");
    if (hint) {
      const d = new Date();
      d.setDate(d.getDate() - 45);
      const label = d.toLocaleDateString("en-US", { month: "long", day: "numeric" });
      hint.textContent = label;
    }
  }
  window.scrollTo(0, 0);
}

function fmtMoney(n) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n || 0);
}

function fmtMonths(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(1);
}

function getFilteredTransactions() {
  return state.transactions;
}

// --- Gate ---
document.getElementById("btn-unlock-key").addEventListener("click", async () => {
  const gateError = document.getElementById("gate-error");
  gateError.classList.add("hidden");
  const input = document.getElementById("access-key-input");
  const btn = document.getElementById("btn-unlock-key");
  btn.disabled = true;
  btn.textContent = "Checking…";

  const result = await unlockWithKey(input.value);
  btn.disabled = false;
  btn.textContent = "Unlock Nettly";

  if (!result.ok) {
    gateError.textContent = result.error;
    gateError.classList.remove("hidden");
    return;
  }

  await bootApp(true);
});

document.getElementById("access-key-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    document.getElementById("btn-unlock-key").click();
  }
});

// --- Home ---
document.getElementById("btn-new").addEventListener("click", () => {
  state = defaultState();
  state.startedAt = new Date().toISOString();
  pendingPaste = [];
  saveState(state);
  show("upload");
});

document.getElementById("btn-continue").addEventListener("click", () => {
  document.getElementById("snapshot-upload").click();
});

document.getElementById("snapshot-upload").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    state = importSnapshot(data);
    saveState(state);
    if (state.transactions.length) {
      renderDashboard();
      show("dashboard");
    } else {
      show("upload");
    }
  } catch {
    alert("Could not read snapshot. Please choose a valid .ntly file.");
  }
  e.target.value = "";
});

document.getElementById("link-home-footer").addEventListener("click", (e) => {
  e.preventDefault();
  show("home");
});

// --- Upload ---
document.getElementById("btn-upload-back").addEventListener("click", () => show("home"));

document.getElementById("btn-upload-start-over").addEventListener("click", () => {
  if (!confirm("Clear everything and start fresh? This removes all accounts and transactions you\'ve added.")) return;
  state = defaultState();
  pendingPaste = [];
  overlapFlag = false;
  saveState(state);
  document.getElementById("acct-nickname").value = "";
  document.getElementById("paste-tx").value = "";
  document.getElementById("pending-accounts").classList.add("hidden");
  document.getElementById("account-list").innerHTML = "";
  show("home");
});

const ATM_CASH_ALERT_TEXT =
  "💵 This money is about to go off the grid.\n\nLog what you buy with it, or it disappears from your picture entirely.";

function maybeShowAtmCashAlert(categoriesInvolved) {
  const list = Array.isArray(categoriesInvolved) ? categoriesInvolved : [categoriesInvolved];
  if (list.includes("ATM Withdrawal / Cash")) {
    alert(ATM_CASH_ALERT_TEXT);
  }
}

// Keep the nickname field pre-filled with a sensible default (matching the
// selected account type) unless the person has typed their own name — a
// real default beats an empty field with a placeholder that vanishes.
let nicknameWasAutoFilled = true;
document.getElementById("acct-type")?.addEventListener("change", (e) => {
  const nicknameInput = document.getElementById("acct-nickname");
  if (nicknameInput && nicknameWasAutoFilled) {
    nicknameInput.value = e.target.value;
  }
  updateLastImportedHint();
});
document.getElementById("acct-nickname")?.addEventListener("input", (e) => {
  nicknameWasAutoFilled = false;
  updateLastImportedHint();
});

function updateLastImportedHint() {
  const nickname = document.getElementById("acct-nickname")?.value.trim();
  const hintEl = document.getElementById("acct-last-imported-hint");
  if (!hintEl) return;
  if (!nickname) { hintEl.textContent = ""; return; }
  const existingTx = state.transactions.filter((tx) => tx.account === nickname);
  if (!existingTx.length) {
    hintEl.textContent = "";
    return;
  }
  const lastDate = existingTx.map((tx) => tx.date).sort().at(-1);
  hintEl.textContent = `You've already added "${nickname}" through ${lastDate} — paste anything from that date forward to pick up where you left off.`;
}

document.getElementById("btn-add-account").addEventListener("click", () => {
  const nickname = document.getElementById("acct-nickname").value.trim();
  const accountType = document.getElementById("acct-type").value;
  const text = document.getElementById("paste-tx").value;
  const last4 = document.getElementById("acct-last4")?.value.trim();
  if (!nickname || !text.trim()) {
    alert("Add an account nickname and paste some transactions.");
    return;
  }
  if (last4) {
    if (!state.accountDigits) state.accountDigits = {};
    state.accountDigits[last4] = { nickname, type: accountType };
  }
  const parsed = parseTransactions(text, nickname, accountType);
  if (!parsed.length) {
    alert("We could not find transactions in that paste. Try including dates and amounts on each line.");
    return;
  }
  pendingPaste.push({ nickname, accountType, transactions: parsed });
  document.getElementById("paste-tx").value = "";
  document.getElementById("acct-last4").value = "";
  saveState(state);
  renderPendingAccounts();
});

/**
 * If the person told us which digits belong to which of their accounts,
 * transfer descriptions like "TRANSFER FROM X0174 TO X3159" can be labeled
 * precisely (Transfer from Savings / Transfer from Checking) instead of
 * falling back to a generic Transfer. High confidence when it matches,
 * since the description is explicit about which account the money came
 * from — untouched (and left to the normal category rules) when it doesn't.
 */
function applyTransferDigitMatching(transactions) {
  const digits = state.accountDigits;
  if (!digits || !Object.keys(digits).length) return transactions;
  const re = /TRANSFER FROM X?(\d{3,6})[^A-Z]{0,20}?TO X?(\d{3,6})/i;
  return transactions.map((tx) => {
    const m = re.exec(tx.description);
    if (!m) return tx;
    const fromAcct = digits[m[1]];
    if (!fromAcct) return tx;
    const cat = fromAcct.type === "Savings" ? "Transfer from Savings"
      : fromAcct.type === "Checking" ? "Transfer from Checking"
      : null;
    if (!cat) return tx;
    return { ...tx, category: cat, confidence: 0.95 };
  });
}

function renderPendingAccounts() {
  const wrap = document.getElementById("pending-accounts");
  const list = document.getElementById("account-list");
  if (!pendingPaste.length) {
    wrap.classList.add("hidden");
    return;
  }
  wrap.classList.remove("hidden");
  list.innerHTML = pendingPaste
    .map((p) => `<li>${p.nickname} (${p.accountType}) — ${p.transactions.length} rows</li>`)
    .join("");
}

document.getElementById("btn-analyze").addEventListener("click", () => {
  if (!pendingPaste.length) return;

  let allNew = [];
  for (const batch of pendingPaste) {
    allNew = allNew.concat(batch.transactions);
    if (!state.accounts.find((a) => a.nickname === batch.nickname)) {
      state.accounts.push({ nickname: batch.nickname, type: batch.accountType });
    }
  }

  const { added, overlapDetected } = dedupeTransactions(state.transactions, allNew);
  overlapFlag = overlapDetected;

  let categorized = applyCategories(added, state.merchantMemory, state.categoryNeedWant);
  categorized = applyTransferDigitMatching(categorized);
  state.transactions = state.transactions.concat(categorized);
  maybeShowAtmCashAlert(categorized.map((tx) => tx.category));

  // Auto-detect recurring transactions before review
  const recurringMap = detectRecurring45(state.transactions);
  state.transactions = state.transactions.map((tx) => {
    const rec = recurringMap.get(tx.id);
    if (rec && !tx.isRecurring) {
      return { ...tx, isRecurring: true, recurringInterval: rec.interval,
               recurringLastDate: rec.lastDate, recurringLastAmt: rec.lastAmt };
    }
    return tx;
  });

  state.streaks = updateStreaks(state, true);
  pendingPaste = [];
  saveState(state);

  const unknownCount = state.transactions.filter((tx) => tx.category === "Unknown").length;
  const unknownPct = state.transactions.length > 0 ? unknownCount / state.transactions.length : 0;
  const review = merchantsNeedingReview(state.transactions);
  // Force review if many unknowns OR if any merchants need review
  if (review.length || unknownPct > 0.15) {
    merchantReviewDoneCount = 0;
    renderMerchantReview(review, unknownPct);
    show("merchants");
  } else {
    show("safety");
    renderSafetySummary();
  }
});

// --- Merchants ---
const MERCHANT_REVIEW_BATCH_SIZE = 8;
let merchantReviewDoneCount = 0; // cumulative across batches, for the "nice, X done!" framing

function renderMerchantReview(review, unknownPct = 0) {
  const container = document.getElementById("merchant-list");
  // Also include Unknown transactions not in review list
  const unknownMerchants = new Map();
  for (const tx of state.transactions) {
    if (tx.category === "Unknown") {
      const m = tx.merchant || tx.description.slice(0, 40);
      if (!unknownMerchants.has(m)) unknownMerchants.set(m, { merchant: m, count: 0, sample: tx.description, category: "Unknown" });
      unknownMerchants.get(m).count++;
    }
  }
  const allReview = [...review];
  for (const [m, g] of unknownMerchants) {
    if (!allReview.find((r) => r.merchant === m)) allReview.push(g);
  }
  allReview.sort((a, b) => b.count - a.count);

  const batch = allReview.slice(0, MERCHANT_REVIEW_BATCH_SIZE);
  const remainingAfterBatch = allReview.length - batch.length;

  const accomplishedHtml = merchantReviewDoneCount > 0
    ? `<p class="small" style="color:var(--teal);font-weight:600;margin-bottom:0.5rem;">✓ ${merchantReviewDoneCount} categorized so far.</p>`
    : "";

  const warningHtml = unknownPct > 0.15
    ? `<div style="background:#fef6e4;border:1px solid #f0d080;border-radius:10px;padding:0.75rem 1rem;margin-bottom:0.75rem;font-size:0.88rem;color:#7a5000;">
        <strong>${Math.round(unknownPct * 100)}% of your transactions are uncategorized.</strong>
        Categorizing them now makes your dashboard far more useful. Set a category for each merchant below — it applies to all matching transactions.
       </div>`
    : "";

  const deferredHtml = remainingAfterBatch > 0
    ? `<p class="small" style="margin-top:0.5rem;">${remainingAfterBatch} more after this batch — do as many rounds as you'd like, or stop anytime and pick it up later from the dashboard.</p>`
    : "";

  container.innerHTML = accomplishedHtml + warningHtml +
    `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem;">
      <span class="small" id="merchant-review-progress-label">0 of ${batch.length} set</span>
    </div>
    <div style="background:var(--border);border-radius:999px;height:6px;margin-bottom:0.75rem;">
      <div id="merchant-review-progress-bar" style="background:var(--teal);height:6px;border-radius:999px;transition:width 0.3s;width:0%;"></div>
    </div>` +
    batch.map((g) => `
    <div class="merchant-review" data-merchant="${escapeAttr(g.merchant)}">
      <strong>${escapeHtml(g.merchant)}</strong>
      <span class="small"> — seen ${g.count} time${g.count > 1 ? "s" : ""}</span>
      <label>Category (applies to all)</label>
      <select class="merchant-cat">${CATEGORIES.map((cat) => `<option${cat === (g.category || "Unknown") ? " selected" : ""}>${escapeHtml(cat)}</option>`).join("")}</select>
    </div>
  `).join("") + deferredHtml;

  const moreBtn = document.getElementById("btn-merchants-more");
  if (moreBtn) moreBtn.style.display = remainingAfterBatch > 0 ? "block" : "none";

  updateMerchantReviewProgress();
  container.querySelectorAll(".merchant-cat").forEach((sel) => {
    sel.addEventListener("change", updateMerchantReviewProgress);
  });
}

function updateMerchantReviewProgress() {
  const rows = document.querySelectorAll(".merchant-review");
  const total = rows.length;
  let done = 0;
  rows.forEach((row) => {
    const sel = row.querySelector(".merchant-cat");
    if (sel && sel.value !== "Unknown") done++;
  });
  const label = document.getElementById("merchant-review-progress-label");
  const bar = document.getElementById("merchant-review-progress-bar");
  if (label) label.textContent = `${done} of ${total} set`;
  if (bar) bar.style.width = total > 0 ? `${Math.round((done / total) * 100)}%` : "0%";
}

/** Saves whatever the current batch's dropdowns are set to. Returns how many rows were saved. */
function saveCurrentMerchantBatch() {
  const chosenCats = [];
  const rows = document.querySelectorAll(".merchant-review");
  rows.forEach((row) => {
    const merchant = row.dataset.merchant;
    const cat = row.querySelector(".merchant-cat").value;
    chosenCats.push(cat);
    state.merchantMemory[merchant] = cat;
    state.transactions = state.transactions.map((tx) => {
      if (tx.merchant === merchant) return { ...tx, category: cat, confidence: 1 };
      return tx;
    });
  });
  saveState(state);
  maybeShowAtmCashAlert(chosenCats);
  merchantReviewDoneCount += rows.length;
  return rows.length;
}

document.getElementById("btn-merchants-more")?.addEventListener("click", () => {
  saveCurrentMerchantBatch();
  const review = merchantsNeedingReview(state.transactions);
  renderMerchantReview(review, 0);
  window.scrollTo(0, 0);
});

document.getElementById("btn-merchants-done").addEventListener("click", () => {
  saveCurrentMerchantBatch();
  merchantReviewDoneCount = 0;
  if (merchantReviewReturnsToDashboard) {
    merchantReviewReturnsToDashboard = false;
    renderDashboard();
    show("dashboard");
  } else {
    startWeeklyReview();
  }
});


// ═══════════════════════════════════════════════════════
// WEEK-BY-WEEK TRANSACTION REVIEW
// ═══════════════════════════════════════════════════════
let reviewWeeks = [];      // [{label, txIds}] sorted newest→oldest
let reviewWeekIdx = 0;     // current week index
let reviewAccountList = []; // accounts to cycle through
let reviewAcctIdx = 0;     // current account index

// Deep per-transaction review (category/need-want/tags/recurring) is capped to
// this many recent days regardless of how much total history was imported —
// older transactions still get categorized via the bulk merchant-review pass
// and are fully included in the Spending Patterns analysis, they just don't
// need a one-by-one walkthrough.
const REVIEW_WINDOW_DAYS = 60;

function startWeeklyReview() {
  showFloatingBtn();
  // Get all accounts that have transactions
  const acctNames = [...new Set(state.transactions.map((tx) => tx.account))].filter(Boolean);
  reviewAccountList = acctNames;
  reviewAcctIdx = 0;
  startReviewForAccount();
}

function startReviewForAccount() {
  const acct = reviewAccountList[reviewAcctIdx];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - REVIEW_WINDOW_DAYS);

  const acctTxs = state.transactions
    .filter((tx) => tx.amount < 0 && tx.account === acct && new Date(tx.date) >= cutoff)
    .sort((a, b) => b.date.localeCompare(a.date));

  if (!acctTxs.length) {
    advanceReviewAccount();
    return;
  }

  // Group into weeks (7-day buckets from most recent)
  const weeks = [];
  let weekStart = null;
  let weekTxIds = [];
  for (const tx of acctTxs) {
    const d = new Date(tx.date);
    if (!weekStart) weekStart = d;
    const diffDays = (weekStart - d) / 86400000;
    if (diffDays > 7) {
      const label = weekLabel(weekStart, new Date(acctTxs[weekTxIds.length - 1]?.date || tx.date));
      weeks.push({ label, txIds: [...weekTxIds] });
      weekTxIds = [];
      weekStart = d;
    }
    weekTxIds.push(tx.id);
  }
  if (weekTxIds.length) {
    weeks.push({ label: weekLabel(weekStart, new Date(acctTxs[acctTxs.length - 1].date)), txIds: weekTxIds });
  }

  reviewWeeks = weeks;
  reviewWeekIdx = 0;
  renderReviewWeek(acct);
  show("review");
}

function weekLabel(newest, oldest) {
  const fmt = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${fmt(oldest)} – ${fmt(newest)}`;
}

function advanceReviewAccount() {
  reviewAcctIdx++;
  if (reviewAcctIdx < reviewAccountList.length) {
    startReviewForAccount();
  } else {
    // All accounts reviewed — go to safety net
    show("safety");
    populateSafetyNetAccountList();
    renderSafetySummary();
  }
}

const DAY_NAMES = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
function fmtDateWithDay(dateStr) {
  const d = new Date(dateStr + "T12:00:00");
  return DAY_NAMES[d.getDay()] + " " + dateStr;
}

function renderReviewWeek(acct) {
  const week = reviewWeeks[reviewWeekIdx];
  if (!week) { advanceReviewAccount(); return; }

  const totalWeeks = reviewWeeks.length;
  const totalAccts = reviewAccountList.length;
  const pct = Math.round(
    ((reviewAcctIdx * totalWeeks + reviewWeekIdx) / (totalAccts * totalWeeks)) * 100
  );

  (document.getElementById("review-heading")||{textContent:""}).textContent =
    `Review — ${acct}`;
  (document.getElementById("review-subhead")||{textContent:""}).textContent =
    `Week: ${week.label} · ${week.txIds.length} transaction${week.txIds.length !== 1 ? "s" : ""}` +
    (totalAccts > 1 ? ` · Account ${reviewAcctIdx + 1} of ${totalAccts}` : "");
  (document.getElementById("review-progress")||{textContent:""}).textContent =
    `Week ${reviewWeekIdx + 1} of ${totalWeeks}`;
  (document.getElementById("review-progress-bar")||{style:{}}).style.width = `${pct}%`;

  // Prev/Next visibility
  const prevBtn = document.getElementById("btn-review-prev");
  if (prevBtn) prevBtn.style.visibility = reviewWeekIdx === 0 ? "hidden" : "visible";
  const nextBtn = document.getElementById("btn-review-next");
  if (nextBtn) nextBtn.textContent =
    reviewWeekIdx < totalWeeks - 1
      ? "Next Week →"
      : reviewAcctIdx < reviewAccountList.length - 1
        ? `Next Account →`
        : "Finish →";

  // Build transaction rows
  const txs = week.txIds.map((id) => state.transactions.find((t) => t.id === id)).filter(Boolean);
  const container = document.getElementById("review-tx-list");

  container.innerHTML = txs.map((tx) => `
    <div class="review-tx-card" data-tx-id="${escapeAttr(tx.id)}" style="background:#fff;border:1px solid var(--border);border-radius:12px;padding:0.85rem;margin:0.5rem 0;">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.4rem;">
        <span style="font-size:0.82rem;color:var(--muted);">${escapeHtml(fmtDateWithDay(tx.date))}</span>
        <strong style="color:var(--navy);">${fmtMoney(Math.abs(tx.amount))}</strong>
      </div>
      <div style="font-size:0.9rem;margin-bottom:0.6rem;word-break:break-word;">${escapeHtml(tx.description.slice(0, 60))}</div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.4rem;margin-bottom:0.5rem;">
        <div>
          <label style="font-size:0.75rem;margin-bottom:0.2rem;">Category</label>
          <select class="review-cat" data-tx-id="${escapeAttr(tx.id)}" style="font-size:0.82rem;padding:0.3rem 0.4rem;width:100%;">
            ${CATEGORIES.map((cat) => `<option${cat === tx.category ? " selected" : ""}>${escapeHtml(cat)}</option>`).join("")}
          </select>
        </div>
        <div>
          <label style="font-size:0.75rem;margin-bottom:0.2rem;">Need or Want?</label>
          <select class="review-nw" data-tx-id="${escapeAttr(tx.id)}" style="font-size:0.82rem;padding:0.3rem 0.4rem;width:100%;">
            <option value="need"${tx.needWant === "need" ? " selected" : ""}>Need</option>
            <option value="want"${tx.needWant === "want" ? " selected" : ""}>Want</option>
          </select>
        </div>
      </div>

      <div>
        <label style="font-size:0.75rem;margin-bottom:0.3rem;">Tags (optional)</label>
        ${(() => {
          const catTags =
            tx.category === "Clothing, Shoes & Apparel" ? { list: CLOTHING_TAGS, hint: "💡 Tag who this is for and what type — tracks per-person clothing spend over time." } :
            (tx.category === "Transportation" || tx.category === "Transportation Maintenance") ? { list: TRANSPORTATION_TAGS, hint: "💡 Tag what this was for — helps break down your vehicle costs." } :
            tx.category === "ATM Withdrawal / Cash" ? { list: ATM_CASH_TAGS, hint: "💡 Tag what you used this cash for — cash spending is easy to lose track of." } :
            null;
          const allTags = [...DEFAULT_TAGS, ...(state.customTags || [])];
          const txTags = tx.tags || [];
          function chipHtml(tag, highlight) {
            const active = txTags.includes(tag);
            return `<button type="button" class="tag-chip review-tag-chip${active ? " active" : ""}"
              data-tx-id="${escapeAttr(tx.id)}" data-tag="${escapeAttr(tag)}"
              style="font-size:0.75rem;padding:0.2rem 0.6rem;${highlight && !active ? "background:#f0f9f9;border-color:#c5dede;" : ""}">${escapeHtml(tag)}</button>`;
          }
          return `
            ${catTags ? `
              <p style="font-size:0.72rem;color:var(--teal);margin:0 0 0.35rem;font-weight:600;">${catTags.hint}</p>
              <div style="display:flex;flex-wrap:wrap;gap:0.3rem;margin-bottom:0.4rem;">
                ${catTags.list.map((t) => chipHtml(t, true)).join("")}
              </div>
              <details style="margin-bottom:0.3rem;">
                <summary style="font-size:0.72rem;color:var(--muted);cursor:pointer;list-style:none;">▸ All tags &amp; create new</summary>
                <div style="display:flex;flex-wrap:wrap;gap:0.3rem;margin:0.35rem 0;">
                  ${allTags.map((t) => chipHtml(t, false)).join("")}
                </div>
                <div style="display:flex;gap:0.4rem;margin-top:0.3rem;">
                  <input type="text" class="review-new-tag-input" data-tx-id="${escapeAttr(tx.id)}"
                    placeholder="Create tag…"
                    style="flex:1;font-size:0.8rem;padding:0.25rem 0.5rem;border:1px solid var(--border);border-radius:8px;">
                  <button type="button" class="review-new-tag-btn" data-tx-id="${escapeAttr(tx.id)}"
                    style="font-size:0.8rem;padding:0.25rem 0.6rem;border-radius:8px;border:1px solid var(--teal);background:var(--teal-soft);color:var(--navy);cursor:pointer;">Add</button>
                </div>
              </details>` : `
              <div style="display:flex;flex-wrap:wrap;gap:0.3rem;margin-bottom:0.3rem;">
                ${allTags.map((t) => chipHtml(t, false)).join("")}
              </div>
              <div style="display:flex;gap:0.4rem;margin-top:0.3rem;">
                <input type="text" class="review-new-tag-input" data-tx-id="${escapeAttr(tx.id)}"
                  placeholder="Create new tag…"
                  style="flex:1;font-size:0.8rem;padding:0.25rem 0.5rem;border:1px solid var(--border);border-radius:8px;">
                <button type="button" class="review-new-tag-btn" data-tx-id="${escapeAttr(tx.id)}"
                  style="font-size:0.8rem;padding:0.25rem 0.6rem;border-radius:8px;border:1px solid var(--teal);background:var(--teal-soft);color:var(--navy);cursor:pointer;">Add</button>
              </div>`}`;
        })()}
      </div>

      <div style="margin-top:0.5rem;">
        <label style="font-size:0.75rem;color:var(--muted);display:block;margin-bottom:0.3rem;">Spending type</label>
        <div style="display:flex;gap:0.3rem;flex-wrap:wrap;">
          ${["regular","recurring","one-time"].map((type) => {
            const active = type === "recurring" ? tx.isRecurring && !tx.isOneTime
                         : type === "one-time"  ? tx.isOneTime
                         : !tx.isRecurring && !tx.isOneTime;
            const labels = { regular: "Regular", recurring: "🔁 Recurring", "one-time": "1× One-time" };
            return `<button type="button" class="review-type-btn${active ? " active" : ""}"
              data-tx-id="${escapeAttr(tx.id)}" data-type="${type}"
              style="font-size:0.75rem;padding:0.25rem 0.6rem;border-radius:999px;border:1px solid ${active ? "var(--teal)" : "var(--border)"};background:${active ? "var(--teal-soft)" : "#fff"};color:${active ? "var(--navy)" : "var(--muted)"};cursor:pointer;">${labels[type]}</button>`;
          }).join("")}
          ${tx.isRecurring && tx.recurringLastDate
            ? `<span title="We saw $${(tx.recurringLastAmt||0).toFixed(2)} from this merchant on ${tx.recurringLastDate} — auto-flagged as recurring"
                style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;border:1.5px solid var(--teal);color:var(--teal);font-size:9px;font-weight:700;cursor:help;margin-left:2px;" tabindex="0">i</span>`
            : ""}
        </div>
        <p style="font-size:0.72rem;color:var(--muted);margin:0.25rem 0 0;line-height:1.3;">
          <em>Recurring</em> = fixed monthly bill. <em>One-time</em> = excluded from your monthly spending average.
        </p>
      </div>
    </div>`).join("");

  // Wire category change → save immediately
  container.querySelectorAll(".review-cat").forEach((sel) => {
    sel.addEventListener("change", () => {
      saveReviewTx(sel.dataset.txId, sel.value, null, null, null, null);
      maybeShowAtmCashAlert(sel.value);
    });
  });
  container.querySelectorAll(".review-nw").forEach((sel) => {
    sel.addEventListener("change", () => saveReviewTx(sel.dataset.txId, null, sel.value, null, null, null));
  });
  container.querySelectorAll(".review-tag-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      btn.classList.toggle("active");
      const tags = [...container.querySelectorAll(`.review-tag-chip.active[data-tx-id="${btn.dataset.txId}"]`)]
        .map((b) => b.dataset.tag);
      saveReviewTx(btn.dataset.txId, null, null, tags, null, null);
    });
  });
  // Create new tag from review card
  container.querySelectorAll(".review-new-tag-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = container.querySelector(`.review-new-tag-input[data-tx-id="${btn.dataset.txId}"]`);
      if (!input) return;
      const tag = input.value.trim();
      if (!tag) return;
      if (!state.customTags.includes(tag)) state.customTags.push(tag);
      const tx = state.transactions.find((t) => t.id === btn.dataset.txId);
      if (tx && !(tx.tags || []).includes(tag)) {
        saveReviewTx(btn.dataset.txId, null, null, [...(tx.tags || []), tag], null, null);
      }
      input.value = "";
      saveState(state);
      renderReviewWeek(reviewAccountList[reviewAcctIdx]); // re-render to show new chip
    });
    // Also allow Enter key
    const input = container.querySelector(`.review-new-tag-input[data-tx-id="${btn.dataset.txId}"]`);
    if (input) {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); btn.click(); }
      });
    }
  });

  container.querySelectorAll(".review-type-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const type = btn.dataset.type;
      const txId = btn.dataset.txId;
      const isRecurring = type === "recurring";
      const isOneTime   = type === "one-time";
      saveReviewTx(txId, null, null, null, isRecurring, isOneTime);
      // Update button styles immediately
      container.querySelectorAll(`.review-type-btn[data-tx-id="${txId}"]`).forEach((b) => {
        const active = b.dataset.type === type;
        b.classList.toggle("active", active);
        b.style.borderColor = active ? "var(--teal)" : "var(--border)";
        b.style.background  = active ? "var(--teal-soft)" : "#fff";
        b.style.color       = active ? "var(--navy)" : "var(--muted)";
      });
    });
  });
}

function saveReviewTx(txId, cat, nw, tags, isRecurring, isOneTime) {
  state.transactions = state.transactions.map((tx) => {
    if (tx.id !== txId) return tx;
    const updated = { ...tx };
    if (cat !== null) { updated.category = cat; updated.confidence = 1; }
    if (nw !== null) updated.needWant = nw;
    if (tags !== null) updated.tags = tags;
    if (isRecurring !== null && isRecurring !== undefined) updated.isRecurring = isRecurring;
    if (isOneTime !== null && isOneTime !== undefined) updated.isOneTime = isOneTime;
    return updated;
  });
  saveState(state);
}

(document.getElementById("btn-review-next") || {addEventListener:()=>{}}).addEventListener("click", () => {
  // Save any pending changes (already saved on change), advance week
  if (reviewWeekIdx < reviewWeeks.length - 1) {
    reviewWeekIdx++;
    renderReviewWeek(reviewAccountList[reviewAcctIdx]);
  } else {
    advanceReviewAccount();
  }
});

(document.getElementById("btn-review-prev") || {addEventListener:()=>{}}).addEventListener("click", () => {
  if (reviewWeekIdx > 0) {
    reviewWeekIdx--;
    renderReviewWeek(reviewAccountList[reviewAcctIdx]);
  }
});

(document.getElementById("btn-review-done") || {addEventListener:()=>{}}).addEventListener("click", () => {
  saveState(state);
  show("safety");
  populateSafetyNetAccountList();
  renderSafetySummary();
});

// ═══════════════════════════════════════════════════════

// ── Floating snapshot button ──────────────────────────────────────────────
let lastDownloadedState = null;
let floatingBtnVisible = false;

function showFloatingBtn() {
  const wrap = document.getElementById("floating-save-wrap");
  if (wrap) { wrap.style.display = "block"; floatingBtnVisible = true; }
}

function markUnsavedChanges() {
  if (!floatingBtnVisible) return;
  const dot = document.getElementById("floating-save-dot");
  const label = document.getElementById("floating-save-label");
  const icon = document.getElementById("floating-save-icon");
  if (dot) dot.style.display = "block";
  if (label) label.textContent = "Unsaved changes — Download";
  if (icon) icon.textContent = "⚠️";
}

function markSaved() {
  const dot = document.getElementById("floating-save-dot");
  const label = document.getElementById("floating-save-label");
  const icon = document.getElementById("floating-save-icon");
  if (dot) dot.style.display = "none";
  if (label) label.textContent = "Download Snapshot";
  if (icon) icon.textContent = "💾";
}

(document.getElementById("btn-floating-snapshot") || {addEventListener:()=>{}})
  .addEventListener("click", () => {
    downloadSnapshot(state);
    lastDownloadedState = JSON.stringify(state);
    markSaved();
  });

// Poll for state changes every 15 seconds and show unsaved indicator
setInterval(() => {
  if (!floatingBtnVisible) return;
  const current = JSON.stringify(state);
  if (lastDownloadedState === null) {
    // Never downloaded yet — show unsaved
    markUnsavedChanges();
  } else if (current !== lastDownloadedState) {
    markUnsavedChanges();
  }
}, 15000);

// Also warn before closing if unsaved changes
window.addEventListener("beforeunload", (e) => {
  if (!floatingBtnVisible) return;
  const current = JSON.stringify(state);
  if (lastDownloadedState === null || current !== lastDownloadedState) {
    e.preventDefault();
    e.returnValue = "You have unsaved changes. Download your snapshot before leaving.";
  }
});
// ─────────────────────────────────────────────────────────────────────────

// --- Safety Net ---
const snType = document.getElementById("sn-type");
snType.addEventListener("change", () => {
  document.getElementById("sn-partial-wrap").classList.toggle("hidden", snType.value !== "partial");
  document.getElementById("sn-balance-label").textContent =
    snType.value === "cash" ? "Cash on hand ($)" : "Current balance ($)";
});

document.getElementById("btn-add-sn").addEventListener("click", () => {
  const type = snType.value;
  const label = document.getElementById("sn-label").value.trim() || "Safety Net";
  const balance = Number(document.getElementById("sn-balance").value) || 0;
  const protectedAmount = Number(document.getElementById("sn-protected").value) || 0;

  if (type === "cash") {
    state.safetyNet.cashAmount = balance;
  } else {
    state.safetyNet.accounts.push({
      type,
      label,
      balance,
      protectedAmount: type === "partial" ? protectedAmount : balance
    });
  }

  const total = computeSafetyNetBalance(state.safetyNet);
  state.safetyNet.totalBalance = total;

  const avgTotalSpend = averageTotalSpending(state.transactions);
  const months = computeMonthsCovered(total, avgTotalSpend);
  state.safetyNetHistory.push({
    date: new Date().toISOString().slice(0, 10),
    balance: total,
    monthsCovered: months
  });

  state.personalRecords = updateRecords(state, months, total);
  saveState(state);
  renderSafetySummary();
});

function renderSafetySummary() {
  const el = document.getElementById("sn-summary");
  const total = computeSafetyNetBalance(state.safetyNet);
  const avgTotalSpend = averageTotalSpending(state.transactions);
  const avgNeeds = averageNeedsSpending(state.transactions);
  const months = computeMonthsCovered(total, avgTotalSpend);
  const monthsNeedsOnly = computeMonthsCovered(total, avgNeeds);
  el.classList.remove("hidden");
  el.innerHTML = `
    <h3>Current Safety Net</h3>
    <p><strong>${fmtMoney(total)}</strong></p>
    <p class="small">Months Covered (needs + wants, 45-day average): <strong>${fmtMonths(months)}</strong>${monthsNeedsOnly != null ? ` <span style="color:var(--muted);">(stretches to ${fmtMonths(monthsNeedsOnly)} on needs alone)</span>` : ""}</p>
  `;
}


function populateSafetyNetAccountList() {
  let dl = document.getElementById("sn-account-hints");
  if (!dl) {
    dl = document.createElement("datalist");
    dl.id = "sn-account-hints";
    document.getElementById("sn-label").setAttribute("list", "sn-account-hints");
    document.getElementById("sn-label").parentNode.appendChild(dl);
  }
  const names = (state.accounts || []).map((a) => a.nickname).filter(Boolean);
  dl.innerHTML = names.map((n) => `<option value="${escapeAttr(n)}">`).join("");
}

document.getElementById("btn-to-dashboard").addEventListener("click", () => {
  renderDashboard();
  show("dashboard");
  showFloatingBtn();
  downloadSnapshot(state);
});

// --- Dashboard ---

// Tags that typically represent a one-off event rather than regular,
// recurring spending — applying one of these defaults the "exclude from
// monthly averages" checkbox to checked, since these are exactly the kind
// of outlier that would otherwise skew a normal month's numbers.
const OUTLIER_EVENT_TAGS = new Set([
  "Travel", "Vacation", "Business Trip", "Home Repair", "Moving",
  "Wedding", "New Baby", "Medical Event", "Vehicle Purchase", "Emergency"
]);

function renderTags(txs) {
  const allTags = [...DEFAULT_TAGS, ...(state.customTags || [])];
  const chipsEl = document.getElementById("default-tag-chips");
  chipsEl.innerHTML = allTags.map((tag) => {
    const isCustom = !(DEFAULT_TAGS.includes(tag));
    const cls = activeTag === tag ? "tag-chip active" : "tag-chip";
    const extra = isCustom ? " tag-chip-custom" : "";
    return `<button type="button" class="${cls}${extra}" data-tag="${escapeAttr(tag)}">${escapeHtml(tag)}</button>`;
  }).join("");

  document.getElementById("active-tag-label").textContent = activeTag || "None";

  // Proactive nudge: surface the most recent untagged burst of discretionary
  // spending (from the existing spending-spree detector) as a candidate for
  // "was this a trip or one-time event? tag it so it doesn't skew your
  // normal month."
  const nudgeEl = document.getElementById("trip-tag-nudge");
  if (nudgeEl) {
    const sprees = detectSpendingSprees(state.transactions, 60);
    const untagged = sprees.available ? sprees.sprees.find((s) => !s.anyTagged) : null;
    if (untagged) {
      nudgeEl.classList.remove("hidden");
      nudgeEl.innerHTML = `Noticed a burst of spending ${escapeHtml(untagged.startDate)}${untagged.startDate !== untagged.endDate ? "–" + escapeHtml(untagged.endDate) : ""}
        (${untagged.count} purchases, ${fmtMoney(untagged.total)}) — trip, event, or something one-off? Pick a tag above, check those transactions below, and mark them as one-time so they don't skew your normal month.`;
    } else {
      nudgeEl.classList.add("hidden");
    }
  }

  const totals = tagSummaries(txs);
  const totalsEl = document.getElementById("tag-totals");
  totalsEl.innerHTML = totals.length
    ? totals.slice(0, 8).map((t) => `<div><strong>${escapeHtml(t.tag)}</strong> — ${fmtMoney(t.total)} (90 days)</div>`).join("")
    : "<p>No tagged spending yet. Select a tag, then tap transactions below.</p>";

  const recent = txs
    .filter((tx) => tx.amount < 0)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 50);

  const suggestOneTime = OUTLIER_EVENT_TAGS.has(activeTag);
  const applyBtnHtml = `<div style="margin:0.5rem 0;">
    <label class="small" style="display:flex;align-items:center;gap:0.4rem;margin:0 0 0.5rem;cursor:pointer;">
      <input type="checkbox" id="tag-mark-onetime" ${suggestOneTime ? "checked" : ""} style="width:auto;margin:0;">
      Also exclude these from monthly averages (one-time expense)
    </label>
    <div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;">
      <button type="button" class="btn btn-secondary" id="btn-apply-tag-checked" style="width:auto;margin:0;padding:0.4rem 0.85rem;font-size:0.88rem;"
        ${activeTag ? "" : "disabled"}>Apply "${escapeHtml(activeTag || "")}" to checked</button>
      <button type="button" class="btn btn-ghost" id="btn-check-all-tags" style="width:auto;margin:0;padding:0.4rem 0.85rem;font-size:0.88rem;">Check all</button>
      <button type="button" class="btn btn-ghost" id="btn-uncheck-all-tags" style="width:auto;margin:0;padding:0.4rem 0.85rem;font-size:0.88rem;">Uncheck all</button>
    </div>
  </div>`;

  document.getElementById("tx-tag-list").innerHTML = recent.length
    ? applyBtnHtml + recent.map((tx) => {
      const tagStr = (tx.tags || []).length ? (tx.tags || []).map((t) => `#${escapeHtml(t)}`).join(" ") : "";
      const oneTimeStr = tx.isOneTime ? " · one-time" : "";
      return `<div class="tx-tag-row" style="display:grid;grid-template-columns:1.25rem 1fr;gap:0.5rem;align-items:start;">
        <input type="checkbox" class="tx-tag-check" data-tx-id="${escapeAttr(tx.id)}" style="margin-top:0.25rem;flex-shrink:0;">
        <div style="min-width:0;cursor:pointer;overflow:hidden;" data-tx-id="${escapeAttr(tx.id)}">
          <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(tx.date)} · ${escapeHtml(tx.description.slice(0, 50))}</div>
          <div class="small">${fmtMoney(Math.abs(tx.amount))} ${tagStr ? `· ${tagStr}` : ""}${oneTimeStr}</div>
        </div>
      </div>`;
    }).join("")
    : "<p class=\"small\">No spending rows to tag yet.</p>";
}

document.getElementById("default-tag-chips").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-tag]");
  if (!btn) return;
  const tag = btn.dataset.tag;
  activeTag = activeTag === tag ? null : tag;
  renderTags(getFilteredTransactions());
});

document.getElementById("btn-add-custom-tag").addEventListener("click", () => {
  const input = document.getElementById("custom-tag-input");
  const tag = input.value.trim();
  if (!tag) return;
  if (!state.customTags) state.customTags = [];
  if (!state.customTags.includes(tag) && !DEFAULT_TAGS.includes(tag)) {
    state.customTags.push(tag);
    saveState(state);
  }
  activeTag = tag;
  input.value = "";
  renderTags(getFilteredTransactions());
});

document.getElementById("custom-tag-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    document.getElementById("btn-add-custom-tag").click();
  }
});

document.getElementById("tx-tag-list").addEventListener("click", (e) => {
  // Apply button
  if (e.target.id === "btn-apply-tag-checked") {
    if (!activeTag) return;
    const markOneTime = document.getElementById("tag-mark-onetime")?.checked;
    document.querySelectorAll(".tx-tag-check:checked").forEach((cb) => {
      const txId = cb.dataset.txId;
      const tx = state.transactions.find((t) => t.id === txId);
      if (!tx) return;
      const needsTag = !(tx.tags || []).includes(activeTag);
      if (needsTag || markOneTime) {
        state.transactions = state.transactions.map((t) => {
          if (t.id !== txId) return t;
          const updated = { ...t };
          if (needsTag) updated.tags = [...(t.tags || []), activeTag];
          if (markOneTime) updated.isOneTime = true;
          return updated;
        });
      }
    });
    saveState(state);
    renderDashboard();
    return;
  }
  // Check all / uncheck all
  if (e.target.id === "btn-check-all-tags") {
    document.querySelectorAll(".tx-tag-check").forEach((cb) => cb.checked = true);
    return;
  }
  if (e.target.id === "btn-uncheck-all-tags") {
    document.querySelectorAll(".tx-tag-check").forEach((cb) => cb.checked = false);
    return;
  }
  // Click on row text = toggle checkbox
  const rowText = e.target.closest("[data-tx-id]:not(input)");
  if (rowText && rowText.tagName !== "INPUT") {
    const cb = rowText.closest(".tx-tag-row")?.querySelector(".tx-tag-check");
    if (cb) cb.checked = !cb.checked;
  }
});

function toggleTagOnTx(txId) {
  if (!activeTag) return;
  state.transactions = state.transactions.map((tx) => {
    if (tx.id !== txId) return tx;
    const tags = tx.tags || [];
    const has = tags.includes(activeTag);
    return { ...tx, tags: has ? tags.filter((t) => t !== activeTag) : [...tags, activeTag] };
  });
  saveState(state);
  renderTags(getFilteredTransactions());
}

// ── Manual cash-purchase entry ─────────────────────────────────────────────
// Cash spending can't be pulled from a bank export, so this form lets people
// log it by hand. Entries are stored under a "Cash Wallet" account like any
// other transaction — that's what lets a future "cash withdrawn vs. cash
// logged" comparison work without any special-casing.
const CASH_ENTRY_EXCLUDED_CATEGORIES = new Set(["Income", "Interest Income", "One-Time Income", "ATM Withdrawal / Cash"]);
let cashEntryTags = [];

function uid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "tx-" + Math.random().toString(36).slice(2, 11);
}

function populateCashEntryCategoryOptions() {
  const sel = document.getElementById("cash-entry-category");
  if (!sel || sel.options.length) return;
  sel.innerHTML = CATEGORIES
    .filter((c) => !CASH_ENTRY_EXCLUDED_CATEGORIES.has(c))
    .map((c) => `<option>${escapeHtml(c)}</option>`)
    .join("");
}

function renderCashEntryTagChips() {
  const wrap = document.getElementById("cash-entry-tag-chips");
  if (!wrap) return;
  const allTags = [...DEFAULT_TAGS, ...(state.customTags || [])];
  wrap.innerHTML = allTags.map((tag) => {
    const active = cashEntryTags.includes(tag);
    return `<button type="button" class="tag-chip cash-entry-tag-chip${active ? " active" : ""}" data-tag="${escapeAttr(tag)}">${escapeHtml(tag)}</button>`;
  }).join("");
  wrap.querySelectorAll(".cash-entry-tag-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tag = btn.dataset.tag;
      cashEntryTags = cashEntryTags.includes(tag) ? cashEntryTags.filter((t) => t !== tag) : [...cashEntryTags, tag];
      renderCashEntryTagChips();
    });
  });
}

document.getElementById("btn-add-cash-entry")?.addEventListener("click", () => {
  const desc = document.getElementById("cash-entry-desc").value.trim();
  const amountRaw = document.getElementById("cash-entry-amount").value;
  const amount = Number(amountRaw);
  const dateInput = document.getElementById("cash-entry-date").value;
  const category = document.getElementById("cash-entry-category").value;
  const needWant = document.getElementById("cash-entry-needwant").value;

  if (!desc || !amountRaw || !(amount > 0)) {
    alert("Add what you bought and an amount greater than $0.");
    return;
  }

  const date = dateInput || new Date().toISOString().slice(0, 10);
  const nickname = "Cash Wallet";

  if (!state.accounts.find((a) => a.nickname === nickname)) {
    state.accounts.push({ nickname, type: "Cash" });
  }

  const tx = {
    id: uid(),
    date,
    description: desc,
    amount: -Math.abs(amount),
    account: nickname,
    accountType: "Cash",
    type: "debit",
    merchant: normalizeMerchant(desc),
    category,
    confidence: 1,
    needWant,
    isReimbursement: false,
    tags: [...cashEntryTags]
  };

  state.transactions.push(tx);
  saveState(state);

  // Reset the form
  document.getElementById("cash-entry-desc").value = "";
  document.getElementById("cash-entry-amount").value = "";
  document.getElementById("cash-entry-date").value = "";
  cashEntryTags = [];
  renderCashEntryTagChips();

  const confirmEl = document.getElementById("cash-entry-confirm");
  if (confirmEl) {
    confirmEl.classList.remove("hidden");
    setTimeout(() => confirmEl.classList.add("hidden"), 2500);
  }

  renderDashboard();
});

// ── Spending Patterns (client-side only, no AI, no external calls) ────────
function renderPatternInsights(txs) {
  const container = document.getElementById("pattern-insights-list");
  if (!container) return;

  const windowDays = state.analysisWindowDays || 365;
  const result = analyzeSpendingPatterns(txs, windowDays);

  const sections = [];

  if (result.summaries.length) {
    sections.push(`<ul style="margin:0 0 0.75rem;padding-left:1.2rem;">${result.summaries.map((s) => `<li style="margin-bottom:0.35rem;">${escapeHtml(s)}</li>`).join("")}</ul>`);
  } else {
    sections.push(`<p class="small">Not enough history yet in this window to surface patterns — add more transactions or widen the window above.</p>`);
  }

  if (result.dayOfWeek.available) {
    const maxVal = Math.max(...result.dayOfWeek.days.map((d) => d.avgPerWeek), 1);
    sections.push(`
      <h4 style="margin:0.75rem 0 0.4rem;font-size:0.85rem;color:var(--navy);">Average spend by day of week</h4>
      <div style="display:flex;gap:0.35rem;align-items:flex-end;height:70px;">
        ${result.dayOfWeek.days.map((d) => `
          <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:0.2rem;">
            <div style="width:100%;background:var(--teal);border-radius:4px 4px 0 0;height:${Math.max(4, Math.round((d.avgPerWeek / maxVal) * 55))}px;"></div>
            <span style="font-size:0.65rem;color:var(--muted);">${d.day.slice(0,3)}</span>
          </div>`).join("")}
      </div>`);
  }

  if (result.trends.available && result.trends.trends.length) {
    sections.push(`
      <h4 style="margin:0.75rem 0 0.4rem;font-size:0.85rem;color:var(--navy);">This month vs. recent average</h4>
      ${result.trends.trends.slice(0, 6).map((t) => `
        <div style="display:flex;justify-content:space-between;font-size:0.82rem;margin:0.2rem 0;">
          <span>${escapeHtml(t.category)}</span>
          <span style="color:${t.pctChange > 0 ? '#c0392b' : t.pctChange < 0 ? 'var(--teal)' : 'var(--muted)'};">
            ${t.pctChange == null ? '—' : (t.pctChange > 0 ? '+' : '') + t.pctChange + '%'}
          </span>
        </div>`).join("")}`);
  }

  if (result.anomalies.available) {
    sections.push(`
      <h4 style="margin:0.75rem 0 0.4rem;font-size:0.85rem;color:var(--navy);">Unusual charges</h4>
      ${result.anomalies.anomalies.slice(0, 5).map((a) => `
        <div style="font-size:0.82rem;margin:0.25rem 0;">
          ${escapeHtml(a.date)} · ${escapeHtml(a.merchant)} — ${fmtMoney(a.amount)}
          <span class="small">(usually ~${fmtMoney(a.usualAvg)}, +${a.pctAboveUsual}%)</span>
        </div>`).join("")}`);
  }

  if (result.sprees.available) {
    sections.push(`
      <h4 style="margin:0.75rem 0 0.4rem;font-size:0.85rem;color:var(--navy);">Spending clusters</h4>
      ${result.sprees.sprees.slice(0, 5).map((s) => `
        <div style="font-size:0.82rem;margin:0.25rem 0;">
          ${escapeHtml(s.startDate)}${s.startDate !== s.endDate ? ' – ' + escapeHtml(s.endDate) : ''} ·
          ${s.count} purchases · ${fmtMoney(s.total)} total
        </div>`).join("")}`);
  }

  container.innerHTML = sections.join("");
}

document.addEventListener("change", (e) => {
  if (e.target.id !== "analysis-window-select") return;
  state.analysisWindowDays = Number(e.target.value);
  saveState(state);
  renderPatternInsights(getFilteredTransactions());
});

function renderCantMissZone(txs) {
  const badgeEl = document.getElementById("wants-tier-badge");
  const detailEl = document.getElementById("wants-tier-detail");
  const alertEl = document.getElementById("worst-offender-alert");
  if (!badgeEl || !detailEl || !alertEl) return;

  const tierColors = { "Careful": "var(--teal)", "Standard": "#3a6ea5", "Generous": "#c98a1f" };
  const overall = overallWantsTier(txs, 30);

  if (!overall.available) {
    badgeEl.innerHTML = "";
    detailEl.textContent = overall.reason || "";
  } else {
    const color = overall.overGuideline ? "#c0392b" : tierColors[overall.tier];
    badgeEl.innerHTML = `<span style="font-size:0.72rem;font-weight:700;padding:0.15rem 0.55rem;border-radius:999px;color:#fff;background:${color};">${overall.overGuideline ? "Over Guideline" : overall.tier}</span>`;
    detailEl.textContent = `${fmtMoney(overall.monthlyWants)}/mo on wants (${overall.pctOfIncome}% of income). Careful ≤${Math.round(overall.careful)}% · Standard ≤${Math.round(overall.standard)}% · Generous ≤${Math.round(overall.generous)}%.`;
  }

  const wantsHistoryEl = document.getElementById("wants-tier-history");
  if (wantsHistoryEl) {
    const history = overallWantsTierByMonth(state.transactions, 6);
    wantsHistoryEl.innerHTML = history.map((m) => {
      if (!m.available) return `<div style="display:flex;justify-content:space-between;padding:0.15rem 0;color:var(--muted);">${escapeHtml(m.label)}<span>No income data</span></div>`;
      const color = m.overGuideline ? "#c0392b" : (tierColors[m.tier] || "var(--muted)");
      return `<div style="display:flex;justify-content:space-between;padding:0.15rem 0;">
        <span>${escapeHtml(m.label)}</span>
        <span>${fmtMoney(m.amount)}/mo · ${m.pctOfIncome}% · <span style="color:${color};font-weight:600;">${m.overGuideline ? "Over Guideline" : m.tier}</span></span>
      </div>`;
    }).join("");
  }

  // Fires whenever a want-category is over its own Generous guideline —
  // including a steady, unchanging habit. The point is to surface
  // overspending itself, not just changes in it; trend direction is still
  // mentioned in the message for context, it just doesn't gate whether this
  // shows up at all.
  const worst = worstOffendingWantCategory(txs, 90);
  const worstTextEl = document.getElementById("worst-offender-text");
  if (worst.available) {
    alertEl.classList.remove("hidden");
    if (worstTextEl) worstTextEl.textContent = worst.summary;
  } else {
    alertEl.classList.add("hidden");
    if (worstTextEl) worstTextEl.textContent = "";
  }

  const worstHistoryEl = document.getElementById("worst-offender-history");
  if (worstHistoryEl) {
    const history = topWantCategoryByMonth(state.transactions, 6);
    worstHistoryEl.innerHTML = history.map((m) => {
      if (!m.available) return `<div style="display:flex;justify-content:space-between;padding:0.15rem 0;">${escapeHtml(m.label)}<span>No want spending</span></div>`;
      return `<div style="display:flex;justify-content:space-between;padding:0.15rem 0;">
        <span>${escapeHtml(m.label)}</span>
        <span>${escapeHtml(m.topCategory)} · ${fmtMoney(m.amount)}${m.pctOfIncome != null ? ` · ${m.pctOfIncome}% income` : ""}</span>
      </div>`;
    }).join("");
  }

  const uncatEl = document.getElementById("uncategorized-alert");
  const uncatTextEl = document.getElementById("uncategorized-text");
  if (uncatEl && uncatTextEl) {
    const uncat = uncategorizedSummary(state.transactions);
    if (uncat.unknownMerchantCount > 0) {
      uncatEl.classList.remove("hidden");
      uncatEl.style.background = uncat.shouldHighlight ? "#fdecec" : "#f4f6f7";
      uncatEl.style.border = uncat.shouldHighlight ? "1px solid #f0b8b8" : "1px solid var(--border)";
      uncatEl.style.color = uncat.shouldHighlight ? "#8a2c2c" : "var(--muted)";
      uncatTextEl.textContent =
        `${uncat.unknownMerchantCount} merchant${uncat.unknownMerchantCount > 1 ? "s" : ""} (${uncat.unknownTxCount} transaction${uncat.unknownTxCount > 1 ? "s" : ""}) still need${uncat.unknownMerchantCount > 1 ? "" : "s"} a category — ` +
        `about ${fmtMoney(uncat.unknownSpend)} (${uncat.pctOfSpend}% of your spending) isn't reflected anywhere yet.`;
    } else {
      uncatEl.classList.add("hidden");
    }
  }

  const completenessPctEl = document.getElementById("completeness-pct");
  const completenessDetailEl = document.getElementById("completeness-detail");
  if (completenessPctEl && completenessDetailEl) {
    const complete = completeFinancialPicture(state.transactions);
    completenessPctEl.textContent = `${complete.pct}%`;
    const parts = [];
    if (complete.unknownSpend > 0) parts.push(`${fmtMoney(complete.unknownSpend)} uncategorized`);
    if (complete.cashGap > 0) parts.push(`${fmtMoney(complete.cashGap)} in withdrawn cash not yet logged`);
    completenessDetailEl.textContent = parts.length
      ? `Gaps: ${parts.join(" · ")}.`
      : "Your spending picture is fully accounted for.";
  }
}

let merchantReviewReturnsToDashboard = false;

document.getElementById("btn-categorize-now")?.addEventListener("click", () => {
  merchantReviewReturnsToDashboard = true;
  merchantReviewDoneCount = 0;
  const review = merchantsNeedingReview(state.transactions);
  renderMerchantReview(review, 0);
  show("merchants");
});

function renderWhatToDo(txs) {
  // Safety Net Builder Suggestions — Biggest Opportunity + up to 2 more
  const suggEl = document.getElementById("safety-net-suggestions");
  if (suggEl) {
    const result = safetyNetBuilderSuggestions(state.transactions);
    if (!result.available) {
      suggEl.innerHTML = `<p class="small">${escapeHtml(result.reason || "Add more history to see suggestions here.")}</p>`;
    } else {
      suggEl.innerHTML = result.suggestions.map((s, i) => {
        const label = i === 0 ? "Your Biggest Opportunity" : "Also worth considering";
        const tierBadge = s.tier
          ? `<span style="font-size:0.68rem;font-weight:700;padding:0.1rem 0.4rem;border-radius:999px;margin-left:0.4rem;color:#fff;background:${s.overGuideline ? "#c0392b" : "#3a6ea5"};">${s.overGuideline ? "Over Guideline" : s.tier}</span>`
          : "";
        return `<div style="margin:${i === 0 ? "0" : "0.6rem"} 0 0.6rem;padding:0.65rem 0.75rem;background:${i === 0 ? "#e8f4f4" : "#f8f9fa"};border:1px solid ${i === 0 ? "#c5dede" : "var(--border)"};border-radius:8px;">
          <div style="font-size:0.72rem;font-weight:700;color:var(--teal);text-transform:uppercase;letter-spacing:0.02em;">${label}</div>
          <div style="font-size:0.88rem;color:var(--navy);margin-top:0.2rem;">${escapeHtml(s.category)}${tierBadge}</div>
          <p class="small" style="margin-top:0.25rem;">${escapeHtml(s.summary)} <span style="color:var(--muted);">(you're at ${fmtMoney(s.currentAmt)} of ${fmtMoney(s.baselineAmt)} typical for this cycle.)</span></p>
        </div>`;
      }).join("");
    }
  }

  // Convenience Tax
  const convEl = document.getElementById("convenience-tax-callout");
  if (convEl) {
    const conv = convenienceTax(txs, 30);
    if (conv.available) {
      convEl.classList.remove("hidden");
      convEl.innerHTML = `
        <div style="font-size:0.85rem;font-weight:600;color:var(--navy);">Convenience Tax</div>
        <p class="small" style="margin-top:0.2rem;">${fmtMoney(conv.monthlyAmt)}/mo${conv.pctOfIncome != null ? ` (${conv.pctOfIncome}% of income)` : ""} — the cost of dining out, fast food, coffee stops, and bank fees combined.
        ${conv.breakdown.length ? conv.breakdown.map((b) => `${escapeHtml(b.category)}: ${fmtMoney(b.monthlyAmt)}`).join(" · ") : ""}</p>`;
    } else {
      convEl.classList.add("hidden");
    }
  }

  // Impulse Spending (relabeled spending-spree detector — no new math)
  const impulseEl = document.getElementById("impulse-spending-callout");
  if (impulseEl) {
    const sprees = detectSpendingSprees(txs, 90);
    if (sprees.available) {
      impulseEl.classList.remove("hidden");
      const top = sprees.sprees[0];
      impulseEl.innerHTML = `
        <div style="font-size:0.85rem;font-weight:600;color:var(--navy);">Impulse Spending</div>
        <p class="small" style="margin-top:0.2rem;">${sprees.sprees.length} cluster${sprees.sprees.length > 1 ? "s" : ""} of 3+ purchases within 48 hours in the last 90 days — most recent: ${escapeHtml(top.startDate)}${top.startDate !== top.endDate ? "–" + escapeHtml(top.endDate) : ""}, ${top.count} purchases, ${fmtMoney(top.total)} total.</p>`;
    } else {
      impulseEl.classList.add("hidden");
    }
  }

  // Income Allocation Trend ("where did the raise go")
  const incomeEl = document.getElementById("income-allocation-callout");
  if (incomeEl) {
    const trend = incomeAllocationTrend(state.transactions);
    if (trend.available) {
      incomeEl.classList.remove("hidden");
      incomeEl.innerHTML = `
        <div style="font-size:0.85rem;font-weight:600;color:var(--navy);">Where Did the Extra Income Go?</div>
        <p class="small" style="margin-top:0.2rem;">${escapeHtml(trend.summary)}</p>`;
    } else {
      incomeEl.classList.add("hidden");
    }
  }

  // Small-purchase blindness (≤$15)
  const smallEl = document.getElementById("small-purchase-callout");
  if (smallEl) {
    const small = smallPurchaseBlindness(state.transactions, 15);
    if (small.available) {
      smallEl.classList.remove("hidden");
      smallEl.innerHTML = `
        <div style="font-size:0.85rem;font-weight:600;color:var(--navy);">Small Purchases Add Up</div>
        <p class="small" style="margin-top:0.2rem;">Purchases $15 and under: ${fmtMoney(small.weekTotal)} this week (${small.weekCount}), ${fmtMoney(small.monthTotal)} this month (${small.monthCount}).</p>`;
    } else {
      smallEl.classList.add("hidden");
    }
  }
}

function renderSafeSpendingBox() {
  const rangeEl = document.getElementById("safe-spending-range");
  const daysEl = document.getElementById("safe-spending-days");
  const detailEl = document.getElementById("safe-spending-detail");
  const billsEl = document.getElementById("safe-spending-bills");
  if (!rangeEl || !billsEl) return;

  const safe = safeSpendingUntilPayday(state.transactions);
  if (!safe.available) {
    rangeEl.textContent = "—";
    daysEl.textContent = "";
    detailEl.textContent = safe.reason || "";
    billsEl.innerHTML = "";
    return;
  }

  rangeEl.textContent = `${fmtMoney(safe.rangeLow)} – ${fmtMoney(safe.rangeHigh)}`;
  daysEl.textContent = `${safe.daysUntilPayday} day${safe.daysUntilPayday !== 1 ? "s" : ""} until payday`;
  detailEl.textContent = `A range, not a precise number — bills that might come in lighter than usual push you toward the higher end.`;

  const paidHtml = safe.bills.paidThisCycle.length
    ? `<div style="margin-bottom:0.3rem;"><strong>Already paid this cycle:</strong>${safe.bills.paidThisCycle.map((b) =>
        `<div style="display:flex;justify-content:space-between;padding:0.1rem 0;"><span>${escapeHtml(b.merchant)}</span><span>${fmtMoney(b.amount)} · ${escapeHtml(b.lastDate)}</span></div>`
      ).join("")}</div>`
    : "";
  const expectedHtml = safe.bills.expectedNotYetPaid.length
    ? `<div><strong>Expected before next payday:</strong>${safe.bills.expectedNotYetPaid.map((b) =>
        `<div style="display:flex;justify-content:space-between;padding:0.1rem 0;"><span>${escapeHtml(b.merchant)}</span><span>${fmtMoney(b.amount)} · ~${escapeHtml(b.expectedDate)}</span></div>`
      ).join("")}</div>`
    : `<p class="small">No upcoming bills detected — if that's missing something, this estimate may run high.</p>`;

  billsEl.innerHTML = paidHtml + expectedHtml;
}

function renderDashboard() {
  const txs = getFilteredTransactions();
  const total = computeSafetyNetBalance(state.safetyNet);
  const avgTotalSpend = averageTotalSpending(txs);
  const avgNeeds = averageNeedsSpending(txs);
  const months = computeMonthsCovered(total, avgTotalSpend);
  const monthsNeedsOnly = computeMonthsCovered(total, avgNeeds);
  const nw = needsVsWants(txs);
  const bills = detectRecurring(txs);
  const subs = subscriptionSummary(txs);
  const stability = stabilityLabel(state.safetyNetHistory);
  const insights = simpleInsights(txs);
  const records = state.personalRecords || {};

  document.getElementById("overlap-notice").classList.toggle("hidden", !overlapFlag);
  renderSafeSpendingBox();
  renderCantMissZone(txs);
  document.getElementById("months-covered").textContent = fmtMonths(months);
  const monthsSubEl = document.getElementById("months-covered-needs-sub");
  if (monthsSubEl) {
    monthsSubEl.textContent = monthsNeedsOnly != null
      ? `(stretches to ${fmtMonths(monthsNeedsOnly)} months on needs alone)`
      : "";
  }
  document.getElementById("sn-current").textContent = fmtMoney(total);
  document.getElementById("growth-streak").textContent = String(computeGrowthStreak(state.safetyNetHistory));
  document.getElementById("checkin-streak").textContent = String(state.streaks?.weeklyCheckIn || 0);
  document.getElementById("stability-label").textContent = stability;

  const recParts = [];
  if (records.bestMonthsCovered) recParts.push(`Highest Months Covered: ${fmtMonths(records.bestMonthsCovered)}`);
  if (records.largestSafetyNet) recParts.push(`Largest Safety Net: ${fmtMoney(records.largestSafetyNet)}`);
  if (records.longestCheckInStreak) recParts.push(`Longest check-in streak: ${records.longestCheckInStreak}`);
  document.getElementById("personal-record").textContent = recParts.length ? recParts.join(" · ") : "Records appear as you grow.";

  const hist = state.safetyNetHistory;
  if (hist.length) {
    const first = hist[0];
    const best = Math.max(...hist.map((h) => h.monthsCovered || 0));
    const cur = hist.at(-1);
    document.getElementById("sn-history").textContent =
      `Started ${first.date}. Highest: ${fmtMonths(best)} months. Current: ${fmtMonths(cur.monthsCovered)} months.`;
  }

  const nextM = months != null ? Math.ceil(months) + 1 : 1;
  document.getElementById("next-milestone").textContent =
    months != null
      ? `Observed progress toward ${nextM} full months of needs covered.`
      : "Add more transaction history to estimate needs spending.";

  const billEl = document.getElementById("bill-changes");
  if (!bills.length) {
    billEl.innerHTML = '<p class="small">Recurring bills appear after 3+ similar charges over time.</p>';
  } else {
    billEl.innerHTML = bills.slice(0, 8).map((b) => {
      const ch = b.change1;
      const cls = ch > 0 ? "bill-change-up" : ch < 0 ? "bill-change-down" : "";
      const sign = ch > 0 ? `+$${ch.toFixed(0)}` : ch < 0 ? `-$${Math.abs(ch).toFixed(0)}` : "No change";
      return `<div class="bill-row"><span>${escapeHtml(b.label)}</span><span class="${cls}">${sign}</span></div>`;
    }).join("");
  }

  document.getElementById("bar-needs").style.width = `${nw.needsPct}%`;
  document.getElementById("bar-wants").style.width = `${nw.wantsPct}%`;
  const needsAmtEl = document.getElementById("needs-amt");
  const wantsAmtEl = document.getElementById("wants-amt");
  needsAmtEl.innerHTML = `<button type="button" class="nw-toggle" data-nw="need">Needs ${fmtMoney(nw.needs)} (${nw.needsPct}%) ▾</button>`;
  wantsAmtEl.innerHTML = `<button type="button" class="nw-toggle" data-nw="want">Wants ${fmtMoney(nw.wants)} (${nw.wantsPct}%) ▾</button>`;
  document.getElementById("nw-detail").innerHTML = "";

  document.getElementById("subs-summary").textContent =
    subs.count
      ? `${subs.count} recurring services observed (~${fmtMoney(subs.monthly)}/mo).`
      : "No subscription pattern detected yet.";

  document.getElementById("insights-list").innerHTML = insights.map((i) => `<li>${escapeHtml(i)}</li>`).join("") ||
    "<li>Upload more history to surface patterns.</li>";

  const windowSelect = document.getElementById("analysis-window-select");
  if (windowSelect) windowSelect.value = String(state.analysisWindowDays || 365);
  renderPatternInsights(txs);

  populateCashEntryCategoryOptions();
  renderCashEntryTagChips();
  renderWhatToDo(txs);

  renderCategoryReview(txs);
  renderTags(txs);
}


// Category fix in dashboard
document.addEventListener("change", (e) => {
  const sel = e.target.closest(".cat-fix-select");
  if (!sel) return;
  const txId = sel.dataset.txId;
  const merchant = sel.dataset.merchant;
  const newCat = sel.value;
  // Update all transactions with same merchant
  state.transactions = state.transactions.map((tx) => {
    if (merchant && tx.merchant === merchant) return { ...tx, category: newCat, confidence: 1 };
    if (tx.id === txId) return { ...tx, category: newCat, confidence: 1 };
    return tx;
  });
  if (merchant) state.merchantMemory[merchant] = newCat;
  saveState(state);
  maybeShowAtmCashAlert(newCat);
});


// Budget guidelines now live in categories.js (BUDGET_GUIDELINES + getSpendingTier), shared with patterns.js

// Needs vs Wants drill-down
document.addEventListener("click", (e) => {
  const btn = e.target.closest(".nw-toggle");
  if (!btn) return;
  const type = btn.dataset.nw; // "need" or "want"
  const txs = getFilteredTransactions();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);

  // Sum income over the same 90-day window for % calculations
  const monthlyIncome = txs
    .filter((tx) => tx.amount > 0 && tx.category === "Income" && new Date(tx.date) >= cutoff)
    .reduce((s, tx) => s + tx.amount, 0) / 3; // 90 days = ~3 months

  const filtered = txs.filter((tx) => {
    if (tx.amount >= 0) return false;
    if (new Date(tx.date) < cutoff) return false;
    const EXCLUDE = new Set(["Safety Net Contribution", "Transfer from Savings", "Transfer from Checking", "Savings", "Income", "Interest Income", "One-Time Income", "Transfer", "Unknown"]);
    if (EXCLUDE.has(tx.category)) return false;
    if (tx.amount >= 0) return false; // deposits/credits excluded
    return tx.needWant === type;
  });

  // Aggregate by category and merchant
  const byCat = new Map();
  const byMerchant = new Map();
  for (const tx of filtered) {
    const cat = tx.category || "Unknown";
    const mer = tx.merchant || tx.description.slice(0, 30);
    byCat.set(cat, (byCat.get(cat) || 0) + Math.abs(tx.amount));
    byMerchant.set(mer, (byMerchant.get(mer) || 0) + Math.abs(tx.amount));
  }

  const topCats = [...byCat.entries()].sort((a, b) => b[1] - a[1]);
  const topMerchants = [...byMerchant.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const totalSpend = topCats.reduce((s, [, v]) => s + v, 0);
  const maxCatAmt = topCats[0]?.[1] || 1;
  const label = type === "need" ? "Needs" : "Wants";

  // Build category bar chart rows with optional income % flag
  function catRow(cat, amt) {
    const barPct = Math.round((amt / maxCatAmt) * 100);
    const spendPct = totalSpend > 0 ? Math.round((amt / totalSpend) * 100) : 0;
    const guideline = BUDGET_GUIDELINES[cat];
    const monthlyAmt = amt / 3;
    const incomePct = monthlyIncome > 0 ? Math.round((monthlyAmt / monthlyIncome) * 100) : null;
    const tierInfo = guideline && incomePct != null ? getSpendingTier(incomePct, guideline) : { tier: null, overGuideline: false };

    const tierColors = { "Careful": "var(--teal)", "Standard": "#3a6ea5", "Generous": "#c98a1f" };
    const tierBadgeHtml = tierInfo.tier
      ? `<span style="font-size:0.68rem;font-weight:700;padding:0.1rem 0.45rem;border-radius:999px;margin-left:0.4rem;color:#fff;background:${tierInfo.overGuideline ? '#c0392b' : tierColors[tierInfo.tier]};">${tierInfo.overGuideline ? "Over Guideline" : tierInfo.tier}</span>`
      : "";

    const tooltipText = guideline
      ? (incomePct != null
          ? `${cat}: you're at ${incomePct}% of monthly income (${tierInfo.tier}${tierInfo.overGuideline ? ", above the usual Generous ceiling" : ""}). Careful ≤${Math.round(tierInfo.careful)}% · Standard ≤${Math.round(tierInfo.standard)}% · Generous ≤${Math.round(tierInfo.generous)}%. ${guideline.note}`
          : `${cat}: guideline is ${guideline.aim}% or less of income. Add income transactions to see your %.`)
      : null;

    const iconColor = tierInfo.overGuideline ? "#c0392b" : "var(--muted)";
    const iconHtml = tooltipText
      ? `<span title="${tooltipText.replace(/"/g, "&quot;")}" tabindex="0" style="display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;border-radius:50%;border:1.5px solid ${iconColor};color:${iconColor};font-size:9px;font-weight:700;cursor:help;flex-shrink:0;line-height:1;margin-left:4px;vertical-align:middle;">i</span>`
      : "";

    return '<div style="margin:0.5rem 0;">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:0.5rem;flex-wrap:wrap;">' +
        '<span style="font-size:0.88rem;font-weight:600;color:var(--navy);display:inline-flex;align-items:center;">' + escapeHtml(cat) + iconHtml + tierBadgeHtml + '</span>' +
        '<span style="font-size:0.82rem;color:var(--muted);white-space:nowrap;">' + fmtMoney(amt) + ' · ' + spendPct + '%' + (incomePct != null ? ' · ' + incomePct + '% income' : '') + '</span>' +
      '</div>' +
      '<div style="background:var(--border);border-radius:999px;height:8px;margin:0.25rem 0;">' +
        '<div style="background:' + (tierInfo.overGuideline ? '#e8a028' : 'var(--teal)') + ';width:' + barPct + '%;height:8px;border-radius:999px;transition:width 0.3s;"></div>' +
      '</div>' +
      (tierInfo.overGuideline && guideline ? `<p style='font-size:0.78rem;color:#7a5000;background:#fef6e4;border:1px solid #f0d080;border-radius:8px;padding:0.35rem 0.6rem;margin:0.3rem 0 0;'>${escapeHtml(guideline.note)} Aim for ${guideline.aim}% or less. You are at ${incomePct}%.</p>` : '') +
    '</div>';
  }

  const detail = document.getElementById("nw-detail");
  // Build merchant bar rows (same style as catRow)
  function merchantRow(mer, amt) {
    const barPct = Math.round((amt / (topMerchants[0]?.[1] || 1)) * 100);
    const spendPct = totalSpend > 0 ? Math.round((amt / totalSpend) * 100) : 0;
    return `<div style="margin:0.5rem 0;">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:0.5rem;flex-wrap:wrap;">
        <span style="font-size:0.88rem;font-weight:600;color:var(--navy);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:65%;">${escapeHtml(mer)}</span>
        <span style="font-size:0.82rem;color:var(--muted);white-space:nowrap;">${fmtMoney(amt)} · ${spendPct}%</span>
      </div>
      <div style="background:var(--border);border-radius:999px;height:8px;margin:0.25rem 0;">
        <div style="background:var(--slate);width:${barPct}%;height:8px;border-radius:999px;transition:width 0.3s;"></div>
      </div>
    </div>`;
  }

  let nwView = detail.dataset.view || "categories";
  function renderNwDetail() {
    detail.innerHTML = `
      <div style="margin-top:0.75rem;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.65rem;flex-wrap:wrap;gap:0.4rem;">
          <strong style="color:var(--navy);">${label} Breakdown (90 days) · ${fmtMoney(totalSpend)}</strong>
          <div style="display:flex;border:1px solid var(--border);border-radius:8px;overflow:hidden;font-size:0.82rem;">
            <button type="button" data-nw-view="categories" style="padding:0.3rem 0.65rem;border:none;cursor:pointer;background:${nwView==="categories"?"var(--navy)":"#fff"};color:${nwView==="categories"?"#fff":"var(--slate)"};">Categories</button>
            <button type="button" data-nw-view="merchants" style="padding:0.3rem 0.65rem;border:none;cursor:pointer;background:${nwView==="merchants"?"var(--navy)":"#fff"};color:${nwView==="merchants"?"#fff":"var(--slate)"};">Merchants</button>
          </div>
        </div>
        ${nwView === "categories"
          ? (topCats.map(([cat, amt]) => catRow(cat, amt)).join("") || "<p class='small'>No transactions found.</p>")
          : (topMerchants.map(([mer, amt]) => merchantRow(mer, amt)).join("") || "<p class='small'>No merchants found.</p>")
        }
        ${monthlyIncome > 0
          ? `<p class="small" style="margin-top:0.75rem;color:var(--muted);">Income estimate: ${fmtMoney(monthlyIncome)}/mo (90-day avg). Percentages of income are monthly averages.</p>`
          : `<p class="small" style="margin-top:0.75rem;color:var(--muted);">Add income transactions to unlock % of income breakdowns and budget guidance.</p>`}
      </div>`;
    // Wire toggle buttons
    detail.querySelectorAll("[data-nw-view]").forEach((btn) => {
      btn.addEventListener("click", () => {
        nwView = btn.dataset.nwView;
        detail.dataset.view = nwView;
        renderNwDetail();
      });
    });
  }
  renderNwDetail();
});

document.getElementById("btn-download-snapshot").addEventListener("click", () => downloadSnapshot(state));

document.getElementById("btn-add-more").addEventListener("click", () => {
  pendingPaste = [];
  show("upload");
});

document.getElementById("btn-clear-device").addEventListener("click", () => {
  const msg = `Remove all Nettly data stored on this device?

Privacy and security matter. Nettly does not store transaction history on its servers.

Transaction data is currently stored only on this device to keep things running smoothly between visits.

Removing local data cannot be undone.

To continue where things left off later, save the most recent Snapshot before removing data from this device.`;
  if (confirm(msg)) {
    clearState();
    state = defaultState();
    pendingPaste = [];
    overlapFlag = false;
    show("home");
  }
});


function renderCategoryReview(txs) {
  const el = document.getElementById("cat-review-list");
  if (!el) return;
  const recent = txs
    .filter((tx) => tx.amount < 0)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 40);
  el.innerHTML = recent.map((tx) => `
    <div class="tx-tag-row" style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;">
      <div style="flex:1;min-width:0;">
        <div style="font-size:0.85rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(tx.date)} · ${escapeHtml(tx.description.slice(0,40))}</div>
        <div class="small">${fmtMoney(Math.abs(tx.amount))}</div>
      </div>
      <select class="cat-fix-select" data-tx-id="${escapeAttr(tx.id)}" data-merchant="${escapeAttr(tx.merchant||'')}" style="font-size:0.82rem;padding:0.3rem 0.4rem;width:auto;flex-shrink:0;">
        ${CATEGORIES.map((cat) => `<option${cat === tx.category ? " selected" : ""}>${escapeHtml(cat)}</option>`).join("")}
      </select>
    </div>`).join("");
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

async function bootApp(fromUnlock = false) {
  const hasAccess = fromUnlock || (await ensureAccess());
  if (!hasAccess) {
    show("gate");
    return;
  }

  syncHomeCouples();
  const params = new URLSearchParams(window.location.search);
  const start = params.get("start");

  if (start === "new") {
    history.replaceState({}, "", window.location.pathname);
    document.getElementById("btn-new").click();
    return;
  }

  if (start === "snapshot") {
    history.replaceState({}, "", window.location.pathname);
    show("home");
    document.getElementById("btn-continue").click();
    return;
  }

  if (state.transactions?.length) {
    renderDashboard();
    show("dashboard");
  } else {
    show("home");
  }
}

bootApp();
