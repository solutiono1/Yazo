// Who is allowed to do what to an order.
//
// THE BUG THIS EXISTS TO FIX. The order id used to be the only thing standing
// between a request and an order, and every endpoint accepted it. One link,
// handed to four people, carried every power the order had. The worst case was
// not theft, it was griefing the one party with no protection at all: the
// vendor hands over the rice, and before the recipient's code is presented,
// anyone who ever saw the link - a forwarded WhatsApp message, a screenshot in
// a group chat, the payer having second thoughts - can POST /cancel and take
// the money back. Goods gone, payment gone, no recourse.
//
// So the id is now an identifier and nothing more. Authority comes from a
// separate link key, one per role, and each key carries only the capabilities
// its holder actually needs:
//
//   payer      view, cancel     - may change their mind, may not release
//   recipient  view, release    - holds the code; cannot claw the money back
//   vendor     view, release    - scans the code at the counter
//   proof      view             - a receipt safe to forward to anyone
//
// WHAT IS STORED. Only sha256 of each key, never the key itself. A thief who
// takes the whole database gets four hashes per order and can mint nothing -
// the same stance the release secret already takes. The keys exist exactly
// once, in the response that creates the order.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export class CapabilityError extends Error {}

export const ROLE = Object.freeze({
  PAYER: "payer",
  RECIPIENT: "recipient",
  VENDOR: "vendor",
  PROOF: "proof",
});

export const CAP = Object.freeze({
  VIEW: "view",
  RELEASE: "release",
  CANCEL: "cancel",
});

// The whole authorisation policy, in one readable object. Anything not listed
// here is denied: `can()` never falls through to a default of yes.
const GRANTS = Object.freeze({
  [ROLE.PAYER]: Object.freeze([CAP.VIEW, CAP.CANCEL]),
  [ROLE.RECIPIENT]: Object.freeze([CAP.VIEW, CAP.RELEASE]),
  [ROLE.VENDOR]: Object.freeze([CAP.VIEW, CAP.RELEASE]),
  [ROLE.PROOF]: Object.freeze([CAP.VIEW]),
});

export const ROLES = Object.freeze(Object.keys(GRANTS));

// 128 bits. These are bearer credentials handed out in links, so they are
// sized to be unguessable rather than typed by a human - unlike the release
// secret, which has a typed mode precisely because a person reads it aloud.
const KEY_BYTES = 16;
const DOMAIN = Buffer.from("yazo/link-key/v1");

/** The shape we issue. Checked before any comparison, to reject junk early. */
export const LINK_KEY = /^yzk_[A-Za-z0-9_-]{22}$/;

/** sha256 over a domain tag, so a link key can never collide with a preimage. */
export function keyDigest(key) {
  return createHash("sha256").update(DOMAIN).update(Buffer.from(key, "utf8")).digest();
}

export function newLinkKey() {
  return `yzk_${randomBytes(KEY_BYTES).toString("base64url")}`;
}

/**
 * Mint one key per role.
 *
 * Returns the keys (to be handed out once and forgotten) and the digests (the
 * only part that is ever persisted).
 */
export function newGrantSet() {
  const keys = {};
  const digests = {};
  for (const role of ROLES) {
    const key = newLinkKey();
    keys[role] = key;
    digests[role] = keyDigest(key);
  }
  return { keys: Object.freeze(keys), digests: Object.freeze(digests) };
}

/** Reject a malformed or incomplete grant set rather than store half of one. */
export function assertGrants(grants) {
  if (!grants || typeof grants !== "object") throw new CapabilityError("grants are required");
  for (const role of ROLES) {
    const d = grants[role];
    if (!Buffer.isBuffer(d) || d.length !== 32) {
      throw new CapabilityError(`grants.${role} must be a 32-byte digest`);
    }
  }
  return grants;
}

/**
 * Which role a presented key belongs to, or null.
 *
 * Every role is compared on every call and the loop never returns early, so
 * the work done is the same whether the key matches the first role, the last
 * role, or none - the timing cannot be read as a hint about which link someone
 * holds. Comparison itself is constant-time.
 */
export function roleFor(grants, key) {
  if (typeof key !== "string" || !LINK_KEY.test(key)) return null;
  const presented = keyDigest(key);
  let found = null;
  for (const role of ROLES) {
    const stored = grants?.[role];
    if (!Buffer.isBuffer(stored) || stored.length !== presented.length) continue;
    if (timingSafeEqual(stored, presented)) found = role;
  }
  return found;
}

/** Deny by default: an unknown role or an unknown capability is always false. */
export function can(role, capability) {
  const allowed = GRANTS[role];
  return Array.isArray(allowed) && allowed.includes(capability);
}

export function capabilitiesOf(role) {
  return [...(GRANTS[role] ?? [])];
}
