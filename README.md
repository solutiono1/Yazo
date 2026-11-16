# Yazo

**Send the goods, not the cash.**

Yazo locks a dollar-priced payment on Bitcoin Lightning until the person
receiving the goods shows their delivery code. The vendor cannot take it early,
the platform cannot either, and if delivery never happens the money refunds
itself.

> Built for the [Dakar Bitcoin Hack by BTrust](https://dakar-bitcoin-hack-2026.devpost.com/).

---

## The problem

A Nigerian in London wants his mother in Kano to have a bag of rice. Today he
sends cash and hopes. The money gets spent on something else, skimmed by a
middleman, or lost to a fake-alert scam. So he sends less, or only through
relatives he trusts.

The vendor has the mirror problem: he will not ship before payment, he gets
burned by forged transfer alerts, and mobile money settles days later minus up
to 5%.

Everyone competes on remittance fees. **Nobody sells certainty about what the
money became.**

| | |
|---|---|
| Remittances into Nigeria, 2025 | **$21.8bn** (CBN) / **$22.8bn** (World Bank) |
| Cost of sending to Sub-Saharan Africa | **8.46%** vs a 6.36% global average |
| Nigeria's rank, cross-border crypto flows | **#1 globally** |
| Crypto-active Nigerian adults holding USDT | **59%** |

The diaspora sender is the one person in this story who already holds dollars
on a chain. That is who Yazo is built for first.

## How it works

```
Payer (London)          Yazo server            Recipient (Kano)        Vendor
     |                  stores ONLY:                   |                   |
     |                  {salt, paymentHash}            |                   |
  1. order $40 ──────────────> issues hold invoice      |                   |
  2. pays ───────────> HTLC LOCKED in the network       |                   |
     |                        |                  3. gets secret (QR)        |
     |                        |                         └── shows code ──>  |
     |                        | <──── code ─────────────────────────────────┘
     |                   4. derives preimage, settles ──────────> PAID in seconds
     |
  5. no code before timeout ──> invoice cancelled ──> REFUNDED automatically
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

### Threat model, stated honestly

The two secret modes are **not** equally strong, and we say so rather than
implying a guarantee we cannot keep:

| Mode | Entropy | Holds against |
|---|---|---|
| **QR** (default) | 128-bit | Everyone, including us |
| **Typed** (8+ chars, for feature phones) | Low | The vendor — **not** a breached platform, which could brute force it offline |

Typed mode is therefore backed by a hard cap of 5 wrong attempts per order,
after which the order can only refund. We would rather return the payer's money
than let a guesser who got close succeed.

### Why Lightning rather than a stablecoin chain

Lightning has a primitive that USDT on Tron or Base does not: a payment that is
**held**, then either delivered or returned, enforced by the network itself
rather than by our server or an admin button. That is the entire product.

Dollar amounts are fixed by a quote at lock time and the hold window is short
(6h default, matching same-day delivery), so price drift is bounded and
disclosed. Native dollar-denominated escrow is the next step, and the API for
it already ships: Taproot Assets' `AddInvoice` accepts `asset_amount` together
with `hodl_invoice`.

## Status

Working: the escrow engine — money math, secret derivation, state machine —
with 36 tests including the adversarial suite.

Next: the Lightning adapter against a local regtest node, then the mobile-first
web UI.

## Running it

```bash
npm test              # 36 tests, no network or database required
```

The core is pure functions over plain objects: no network, no database, no
clock of its own. The Lightning layer is a thin adapter that reacts to its
transitions.

## Repository hygiene

Node credentials are spending authority. `.gitignore` excludes macaroons, TLS
keys, wallet and channel databases, seeds, `.env` files and any preimage
material from the first commit onward, and `scripts/audit-staged.sh` scans
staged content for key material, seed phrases and live invoices before every
commit.

## Licence

MIT — see [LICENSE](LICENSE).
