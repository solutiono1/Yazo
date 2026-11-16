// The escrow state machine. Pure functions over plain objects: no network, no
// database, no clock of its own. Everything here is unit-testable, and the
// Lightning layer is a thin adapter that reacts to these transitions.
import { timingSafeEqual } from "node:crypto";
import { quoteIsFresh } from "./money.js";
import { paymentHashFor } from "./secret.js";

export const STATE = Object.freeze({
  DRAFT: "DRAFT", // order exists, nothing at stake yet
  AWAITING_PAYMENT: "AWAITING_PAYMENT", // hold invoice issued, nobody has paid
  LOCKED: "LOCKED", // HTLC accepted: funds held by the network
  RELEASED: "RELEASED", // recipient's secret settled it; vendor paid
  REFUNDED: "REFUNDED", // hold cancelled; payer made whole
  VOID: "VOID", // abandoned before any money moved
});

const TERMINAL = new Set([STATE.RELEASED, STATE.REFUNDED, STATE.VOID]);

export const EVENT = Object.freeze({
  INVOICE_CREATED: "INVOICE_CREATED",
  PAYMENT_LOCKED: "PAYMENT_LOCKED",
  RELEASE: "RELEASE",
  RELEASE_FAILED: "RELEASE_FAILED",
  HOLD_EXPIRED: "HOLD_EXPIRED",
  CANCEL: "CANCEL",
});

// How long funds may sit locked. Short by default: a locked HTLC ties up the
// payer's money and our peer's channel liquidity, and the longer it is held the
// closer it creeps to its CLTV deadline.
export const DEFAULT_HOLD_MS = 6 * 60 * 60 * 1000; // 6 hours
export const MAX_HOLD_MS = 24 * 60 * 60 * 1000; // 24 hours, hard ceiling

// Wrong-secret attempts an order will ever accept. This is the server-side
// brake on guessing a short TYPED secret. Once spent, the order can only
// refund - we would rather return the payer's money than let a guesser win.
export const MAX_RELEASE_ATTEMPTS = 5;

const MS_PER_BLOCK = 10 * 60 * 1000; // nominal Bitcoin block interval
const CLTV_SAFETY_BLOCKS = 40; // ~6.7h of slack for slow blocks and routing

export class EscrowError extends Error {}

/**
 * An un-settled HTLC whose CLTV height passes gets force-closed on chain, which
 * is how naive hold-invoice designs lose channels. So the final CLTV we request
 * must cover the whole hold window plus real slack.
 */
export function requiredFinalCltvBlocks(holdMs = DEFAULT_HOLD_MS) {
  if (holdMs <= 0 || holdMs > MAX_HOLD_MS) {
    throw new EscrowError("holdMs must be within (0, " + MAX_HOLD_MS + "]");
  }
  return Math.ceil(holdMs / MS_PER_BLOCK) + CLTV_SAFETY_BLOCKS;
}

export function createOrder({
  id,
  vendorId,
  payerId,
  recipientLabel,
  q,
  release,
  holdMs = DEFAULT_HOLD_MS,
  now,
}) {
  for (const [field, value] of Object.entries({ id, vendorId, payerId, recipientLabel })) {
    if (typeof value !== "string" || value.length === 0) {
      throw new EscrowError(field + " is required");
    }
  }
  if (!q || typeof q.sats !== "bigint") throw new EscrowError("a quote is required");
  if (!release?.paymentHash || !release?.salt) throw new EscrowError("a release secret is required");
  requiredFinalCltvBlocks(holdMs); // validate up front, not at invoice time

  return Object.freeze({
    id,
    vendorId,
    payerId,
    recipientLabel, // a first name is enough; we store no recipient PII
    state: STATE.DRAFT,
    quote: q,
    // From the release secret we keep ONLY these two. See secret.js.
    paymentHash: release.paymentHash,
    salt: release.salt,
    secretMode: release.mode,
    holdMs,
    createdAt: now,
    invoice: null,
    lockedAt: null,
    holdExpiresAt: null,
    settledAt: null,
    failedReleaseAttempts: 0,
    history: Object.freeze([{ at: now, event: "CREATED", state: STATE.DRAFT }]),
  });
}

/** True once an order has burned through its wrong-secret allowance. */
export function releaseIsBlocked(order) {
  return order.failedReleaseAttempts >= MAX_RELEASE_ATTEMPTS;
}

/**
 * The single reducer. Returns a new order, or throws EscrowError on an illegal
 * transition - illegal transitions are bugs or attacks, never normal flow.
 */
export function apply(order, event, now, payload = {}) {
  if (TERMINAL.has(order.state)) {
    throw new EscrowError("order " + order.id + " is terminal (" + order.state + "); " + event + " rejected");
  }
  const next = (changes, label = event) =>
    Object.freeze({
      ...order,
      ...changes,
      history: Object.freeze([
        ...order.history,
        { at: now, event: label, state: changes.state ?? order.state },
      ]),
    });

  switch (event) {
    case EVENT.INVOICE_CREATED: {
      if (order.state !== STATE.DRAFT) throw new EscrowError("invoice already created");
      if (!payload.paymentRequest) throw new EscrowError("paymentRequest required");
      if (!quoteIsFresh(order.quote, now)) throw new EscrowError("quote expired; re-quote before invoicing");
      return next({ state: STATE.AWAITING_PAYMENT, invoice: payload.paymentRequest });
    }

    case EVENT.PAYMENT_LOCKED: {
      if (order.state !== STATE.AWAITING_PAYMENT) throw new EscrowError("not awaiting payment");
      // The network tells us how much actually arrived. Short-paying an escrow
      // must not lock an order as though it were fully funded.
      if (typeof payload.amountSats !== "bigint") throw new EscrowError("amountSats required");
      if (payload.amountSats < order.quote.sats) {
        throw new EscrowError("underpaid: locked " + payload.amountSats + " < quoted " + order.quote.sats);
      }
      return next({ state: STATE.LOCKED, lockedAt: now, holdExpiresAt: now + order.holdMs });
    }

    case EVENT.RELEASE_FAILED: {
      // A wrong secret was presented. Count it; the allowance is finite.
      if (order.state !== STATE.LOCKED) throw new EscrowError("nothing is locked");
      return next({ failedReleaseAttempts: order.failedReleaseAttempts + 1 });
    }

    case EVENT.RELEASE: {
      if (order.state !== STATE.LOCKED) throw new EscrowError("nothing is locked to release");
      if (releaseIsBlocked(order)) {
        throw new EscrowError("too many failed attempts; this order can only refund");
      }
      // The caller should already have recovered this from the recipient's
      // secret, but we never take that on trust. Shape is not proof: a buffer
      // of 32 zero bytes is the right shape and is not a key. The preimage
      // must actually hash to THIS order's payment hash, or no money moves.
      const { preimage } = payload;
      if (!Buffer.isBuffer(preimage) || preimage.length !== 32) {
        throw new EscrowError("a valid 32-byte preimage is required to release");
      }
      if (!timingSafeEqual(paymentHashFor(preimage), order.paymentHash)) {
        throw new EscrowError("preimage does not match this order's payment hash");
      }
      if (now > order.holdExpiresAt) throw new EscrowError("hold window has passed; this order refunds");
      return next({ state: STATE.RELEASED, settledAt: now });
    }

    case EVENT.HOLD_EXPIRED: {
      if (order.state !== STATE.LOCKED) throw new EscrowError("only a locked order can expire");
      if (now <= order.holdExpiresAt) throw new EscrowError("hold window has not passed yet");
      return next({ state: STATE.REFUNDED, settledAt: now });
    }

    case EVENT.CANCEL: {
      // Available right up until release: this is the payer's protection.
      if (order.state === STATE.LOCKED) return next({ state: STATE.REFUNDED, settledAt: now });
      return next({ state: STATE.VOID, settledAt: now });
    }

    default:
      throw new EscrowError("unknown event: " + event);
  }
}

/** True when a watcher should cancel the invoice and refund the payer. */
export function isRefundDue(order, now) {
  if (order.state !== STATE.LOCKED) return false;
  return now > order.holdExpiresAt || releaseIsBlocked(order);
}

/**
 * A receipt anyone can check: the payment hash commits to the preimage, and the
 * preimage is only producible from the recipient's secret. Showing both proves
 * the recipient released it - the vendor cannot forge this, and neither can we.
 */
export function receipt(order, preimage) {
  if (order.state !== STATE.RELEASED) throw new EscrowError("only a released order has a receipt");
  return Object.freeze({
    orderId: order.id,
    usdCents: order.quote.usdCents.toString(),
    sats: order.quote.sats.toString(),
    btcUsdAtQuote: order.quote.btcUsd.toString(),
    paymentHash: order.paymentHash.toString("hex"),
    preimage: preimage.toString("hex"),
    lockedAt: order.lockedAt,
    releasedAt: order.settledAt,
    verify: "sha256(preimage) == paymentHash, and the preimage derives only from the recipient's secret",
  });
}
