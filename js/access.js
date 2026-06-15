const STORAGE_KEY = "nettly-access-key";
const CHECKED_AT = "nettly-access-checked-at";
const VALID_FLAG = "nettly-access-valid";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const STRIPE_CHECKOUT_URL = "https://buy.stripe.com/14A14o7MqedrfhLabc1RC06";
export const STRIPE_PORTAL_URL = "https://billing.stripe.com/p/login/8x25kE7Mq8T7edH8341RC00";

export function getStoredAccessKey() {
  return localStorage.getItem(STORAGE_KEY);
}

export function setStoredAccessKey(key) {
  localStorage.setItem(STORAGE_KEY, key);
  localStorage.setItem(VALID_FLAG, "1");
  localStorage.setItem(CHECKED_AT, String(Date.now()));
}

export function clearAccess() {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(CHECKED_AT);
  localStorage.removeItem(VALID_FLAG);
}

export async function checkAccessWithServer(accessKey) {
  const res = await fetch("/.netlify/functions/check-access", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accessKey })
  });
  const data = await res.json();
  return { ok: res.ok && data.ok, data };
}

export async function ensureAccess() {
  const key = getStoredAccessKey();
  if (!key) return false;

  const lastCheck = Number(localStorage.getItem(CHECKED_AT) || 0);
  if (Date.now() - lastCheck < CHECK_INTERVAL_MS && localStorage.getItem(VALID_FLAG) === "1") {
    return true;
  }

  try {
    const { ok } = await checkAccessWithServer(key);
    if (ok) {
      localStorage.setItem(CHECKED_AT, String(Date.now()));
      localStorage.setItem(VALID_FLAG, "1");
      return true;
    }
    clearAccess();
    return false;
  } catch {
    return localStorage.getItem(VALID_FLAG) === "1";
  }
}

export async function unlockWithKey(accessKey) {
  const trimmed = String(accessKey || "").trim();
  if (!trimmed) {
    return { ok: false, error: "Enter your access key." };
  }

  const { ok, data } = await checkAccessWithServer(trimmed);
  if (!ok) {
    return { ok: false, error: data.error || "That access key is not valid." };
  }

  setStoredAccessKey(trimmed);
  return { ok: true };
}

export async function verifyCheckoutSession(sessionId) {
  const res = await fetch("/.netlify/functions/verify-checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId })
  });
  const data = await res.json();
  return { ok: res.ok && data.ok, data };
}

export async function startFindKey(email) {
  const res = await fetch("/.netlify/functions/find-key-start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email })
  });
  const data = await res.json();
  return { ok: res.ok && data.ok, data };
}

export async function completeFindKey(token) {
  const res = await fetch("/.netlify/functions/find-key-complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token })
  });
  const data = await res.json();
  return { ok: res.ok && data.ok, data };
}

export function copyText(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  document.body.removeChild(ta);
  return Promise.resolve();
}
