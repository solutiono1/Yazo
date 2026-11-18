// The vendor dashboard. One fetch, rendered from real data - nothing here
// is a mock. Reads the merchant key from the URL fragment, which a browser
// never sends over the wire, and attaches it as the Authorization header on
// the one request this page ever makes.
(() => {
  "use strict";

  // The sidebar is the only navigation on this screen, so on a phone it
  // needs a button that is always reachable, not one you have to scroll to.
  const sidebar = document.getElementById("sidebar");
  const menuToggle = document.getElementById("menuToggle");
  const backdrop = document.getElementById("sidebarBackdrop");
  const closeSidebar = () => {
    sidebar.classList.remove("is-open");
    backdrop.classList.remove("is-open");
    menuToggle.setAttribute("aria-expanded", "false");
  };
  menuToggle.addEventListener("click", () => {
    const open = sidebar.classList.toggle("is-open");
    backdrop.classList.toggle("is-open", open);
    menuToggle.setAttribute("aria-expanded", String(open));
  });
  backdrop.addEventListener("click", closeSidebar);
  sidebar.querySelectorAll("a").forEach((a) => a.addEventListener("click", closeSidebar));

  const keyGate = document.getElementById("keyGate");
  const keyInput = document.getElementById("keyInput");
  const existingKeyForm = document.getElementById("existingKeyForm");
  const createShopBtn = document.getElementById("createShopBtn");
  const newKeyReveal = document.getElementById("newKeyReveal");
  const newKeyText = document.getElementById("newKeyText");
  const continueToDashboard = document.getElementById("continueToDashboard");
  const keyGateError = document.getElementById("keyGateError");
  const dashboardRoot = document.getElementById("dashboardRoot");
  const vendorFoot = document.getElementById("vendorFoot");
  const vendorIdLabel = document.getElementById("vendorIdLabel");
  const vendorSub = document.getElementById("vendorSub");
  const statGrid = document.getElementById("statGrid");
  const orderList = document.getElementById("orderList");

  const BADGE = {
    AWAITING_PAYMENT: "badge-awaiting",
    LOCKED: "badge-locked",
    RELEASED: "badge-released",
    REFUNDED: "badge-refunded",
    DRAFT: "badge-void",
    VOID: "badge-void",
  };

  const timeAgo = (ms) => {
    const diff = Date.now() - ms;
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  };

  function renderStats(orders) {
    const locked = orders.filter((o) => o.state === "LOCKED");
    const releasedToday = orders.filter(
      (o) => o.state === "RELEASED" && o.settledAt && Date.now() - o.settledAt < 86_400_000,
    );
    const refunded = orders.filter((o) => o.state === "REFUNDED");

    const cards = [
      { label: "Orders held", value: locked.length, tone: "is-amber" },
      { label: "Released today", value: releasedToday.length, tone: "is-green" },
      { label: "Refunded", value: refunded.length, tone: "is-teal" },
      { label: "Total orders", value: orders.length, tone: "" },
    ];

    statGrid.replaceChildren(
      ...cards.map((c) => {
        const el = document.createElement("div");
        el.className = `stat-card ${c.tone}`.trim();
        const cap = document.createElement("p");
        cap.className = "cap";
        cap.textContent = c.label;
        const num = document.createElement("p");
        num.className = "num";
        num.textContent = String(c.value);
        el.append(cap, num);
        return el;
      }),
    );
  }

  function renderOrders(orders) {
    if (!orders.length) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "No orders yet. They'll show up here the moment someone pays one.";
      orderList.replaceChildren(empty);
      return;
    }

    orderList.replaceChildren(
      ...orders.map((o) => {
        const row = document.createElement("div");
        row.className = "order-row";

        const who = document.createElement("div");
        const whoName = document.createElement("p");
        whoName.className = "who";
        whoName.textContent = o.recipientLabel;
        const whoMeta = document.createElement("p");
        whoMeta.className = "meta";
        whoMeta.textContent = timeAgo(o.createdAt);
        who.append(whoName, whoMeta);

        const amounts = document.createElement("div");
        amounts.className = "order-amounts";
        const usd = document.createElement("span");
        usd.className = "amount";
        usd.textContent = o.amount.usdFormatted;
        const sats = document.createElement("span");
        sats.className = "amount meta";
        sats.textContent = `${o.amount.sats} sats`;
        amounts.append(usd, sats);

        const badge = document.createElement("span");
        badge.className = `badge ${BADGE[o.state] ?? "badge-void"}`;
        const dot = document.createElement("span");
        dot.className = "dot";
        badge.append(dot, document.createTextNode(o.status));

        row.append(who, amounts, badge);
        return row;
      }),
    );
  }

  // A convenience, not a session: this is why there is no cookie and no
  // account anywhere on this page. A cookie is sent to the server on every
  // request automatically - that is the entire mechanism that makes
  // tracking and CSRF possible. localStorage is never sent anywhere; it
  // just lets this browser remember which key to re-attach itself, the
  // same way it would remember a bookmark. Wrapped in try/catch because a
  // private window or blocked site data can make it throw, and the
  // dashboard must still work with nothing remembered at all.
  const REMEMBER_KEY = "yazo:lastMerchantKey";
  function rememberKey(key) {
    try {
      localStorage.setItem(REMEMBER_KEY, key);
    } catch {
      /* private window, blocked storage - the key still works via the URL */
    }
  }
  function forgetKey() {
    try {
      localStorage.removeItem(REMEMBER_KEY);
    } catch {
      /* nothing was remembered either way */
    }
  }
  function recalledKey() {
    try {
      return localStorage.getItem(REMEMBER_KEY);
    } catch {
      return null;
    }
  }

  async function loadOrders(merchantKey) {
    const res = await fetch("/api/merchants/orders", {
      headers: { Authorization: `Bearer ${merchantKey}` },
    });
    if (!res.ok) throw new Error(`${res.status}`);
    return res.json();
  }

  function showError(message) {
    keyGateError.textContent = message;
    keyGateError.hidden = false;
  }

  async function boot(merchantKey) {
    try {
      const { vendorId, orders } = await loadOrders(merchantKey);
      rememberKey(merchantKey);
      keyGate.hidden = true;
      dashboardRoot.hidden = false;
      vendorFoot.hidden = false;
      vendorIdLabel.textContent = vendorId;
      vendorSub.textContent = `${orders.length} order${orders.length === 1 ? "" : "s"} total`;
      renderStats(orders);
      renderOrders(orders);
    } catch {
      forgetKey();
      keyGate.hidden = false;
      dashboardRoot.hidden = true;
      newKeyReveal.hidden = true;
      location.hash = "";
      showError("That key didn't work. Check it was pasted in full, or create a new shop below.");
    }
  }

  // The URL fragment wins when present (a link someone was handed), then
  // whatever this browser remembered from last time - so following a fresh
  // link never gets silently overridden by an old remembered shop.
  const fromHash = location.hash.slice(1);
  const fromMemory = fromHash ? null : recalledKey();
  if (fromHash) {
    boot(fromHash);
  } else if (fromMemory) {
    location.hash = fromMemory;
    boot(fromMemory);
  }

  // Returning vendor: paste the key they already have.
  existingKeyForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const value = keyInput.value.trim();
    if (!value) return;
    keyGateError.hidden = true;
    location.hash = value;
    boot(value);
  });

  // New vendor: no form, no password - just mint a key. This is the entire
  // "sign-up" flow, because there is nothing else that needs collecting.
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

  continueToDashboard.addEventListener("click", () => {
    if (!mintedKey) return;
    location.hash = mintedKey;
    boot(mintedKey);
  });

  document.getElementById("switchShopBtn").addEventListener("click", () => {
    forgetKey();
    location.hash = "";
    keyGate.hidden = false;
    dashboardRoot.hidden = true;
    vendorFoot.hidden = true;
    keyInput.value = "";
  });
})();
