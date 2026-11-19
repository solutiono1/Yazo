// The outbound webhook sender.
//
// Same shape as the watcher, and for the same reason: a promise that only
// holds while somebody is watching the screen is not a promise. A delivery is
// enqueued inside the transaction that changed the order, and this drains that
// queue until the receiver acknowledges or we give up loudly.
//
// What it deliberately does NOT do:
//   - follow redirects. A 302 to 169.254.169.254 would walk straight past the
//     address checks that ran before the request.
//   - retry forever. A permanently broken endpoint becomes a dead letter with
//     its last error kept, not an infinite tail of requests.
//   - send anything the API would not. The body comes from the same projection
//     the HTTP layer serves.
import { signBody, SIGNATURE_HEADER } from "./sign.js";
import { parseTarget, resolveTarget, WebhookTargetError } from "./target.js";

/** Backoff between attempts. Roughly 10s, 1m, 5m, 25m, 2h. */
const BACKOFF_MS = [10_000, 60_000, 300_000, 1_500_000, 7_200_000];
export const MAX_ATTEMPTS = BACKOFF_MS.length + 1;

export function backoffFor(attempts) {
  return BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)];
}

export class WebhookSender {
  /**
   * @param {object} opts
   * @param {object} opts.store
   * @param {number} [opts.intervalMs]
   * @param {number} [opts.timeoutMs] how long a receiver has to answer
   * @param {boolean} [opts.allowInsecure] http:// targets (local development)
   * @param {boolean} [opts.allowPrivate] private addresses (tests only)
   * @param {typeof fetch} [opts.fetchImpl]
   * @param {() => number} [opts.now]
   */
  constructor({
    store,
    intervalMs = 5_000,
    timeoutMs = 8_000,
    allowInsecure = false,
    allowPrivate = false,
    fetchImpl = globalThis.fetch,
    resolver = undefined,
    now = () => Date.now(),
    onTick = () => {},
  }) {
    this.store = store;
    this.resolver = resolver;
    this.intervalMs = intervalMs;
    this.timeoutMs = timeoutMs;
    this.allowInsecure = allowInsecure;
    this.allowPrivate = allowPrivate;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.onTick = onTick;
    this.timer = null;
    this.running = false;
    this.stats = { sweeps: 0, delivered: 0, failed: 0, dead: 0 };
  }

  /** One pass. Exposed so tests can drive it without waiting on a clock. */
  async sweep() {
    if (this.running) return this.stats;
    this.running = true;
    try {
      const now = this.now();
      const due = await this.store.dueWebhooks(now);
      for (const delivery of due) {
        await this.#attempt(delivery);
      }
      this.stats.sweeps += 1;
      this.onTick({ due: due.length, ...this.stats });
    } finally {
      this.running = false;
    }
    return this.stats;
  }

  async #attempt(delivery) {
    const attempts = delivery.attempts + 1;
    const endpoint = await this.store.getWebhookEndpoint(delivery.vendor_id);

    // The vendor removed the endpoint after this was queued. Nothing to
    // deliver to, and retrying cannot change that.
    if (!endpoint) {
      await this.store.markWebhookDelivered(delivery.id, { at: this.now(), attempts });
      return;
    }

    try {
      const url = parseTarget(endpoint.url, {
        allowInsecure: this.allowInsecure,
        allowPrivate: this.allowPrivate,
      });
      // Re-checked every attempt, not just at registration: what a hostname
      // points at is not fixed, and the registration check may be days old.
      await resolveTarget(url, {
        allowPrivate: this.allowPrivate,
        ...(this.resolver ? { resolver: this.resolver } : {}),
      });

      const at = this.now();
      const { header } = signBody({ body: delivery.body, secret: endpoint.secret, at });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let res;
      try {
        res = await this.fetchImpl(url.toString(), {
          method: "POST",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            [SIGNATURE_HEADER]: header,
            "yazo-event": delivery.event,
            "yazo-delivery": delivery.id,
            "user-agent": "Yazo-Webhooks/1",
          },
          body: delivery.body,
        });
      } finally {
        clearTimeout(timer);
      }

      if (res.status >= 300 && res.status < 400) {
        throw new Error(`refused redirect to ${res.headers.get("location") ?? "unknown"}`);
      }
      if (!res.ok) throw new Error(`receiver answered ${res.status}`);

      await this.store.markWebhookDelivered(delivery.id, { at: this.now(), attempts });
      this.stats.delivered += 1;
    } catch (err) {
      const fatal = err instanceof WebhookTargetError;
      // A target that is not allowed to be called is not going to become
      // allowed by waiting, so it dies now rather than after five retries.
      if (fatal || attempts >= MAX_ATTEMPTS) {
        await this.store.markWebhookFailed(delivery.id, {
          attempts,
          nextAttemptAt: Number.MAX_SAFE_INTEGER, // parked: never due again
          error: fatal ? `${err.message} (not retried)` : `${err.message} (gave up)`,
        });
        this.stats.dead += 1;
        return;
      }
      await this.store.markWebhookFailed(delivery.id, {
        attempts,
        nextAttemptAt: this.now() + backoffFor(attempts),
        error: err.message,
      });
      this.stats.failed += 1;
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.sweep().catch(() => {});
    }, this.intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
