// Create a shop or sign back into one, then hand off to the dashboard.
// This page never shows orders itself - it only ever produces a merchant
// key and sends the browser on to /dashboard.html with it.
(() => {
  "use strict";

  const keyInput = document.getElementById("keyInput");
  const existingKeyForm = document.getElementById("existingKeyForm");
  const createShopBtn = document.getElementById("createShopBtn");
  const newKeyReveal = document.getElementById("newKeyReveal");
  const newKeyText = document.getElementById("newKeyText");
  const copyKeyBtn = document.getElementById("copyKeyBtn");
  const continueToDashboard = document.getElementById("continueToDashboard");
  const keyGateError = document.getElementById("keyGateError");

  // Same convenience as the dashboard's own copy of this: a remembered
  // key, never a cookie, never sent anywhere on its own.
  const REMEMBER_KEY = "yazo:lastMerchantKey";
  function rememberKey(key) {
    try {
      localStorage.setItem(REMEMBER_KEY, key);
    } catch {
      /* private window, blocked storage - the key still works via the URL */
    }
  }
  function recalledKey() {
    try {
      return localStorage.getItem(REMEMBER_KEY);
    } catch {
      return null;
    }
  }

  function showError(message) {
    keyGateError.textContent = message;
    keyGateError.hidden = false;
  }

  // Already signed in from a previous visit - skip straight to the
  // dashboard instead of making them look at this page again.
  if (recalledKey() && !new URLSearchParams(location.search).has("invalid")) {
    location.replace("/dashboard.html");
    return;
  }

  if (new URLSearchParams(location.search).has("invalid")) {
    showError("That key didn't work. Check it was pasted in full, or create a new shop below.");
  }

  async function verifyKey(merchantKey) {
    const res = await fetch("/api/merchants/orders", {
      headers: { Authorization: `Bearer ${merchantKey}` },
    });
    if (!res.ok) throw new Error(String(res.status));
  }

  existingKeyForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const value = keyInput.value.trim();
    if (!value) return;
    keyGateError.hidden = true;
    const submitBtn = existingKeyForm.querySelector("button[type=submit]");
    submitBtn.disabled = true;
    try {
      await verifyKey(value);
      rememberKey(value);
      location.href = `/dashboard.html#${value}`;
    } catch (err) {
      // A real 401 means the key itself is wrong. Anything else - the
      // server briefly unreachable, a network blip - is not a typo in what
      // they pasted, and telling them it is sends them hunting for a
      // mistake that was never there.
      showError(
        err.message === "401"
          ? "That key didn't work. Check it was pasted in full."
          : "Couldn't check that key just now - the server may be unreachable. Try again in a moment.",
      );
      submitBtn.disabled = false;
    }
  });

  let mintedKey = null;
  createShopBtn.addEventListener("click", async () => {
    createShopBtn.disabled = true;
    createShopBtn.textContent = "Creating...";
    keyGateError.hidden = true;
    try {
      const res = await fetch("/api/merchants", { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
      const { merchantKey } = await res.json();
      mintedKey = merchantKey;
      newKeyText.textContent = merchantKey;
      newKeyReveal.hidden = false;
      createShopBtn.hidden = true;
    } catch {
      showError("Couldn't create a shop just now - the server may be unreachable. Try again in a moment.");
      createShopBtn.disabled = false;
      createShopBtn.textContent = "Create your shop - it's free";
    }
  });

  copyKeyBtn.addEventListener("click", async () => {
    if (!mintedKey) return;
    try {
      await navigator.clipboard.writeText(mintedKey);
    } catch {
      // Clipboard API can be unavailable (insecure context, denied
      // permission) - the key is still right there in the <code> to
      // select and copy by hand, so this never blocks anyone.
      return;
    }
    copyKeyBtn.classList.add("is-copied");
    setTimeout(() => copyKeyBtn.classList.remove("is-copied"), 1500);
  });

  continueToDashboard.addEventListener("click", () => {
    if (!mintedKey) return;
    rememberKey(mintedKey);
    location.href = `/dashboard.html#${mintedKey}`;
  });
})();
