import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { quote, QUOTE_TTL_MS } from "../src/core/money.js";
import { newReleaseSecret, recoverPreimage, MODE_QR } from "../src/core/secret.js";
import {
  createOrder,
  apply,
  receipt,
  isRefundDue,
  requiredFinalCltvBlocks,
  STATE,
  EVENT,
  EscrowError,
  DEFAULT_HOLD_MS,
  MAX_HOLD_MS,
} from "../src/core/escrow.js";

const BTC = 95_000n;
const T0 = 1_700_000_000_000;

export const orderFixture = (over = {}) => {
  const release = newReleaseSecret(MODE_QR);
  const q = quote(4_000n, BTC, T0); // $40.00
  return {
    release,
    order: createOrder({
      id: "ord_1",
      vendorId: "v_mamas_shop",
      payerId: "p_london",
      recipientLabel: "Fatima",
      q,
      release,
      now: T0,
      ...over,
    }),
  };
};

/** Drive an order to LOCKED, the state where money is actually at stake. */
export const locked = (fixture = orderFixture()) => {
  let o = apply(fixture.order, EVENT.INVOICE_CREATED, T0 + 1, { paymentRequest: "lnbcrt400..." });
  o = apply(o, EVENT.PAYMENT_LOCKED, T0 + 2, { amountSats: o.quote.sats });
  return { ...fixture, order: o };
};

test("happy path: draft, locked, released, with a verifiable receipt", () => {
  const { order, release } = orderFixture();
  assert.equal(order.state, STATE.DRAFT);

  let o = apply(order, EVENT.INVOICE_CREATED, T0 + 1, { paymentRequest: "lnbcrt400..." });
  assert.equal(o.state, STATE.AWAITING_PAYMENT);

  o = apply(o, EVENT.PAYMENT_LOCKED, T0 + 2, { amountSats: o.quote.sats });
  assert.equal(o.state, STATE.LOCKED);
  assert.equal(o.holdExpiresAt, T0 + 2 + DEFAULT_HOLD_MS);

  const preimage = recoverPreimage(release.secret, o.salt, o.paymentHash, o.secretMode);
  o = apply(o, EVENT.RELEASE, T0 + 3, { preimage });
  assert.equal(o.state, STATE.RELEASED);

  const r = receipt(o, preimage);
  assert.equal(r.usdCents, "4000");
  assert.equal(
    createHash("sha256").update(Buffer.from(r.preimage, "hex")).digest().toString("hex"),
    r.paymentHash,
  );
});

test("the payer can cancel a locked order and be refunded", () => {
  const { order } = locked();
  assert.equal(apply(order, EVENT.CANCEL, T0 + 3).state, STATE.REFUNDED);
});

test("cancelling before payment just voids the order", () => {
  const { order } = orderFixture();
  assert.equal(apply(order, EVENT.CANCEL, T0 + 1).state, STATE.VOID);
});

test("once the hold window passes the money refunds", () => {
  const { order } = locked();
  const late = order.holdExpiresAt + 1;
  assert.ok(!isRefundDue(order, order.holdExpiresAt));
  assert.ok(isRefundDue(order, late));
  assert.equal(apply(order, EVENT.HOLD_EXPIRED, late).state, STATE.REFUNDED);
});

test("the requested CLTV outlives the hold window, so channels do not force-close", () => {
  // 6h hold = 36 blocks of hold, plus safety margin
  assert.equal(requiredFinalCltvBlocks(DEFAULT_HOLD_MS), 36 + 40);
  assert.ok(requiredFinalCltvBlocks(MAX_HOLD_MS) > MAX_HOLD_MS / (10 * 60 * 1000));
  assert.throws(() => requiredFinalCltvBlocks(MAX_HOLD_MS + 1), EscrowError);
  assert.throws(() => requiredFinalCltvBlocks(0), EscrowError);
});

test("createOrder validates its inputs", () => {
  const { release } = orderFixture();
  const q = quote(4_000n, BTC, T0);
  const base = { id: "o", vendorId: "v", payerId: "p", recipientLabel: "F", q, release, now: T0 };
  assert.throws(() => createOrder({ ...base, id: "" }), EscrowError);
  assert.throws(() => createOrder({ ...base, q: null }), EscrowError);
  assert.throws(() => createOrder({ ...base, release: {} }), EscrowError);
  assert.throws(() => createOrder({ ...base, holdMs: MAX_HOLD_MS + 1 }), EscrowError);
});

test("an invoice cannot be issued against a stale quote", () => {
  const { order } = orderFixture();
  assert.throws(
    () => apply(order, EVENT.INVOICE_CREATED, T0 + QUOTE_TTL_MS, { paymentRequest: "lnbcrt..." }),
    EscrowError,
  );
});

test("history records every transition for audit", () => {
  const { order } = locked();
  assert.deepEqual(
    order.history.map((h) => h.event),
    ["CREATED", EVENT.INVOICE_CREATED, EVENT.PAYMENT_LOCKED],
  );
});

test("no recipient phone number or address is ever stored on the order", () => {
  const { order } = orderFixture();
  // Inspect the text fields only; numeric timestamps are not contact details.
  const textFields = Object.entries(order)
    .filter(([, v]) => typeof v === "string")
    .map(([k, v]) => k + "=" + v);
  assert.ok(textFields.includes("recipientLabel=Fatima")); // a first name, nothing more
  for (const field of textFields) {
    assert.doesNotMatch(field, /\+?\d{7,}/, field + " looks like a phone number");
  }
  // The secret and the preimage must never be retained anywhere on the order.
  assert.ok(!("secret" in order) && !("preimage" in order));
  const deep = JSON.stringify(order, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  assert.doesNotMatch(deep, /"(secret|preimage)"/);
});
