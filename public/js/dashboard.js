// The vendor dashboard. One fetch, rendered from real data - nothing here
// is a mock. Reads the merchant key from the URL fragment, which a browser
// never sends over the wire, and attaches it as the Authorization header on
// the one request this page ever makes.
(() => {
  "use strict";

  const keyGate = document.getElementById("keyGate");
  const keyInput = document.getElementById("keyInput");
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

        const amount = document.createElement("p");
        amount.className = "amount";
        amount.textContent = o.amount.usdFormatted;

        const sats = document.createElement("p");
        sats.className = "meta amount";
        sats.textContent = `${o.amount.sats} sats`;

        const badge = document.createElement("span");
        badge.className = `badge ${BADGE[o.state] ?? "badge-void"}`;
        const dot = document.createElement("span");
        dot.className = "dot";
        badge.append(dot, document.createTextNode(o.status));

        row.append(who, amount, sats, badge);
        return row;
      }),
    );
  }

  async function loadOrders(merchantKey) {
    const res = await fetch("/api/merchants/orders", {
      headers: { Authorization: `Bearer ${merchantKey}` },
    });
    if (!res.ok) throw new Error(`${res.status}`);
    return res.json();
  }

  async function boot(merchantKey) {
    try {
      const { vendorId, orders } = await loadOrders(merchantKey);
      keyGate.hidden = true;
      dashboardRoot.hidden = false;
      vendorFoot.hidden = false;
      vendorIdLabel.textContent = vendorId;
      vendorSub.textContent = `${orders.length} order${orders.length === 1 ? "" : "s"} total`;
      renderStats(orders);
      renderOrders(orders);
    } catch {
      keyGate.hidden = false;
      dashboardRoot.hidden = true;
      keyInput.value = "";
      keyInput.placeholder = "That key didn't work. Try again.";
      location.hash = "";
    }
  }

  const fromHash = location.hash.slice(1);
  if (fromHash) {
    boot(fromHash);
  }

  keyInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const value = keyInput.value.trim();
    if (!value) return;
    location.hash = value;
    boot(value);
  });
})();
