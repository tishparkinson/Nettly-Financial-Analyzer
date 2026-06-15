const STORAGE_KEY = "nettly-v1";

export function defaultState() {
  return {
    version: 1,
    transactions: [],
    accounts: [],
    merchantMemory: {},
    categoryNeedWant: {},
    customTags: [],
    couplesMode: false,
    partners: { primary: "You", secondary: "Partner" },
    accountOwners: {},
    dashboardPersonFilter: "combined",
    safetyNet: {
      type: "partial",
      accounts: [],
      cashAmount: 0,
      totalBalance: 0
    },
    safetyNetHistory: [],
    streaks: {
      weeklyCheckIn: 0,
      safetyNetContribution: 0,
      growthStreak: 0,
      lastCheckIn: null
    },
    personalRecords: {},
    preferences: {},
    startedAt: null
  };
}

export function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    return { ...defaultState(), ...JSON.parse(raw) };
  } catch {
    return defaultState();
  }
}

export function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function clearState() {
  localStorage.removeItem(STORAGE_KEY);
}

export function buildSnapshot(state) {
  return {
    version: 1,
    exportDate: new Date().toISOString(),
    ...state
  };
}

export function importSnapshot(data) {
  const base = defaultState();
  return {
    ...base,
    ...data,
    transactions: data.transactions || [],
    merchantMemory: data.merchantMemory || {},
    safetyNetHistory: data.safetyNetHistory || [],
    customTags: data.customTags || [],
    accountOwners: data.accountOwners || {},
    partners: { ...base.partners, ...(data.partners || {}) }
  };
}

export function downloadSnapshot(state) {
  const snap = buildSnapshot(state);
  const date = new Date().toISOString().slice(0, 10);
  const blob = new Blob([JSON.stringify(snap, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `nettly-snapshot-${date}.ntly`;
  a.click();
  URL.revokeObjectURL(url);
}

export function computeSafetyNetBalance(safetyNet) {
  if (!safetyNet) return 0;
  let total = Number(safetyNet.cashAmount) || 0;
  for (const acct of safetyNet.accounts || []) {
    if (acct.type === "dedicated_savings" || acct.type === "entire_checking") {
      total += Number(acct.balance) || 0;
    } else if (acct.type === "partial") {
      total += Number(acct.protectedAmount) || 0;
    }
  }
  return total;
}
