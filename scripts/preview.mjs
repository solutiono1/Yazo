// A static preview of the HTTP surface, with a fake Lightning node behind
// it, for reviewing the frontend without standing up the regtest network.
//
//   npm run preview
//
// Nothing here moves real money; FakeLnd enforces the same rules the real
// node does (see src/lightning/fake.js) but needs no btcd, no lnd, no wallet.
// Seeds one demo merchant with a handful of orders in different states, so
// the dashboard has something real to render rather than an empty page.
import { createServer } from "../src/http/server.js";
import { EscrowService, MemoryStore } from "../src/escrow-service.js";
import { FakeLnd } from "../src/lightning/fake.js";

const port = Number(process.env.YAZO_PREVIEW_PORT ?? 4178);
const node = new FakeLnd();
const store = new MemoryStore();
const service = new EscrowService({
  node,
  store,
  btcUsd: async () => 95_000n,
  merchantSecret: "preview-only-secret-not-for-production",
});

async function seed() {
  const merchant = service.mintMerchantKey();
  const vendorId = merchant.vendorId;

  // Awaiting: created, never paid.
  await service.createOrder({ vendorId, payerId: "p_chidi", recipientLabel: "Fatima", usdCents: 4_000n });

  // Locked: paid, held, nobody has shown the code yet.
  const b = await service.createOrder({ vendorId, payerId: "p_amaka", recipientLabel: "Musa", usdCents: 9_000n });
  node.payInvoice(b.order.paymentHash, b.order.quote.sats);
  await service.syncFromNode(b.order.id);

  // Released: paid, code shown, vendor paid out.
  const c = await service.createOrder({ vendorId, payerId: "p_tunde", recipientLabel: "Chinedu", usdCents: 15_000n });
  node.payInvoice(c.order.paymentHash, c.order.quote.sats);
  await service.syncFromNode(c.order.id);
  await service.release(c.order.id, c.secret);

  // Refunded: paid, never delivered, hold expired.
  const d = await service.createOrder({ vendorId, payerId: "p_ngozi", recipientLabel: "Aisha", usdCents: 2_500n });
  node.payInvoice(d.order.paymentHash, d.order.quote.sats);
  await service.syncFromNode(d.order.id);
  await service.refund(d.order.id, "no delivery");

  return merchant;
}

const merchant = await seed();

const server = createServer({ service, publicDir: "public" });
server.listen(port, "127.0.0.1", () => {
  console.log(`[yazo] preview on http://127.0.0.1:${port}`);
  console.log(`[yazo] demo vendorId: ${merchant.vendorId}`);
  console.log(`[yazo] demo dashboard: http://127.0.0.1:${port}/dashboard.html#${merchant.merchantKey}`);
});
