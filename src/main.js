// Yazo server entrypoint.
//
//   node src/main.js
//
// Boots in an order that matters: open the database, connect to the node,
// reconcile our record against it, and only then start accepting requests. A
// server that answers before it has reconciled can tell a vendor he was not
// paid when the node already settled him.
import { randomBytes } from "node:crypto";
import { EscrowService } from "./escrow-service.js";
import { SqliteStore } from "./store/sqlite.js";
import { LndClient } from "./lightning/client.js";
import { Watcher } from "./watcher.js";
import { createServer } from "./http/server.js";
import { WebhookSender } from "./webhooks/sender.js";
import { orderView } from "./http/views.js";

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
  // Webhook targets must be https in any real deployment. This exists so a
  // developer can point one at their own machine, and it is opt-in rather
  // than inferred from the network, so nothing silently relaxes in production.
  allowInsecureWebhooks: process.env.YAZO_ALLOW_INSECURE_WEBHOOKS === "1",
};

const log = (...a) => console.log(new Date().toISOString(), "[yazo]", ...a);

// Every merchant key is an HMAC under this one secret - there is no server
// table of merchants to protect instead, but this is now the thing that
// must never leak or roll over unannounced: rolling it invalidates every
// merchant key issued so far. Generating one at boot is a usable default for
// a demo; losing it on every restart is the trade-off, and is why a real
// deployment sets YAZO_MERCHANT_SECRET itself.
function merchantSecret() {
  const fromEnv = process.env.YAZO_MERCHANT_SECRET;
  if (fromEnv) {
    if (fromEnv.length < 16) throw new Error("YAZO_MERCHANT_SECRET must be at least 16 characters");
    return fromEnv;
  }
  log("YAZO_MERCHANT_SECRET not set - generating one for this run only; merchant keys will not survive a restart");
  return randomBytes(32).toString("base64url");
}

async function main() {
  // The webhook body is the same projection the API serves, so a delivery can
  // never carry a field the HTTP layer would have withheld.
  const store = new SqliteStore(config.dbPath, {
    renderWebhook: (order, entry) => ({
      event: entry.event,
      state: entry.state,
      at: entry.at,
      order: orderView(order, { now: entry.at }),
    }),
  });
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
    merchantSecret: merchantSecret(),
    onError: (e, orderId) => log(`error on ${orderId ?? "-"}: ${e.message}`),
  });

  // Correct ourselves from the node before serving anything.
  const corrections = await service.reconcile();
  if (corrections.length) {
    for (const c of corrections) log(`reconciled ${c.id}: ${c.from} -> ${c.to}`);
  } else {
    log("reconciled: nothing to correct");
  }

  // Subscribe to anything still awaiting payment, so a payer sees the lock
  // immediately rather than on the next sweep.
  const watching = await service.watchLiveOrders();
  if (watching) log(`subscribed to ${watching} order(s) awaiting payment`);

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

  const sender = new WebhookSender({
    store,
    allowInsecureWebhooks: config.allowInsecureWebhooks,
    allowInsecure: config.allowInsecureWebhooks,
    onTick: ({ due, dead }) => {
      if (due) log(`webhooks: ${due} due${dead ? `, ${dead} dead-lettered so far` : ""}`);
    },
  });
  sender.start();
  log("webhook sender started");

  const server = createServer({
    service,
    publicDir: config.publicDir,
    allowInsecureWebhooks: config.allowInsecureWebhooks,
  });
  server.listen(config.port, config.host, () => {
    log(`listening on http://${config.host}:${config.port}`);
  });

  const shutdown = (signal) => {
    log(`${signal}: shutting down`);
    watcher.stop();
    sender.stop();
    service.stopWatching();
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
