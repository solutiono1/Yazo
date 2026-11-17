// Concurrency attacks.
//
// Every check in the escrow machine is read-then-write: load the order, decide,
// save it. That is safe only if one order is never handled by two requests at
// the same moment. These tests fire simultaneous requests at a single order and
// assert the guarantees still hold.
import test from "node:test";
import assert from "node:assert/strict";

import { EscrowService, MemoryStore } from "../src/escrow-service.js";
import { FakeLnd } from "../src/lightning/fake.js";
import { INVOICE_STATE } from "../src/lightning/client.js";
import { STATE, MAX_RELEASE_ATTEMPTS } from "../src/core/escrow.js";
import { MODE_TYPED } from "../src/core/secret.js";

const BTC = 95_000n;

async function lockedOrder({ mode } = {}) {
  const node = new FakeLnd();
  const store = new MemoryStore();
  const service = new EscrowService({ node, store, btcUsd: async () => BTC });
  const created = await service.createOrder({
    vendorId: "v_shop",
    payerId: "p_payer",
    recipientLabel: "Fatima",
    usdCents: 4_000n,
    mode,
  });
  node.payInvoice(created.order.paymentHash, created.order.quote.sats);
  await service.syncFromNode(created.order.id);
  return { node, store, service, ...created };
}

test("ATTACK: simultaneous wrong codes cannot outrun the guess cap", async () => {
  const { service, store, order } = await lockedOrder({ mode: MODE_TYPED });

  // A distributed guesser fires every attempt at once rather than in sequence,
  // so that each request reads the counter before any of them has written it.
  const attempts = 25;
  await Promise.all(
    Array.from({ length: attempts }, (_, i) => service.release(order.id, `GUESS${i}`).catch(() => {})),
  );

  const after = await store.get(order.id);
  // Either every attempt was counted, or the order stopped accepting them.
  const counted = after.failedReleaseAttempts;
  assert.ok(
    counted >= MAX_RELEASE_ATTEMPTS || after.state === STATE.REFUNDED,
    `only ${counted} of ${attempts} concurrent guesses were counted: the cap was bypassed`,
  );
});

test("ATTACK: simultaneous releases pay the vendor exactly once", async () => {
  const { node, store, service, order, secret } = await lockedOrder();

  const results = await Promise.allSettled(
    Array.from({ length: 10 }, () => service.release(order.id, secret)),
  );
  const succeeded = results.filter((r) => r.status === "fulfilled");

  assert.equal(succeeded.length, 1, "exactly one release may succeed");
  assert.equal((await store.get(order.id)).state, STATE.RELEASED);
  assert.equal((await node.lookupInvoice(order.paymentHash)).state, INVOICE_STATE.SETTLED);
  assert.equal(node.calls.filter((c) => c.method === "settleInvoice").length, 1);
});

test("ATTACK: a release racing a refund resolves one way, not both", async () => {
  const { node, store, service, order, secret } = await lockedOrder();

  const [release, refund] = await Promise.allSettled([
    service.release(order.id, secret),
    service.refund(order.id, "racing"),
  ]);

  const settled = node.calls.filter((c) => c.method === "settleInvoice").length;
  const cancelled = node.calls.filter((c) => c.method === "cancelInvoice").length;
  assert.equal(settled + cancelled, 1, "the money must move exactly once");

  const final = await store.get(order.id);
  const invoice = await node.lookupInvoice(order.paymentHash);
  // Our record and the node must agree on which way it went.
  if (invoice.state === INVOICE_STATE.SETTLED) {
    assert.equal(final.state, STATE.RELEASED);
    assert.equal(release.status, "fulfilled");
  } else {
    assert.equal(invoice.state, INVOICE_STATE.CANCELED);
    assert.equal(final.state, STATE.REFUNDED);
    assert.equal(refund.status, "fulfilled");
  }
});

test("ATTACK: simultaneous refunds cancel the invoice exactly once", async () => {
  const { node, store, service, order } = await lockedOrder();

  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () => service.refund(order.id, "double refund")),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(node.calls.filter((c) => c.method === "cancelInvoice").length, 1);
  assert.equal((await store.get(order.id)).state, STATE.REFUNDED);
});
