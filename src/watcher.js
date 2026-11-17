// The watcher. Yazo's promise is that an undelivered order refunds itself, and
// this is the only thing that makes that true: without it, a refund happens
// only when somebody remembers to ask, which is exactly the trust we removed.
//
// Two jobs, on a timer:
//   1. detect payments that arrived while nobody was looking
//   2. cancel holds whose window has passed, returning the payer's money
//
// Runs never overlap. A slow pass must not stack on itself and fire two cancels
// for one order.
import { STATE } from "./core/escrow.js";

export class Watcher {
  /**
   * @param {object} opts
   * @param {import("./escrow-service.js").EscrowService} opts.service
   * @param {number} [opts.intervalMs] how often to sweep
   * @param {(event: object) => void} [opts.onTick] observability hook
   */
  constructor({ service, intervalMs = 15_000, onTick = () => {} }) {
    this.service = service;
    this.intervalMs = intervalMs;
    this.onTick = onTick;
    this.timer = null;
    this.running = false;
    this.stats = { sweeps: 0, locked: 0, refunded: 0, errors: 0 };
  }

  /** One pass. Exposed so tests can drive it without waiting on a clock. */
  async sweep() {
    if (this.running) return { skipped: true };
    this.running = true;
    const started = Date.now();
    const result = { locked: [], refunded: [], errors: [] };
    try {
      const store = this.service.store;
      const live = store.live ? await store.live() : await store.all();

      // 1. has anyone paid?
      for (const order of live) {
        if (order.state !== STATE.AWAITING_PAYMENT) continue;
        try {
          const synced = await this.service.syncFromNode(order.id);
          if (synced.state === STATE.LOCKED) result.locked.push(order.id);
        } catch (e) {
          result.errors.push({ id: order.id, message: e.message });
        }
      }

      // 2. has anything run out of time?
      try {
        const refunded = await this.service.expireDueHolds();
        result.refunded.push(...refunded.map((o) => o.id));
      } catch (e) {
        result.errors.push({ id: null, message: e.message });
      }
    } finally {
      this.running = false;
    }

    this.stats.sweeps += 1;
    this.stats.locked += result.locked.length;
    this.stats.refunded += result.refunded.length;
    this.stats.errors += result.errors.length;
    this.onTick({ ...result, durationMs: Date.now() - started });
    return result;
  }

  start() {
    if (this.timer) return this;
    this.timer = setInterval(() => {
      this.sweep().catch((e) => this.onTick({ errors: [{ id: null, message: e.message }] }));
    }, this.intervalMs);
    // Never hold the process open purely for the watcher.
    this.timer.unref?.();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return this;
  }
}
