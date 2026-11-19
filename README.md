# Yazo

**Send the goods, not the cash.**

Yazo locks a dollar-priced payment on Bitcoin Lightning until the person
receiving the goods shows their delivery code. The vendor cannot take it
early, the platform cannot either, and if delivery never happens the money
refunds itself — nobody has to ask.

> Built for the [Dakar Bitcoin Hack by BTrust](https://dakar-bitcoin-hack-2026.devpost.com/).

---

## The problem

A Nigerian in London wants his mother in Kano to have a bag of rice. Today he
sends cash and hopes. The money gets spent on something else, skimmed by a
middleman, or lost to a fake-alert scam — fraud that is tooled and
subscription-scale now, not opportunistic: Nigerian fraud-prevention write-ups
describe a platform generating fake payment receipts promoted to 61,000+
Telegram subscribers, built specifically to exploit the delay between a real
transfer and the bank's alert. So he sends less, or only through relatives he
trusts.

The vendor has the mirror problem: she will not ship before payment, she gets
burned by forged transfer alerts, and mobile money settles days later minus up
to 5%.

Everyone competes on remittance fees. **Nobody sells certainty about what the
money became.**

| | |
|---|---|
| Remittances into Nigeria, 2025 | **$21.8bn** (CBN) / **$22.8bn** (World Bank) |
| Cost of sending to Sub-Saharan Africa | **8.46%** vs a 6.36% global average |
| Nigerian P2P stablecoin volume, 2022 → 2026 | **$2.3bn → $14.6bn** (Chainalysis) |
| Nigeria's rank, cross-border crypto flows | **#1 globally** |

The diaspora sender is the one person in this story who already holds dollars
on a chain. That is who Yazo is built for first.

## Who this is for, and how big the problem actually is

**Primary user: the vendor**, not the sender. The sender only has to trust
Yazo for the length of one payment; the vendor is the one whose daily workflow
actually changes. Today she decides whether to ship by reading a bank alert
and hoping it is real. With Yazo, she waits for the buyer-shown code instead —
one concrete habit swapped for another — and gets paid in Lightning-speed
seconds once it is shown, instead of a 5%-eaten mobile-money settlement days
later.

**Reach, stated honestly, not inflated.** This build has zero production
users — it is a hackathon submission running on Lightning's test network. Two
numbers worth separating: the market this sits inside is not small ($21.8bn in
2025 remittances; $14.6bn in Nigerian P2P stablecoin volume in 2026, per
Chainalysis — sourced in [`docs/roadmap.md`](docs/roadmap.md)), but the honest
target for a *first pilot* is a handful of vendors who already do
diaspora-funded business over WhatsApp — where 56% of Nigerian MSMEs sell
exclusively today (GSMA) — not a market-wide claim this build has not earned
yet. On technical capacity: a single Lightning channel carries up to 483
unsettled HTLCs per direction, so one channel supports hundreds of
simultaneous open escrows before that becomes the constraint; a vendor doing a
handful of orders a day is nowhere near it.

## See it live

```bash
npm run preview   # zero runtime dependencies - nothing to install first
```

Opens on `http://127.0.0.1:4178` with a fake (but behaviourally real — see
`src/lightning/fake.js`) Lightning node behind it, seeded with orders in every
state, so the dashboard has something real to show rather than an empty page.
Three pages, each with one job:

- **`/index.html`** — the pitch, and a live click-through demo of the actual
  order-row component the dashboard renders (not a screenshot of one).
- **`/onboarding.html`** — create a shop or sign back into one. No sign-up
  form, no password: a self-certifying key, shown once, is the entire account.
- **`/dashboard.html`** — the vendor's real order list, stats, and the
  create-shop flow's landing point.

Checked against a real 390px viewport at every step, not just at the end —
several genuine mobile bugs (a cramped sidebar, a row sizing itself off an
image's intrinsic aspect ratio rather than the actual viewport) were found and
fixed this way rather than assumed away.

## How it works

```
Payer (London)          Yazo server            Recipient (Kano)        Vendor
     |                  stores ONLY:                   |                   |
     |                  {salt, paymentHash,            |                   |
     |                   4 grant digests}              |                   |
  1. order $40 ──────────────> issues hold invoice      |                   |
     |              four one-role links go out: payer, recipient,          |
     |              vendor, proof — each can do only its own job           |
  2. pays ───────────> HTLC LOCKED in the network       |                   |
     |                        |                  3. gets secret (QR)        |
     |                        |                         └── shows code ──>  |
     |                        | <──── code ─────────────────────────────────┘
     |                   4. derives preimage, settles ──────────> PAID in seconds
     |
  5. no code before timeout ──> invoice cancelled ──> REFUNDED automatically
     (only the PAYER's link can trigger this — not the vendor's, not a copy
      of the order id forwarded in a group chat)
```

## The guarantee

A Lightning hold invoice can only be settled by whoever can produce the
*preimage*. Yazo derives the preimage from a secret only the recipient holds:

```
preimage    = sha256(DOMAIN || salt || secret)
paymentHash = sha256(preimage)
```

The server persists **only `{salt, paymentHash}`**. The secret and the preimage
are never stored. So the money cannot be released by the vendor, by the
platform, or by someone who steals the entire database — only by whoever holds
the secret handed to the recipient. Non-delivery has exactly one outcome: the
hold expires and the payer is refunded.

`test/attack.test.js` asserts this directly, including a test that hands an
attacker everything the server stores and proves it still cannot settle.

### The order id is not a password

Four people touch one order — the payer, the recipient, the vendor, and
whoever gets sent a receipt afterwards — and they do not all get to do the
same things. Each gets its own 128-bit **link key**, carrying only its own
capability:

| Link | Can | Cannot |
|---|---|---|
| `payer` | view, **cancel** | release |
| `recipient` | view, **release** | cancel |
| `vendor` | view, **release** | cancel |
| `proof` | view only | release or cancel |

The server stores a hash of each key, never the key itself, and hands all four
out exactly once, in the response that creates the order. Without this, the
order id alone was a single shared credential: a vendor who has already handed
over the goods — or anyone who was ever forwarded the link — could cancel the
order before the code was shown and take the payment back. `test/capability.test.js`
is the regression suite for that hole; every attack in it fails against the
earlier, unscoped design.

**[SECURITY.md](SECURITY.md)** carries the full threat model, the findings from
attacking our own code, and a register of automated security checks, each one
listed with the test file it lives in.

### Threat model, stated honestly

The two secret modes are **not** equally strong, and we say so rather than
implying a guarantee we cannot keep:

| Mode | Entropy | Holds against |
|---|---|---|
| **QR** (default) | 128-bit | Everyone, including us |
| **Typed** (8+ chars, for feature phones) | Low | The vendor — **not** a breached platform, which could brute force it offline |

Typed mode is therefore backed by a hard cap of 5 wrong attempts per order,
after which the order can only refund — and *why* it refunded (guess allowance
burned, versus the hold simply expiring, versus a plain cancel) is now
distinguishable in the order record, not collapsed into one generic
`REFUNDED` status. We would rather return the payer's money than let a guesser
who got close succeed.

### Why Lightning rather than a stablecoin chain

Lightning has a primitive that USDT on Tron or Base does not: a payment that is
**held**, then either delivered or returned, enforced by the network itself
rather than by our server or an admin button. That is the entire product.

Dollar amounts are fixed by a quote at lock time and the hold window is
bounded (6h default, 24h hard ceiling — see **Constraints** below), so price
drift is bounded and disclosed, not hidden. A stablecoin *payout option* — let
a vendor opt into a converted, price-stable settlement instead of sats, via an
existing licensed conversion partner rather than Yazo issuing or custodying
anything itself — is scoped on the roadmap, for the same reason: the vendor
currently carries 100% of the BTC price risk for the hold window with no way
to opt out, and that is a real, provable gap, not a hypothetical one.

## Architecture

```
Browser                              Yazo server                         Lightning
--------                             -----------                         ---------
index.html    ─┐
dashboard.html ├── fetch() ──>  HTTP API (src/http/server.js, views.js, guards.js)
onboarding.html┘                        │
                                         ├── EscrowService (src/escrow-service.js)
                                         │     ├── core/escrow.js       state machine
                                         │     ├── core/secret.js      secret → preimage
                                         │     ├── core/capability.js  per-role link keys
                                         │     ├── core/merchant.js    self-certifying vendor keys
                                         │     └── core/money.js       quote, sats conversion
                                         │
                                         ├── SqliteStore (src/store/) ── orders, events,
                                         │       webhook delivery queue, one transaction each
                                         │
                                         ├── Watcher (src/watcher.js) ── sweeps on a timer,
                                         │       refunds any hold whose window has passed
                                         │
                                         ├── WebhookSender (src/webhooks/) ── HMAC-signed,
                                         │       SSRF-checked delivery to a vendor's own server,
                                         │       enqueued in the same transaction as the state
                                         │       change that caused it
                                         │
                                         └── LndClient (src/lightning/client.js) ──> lnd
                                                 (AddHoldInvoice / LookupInvoice /
                                                  SettleInvoice / CancelInvoice — four calls,
                                                  nothing else, via invoice.macaroon only)
```

Zero runtime dependencies anywhere in this diagram. The core is pure
functions over plain objects; `src/lightning/fake.js` models everything lnd
enforces closely enough that the entire escrow flow — including the HTLC
timing and the hold invoice's own state machine — is verified with no node, no
chain, and no network.

## Status — what's actually built

**Working end to end on real Lightning nodes.** HTTP API, durable SQLite
storage, a watcher that refunds undelivered orders by itself, crash recovery
that reconciles against the node on boot, signed outbound webhooks with
SSRF-checked delivery and automatic retry/dead-lettering, and a complete
mobile-first web UI — landing page, vendor dashboard, and a standalone
create-shop/sign-in flow. **165 tests**, all passing, no network or real node
required to run them.

Both the delivered and undelivered journeys run against a live two-node
regtest network, and the channel balances settle to the sat:

```
delivered order : RELEASED  (vendor paid 42,106 sats)
undelivered one : REFUNDED  (payer kept 26,316 sats)
channel balance : alice 2,456,950 sat | bob 2,542,106 sat
```

Alice began with 2,499,056 sat and ends 42,106 lighter — exactly the delivered
order, and nothing else. The undelivered order moved no money at all.

### Constraints, stated rather than hidden

- **Testnet/regtest only.** No real money moves in this build. `npm run demo`
  and the live two-node network above are real Lightning mechanics against
  test funds, not a simulation of them.
- **24-hour hold ceiling.** A Lightning payment held too long risks forcing
  the channel carrying it to close, so Yazo is a good fit for same-day and
  next-day delivery today, not for a delivery that genuinely needs longer. The
  fix (a submarine swap to an on-chain hash-timelock contract, carrying the
  same guarantee past Lightning's ceiling) is the top item on the roadmap, not
  an afterthought — see [`docs/roadmap.md`](docs/roadmap.md).
- **One operator's Lightning node.** Every order settles through the node
  this deployment runs. Nostr Wallet Connect, letting a vendor settle to
  *their own* wallet instead, is scoped specifically to remove Yazo as that
  single point of custody.
- **Typed-code mode is weaker than QR**, by construction — see the threat
  model table above. It exists for feature phones, is capped at 5 wrong
  attempts, and the trade-off is stated rather than papered over.
- **Built solo, in a hackathon timeframe.** Two real scale limits were found
  and deliberately *not* rushed-fixed in the pre-submission audit — an O(n)
  scan on a vendor's order list, a sequential rather than concurrent watcher
  sweep — because neither matters at pilot scale and both carry real risk to
  fix hastily right before submission. They're on the roadmap, not hidden.

### Metrics worth tracking once this has real users

Named explicitly because a metric nobody decided to track in advance tends
never to get tracked: quote-to-lock conversion (orders created vs. actually
paid); time from `LOCKED` to `RELEASED` (the real-world signal on whether the
24h ceiling is a theoretical limit or one vendors actually hit); refund rate,
broken down by *reason* now that a refund's cause is distinguishable in the
record instead of collapsing into one generic status; webhook delivery
success and dead-letter rate; and guess-cap lockouts per order, as the live
signal on whether typed-code mode is too weak in practice rather than only in
theory.

## What's next

[`docs/roadmap.md`](docs/roadmap.md) is the full writeup — researched, sourced,
and honest about which claims in it are solid versus speculative. In priority
order: an on-chain hash-timelock contract so a hold can outlive what Lightning
alone tolerates (the one item marked must-do); a stablecoin payout option at
release time, integrating an existing licensed conversion partner rather than
Yazo issuing or custodying anything; escrowed payments for AI agents over
L402 — the same preimage-as-proof primitive this codebase already built for
human release secrets, pointed at machine-to-machine commerce instead, which
is the one item that costs almost nothing extra to build; and a share-to-chat
order handoff, since the vendor's real interface is WhatsApp, not a dashboard.

## Running it

```bash
npm test                # 165 tests, no network, node or database required
npm run preview         # the full web UI, seeded, no Lightning node needed
npm run regtest:up      # build a local 2-node Lightning network
npm run demo            # watch both journeys (delivered, undelivered) run for real
npm start               # the API on http://127.0.0.1:3000
```

The harness expects `lnd` and `btcd` binaries; point `LND_BIN` and `BTCD_BIN`
at them, or edit `scripts/regtest/config.mjs`. Add `--fresh` to `up.mjs` to
wipe and rebuild the network from nothing.

### Least privilege is real here

Yazo authenticates to lnd with `invoice.macaroon`, which can create and settle
invoices and nothing else. It cannot send funds, and it cannot even call
`getinfo` — the demo prints that refusal rather than hiding it.

## Repository hygiene

Node credentials are spending authority. `.gitignore` excludes macaroons, TLS
keys, wallet and channel databases, seeds, `.env` files and any preimage
material from the first commit onward, and `scripts/audit-staged.sh` scans
staged content for key material, seed phrases and live invoices before every
commit.

## Licence

MIT — see [LICENSE](LICENSE).
