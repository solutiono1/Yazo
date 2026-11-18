// The HTTP surface. Zero dependencies: node:http, a router, and strict guards.
//
// Security posture, in one place so it can be reviewed in one place:
//   - every response carries a restrictive CSP and the usual hardening headers
//   - no third-party origins at all: no CDN, no fonts, no analytics
//   - release attempts are rate limited per client AND capped per order
//   - responses are built from allow-lists, never by deleting fields
//   - errors never echo internals; unexpected ones become a plain 500
//   - the release secret is returned exactly once, at creation
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { EscrowError, STATE } from "../core/escrow.js";
import { QuoteError } from "../core/money.js";
import { SecretError, MODE_QR, MODE_TYPED } from "../core/secret.js";
import { CAP, can } from "../core/capability.js";
import {
  readJsonBody,
  readLinkKey,
  readBearerHeader,
  requireString,
  requireUsdCents,
  requireOrderId,
  optionalEnum,
  RateLimiter,
  BadRequest,
  Unauthorized,
  Forbidden,
  NotFound,
  TooManyRequests,
} from "./guards.js";
import { orderView, receiptView, eventsView, linksView } from "./views.js";

const SECURITY_HEADERS = {
  // Everything is served from this origin. No CDN, no inline script, no eval.
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; " +
    "base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=(), payment=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

export function createServer({ service, publicDir = "public", now = () => Date.now() }) {
  // Two limiters: a broad one for everything, and a tight one for the endpoint
  // that guesses at money.
  const general = new RateLimiter({ limit: 120, windowMs: 60_000, now });
  const releases = new RateLimiter({ limit: 10, windowMs: 60_000, now });
  const creates = new RateLimiter({ limit: 20, windowMs: 60_000, now });
  const merchants = new RateLimiter({ limit: 10, windowMs: 60_000, now });
  setInterval(() => {
    general.prune();
    releases.prune();
    creates.prune();
    merchants.prune();
  }, 60_000).unref?.();

  // Each open stream costs two timers and a socket for as long as it lives,
  // so the number of them is bounded rather than left to the client.
  // A bad value must not silently switch the cap off: Number("lots") is NaN,
  // and `openStreams >= NaN` is false for every value, so the limit would
  // disappear without a word. Fall back to the default instead.
  const configuredStreams = Number.parseInt(process.env.YAZO_MAX_STREAMS ?? "", 10);
  const MAX_STREAMS = Number.isSafeInteger(configuredStreams) && configuredStreams > 0 ? configuredStreams : 200;
  let openStreams = 0;

  const clientKey = (req) =>
    // No proxy is trusted by default: a forwarded header is only honoured when
    // the operator opts in, otherwise a client could spoof its way around the
    // limiter by inventing addresses.
    (process.env.TRUST_PROXY === "1" ? req.headers["x-forwarded-for"]?.split(",")[0]?.trim() : null) ||
    req.socket.remoteAddress ||
    "unknown";

  const send = (res, status, payload, extraHeaders = {}) => {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
      ...SECURITY_HEADERS,
      ...extraHeaders,
    });
    res.end(body);
  };

  const fail = (res, error) => {
    // Known, safe-to-surface errors keep their message. Anything else is a bug
    // or an attack and gets nothing useful back.
    if (error instanceof TooManyRequests) {
      return send(res, 429, { error: error.message }, { "Retry-After": String(error.retryAfterSeconds) });
    }
    if (error instanceof BadRequest) return send(res, 400, { error: error.message, field: error.field });
    if (error instanceof Unauthorized) {
      return send(res, 401, { error: error.message }, { "WWW-Authenticate": 'Bearer realm="yazo"' });
    }
    if (error instanceof Forbidden) return send(res, 403, { error: error.message });
    if (error instanceof NotFound) return send(res, 404, { error: error.message });
    if (error instanceof QuoteError || error instanceof SecretError) {
      return send(res, 400, { error: error.message });
    }
    if (error instanceof EscrowError) {
      const notFound = /unknown order/i.test(error.message);
      return send(res, notFound ? 404 : 409, { error: error.message });
    }
    console.error("[yazo] unhandled:", error);
    return send(res, 500, { error: "something went wrong" });
  };

  async function serveStatic(req, res, pathname) {
    const wanted = pathname === "/" ? "/index.html" : pathname;
    // Resolve inside publicDir and refuse anything that escapes it.
    const resolved = normalize(join(publicDir, wanted));
    if (!resolved.startsWith(normalize(publicDir) + sep) && resolved !== normalize(join(publicDir, "index.html"))) {
      return send(res, 403, { error: "forbidden" });
    }
    try {
      const body = await readFile(resolved);
      res.writeHead(200, {
        "Content-Type": MIME[extname(resolved)] ?? "application/octet-stream",
        "Content-Length": body.length,
        "Cache-Control": "no-store",
        ...SECURITY_HEADERS,
      });
      res.end(body);
    } catch {
      send(res, 404, { error: "not found" });
    }
  }

  /**
   * The single gate every per-order route passes through.
   *
   * An order id on its own buys nothing: it names an order, it does not
   * authorise anything. Authority is the link key, and each key carries only
   * its role's capabilities - which is why a vendor cannot cancel the order he
   * has already handed goods for, and the payer cannot release one he has not.
   */
  const authorise = async (req, url, rawId, capability) => {
    const orderId = requireOrderId(rawId);
    const presented = readLinkKey(req, url);
    if (!presented) throw new Unauthorized();

    const granted = await service.authorise(orderId, presented.key);
    // Unknown order and wrong key are the same answer on purpose: otherwise
    // this route reports which order ids exist.
    if (!granted) throw new NotFound();

    // A key in the query string is a key in somebody's logs. It reads, it
    // never moves money, whatever role it belongs to.
    if (presented.channel === "query" && capability !== CAP.VIEW) {
      throw new Forbidden("send the link key as an Authorization header to do that");
    }
    if (!can(granted.role, capability)) {
      throw new Forbidden(`a ${granted.role} link cannot ${capability} this order`);
    }
    return { ...granted, orderId };
  };

  const routes = [
    {
      method: "GET",
      pattern: /^\/api\/health$/,
      handler: async (_req, res) => send(res, 200, { ok: true, service: "yazo" }),
    },

    // A merchant key: a durable credential over one vendorId's order
    // history. No signup, no email, no stored record of this call - the key
    // is self-certifying. Returned exactly once, like the release secret.
    {
      method: "POST",
      pattern: /^\/api\/merchants$/,
      handler: async (req, res) => {
        merchants.check(clientKey(req));
        const minted = service.mintMerchantKey();
        send(res, 201, {
          vendorId: minted.vendorId,
          merchantKey: minted.merchantKey,
          merchantKeyNotice: "This is shown exactly once. Losing it means starting over with a new vendorId.",
        });
      },
    },

    // The vendor's own dashboard feed. Header only - no ?k= fallback - since
    // this lists every order a vendor has ever taken, not one.
    {
      method: "GET",
      pattern: /^\/api\/merchants\/orders$/,
      handler: async (req, res) => {
        merchants.check(clientKey(req));
        const key = readBearerHeader(req);
        if (!key) throw new Unauthorized("a merchant key is required");
        const vendorId = service.authoriseMerchant(key);
        if (!vendorId) throw new Unauthorized("that merchant key is not valid");
        const orders = await service.ordersForVendor(vendorId);
        send(res, 200, { vendorId, orders: orders.map((o) => orderView(o, { now: now() })) });
      },
    },

    // Create an order. The release secret is in this response and nowhere else,
    // ever again.
    {
      method: "POST",
      pattern: /^\/api\/orders$/,
      handler: async (req, res) => {
        creates.check(clientKey(req));
        const body = await readJsonBody(req);
        const created = await service.createOrder({
          vendorId: requireString(body, "vendorId", { max: 64 }),
          payerId: requireString(body, "payerId", { max: 64 }),
          recipientLabel: requireString(body, "recipientLabel", { max: 40 }),
          usdCents: requireUsdCents(body),
          mode: optionalEnum(body, "mode", [MODE_QR, MODE_TYPED], MODE_QR),
          memo: body.memo === undefined ? undefined : requireString(body, "memo", { max: 200 }),
        });
        send(res, 201, {
          order: orderView(created.order, { now: now() }),
          paymentRequest: created.paymentRequest,
          secret: created.secret,
          secretNotice: "Give this to the recipient now. It is not stored and cannot be recovered.",
          links: linksView(created.links),
          linksNotice:
            "One key per role, each carrying only that role's powers. Shown once, never stored.",
        });
      },
    },

    {
      method: "GET",
      pattern: /^\/api\/orders\/([^/]+)$/,
      handler: async (req, res, [id], url) => {
        const { order, role } = await authorise(req, url, id, CAP.VIEW);
        send(res, 200, { order: orderView(order, { now: now() }), as: role });
      },
    },

    {
      method: "GET",
      pattern: /^\/api\/orders\/([^/]+)\/events$/,
      handler: async (req, res, [id], url) => {
        const { orderId } = await authorise(req, url, id, CAP.VIEW);
        const events = service.store.events ? await service.store.events(orderId) : [];
        send(res, 200, { events: eventsView(events) });
      },
    },

    // Proof that the money moved, safe to forward to anybody: the preimage and
    // the hash it commits to, and nothing that could release another order.
    {
      method: "GET",
      pattern: /^\/api\/orders\/([^/]+)\/receipt$/,
      handler: async (req, res, [id], url) => {
        const { orderId } = await authorise(req, url, id, CAP.VIEW);
        send(res, 200, { receipt: receiptView(await service.receiptFor(orderId)) });
      },
    },

    // The code is presented at the counter - by the vendor scanning it, or by
    // the recipient's own phone. The payer's link cannot do this.
    {
      method: "POST",
      pattern: /^\/api\/orders\/([^/]+)\/release$/,
      handler: async (req, res, [id], url) => {
        const orderId = requireOrderId(id);
        // Rate limit before authorising, so a flood of guesses at the key
        // itself is throttled on the same budget as guesses at the code.
        releases.check(`${clientKey(req)}:${orderId}`);
        await authorise(req, url, id, CAP.RELEASE);
        const body = await readJsonBody(req);
        const code = requireString(body, "code", { max: 128 });
        const { order, receipt } = await service.release(orderId, code);
        send(res, 200, { order: orderView(order, { now: now() }), receipt: receiptView(receipt) });
      },
    },

    // Only the payer may take their money back, and only before release.
    {
      method: "POST",
      pattern: /^\/api\/orders\/([^/]+)\/cancel$/,
      handler: async (req, res, [id], url) => {
        const { orderId, role } = await authorise(req, url, id, CAP.CANCEL);
        const order = await service.refund(orderId, `cancelled by ${role}`);
        send(res, 200, { order: orderView(order, { now: now() }) });
      },
    },

    // Live updates. Server-sent events: one direction, no extra dependency,
    // and it degrades to polling in any client that cannot use it.
    {
      method: "GET",
      pattern: /^\/api\/orders\/([^/]+)\/stream$/,
      handler: async (req, res, [id], url) => {
        // EventSource cannot set headers, so this is the one route commonly
        // reached with ?k=. It is view-only, which is exactly what the weaker
        // channel is allowed to carry.
        const { order: existing, orderId } = await authorise(req, url, id, CAP.VIEW);
        if (openStreams >= MAX_STREAMS) {
          return send(res, 503, { error: "too many open streams, retry shortly" }, { "Retry-After": "5" });
        }

        // Claim the slot only once the response is actually open. Counting it
        // before writeHead means a throw there leaks the slot for the lifetime
        // of the process.
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
          ...SECURITY_HEADERS,
        });
        openStreams += 1;

        let lastState = null;
        const push = (order) => {
          if (order.state === lastState) return;
          lastState = order.state;
          res.write(`event: order\ndata: ${JSON.stringify(orderView(order, { now: now() }))}\n\n`);
        };
        push(existing);

        const poll = setInterval(async () => {
          try {
            const current = await service.store.get(orderId);
            if (!current) return;
            push(current);
            if ([STATE.RELEASED, STATE.REFUNDED, STATE.VOID].includes(current.state)) {
              cleanup();
              res.end();
            }
          } catch {
            /* keep the stream alive; the next tick may succeed */
          }
        }, 1000);
        const beat = setInterval(() => res.write(": keep-alive\n\n"), 20_000);

        let closed = false;
        const cleanup = () => {
          if (closed) return;
          closed = true;
          openStreams -= 1;
          clearInterval(poll);
          clearInterval(beat);
        };
        req.on("close", cleanup);
        res.on("close", cleanup);
      },
    },
  ];

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      return send(res, 400, { error: "bad request" });
    }
    const pathname = url.pathname;

    try {
      if (pathname.startsWith("/api/")) {
        general.check(clientKey(req));
        for (const route of routes) {
          const match = pathname.match(route.pattern);
          if (!match) continue;
          if (req.method !== route.method) return send(res, 405, { error: "method not allowed" });
          return await route.handler(req, res, match.slice(1), url);
        }
        return send(res, 404, { error: "not found" });
      }
      if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
      return await serveStatic(req, res, pathname);
    } catch (error) {
      return fail(res, error);
    }
  });

  server.streamCount = () => openStreams;
  server.limiters = { general, releases, creates };
  return server;
}
