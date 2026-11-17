// Admin-level lnd REST calls used ONLY by the local regtest harness: funding a
// wallet, opening a channel, paying an invoice.
//
// These are deliberately kept out of src/. Production Yazo needs exactly four
// invoice calls (see src/lightning/client.js) and should never hold a macaroon
// that can move funds. The harness uses admin.macaroon because setting up a
// test network genuinely requires it.
import https from "node:https";
import { readFileSync } from "node:fs";
import { macaroonPath, tlsCertPath, sleep } from "./config.mjs";

export class LndAdmin {
  constructor(node, name) {
    this.node = node;
    this.name = name;
  }

  #creds() {
    return {
      ca: readFileSync(tlsCertPath(this.node)),
      macaroon: readFileSync(macaroonPath(this.node)).toString("hex"),
    };
  }

  request(method, path, body, { stream = false, onChunk } = {}) {
    const { ca, macaroon } = this.#creds();
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          host: "127.0.0.1",
          port: this.node.rest,
          path,
          method,
          ca,
          checkServerIdentity: () => undefined,
          headers: {
            "Grpc-Metadata-macaroon": macaroon,
            ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
          },
        },
        (res) => {
          if (stream) {
            res.setEncoding("utf8");
            let buffered = "";
            res.on("data", (chunk) => {
              buffered += chunk;
              let nl;
              while ((nl = buffered.indexOf("\n")) >= 0) {
                const line = buffered.slice(0, nl).trim();
                buffered = buffered.slice(nl + 1);
                if (!line) continue;
                try {
                  if (onChunk(JSON.parse(line)) === "stop") {
                    req.destroy();
                    resolve("stopped");
                  }
                } catch {
                  /* partial frame */
                }
              }
            });
            res.on("end", () => resolve("ended"));
            return;
          }
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let parsed;
            try {
              parsed = text ? JSON.parse(text) : {};
            } catch {
              return reject(new Error(`${this.name} returned non-JSON (${res.statusCode}): ${text.slice(0, 200)}`));
            }
            if (res.statusCode < 200 || res.statusCode >= 300) {
              return reject(new Error(`${this.name} ${path} failed: ${parsed.message ?? text.slice(0, 200)}`));
            }
            resolve(parsed);
          });
        },
      );
      req.on("error", (e) => (stream ? resolve("aborted") : reject(e)));
      if (payload) req.write(payload);
      req.end();
    });
  }

  getInfo = () => this.request("GET", "/v1/getinfo");
  newAddress = () => this.request("GET", "/v1/newaddress?type=WITNESS_PUBKEY_HASH");
  walletBalance = () => this.request("GET", "/v1/balance/blockchain");
  channelBalance = () => this.request("GET", "/v1/balance/channels");
  listChannels = () => this.request("GET", "/v1/channels");

  connectPeer = (pubkey, host) =>
    this.request("POST", "/v1/peers", { addr: { pubkey, host }, perm: true }).catch((e) => {
      if (String(e.message).includes("already connected")) return { ok: true };
      throw e;
    });

  openChannel = (pubkeyHex, localFundingSat) =>
    this.request("POST", "/v1/channels", {
      node_pubkey: Buffer.from(pubkeyHex, "hex").toString("base64"),
      local_funding_amount: String(localFundingSat),
      push_sat: String(Math.floor(localFundingSat / 2)),
      target_conf: 1,
    });

  /**
   * Fire a payment at a HOLD invoice and return as soon as it is in flight.
   *
   * A hold invoice never completes on its own, so we must not wait for it: the
   * HTLC sits locked at the recipient until someone settles or cancels it.
   * Aborting the observation stream does not cancel the payment; lnd keeps it
   * in flight server-side, which is exactly the state escrow depends on.
   */
  async payHeld(paymentRequest, { timeoutSeconds = 120 } = {}) {
    let seen = null;
    await this.request(
      "POST",
      "/v2/router/send",
      {
        payment_request: paymentRequest,
        timeout_seconds: timeoutSeconds,
        fee_limit_sat: "1000",
        no_inflight_updates: false,
      },
      {
        stream: true,
        onChunk: (frame) => {
          const status = frame?.result?.status ?? frame?.status;
          if (status) seen = status;
          if (status === "IN_FLIGHT" || status === "FAILED" || status === "SUCCEEDED") return "stop";
          return undefined;
        },
      },
    );
    return seen;
  }

  trackPayment = (paymentHashHex) =>
    new Promise((resolve) => {
      let last = null;
      this.request(
        "GET",
        `/v2/router/track/${encodeURIComponent(Buffer.from(paymentHashHex, "hex").toString("base64"))}`,
        undefined,
        {
          stream: true,
          onChunk: (frame) => {
            const status = frame?.result?.status ?? frame?.status;
            if (status) last = status;
            if (status === "SUCCEEDED" || status === "FAILED") return "stop";
            return undefined;
          },
        },
      ).then(() => resolve(last));
      setTimeout(() => resolve(last), 15_000);
    });

  async waitUntilReady({ attempts = 90, delayMs = 1000, requireSynced = false } = {}) {
    let last = "no response";
    for (let i = 0; i < attempts; i += 1) {
      try {
        const info = await this.getInfo();
        if (info.identity_pubkey && (!requireSynced || info.synced_to_chain)) return info;
        last = requireSynced ? "not yet synced to chain" : "no pubkey";
      } catch (e) {
        last = e.message;
      }
      await sleep(delayMs);
    }
    throw new Error(`${this.name} did not become ready: ${last}`);
  }

  /**
   * lnd answers getinfo before its RPC server finishes starting, so peer and
   * channel calls can still bounce with "server is still in the process of
   * starting". Retry those rather than failing the whole harness.
   */
  async retrying(label, fn, { attempts = 45, delayMs = 2000 } = {}) {
    let last;
    for (let i = 0; i < attempts; i += 1) {
      try {
        return await fn();
      } catch (e) {
        last = e;
        if (!/still in the process of starting|not yet active|server is still/i.test(e.message)) throw e;
        await sleep(delayMs);
      }
    }
    throw new Error(`${label} never succeeded: ${last?.message}`);
  }
}
