import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  newReleaseSecret,
  recoverPreimage,
  derivePreimage,
  paymentHashFor,
  generateTypedSecret,
  generateQrSecret,
  normaliseSecret,
  MODE_QR,
  MODE_TYPED,
  SecretError,
} from "../src/core/secret.js";

test("payment hash commits to a preimage derived from the secret", () => {
  const { secret, salt, paymentHash, mode } = newReleaseSecret(MODE_QR);
  const preimage = derivePreimage(secret, salt, mode);
  assert.equal(preimage.length, 32);
  assert.deepEqual(paymentHashFor(preimage), paymentHash);
  // and that really is plain sha256, so any Lightning node agrees
  assert.deepEqual(createHash("sha256").update(preimage).digest(), paymentHash);
});

test("the correct secret recovers the preimage; a wrong one yields null", () => {
  const { secret, salt, paymentHash, mode } = newReleaseSecret(MODE_QR);
  assert.ok(recoverPreimage(secret, salt, paymentHash, mode));
  assert.equal(recoverPreimage("not-the-secret", salt, paymentHash, mode), null);
});

test("derivation is deterministic", () => {
  const { secret, salt, mode } = newReleaseSecret(MODE_QR);
  assert.deepEqual(derivePreimage(secret, salt, mode), derivePreimage(secret, salt, mode));
});

test("a QR secret carries 128 bits of randomness and never repeats", () => {
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) seen.add(generateQrSecret());
  assert.equal(seen.size, 500);
  assert.equal(Buffer.from(generateQrSecret(), "base64url").length, 16);
});

test("typed secrets tolerate case and spacing as read aloud", () => {
  const secret = generateTypedSecret(8);
  const salt = Buffer.alloc(16, 7);
  const hash = paymentHashFor(derivePreimage(secret, salt, MODE_TYPED));
  assert.ok(recoverPreimage(secret.toLowerCase(), salt, hash, MODE_TYPED));
  assert.ok(recoverPreimage(secret.slice(0, 4) + " " + secret.slice(4), salt, hash, MODE_TYPED));
  assert.ok(recoverPreimage(secret.slice(0, 4) + "-" + secret.slice(4), salt, hash, MODE_TYPED));
});

test("QR secrets are NOT case-folded, so entropy is preserved", () => {
  const secret = "AbCdEf";
  assert.equal(normaliseSecret(secret, MODE_QR), "AbCdEf");
  assert.equal(normaliseSecret("  AbCdEf  ", MODE_QR), "AbCdEf");
});

test("typed secrets avoid characters people mishear or misread", () => {
  for (let i = 0; i < 50; i += 1) {
    assert.match(generateTypedSecret(10), /^[23456789ACDEFGHJKMNPQRTUVWXYZ]{10}$/);
  }
  assert.throws(() => generateTypedSecret(4), SecretError); // too short to be meaningful
});

test("a short or missing salt is refused", () => {
  assert.throws(() => derivePreimage("abc", Buffer.alloc(8), MODE_QR), SecretError);
  assert.throws(() => derivePreimage("abc", "not-a-buffer", MODE_QR), SecretError);
});

test("an empty secret is refused rather than hashed", () => {
  const salt = Buffer.alloc(16, 1);
  assert.throws(() => derivePreimage("", salt, MODE_QR), SecretError);
  assert.throws(() => derivePreimage("   ", salt, MODE_QR), SecretError);
});

test("a malformed payment hash is a programming error, not a wrong guess", () => {
  const salt = Buffer.alloc(16, 1);
  assert.throws(() => recoverPreimage("x", salt, Buffer.alloc(31), MODE_QR), SecretError);
});
