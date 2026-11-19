// End-to-end tests through the escrow service against a faithful lnd model.
// No network, no chain, no database - but every rule a real node enforces is
// enforced here too.
import test from "node:test";
import assert from "node:assert/strict";

import { EscrowService, MemoryStore } from "../src/escrow-service.js";
import { FakeLnd } from "../src/lightning/fake.js";
import { INVOICE_STATE } from "../src/lightning/client.js";
import { STATE, EscrowError, MAX_RELEASE_ATTEMPTS, DEFAULT_HOLD_MS } from "../src/core/escrow.js";
import { MODE_TYPED } from "../src/core/secret.js";

const T0 = 1_700_000_000_000;
const BTC = 95_000n;

function harness({ price = BTC } = {}) {
  const node = new FakeLnd();
  const store = new MemoryStore();
  const clock = { t: T0 };
  const service = new EscrowService({
    node,
    store,
    now: () => clock.t,
    btcUsd: async () => price,
  });
  return { node, store, clock, service };
}

const newOrder = (service, over = {}) =>
  service.createOrder({
    vendorId: "v_mamas_shop",
    payerId: "p_london",
    recipientLabel: "Fatima",
    usdCents: 4_000n,
    ...over,
  });

test("full journey: order, pay, show the code, vendor is paid", async () => {
  const { node, service, clock } = harness();

  const { order, paymentRequest, secret } = await newOrder(service);
  assert.equal(order.state, STATE.AWAITING_PAYMENT);
  assert.ok(paymentRequest.startsWith("lnbcrt"));
  assert.equal(order.quote.sats, 42_106n); // $40 at $95k

  // The payer pays. The node holds the HTLC; nobody has the money yet.
  node.payInvoice(order.paymentHash, order.quote.sats);
  const locked = await service.syncFromNode(order.id);
  assert.equal(locked.state, STATE.LOCKED);
  assert.equal((await node.lookupInvoice(order.paymentHash)).state, INVOICE_STATE.ACCEPTED);

  // The rice arrives. Fatima shows her code.
  clock.t += 60_000;
  const { order: released, receipt } = await service.release(order.id, secret);
  assert.equal(released.state, STATE.RELEASED);
  assert.equal((await node.lookupInvoice(order.paymentHash)).state, INVOICE_STATE.SETTLED);
  assert.equal(receipt.usdCents, "4000");
});

test("the hold invoice is created with a CLTV that outlives the hold window", async () => {
  const { node, service } = harness();
  await newOrder(service);
  const call = node.calls.find((c) => c.method === "addHoldInvoice");
  // 6h hold = 36 blocks, plus 40 blocks of safety margin
  assert.equal(call.cltvExpiry, 76);
  assert.ok(call.cltvExpiry * 10 * 60 * 1000 > DEFAULT_HOLD_MS);
});

test("the release secret is returned once and never stored", async () => {
  const { store, service } = harness();
  const { order, secret } = await newOrder(service);
  const saved = await store.get(order.id);
  const serialised = JSON.stringify(saved, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  assert.ok(!serialised.includes(secret));
  assert.doesNotMatch(serialised, /"(secret|preimage)"/);
});

test("nobody is paid until the code is shown", async () => {
  const { node, service } = harness();
  const { order } = await newOrder(service);
  node.payInvoice(order.paymentHash, order.quote.sats);
  await service.syncFromNode(order.id);

  // Money is in the network, held. Not with the vendor, not with us.
  const invoice = await node.lookupInvoice(order.paymentHash);
  assert.equal(invoice.state, INVOICE_STATE.ACCEPTED);
  assert.equal(invoice.settled, false);
});

test("a wrong code never settles the invoice", async () => {
  const { node, service } = harness();
  const { order } = await newOrder(service);
  node.payInvoice(order.paymentHash, order.quote.sats);
  await service.syncFromNode(order.id);

  await assert.rejects(() => service.release(order.id, "WRONG-CODE"), EscrowError);
  assert.equal((await node.lookupInvoice(order.paymentHash)).state, INVOICE_STATE.ACCEPTED);
});

test("guessing is capped, and the cap refunds the payer automatically", async () => {
  const { node, store, service } = harness();
  const { order } = await newOrder(service, { mode: MODE_TYPED });
  node.payInvoice(order.paymentHash, order.quote.sats);
  await service.syncFromNode(order.id);

  for (let i = 0; i < MAX_RELEASE_ATTEMPTS; i += 1) {
    await assert.rejects(() => service.release(order.id, "BADCODE" + i), EscrowError);
  }
  // The allowance is spent, so the money went back to the payer by itself.
  const after = await store.get(order.id);
  assert.equal(after.state, STATE.REFUNDED);
  assert.equal((await node.lookupInvoice(order.paymentHash)).state, INVOICE_STATE.CANCELED);
  // A refund for burning the guess allowance must stay distinguishable from
  // one caused by the hold simply expiring, or a vendor/payer checking why
  // their money came back has no way to tell "they kept guessing wrong" from
  // "the clock ran out" - both previously surfaced only as bare "REFUNDED".
  assert.match(after.refundReason, /too many failed release attempts/);

  // apply() always hands back a frozen order; a refund must stay one too, or
  // this is the one order in the system where a later `order.state = X`
  // would silently succeed instead of throwing.
  assert.throws(() => {
    after.state = "TAMPERED";
  }, TypeError);
});

test("an undelivered order refunds when its window passes", async () => {
  const { node, service, clock } = harness();
  const { order } = await newOrder(service);
  node.payInvoice(order.paymentHash, order.quote.sats);
  await service.syncFromNode(order.id);

  clock.t += DEFAULT_HOLD_MS + 1;
  const refunded = await service.expireDueHolds();
  assert.equal(refunded.length, 1);
  assert.equal(refunded[0].state, STATE.REFUNDED);
  assert.equal((await node.lookupInvoice(order.paymentHash)).state, INVOICE_STATE.CANCELED);
});

test("the watcher leaves orders inside their window alone", async () => {
  const { node, service, clock } = harness();
  const { order } = await newOrder(service);
  node.payInvoice(order.paymentHash, order.quote.sats);
  await service.syncFromNode(order.id);

  clock.t += DEFAULT_HOLD_MS - 1000;
  assert.equal((await service.expireDueHolds()).length, 0);
});

test("a correct code presented after the window still cannot take the money", async () => {
  const { node, service, clock } = harness();
  const { order, secret } = await newOrder(service);
  node.payInvoice(order.paymentHash, order.quote.sats);
  await service.syncFromNode(order.id);

  clock.t += DEFAULT_HOLD_MS + 1;
  await assert.rejects(() => service.release(order.id, secret), EscrowError);
  assert.equal((await node.lookupInvoice(order.paymentHash)).state, INVOICE_STATE.ACCEPTED);
});

test("an underpaid hold is not accepted as payment", async () => {
  const { node, service } = harness();
  const { order } = await newOrder(service);
  node.payInvoice(order.paymentHash, order.quote.sats - 1n);
  await assert.rejects(() => service.syncFromNode(order.id), EscrowError);
});

test("the node refuses to settle twice", async () => {
  const { node, service } = harness();
  const { order, secret } = await newOrder(service);
  node.payInvoice(order.paymentHash, order.quote.sats);
  await service.syncFromNode(order.id);
  await service.release(order.id, secret);

  // Our machine refuses, and so would the node underneath it.
  await assert.rejects(() => service.release(order.id, secret), EscrowError);
});

test("a cancelled order cannot later be released", async () => {
  const { node, service } = harness();
  const { order, secret } = await newOrder(service);
  node.payInvoice(order.paymentHash, order.quote.sats);
  await service.syncFromNode(order.id);
  await service.refund(order.id);

  await assert.rejects(() => service.release(order.id, secret), EscrowError);
  assert.equal((await node.lookupInvoice(order.paymentHash)).state, INVOICE_STATE.CANCELED);
});

test("two orders never share a payment hash", async () => {
  const { service } = harness();
  const a = await newOrder(service);
  const b = await newOrder(service);
  assert.notEqual(a.order.paymentHash.toString("hex"), b.order.paymentHash.toString("hex"));
  assert.notEqual(a.secret, b.secret);
});

test("a stale price cannot be used: each order quotes fresh", async () => {
  const { service, clock } = harness();
  const a = await newOrder(service);
  clock.t += 120_000; // longer than the quote TTL
  const b = await newOrder(service);
  assert.ok(b.order.quote.createdAt > a.order.quote.createdAt);
  assert.equal(b.order.state, STATE.AWAITING_PAYMENT);
});

test("an unknown order id is rejected rather than silently ignored", async () => {
  const { service } = harness();
  await assert.rejects(() => service.release("ord_nope", "x"), EscrowError);
  await assert.rejects(() => service.refund("ord_nope"), EscrowError);
});
