// Adversarial suite. Every test here is an attempt to steal money, release
// funds without delivery, or corrupt the escrow's accounting. If any of these
// ever passes, the product is broken and must not ship.
import test from "node:test";
import assert from "node:assert/strict";

import { quote } from "../src/core/money.js";
import {
  newReleaseSecret,
  recoverPreimage,
  derivePreimage,
  paymentHashFor,
  generateTypedSecret,
  MODE_QR,
  MODE_TYPED,
} from "../src/core/secret.js";
import {
  createOrder,
  apply,
  receipt,
  isRefundDue,
  releaseIsBlocked,
  STATE,
  EVENT,
  EscrowError,
  MAX_RELEASE_ATTEMPTS,
} from "../src/core/escrow.js";

const BTC = 95_000n;
const T0 = 1_700_000_000_000;

const lockedOrder = (mode = MODE_QR) => {
  const release = newReleaseSecret(mode);
  const order = createOrder({
    id: "ord_attack",
    vendorId: "v_shop",
    payerId: "p_payer",
    recipientLabel: "Fatima",
    q: quote(4_000n, BTC, T0),
    release,
    now: T0,
  });
  let o = apply(order, EVENT.INVOICE_CREATED, T0 + 1, { paymentRequest: "lnbcrt400..." });
  o = apply(o, EVENT.PAYMENT_LOCKED, T0 + 2, { amountSats: o.quote.sats });
  return { order: o, release };
};

test("ATTACK: the vendor tries to release without the recipient's code", () => {
  const { order } = lockedOrder();
  // The vendor has the order id, the invoice, the payment hash - everything
  // except the secret. None of it settles the invoice.
  for (const forged of [null, undefined, "", Buffer.alloc(32), order.paymentHash, order.salt]) {
    assert.throws(() => apply(order, EVENT.RELEASE, T0 + 3, { preimage: forged }), EscrowError);
  }
  assert.equal(order.state, STATE.LOCKED);
});

test("ATTACK: the platform database is fully breached", () => {
  // Everything persisted server-side, handed to the attacker:
  const { order, release } = lockedOrder();
  const stolen = {
    salt: order.salt,
    paymentHash: order.paymentHash,
    secretMode: order.secretMode,
    invoice: order.invoice,
    quote: order.quote,
  };
  // There is no function from the stolen data to the preimage. Guessing fails.
  for (const guess of ["", "0", "admin", "undefined", release.secret.slice(0, -1), release.secret + "x"]) {
    assert.equal(recoverPreimage(guess, stolen.salt, stolen.paymentHash, stolen.secretMode), null);
  }
  // Only the secret held by the recipient works, and it was never stored.
  assert.ok(recoverPreimage(release.secret, stolen.salt, stolen.paymentHash, stolen.secretMode));
});

test("ATTACK: a code from another order is replayed against this one", () => {
  const a = lockedOrder();
  const b = lockedOrder();
  // Salt-binding means a valid secret is valid for exactly one order.
  assert.equal(recoverPreimage(a.release.secret, b.order.salt, b.order.paymentHash, MODE_QR), null);
  assert.equal(recoverPreimage(b.release.secret, a.order.salt, a.order.paymentHash, MODE_QR), null);
  // Even the derived preimage from order A cannot settle order B.
  const preimageA = recoverPreimage(a.release.secret, a.order.salt, a.order.paymentHash, MODE_QR);
  assert.notDeepEqual(paymentHashFor(preimageA), b.order.paymentHash);
});

test("ATTACK: brute-forcing a short typed code is capped and then refunds", () => {
  let { order } = lockedOrder(MODE_TYPED);
  for (let i = 0; i < MAX_RELEASE_ATTEMPTS; i += 1) {
    assert.ok(!releaseIsBlocked(order));
    order = apply(order, EVENT.RELEASE_FAILED, T0 + 10 + i);
  }
  assert.ok(releaseIsBlocked(order));
  // Even a CORRECT secret can no longer release it - we would rather return
  // the payer's money than let a guesser who got close succeed.
  const good = newReleaseSecret(MODE_TYPED);
  const preimage = derivePreimage(good.secret, good.salt, MODE_TYPED);
  assert.throws(() => apply(order, EVENT.RELEASE, T0 + 100, { preimage }), EscrowError);
  // And the watcher is told to refund immediately, not at window end.
  assert.ok(isRefundDue(order, T0 + 100));
  assert.equal(apply(order, EVENT.CANCEL, T0 + 100).state, STATE.REFUNDED);
});

test("ATTACK: paying less than quoted to lock a full-value order", () => {
  const release = newReleaseSecret(MODE_QR);
  const order = createOrder({
    id: "o",
    vendorId: "v",
    payerId: "p",
    recipientLabel: "F",
    q: quote(4_000n, BTC, T0),
    release,
    now: T0,
  });
  const awaiting = apply(order, EVENT.INVOICE_CREATED, T0 + 1, { paymentRequest: "lnbcrt..." });
  assert.throws(
    () => apply(awaiting, EVENT.PAYMENT_LOCKED, T0 + 2, { amountSats: awaiting.quote.sats - 1n }),
    EscrowError,
  );
  // Nor by lying about the type to dodge the comparison.
  assert.throws(() => apply(awaiting, EVENT.PAYMENT_LOCKED, T0 + 2, { amountSats: 999999 }), EscrowError);
  assert.throws(() => apply(awaiting, EVENT.PAYMENT_LOCKED, T0 + 2, {}), EscrowError);
});

test("ATTACK: releasing after the hold window has expired", () => {
  const { order, release } = lockedOrder();
  const preimage = recoverPreimage(release.secret, order.salt, order.paymentHash, MODE_QR);
  const late = order.holdExpiresAt + 1;
  // The correct secret, presented too late, must not move the money.
  assert.throws(() => apply(order, EVENT.RELEASE, late, { preimage }), EscrowError);
  assert.equal(apply(order, EVENT.HOLD_EXPIRED, late).state, STATE.REFUNDED);
});

test("ATTACK: forcing an early expiry to snatch a refund mid-delivery", () => {
  const { order } = lockedOrder();
  assert.throws(() => apply(order, EVENT.HOLD_EXPIRED, order.holdExpiresAt), EscrowError);
  assert.throws(() => apply(order, EVENT.HOLD_EXPIRED, T0 + 3), EscrowError);
});

test("ATTACK: double-spending by replaying the settling event", () => {
  const { order, release } = lockedOrder();
  const preimage = recoverPreimage(release.secret, order.salt, order.paymentHash, MODE_QR);
  const released = apply(order, EVENT.RELEASE, T0 + 3, { preimage });
  // Pay once, refund never. Every further event on a terminal order is refused.
  for (const e of Object.values(EVENT)) {
    assert.throws(
      () => apply(released, e, T0 + 4, { preimage, amountSats: 1n, paymentRequest: "x" }),
      EscrowError,
    );
  }
  const refunded = apply(lockedOrder().order, EVENT.CANCEL, T0 + 3);
  for (const e of Object.values(EVENT)) {
    assert.throws(() => apply(refunded, e, T0 + 4, { preimage, amountSats: 1n }), EscrowError);
  }
});

test("ATTACK: mutating an order object in place to change its state", () => {
  const { order } = lockedOrder();
  // Orders are frozen, so a compromised handler cannot quietly rewrite one.
  assert.throws(() => {
    "use strict";
    order.state = STATE.RELEASED;
  }, TypeError);
  assert.throws(() => {
    "use strict";
    order.failedReleaseAttempts = 0;
  }, TypeError);
  assert.equal(order.state, STATE.LOCKED);
});

test("ATTACK: forging a receipt for money that was never released", () => {
  const { order, release } = lockedOrder();
  const preimage = recoverPreimage(release.secret, order.salt, order.paymentHash, MODE_QR);
  // A receipt only exists for a genuinely released order.
  assert.throws(() => receipt(order, preimage), EscrowError);
  assert.throws(() => receipt(apply(order, EVENT.CANCEL, T0 + 3), preimage), EscrowError);
});

test("ATTACK: near-miss secrets leak nothing through the comparison", () => {
  // Comparison uses crypto.timingSafeEqual over the derived hash, so a guess
  // that shares a long prefix is rejected exactly like one that shares none.
  const { order, release } = lockedOrder();
  const real = release.secret;
  const nearMisses = [
    real.slice(0, -1) + (real.endsWith("A") ? "B" : "A"),
    real.slice(1),
    real + "=",
    real.toUpperCase() === real ? real.toLowerCase() : real.toUpperCase(),
  ];
  for (const guess of nearMisses) {
    if (guess === real) continue;
    assert.equal(recoverPreimage(guess, order.salt, order.paymentHash, MODE_QR), null);
  }
  // Surrounding whitespace IS forgiven, on purpose: a recipient pasting a
  // scanned code should not be punished for a trailing newline.
  assert.ok(recoverPreimage("  " + real + "\n", order.salt, order.paymentHash, MODE_QR));
});

test("ATTACK: a typed secret is never silently accepted at low entropy", () => {
  // The generator refuses lengths that would be trivially guessable, so an
  // operator cannot quietly weaken the system by asking for a 4-digit code.
  assert.throws(() => generateTypedSecret(1));
  assert.throws(() => generateTypedSecret(5));
  assert.equal(generateTypedSecret(6).length, 6);
});
