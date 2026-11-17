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
import {
  readJsonBody,
  requireString,
  requireUsdCents,
  requireOrderId,
  optionalEnum,
  RateLimiter,
  BadRequest,
  TooManyRequests,
} from "./guards.js";
import { orderView, receiptView, eventsView } from "./views.js";

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
  setInterval(() => {
    general.prune();
    releases.prune();
    creates.prune();
  }, 60_000).unref?.();

  // Each open stream costs two timers and a socket for as long as it lives,
  // so the number of them is bounded rather than left to the client.
  const MAX_STREAMS = Number(process.env.YAZO_MAX_STREAMS ?? 200);
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

  const routes = [
    {
      method: "GET",
      pattern: /^\/api\/health$/,
      handler: async (_req, res) => send(res, 200, { ok: true, service: "yazo" }),
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
        });
      },
    },

    {
      method: "GET",
      pattern: /^\/api\/orders\/([^/]+)$/,
      handler: async (req, res, [id]) => {
        const order = await service.store.get(requireOrderId(id));
        if (!order) return send(res, 404, { error: "unknown order" });
        send(res, 200, { order: orderView(order, { now: now() }) });
      },
    },

    {
      method: "GET",
      pattern: /^\/api\/orders\/([^/]+)\/events$/,
      handler: async (req, res, [id]) => {
        const orderId = requireOrderId(id);
        if (!(await service.store.get(orderId))) return send(res, 404, { error: "unknown order" });
        const events = service.store.events ? await service.store.events(orderId) : [];
        send(res, 200, { events: eventsView(events) });
      },
    },

    // The recipient presents their code.
    {
      method: "POST",
      pattern: /^\/api\/orders\/([^/]+)\/release$/,
      handler: async (req, res, [id]) => {
        const orderId = requireOrderId(id);
        releases.check(`${clientKey(req)}:${orderId}`);
        const body = await readJsonBody(req);
        const code = requireString(body, "code", { max: 128 });
        const { order, receipt } = await service.release(orderId, code);
        send(res, 200, { order: orderView(order, { now: now() }), receipt: receiptView(receipt) });
      },
    },

    {
      method: "POST",
      pattern: /^\/api\/orders\/([^/]+)\/cancel$/,
      handler: async (req, res, [id]) => {
        const orderId = requireOrderId(id);
        const order = await service.refund(orderId, "cancelled by payer");
        send(res, 200, { order: orderView(order, { now: now() }) });
      },
    },

    // Live updates. Server-sent events: one direction, no extra dependency,
    // and it degrades to polling in any client that cannot use it.
    {
      method: "GET",
      pattern: /^\/api\/orders\/([^/]+)\/stream$/,
      handler: async (req, res, [id]) => {
        const orderId = requireOrderId(id);
        const existing = await service.store.get(orderId);
        if (!existing) return send(res, 404, { error: "unknown order" });
        if (openStreams >= MAX_STREAMS) {
          return send(res, 503, { error: "too many open streams, retry shortly" }, { "Retry-After": "5" });
        }
        openStreams += 1;

        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
          ...SECURITY_HEADERS,
        });

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
    let pathname;
    try {
      pathname = new URL(req.url, "http://localhost").pathname;
    } catch {
      return send(res, 400, { error: "bad request" });
    }

    try {
      if (pathname.startsWith("/api/")) {
        general.check(clientKey(req));
        for (const route of routes) {
          const match = pathname.match(route.pattern);
          if (!match) continue;
          if (req.method !== route.method) return send(res, 405, { error: "method not allowed" });
          return await route.handler(req, res, match.slice(1));
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
