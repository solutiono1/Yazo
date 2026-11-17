import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteStore } from "../src/store/sqlite.js";
import { encodeOrder, decodeOrder, assertNoSecrets, CodecError } from "../src/store/codec.js";
import { quote } from "../src/core/money.js";
import { newReleaseSecret, MODE_QR } from "../src/core/secret.js";
import { createOrder, apply, STATE, EVENT } from "../src/core/escrow.js";

const T0 = 1_700_000_000_000;
const BTC = 95_000n;

const makeOrder = (id = "ord_1") =>
  createOrder({
    id,
    vendorId: "v_shop",
    payerId: "p_payer",
    recipientLabel: "Fatima",
    q: quote(4_000n, BTC, T0),
    release: newReleaseSecret(MODE_QR),
    now: T0,
  });

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "yazo-test-"));
  const store = new SqliteStore(join(dir, "test.db"));
  return { store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

// ---------------------------------------------------------------- codec --

test("an order survives a round trip with its Buffers and bigints intact", () => {
  const order = makeOrder();
  const back = decodeOrder(encodeOrder(order));
  assert.ok(Buffer.isBuffer(back.paymentHash));
  assert.deepEqual(back.paymentHash, order.paymentHash);
  assert.ok(Buffer.isBuffer(back.salt));
  assert.equal(typeof back.quote.sats, "bigint");
  assert.equal(back.quote.sats, order.quote.sats);
  assert.equal(back.quote.usdCents, 4_000n);
  assert.equal(back.state, STATE.DRAFT);
});

test("a decoded order comes back frozen, not mutable", () => {
  const back = decodeOrder(encodeOrder(makeOrder()));
  assert.throws(() => {
    "use strict";
    back.state = STATE.RELEASED;
  }, TypeError);
  assert.throws(() => {
    "use strict";
    back.quote.sats = 1n;
  }, TypeError);
});

test("the codec refuses to persist a secret or preimage", () => {
  const order = makeOrder();
  assert.throws(() => assertNoSecrets({ ...order, secret: "leaked" }), CodecError);
  assert.throws(() => assertNoSecrets({ ...order, preimage: Buffer.alloc(32) }), CodecError);
  assert.throws(() => assertNoSecrets({ ...order, nested: { deep: { macaroon: "x" } } }), CodecError);
  assert.doesNotThrow(() => assertNoSecrets(order));
});

// ---------------------------------------------------------------- store --

test("orders survive a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yazo-test-"));
  const path = join(dir, "restart.db");
  try {
    const first = new SqliteStore(path);
    const order = makeOrder();
    await first.put(order);
    first.close(); // the process dies here

    const second = new SqliteStore(path);
    const recovered = await second.get(order.id);
    assert.equal(recovered.id, order.id);
    assert.equal(recovered.quote.sats, order.quote.sats);
    assert.deepEqual(recovered.paymentHash, order.paymentHash);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an order is updated in place, not duplicated", async () => {
  const { store, cleanup } = tempStore();
  try {
    const order = makeOrder();
    await store.put(order);
    const awaiting = apply(order, EVENT.INVOICE_CREATED, T0 + 1, { paymentRequest: "lnbcrt1..." });
    await store.put(awaiting);

    assert.equal((await store.all()).length, 1);
    assert.equal((await store.get(order.id)).state, STATE.AWAITING_PAYMENT);
  } finally {
    cleanup();
  }
});

test("two orders can never share a payment hash", async () => {
  const { store, cleanup } = tempStore();
  try {
    const a = makeOrder("ord_a");
    await store.put(a);
    // Same hash, different id: the database itself refuses.
    const clash = Object.freeze({ ...makeOrder("ord_b"), paymentHash: a.paymentHash });
    await assert.rejects(() => store.put(clash));
  } finally {
    cleanup();
  }
});

test("the event journal is append-only and records every transition", async () => {
  const { store, cleanup } = tempStore();
  try {
    let order = makeOrder();
    await store.put(order);
    order = apply(order, EVENT.INVOICE_CREATED, T0 + 1, { paymentRequest: "lnbcrt1..." });
    await store.put(order);
    order = apply(order, EVENT.PAYMENT_LOCKED, T0 + 2, { amountSats: order.quote.sats });
    await store.put(order);

    const events = await store.events(order.id);
    assert.deepEqual(
      events.map((e) => e.event),
      ["CREATED", EVENT.INVOICE_CREATED, EVENT.PAYMENT_LOCKED],
    );
    // Re-saving the same order must not duplicate history.
    await store.put(order);
    assert.equal((await store.events(order.id)).length, 3);
  } finally {
    cleanup();
  }
});

test("live() returns only orders where money is still at stake", async () => {
  const { store, cleanup } = tempStore();
  try {
    let open = makeOrder("ord_open");
    open = apply(open, EVENT.INVOICE_CREATED, T0 + 1, { paymentRequest: "lnbcrt1..." });
    await store.put(open);

    let done = makeOrder("ord_done");
    done = apply(done, EVENT.CANCEL, T0 + 1);
    await store.put(done);

    const live = await store.live();
    assert.deepEqual(live.map((o) => o.id), ["ord_open"]);
    assert.equal((await store.all()).length, 2);
  } finally {
    cleanup();
  }
});
