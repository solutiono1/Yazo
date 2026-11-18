// Merchant keys: durable, vendor-scoped, read-only credentials with no
// signup, no stored table, and no password to leak.
import test from "node:test";
import assert from "node:assert/strict";

import {
  newMerchantId,
  mintMerchantKey,
  merchantIdFor,
  MerchantError,
  MERCHANT_ID,
  MERCHANT_KEY,
} from "../src/core/merchant.js";
import { EscrowService, MemoryStore } from "../src/escrow-service.js";
import { FakeLnd } from "../src/lightning/fake.js";
import { createServer } from "../src/http/server.js";

const BTC = 95_000n;
const SECRET = "a-test-secret-at-least-16-bytes-long";

test("a minted key authenticates as its own vendorId, and shapes match", () => {
  const vendorId = newMerchantId();
  assert.match(vendorId, MERCHANT_ID);
  const key = mintMerchantKey(vendorId, SECRET);
  assert.match(key, MERCHANT_KEY);
  assert.equal(merchantIdFor(key, SECRET), vendorId);
});

test("ATTACK: a key signed under a different secret authenticates as nobody", () => {
  const vendorId = newMerchantId();
  const key = mintMerchantKey(vendorId, SECRET);
  assert.equal(merchantIdFor(key, "a-completely-different-secret!!"), null);
});

test("ATTACK: editing the vendorId inside a valid key invalidates it", () => {
  const vendorId = newMerchantId();
  const key = mintMerchantKey(vendorId, SECRET);
  const forged = key.replace(vendorId, newMerchantId());
  assert.equal(merchantIdFor(forged, SECRET), null);
});

test("junk and malformed keys resolve to no vendor", () => {
  for (const bad of ["", "yzm_", "yzk_notamerchantkey", "vnd_abc.not-a-real-mac", null, undefined, 123, {}]) {
    assert.equal(merchantIdFor(bad, SECRET), null, `accepted ${String(bad)}`);
  }
});

test("minting refuses a bad vendorId or a weak secret", () => {
  assert.throws(() => mintMerchantKey("not-a-vendor-id", SECRET), MerchantError);
  assert.throws(() => mintMerchantKey(newMerchantId(), "too-short"), MerchantError);
});

// ------------------------------------------------------------- service --

async function harness() {
  const node = new FakeLnd();
  const store = new MemoryStore();
  const service = new EscrowService({ node, store, btcUsd: async () => BTC, merchantSecret: SECRET });
  return { node, store, service };
}

test("a merchant key lists only that vendor's own orders", async () => {
  const { service } = await harness();
  const mine = service.mintMerchantKey();
  const theirs = service.mintMerchantKey();

  await service.createOrder({ vendorId: mine.vendorId, payerId: "p1", recipientLabel: "A", usdCents: 1_000n });
  await service.createOrder({ vendorId: mine.vendorId, payerId: "p2", recipientLabel: "B", usdCents: 2_000n });
  await service.createOrder({ vendorId: theirs.vendorId, payerId: "p3", recipientLabel: "C", usdCents: 3_000n });

  const mineOrders = await service.ordersForVendor(service.authoriseMerchant(mine.merchantKey));
  assert.equal(mineOrders.length, 2);
  assert.ok(mineOrders.every((o) => o.vendorId === mine.vendorId));

  const theirsOrders = await service.ordersForVendor(service.authoriseMerchant(theirs.merchantKey));
  assert.equal(theirsOrders.length, 1);
});

test("without a configured secret, merchant keys are refused rather than silently open", async () => {
  const node = new FakeLnd();
  const store = new MemoryStore();
  const service = new EscrowService({ node, store, btcUsd: async () => BTC }); // no merchantSecret
  assert.throws(() => service.mintMerchantKey(), /not configured/);
  assert.equal(service.authoriseMerchant("yzm_vnd_x.y"), null);
});

// --------------------------------------------------------------- http --

async function httpHarness() {
  const node = new FakeLnd();
  const store = new MemoryStore();
  const service = new EscrowService({ node, store, btcUsd: async () => BTC, merchantSecret: SECRET });
  const server = createServer({ service });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, bearer) => {
    const headers = {};
    if (body) headers["Content-Type"] = "application/json";
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* not json */
    }
    return { status: res.status, json };
  };
  return { service, call, base, close: () => server.close() };
}

test("POST /api/merchants mints a key; GET /api/merchants/orders requires it", async () => {
  const h = await httpHarness();
  try {
    const minted = await h.call("POST", "/api/merchants");
    assert.equal(minted.status, 201);
    assert.match(minted.json.vendorId, MERCHANT_ID);
    assert.match(minted.json.merchantKey, MERCHANT_KEY);

    const noAuth = await h.call("GET", "/api/merchants/orders");
    assert.equal(noAuth.status, 401);

    const wrongKey = await h.call("GET", "/api/merchants/orders", undefined, "yzm_vnd_bogus.notreal");
    assert.equal(wrongKey.status, 401);

    const ok = await h.call("GET", "/api/merchants/orders", undefined, minted.json.merchantKey);
    assert.equal(ok.status, 200);
    assert.equal(ok.json.vendorId, minted.json.vendorId);
    assert.deepEqual(ok.json.orders, []);
  } finally {
    h.close();
  }
});

test("ATTACK: a merchant key cannot be presented as a query string", async () => {
  const h = await httpHarness();
  try {
    const minted = await h.call("POST", "/api/merchants");
    // There is deliberately no ?k= path for this route: a valid key in the
    // query string must be refused exactly like no key at all.
    const viaQuery = await fetch(`${h.base}/api/merchants/orders?k=${minted.json.merchantKey}`);
    assert.equal(viaQuery.status, 401, "a key in the query string must not work");
  } finally {
    h.close();
  }
});

test("merchant dashboard shows a vendor's orders newest first, without secrets", async () => {
  const h = await httpHarness();
  try {
    const minted = await h.call("POST", "/api/merchants");
    await h.call("POST", "/api/orders", {
      vendorId: minted.json.vendorId,
      payerId: "p1",
      recipientLabel: "Fatima",
      usdCents: "4000",
    });
    await new Promise((r) => setTimeout(r, 2));
    await h.call("POST", "/api/orders", {
      vendorId: minted.json.vendorId,
      payerId: "p2",
      recipientLabel: "Musa",
      usdCents: "9000",
    });

    const res = await h.call("GET", "/api/merchants/orders", undefined, minted.json.merchantKey);
    assert.equal(res.status, 200);
    assert.equal(res.json.orders.length, 2);
    assert.ok(res.json.orders[0].createdAt >= res.json.orders[1].createdAt, "newest first");
    const text = JSON.stringify(res.json);
    assert.doesNotMatch(text, /salt|preimage|grants/i);
  } finally {
    h.close();
  }
});
