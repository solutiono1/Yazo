// Signing for outbound webhooks.
//
// A receiver has to be able to tell a real Yazo delivery from anybody who
// learned the URL. The URL is not a secret - it ends up in logs, proxies and
// screenshots - so the proof is an HMAC over the body, keyed by a secret that
// only the receiver and this node hold.
//
// The timestamp is inside the signed material on purpose. Signing the body
// alone would let anyone who captured one delivery replay it forever; with the
// timestamp signed, a replay is only valid inside the tolerance window, and the
// receiver can reject anything older.
//
//   Yazo-Signature: t=1763500000,v1=<hex hmac-sha256 of "t.body">
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

export const SIGNATURE_HEADER = "yazo-signature";

/** Default tolerance for how stale a signed timestamp may be. */
export const DEFAULT_TOLERANCE_MS = 5 * 60 * 1000;

/** A fresh endpoint secret. Shown to the vendor once, stored by both sides. */
export function newEndpointSecret() {
  return `yws_${randomBytes(32).toString("base64url")}`;
}

/**
 * The exact bytes an HMAC is taken over. Both sides must build this the same
 * way or nothing verifies, so it lives in one function rather than twice.
 */
export function signingPayload(timestampSec, body) {
  return `${timestampSec}.${body}`;
}

/**
 * @param {object} opts
 * @param {string} opts.body raw JSON body, exactly as it will be sent
 * @param {string} opts.secret the endpoint secret
 * @param {number} opts.at milliseconds
 * @returns {{header: string, timestampSec: number, signature: string}}
 */
export function signBody({ body, secret, at }) {
  if (typeof body !== "string") throw new TypeError("body must be the raw string that is sent");
  if (!secret) throw new TypeError("secret is required");
  const timestampSec = Math.floor(at / 1000);
  const signature = createHmac("sha256", secret)
    .update(signingPayload(timestampSec, body))
    .digest("hex");
  return { header: `t=${timestampSec},v1=${signature}`, timestampSec, signature };
}

/** Parse "t=...,v1=..." without trusting its shape. */
export function parseSignatureHeader(header) {
  if (typeof header !== "string") return null;
  let t = null;
  let v1 = null;
  for (const part of header.split(",")) {
    const [key, value] = part.trim().split("=");
    if (key === "t" && /^\d+$/.test(value ?? "")) t = Number(value);
    else if (key === "v1" && /^[0-9a-f]+$/i.test(value ?? "")) v1 = value;
  }
  if (t === null || v1 === null) return null;
  return { timestampSec: t, signature: v1 };
}

/**
 * The check a receiver runs. Exported because it is also what our own tests
 * assert against, and because anybody integrating deserves the reference
 * implementation rather than a prose description of it.
 *
 * @returns {boolean} true only if the signature matches AND is inside tolerance
 */
export function verifySignature({ header, body, secret, now, toleranceMs = DEFAULT_TOLERANCE_MS }) {
  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;

  // Window check first: a stale-but-valid signature is still a replay.
  const skewMs = Math.abs(now - parsed.timestampSec * 1000);
  if (skewMs > toleranceMs) return false;

  const expected = createHmac("sha256", secret)
    .update(signingPayload(parsed.timestampSec, body))
    .digest();
  let presented;
  try {
    presented = Buffer.from(parsed.signature, "hex");
  } catch {
    return false;
  }
  // timingSafeEqual throws on a length mismatch, which is itself a tell, so
  // the length is checked separately and the compare only runs on equal sizes.
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}
