// Controls added as a result of the self-audit. Each one exists because a
// specific attack worked, or would have.
import test from "node:test";
import assert from "node:assert/strict";

import { KeyedMutex } from "../src/keyed-mutex.js";
import { EscrowService, MemoryStore } from "../src/escrow-service.js";
import { FakeLnd } from "../src/lightning/fake.js";
import { createServer } from "../src/http/server.js";
import { STATE } from "../src/core/escrow.js";

const BTC = 95_000n;

// ------------------------------------------------------------ mutex --

test("the mutex serialises one key and leaves other keys free", async () => {
  const mutex = new KeyedMutex();
  const order = [];
  const slow = (key, label, ms) =>
    mutex.run(key, async () => {
      order.push(`${label}:start`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${label}:end`);
    });

  await Promise.all([slow("a", "a1", 30), slow("a", "a2", 1), slow("b", "b1", 1)]);

  // a1 must fully finish before a2 begins.
  assert.ok(order.indexOf("a1:end") < order.indexOf("a2:start"), order.join(" "));
  // b was never blocked behind a.
  assert.ok(order.indexOf("b1:end") < order.indexOf("a1:end"), order.join(" "));
});

test("a thrown task does not wedge the queue behind it", async () => {
  const mutex = new KeyedMutex();
  await assert.rejects(() => mutex.run("k", async () => { throw new Error("boom"); }));
  assert.equal(await mutex.run("k", async () => "still works"), "still works");
});

test("the mutex does not grow without bound", async () => {
  const mutex = new KeyedMutex();
  for (let i = 0; i < 500; i += 1) await mutex.run(`key-${i}`, async () => i);
  assert.equal(mutex.size, 0, "finished keys must be forgotten");
});

// ------------------------------------------------- audit trail --

test("a reconciliation is written into the audit trail, not applied silently", async () => {
  const node = new FakeLnd();
  const store = new MemoryStore();
  const service = new EscrowService({ node, store, btcUsd: async () => BTC });
  const { order, secret } = await service.createOrder({
    vendorId: "v",
    payerId: "p",
    recipientLabel: "Fatima",
    usdCents: 4_000n,
  });
  node.payInvoice(order.paymentHash, order.quote.sats);
  await service.syncFromNode(order.id);

  const { recoverPreimage } = await import("../src/core/secret.js");
  const full = await store.get(order.id);
  await node.settleInvoice(recoverPreimage(secret, full.salt, full.paymentHash, full.secretMode));
  await service.reconcile();

  const after = await store.get(order.id);
  assert.equal(after.state, STATE.RELEASED);
  assert.equal(after.history.at(-1).event, "RECONCILED");
  // A state that changed with no history entry is indistinguishable from
  // tampering, which is the whole reason this is asserted.
  assert.equal(after.history.at(-1).state, STATE.RELEASED);
});

// ------------------------------------------------- stream limit --

test("open event streams are capped so they cannot exhaust the server", async () => {
  process.env.YAZO_MAX_STREAMS = "2";
  const node = new FakeLnd();
  const store = new MemoryStore();
  const service = new EscrowService({ node, store, btcUsd: async () => BTC });
  const server = createServer({ service });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const { order, links } = await service.createOrder({
      vendorId: "v",
      payerId: "p",
      recipientLabel: "Fatima",
      usdCents: 4_000n,
    });
    // EventSource cannot set headers, so streams are reached with ?k=.
    const url = `${base}/api/orders/${order.id}/stream?k=${links.proof.key}`;

    const controllers = [];
    const open = async () => {
      const controller = new AbortController();
      controllers.push(controller);
      const res = await fetch(url, { signal: controller.signal });
      return res.status;
    };

    assert.equal(await open(), 200);
    assert.equal(await open(), 200);
    const third = await fetch(url);
    assert.equal(third.status, 503, "the third stream must be refused");
    assert.ok(Number(third.headers.get("retry-after")) > 0);
    await third.body?.cancel();

    for (const c of controllers) c.abort();
  } finally {
    delete process.env.YAZO_MAX_STREAMS;
    server.close();
  }
});

// ------------------------------------------- live payment detection --

test("a payment is seen the moment it lands, with no sweep and no polling", async () => {
  const node = new FakeLnd();
  const store = new MemoryStore();
  const service = new EscrowService({ node, store, btcUsd: async () => BTC });
  const { order } = await service.createOrder({
    vendorId: "v",
    payerId: "p",
    recipientLabel: "Fatima",
    usdCents: 4_000n,
  });

  // Nobody calls syncFromNode and no watcher is running.
  node.payInvoice(order.paymentHash, order.quote.sats);
  await new Promise((r) => setImmediate(r));

  assert.equal((await store.get(order.id)).state, STATE.LOCKED);
});

test("a subscription is dropped once the order reaches a terminal state", async () => {
  const node = new FakeLnd();
  const store = new MemoryStore();
  const service = new EscrowService({ node, store, btcUsd: async () => BTC });
  const { order, secret } = await service.createOrder({
    vendorId: "v",
    payerId: "p",
    recipientLabel: "Fatima",
    usdCents: 4_000n,
  });
  assert.equal(service.subscriptions.size, 1);

  node.payInvoice(order.paymentHash, order.quote.sats);
  await new Promise((r) => setImmediate(r));
  await service.release(order.id, secret);
  await new Promise((r) => setImmediate(r));

  assert.equal(service.subscriptions.size, 0, "a settled order must not stay subscribed");
});

test("the service works against a node with no subscription support", async () => {
  const node = new FakeLnd();
  delete node.subscribeInvoice; // an older node, or a different implementation
  const store = new MemoryStore();
  const service = new EscrowService({ node, store, btcUsd: async () => BTC });

  const { order } = await service.createOrder({
    vendorId: "v",
    payerId: "p",
    recipientLabel: "Fatima",
    usdCents: 4_000n,
  });
  // No subscription, so the sweep is what finds it - which is the point of
  // keeping the sweep rather than relying on the stream.
  node.payInvoice(order.paymentHash, order.quote.sats);
  assert.equal((await store.get(order.id)).state, STATE.AWAITING_PAYMENT);
  await service.syncFromNode(order.id);
  assert.equal((await store.get(order.id)).state, STATE.LOCKED);
});
