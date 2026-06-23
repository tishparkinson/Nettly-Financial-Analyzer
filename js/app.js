import { CATEGORIES, DEFAULT_TAGS, CLOTHING_TAGS } from "./categories.js";
import { parseTransactions, dedupeTransactions } from "./parser.js";
import {
  applyCategories,
  merchantsNeedingReview,
  averageNeedsSpending,
  computeMonthsCovered,
  needsVsWants,
  detectRecurring,
  detectRecurring45,
  subscriptionSummary,
  stabilityLabel,
  simpleInsights,
  updateStreaks,
  updateRecords,
  filterByPerson,
  tagSummaries
} from "./analytics.js";
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
  if (name === "home") syncHomeCouples();
  if (name === "upload") {
    syncUploadCouples();
    syncUploadCouplesCheckbox();
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
  return filterByPerson(
    state.transactions,
    state.accountOwners || {},
    state.dashboardPersonFilter || "combined",
    state.partners
  );
}

function syncHomeCouples() {
  const cb = document.getElementById("couples-mode-home");
  const namesWrap = document.getElementById("couples-names-home");
  cb.checked = Boolean(state.couplesMode);
  namesWrap.classList.toggle("hidden", !state.couplesMode);
  document.getElementById("partner-primary-name").value = state.partners?.primary || "You";
  document.getElementById("partner-secondary-name").value = state.partners?.secondary || "Partner";
}

function syncUploadCouples() {
  const wrap = document.getElementById("acct-owner-wrap");
  wrap.classList.toggle("hidden", !state.couplesMode);
  if (!state.couplesMode) return;
  const sel = document.getElementById("acct-owner");
  sel.options[0].text = state.partners?.primary || "You";
  sel.options[1].text = state.partners?.secondary || "Partner";
}

function saveCouplesFromHome() {
  state.couplesMode = document.getElementById("couples-mode-home").checked;
  state.partners = {
    primary: document.getElementById("partner-primary-name").value.trim() || "You",
    secondary: document.getElementById("partner-secondary-name").value.trim() || "Partner"
  };
  saveState(state);
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
document.getElementById("couples-mode-home").addEventListener("change", (e) => {
  document.getElementById("couples-names-home").classList.toggle("hidden", !e.target.checked);
  saveCouplesFromHome();
});

document.getElementById("partner-primary-name").addEventListener("input", saveCouplesFromHome);
document.getElementById("partner-secondary-name").addEventListener("input", saveCouplesFromHome);

document.getElementById("btn-new").addEventListener("click", () => {
  state = defaultState();
  state.startedAt = new Date().toISOString();
  pendingPaste = [];
  saveState(state);
  show("upload");
  syncUploadCouples();
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

// Sync upload-screen couples checkbox with state
function syncUploadCouplesCheckbox() {
  const cb = document.getElementById("couples-mode-upload");
  if (!cb) return;
  cb.checked = Boolean(state.couplesMode);
  const namesWrap = document.getElementById("couples-names-upload");
  if (namesWrap) namesWrap.classList.toggle("hidden", !state.couplesMode);
  const prim = document.getElementById("upload-primary-name");
  const sec = document.getElementById("upload-secondary-name");
  if (prim) prim.value = state.partners?.primary || "You";
  if (sec) sec.value = state.partners?.secondary || "Partner";
}

(document.getElementById("couples-mode-upload") || document.createElement("input")).addEventListener("change", (e) => {
  state.couplesMode = e.target.checked;
  document.getElementById("couples-names-upload").classList.toggle("hidden", !e.target.checked);
  // sync hidden home inputs too
  const homeCb = document.getElementById("couples-mode-home");
  if (homeCb) homeCb.checked = e.target.checked;
  saveState(state);
  syncUploadCouples(); // updates account owner dropdown
});

(document.getElementById("upload-primary-name") || document.createElement("input")).addEventListener("input", (e) => {
  state.partners = { ...state.partners, primary: e.target.value.trim() || "You" };
  document.getElementById("partner-primary-name").value = e.target.value;
  saveState(state);
});

(document.getElementById("upload-secondary-name") || document.createElement("input")).addEventListener("input", (e) => {
  state.partners = { ...state.partners, secondary: e.target.value.trim() || "Partner" };
  document.getElementById("partner-secondary-name").value = e.target.value;
  saveState(state);
});



document.getElementById("btn-upload-start-over").addEventListener("click", () => {
  if (!confirm("Clear everything and start fresh? This removes all accounts and transactions you\'ve added.")) return;
  const { couplesMode, partners } = state;
  state = defaultState();
  state.couplesMode = couplesMode;
  state.partners = { ...partners };
  pendingPaste = [];
  overlapFlag = false;
  saveState(state);
  document.getElementById("acct-nickname").value = "";
  document.getElementById("paste-tx").value = "";
  document.getElementById("pending-accounts").classList.add("hidden");
  document.getElementById("account-list").innerHTML = "";
  show("home");
});

document.getElementById("btn-add-account").addEventListener("click", () => {
  const nickname = document.getElementById("acct-nickname").value.trim();
  const accountType = document.getElementById("acct-type").value;
  const text = document.getElementById("paste-tx").value;
  if (!nickname || !text.trim()) {
    alert("Add an account nickname and paste some transactions.");
    return;
  }
  const owner = state.couplesMode ? document.getElementById("acct-owner").value : "primary";
  state.accountOwners[nickname] = owner;
  const parsed = parseTransactions(text, nickname, accountType);
  if (!parsed.length) {
    alert("We could not find transactions in that paste. Try including dates and amounts on each line.");
    return;
  }
  pendingPaste.push({ nickname, accountType, transactions: parsed, owner });
  document.getElementById("paste-tx").value = "";
  saveState(state);
  renderPendingAccounts();
});

function renderPendingAccounts() {
  const wrap = document.getElementById("pending-accounts");
  const list = document.getElementById("account-list");
  if (!pendingPaste.length) {
    wrap.classList.add("hidden");
    return;
  }
  wrap.classList.remove("hidden");
  const ownerLabel = (o) => {
    if (!state.couplesMode) return "";
    if (o === "secondary") return ` · ${state.partners?.secondary || "Partner"}`;
    if (o === "joint") return " · Joint";
    return ` · ${state.partners?.primary || "You"}`;
  };
  list.innerHTML = pendingPaste
    .map((p) => `<li>${p.nickname} (${p.accountType})${ownerLabel(p.owner)} — ${p.transactions.length} rows</li>`)
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
    if (batch.owner) state.accountOwners[batch.nickname] = batch.owner;
  }

  const { added, overlapDetected } = dedupeTransactions(state.transactions, allNew);
  overlapFlag = overlapDetected;

  let categorized = applyCategories(added, state.merchantMemory, state.categoryNeedWant);
  state.transactions = state.transactions.concat(categorized);

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
    renderMerchantReview(review, unknownPct);
    show("merchants");
  } else {
    show("safety");
    renderSafetySummary();
  }
});

// --- Merchants ---
function renderMerchantReview(review, unknownPct = 0) {
  const container = document.getElementById("merchant-list");
  // Also include Unknown transactions not in review list
  const unknownMerchants = new Map();
  for (const tx of state.transactions) {
    if (tx.category === "Unknown") {
      const m = tx.merchant || tx.description.slice(0, 40);
      if (!unknownMerchants.has(m)) unknownMerchants.set(m, { merchant: m, count: 0, sample: tx.description });
      unknownMerchants.get(m).count++;
    }
  }
  const allReview = [...review];
  for (const [m, g] of unknownMerchants) {
    if (!allReview.find((r) => r.merchant === m)) allReview.push(g);
  }
  const warningHtml = unknownPct > 0.15
    ? `<div style="background:#fef6e4;border:1px solid #f0d080;border-radius:10px;padding:0.75rem 1rem;margin-bottom:0.75rem;font-size:0.88rem;color:#7a5000;">
        <strong>${Math.round(unknownPct * 100)}% of your transactions are uncategorized.</strong>
        Categorizing them now makes your dashboard far more useful. Set a category for each merchant below — it applies to all matching transactions.
       </div>`
    : "";
  container.innerHTML = warningHtml + allReview.slice(0, 30).map((g) => `
    <div class="merchant-review" data-merchant="${escapeAttr(g.merchant)}">
      <strong>${escapeHtml(g.merchant)}</strong>
      <span class="small"> — seen ${g.count} time${g.count > 1 ? "s" : ""}</span>
      <label>Category (applies to all)</label>
      <select class="merchant-cat">${CATEGORIES.map((cat) => `<option${cat === "Unknown" ? "" : ""}>${cat}</option>`).join("")}</select>
    </div>
  `).join("");
}

document.getElementById("btn-merchants-done").addEventListener("click", () => {
  document.querySelectorAll(".merchant-review").forEach((row) => {
    const merchant = row.dataset.merchant;
    const cat = row.querySelector(".merchant-cat").value;
    state.merchantMemory[merchant] = cat;
    state.transactions = state.transactions.map((tx) => {
      if (tx.merchant === merchant) {
        return { ...tx, category: cat, confidence: 1 };
      }
      return tx;
    });
  });
  saveState(state);
  startWeeklyReview();
});


// ═══════════════════════════════════════════════════════
// WEEK-BY-WEEK TRANSACTION REVIEW
// ═══════════════════════════════════════════════════════
let reviewWeeks = [];      // [{label, txIds}] sorted newest→oldest
let reviewWeekIdx = 0;     // current week index
let reviewAccountList = []; // accounts to cycle through
let reviewAcctIdx = 0;     // current account index

function startWeeklyReview() {
  // Get all accounts that have transactions
  const acctNames = [...new Set(state.transactions.map((tx) => tx.account))].filter(Boolean);
  reviewAccountList = acctNames;
  reviewAcctIdx = 0;
  startReviewForAccount();
}

function startReviewForAccount() {
  const acct = reviewAccountList[reviewAcctIdx];
  const acctTxs = state.transactions
    .filter((tx) => tx.amount < 0 && tx.account === acct)
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
        <span style="font-size:0.82rem;color:var(--muted);">${escapeHtml(tx.date)}</span>
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
        ${tx.category === "Clothing, Shoes & Apparel" ? `
          <p style="font-size:0.72rem;color:var(--teal);margin:0 0 0.3rem;font-weight:600;">
            💡 Tag who this is for and what type — helps track per-person clothing spend over time.
          </p>
          <div style="display:flex;flex-wrap:wrap;gap:0.3rem;margin-bottom:0.4rem;">
            ${CLOTHING_TAGS.map((tag) =>
              `<button type="button" class="tag-chip review-tag-chip${(tx.tags||[]).includes(tag) ? " active" : ""}"
                data-tx-id="${escapeAttr(tx.id)}" data-tag="${escapeAttr(tag)}"
                style="font-size:0.75rem;padding:0.2rem 0.55rem;background:${(tx.tags||[]).includes(tag)?"var(--teal-soft)":"#f0f9f9"};border-color:${(tx.tags||[]).includes(tag)?"var(--teal)":"#c5dede"};">${escapeHtml(tag)}</button>`
            ).join("")}
          </div>
          <p style="font-size:0.7rem;color:var(--muted);margin:0 0 0.3rem;">Or add from all tags:</p>` : ""}
        <div style="display:flex;flex-wrap:wrap;gap:0.3rem;margin-bottom:0.3rem;">
          ${[...DEFAULT_TAGS, ...(state.customTags || [])].map((tag) =>
            `<button type="button" class="tag-chip review-tag-chip${(tx.tags||[]).includes(tag) ? " active" : ""}"
              data-tx-id="${escapeAttr(tx.id)}" data-tag="${escapeAttr(tag)}"
              style="font-size:0.75rem;padding:0.2rem 0.55rem;">${escapeHtml(tag)}</button>`
          ).join("")}
        </div>
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
    sel.addEventListener("change", () => saveReviewTx(sel.dataset.txId, sel.value, null, null, null, null));
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

  const avgNeeds = averageNeedsSpending(state.transactions);
  const months = computeMonthsCovered(total, avgNeeds);
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
  const avg = averageNeedsSpending(state.transactions);
  const months = computeMonthsCovered(total, avg);
  el.classList.remove("hidden");
  el.innerHTML = `
    <h3>Current Safety Net</h3>
    <p><strong>${fmtMoney(total)}</strong></p>
    <p class="small">Months Covered (needs only, 90-day average): <strong>${fmtMonths(months)}</strong></p>
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
  downloadSnapshot(state);
});

// --- Dashboard ---
function renderCouplesFilter() {
  const wrap = document.getElementById("couples-filter-wrap");
  wrap.classList.toggle("hidden", !state.couplesMode);
  if (!state.couplesMode) return;
  const bar = document.getElementById("couples-filter-bar");
  const filter = state.dashboardPersonFilter || "combined";
  bar.querySelector('[data-filter="primary"]').textContent = state.partners?.primary || "You";
  bar.querySelector('[data-filter="secondary"]').textContent = state.partners?.secondary || "Partner";
  bar.querySelectorAll("button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.filter === filter);
  });
}

document.getElementById("couples-filter-bar").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-filter]");
  if (!btn) return;
  state.dashboardPersonFilter = btn.dataset.filter;
  saveState(state);
  renderDashboard();
});

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

  const totals = tagSummaries(txs);
  const totalsEl = document.getElementById("tag-totals");
  totalsEl.innerHTML = totals.length
    ? totals.slice(0, 8).map((t) => `<div><strong>${escapeHtml(t.tag)}</strong> — ${fmtMoney(t.total)} (90 days)</div>`).join("")
    : "<p>No tagged spending yet. Select a tag, then tap transactions below.</p>";

  const recent = txs
    .filter((tx) => tx.amount < 0)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 50);

  const applyBtnHtml = `<div style="margin:0.5rem 0;display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;">
    <button type="button" class="btn btn-secondary" id="btn-apply-tag-checked" style="width:auto;margin:0;padding:0.4rem 0.85rem;font-size:0.88rem;"
      ${activeTag ? "" : "disabled"}>Apply "${escapeHtml(activeTag || "")}" to checked</button>
    <button type="button" class="btn btn-ghost" id="btn-check-all-tags" style="width:auto;margin:0;padding:0.4rem 0.85rem;font-size:0.88rem;">Check all</button>
    <button type="button" class="btn btn-ghost" id="btn-uncheck-all-tags" style="width:auto;margin:0;padding:0.4rem 0.85rem;font-size:0.88rem;">Uncheck all</button>
  </div>`;

  document.getElementById("tx-tag-list").innerHTML = recent.length
    ? applyBtnHtml + recent.map((tx) => {
      const tagStr = (tx.tags || []).length ? (tx.tags || []).map((t) => `#${escapeHtml(t)}`).join(" ") : "";
      return `<div class="tx-tag-row" style="display:grid;grid-template-columns:1.25rem 1fr;gap:0.5rem;align-items:start;">
        <input type="checkbox" class="tx-tag-check" data-tx-id="${escapeAttr(tx.id)}" style="margin-top:0.25rem;flex-shrink:0;">
        <div style="min-width:0;cursor:pointer;overflow:hidden;" data-tx-id="${escapeAttr(tx.id)}">
          <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(tx.date)} · ${escapeHtml(tx.description.slice(0, 50))}</div>
          <div class="small">${fmtMoney(Math.abs(tx.amount))} ${tagStr ? `· ${tagStr}` : ""}</div>
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
    document.querySelectorAll(".tx-tag-check:checked").forEach((cb) => {
      const txId = cb.dataset.txId;
      const tx = state.transactions.find((t) => t.id === txId);
      if (tx && !(tx.tags || []).includes(activeTag)) {
        state.transactions = state.transactions.map((t) =>
          t.id === txId ? { ...t, tags: [...(t.tags || []), activeTag] } : t
        );
      }
    });
    saveState(state);
    renderTags(getFilteredTransactions());
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

function renderDashboard() {
  const txs = getFilteredTransactions();
  const total = computeSafetyNetBalance(state.safetyNet);
  const avgNeeds = averageNeedsSpending(txs);
  const months = computeMonthsCovered(total, avgNeeds);
  const nw = needsVsWants(txs);
  const bills = detectRecurring(txs);
  const subs = subscriptionSummary(txs);
  const stability = stabilityLabel(state.safetyNetHistory);
  const insights = simpleInsights(txs);
  const records = state.personalRecords || {};

  renderCouplesFilter();

  document.getElementById("overlap-notice").classList.toggle("hidden", !overlapFlag);
  document.getElementById("months-covered").textContent = fmtMonths(months);
  document.getElementById("sn-current").textContent = fmtMoney(total);
  document.getElementById("growth-streak").textContent = String(state.streaks?.growthStreak || 0);
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
});


// Budget guidelines (% of monthly take-home, soft ceiling)
const BUDGET_GUIDELINES = {
  "Housing": { aim: 30, note: "Aim to keep housing under 30% of take-home." },
  "Transportation": { aim: 15, note: "Most budgets target transportation under 15% of take-home." },
  "Groceries": { aim: 12, note: "A common grocery target is under 12% of take-home." },
  "Dining Out": { aim: 8, note: "Dining out tends to add up — many households aim for under 8%." },
  "Fast Food": { aim: 5, note: "Fast food under 5% of take-home keeps it manageable." },
  "Coffee & Convenience": { aim: 4, note: "Coffee and convenience stops can sneak up — under 4% is a common target." },
  "Utilities": { aim: 8, note: "Utilities typically run 5–8% of take-home." },
  "Insurance": { aim: 20, note: "Insurance (all types) often lands between 10–20% of take-home." },
  "Healthcare": { aim: 8, note: "Healthcare costs vary widely — many budgets target under 8%." },
  "Subscriptions": { aim: 5, note: "Subscriptions are easy to accumulate — under 5% is a reasonable cap." },
  "Personal Care": { aim: 5, note: "Personal care typically runs 3–5% of take-home." },
  "Charity & Donations": { aim: 10, note: "Many aim to give 5–10% — whatever fits your values and situation." },
  "Religious Contribution": { aim: 10, note: "Tithing and religious giving are deeply personal — this is just for awareness." },
  "ATM & Bank Fees": { aim: 1, note: "Bank fees ideally stay under 1% of take-home — most can be avoided entirely." },
  "Gifts": { aim: 5, note: "Gift spending often spikes seasonally — under 5% annually is a common guideline." },
};

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
    const overBudget = guideline && incomePct != null && incomePct > guideline.aim;

    const tooltipText = guideline
      ? (incomePct != null
          ? `${cat}: you're at ${incomePct}% of monthly income. Guideline: aim for ${guideline.aim}% or less. ${guideline.note}`
          : `${cat}: guideline is ${guideline.aim}% or less of income. Add income transactions to see your %.`)
      : null;

    const iconColor = overBudget ? "#c0392b" : "var(--muted)";
    const iconHtml = tooltipText
      ? `<span title="${tooltipText.replace(/"/g, "&quot;")}" tabindex="0" style="display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;border-radius:50%;border:1.5px solid ${iconColor};color:${iconColor};font-size:9px;font-weight:700;cursor:help;flex-shrink:0;line-height:1;margin-left:4px;vertical-align:middle;">i</span>`
      : "";

    return '<div style="margin:0.5rem 0;">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:0.5rem;flex-wrap:wrap;">' +
        '<span style="font-size:0.88rem;font-weight:600;color:var(--navy);display:inline-flex;align-items:center;">' + escapeHtml(cat) + iconHtml + '</span>' +
        '<span style="font-size:0.82rem;color:var(--muted);white-space:nowrap;">' + fmtMoney(amt) + ' · ' + spendPct + '%' + (incomePct != null ? ' · ' + incomePct + '% income' : '') + '</span>' +
      '</div>' +
      '<div style="background:var(--border);border-radius:999px;height:8px;margin:0.25rem 0;">' +
        '<div style="background:' + (overBudget ? '#e8a028' : 'var(--teal)') + ';width:' + barPct + '%;height:8px;border-radius:999px;transition:width 0.3s;"></div>' +
      '</div>' +
      (overBudget && guideline ? `<p style='font-size:0.78rem;color:#7a5000;background:#fef6e4;border:1px solid #f0d080;border-radius:8px;padding:0.35rem 0.6rem;margin:0.3rem 0 0;'>${escapeHtml(guideline.note)} Aim for ${guideline.aim}% or less. You are at ${incomePct}%.</p>` : '') +
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
