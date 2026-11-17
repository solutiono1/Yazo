// Role-scoped link keys.
//
// Before this, the order id was the only credential and every endpoint took
// it. One link carried every power the order had, so anyone who had ever seen
// it could cancel - including after the vendor had handed over the goods. The
// HTTP tests below fail against that design: they are the regression suite for
// a real authorisation hole, not a hypothetical one.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  ROLE,
  ROLES,
  CAP,
  can,
  roleFor,
  newLinkKey,
  newGrantSet,
  keyDigest,
  assertGrants,
  capabilitiesOf,
  LINK_KEY,
  CapabilityError,
} from "../src/core/capability.js";
import { createServer } from "../src/http/server.js";
import { EscrowService, MemoryStore } from "../src/escrow-service.js";
import { FakeLnd } from "../src/lightning/fake.js";
import { STATE } from "../src/core/escrow.js";

const BTC = 95_000n;

async function harness() {
  const node = new FakeLnd();
  const store = new MemoryStore();
  const clock = { t: 1_700_000_000_000 };
  const service = new EscrowService({ node, store, now: () => clock.t, btcUsd: async () => BTC });
  const server = createServer({ service, now: () => clock.t });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, path, body, key) => {
    const headers = {};
    if (body) headers["Content-Type"] = "application/json";
    if (key) headers.Authorization = `Bearer ${key}`;
    const res = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: res.status, json, text };
  };

  const open = async () => {
    const created = await call("POST", "/api/orders", {
      vendorId: "v_shop",
      payerId: "p_chidi",
      recipientLabel: "Fatima",
      usdCents: "4000",
    });
    const keys = Object.fromEntries(
      Object.entries(created.json.links).map(([role, link]) => [role, link.key]),
    );
    return { created, order: created.json.order, secret: created.json.secret, keys };
  };

  /** Money actually at stake: the state where a wrongful cancel costs someone. */
  const pay = async (orderId) => {
    const full = await store.get(orderId);
    node.payInvoice(full.paymentHash, full.quote.sats);
    await service.syncFromNode(orderId);
    return full;
  };

  return { node, store, clock, service, base, call, open, pay, close: () => server.close() };
}

// ------------------------------------------------------------- the policy --

test("the capability table is exactly what we claim it is", () => {
  const expected = {
    [ROLE.PAYER]: [CAP.VIEW, CAP.CANCEL],
    [ROLE.RECIPIENT]: [CAP.VIEW, CAP.RELEASE],
    [ROLE.VENDOR]: [CAP.VIEW, CAP.RELEASE],
    [ROLE.PROOF]: [CAP.VIEW],
  };
  for (const role of ROLES) {
    assert.deepEqual(capabilitiesOf(role), expected[role], `${role} grants`);
    for (const cap of Object.values(CAP)) {
      assert.equal(can(role, cap), expected[role].includes(cap), `${role} / ${cap}`);
    }
  }
  // Nobody holds every power. That is the entire point.
  for (const role of ROLES) {
    assert.ok(capabilitiesOf(role).length < Object.values(CAP).length, `${role} is not omnipotent`);
  }
});

test("an unknown role or capability is denied, never defaulted to yes", () => {
  for (const role of [undefined, null, "", "admin", "__proto__", "constructor", "toString"]) {
    assert.equal(can(role, CAP.CANCEL), false, `role ${String(role)}`);
    assert.equal(can(role, CAP.RELEASE), false, `role ${String(role)}`);
  }
  for (const cap of [undefined, null, "", "everything", "__proto__"]) {
    assert.equal(can(ROLE.PAYER, cap), false, `cap ${String(cap)}`);
  }
});

// -------------------------------------------------------------- the keys --

test("each key resolves to exactly one role, and to nothing on another order", () => {
  const a = newGrantSet();
  const b = newGrantSet();
  for (const role of ROLES) {
    assert.equal(roleFor(a.digests, a.keys[role]), role);
    // The same role's key from a different order must not work here.
    assert.equal(roleFor(a.digests, b.keys[role]), null, `${role} key crossed orders`);
  }
  // No two roles ever share a key.
  assert.equal(new Set(Object.values(a.keys)).size, ROLES.length);
});

test("junk, near misses and forgeries all resolve to no role", () => {
  const { keys, digests } = newGrantSet();
  const real = keys[ROLE.PAYER];

  const forgeries = [
    "",
    "yzk_",
    real.slice(0, -1), // truncated
    `${real}A`, // extended
    `${real.slice(0, -1)}${real.at(-1) === "A" ? "B" : "A"}`, // one character off
    real.toUpperCase() === real ? real.toLowerCase() : real.toUpperCase(),
    real.replace("yzk_", "yzk-"),
    `Bearer ${real}`,
    digests[ROLE.PAYER].toString("hex"), // the stored digest itself
    "../../etc/passwd",
    "' OR 1=1--",
    null,
    undefined,
    12345,
    {},
    [real],
  ];
  for (const bad of forgeries) {
    assert.equal(roleFor(digests, bad), null, `accepted ${String(bad)}`);
  }
  assert.equal(roleFor(digests, real), ROLE.PAYER, "the real key must still work");
});

test("a key cannot be recovered from what is stored", () => {
  const { keys, digests } = newGrantSet();
  for (const role of ROLES) {
    const digest = digests[role];
    assert.equal(digest.length, 32);
    assert.ok(!digest.toString("hex").includes(Buffer.from(keys[role]).toString("hex")));
    // The digest is a hash, so holding it does not let you present the key.
    assert.equal(roleFor(digests, digest.toString("base64url")), null);
  }
  // 128 bits, and domain-separated from the release preimage.
  const key = newLinkKey();
  assert.match(key, LINK_KEY);
  assert.notEqual(keyDigest(key).toString("hex"), createHash("sha256").update(key).digest("hex"));
});

test("an incomplete grant set is refused rather than half-stored", () => {
  const { digests } = newGrantSet();
  assert.throws(() => assertGrants(null), CapabilityError);
  assert.throws(() => assertGrants({}), CapabilityError);
  assert.throws(() => assertGrants({ ...digests, vendor: undefined }), CapabilityError);
  assert.throws(() => assertGrants({ ...digests, vendor: "not a buffer" }), CapabilityError);
  assert.throws(() => assertGrants({ ...digests, vendor: Buffer.alloc(31) }), CapabilityError);
  assert.doesNotThrow(() => assertGrants(digests));
});

// --------------------------------------------------------- the HTTP gate --

test("ATTACK: the vendor cannot cancel the order he has handed goods for", async () => {
  const h = await harness();
  try {
    const { order, keys } = await h.open();
    await h.pay(order.id);

    // The rice is over the counter. Before the code is presented, the vendor -
    // or anyone who was ever forwarded his link - tries to take the money back.
    const res = await h.call("POST", `/api/orders/${order.id}/cancel`, {}, keys.vendor);
    assert.equal(res.status, 403, "a vendor link must not be able to refund");
    assert.equal((await h.store.get(order.id)).state, STATE.LOCKED, "the money must still be held");
    assert.equal(h.node.calls.filter((c) => c.method === "cancelInvoice").length, 0);
  } finally {
    h.close();
  }
});

test("ATTACK: the order id alone is not a credential on any route", async () => {
  const h = await harness();
  try {
    const { order } = await h.open();
    await h.pay(order.id);

    const unauthenticated = [
      ["GET", `/api/orders/${order.id}`],
      ["GET", `/api/orders/${order.id}/events`],
      ["GET", `/api/orders/${order.id}/receipt`],
      ["GET", `/api/orders/${order.id}/stream`],
      ["POST", `/api/orders/${order.id}/release`, { code: "whatever" }],
      ["POST", `/api/orders/${order.id}/cancel`, {}],
    ];
    for (const [method, path, body] of unauthenticated) {
      const res = await h.call(method, path, body);
      assert.equal(res.status, 401, `${method} ${path} answered without a key`);
    }
    assert.equal((await h.store.get(order.id)).state, STATE.LOCKED);
  } finally {
    h.close();
  }
});

test("every link is refused the powers it does not hold", async () => {
  const h = await harness();
  try {
    // A fresh order per case: a successful cancel or release is terminal.
    const cases = [
      ["payer", "release", 403],
      ["proof", "release", 403],
      ["recipient", "cancel", 403],
      ["vendor", "cancel", 403],
      ["proof", "cancel", 403],
    ];
    for (const [role, action, expected] of cases) {
      const { order, keys } = await h.open();
      await h.pay(order.id);
      const body = action === "release" ? { code: "ABCDEFGH" } : {};
      const res = await h.call("POST", `/api/orders/${order.id}/${action}`, body, keys[role]);
      assert.equal(res.status, expected, `${role} -> ${action}`);
      assert.match(res.json.error, new RegExp(`${role} link cannot ${action}`));
      assert.equal((await h.store.get(order.id)).state, STATE.LOCKED, `${role}/${action} moved money`);
    }
  } finally {
    h.close();
  }
});

test("the powers each link does hold still work", async () => {
  const h = await harness();
  try {
    // The payer may change their mind.
    const a = await h.open();
    await h.pay(a.order.id);
    const cancelled = await h.call("POST", `/api/orders/${a.order.id}/cancel`, {}, a.keys.payer);
    assert.equal(cancelled.status, 200);
    assert.equal((await h.store.get(a.order.id)).state, STATE.REFUNDED);

    // The recipient may release with her own code.
    const b = await h.open();
    await h.pay(b.order.id);
    const byRecipient = await h.call(
      "POST",
      `/api/orders/${b.order.id}/release`,
      { code: b.secret },
      b.keys.recipient,
    );
    assert.equal(byRecipient.status, 200);
    assert.equal((await h.store.get(b.order.id)).state, STATE.RELEASED);

    // And so may the vendor, scanning that same code at the counter.
    const c = await h.open();
    await h.pay(c.order.id);
    const byVendor = await h.call(
      "POST",
      `/api/orders/${c.order.id}/release`,
      { code: c.secret },
      c.keys.vendor,
    );
    assert.equal(byVendor.status, 200);
    assert.equal((await h.store.get(c.order.id)).state, STATE.RELEASED);

    // Every role can read.
    for (const key of Object.values(c.keys)) {
      assert.equal((await h.call("GET", `/api/orders/${c.order.id}`, undefined, key)).status, 200);
    }
  } finally {
    h.close();
  }
});

test("ATTACK: a key from another order opens nothing, and says nothing", async () => {
  const h = await harness();
  try {
    const mine = await h.open();
    const theirs = await h.open();
    await h.pay(theirs.order.id);

    for (const [role, key] of Object.entries(mine.keys)) {
      const res = await h.call("GET", `/api/orders/${theirs.order.id}`, undefined, key);
      // 404, not 403: a 403 would confirm that the order exists.
      assert.equal(res.status, 404, `${role} key leaked across orders`);
      assert.equal(res.json.error, "unknown order");
    }

    // And an order that does not exist answers identically, so the endpoint is
    // not an oracle for which ids are real.
    const ghost = await h.call("GET", "/api/orders/ord_aaaaaaaaaaaaaaaa", undefined, mine.keys.payer);
    assert.equal(ghost.status, 404);
    assert.equal(ghost.json.error, "unknown order");
  } finally {
    h.close();
  }
});

test("ATTACK: a key in the query string can read, and can never move money", async () => {
  const h = await harness();
  try {
    const { order, secret, keys } = await h.open();
    await h.pay(order.id);

    // Query strings end up in proxy logs, browser history and Referer headers,
    // so that channel is capped at `view` whatever role the key belongs to.
    // The payer's key really can cancel - just not from here.
    const cancel = await h.call("POST", `/api/orders/${order.id}/cancel?k=${keys.payer}`, {});
    assert.equal(cancel.status, 403);
    assert.match(cancel.json.error, /Authorization header/);

    const release = await h.call("POST", `/api/orders/${order.id}/release?k=${keys.vendor}`, {
      code: secret,
    });
    assert.equal(release.status, 403);
    assert.match(release.json.error, /Authorization header/);
    assert.equal((await h.store.get(order.id)).state, STATE.LOCKED, "money must not have moved");

    // Reading is fine: that is what the weaker channel exists for.
    const read = await h.call("GET", `/api/orders/${order.id}?k=${keys.proof}`);
    assert.equal(read.status, 200);
    assert.equal(read.json.as, ROLE.PROOF);
  } finally {
    h.close();
  }
});

test("the channel is checked before the role, so neither gate can be skipped", async () => {
  const h = await harness();
  try {
    const { order, keys } = await h.open();
    await h.pay(order.id);
    // A key that fails both gates is refused by the channel gate first, so a
    // caller cannot learn its role by probing the weaker channel.
    const viaHeader = await h.call("POST", `/api/orders/${order.id}/cancel`, {}, keys.proof);
    assert.equal(viaHeader.status, 403);
    assert.match(viaHeader.json.error, /proof link cannot cancel/);

    const viaQuery = await h.call("POST", `/api/orders/${order.id}/cancel?k=${keys.proof}`, {});
    assert.equal(viaQuery.status, 403);
    assert.match(viaQuery.json.error, /Authorization header/);
    assert.doesNotMatch(viaQuery.json.error, /proof/, "the query channel must not disclose the role");

    assert.equal((await h.store.get(order.id)).state, STATE.LOCKED);
  } finally {
    h.close();
  }
});

// ----------------------------------------------------------- key handling --

test("the link keys are returned once at creation and never again", async () => {
  const h = await harness();
  try {
    const { created, order, secret, keys } = await h.open();
    assert.equal(Object.keys(keys).length, ROLES.length);
    for (const key of Object.values(keys)) assert.match(key, LINK_KEY);

    await h.pay(order.id);
    await h.call("POST", `/api/orders/${order.id}/release`, { code: secret }, keys.vendor);

    const everywhereElse = [
      await h.call("GET", `/api/orders/${order.id}`, undefined, keys.payer),
      await h.call("GET", `/api/orders/${order.id}/events`, undefined, keys.payer),
      await h.call("GET", `/api/orders/${order.id}/receipt`, undefined, keys.proof),
    ];
    for (const res of everywhereElse) {
      assert.equal(res.status, 200);
      for (const [role, key] of Object.entries(keys)) {
        assert.ok(!res.text.includes(key), `a ${role} key came back in a later response`);
      }
      assert.ok(!res.text.includes(secret), "the release secret came back");
    }
    // Only the creation response ever carried them.
    for (const key of Object.values(keys)) assert.ok(created.text.includes(key));
  } finally {
    h.close();
  }
});

test("the store holds digests, never keys", async () => {
  const h = await harness();
  try {
    const { order, keys } = await h.open();
    const stored = await h.store.get(order.id);

    assert.deepEqual(Object.keys(stored.grants).sort(), [...ROLES].sort());
    for (const role of ROLES) {
      assert.ok(Buffer.isBuffer(stored.grants[role]));
      assert.equal(stored.grants[role].length, 32);
      assert.ok(stored.grants[role].equals(keyDigest(keys[role])));
    }

    // Serialise the whole row the way the database would and search it.
    const { encodeOrder } = await import("../src/store/codec.js");
    const serialised = encodeOrder(stored);
    for (const [role, key] of Object.entries(keys)) {
      assert.ok(!serialised.includes(key), `the ${role} key was persisted`);
    }
    // A thief holding the row cannot mint a key from it.
    assert.equal(roleFor(stored.grants, stored.grants.payer.toString("base64url")), null);
  } finally {
    h.close();
  }
});

test("grant digests survive storage and still authorise afterwards", async () => {
  const h = await harness();
  try {
    const { order, keys } = await h.open();
    const { encodeOrder, decodeOrder } = await import("../src/store/codec.js");
    const roundTripped = decodeOrder(encodeOrder(await h.store.get(order.id)));
    for (const role of ROLES) {
      assert.equal(roleFor(roundTripped.grants, keys[role]), role, `${role} broke in the codec`);
    }
  } finally {
    h.close();
  }
});

test("an order created without grants is unreachable, not public", async () => {
  const { createOrder } = await import("../src/core/escrow.js");
  const { newReleaseSecret, MODE_QR } = await import("../src/core/secret.js");
  const { quote } = await import("../src/core/money.js");
  const now = Date.now();
  const order = createOrder({
    id: "ord_nograntsgiven",
    vendorId: "v",
    payerId: "p",
    recipientLabel: "Fatima",
    q: quote(4_000n, BTC, now),
    release: newReleaseSecret(MODE_QR),
    now,
  });
  // A forgotten grant set fails closed: real digests whose keys went nowhere.
  assert.doesNotThrow(() => assertGrants(order.grants));
  assert.equal(roleFor(order.grants, newLinkKey()), null);
});

// ---------------------------------------------------------- the receipt --

test("the receipt is a shareable proof that needs only the weakest link", async () => {
  const h = await harness();
  try {
    const { order, secret, keys } = await h.open();
    await h.pay(order.id);

    // Before release there is nothing to prove.
    const early = await h.call("GET", `/api/orders/${order.id}/receipt`, undefined, keys.proof);
    assert.equal(early.status, 409);

    await h.call("POST", `/api/orders/${order.id}/release`, { code: secret }, keys.vendor);

    const res = await h.call("GET", `/api/orders/${order.id}/receipt`, undefined, keys.proof);
    assert.equal(res.status, 200);
    const { receipt } = res.json;
    // The proof checks out: sha256(preimage) is the payment hash the invoice
    // committed to before anyone paid.
    const hashed = createHash("sha256").update(Buffer.from(receipt.preimage, "hex")).digest("hex");
    assert.equal(hashed, receipt.paymentHash);
    assert.equal(receipt.orderId, order.id);
    // And it reveals nothing that could release anything: the preimage is
    // already public to every node on the payment path once settled, and the
    // recipient's secret is not derivable from it.
    assert.ok(!res.text.includes(secret));
  } finally {
    h.close();
  }
});

test("a refunded order has no receipt to show", async () => {
  const h = await harness();
  try {
    const { order, keys } = await h.open();
    await h.pay(order.id);
    await h.call("POST", `/api/orders/${order.id}/cancel`, {}, keys.payer);
    const res = await h.call("GET", `/api/orders/${order.id}/receipt`, undefined, keys.proof);
    assert.equal(res.status, 409);
    assert.match(res.json.error, /only a released order/);
  } finally {
    h.close();
  }
});
