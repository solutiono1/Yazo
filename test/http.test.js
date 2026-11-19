// The HTTP surface, exercised as an attacker would: bad input, oversized
// bodies, path traversal, enumeration, and hammering the release endpoint.
import test from "node:test";
import assert from "node:assert/strict";

import { createServer } from "../src/http/server.js";
import { EscrowService, MemoryStore } from "../src/escrow-service.js";
import { FakeLnd } from "../src/lightning/fake.js";
import { STATE } from "../src/core/escrow.js";

const BTC = 95_000n;

async function harness() {
  const node = new FakeLnd();
  const store = new MemoryStore();
  const clock = { t: 1_700_000_000_000 };
  const service = new EscrowService({
    node,
    store,
    now: () => clock.t,
    btcUsd: async () => BTC,
    merchantSecret: "test-merchant-secret-at-least-16",
  });
  const server = createServer({ service, now: () => clock.t });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, path, body, key) => {
    const headers = {};
    if (body) headers["Content-Type"] = "application/json";
    if (key) headers.Authorization = `Bearer ${key}`;
    const res = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: res.status, json, text, headers: res.headers };
  };

  const validOrder = {
    vendorId: "v_shop",
    payerId: "p_payer",
    recipientLabel: "Fatima",
    usdCents: "4000",
  };

  /** Create an order and hand back its id, secret and the four link keys. */
  const open = async (overrides = {}) => {
    const created = await call("POST", "/api/orders", { ...validOrder, ...overrides });
    const keys = Object.fromEntries(
      Object.entries(created.json.links).map(([role, link]) => [role, link.key]),
    );
    return { created, order: created.json.order, secret: created.json.secret, keys };
  };

  /** Move an order to LOCKED, the state where money is actually at stake. */
  const pay = async (orderId) => {
    const full = await store.get(orderId);
    node.payInvoice(full.paymentHash, full.quote.sats);
    await service.syncFromNode(orderId);
    return full;
  };

  return {
    node,
    store,
    clock,
    service,
    server,
    call,
    open,
    pay,
    base,
    validOrder,
    close: () => server.close(),
  };
}

test("health responds and carries the hardening headers", async () => {
  const h = await harness();
  try {
    const res = await h.call("GET", "/api/health");
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.match(res.headers.get("content-security-policy"), /default-src 'self'/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.equal(res.headers.get("cache-control"), "no-store");
  } finally {
    h.close();
  }
});

test("creating an order returns the secret exactly once", async () => {
  const h = await harness();
  try {
    const { created, order, secret, keys } = await h.open();
    assert.equal(created.status, 201);
    assert.ok(secret && secret.length > 10);
    assert.ok(created.json.paymentRequest.startsWith("lnbcrt"));
    assert.equal(order.amount.sats, "42106");
    assert.equal(order.state, STATE.AWAITING_PAYMENT);

    // Fetching it again never reveals the secret - with any of the four links.
    for (const key of Object.values(keys)) {
      const fetched = await h.call("GET", `/api/orders/${order.id}`, undefined, key);
      assert.equal(fetched.status, 200);
      assert.ok(!fetched.text.includes(secret));
    }
  } finally {
    h.close();
  }
});

test("the salt never leaves the server", async () => {
  const h = await harness();
  try {
    const { created, order, keys } = await h.open();
    const fetched = await h.call("GET", `/api/orders/${order.id}`, undefined, keys.payer);
    // Salt plus payment hash would allow offline brute force of a typed code.
    assert.ok(!("salt" in fetched.json.order));
    assert.doesNotMatch(created.text, /"salt"/);
    assert.doesNotMatch(fetched.text, /"salt"/);
    // The stored grant digests are server-side too: a response that carried
    // them would hand an attacker the material to confirm a guessed key.
    assert.ok(!("grants" in fetched.json.order));
    assert.doesNotMatch(fetched.text, /"grants"/);
  } finally {
    h.close();
  }
});

test("malformed input is rejected rather than coerced", async () => {
  const h = await harness();
  try {
    const cases = [
      [{ ...h.validOrder, usdCents: 4000 }, "number instead of string"],
      [{ ...h.validOrder, usdCents: "40.5" }, "fractional cents"],
      [{ ...h.validOrder, usdCents: "4e3" }, "exponent"],
      [{ ...h.validOrder, usdCents: "-4000" }, "negative"],
      [{ ...h.validOrder, recipientLabel: "" }, "empty label"],
      [{ ...h.validOrder, recipientLabel: "x".repeat(200) }, "oversized label"],
      [{ ...h.validOrder, vendorId: undefined }, "missing vendor"],
      [{ ...h.validOrder, mode: "telepathy" }, "unknown mode"],
    ];
    for (const [body, why] of cases) {
      const res = await h.call("POST", "/api/orders", body);
      assert.equal(res.status, 400, `should reject: ${why}`);
    }
  } finally {
    h.close();
  }
});

test("an oversized body is refused", async () => {
  const h = await harness();
  try {
    const res = await fetch(`${h.base}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...h.validOrder, memo: "x".repeat(100_000) }),
    }).catch((e) => ({ status: 0, error: e.message }));
    assert.ok(res.status === 400 || res.status === 0, "huge body must not be accepted");
  } finally {
    h.close();
  }
});

test("order ids that are not ours are rejected without a lookup", async () => {
  const h = await harness();
  try {
    for (const bad of ["../../etc/passwd", "ord_1", "' OR 1=1--", "ord_" + "x".repeat(200)]) {
      const res = await h.call("GET", `/api/orders/${encodeURIComponent(bad)}`);
      assert.ok([400, 404].includes(res.status), `rejected ${bad}`);
    }
  } finally {
    h.close();
  }
});

test("path traversal cannot escape the public directory", async () => {
  const h = await harness();
  try {
    for (const attempt of ["/../package.json", "/../../../../etc/passwd", "/..%2fpackage.json"]) {
      const res = await fetch(h.base + attempt);
      assert.ok([403, 404].includes(res.status), `${attempt} -> ${res.status}`);
      const body = await res.text();
      assert.doesNotMatch(body, /"name": "yazo"/);
    }
  } finally {
    h.close();
  }
});

test("every static asset extension actually in use has a MIME entry", async () => {
  // nosniff means a missing entry is not cosmetic: the browser refuses to
  // render the file as its real type rather than guessing one. This check
  // walks the real public/ directory so a new file format added there
  // without updating MIME fails a test instead of failing silently in a
  // browser.
  const h = await harness();
  try {
    const { readdir } = await import("node:fs/promises");
    const { extname, join } = await import("node:path");
    const files = [];
    async function walk(dir) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else files.push(full);
      }
    }
    await walk("public");
    const seen = new Set();
    for (const file of files) {
      const ext = extname(file);
      if (!ext || seen.has(ext)) continue;
      seen.add(ext);
      const res = await fetch(`${h.base}/${file.replace(/^public[\\/]/, "").replace(/\\/g, "/")}`);
      assert.equal(res.status, 200, `${file} did not serve`);
      assert.notEqual(
        res.headers.get("content-type"),
        "application/octet-stream",
        `${ext} has no MIME entry - nosniff will block it from rendering`,
      );
    }
  } finally {
    h.close();
  }
});

test("a wrong code is refused and the money stays held", async () => {
  const h = await harness();
  try {
    const { order, keys } = await h.open();
    await h.pay(order.id);

    const res = await h.call("POST", `/api/orders/${order.id}/release`, { code: "NOPE" }, keys.vendor);
    assert.equal(res.status, 409);
    assert.equal((await h.store.get(order.id)).state, STATE.LOCKED);
  } finally {
    h.close();
  }
});

test("the right code releases, and the receipt verifies", async () => {
  const h = await harness();
  try {
    const { order, secret, keys } = await h.open();
    await h.pay(order.id);

    const res = await h.call("POST", `/api/orders/${order.id}/release`, { code: secret }, keys.vendor);
    assert.equal(res.status, 200);
    assert.equal(res.json.order.state, STATE.RELEASED);

    const { createHash } = await import("node:crypto");
    const hashed = createHash("sha256")
      .update(Buffer.from(res.json.receipt.preimage, "hex"))
      .digest("hex");
    assert.equal(hashed, res.json.receipt.paymentHash);
  } finally {
    h.close();
  }
});

test("hammering the release endpoint is rate limited", async () => {
  const h = await harness();
  try {
    const { order, keys } = await h.open();
    const statuses = [];
    for (let i = 0; i < 14; i += 1) {
      const res = await h.call("POST", `/api/orders/${order.id}/release`, { code: `g${i}` }, keys.vendor);
      statuses.push(res.status);
    }
    assert.ok(statuses.includes(429), "the limiter must kick in");
    const limited = await h.call("POST", `/api/orders/${order.id}/release`, { code: "x" }, keys.vendor);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
  } finally {
    h.close();
  }
});

test("unknown routes and wrong methods are handled cleanly", async () => {
  const h = await harness();
  try {
    assert.equal((await h.call("GET", "/api/nope")).status, 404);
    assert.equal((await h.call("DELETE", "/api/health")).status, 405);
    assert.equal((await h.call("GET", "/api/orders/ord_abcdefghijk/release")).status, 405);
  } finally {
    h.close();
  }
});

test("an internal error never leaks its details", async () => {
  const h = await harness();
  try {
    const { order, keys } = await h.open();
    // Break the store so the handler throws something unexpected.
    h.service.store.get = async () => {
      throw new Error("ECONNREFUSED postgres://user:hunter2@10.0.0.5/yazo");
    };
    const res = await h.call("GET", `/api/orders/${order.id}`, undefined, keys.payer);
    assert.equal(res.status, 500);
    assert.equal(res.json.error, "something went wrong");
    assert.doesNotMatch(res.text, /hunter2|postgres|10\.0\.0\.5/);
  } finally {
    h.close();
  }
});

/* ------------------------------------------------------------ webhooks -- */

test("a webhook endpoint cannot be set without a merchant key", async () => {
  const { call, close } = await harness();
  try {
    const res = await call("PUT", "/api/merchants/webhook", { url: "https://hooks.example.com/y" });
    assert.equal(res.status, 401);
    const get = await call("GET", "/api/merchants/webhook");
    assert.equal(get.status, 401);
    const del = await call("DELETE", "/api/merchants/webhook");
    assert.equal(del.status, 401);
  } finally {
    await close();
  }
});

test("a forged merchant key cannot set a webhook endpoint", async () => {
  const { call, close } = await harness();
  try {
    const res = await call(
      "PUT",
      "/api/merchants/webhook",
      { url: "https://hooks.example.com/y" },
      "yzm_v_shop.notarealsignature",
    );
    assert.equal(res.status, 401);
  } finally {
    await close();
  }
});

test("a real merchant key registers an endpoint and gets a secret exactly once", async () => {
  const { call, close } = await harness();
  try {
    const minted = await call("POST", "/api/merchants");
    assert.equal(minted.status, 201);
    const key = minted.json.merchantKey;

    const set = await call("PUT", "/api/merchants/webhook", { url: "https://hooks.example.com/y" }, key);
    assert.equal(set.status, 200);
    assert.match(set.json.signingSecret, /^yws_/);

    // Reading it back never repeats the secret.
    const got = await call("GET", "/api/merchants/webhook", undefined, key);
    assert.equal(got.status, 200);
    assert.equal(got.json.webhook.url, "https://hooks.example.com/y");
    assert.equal(got.json.webhook.secret, undefined);
    assert.equal(JSON.stringify(got.json).includes(set.json.signingSecret), false);

    const removed = await call("DELETE", "/api/merchants/webhook", undefined, key);
    assert.equal(removed.status, 200);
    const after = await call("GET", "/api/merchants/webhook", undefined, key);
    assert.equal(after.json.webhook, null);
  } finally {
    await close();
  }
});

test("a webhook url pointing inward is refused at registration", async () => {
  const { call, close } = await harness();
  try {
    const key = (await call("POST", "/api/merchants")).json.merchantKey;
    for (const url of [
      "http://hooks.example.com/y", // not https
      "https://127.0.0.1/y",
      "https://169.254.169.254/latest/meta-data/",
      "https://localhost/y",
      "file:///etc/passwd",
      "not-a-url",
    ]) {
      const res = await call("PUT", "/api/merchants/webhook", { url }, key);
      assert.equal(res.status, 400, `expected ${url} to be refused`);
    }
  } finally {
    await close();
  }
});

test("one vendor cannot read or clear another vendor's webhook", async () => {
  const { call, close } = await harness();
  try {
    const a = (await call("POST", "/api/merchants")).json.merchantKey;
    const b = (await call("POST", "/api/merchants")).json.merchantKey;
    await call("PUT", "/api/merchants/webhook", { url: "https://a.example.com/y" }, a);

    // B sees its own absence, not A's endpoint.
    const bSees = await call("GET", "/api/merchants/webhook", undefined, b);
    assert.equal(bSees.json.webhook, null);

    // And B deleting changes nothing for A.
    await call("DELETE", "/api/merchants/webhook", undefined, b);
    const aStill = await call("GET", "/api/merchants/webhook", undefined, a);
    assert.equal(aStill.json.webhook.url, "https://a.example.com/y");
  } finally {
    await close();
  }
});
