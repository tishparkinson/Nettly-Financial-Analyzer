import { startFindKey, completeFindKey, setStoredAccessKey, copyText } from "./access.js";

const params = new URLSearchParams(window.location.search);
const verifiedToken = params.get("verified");

const formState = document.getElementById("state-form");
const loadingState = document.getElementById("state-loading");
const keyState = document.getElementById("state-key");
const errorState = document.getElementById("state-error");
const findKeyError = document.getElementById("find-key-error");
const errorMessage = document.getElementById("error-message");
const keyDisplay = document.getElementById("access-key-display");

document.getElementById("btn-find-key").addEventListener("click", async () => {
  findKeyError.classList.add("hidden");
  const email = document.getElementById("find-key-email").value.trim();
  if (!email) {
    findKeyError.textContent = "Enter the email you used at checkout.";
    findKeyError.classList.remove("hidden");
    return;
  }

  const btn = document.getElementById("btn-find-key");
  btn.disabled = true;
  btn.textContent = "Redirecting…";

  const { ok, data } = await startFindKey(email);
  if (!ok) {
    findKeyError.textContent = data.error || "Could not start recovery.";
    findKeyError.classList.remove("hidden");
    btn.disabled = false;
    btn.textContent = "Continue with Stripe";
    return;
  }

  window.location.href = data.url;
});

document.getElementById("btn-copy-key").addEventListener("click", async () => {
  const key = keyDisplay.textContent;
  if (!key) return;
  await copyText(key);
});

async function completeRecovery() {
  formState.classList.add("hidden");
  loadingState.classList.remove("hidden");

  const { ok, data } = await completeFindKey(verifiedToken);
  loadingState.classList.add("hidden");

  if (!ok) {
    errorState.classList.remove("hidden");
    errorMessage.textContent = data.error || "Could not retrieve your access key.";
    return;
  }

  setStoredAccessKey(data.accessKey);
  keyDisplay.textContent = data.accessKey;
  keyState.classList.remove("hidden");
  history.replaceState({}, "", "/find-key.html");
}

if (verifiedToken) {
  completeRecovery();
}
