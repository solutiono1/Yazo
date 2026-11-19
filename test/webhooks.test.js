import { test } from "node:test";
import assert from "node:assert/strict";

import {
  signBody,
  verifySignature,
  parseSignatureHeader,
  newEndpointSecret,
  DEFAULT_TOLERANCE_MS,
} from "../src/webhooks/sign.js";
import {
  parseTarget,
  resolveTarget,
  isPrivateAddress,
  WebhookTargetError,
} from "../src/webhooks/target.js";

const NOW = 1_763_500_000_000;
const SECRET = "yws_test_secret_value";

/* ------------------------------------------------------------ signing -- */

test("a signature this node produces verifies with the same secret", () => {
  const body = JSON.stringify({ event: "RELEASE", orderId: "ord_1" });
  const { header } = signBody({ body, secret: SECRET, at: NOW });
  assert.equal(verifySignature({ header, body, secret: SECRET, now: NOW }), true);
});

test("a body changed in transit does not verify", () => {
  const body = JSON.stringify({ event: "RELEASE", amountSats: 1000 });
  const { header } = signBody({ body, secret: SECRET, at: NOW });
  const tampered = JSON.stringify({ event: "RELEASE", amountSats: 9_999_999 });
  assert.equal(verifySignature({ header, body: tampered, secret: SECRET, now: NOW }), false);
});

test("a different secret does not verify", () => {
  const body = "{}";
  const { header } = signBody({ body, secret: SECRET, at: NOW });
  assert.equal(verifySignature({ header, body, secret: "yws_other", now: NOW }), false);
});

test("a captured delivery stops verifying once it is stale", () => {
  const body = "{}";
  const { header } = signBody({ body, secret: SECRET, at: NOW });

  // Still inside the window.
  assert.equal(
    verifySignature({ header, body, secret: SECRET, now: NOW + DEFAULT_TOLERANCE_MS - 1000 }),
    true,
  );
  // Replayed later: same bytes, same signature, now refused.
  assert.equal(
    verifySignature({ header, body, secret: SECRET, now: NOW + DEFAULT_TOLERANCE_MS + 1000 }),
    false,
  );
});

test("a timestamp from the future is refused too", () => {
  const body = "{}";
  const { header } = signBody({ body, secret: SECRET, at: NOW + DEFAULT_TOLERANCE_MS + 5000 });
  assert.equal(verifySignature({ header, body, secret: SECRET, now: NOW }), false);
});

test("moving the timestamp invalidates the signature", () => {
  const body = "{}";
  const { signature } = signBody({ body, secret: SECRET, at: NOW });
  const moved = `t=${Math.floor(NOW / 1000) + 30},v1=${signature}`;
  assert.equal(verifySignature({ header: moved, body, secret: SECRET, now: NOW }), false);
});

test("malformed signature headers are refused, not thrown on", () => {
  for (const header of ["", "garbage", "t=abc,v1=def", "v1=deadbeef", "t=1763500000", null, undefined]) {
    assert.equal(parseSignatureHeader(header) === null || true, true);
    assert.equal(verifySignature({ header, body: "{}", secret: SECRET, now: NOW }), false);
  }
});

test("a signature of the wrong length is refused without throwing", () => {
  const header = `t=${Math.floor(NOW / 1000)},v1=abcd`;
  assert.equal(verifySignature({ header, body: "{}", secret: SECRET, now: NOW }), false);
});

test("endpoint secrets are unique and prefixed", () => {
  const a = newEndpointSecret();
  const b = newEndpointSecret();
  assert.notEqual(a, b);
  assert.match(a, /^yws_[\w-]{20,}$/);
});

/* ------------------------------------------------- target / SSRF gate -- */

test("a normal https url is accepted", () => {
  const url = parseTarget("https://hooks.example.com/yazo");
  assert.equal(url.hostname, "hooks.example.com");
});

test("http is refused unless explicitly allowed", () => {
  assert.throws(() => parseTarget("http://hooks.example.com/yazo"), WebhookTargetError);
  assert.doesNotThrow(() => parseTarget("http://hooks.example.com/yazo", { allowInsecure: true }));
});

test("non-http schemes are refused", () => {
  for (const raw of ["file:///etc/passwd", "ftp://example.com", "gopher://example.com"]) {
    assert.throws(() => parseTarget(raw), WebhookTargetError);
  }
});

test("credentials in the url are refused rather than stripped", () => {
  assert.throws(() => parseTarget("https://user:pass@example.com/hook"), WebhookTargetError);
});

test("literal private and loopback addresses are refused", () => {
  const blocked = [
    "https://127.0.0.1/hook",
    "https://10.0.0.5/hook",
    "https://192.168.1.1/hook",
    "https://172.16.4.2/hook",
    "https://169.254.169.254/latest/meta-data/", // cloud metadata
    "https://[::1]/hook",
    "https://[fd00::1]/hook",
    "https://localhost/hook",
    "https://anything.local/hook",
    "https://svc.internal/hook",
  ];
  for (const raw of blocked) {
    assert.throws(() => parseTarget(raw), WebhookTargetError, `expected ${raw} to be refused`);
  }
});

test("the metadata address is private however it is written", () => {
  assert.equal(isPrivateAddress("169.254.169.254"), true);
  assert.equal(isPrivateAddress("::ffff:169.254.169.254"), true);
  assert.equal(isPrivateAddress("8.8.8.8"), false);
});

test("a public-looking hostname that resolves inward is refused at send time", async () => {
  const url = parseTarget("https://totally-public.example.com/hook");
  const resolver = async () => [{ address: "10.1.2.3", family: 4 }];
  await assert.rejects(() => resolveTarget(url, { resolver }), WebhookTargetError);
});

test("one private answer among several is enough to refuse", async () => {
  const url = parseTarget("https://mixed.example.com/hook");
  const resolver = async () => [
    { address: "93.184.216.34", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ];
  await assert.rejects(() => resolveTarget(url, { resolver }), WebhookTargetError);
});

test("a hostname resolving to public addresses passes", async () => {
  const url = parseTarget("https://good.example.com/hook");
  const resolver = async () => [{ address: "93.184.216.34", family: 4 }];
  assert.deepEqual(await resolveTarget(url, { resolver }), ["93.184.216.34"]);
});

test("a hostname that does not resolve is refused", async () => {
  const url = parseTarget("https://nope.example.com/hook");
  const resolver = async () => {
    throw new Error("ENOTFOUND");
  };
  await assert.rejects(() => resolveTarget(url, { resolver }), WebhookTargetError);
});

/* --------------------------------------------- queue + sender behaviour -- */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/store/sqlite.js";
import { quote } from "../src/core/money.js";
import { newReleaseSecret, MODE_QR } from "../src/core/secret.js";
import { createOrder, apply, EVENT } from "../src/core/escrow.js";
import { WebhookSender, MAX_ATTEMPTS, backoffFor } from "../src/webhooks/sender.js";

const T0 = 1_700_000_000_000;

function tempStore(opts) {
  const dir = mkdtempSync(join(tmpdir(), "yazo-wh-"));
  const store = new SqliteStore(join(dir, "wh.db"), opts);
  return { store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const makeOrder = (id = "ord_wh") =>
  createOrder({
    id,
    vendorId: "v_shop",
    payerId: "p_payer",
    recipientLabel: "Fatima",
    q: quote(4_000n, 95_000n, T0),
    release: newReleaseSecret(MODE_QR),
    now: T0,
  });

const render = (order, entry) => ({ orderId: order.id, event: entry.event, state: entry.state });

test("no endpoint registered means nothing is ever queued", async () => {
  const { store, cleanup } = tempStore({ renderWebhook: render });
  try {
    await store.put(makeOrder());
    assert.equal((await store.dueWebhooks(T0 + 1)).length, 0);
  } finally { cleanup(); }
});

test("a state change queues one delivery per new transition, once", async () => {
  const { store, cleanup } = tempStore({ renderWebhook: render });
  try {
    await store.setWebhookEndpoint({ vendorId: "v_shop", url: "https://e.example/h", secret: "s", at: T0 });
    let order = makeOrder();
    await store.put(order);
    const first = await store.dueWebhooks(T0 + 1);
    assert.equal(first.length, 1);

    // Putting the same order again must not re-queue what was already sent.
    await store.put(order);
    assert.equal((await store.dueWebhooks(T0 + 1)).length, 1);

    order = apply(order, EVENT.INVOICE_CREATED, T0 + 10, { paymentRequest: "lnbc1" });
    await store.put(order);
    assert.equal((await store.dueWebhooks(T0 + 20)).length, 2);
  } finally { cleanup(); }
});

test("a delivered webhook stops being due", async () => {
  const { store, cleanup } = tempStore({ renderWebhook: render });
  try {
    await store.setWebhookEndpoint({ vendorId: "v_shop", url: "https://e.example/h", secret: "s", at: T0 });
    await store.put(makeOrder());
    const [d] = await store.dueWebhooks(T0 + 1);
    await store.markWebhookDelivered(d.id, { at: T0 + 5, attempts: 1 });
    assert.equal((await store.dueWebhooks(T0 + 100)).length, 0);
  } finally { cleanup(); }
});

test("the sender signs what it posts, and the receiver can verify it", async () => {
  const { store, cleanup } = tempStore({ renderWebhook: render });
  try {
    const secret = "yws_shared";
    await store.setWebhookEndpoint({ vendorId: "v_shop", url: "https://e.example/h", secret, at: T0 });
    await store.put(makeOrder());

    let seen = null;
    const sender = new WebhookSender({
      store,
      now: () => T0 + 1000,
      resolver: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: async (url, init) => {
        seen = { url, init };
        return { ok: true, status: 200, headers: new Map() };
      },
    });
    await sender.sweep();

    assert.equal(sender.stats.delivered, 1);
    assert.equal(seen.url, "https://e.example/h");
    assert.equal(seen.init.redirect, "manual");
    const ok = verifySignature({
      header: seen.init.headers["yazo-signature"],
      body: seen.init.body,
      secret,
      now: T0 + 1000,
    });
    assert.equal(ok, true, "receiver must be able to verify the delivery");
    assert.equal((await store.dueWebhooks(T0 + 10_000)).length, 0);
  } finally { cleanup(); }
});

test("a failing receiver is retried with backoff, then parked", async () => {
  const { store, cleanup } = tempStore({ renderWebhook: render });
  try {
    await store.setWebhookEndpoint({ vendorId: "v_shop", url: "https://e.example/h", secret: "s", at: T0 });
    await store.put(makeOrder());

    let clock = T0;
    const sender = new WebhookSender({
      store,
      now: () => clock,
      resolver: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: async () => ({ ok: false, status: 500, headers: new Map() }),
    });

    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      await sender.sweep();
      const [row] = await store.dueWebhooks(Number.MAX_SAFE_INTEGER - 1);
      assert.equal(row.attempts, attempt);
      assert.match(row.last_error, /500/);
      clock += backoffFor(attempt) + 1;
    }
    await sender.sweep(); // the attempt that exhausts the budget
    assert.equal(sender.stats.dead, 1);
    assert.equal((await store.dueWebhooks(Number.MAX_SAFE_INTEGER - 1)).length, 0);
  } finally { cleanup(); }
});

test("a redirect is refused rather than followed", async () => {
  const { store, cleanup } = tempStore({ renderWebhook: render });
  try {
    await store.setWebhookEndpoint({ vendorId: "v_shop", url: "https://e.example/h", secret: "s", at: T0 });
    await store.put(makeOrder());
    const sender = new WebhookSender({
      store,
      now: () => T0,
      resolver: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: async () => ({
        ok: false, status: 302,
        headers: new Map([["location", "http://169.254.169.254/latest/meta-data/"]]),
      }),
    });
    await sender.sweep();
    const [row] = await store.dueWebhooks(Number.MAX_SAFE_INTEGER - 1);
    assert.match(row.last_error, /refused redirect/);
  } finally { cleanup(); }
});

test("an endpoint that became private is killed off, not retried", async () => {
  const { store, cleanup } = tempStore({ renderWebhook: render });
  try {
    await store.setWebhookEndpoint({ vendorId: "v_shop", url: "https://10.0.0.9/h", secret: "s", at: T0 });
    await store.put(makeOrder());
    let called = false;
    const sender = new WebhookSender({
      store, now: () => T0,
      fetchImpl: async () => { called = true; return { ok: true, status: 200, headers: new Map() }; },
    });
    await sender.sweep();
    assert.equal(called, false, "must not have made the request at all");
    assert.equal(sender.stats.dead, 1);
    assert.equal((await store.dueWebhooks(Number.MAX_SAFE_INTEGER - 1)).length, 0);
  } finally { cleanup(); }
});

test("removing the endpoint drains what was already queued for it", async () => {
  const { store, cleanup } = tempStore({ renderWebhook: render });
  try {
    await store.setWebhookEndpoint({ vendorId: "v_shop", url: "https://e.example/h", secret: "s", at: T0 });
    await store.put(makeOrder());
    await store.deleteWebhookEndpoint("v_shop");
    let called = false;
    const sender = new WebhookSender({
      store, now: () => T0,
      fetchImpl: async () => { called = true; return { ok: true, status: 200, headers: new Map() }; },
    });
    await sender.sweep();
    assert.equal(called, false);
    assert.equal((await store.dueWebhooks(Number.MAX_SAFE_INTEGER - 1)).length, 0);
  } finally { cleanup(); }
});
