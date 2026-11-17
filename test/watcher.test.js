// The watcher and crash recovery: the two things that make "it refunds itself"
// true rather than aspirational.
import test from "node:test";
import assert from "node:assert/strict";

import { EscrowService, MemoryStore } from "../src/escrow-service.js";
import { Watcher } from "../src/watcher.js";
import { FakeLnd } from "../src/lightning/fake.js";
import { INVOICE_STATE } from "../src/lightning/client.js";
import { STATE, DEFAULT_HOLD_MS } from "../src/core/escrow.js";

const T0 = 1_700_000_000_000;
const BTC = 95_000n;

function harness() {
  const node = new FakeLnd();
  const store = new MemoryStore();
  const clock = { t: T0 };
  const service = new EscrowService({ node, store, now: () => clock.t, btcUsd: async () => BTC });
  const watcher = new Watcher({ service, intervalMs: 50 });
  return { node, store, clock, service, watcher };
}

const order = (service) =>
  service.createOrder({
    vendorId: "v_shop",
    payerId: "p_payer",
    recipientLabel: "Fatima",
    usdCents: 4_000n,
  });

test("the watcher notices a payment nobody was watching for", async () => {
  const { node, service, watcher, store } = harness();
  const { order: o } = await order(service);
  node.payInvoice(o.paymentHash, o.quote.sats);

  const result = await watcher.sweep();
  assert.deepEqual(result.locked, [o.id]);
  assert.equal((await store.get(o.id)).state, STATE.LOCKED);
});

test("the watcher refunds a hold whose window has passed", async () => {
  const { node, service, watcher, clock, store } = harness();
  const { order: o } = await order(service);
  node.payInvoice(o.paymentHash, o.quote.sats);
  await watcher.sweep();

  clock.t += DEFAULT_HOLD_MS + 1;
  const result = await watcher.sweep();
  assert.deepEqual(result.refunded, [o.id]);
  assert.equal((await store.get(o.id)).state, STATE.REFUNDED);
  assert.equal((await node.lookupInvoice(o.paymentHash)).state, INVOICE_STATE.CANCELED);
});

test("the watcher leaves a hold inside its window alone", async () => {
  const { node, service, watcher, clock } = harness();
  const { order: o } = await order(service);
  node.payInvoice(o.paymentHash, o.quote.sats);
  await watcher.sweep();

  clock.t += DEFAULT_HOLD_MS - 1;
  assert.deepEqual((await watcher.sweep()).refunded, []);
});

test("sweeps never overlap, so one order is never cancelled twice", async () => {
  const { node, service, watcher, clock } = harness();
  const { order: o } = await order(service);
  node.payInvoice(o.paymentHash, o.quote.sats);
  await watcher.sweep();
  clock.t += DEFAULT_HOLD_MS + 1;

  const [first, second] = await Promise.all([watcher.sweep(), watcher.sweep()]);
  const skipped = [first, second].filter((r) => r.skipped);
  const ran = [first, second].filter((r) => !r.skipped);
  assert.equal(skipped.length, 1, "the second concurrent sweep must bail out");
  assert.deepEqual(ran[0].refunded, [o.id]);
});

test("one broken order does not stop the others being refunded", async () => {
  const { node, service, watcher, clock, store } = harness();
  const a = await order(service);
  const b = await order(service);
  node.payInvoice(a.order.paymentHash, a.order.quote.sats);
  node.payInvoice(b.order.paymentHash, b.order.quote.sats);
  await watcher.sweep();

  // Cancel a's invoice behind the service's back, so refunding it will throw.
  await node.cancelInvoice(a.order.paymentHash);
  await node.settleInvoice; // no-op, keeps intent explicit
  node.invoices.get(a.order.paymentHash.toString("hex")).state = INVOICE_STATE.SETTLED;

  const errors = [];
  service.onError = (e, id) => errors.push({ id, message: e.message });
  clock.t += DEFAULT_HOLD_MS + 1;
  await watcher.sweep();

  assert.equal((await store.get(b.order.id)).state, STATE.REFUNDED, "b must still be refunded");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].id, a.order.id);
});

test("start and stop are idempotent and do not hold the process open", () => {
  const { watcher } = harness();
  assert.equal(watcher.start(), watcher);
  const timer = watcher.timer;
  watcher.start(); // second call must not replace the timer
  assert.equal(watcher.timer, timer);
  watcher.stop();
  assert.equal(watcher.timer, null);
  watcher.stop(); // safe to call twice
});

// ---------------------------------------------------- crash recovery --

test("recovery: the node settled it but we died before writing the row", async () => {
  const { node, service, store } = harness();
  const { order: o, secret } = await order(service);
  node.payInvoice(o.paymentHash, o.quote.sats);
  await service.syncFromNode(o.id);

  // Settle directly on the node, as if we crashed immediately afterwards.
  const { recoverPreimage } = await import("../src/core/secret.js");
  await node.settleInvoice(recoverPreimage(secret, o.salt, o.paymentHash, o.secretMode));

  const corrections = await service.reconcile();
  assert.deepEqual(corrections, [{ id: o.id, from: STATE.LOCKED, to: STATE.RELEASED }]);
  assert.equal((await store.get(o.id)).state, STATE.RELEASED);
});

test("recovery: the node cancelled it but we died before writing the row", async () => {
  const { node, service, store } = harness();
  const { order: o } = await order(service);
  node.payInvoice(o.paymentHash, o.quote.sats);
  await service.syncFromNode(o.id);
  await node.cancelInvoice(o.paymentHash);

  const corrections = await service.reconcile();
  assert.deepEqual(corrections, [{ id: o.id, from: STATE.LOCKED, to: STATE.REFUNDED }]);
  assert.equal((await store.get(o.id)).state, STATE.REFUNDED);
});

test("recovery: the payer paid while we were down", async () => {
  const { node, service, store } = harness();
  const { order: o } = await order(service);
  // "Down" means no live subscription, so the payment is genuinely unobserved
  // until reconcile asks the node about it.
  service.unwatchPayment(o.id);
  node.payInvoice(o.paymentHash, o.quote.sats);

  const corrections = await service.reconcile();
  assert.deepEqual(corrections, [{ id: o.id, from: STATE.AWAITING_PAYMENT, to: STATE.LOCKED }]);
  assert.equal((await store.get(o.id)).state, STATE.LOCKED);
});

test("recovery is a no-op when our record already agrees with the node", async () => {
  const { node, service } = harness();
  const { order: o } = await order(service);
  node.payInvoice(o.paymentHash, o.quote.sats);
  await service.syncFromNode(o.id);

  assert.deepEqual(await service.reconcile(), []);
  assert.deepEqual(await service.reconcile(), []);
});

test("recovery survives a node that cannot answer about one order", async () => {
  const { node, service, store } = harness();
  const a = await order(service);
  const b = await order(service);
  service.unwatchPayment(a.order.id);
  service.unwatchPayment(b.order.id);
  node.payInvoice(b.order.paymentHash, b.order.quote.sats);
  // Delete a's invoice so lookup throws for it.
  node.invoices.delete(a.order.paymentHash.toString("hex"));

  const errors = [];
  service.onError = (e, id) => errors.push(id);
  const corrections = await service.reconcile();

  assert.deepEqual(corrections, [{ id: b.order.id, from: STATE.AWAITING_PAYMENT, to: STATE.LOCKED }]);
  assert.deepEqual(errors, [a.order.id]);
  assert.equal((await store.get(b.order.id)).state, STATE.LOCKED);
});
