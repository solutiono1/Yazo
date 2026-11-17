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
`;

/** States where money is still at stake and the watcher must keep looking. */
const LIVE_STATES = [STATE.AWAITING_PAYMENT, STATE.LOCKED];

export class SqliteStore {
  constructor(path = "data/yazo.db") {
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
  }

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
      for (const entry of order.history.slice(already)) {
        this.#insertEvent.run(order.id, entry.at, entry.event, entry.state);
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

  close() {
    this.db.close();
  }
}
