// The release secret: the heart of the escrow guarantee.
//
// A Lightning hold invoice can only be settled by whoever can produce the
// preimage. We therefore DERIVE the preimage from a secret that only the
// recipient holds, and we never store that secret or the preimage.
//
//   preimage     = sha256(DOMAIN || salt || secret)
//   paymentHash  = sha256(preimage)
//
// The server persists only { salt, paymentHash }. From those, the preimage is
// not recoverable. So the money cannot be released by the vendor, by us, or by
// anyone who steals the whole database - only by someone holding the secret
// that was handed to the recipient. Non-delivery leaves exactly one outcome:
// the hold expires and the payer is refunded.
//
// THREAT MODEL, stated honestly - the two modes are not equally strong:
//
//   QR mode (default, 128-bit secret)
//     Brute force is infeasible. The guarantee holds even against us.
//
//   TYPED mode (8+ characters, for feature phones and reading aloud)
//     A short secret is low-entropy. Anyone holding { salt, paymentHash } can
//     brute force it offline. So TYPED mode protects the payer against the
//     VENDOR (who never sees salt and hash together), but it does NOT protect
//     against a malicious or breached platform. We say so plainly rather than
//     implying a guarantee we cannot keep, we default to QR, and the escrow
//     machine caps how many release attempts an order will ever accept.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const DOMAIN = Buffer.from("yazo/release-secret/v1");

export const MODE_QR = "qr";
export const MODE_TYPED = "typed";

// Unambiguous alphabet: no 0/O, no 1/I/L, so a code read aloud survives.
const TYPED_ALPHABET = "23456789ACDEFGHJKMNPQRTUVWXYZ";
const MIN_TYPED_LENGTH = 6;

export class SecretError extends Error {}

const sha256 = (...parts) => createHash("sha256").update(Buffer.concat(parts)).digest();

export function newSalt() {
  return randomBytes(16);
}

/** A 128-bit secret, carried in a QR code. Infeasible to guess. */
export function generateQrSecret() {
  return randomBytes(16).toString("base64url");
}

/** A short human-typable secret. Weaker by construction - see threat model. */
export function generateTypedSecret(length = 8) {
  if (length < MIN_TYPED_LENGTH) {
    throw new SecretError("typed secret must be at least " + MIN_TYPED_LENGTH + " characters");
  }
  // Rejection sampling, so every character is uniform over the alphabet.
  const out = [];
  const limit = 256 - (256 % TYPED_ALPHABET.length);
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (out.length === length) break;
      if (byte < limit) out.push(TYPED_ALPHABET[byte % TYPED_ALPHABET.length]);
    }
  }
  return out.join("");
}

export function generateSecret(mode = MODE_QR) {
  if (mode === MODE_QR) return generateQrSecret();
  if (mode === MODE_TYPED) return generateTypedSecret();
  throw new SecretError("unknown secret mode: " + mode);
}

/** Normalise user input: typed secrets are case- and space-insensitive. */
export function normaliseSecret(secret, mode) {
  if (typeof secret !== "string") throw new SecretError("secret must be a string");
  if (mode === MODE_TYPED) return secret.replace(/[\s-]/g, "").toUpperCase();
  return secret.trim();
}

export function derivePreimage(secret, salt, mode = MODE_QR) {
  if (!Buffer.isBuffer(salt) || salt.length < 16) {
    throw new SecretError("salt must be at least 16 bytes");
  }
  const normalised = normaliseSecret(secret, mode);
  if (normalised.length === 0) throw new SecretError("secret must not be empty");
  return sha256(DOMAIN, salt, Buffer.from(normalised, "utf8"));
}

export function paymentHashFor(preimage) {
  if (!Buffer.isBuffer(preimage) || preimage.length !== 32) {
    throw new SecretError("preimage must be 32 bytes");
  }
  return sha256(preimage);
}

/**
 * Build the pair stored against an order at creation time. The caller is
 * responsible for handing `secret` to the recipient and then forgetting it.
 */
export function newReleaseSecret(mode = MODE_QR) {
  const secret = generateSecret(mode);
  const salt = newSalt();
  const preimage = derivePreimage(secret, salt, mode);
  return {
    secret, // -> recipient only. NEVER persisted.
    mode,
    salt, // -> stored
    paymentHash: paymentHashFor(preimage), // -> stored, used to create the invoice
  };
}

/**
 * Verify a presented secret and recover the preimage that settles the invoice.
 * Returns the 32-byte preimage, or null if the secret is wrong. Comparison is
 * constant-time so a caller cannot learn the hash byte by byte.
 */
export function recoverPreimage(secret, salt, expectedPaymentHash, mode = MODE_QR) {
  if (!Buffer.isBuffer(expectedPaymentHash) || expectedPaymentHash.length !== 32) {
    throw new SecretError("expectedPaymentHash must be 32 bytes");
  }
  let preimage;
  try {
    preimage = derivePreimage(secret, salt, mode);
  } catch {
    return null; // malformed input is simply a wrong secret
  }
  const candidate = paymentHashFor(preimage);
  return timingSafeEqual(candidate, expectedPaymentHash) ? preimage : null;
}
