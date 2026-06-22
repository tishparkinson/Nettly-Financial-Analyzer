import { CATEGORIES, DEFAULT_TAGS } from "./categories.js";
import { parseTransactions, dedupeTransactions } from "./parser.js";
import {
  applyCategories,
  merchantsNeedingReview,
  averageNeedsSpending,
  computeMonthsCovered,
  needsVsWants,
  detectRecurring,
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
  safety: document.getElementById("screen-safety"),
  dashboard: document.getElementById("screen-dashboard")
};

function show(name) {
  Object.values(screens).forEach((el) => el.classList.remove("active"));
  screens[name].classList.add("active");
  if (name === "home") syncHomeCouples();
  if (name === "upload") syncUploadCouples();
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
  saveCouplesFromHome();
  const { couplesMode, partners } = state;
  state = defaultState();
  state.couplesMode = couplesMode;
  state.partners = { ...partners };
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

  state.streaks = updateStreaks(state, true);
  pendingPaste = [];
  saveState(state);

  const review = merchantsNeedingReview(state.transactions);
  if (review.length) {
    renderMerchantReview(review);
    show("merchants");
  } else {
    show("safety");
    renderSafetySummary();
  }
});

// --- Merchants ---
function renderMerchantReview(review) {
  const container = document.getElementById("merchant-list");
  container.innerHTML = review.slice(0, 12).map((g) => `
    <div class="merchant-review" data-merchant="${escapeAttr(g.merchant)}">
      <strong>${escapeHtml(g.merchant)}</strong>
      <span class="small"> — seen ${g.count} time${g.count > 1 ? "s" : ""}</span>
      <label>Category (applies to all)</label>
      <select class="merchant-cat">${CATEGORIES.map((c) => `<option>${c}</option>`).join("")}</select>
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
  show("safety");
  populateSafetyNetAccountList();
  renderSafetySummary();
});

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


// Needs vs Wants drill-down
document.addEventListener("click", (e) => {
  const btn = e.target.closest(".nw-toggle");
  if (!btn) return;
  const type = btn.dataset.nw; // "need" or "want" (matches tx.needWant)
  const txs = getFilteredTransactions();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);
  const filtered = txs.filter((tx) => {
    if (tx.amount >= 0) return false;
    if (new Date(tx.date) < cutoff) return false;
    if (tx.category === "Safety Net Contribution" || tx.category === "Transfer from Savings") return false;
    return tx.needWant === type || (type === 'need' && tx.needWant === 'needs') || (type === 'want' && tx.needWant === 'wants');
  });

  // Top categories
  const byCat = new Map();
  const byMerchant = new Map();
  for (const tx of filtered) {
    const cat = tx.category || "Unknown";
    const mer = tx.merchant || tx.description.slice(0, 30);
    byCat.set(cat, (byCat.get(cat) || 0) + Math.abs(tx.amount));
    byMerchant.set(mer, (byMerchant.get(mer) || 0) + Math.abs(tx.amount));
  }
  const topCats = [...byCat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  const topMerchants = [...byMerchant.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);

  const detail = document.getElementById("nw-detail");
  const label = type === "needs" ? "Needs" : "Wants";
  detail.innerHTML = `
    <div class="nw-breakdown">
      <h4 style="margin:0.75rem 0 0.4rem;color:var(--navy);">${label} — Top Categories (90 days)</h4>
      ${topCats.map(([cat, amt]) => `<div class="bill-row"><span>${escapeHtml(cat)}</span><span>${fmtMoney(amt)}</span></div>`).join("") || "<p class='small'>None.</p>"}
      <h4 style="margin:0.75rem 0 0.4rem;color:var(--navy);">${label} — Top Merchants</h4>
      ${topMerchants.map(([mer, amt]) => `<div class="bill-row"><span>${escapeHtml(mer)}</span><span>${fmtMoney(amt)}</span></div>`).join("") || "<p class='small'>None.</p>"}
    </div>`;
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
