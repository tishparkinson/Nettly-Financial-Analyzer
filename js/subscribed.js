import { verifyCheckoutSession, setStoredAccessKey, copyText } from "./access.js";

const params = new URLSearchParams(window.location.search);
const sessionId = params.get("session_id");

const loading = document.getElementById("state-loading");
const errorState = document.getElementById("state-error");
const successState = document.getElementById("state-success");
const errorMessage = document.getElementById("error-message");
const keyDisplay = document.getElementById("access-key-display");

async function init() {
  if (!sessionId) {
    showError("Missing checkout session. Start from the Nettly homepage.");
    return;
  }

  const { ok, data } = await verifyCheckoutSession(sessionId);
  if (!ok) {
    showError(data.error || "We could not confirm your trial. Try again in a moment.");
    return;
  }

  setStoredAccessKey(data.accessKey);
  loading.classList.add("hidden");
  successState.classList.remove("hidden");
  keyDisplay.textContent = data.accessKey;
}

function showError(msg) {
  loading.classList.add("hidden");
  errorState.classList.remove("hidden");
  errorMessage.textContent = msg;
}

document.getElementById("btn-copy-key").addEventListener("click", async () => {
  const key = keyDisplay.textContent;
  if (!key) return;
  await copyText(key);
  document.getElementById("copy-feedback").textContent = "Copied.";
});

init();
