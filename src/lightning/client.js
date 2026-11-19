// A minimal LND client over its REST interface.
//
// Deliberately zero-dependency: no gRPC, no protobuf toolchain, no npm install
// before a reviewer can run this. It speaks to lnd over node:https, trusting
// the node's own self-signed certificate explicitly rather than disabling TLS
// verification, and authenticates with a macaroon.
//
// We use exactly four calls, all from lnd's invoicesrpc:
//   AddHoldInvoice  - create an invoice that will NOT auto-settle
//   LookupInvoice   - read its state (OPEN / ACCEPTED / SETTLED / CANCELED)
//   SettleInvoice   - release the held funds, using the preimage
//   CancelInvoice   - return the held funds to the payer
//
// SECURITY: the macaroon is bearer authority over this node. It is read from
// disk at startup, never logged, and never committed (see .gitignore).
import https from "node:https";
import { readFileSync } from "node:fs";

export const INVOICE_STATE = Object.freeze({
  OPEN: "OPEN", // created, nobody has paid
  ACCEPTED: "ACCEPTED", // an HTLC is held: this is escrow's "locked"
  SETTLED: "SETTLED", // released to us
  CANCELED: "CANCELED", // returned to the payer
});

/**
 * Split a streaming buffer into complete top-level JSON values plus whatever
 * incomplete tail is left over.
 *
 * lnd's gRPC-gateway stream writes one JSON object per message but does not
 * reliably separate them with a newline, and a TCP chunk boundary has no
 * relationship to a message boundary either - two complete frames can arrive
 * concatenated in a single chunk, or one frame can span several chunks.
 * Splitting on newlines alone is correct only in the newline-delimited case;
 * splitting on "ends with }" is correct only for a single frame. Neither
 * survives frames arriving back to back with nothing between them, which
 * silently and permanently wedges the buffer - the previous version of this
 * function did exactly that, and nothing caught it because this path has no
 * direct coverage (the LND node is faked out in every other test).
 *
 * This tracks brace depth directly, respecting JSON string literals and
 * escapes so a `}` inside a quoted string never counts, and emits a frame
 * the instant depth returns to zero - independent of whatever whitespace
 * surrounds it.
 *
 * @param {string} buffer
 * @returns {{ frames: string[], remainder: string }}
 */
export function splitFrames(buffer) {
  const frames = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let frameStart = -1;
  let i = 0;

  for (; i < buffer.length; i += 1) {
    const ch = buffer[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) frameStart = i;
      depth += 1;
      continue;
    }
    if (ch === "}") {
      if (depth === 0) continue; // stray brace outside any object; ignore
      depth -= 1;
      if (depth === 0 && frameStart >= 0) {
        frames.push(buffer.slice(frameStart, i + 1));
        frameStart = -1;
      }
    }
  }

  // Whatever comes after the last complete frame (whitespace, or a frame
  // still in progress) is carried forward untouched.
  const remainder = frameStart >= 0 ? buffer.slice(frameStart) : buffer.slice(i);
  return { frames, remainder };
}

export class LndError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export class LndClient {
  /**
   * @param {object} opts
   * @param {string} opts.host        e.g. "127.0.0.1"
   * @param {number} opts.port        lnd's REST port, usually 8080
   * @param {string} opts.tlsCertPath path to lnd's tls.cert
   * @param {string} opts.macaroonPath path to an invoice.macaroon (least privilege)
   */
  constructor({ host, port, tlsCertPath, macaroonPath }) {
    this.host = host;
    this.port = port;
    // Trust this node's specific certificate rather than turning verification
    // off. A self-signed cert is fine; skipping verification is not.
    this.ca = readFileSync(tlsCertPath);
    this.macaroon = readFileSync(macaroonPath).toString("hex");
  }

  /** Least privilege: invoice.macaroon can create and settle, but cannot send. */
  static fromLndDir(lndDir, { host = "127.0.0.1", port = 8080, network = "regtest" } = {}) {
    return new LndClient({
      host,
      port,
      tlsCertPath: `${lndDir}/tls.cert`,
      macaroonPath: `${lndDir}/data/chain/bitcoin/${network}/invoice.macaroon`,
    });
  }

  #request(method, path, body) {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const options = {
      host: this.host,
      port: this.port,
      path,
      method,
      ca: this.ca,
      // lnd's cert is issued for its own hostname/IP; we pin the CA above.
      checkServerIdentity: () => undefined,
      headers: {
        "Grpc-Metadata-macaroon": this.macaroon,
        ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
      },
    };

    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed;
          try {
            parsed = text ? JSON.parse(text) : {};
          } catch {
            return reject(new LndError("lnd returned non-JSON", res.statusCode, text));
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            // Never echo the macaroon or request body into an error.
            return reject(new LndError(parsed.message || "lnd request failed", res.statusCode, parsed));
          }
          resolve(parsed);
        });
      });
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  /**
   * Create a hold invoice for a payment hash we did NOT generate randomly -
   * it comes from the recipient's release secret. That is the whole trick.
   */
  async addHoldInvoice({ paymentHash, sats, memo, expirySeconds, cltvExpiry }) {
    if (!Buffer.isBuffer(paymentHash) || paymentHash.length !== 32) {
      throw new LndError("paymentHash must be 32 bytes");
    }
    if (typeof sats !== "bigint" || sats <= 0n) throw new LndError("sats must be a positive bigint");
    const res = await this.#request("POST", "/v2/invoices/hodl", {
      memo,
      hash: paymentHash.toString("base64"),
      value: sats.toString(),
      expiry: String(expirySeconds),
      cltv_expiry: String(cltvExpiry),
    });
    return { paymentRequest: res.payment_request };
  }

  async lookupInvoice(paymentHash) {
    const res = await this.#request("GET", `/v1/invoice/${paymentHash.toString("hex")}`);
    // lnd returns an all-zero r_preimage until the invoice actually settles,
    // so an unsettled invoice must report null rather than 32 zero bytes -
    // that value is the right shape and is not a key.
    const raw = res.r_preimage ? Buffer.from(res.r_preimage, "base64") : null;
    const rPreimage = raw && raw.length === 32 && raw.some((b) => b !== 0) ? raw : null;
    return {
      state: res.state,
      amtPaidSat: BigInt(res.amt_paid_sat ?? "0"),
      settled: Boolean(res.settled),
      rPreimage,
    };
  }

  /** Release the held funds. Only possible with the real preimage. */
  async settleInvoice(preimage) {
    if (!Buffer.isBuffer(preimage) || preimage.length !== 32) {
      throw new LndError("preimage must be 32 bytes");
    }
    await this.#request("POST", "/v2/invoices/settle", { preimage: preimage.toString("base64") });
  }

  /** Return the held funds to the payer. */
  async cancelInvoice(paymentHash) {
    await this.#request("POST", "/v2/invoices/cancel", {
      payment_hash: paymentHash.toString("base64"),
    });
  }

  async getInfo() {
    return this.#request("GET", "/v1/getinfo");
  }

  /**
   * Watch one invoice and be told the moment its state changes.
   *
   * Polling a node every few seconds is both wasteful and slow; the payer
   * deserves to see "locked" the instant their HTLC lands. The watcher still
   * sweeps on a timer as a safety net, because a dropped stream must never be
   * the reason a refund does not happen.
   *
   * @returns {() => void} call to stop watching
   */
  subscribeInvoice(paymentHash, onUpdate) {
    // lnd's REST gateway rejects base64url on this path parameter
    // ("illegal base64 data"). It wants standard base64, URL-escaped.
    const rHash = encodeURIComponent(paymentHash.toString("base64"));
    let stopped = false;
    const req = https.request(
      {
        host: this.host,
        port: this.port,
        path: `/v2/invoices/subscribe/${rHash}`,
        method: "GET",
        ca: this.ca,
        checkServerIdentity: () => undefined,
        headers: { "Grpc-Metadata-macaroon": this.macaroon },
      },
      (res) => {
        // Without this, a rejected subscription simply hangs for ever and the
        // caller believes it is watching something. Surface it instead.
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (body += c));
          res.on("end", () => {
            if (!stopped) onUpdate({ error: `subscribe failed (${res.statusCode}): ${body.slice(0, 200)}` });
          });
          return;
        }
        res.setEncoding("utf8");
        let buffered = "";

        // Frames arrive as JSON objects, but neither a newline nor a TCP
        // chunk boundary lines up with a frame boundary - see splitFrames()
        // for why a heuristic here (newlines, or "buffer ends with }") can
        // silently and permanently wedge on two frames arriving back to
        // back with nothing between them.
        const emit = (text) => {
          if (stopped) return;
          let frame;
          try {
            frame = JSON.parse(text);
          } catch {
            return; // genuinely malformed, not just incomplete; drop it
          }
          if (frame.error) {
            onUpdate({ error: frame.error.message ?? "stream error" });
            return;
          }
          const invoice = frame.result ?? frame;
          if (invoice?.state) {
            onUpdate({
              state: invoice.state,
              amtPaidSat: BigInt(invoice.amt_paid_sat ?? "0"),
              settled: Boolean(invoice.settled),
            });
          }
        };

        res.on("data", (chunk) => {
          buffered += chunk;
          const { frames, remainder } = splitFrames(buffered);
          frames.forEach(emit);
          buffered = remainder;
        });
      },
    );
    req.on("error", (e) => {
      if (!stopped) onUpdate({ error: e.message });
    });
    req.end();

    return () => {
      stopped = true;
      req.destroy();
    };
  }
}
