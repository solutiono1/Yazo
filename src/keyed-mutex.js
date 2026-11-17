// Serialise work per key.
//
// Every decision in the escrow machine is read-then-write: load the order,
// decide, save. Two requests touching the same order at the same moment both
// read the old value, and the second write silently overwrites the first.
//
// That is not theoretical. It let 25 simultaneous wrong codes be counted as a
// single failed attempt, which defeats the five-guess cap entirely - the exact
// defence a short typed code depends on. See test/concurrency.test.js.
//
// Work on one order now runs one at a time. Different orders still run freely.
export class KeyedMutex {
  #chains = new Map();

  /** Run fn with exclusive access to `key`. Returns whatever fn returns. */
  async run(key, fn) {
    const previous = this.#chains.get(key) ?? Promise.resolve();

    let release;
    const mine = new Promise((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => mine);
    this.#chains.set(key, chained);

    // Wait for whoever is ahead. A failure ahead of us must not block the
    // queue, so their rejection is swallowed here - it was already surfaced to
    // its own caller.
    await previous.catch(() => {});

    try {
      return await fn();
    } finally {
      release();
      // If nobody queued behind us, forget the key so the map cannot grow
      // without bound on a long-running server.
      if (this.#chains.get(key) === chained) this.#chains.delete(key);
    }
  }

  /** Number of keys currently tracked. Exposed for tests and metrics. */
  get size() {
    return this.#chains.size;
  }
}
