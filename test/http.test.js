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
  const service = new EscrowService({ node, store, now: () => clock.t, btcUsd: async () => BTC });
  const server = createServer({ service, now: () => clock.t });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
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

  return { node, store, clock, service, server, call, base, validOrder, close: () => server.close() };
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
    const created = await h.call("POST", "/api/orders", h.validOrder);
    assert.equal(created.status, 201);
    const { order, secret, paymentRequest } = created.json;
    assert.ok(secret && secret.length > 10);
    assert.ok(paymentRequest.startsWith("lnbcrt"));
    assert.equal(order.amount.sats, "42106");
    assert.equal(order.state, STATE.AWAITING_PAYMENT);

    // Fetching it again never reveals the secret.
    const fetched = await h.call("GET", `/api/orders/${order.id}`);
    assert.equal(fetched.status, 200);
    assert.ok(!fetched.text.includes(secret));
  } finally {
    h.close();
  }
});

test("the salt never leaves the server", async () => {
  const h = await harness();
  try {
    const created = await h.call("POST", "/api/orders", h.validOrder);
    const id = created.json.order.id;
    const fetched = await h.call("GET", `/api/orders/${id}`);
    // Salt plus payment hash would allow offline brute force of a typed code.
    assert.ok(!("salt" in fetched.json.order));
    assert.doesNotMatch(created.text, /"salt"/);
    assert.doesNotMatch(fetched.text, /"salt"/);
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

test("a wrong code is refused and the money stays held", async () => {
  const h = await harness();
  try {
    const created = await h.call("POST", "/api/orders", h.validOrder);
    const order = created.json.order;
    const full = await h.store.get(order.id);
    h.node.payInvoice(full.paymentHash, full.quote.sats);
    await h.service.syncFromNode(order.id);

    const res = await h.call("POST", `/api/orders/${order.id}/release`, { code: "NOPE" });
    assert.equal(res.status, 409);
    assert.equal((await h.store.get(order.id)).state, STATE.LOCKED);
  } finally {
    h.close();
  }
});

test("the right code releases, and the receipt verifies", async () => {
  const h = await harness();
  try {
    const created = await h.call("POST", "/api/orders", h.validOrder);
    const { order, secret } = created.json;
    const full = await h.store.get(order.id);
    h.node.payInvoice(full.paymentHash, full.quote.sats);
    await h.service.syncFromNode(order.id);

    const res = await h.call("POST", `/api/orders/${order.id}/release`, { code: secret });
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
    const created = await h.call("POST", "/api/orders", h.validOrder);
    const order = created.json.order;
    const statuses = [];
    for (let i = 0; i < 14; i += 1) {
      statuses.push((await h.call("POST", `/api/orders/${order.id}/release`, { code: `g${i}` })).status);
    }
    assert.ok(statuses.includes(429), "the limiter must kick in");
    const limited = await h.call("POST", `/api/orders/${order.id}/release`, { code: "x" });
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
    // Break the store so the handler throws something unexpected.
    h.service.store.get = async () => {
      throw new Error("ECONNREFUSED postgres://user:hunter2@10.0.0.5/yazo");
    };
    const res = await h.call("GET", "/api/orders/ord_abcdefghijklmno");
    assert.equal(res.status, 500);
    assert.equal(res.json.error, "something went wrong");
    assert.doesNotMatch(res.text, /hunter2|postgres|10\.0\.0\.5/);
  } finally {
    h.close();
  }
});
