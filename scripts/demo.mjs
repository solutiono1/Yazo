// The whole promise of Yazo, against real Lightning nodes.
//
//   node scripts/regtest/up.mjs    # once, to build the network
//   node scripts/demo.mjs
//
// Two journeys are shown:
//   1. The rice arrives. Fatima shows her code. The vendor is paid.
//   2. The rice never arrives. Nobody shows a code. The payer gets it all back.
//
// Nothing is simulated: alice really pays, bob really holds the HTLC, and the
// money really moves only when the recipient's secret produces the preimage.
import { EscrowService } from "../src/escrow-service.js";
import { LndClient, INVOICE_STATE } from "../src/lightning/client.js";
import { STATE } from "../src/core/escrow.js";
import { formatUsd } from "../src/core/money.js";
import { createServer } from "../src/http/server.js";
import { NODES, NETWORK, sleep } from "./regtest/config.mjs";
import { LndAdmin } from "./regtest/lnd-admin.mjs";

// Fixed for a reproducible demo. Production reads a live rate; the quote is
// stamped on the order and expires after 60 seconds either way.
const BTC_USD = 95_000n;

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;

const step = (n, text) => console.log(`\n${bold(cyan(`  ${n}.`))} ${bold(text)}`);
const note = (text) => console.log(`     ${dim(text)}`);
const good = (text) => console.log(`     ${green("✓")} ${text}`);
const held = (text) => console.log(`     ${yellow("◆")} ${text}`);

async function invoiceState(node, order) {
  return (await node.lookupInvoice(order.paymentHash)).state;
}

async function main() {
  const bobNode = LndClient.fromLndDir(NODES.bob.dir, { port: NODES.bob.rest, network: NETWORK });
  const alice = new LndAdmin(NODES.alice, "alice");

  const service = new EscrowService({ node: bobNode, btcUsd: async () => BTC_USD });

  // The authorisation step below is run over real HTTP rather than by calling
  // the service directly, because the router is where authorisation lives and
  // a demo that skipped it would be proving nothing.
  const api = createServer({ service });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${api.address().port}`;
  const asRole = (method, path, key, body) =>
    fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  console.log(bold("\n═══ YAZO ═══  Send the goods, not the cash.\n"));
  // Yazo authenticates with invoice.macaroon, which can create and settle
  // invoices and nothing else. It cannot read node state and it cannot send
  // funds anywhere. Proving that is worth more than a version banner.
  try {
    await bobNode.getInfo();
    note(`connected to lnd on ${NETWORK}`);
  } catch (e) {
    note(`connected to lnd on ${NETWORK} with a least-privilege macaroon`);
    note(`even "getinfo" is refused: ${e.message}. Yazo can only create and settle invoices.`);
  }

  // ───────────────────────────── journey 1: delivered ──────────────────────
  console.log(bold("\n── Journey 1: the rice arrives ──"));

  step(1, "Chidi in London orders $40 of rice from Mama's Shop in Kano");
  const { order, paymentRequest, secret, links } = await service.createOrder({
    vendorId: "v_mamas_shop",
    payerId: "p_chidi_london",
    recipientLabel: "Fatima",
    usdCents: 4_000n,
    memo: "Yazo: 1 bag of rice for Fatima",
  });
  good(`order ${order.id} for ${formatUsd(order.quote.usdCents)} = ${order.quote.sats} sats`);
  note(`invoice ${paymentRequest.slice(0, 40)}...`);
  note(`payment hash ${order.paymentHash.toString("hex").slice(0, 32)}...`);
  console.log(`     ${bold("Fatima's code:")} ${bold(green(secret))}  ${dim("(sent to her phone, never stored)")}`);
  note("four links go out, and no two of them can do the same things:");
  for (const link of Object.values(links)) {
    note(`  ${link.role.padEnd(10)} ${link.key}  can: ${link.capabilities.join(", ")}`);
  }

  step(2, "Chidi pays. The money locks in the Lightning network");
  const status = await alice.payHeld(paymentRequest);
  note(`alice payment status: ${status}`);
  for (let i = 0; i < 30; i += 1) {
    if ((await invoiceState(bobNode, order)) === INVOICE_STATE.ACCEPTED) break;
    await sleep(500);
  }
  const lockedOrder = await service.syncFromNode(order.id);
  held(`invoice state: ${await invoiceState(bobNode, order)} — the HTLC is HELD`);
  held(`order state: ${lockedOrder.state}`);
  note("the vendor does not have this money. Yazo does not have it. Nobody can spend it.");

  step(3, "Someone tries to take the money without the code");
  try {
    await service.release(order.id, "GUESSING-WRONG-CODE");
  } catch (e) {
    good(`refused: ${e.message}`);
  }
  held(`invoice still ${await invoiceState(bobNode, order)} — nothing moved`);

  step(4, "The vendor hands over the rice, then tries to cancel and keep both");
  const grab = await asRole("POST", `/api/orders/${order.id}/cancel`, links.vendor.key, {});
  good(`refused with ${grab.status}: ${(await grab.json()).error}`);
  const payerTriesToRelease = await asRole(
    "POST",
    `/api/orders/${order.id}/release`,
    links.payer.key,
    { code: secret },
  );
  good(`and the payer's link cannot release either: ${payerTriesToRelease.status}`);
  held(`invoice still ${await invoiceState(bobNode, order)} — the order id is not a password`);

  step(5, "The rice arrives. Fatima shows her code");
  const { order: released, receipt } = await service.release(order.id, secret);
  good(`order state: ${released.state}`);
  good(`invoice state: ${await invoiceState(bobNode, order)} — the vendor has been paid`);
  note(`receipt preimage ${receipt.preimage.slice(0, 32)}...`);
  note(`verify: sha256(preimage) == ${receipt.paymentHash.slice(0, 32)}...`);

  // ───────────────────────────── journey 2: refunded ───────────────────────
  console.log(bold("\n\n── Journey 2: the rice never arrives ──"));

  step(6, "Chidi orders again, and pays again");
  const second = await service.createOrder({
    vendorId: "v_mamas_shop",
    payerId: "p_chidi_london",
    recipientLabel: "Fatima",
    usdCents: 2_500n,
    memo: "Yazo: cooking oil for Fatima",
  });
  good(`order ${second.order.id} for ${formatUsd(second.order.quote.usdCents)} = ${second.order.quote.sats} sats`);
  await alice.payHeld(second.paymentRequest);
  for (let i = 0; i < 30; i += 1) {
    if ((await invoiceState(bobNode, second.order)) === INVOICE_STATE.ACCEPTED) break;
    await sleep(500);
  }
  await service.syncFromNode(second.order.id);
  held(`invoice state: ${await invoiceState(bobNode, second.order)} — held again`);

  step(7, "No delivery. The hold window passes");
  note("(the demo expires it immediately; in production this is a 6 hour window)");
  const refunded = await service.refund(second.order.id, "no delivery");
  good(`order state: ${refunded.state}`);
  good(`invoice state: ${await invoiceState(bobNode, second.order)} — the HTLC was cancelled`);
  good("Chidi's money returned to Chidi. The vendor was never paid.");

  // ───────────────────────────── summary ───────────────────────────────────
  const aliceChannels = await alice.listChannels();
  const ch = aliceChannels.channels?.[0];
  console.log(bold("\n\n── Result ──"));
  console.log(`  delivered order : ${released.state}  (vendor paid ${order.quote.sats} sats)`);
  console.log(`  undelivered one : ${refunded.state}  (payer kept ${second.order.quote.sats} sats)`);
  if (ch) console.log(`  channel balance : alice ${ch.local_balance} sat | bob ${ch.remote_balance} sat`);
  console.log(
    `\n  ${bold("The money only ever moved when the recipient's secret produced the preimage.")}\n`,
  );

  service.stopWatching();
  api.close();
}

main().catch((e) => {
  console.error("\n[demo] FAILED:", e.message);
  process.exit(1);
});
