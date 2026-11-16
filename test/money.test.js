import test from "node:test";
import assert from "node:assert/strict";

import { quote, quoteIsFresh, formatUsd, QuoteError, QUOTE_TTL_MS } from "../src/core/money.js";

const BTC = 95_000n;
const T0 = 1_700_000_000_000;

test("quote converts dollars to sats and rounds up, never under-funding", () => {
  const q = quote(4_000n, BTC, T0);
  // $40 / $95,000 * 1e8 = 42105.26... -> rounds up
  assert.equal(q.sats, 42_106n);
  assert.equal(formatUsd(q.usdCents), "$40.00");
});

test("quote rejects dust, oversized orders and absurd prices", () => {
  assert.throws(() => quote(99n, BTC, T0), QuoteError);
  assert.throws(() => quote(200_001n, BTC, T0), QuoteError);
  assert.throws(() => quote(4_000n, 1n, T0), QuoteError); // broken oracle
  assert.throws(() => quote(4_000n, 99_000_000n, T0), QuoteError);
  assert.throws(() => quote(4000, BTC, T0), QuoteError); // float/number guard
});

test("a quote goes stale so a payer is never held to an old rate", () => {
  const q = quote(4_000n, BTC, T0);
  assert.ok(quoteIsFresh(q, T0));
  assert.ok(quoteIsFresh(q, T0 + QUOTE_TTL_MS - 1));
  assert.ok(!quoteIsFresh(q, T0 + QUOTE_TTL_MS));
});

test("formatUsd pads cents correctly", () => {
  assert.equal(formatUsd(5n), "$0.05");
  assert.equal(formatUsd(100_000n), "$1000.00");
  assert.equal(formatUsd(-250n), "-$2.50");
});

test("a quote is immutable once issued", () => {
  const q = quote(4_000n, BTC, T0);
  assert.throws(() => {
    "use strict";
    q.sats = 1n;
  }, TypeError);
});
