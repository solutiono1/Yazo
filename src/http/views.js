// What an order looks like from outside.
//
// The order object carries material that must never leave the server: the salt
// is half of what derives the preimage, and handing it out alongside the
// payment hash would let anyone brute force a typed code offline. So responses
// are built from an explicit allow-list rather than by deleting fields from the
// real object - forget a delete and you leak; forget an add and you merely
// omit something harmless.
import { STATE, MAX_RELEASE_ATTEMPTS } from "../core/escrow.js";
import { formatUsd } from "../core/money.js";

const HUMAN_STATE = {
  [STATE.DRAFT]: "Preparing",
  [STATE.AWAITING_PAYMENT]: "Waiting for payment",
  [STATE.LOCKED]: "Paid and held",
  [STATE.RELEASED]: "Released to the vendor",
  [STATE.REFUNDED]: "Refunded to the payer",
  [STATE.VOID]: "Cancelled",
};

export function orderView(order, { now = Date.now() } = {}) {
  return {
    id: order.id,
    state: order.state,
    status: HUMAN_STATE[order.state] ?? order.state,
    recipientLabel: order.recipientLabel,
    vendorId: order.vendorId,
    amount: {
      usdCents: order.quote.usdCents.toString(),
      usdFormatted: formatUsd(order.quote.usdCents),
      sats: order.quote.sats.toString(),
      btcUsdAtQuote: order.quote.btcUsd.toString(),
    },
    paymentRequest: order.state === STATE.AWAITING_PAYMENT ? order.invoice : null,
    paymentHash: order.paymentHash.toString("hex"),
    secretMode: order.secretMode,
    hold: {
      expiresAt: order.holdExpiresAt,
      msRemaining: order.holdExpiresAt ? Math.max(0, order.holdExpiresAt - now) : null,
    },
    attempts: {
      failed: order.failedReleaseAttempts,
      remaining: Math.max(0, MAX_RELEASE_ATTEMPTS - order.failedReleaseAttempts),
    },
    createdAt: order.createdAt,
    lockedAt: order.lockedAt,
    settledAt: order.settledAt,
    // Deliberately absent: salt, and anything derived from the release secret.
  };
}

export function receiptView(receipt) {
  return {
    orderId: receipt.orderId,
    amount: { usdCents: receipt.usdCents, sats: receipt.sats, btcUsdAtQuote: receipt.btcUsdAtQuote },
    paymentHash: receipt.paymentHash,
    preimage: receipt.preimage,
    lockedAt: receipt.lockedAt,
    releasedAt: receipt.releasedAt,
    verify: receipt.verify,
  };
}

export const eventsView = (events) => events.map((e) => ({ at: e.at, event: e.event, state: e.state }));

/**
 * The four link keys, returned once at creation and never again.
 *
 * `capabilities` travels with each key so the surface holding it can render
 * only the buttons it is actually allowed to press - but it is a hint for the
 * UI, never the check. The check is in the router, on every request.
 */
export const linksView = (links) =>
  Object.fromEntries(
    Object.entries(links ?? {}).map(([role, link]) => [
      role,
      { role: link.role, key: link.key, capabilities: link.capabilities },
    ]),
  );
