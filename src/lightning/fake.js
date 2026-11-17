// An in-memory stand-in for lnd that enforces the SAME rules a real node does.
//
// This is not a stub that says yes to everything. It is a model of the parts of
// lnd we depend on, and it refuses exactly what lnd refuses:
//
//   - an invoice cannot be settled unless sha256(preimage) matches its hash
//   - an invoice cannot be settled unless an HTLC is actually being held
//   - a canceled or settled invoice is final
//   - a payment hash cannot be reused
//
// Tests run against this, so the whole escrow flow is verified deterministically
// with no node, no chain and no network. The real LndClient exposes the same
// surface, so swapping it in changes one line of wiring.
import { createHash } from "node:crypto";
import { INVOICE_STATE, LndError } from "./client.js";

const sha256 = (b) => createHash("sha256").update(b).digest();

export class FakeLnd {
  constructor() {
    /** @type {Map<string, object>} keyed by payment hash hex */
    this.invoices = new Map();
    this.calls = []; // call log, so tests can assert what was asked of the node
  }

  #find(paymentHashHex) {
    const invoice = this.invoices.get(paymentHashHex);
    if (!invoice) throw new LndError("unable to locate invoice", 404);
    return invoice;
  }

  async addHoldInvoice({ paymentHash, sats, memo, expirySeconds, cltvExpiry }) {
    if (!Buffer.isBuffer(paymentHash) || paymentHash.length !== 32) {
      throw new LndError("paymentHash must be 32 bytes");
    }
    if (typeof sats !== "bigint" || sats <= 0n) throw new LndError("sats must be a positive bigint");
    const hex = paymentHash.toString("hex");
    // lnd rejects a duplicate payment hash; reusing one would let a second
    // order piggyback on the first order's secret.
    if (this.invoices.has(hex)) throw new LndError("invoice with payment hash already exists", 400);

    const paymentRequest = `lnbcrt${sats}1${hex.slice(0, 20)}`;
    this.invoices.set(hex, {
      paymentHash: hex,
      state: INVOICE_STATE.OPEN,
      sats,
      amtPaidSat: 0n,
      memo,
      expirySeconds,
      cltvExpiry,
      paymentRequest,
    });
    this.calls.push({ method: "addHoldInvoice", paymentHash: hex, sats, cltvExpiry });
    return { paymentRequest };
  }

  async lookupInvoice(paymentHash) {
    const invoice = this.#find(paymentHash.toString("hex"));
    return {
      state: invoice.state,
      amtPaidSat: invoice.amtPaidSat,
      settled: invoice.state === INVOICE_STATE.SETTLED,
    };
  }

  async settleInvoice(preimage) {
    if (!Buffer.isBuffer(preimage) || preimage.length !== 32) {
      throw new LndError("preimage must be 32 bytes");
    }
    // The node itself checks the preimage. Our escrow layer checks it too, but
    // this is the check that actually governs the money.
    const hex = sha256(preimage).toString("hex");
    const invoice = this.invoices.get(hex);
    if (!invoice) throw new LndError("unable to locate invoice", 404);
    if (invoice.state === INVOICE_STATE.OPEN) {
      throw new LndError("invoice still open, no htlcs to settle", 400);
    }
    if (invoice.state !== INVOICE_STATE.ACCEPTED) {
      throw new LndError(`invoice is ${invoice.state}, cannot settle`, 400);
    }
    invoice.state = INVOICE_STATE.SETTLED;
    this.calls.push({ method: "settleInvoice", paymentHash: hex });
  }

  async cancelInvoice(paymentHash) {
    const hex = paymentHash.toString("hex");
    const invoice = this.#find(hex);
    if (invoice.state === INVOICE_STATE.SETTLED) {
      throw new LndError("cannot cancel a settled invoice", 400);
    }
    invoice.state = INVOICE_STATE.CANCELED;
    this.calls.push({ method: "cancelInvoice", paymentHash: hex });
  }

  async getInfo() {
    return { version: "fake-lnd", synced_to_chain: true, block_height: 1 };
  }

  // ---------------------------------------------------------------- test aid --
  /** Simulate a payer's HTLC arriving and being held. */
  payInvoice(paymentHash, sats) {
    const invoice = this.#find(paymentHash.toString("hex"));
    if (invoice.state !== INVOICE_STATE.OPEN) {
      throw new LndError(`invoice is ${invoice.state}, cannot be paid`, 400);
    }
    invoice.state = INVOICE_STATE.ACCEPTED;
    invoice.amtPaidSat = sats ?? invoice.sats;
    return invoice;
  }
}
