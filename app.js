const STORAGE_KEY = "quickexhale-web-v1";
const SUPABASE_URL = window.ENV_SUPABASE_URL || "";
const SUPABASE_ANON_KEY = window.ENV_SUPABASE_ANON_KEY || "";
const PRO_MONTHLY_PRICE = 9;
const PRO_FEATURES = {
  calendarExport: true,
  cloudBackup: true
};

const CHIPS = [
  "Kids / Dependents", "Partner / Family", "Pets", "Work Pressure", "Medical Responsibilities",
  "Financial Stress", "Subscription Stress", "Security / Admin", "Home", "Car",
  "School", "Technology", "Caregiving", "Travel (Plane)", "Travel (Car)",
  "High Stress Week", "Tight Budget Month", "Upcoming Trip (1 week)",
  "Upcoming Trip (1 month)", "Upcoming Trip (3 months)"
];

const PROMPTS = {
  common: [
    "Reply to email", "Call or text someone back", "Pay bill", "Deadline check", "Important conversation",
    "Follow up with someone", "Appointment or follow-up", "School or work form", "Renewal reminder", "Password reset",
    "Storage full warning", "Grocery or meal plan", "Laundry or cleaning supplies", "Bank or statement check",
    "Shift schedule check", "Set money aside for something"
  ],
  "Work Pressure": ["Status check", "Schedule deep work block", "Track/report hours", "Ask manager about priority"],
  "Financial Stress": ["Pause subscription", "Change due date", "Payment reminder", "Review recurring charges"],
  "Subscription Stress": ["Cancel unused trial", "Split subscription cost", "Pause entertainment service"],
  "Security / Admin": ["2FA backup", "Recovery email check", "Replace lost card", "Backup phone photos"],
  "Travel (Plane)": ["Plane tickets", "Hotel booking", "Packing list", "Airport transfer plan"],
  "Travel (Car)": ["Tire check", "Oil change", "Emergency kit", "Car registration reminder"],
  "Medical Responsibilities": ["Prescription refill", "Lab results follow-up", "Insurance call", "Dental check"],
  "Kids / Dependents": ["Permission slip", "School email", "Sports physical", "Teacher follow-up"],
  "Home": ["Repair something broken", "Change air filter", "Charge tools", "Organize one area"],
  "Car": ["Insurance check", "Tire pressure", "Maintenance booking", "Emergency kit restock"],
  "Technology": ["Software update", "Backup important files", "Fix login issue", "Delete old files"]
};

const state = loadState() || {
  sessions: [],
  activeList: [],
  selectedPriorities: [],
  timeblocks: [],
  usedPrompts: [],
  auth: {
    userId: null,
    email: null,
    plan: "free"
  }
};

let timerId = null;
let promptId = null;
let remainingSeconds = 300;
let supabaseClient = null;

const el = {
  chips: byId("chips"),
  authStatus: byId("auth-status"),
  planStatus: byId("plan-status"),
  timer: byId("timer"),
  activePrompt: byId("active-prompt"),
  startCard: byId("start-card"),
  dumpCard: byId("dump-card"),
  reviewCard: byId("review-card"),
  repeatCard: byId("repeat-card"),
  priorityCard: byId("priority-card"),
  timeboxCard: byId("timebox-card"),
  textboxMode: byId("textbox-mode"),
  paperMode: byId("paper-mode"),
  dumpInput: byId("dump-input"),
  paperRecap: byId("paper-recap"),
  openLoopCount: byId("open-loop-count"),
  organizedList: byId("organized-list"),
  priorityList: byId("priority-list"),
  priorityCount: byId("priority-count"),
  toTimebox: byId("to-timebox"),
  timeboxForm: byId("timebox-form"),
  emailInput: byId("email-input"),
  manageBilling: byId("manage-billing")
};

renderChips();
bindEvents();
initAuth().catch((err) => {
  console.error(err);
  el.authStatus.textContent = "Auth unavailable (configure Supabase env vars).";
});

function bindEvents() {
  byId("select-all-chips").addEventListener("click", () => {
    document.querySelectorAll(".chip").forEach((chip) => chip.classList.add("active"));
  });

  byId("start-session").addEventListener("click", startSession);
  byId("end-now").addEventListener("click", endSession);
  byId("repeat-session").addEventListener("click", () => showOnly(el.repeatCard));
  byId("repeat-add").addEventListener("click", () => restartDump("append"));
  byId("repeat-new").addEventListener("click", () => restartDump("new"));
  byId("continue-priorities").addEventListener("click", renderPriorityStep);
  byId("to-timebox").addEventListener("click", renderTimeboxStep);
  byId("export-google").addEventListener("click", exportGoogle);
  byId("export-ics").addEventListener("click", exportICS);
  byId("reset-all").addEventListener("click", resetAll);
  byId("email-login").addEventListener("click", sendMagicLink);
  byId("logout").addEventListener("click", logout);
  byId("checkout-pro").addEventListener("click", startCheckout);
  byId("backup-now").addEventListener("click", backupToCloud);
  byId("restore-now").addEventListener("click", restoreFromCloud);
  byId("manage-billing").addEventListener("click", openBillingPortal);

  byId("add-lines").addEventListener("click", () => {
    el.dumpInput.value = splitTrimLines(el.dumpInput.value).join("\n");
  });
  byId("mark-important").addEventListener("click", () => {
    const lines = splitTrimLines(el.dumpInput.value);
    if (!lines.length) return;
    lines[0] = `* ${lines[0].replace(/^\*\s*/, "")}`;
    el.dumpInput.value = lines.join("\n");
  });
}

function startSession() {
  const minutes = Number(byId("session-minutes").value || 5);
  remainingSeconds = minutes * 60;
  renderTimer();

  const method = getInputMethod();
  el.textboxMode.classList.toggle("hidden", method !== "textbox");
  el.paperMode.classList.toggle("hidden", method !== "pen-paper");
  showOnly(el.dumpCard);

  el.activePrompt.textContent = pickPrompt();
  timerId = window.setInterval(() => {
    remainingSeconds -= 1;
    renderTimer();
    if (remainingSeconds <= 0) endSession();
  }, 1000);
  promptId = window.setInterval(() => {
    el.activePrompt.textContent = pickPrompt();
  }, 12000);
}

function endSession() {
  clearIntervals();
  const method = getInputMethod();
  const rawLines = method === "textbox" ? el.dumpInput.value : el.paperRecap.value;
  const parsed = splitTrimLines(rawLines).map((text) => ({ text, star: /^\*/.test(text) }));
  if (parsed.length) {
    state.activeList = mergeAndOrganize(state.activeList, parsed);
  }

  state.sessions.push({
    date: new Date().toISOString(),
    method,
    itemCount: parsed.length
  });
  saveState();
  renderReview();
}

function restartDump(mode) {
  if (mode === "new") {
    state.activeList = [];
    state.selectedPriorities = [];
    state.timeblocks = [];
  }
  el.dumpInput.value = "";
  el.paperRecap.value = "";
  saveState();
  showOnly(el.startCard);
}

function renderReview() {
  showOnly(el.reviewCard);
  el.openLoopCount.textContent = String(state.activeList.length);
  el.organizedList.innerHTML = "";
  state.activeList.forEach((item) => {
    const li = document.createElement("li");
    li.textContent = item.star ? `* ${item.text}` : item.text;
    el.organizedList.appendChild(li);
  });
}

function renderPriorityStep() {
  showOnly(el.priorityCard);
  el.priorityList.innerHTML = "";

  state.activeList.forEach((item) => {
    const li = document.createElement("li");
    li.className = "priority-item";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = state.selectedPriorities.includes(item.text);
    input.addEventListener("change", () => togglePriority(item.text, input));
    li.appendChild(input);
    li.appendChild(document.createTextNode(item.text));
    el.priorityList.appendChild(li);
  });
  refreshPriorityCount();
}

function togglePriority(text, input) {
  if (input.checked) {
    if (state.selectedPriorities.length >= 3) {
      input.checked = false;
      alert("Choose exactly 3 priorities.");
      return;
    }
    state.selectedPriorities.push(text);
  } else {
    state.selectedPriorities = state.selectedPriorities.filter((x) => x !== text);
  }
  saveState();
  refreshPriorityCount();
}

function refreshPriorityCount() {
  el.priorityCount.textContent = `Selected: ${state.selectedPriorities.length} / 3`;
  el.toTimebox.disabled = state.selectedPriorities.length !== 3;
}

function renderTimeboxStep() {
  showOnly(el.timeboxCard);
  el.timeboxForm.innerHTML = "";
  state.timeblocks = state.selectedPriorities.map((task, idx) => state.timeblocks[idx] || {
    task,
    start: "09:00",
    duration: 45,
    buffer: 10
  });
  state.timeblocks.forEach((tb, idx) => {
    const wrap = document.createElement("div");
    wrap.className = "timebox-row";
    wrap.innerHTML = `
      <strong>${tb.task}</strong>
      <label>Start time <input type="time" data-idx="${idx}" data-field="start" value="${tb.start}"></label>
      <label>Duration (minutes) <input type="number" min="15" step="5" data-idx="${idx}" data-field="duration" value="${tb.duration}"></label>
      <label>Buffer (minutes) <input type="number" min="0" step="5" data-idx="${idx}" data-field="buffer" value="${tb.buffer}"></label>
    `;
    el.timeboxForm.appendChild(wrap);
  });

  el.timeboxForm.querySelectorAll("input").forEach((input) => {
    input.addEventListener("input", onTimeboxInput);
  });
  saveState();
}

function onTimeboxInput(evt) {
  const idx = Number(evt.target.dataset.idx);
  const field = evt.target.dataset.field;
  let value = evt.target.value;
  if (field !== "start") value = Number(value);
  state.timeblocks[idx][field] = value;
  saveState();
}

function exportGoogle() {
  if (!hasPro("calendarExport")) {
    alert("Google Calendar export is a Pro feature.");
    return;
  }
  if (state.timeblocks.length !== 3) return;
  // Google supports one event prefill URL at a time, so we open 3 tabs.
  state.timeblocks.forEach((tb) => {
    const start = combineToday(tb.start);
    const end = new Date(start.getTime() + (tb.duration + tb.buffer) * 60000);
    const dates = `${fmtGoogle(start)}/${fmtGoogle(end)}`;
    const url = new URL("https://calendar.google.com/calendar/render");
    url.searchParams.set("action", "TEMPLATE");
    url.searchParams.set("text", tb.task);
    url.searchParams.set("details", "Created with Quick Exhale");
    url.searchParams.set("dates", dates);
    window.open(url.toString(), "_blank", "noopener");
  });
}

function exportICS() {
  if (!hasPro("calendarExport")) {
    alert(".ics export is a Pro feature.");
    return;
  }
  if (state.timeblocks.length !== 3) return;
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Quick Exhale//EN"
  ];
  state.timeblocks.forEach((tb) => {
    const start = combineToday(tb.start);
    const end = new Date(start.getTime() + (tb.duration + tb.buffer) * 60000);
    const uid = `${Date.now()}-${Math.random().toString(36).slice(2)}@quickexhale.com`;
    ics.push(
      "BEGIN:VEVENT",
      `UID:${uid}`,
      `DTSTAMP:${fmtICS(new Date())}`,
      `DTSTART:${fmtICS(start)}`,
      `DTEND:${fmtICS(end)}`,
      `SUMMARY:${escapeICS(tb.task)}`,
      "DESCRIPTION:Created with Quick Exhale",
      "BEGIN:VALARM",
      "TRIGGER:-PT30M",
      "ACTION:DISPLAY",
      "DESCRIPTION:30-minute reminder",
      "END:VALARM",
      "BEGIN:VALARM",
      "TRIGGER:-PT5M",
      "ACTION:DISPLAY",
      "DESCRIPTION:5-minute reminder",
      "END:VALARM",
      "END:VEVENT"
    );
  });
  ics.push("END:VCALENDAR");

  const blob = new Blob([ics.join("\r\n")], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "quick-exhale-timeblocks.ics";
  a.click();
  URL.revokeObjectURL(url);
}

function resetAll() {
  localStorage.removeItem(STORAGE_KEY);
  location.reload();
}

function hasPro(featureName) {
  return state.auth.plan === "pro" && PRO_FEATURES[featureName];
}

function mergeAndOrganize(existing, incoming) {
  const merged = [...existing];
  const seen = new Set(existing.map((x) => x.text.toLowerCase()));
  incoming.forEach((item) => {
    const cleanText = item.text.replace(/^\*\s*/, "").trim();
    if (!cleanText) return;
    const key = cleanText.toLowerCase();
    if (!seen.has(key)) {
      merged.push({ text: cleanText, star: item.star || /\b(today|urgent|asap)\b/i.test(cleanText) });
      seen.add(key);
    }
  });

  // Logic-based organization for MVP: starred first, then short actionable items.
  merged.sort((a, b) => Number(b.star) - Number(a.star) || a.text.length - b.text.length);
  return merged;
}

function pickPrompt() {
  const selected = selectedChips();
  let pool = [...PROMPTS.common];
  selected.forEach((chip) => {
    if (PROMPTS[chip]) pool = pool.concat(PROMPTS[chip]);
  });

  const unused = pool.filter((p) => !state.usedPrompts.includes(p));
  const source = unused.length ? unused : pool;
  const prompt = source[Math.floor(Math.random() * source.length)];

  state.usedPrompts.push(prompt);
  if (state.usedPrompts.length > 120) state.usedPrompts = state.usedPrompts.slice(-120);
  saveState();
  return prompt;
}

function renderChips() {
  el.chips.innerHTML = "";
  CHIPS.forEach((chip) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip";
    btn.textContent = chip;
    btn.addEventListener("click", () => btn.classList.toggle("active"));
    el.chips.appendChild(btn);
  });
}

function selectedChips() {
  return [...document.querySelectorAll(".chip.active")].map((x) => x.textContent);
}

function getInputMethod() {
  const selected = document.querySelector('input[name="input-method"]:checked');
  return selected ? selected.value : "textbox";
}

function splitTrimLines(text) {
  return (text || "")
    .split(/\r?\n/g)
    .map((x) => x.trim())
    .filter(Boolean);
}

function renderTimer() {
  const mins = Math.floor(remainingSeconds / 60).toString().padStart(2, "0");
  const secs = (remainingSeconds % 60).toString().padStart(2, "0");
  el.timer.textContent = `${mins}:${secs}`;
}

function clearIntervals() {
  if (timerId) clearInterval(timerId);
  if (promptId) clearInterval(promptId);
  timerId = null;
  promptId = null;
}

function showOnly(target) {
  [el.startCard, el.dumpCard, el.reviewCard, el.repeatCard, el.priorityCard, el.timeboxCard]
    .forEach((node) => node.classList.add("hidden"));
  target.classList.remove("hidden");
}

function byId(id) {
  return document.getElementById(id);
}

function loadState() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
  } catch {
    return null;
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

async function initAuth() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !window.supabase) {
    renderAuthStatus();
    return;
  }
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true }
  });

  const { data } = await supabaseClient.auth.getSession();
  if (data.session?.user) {
    state.auth.userId = data.session.user.id;
    state.auth.email = data.session.user.email;
    await refreshPlan();
  } else {
    state.auth.userId = null;
    state.auth.email = null;
    state.auth.plan = "free";
    saveState();
  }
  renderAuthStatus();

  const params = new URLSearchParams(location.search);
  const checkoutSession = params.get("checkout_session_id");
  if (checkoutSession && data.session?.access_token) {
    await finalizeCheckout(checkoutSession, data.session.access_token);
    await refreshPlan();
    params.delete("checkout_session_id");
    history.replaceState({}, "", `${location.pathname}?${params.toString()}`.replace(/\?$/, ""));
  }
}

async function sendMagicLink() {
  if (!supabaseClient) {
    alert("Auth is not configured yet.");
    return;
  }
  const email = el.emailInput.value.trim();
  if (!email) {
    alert("Add your email first.");
    return;
  }
  const redirectTo = `${location.origin}${location.pathname}`;
  const { error } = await supabaseClient.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo } });
  if (error) {
    alert(`Sign-in failed: ${error.message}`);
    return;
  }
  alert("Magic link sent. Open it from your email to sign in.");
}

async function logout() {
  if (!supabaseClient) return;
  await supabaseClient.auth.signOut();
  state.auth.userId = null;
  state.auth.email = null;
  state.auth.plan = "free";
  saveState();
  renderAuthStatus();
}

async function getAccessToken() {
  if (!supabaseClient) return null;
  const { data } = await supabaseClient.auth.getSession();
  return data.session?.access_token || null;
}

async function refreshPlan() {
  const token = await getAccessToken();
  if (!token) {
    state.auth.plan = "free";
    saveState();
    renderAuthStatus();
    return;
  }
  const resp = await fetch("/api/subscription-status", {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!resp.ok) {
    state.auth.plan = "free";
    saveState();
    renderAuthStatus();
    return;
  }
  const data = await resp.json();
  state.auth.plan = data.plan === "pro" ? "pro" : "free";
  saveState();
  renderAuthStatus();
}

function renderAuthStatus() {
  const isSignedIn = Boolean(state.auth.userId);
  el.authStatus.textContent = isSignedIn
    ? `Signed in as ${state.auth.email || "user"}`
    : "Not signed in";
  el.planStatus.textContent = `Plan: ${state.auth.plan === "pro" ? "Pro" : `Free (Pro is $${PRO_MONTHLY_PRICE}/mo)`}`;
  if (el.manageBilling) {
    const showPortal = isSignedIn && state.auth.plan === "pro";
    el.manageBilling.classList.toggle("hidden", !showPortal);
  }
}

async function startCheckout() {
  const token = await getAccessToken();
  if (!token) {
    alert("Please sign in first.");
    return;
  }
  const resp = await fetch("/api/create-checkout-session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      successUrl: `${location.origin}${location.pathname}?checkout_session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${location.origin}${location.pathname}`
    })
  });
  const data = await resp.json();
  if (!resp.ok || !data.url) {
    alert(data.error || "Unable to start checkout.");
    return;
  }
  location.href = data.url;
}

async function openBillingPortal() {
  const token = await getAccessToken();
  if (!token) {
    alert("Please sign in first.");
    return;
  }
  const resp = await fetch("/api/create-billing-portal-session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      returnUrl: `${window.location.origin}${window.location.pathname}`
    })
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.url) {
    alert(data.error || "Unable to open subscription management. If you never finished checkout, subscribe first.");
    return;
  }
  window.location.href = data.url;
}

async function finalizeCheckout(checkoutSessionId, accessToken) {
  const resp = await fetch("/api/finalize-checkout", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({ checkoutSessionId })
  });
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    alert(data.error || "Checkout verification failed.");
  }
}

async function backupToCloud() {
  if (!hasPro("cloudBackup")) {
    alert("Cloud backup is a Pro feature.");
    return;
  }
  const token = await getAccessToken();
  if (!token) {
    alert("Sign in first.");
    return;
  }
  const payload = {
    sessions: state.sessions,
    activeList: state.activeList,
    selectedPriorities: state.selectedPriorities,
    timeblocks: state.timeblocks,
    usedPrompts: state.usedPrompts
  };
  const resp = await fetch("/api/save-history", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ payload })
  });
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    alert(data.error || "Cloud backup failed.");
    return;
  }
  alert("Backup complete.");
}

async function restoreFromCloud() {
  const token = await getAccessToken();
  if (!token) {
    alert("Sign in first.");
    return;
  }
  const resp = await fetch("/api/get-history", {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await resp.json();
  if (!resp.ok) {
    alert(data.error || "Restore failed.");
    return;
  }
  if (!data.payload) {
    alert("No cloud history found yet.");
    return;
  }
  state.sessions = data.payload.sessions || [];
  state.activeList = data.payload.activeList || [];
  state.selectedPriorities = data.payload.selectedPriorities || [];
  state.timeblocks = data.payload.timeblocks || [];
  state.usedPrompts = data.payload.usedPrompts || [];
  saveState();
  renderReview();
  alert("Cloud restore complete.");
}

function combineToday(timeHHMM) {
  const [h, m] = timeHHMM.split(":").map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d;
}

function fmtGoogle(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function fmtICS(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function escapeICS(s) {
  return s.replace(/\\/g, "\\\\").replace(/,/g, "\\,").replace(/;/g, "\\;").replace(/\n/g, "\\n");
}
