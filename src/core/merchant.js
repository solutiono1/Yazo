// A durable credential for a vendor who takes more than one order.
//
// The four order-level link keys (core/capability.js) are deliberately
// session-less: each is good for exactly one order. That is correct for a
// payer who orders once a month and a recipient who may never order again,
// but it leaves a vendor with nothing to bookmark except one link per sale.
//
// A merchant key fixes that WITHOUT becoming an account system. There is no
// signup form, no email, no password, no session cookie, and - this is the
// part that keeps it in the same family as everything else in this app - no
// server-side table of merchants to protect either. A merchant key is a
// self-certifying bearer credential: `yzm_<vendorId>.<hmac>`, where the HMAC
// is computed with a server-held secret. Anyone holding a valid key IS that
// vendorId, the same way anyone holding a `yzk_` link key IS that order's
// payer, recipient or vendor. Losing the secret invalidates every merchant
// key at once, which is the one thing that has to be guarded carefully - see
// main.js for how it is sourced.
//
// What this is NOT: a way to move money. vendorId is a label attached to an
// order for display and filtering, not a fund-routing address - every order
// still settles through the one Lightning node this deployment runs, and
// still requires the recipient's own secret to release. A merchant key only
// ever grants read access to a vendorId's own order history.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export class MerchantError extends Error {}

const PREFIX = "yzm_";
const ID_BYTES = 9; // 72 bits - not fund-bearing, so this is plenty

export const MERCHANT_ID = /^vnd_[A-Za-z0-9_-]{10,40}$/;
// yzm_<vendorId>.<43-char base64url sha256 HMAC>
export const MERCHANT_KEY = /^yzm_(vnd_[A-Za-z0-9_-]{10,40})\.([A-Za-z0-9_-]{43})$/;

function sign(vendorId, secret) {
  return createHmac("sha256", secret).update(vendorId).digest("base64url");
}

export function newMerchantId() {
  return `vnd_${randomBytes(ID_BYTES).toString("base64url")}`;
}

/** Mint a key that authenticates as vendorId, for as long as secret is unchanged. */
export function mintMerchantKey(vendorId, secret) {
  if (typeof vendorId !== "string" || !MERCHANT_ID.test(vendorId)) {
    throw new MerchantError("a valid vendorId is required");
  }
  if (!secret || secret.length < 16) {
    throw new MerchantError("a merchant secret of at least 16 bytes is required");
  }
  return `${PREFIX}${vendorId}.${sign(vendorId, secret)}`;
}

/**
 * The vendorId a presented key authenticates as, or null.
 *
 * Verification is constant-time over the MAC itself; there is nothing to
 * scan (no stored list of merchants), so there is no table whose size could
 * leak through timing the way a linear credential search would.
 */
export function merchantIdFor(presentedKey, secret) {
  if (typeof presentedKey !== "string") return null;
  const match = MERCHANT_KEY.exec(presentedKey);
  if (!match) return null;
  const [, vendorId, mac] = match;
  const expected = sign(vendorId, secret);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  return timingSafeEqual(a, b) ? vendorId : null;
}
