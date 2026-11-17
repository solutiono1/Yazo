// The orchestration layer: the pure state machine on one side, a Lightning node
// on the other.
//
// ORDER OF OPERATIONS. The node is the source of truth for money; our database
// is only a record of it. So every money-moving method follows the same shape:
//
//   1. validate the transition with the pure machine (throws if illegal)
//   2. ask the node to move the money (throws if it refuses)
//   3. only then persist the new state
//
// Doing it the other way round - recording "released" and then discovering the
// node refused - leaves us telling a vendor he was paid when he was not. If
// step 3 ever fails, the node still holds the truth and `syncFromNode` restores
// our record from it.
import { randomBytes } from "node:crypto";
import {
  createOrder,
  apply,
  receipt,
  isRefundDue,
  requiredFinalCltvBlocks,
  releaseIsBlocked,
  STATE,
  EVENT,
  EscrowError,
} from "./core/escrow.js";
import { quote } from "./core/money.js";
import { newReleaseSecret, recoverPreimage, MODE_QR } from "./core/secret.js";
import { INVOICE_STATE } from "./lightning/client.js";

/** Swappable persistence. The default keeps everything in memory. */
export class MemoryStore {
  constructor() {
    this.orders = new Map();
  }
  async get(id) {
    return this.orders.get(id) ?? null;
  }
  async put(order) {
    this.orders.set(order.id, order);
    return order;
  }
  async all() {
    return [...this.orders.values()];
  }
}

// Order ids are the capability that reaches an order: whoever holds the link
// can see it, and the recipient can present a code against it. A sequential or
// time-based id would let anyone walk the whole book, so ids are 128 bits of
// randomness. Guessing one is not a realistic attack; guessing is not the
// weakness we are defending against either, but enumeration would be.
const defaultIdFactory = () => `ord_${randomBytes(16).toString("base64url")}`;

export class EscrowService {
  /**
   * @param {object} deps
   * @param {object} deps.node        LndClient or FakeLnd
   * @param {object} [deps.store]     persistence
   * @param {() => number} [deps.now] clock, injectable for tests
   * @param {() => Promise<bigint>} deps.btcUsd price oracle, whole USD per BTC
   */
  constructor({
    node,
    store = new MemoryStore(),
    now = () => Date.now(),
    btcUsd,
    idFactory = defaultIdFactory,
    onError,
  }) {
    if (!node) throw new EscrowError("a Lightning node is required");
    if (typeof btcUsd !== "function") throw new EscrowError("a btcUsd price source is required");
    this.node = node;
    this.store = store;
    this.now = now;
    this.btcUsd = btcUsd;
    this.idFactory = idFactory;
    this.onError = onError;
  }

  /**
   * Rebuild our view of the world from the node after a restart or crash.
   *
   * The node is the source of truth for money. If we died between settling an
   * invoice and writing the row, the node knows and we do not - so on boot we
   * ask it about every order that still has money at stake, and correct
   * ourselves. Without this, a crash at the wrong moment leaves a vendor
   * believing he was not paid when he was.
   */
  async reconcile() {
    const corrections = [];
    const live = this.store.live ? await this.store.live() : await this.store.all();
    for (const order of live) {
      let invoice;
      try {
        invoice = await this.node.lookupInvoice(order.paymentHash);
      } catch (e) {
        this.onError?.(e, order.id);
        continue;
      }

      // The node settled it but we never recorded that.
      if (invoice.state === INVOICE_STATE.SETTLED && order.state !== STATE.RELEASED) {
        const repaired = { ...order, state: STATE.RELEASED, settledAt: order.settledAt ?? this.now() };
        await this.store.put(Object.freeze(repaired));
        corrections.push({ id: order.id, from: order.state, to: STATE.RELEASED });
        continue;
      }
      // The node cancelled it but we never recorded that.
      if (invoice.state === INVOICE_STATE.CANCELED && order.state !== STATE.REFUNDED) {
        const repaired = { ...order, state: STATE.REFUNDED, settledAt: order.settledAt ?? this.now() };
        await this.store.put(Object.freeze(repaired));
        corrections.push({ id: order.id, from: order.state, to: STATE.REFUNDED });
        continue;
      }
      // Payment arrived while we were down.
      if (invoice.state === INVOICE_STATE.ACCEPTED && order.state === STATE.AWAITING_PAYMENT) {
        const locked = apply(order, EVENT.PAYMENT_LOCKED, this.now(), { amountSats: invoice.amtPaidSat });
        await this.store.put(locked);
        corrections.push({ id: order.id, from: order.state, to: STATE.LOCKED });
      }
    }
    return corrections;
  }

  /**
   * Create an order and its hold invoice.
   *
   * Returns the release secret EXACTLY ONCE. The caller must deliver it to the
   * recipient and then forget it: it is not stored, and it cannot be recovered.
   */
  async createOrder({ vendorId, payerId, recipientLabel, usdCents, mode = MODE_QR, holdMs, memo }) {
    const now = this.now();
    const price = await this.btcUsd();
    const q = quote(usdCents, price, now);
    const release = newReleaseSecret(mode);

    let order = createOrder({
      id: this.idFactory(),
      vendorId,
      payerId,
      recipientLabel,
      q,
      release,
      holdMs,
      now,
    });

    // The invoice must outlive the hold window, or an unsettled HTLC reaches
    // its CLTV deadline and the channel force-closes.
    const { paymentRequest } = await this.node.addHoldInvoice({
      paymentHash: order.paymentHash,
      sats: q.sats,
      memo: memo ?? `Yazo order for ${recipientLabel}`,
      expirySeconds: Math.ceil(order.holdMs / 1000),
      cltvExpiry: requiredFinalCltvBlocks(order.holdMs),
    });

    order = apply(order, EVENT.INVOICE_CREATED, this.now(), { paymentRequest });
    await this.store.put(order);

    return { order, paymentRequest, secret: release.secret };
  }

  /**
   * Reconcile our record against the node. This is how we learn that a payer
   * has paid: the node reports an ACCEPTED (held) HTLC.
   */
  async syncFromNode(orderId) {
    const order = await this.#load(orderId);
    if (order.state !== STATE.AWAITING_PAYMENT) return order;

    const invoice = await this.node.lookupInvoice(order.paymentHash);
    if (invoice.state !== INVOICE_STATE.ACCEPTED) return order;

    const locked = apply(order, EVENT.PAYMENT_LOCKED, this.now(), { amountSats: invoice.amtPaidSat });
    return this.store.put(locked);
  }

  /**
   * The recipient presents their code. If it is right, the funds are released
   * to the vendor; if it is wrong, the attempt is counted against a hard cap.
   */
  async release(orderId, presentedSecret) {
    const order = await this.#load(orderId);

    const preimage = recoverPreimage(presentedSecret, order.salt, order.paymentHash, order.secretMode);
    if (!preimage) {
      // Wrong code. Record the attempt so guessing is bounded, then refuse.
      if (order.state === STATE.LOCKED && !releaseIsBlocked(order)) {
        const counted = apply(order, EVENT.RELEASE_FAILED, this.now());
        await this.store.put(counted);
        if (releaseIsBlocked(counted)) {
          // Allowance spent: return the payer's money rather than let a
          // guesser keep trying.
          await this.refund(orderId, "too many failed release attempts");
        }
      }
      throw new EscrowError("that code is not valid for this order");
    }

    // 1. validate  2. move the money  3. persist
    const released = apply(order, EVENT.RELEASE, this.now(), { preimage });
    await this.node.settleInvoice(preimage);
    await this.store.put(released);

    return { order: released, receipt: receipt(released, preimage) };
  }

  /** Return the payer's money. Always available until the order is released. */
  async refund(orderId, reason = "cancelled") {
    const order = await this.#load(orderId);
    const now = this.now();
    const event = isRefundDue(order, now) && now > order.holdExpiresAt ? EVENT.HOLD_EXPIRED : EVENT.CANCEL;

    const next = apply(order, event, now);
    await this.node.cancelInvoice(order.paymentHash);
    return this.store.put({ ...next, refundReason: reason });
  }

  /**
   * The watcher. Any order whose hold window has passed - or which has burned
   * its guess allowance - is refunded. Nobody has to remember to do this.
   */
  async expireDueHolds() {
    const now = this.now();
    const refunded = [];
    // Prefer the store's indexed view of orders that still have money at
    // stake; fall back to a full scan for stores that do not provide one.
    const candidates = this.store.live ? await this.store.live() : await this.store.all();
    for (const order of candidates) {
      if (isRefundDue(order, now)) {
        try {
          refunded.push(await this.refund(order.id, "hold window elapsed"));
        } catch (e) {
          // One stuck order must never stop the others from being refunded.
          this.onError?.(e, order.id);
        }
      }
    }
    return refunded;
  }

  async #load(orderId) {
    const order = await this.store.get(orderId);
    if (!order) throw new EscrowError(`unknown order: ${orderId}`);
    return order;
  }
}
