// Yazo server entrypoint.
//
//   node src/main.js
//
// Boots in an order that matters: open the database, connect to the node,
// reconcile our record against it, and only then start accepting requests. A
// server that answers before it has reconciled can tell a vendor he was not
// paid when the node already settled him.
import { EscrowService } from "./escrow-service.js";
import { SqliteStore } from "./store/sqlite.js";
import { LndClient } from "./lightning/client.js";
import { Watcher } from "./watcher.js";
import { createServer } from "./http/server.js";

const config = {
  port: Number(process.env.YAZO_PORT ?? 3000),
  host: process.env.YAZO_HOST ?? "127.0.0.1",
  dbPath: process.env.YAZO_DB ?? "data/yazo.db",
  publicDir: process.env.YAZO_PUBLIC ?? "public",
  lndDir: process.env.LND_DIR ?? ".regtest/bob",
  lndRestPort: Number(process.env.LND_REST_PORT ?? 8082),
  network: process.env.LND_NETWORK ?? "regtest",
  // No price API is called. The rate is configuration, so the server works
  // offline and nothing about an order depends on a third party being up.
  btcUsd: BigInt(process.env.BTC_USD ?? "95000"),
  sweepMs: Number(process.env.YAZO_SWEEP_MS ?? 15_000),
};

const log = (...a) => console.log(new Date().toISOString(), "[yazo]", ...a);

async function main() {
  const store = new SqliteStore(config.dbPath);
  log(`database ${config.dbPath}`);

  const node = LndClient.fromLndDir(config.lndDir, {
    port: config.lndRestPort,
    network: config.network,
  });
  log(`lnd ${config.lndDir} on :${config.lndRestPort} (${config.network})`);

  const service = new EscrowService({
    node,
    store,
    btcUsd: async () => config.btcUsd,
    onError: (e, orderId) => log(`error on ${orderId ?? "-"}: ${e.message}`),
  });

  // Correct ourselves from the node before serving anything.
  const corrections = await service.reconcile();
  if (corrections.length) {
    for (const c of corrections) log(`reconciled ${c.id}: ${c.from} -> ${c.to}`);
  } else {
    log("reconciled: nothing to correct");
  }

  const watcher = new Watcher({
    service,
    intervalMs: config.sweepMs,
    onTick: ({ locked = [], refunded = [], errors = [] }) => {
      for (const id of locked) log(`payment locked: ${id}`);
      for (const id of refunded) log(`refunded on expiry: ${id}`);
      for (const e of errors) log(`sweep error${e.id ? ` on ${e.id}` : ""}: ${e.message}`);
    },
  }).start();
  log(`watcher sweeping every ${config.sweepMs}ms`);

  const server = createServer({ service, publicDir: config.publicDir });
  server.listen(config.port, config.host, () => {
    log(`listening on http://${config.host}:${config.port}`);
  });

  const shutdown = (signal) => {
    log(`${signal}: shutting down`);
    watcher.stop();
    server.close(() => {
      store.close();
      process.exit(0);
    });
    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((e) => {
  console.error("[yazo] failed to start:", e.message);
  process.exit(1);
});
