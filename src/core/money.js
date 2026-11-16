// Money handling. Two rules, enforced everywhere:
//  1. USD is integer cents. Never a float.
//  2. A dollar amount is only meaningful alongside the quote that produced its sats.
const SATS_PER_BTC = 100_000_000n;

export const MIN_ORDER_CENTS = 100n; // $1
export const MAX_ORDER_CENTS = 200_000n; // $2,000 - keeps any single hold small
export const QUOTE_TTL_MS = 60_000; // a quote the payer can rely on for 60s

// Sanity bounds on the BTC/USD price. A bad oracle must fail loudly rather than
// quietly mint a 100x order. Widen these deliberately, never silently.
const MIN_BTC_USD = 1_000n;
const MAX_BTC_USD = 10_000_000n;

export class QuoteError extends Error {}

/**
 * Convert a USD amount into sats at a given BTC price.
 * @param {bigint} usdCents
 * @param {bigint} btcUsd whole dollars per BTC
 * @param {number} now ms since epoch
 */
export function quote(usdCents, btcUsd, now) {
  if (typeof usdCents !== "bigint" || typeof btcUsd !== "bigint") {
    throw new QuoteError("usdCents and btcUsd must be bigint");
  }
  if (usdCents < MIN_ORDER_CENTS) throw new QuoteError("below minimum order");
  if (usdCents > MAX_ORDER_CENTS) throw new QuoteError("above maximum order");
  if (btcUsd < MIN_BTC_USD || btcUsd > MAX_BTC_USD) {
    throw new QuoteError("btcUsd outside sanity bounds: " + btcUsd);
  }
  // sats = cents / 100 / btcUsd * 1e8  ->  cents * 1e8 / (100 * btcUsd)
  // Round up, so integer truncation can never under-fund the vendor.
  const numerator = usdCents * SATS_PER_BTC;
  const denominator = 100n * btcUsd;
  const sats = (numerator + denominator - 1n) / denominator;
  if (sats <= 0n) throw new QuoteError("quote rounded to zero sats");
  return Object.freeze({
    usdCents,
    btcUsd,
    sats,
    createdAt: now,
    expiresAt: now + QUOTE_TTL_MS,
  });
}

export function quoteIsFresh(q, now) {
  return now >= q.createdAt && now < q.expiresAt;
}

export function formatUsd(usdCents) {
  const negative = usdCents < 0n;
  const abs = negative ? -usdCents : usdCents;
  const whole = abs / 100n;
  const cents = String(abs % 100n).padStart(2, "0");
  return (negative ? "-$" : "$") + whole + "." + cents;
}
