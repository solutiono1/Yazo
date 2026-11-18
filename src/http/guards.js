// Input validation and rate limiting.
//
// Everything arriving over HTTP is hostile until proven otherwise. These
// helpers are deliberately strict and deliberately boring: they reject rather
// than coerce, because a quietly coerced value is how a $40 order becomes a
// $4,000 one.
export class BadRequest extends Error {
  constructor(message, field) {
    super(message);
    this.status = 400;
    this.field = field;
  }
}

/** No link key was presented at all. */
export class Unauthorized extends Error {
  constructor(message = "a link key is required") {
    super(message);
    this.status = 401;
  }
}

/** A real link key, but not one that carries this capability. */
export class Forbidden extends Error {
  constructor(message = "this link does not allow that") {
    super(message);
    this.status = 403;
  }
}

/**
 * The order does not exist, OR the key does not match it.
 *
 * Deliberately the same answer for both. Distinguishing them would turn every
 * endpoint into an oracle for which order ids are real.
 */
export class NotFound extends Error {
  constructor(message = "unknown order") {
    super(message);
    this.status = 404;
  }
}

export class TooManyRequests extends Error {
  constructor(retryAfterSeconds) {
    super("too many requests");
    this.status = 429;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const MAX_BODY_BYTES = 16 * 1024; // nothing we accept is remotely this big

/** Read a JSON body with a hard size cap, so a huge upload cannot exhaust us. */
export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BadRequest("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          return reject(new BadRequest("body must be a JSON object"));
        }
        resolve(parsed);
      } catch {
        reject(new BadRequest("body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function requireString(body, field, { min = 1, max = 120, pattern } = {}) {
  const value = body[field];
  if (typeof value !== "string") throw new BadRequest(`${field} must be a string`, field);
  const trimmed = value.trim();
  if (trimmed.length < min) throw new BadRequest(`${field} is required`, field);
  if (trimmed.length > max) throw new BadRequest(`${field} must be at most ${max} characters`, field);
  if (pattern && !pattern.test(trimmed)) throw new BadRequest(`${field} has an invalid format`, field);
  return trimmed;
}

/**
 * Money arrives as a string of digits and becomes a bigint. Accepting a JSON
 * number here would silently lose precision above 2^53 and allow "4e3" or
 * "40.00000000001" to mean something unintended.
 */
export function requireUsdCents(body, field = "usdCents") {
  const value = body[field];
  if (typeof value !== "string" || !/^[0-9]{1,9}$/.test(value)) {
    throw new BadRequest(`${field} must be a string of digits, in whole cents`, field);
  }
  return BigInt(value);
}

export function optionalEnum(body, field, allowed, fallback) {
  const value = body[field];
  if (value === undefined || value === null) return fallback;
  if (!allowed.includes(value)) {
    throw new BadRequest(`${field} must be one of: ${allowed.join(", ")}`, field);
  }
  return value;
}

/**
 * Pull the link key off a request.
 *
 * Two channels, deliberately not equal:
 *
 *   Authorization: Bearer <key>   the real one. The UI keeps the key in the
 *                                 URL fragment, which browsers never send to
 *                                 a server, and attaches it per request.
 *   ?k=<key>                      a convenience for curl, EventSource and
 *                                 anything that cannot set a header. Query
 *                                 strings land in logs, history and Referer
 *                                 headers, so the router refuses to let this
 *                                 channel carry anything but `view`.
 */
export function readLinkKey(req, url) {
  const header = req.headers.authorization;
  if (typeof header === "string") {
    const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
    if (match) return { key: match[1], channel: "header" };
  }
  const fromQuery = url?.searchParams?.get("k");
  if (typeof fromQuery === "string" && fromQuery.length > 0) {
    return { key: fromQuery, channel: "query" };
  }
  return null;
}

/**
 * A bearer token from the Authorization header only - no query-string
 * fallback. Used for merchant keys: listing a vendor's whole order history
 * is a bigger blast radius than viewing one order, so the weaker channel
 * (query strings end up in proxy logs and Referer headers) is not offered
 * for it at all.
 */
export function readBearerHeader(req) {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

/** Order ids are issued by us; reject anything that is not our shape. */
export const ORDER_ID = /^ord_[A-Za-z0-9_-]{10,64}$/;

export function requireOrderId(value) {
  if (typeof value !== "string" || !ORDER_ID.test(value)) {
    throw new BadRequest("invalid order id", "orderId");
  }
  return value;
}

/**
 * A fixed-window limiter, keyed however the caller likes.
 *
 * Release attempts are limited twice over: the escrow machine caps wrong codes
 * per order at five for all time, and this caps attempts per minute per client
 * so nobody can burn an order allowance in one burst, nor sweep many orders.
 */
export class RateLimiter {
  constructor({ limit, windowMs, now = () => Date.now() }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.hits = new Map();
  }

  check(key) {
    const now = this.now();
    const entry = this.hits.get(key);
    if (!entry || now >= entry.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return;
    }
    entry.count += 1;
    if (entry.count > this.limit) {
      throw new TooManyRequests(Math.ceil((entry.resetAt - now) / 1000));
    }
  }

  /** Drop expired buckets so a long-running process does not grow forever. */
  prune() {
    const now = this.now();
    for (const [key, entry] of this.hits) if (now >= entry.resetAt) this.hits.delete(key);
    return this.hits.size;
  }
}
