// Durable order storage on SQLite, via Node's built-in driver.
//
// No database server, no npm install, no Docker - and still a real ACID store
// that survives a crash. That matters more here than convenience: an order is
// a claim on money held in a Lightning channel, and losing the record while the
// HTLC is still live would strand a payer's funds until the hold expired.
//
// Two tables:
//   orders        current state, one row per order
//   order_events  append-only history. Rows are inserted, never updated or
//                 deleted, so there is an audit trail of every transition.
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { encodeOrder, decodeOrder } from "./codec.js";
import { STATE } from "../core/escrow.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orders (
  id              TEXT PRIMARY KEY,
  state           TEXT NOT NULL,
  payment_hash    TEXT NOT NULL UNIQUE,
  hold_expires_at INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  data            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_live ON orders (state, hold_expires_at);

CREATE TABLE IF NOT EXISTS order_events (
  seq      INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  at       INTEGER NOT NULL,
  event    TEXT NOT NULL,
  state    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_order ON order_events (order_id, seq);

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  vendor_id  TEXT PRIMARY KEY,
  url        TEXT NOT NULL,
  secret     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- A delivery is enqueued in the same transaction as the state change that
-- caused it. That is the whole point: a vendor can never be told about a
-- release that did not commit, and a release that did commit can never fail
-- to produce a delivery because the process died a line later.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              TEXT PRIMARY KEY,
  vendor_id       TEXT NOT NULL,
  order_id        TEXT NOT NULL,
  event           TEXT NOT NULL,
  state           TEXT NOT NULL,
  body            TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  delivered_at    INTEGER,
  last_error      TEXT
);
CREATE INDEX IF NOT EXISTS idx_wh_due ON webhook_deliveries (delivered_at, next_attempt_at);
`;

/** States where money is still at stake and the watcher must keep looking. */
const LIVE_STATES = [STATE.AWAITING_PAYMENT, STATE.LOCKED];

export class SqliteStore {
  /**
   * @param {string} path
   * @param {object} [opts]
   * @param {(order: object, entry: object) => object} [opts.renderWebhook]
   *   Builds the body for one delivery. Injected rather than written here so
   *   the store never has to know what an order looks like from outside - the
   *   HTTP layer owns that projection, and a webhook can therefore never
   *   expose a field the API itself would not.
   */
  constructor(path = "data/yazo.db", { renderWebhook = null } = {}) {
    this.#renderWebhook = renderWebhook;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // WAL survives an unclean shutdown far better than the default journal.
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA synchronous = FULL"); // durability over speed: this is money
    this.db.exec(SCHEMA);

    this.#upsert = this.db.prepare(`
      INSERT INTO orders (id, state, payment_hash, hold_expires_at, created_at, updated_at, data)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        state = excluded.state,
        hold_expires_at = excluded.hold_expires_at,
        updated_at = excluded.updated_at,
        data = excluded.data
    `);
    this.#selectOne = this.db.prepare("SELECT data FROM orders WHERE id = ?");
    this.#selectAll = this.db.prepare("SELECT data FROM orders ORDER BY created_at");
    this.#selectLive = this.db.prepare(
      `SELECT data FROM orders WHERE state IN (${LIVE_STATES.map(() => "?").join(",")}) ORDER BY created_at`,
    );
    this.#countEvents = this.db.prepare("SELECT COUNT(*) AS n FROM order_events WHERE order_id = ?");
    this.#insertEvent = this.db.prepare(
      "INSERT INTO order_events (order_id, at, event, state) VALUES (?, ?, ?, ?)",
    );
    this.#selectEvents = this.db.prepare(
      "SELECT at, event, state FROM order_events WHERE order_id = ? ORDER BY seq",
    );

    this.#getEndpoint = this.db.prepare("SELECT * FROM webhook_endpoints WHERE vendor_id = ?");
    this.#putEndpoint = this.db.prepare(`
      INSERT INTO webhook_endpoints (vendor_id, url, secret, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(vendor_id) DO UPDATE SET
        url = excluded.url, secret = excluded.secret, created_at = excluded.created_at
    `);
    this.#dropEndpoint = this.db.prepare("DELETE FROM webhook_endpoints WHERE vendor_id = ?");
    this.#enqueueDelivery = this.db.prepare(`
      INSERT INTO webhook_deliveries
        (id, vendor_id, order_id, event, state, body, created_at, next_attempt_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.#dueDeliveries = this.db.prepare(`
      SELECT * FROM webhook_deliveries
      WHERE delivered_at IS NULL AND next_attempt_at <= ?
      ORDER BY next_attempt_at LIMIT ?
    `);
    this.#markDelivered = this.db.prepare(
      "UPDATE webhook_deliveries SET delivered_at = ?, attempts = ?, last_error = NULL WHERE id = ?",
    );
    this.#markFailed = this.db.prepare(
      "UPDATE webhook_deliveries SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?",
    );
  }

  #renderWebhook;
  #getEndpoint;
  #putEndpoint;
  #dropEndpoint;
  #enqueueDelivery;
  #dueDeliveries;
  #markDelivered;
  #markFailed;
  #upsert;
  #selectOne;
  #selectAll;
  #selectLive;
  #countEvents;
  #insertEvent;
  #selectEvents;

  async get(id) {
    const row = this.#selectOne.get(id);
    return row ? decodeOrder(row.data) : null;
  }

  async put(order) {
    const data = encodeOrder(order); // throws if a secret ever reached the order
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.#upsert.run(
        order.id,
        order.state,
        order.paymentHash.toString("hex"),
        order.holdExpiresAt ?? null,
        order.createdAt,
        Date.now(),
        data,
      );
      // Append only the transitions this store has not already recorded.
      const already = this.#countEvents.get(order.id).n;
      const fresh = order.history.slice(already);
      for (const entry of fresh) {
        this.#insertEvent.run(order.id, entry.at, entry.event, entry.state);
      }
      // Same transaction as the state change, deliberately. Enqueuing after
      // the commit would mean a crash in between loses the notification for a
      // transition that really happened.
      if (this.#renderWebhook && fresh.length) {
        const endpoint = this.#getEndpoint.get(order.vendorId);
        if (endpoint) {
          for (const entry of fresh) {
            this.#enqueueDelivery.run(
              randomUUID(),
              order.vendorId,
              order.id,
              entry.event,
              entry.state,
              JSON.stringify(this.#renderWebhook(order, entry)),
              entry.at,
              entry.at, // first attempt is due immediately
            );
          }
        }
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return order;
  }

  async all() {
    return this.#selectAll.all().map((r) => decodeOrder(r.data));
  }

  /** Only orders where money is still at stake. What the watcher iterates. */
  async live() {
    return this.#selectLive.all(...LIVE_STATES).map((r) => decodeOrder(r.data));
  }

  /** The immutable audit trail for one order. */
  async events(orderId) {
    return this.#selectEvents.all(orderId);
  }

  /* --------------------------------------------------------- webhooks -- */

  async setWebhookEndpoint({ vendorId, url, secret, at }) {
    this.#putEndpoint.run(vendorId, url, secret, at);
  }

  async getWebhookEndpoint(vendorId) {
    return this.#getEndpoint.get(vendorId) ?? null;
  }

  async deleteWebhookEndpoint(vendorId) {
    this.#dropEndpoint.run(vendorId);
  }

  /** Deliveries that are owed and whose backoff has elapsed. */
  async dueWebhooks(now, limit = 20) {
    return this.#dueDeliveries.all(now, limit);
  }

  async markWebhookDelivered(id, { at, attempts }) {
    this.#markDelivered.run(at, attempts, id);
  }

  async markWebhookFailed(id, { attempts, nextAttemptAt, error }) {
    this.#markFailed.run(attempts, nextAttemptAt, String(error).slice(0, 500), id);
  }

  close() {
    this.db.close();
  }
}
