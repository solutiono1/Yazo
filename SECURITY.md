# Security

Yazo holds other people's money in a Lightning channel and releases it on a
code. This document states what is guaranteed, what is not, what we found when
we attacked it ourselves, and how every claim here can be checked.

Nothing in this file is asserted without a test behind it. Run `npm test`.

---

## The guarantee

A Lightning hold invoice can only be settled by whoever can produce its
*preimage*. Yazo derives the preimage from a secret that only the recipient
holds:

```
preimage    = sha256(DOMAIN || salt || secret)
paymentHash = sha256(preimage)
```

The server persists **only `{salt, paymentHash}`**. The secret is returned once
at order creation and then forgotten; the preimage is never stored at all.

Therefore the money cannot be released by:

- the **vendor**, who never sees the secret
- the **platform**, which stores nothing that yields the preimage
- an **attacker holding the entire database**, for the same reason

Non-delivery has exactly one outcome: the hold expires and the payer is
refunded, by a watcher that runs whether or not anyone asks.

## Threat model

### What we defend against

| Adversary | Capability | Outcome |
|---|---|---|
| Malicious vendor | Sees the order, the invoice, the payment hash | Cannot release without the recipient's code |
| Database thief | Full read of every stored byte | Cannot derive any preimage |
| Malicious platform operator | Full server access | Cannot release a **QR-mode** order |
| Network guesser | Unlimited requests | Five wrong codes per order, for all time, then refund |
| Racing client | Many simultaneous requests | One order is processed one at a time |
| Crashed server | Dies mid-settlement | Reconciles from the node on boot |

### What we do **not** defend against, stated plainly

- **Typed-code mode against a breached platform.** A short typed code is
  low-entropy. Anyone holding `{salt, paymentHash}` can brute force it offline.
  Typed mode protects the payer against the *vendor*, not against *us*. QR mode
  (128-bit) is the default and holds even against us.
- **A compromised lnd node.** Whoever controls the node controls the channel.
  Yazo authenticates with `invoice.macaroon`, which cannot send funds and cannot
  even call `getinfo`, but that is a limit on Yazo, not on an attacker who owns
  the node itself.
- **Collusion between payer and recipient** to claim non-delivery. The code is
  the only evidence of delivery; a recipient who takes the goods and refuses to
  show the code causes a refund. This is a deliberate trade: the alternative is
  trusting the vendor.
- **Traffic analysis.** Order links are unguessable but are plain capabilities;
  anyone who obtains one can read that order.
- **Price movement during a hold.** Amounts are fixed in sats at quote time. A
  six-hour window bounds exposure; it does not eliminate it.

## Findings from the self-audit

Both were found by attacking our own code, both are fixed, and both have a
regression test that fails against the old behaviour.

### 1. Preimage was accepted on shape, not on value — *critical*

`apply()` checked that a release preimage was a 32-byte Buffer, and nothing
else. `Buffer.alloc(32)` — thirty-two zero bytes — satisfied that check and
marked an order `RELEASED`.

In production this is a state-desync hole: our database records a vendor as
paid while Lightning never settled. **Fixed** by verifying
`sha256(preimage) === order.paymentHash` with a constant-time comparison before
any release. Test: *release is impossible without a real preimage*.

### 2. The guess cap could be outrun by firing in parallel — *high*

Every decision is read-then-write. Twenty-five simultaneous wrong codes each
read `failedReleaseAttempts = 0` and each wrote `1`, so twenty-five guesses
counted as **one**. The five-attempt cap — the entire defence for a short typed
code — was defeated by concurrency.

**Fixed** with a per-order mutex (`src/keyed-mutex.js`): one order is processed
one request at a time, while different orders still run freely. Tests in
`test/concurrency.test.js`.

### 3. A subscription that never worked looked exactly like one with nothing to report

`subscribeInvoice` was written, shipped and described in a commit message as
giving payers immediate confirmation — and nothing ever called it. When it was
wired in, it still produced no updates: lnd's REST gateway rejects `base64url`
on that path parameter, the frame parser only emitted on a newline that lnd
does not reliably send, and HTTP error statuses were never checked, so a
rejected subscription hung for ever while appearing healthy.

Fixed on all three counts, and subscription errors now surface through
`onError` instead of returning quietly. Payment detection against a real node
went from up to 15 seconds (the sweep) to **217 ms**. The sweep remains the
safety net: a subscription is an optimisation and is never what a refund
depends on.

### 4. Lesser items, also fixed

- Order ids were time-based and sequential, letting anyone walk the whole book.
  Now 128 bits of randomness.
- Reconciliation rewrote state without touching history. A state change with no
  audit entry is indistinguishable from tampering; corrections now append a
  `RECONCILED` event.
- Event streams were unbounded, each costing two timers and a socket. Now
  capped, with `503` and `Retry-After` beyond the limit.
- `.gitignore` used `regtest/`, which matched *any* directory of that name and
  silently excluded `scripts/regtest/`. Anchored to the repo root.

## The register — 49 checks

Every line is an automated test. The count is the number of checks, not a
marketing number; if a check is removed, this table shrinks.

### Release guarantee (8)

| # | Check | Where |
|---|---|---|
| 1 | Payment hash commits to a preimage derived from the secret | `secret.test.js` |
| 2 | The right secret recovers the preimage; a wrong one yields null | `secret.test.js` |
| 3 | A full database breach still cannot settle | `attack.test.js` |
| 4 | A code from another order cannot be replayed | `attack.test.js` |
| 5 | The vendor cannot release without the code | `attack.test.js` |
| 6 | A preimage must hash to *this* order, not merely be 32 bytes | `escrow.test.js` |
| 7 | Near-miss secrets leak nothing through the comparison | `attack.test.js` |
| 8 | A receipt cannot be forged for unreleased money | `attack.test.js` |

### Guess limiting (5)

| # | Check | Where |
|---|---|---|
| 9 | Five wrong codes per order, for all time | `attack.test.js` |
| 10 | Simultaneous guesses cannot outrun the cap | `concurrency.test.js` |
| 11 | Exhausting the cap refunds the payer automatically | `service.test.js` |
| 12 | A typed secret below minimum entropy is refused | `attack.test.js` |
| 13 | Release attempts are rate limited per client | `http.test.js` |

### Money integrity (12)

| # | Check | Where |
|---|---|---|
| 14 | Underpayment does not lock an order | `attack.test.js` |
| 15 | A correct code after the window still cannot take the money | `attack.test.js` |
| 16 | Expiry cannot be forced early | `attack.test.js` |
| 17 | Replaying the settling event is refused | `attack.test.js` |
| 18 | Simultaneous releases pay the vendor exactly once | `concurrency.test.js` |
| 19 | Simultaneous refunds cancel exactly once | `concurrency.test.js` |
| 20 | A release racing a refund resolves one way, not both | `concurrency.test.js` |
| 21 | Terminal orders reject every further event | `escrow.test.js` |
| 22 | A stale quote cannot mint an invoice | `escrow.test.js` |
| 23 | Sats round up, so a vendor is never underpaid | `money.test.js` |
| 24 | An absurd oracle price is refused, not used | `money.test.js` |
| 25 | Order size bounds are enforced | `money.test.js` |

### Channel safety (1)

| # | Check | Where |
|---|---|---|
| 26 | Final CLTV outlives the hold window, so HTLCs cannot force-close channels | `escrow.test.js` |

### Secret handling (4)

| # | Check | Where |
|---|---|---|
| 27 | The store refuses to persist anything named secret, preimage or macaroon | `store.test.js` |
| 28 | No secret or preimage appears anywhere on a stored order | `escrow.test.js` |
| 29 | The salt never leaves the server | `http.test.js` |
| 30 | The secret is returned exactly once, at creation | `http.test.js` |

### State integrity (5)

| # | Check | Where |
|---|---|---|
| 31 | Orders cannot be mutated in place | `attack.test.js` |
| 32 | Orders come back from storage frozen | `store.test.js` |
| 33 | The event journal is append-only | `store.test.js` |
| 34 | A reconciliation is recorded, never applied silently | `hardening.test.js` |
| 35 | Two orders can never share a payment hash | `store.test.js` |

### Crash recovery (4)

| # | Check | Where |
|---|---|---|
| 36 | Settled-but-unrecorded is repaired on boot | `watcher.test.js` |
| 37 | Cancelled-but-unrecorded is repaired on boot | `watcher.test.js` |
| 38 | Paid-while-we-were-down is repaired on boot | `watcher.test.js` |
| 39 | One unreadable order does not stop recovery | `watcher.test.js` |

### HTTP surface (7)

| # | Check | Where |
|---|---|---|
| 40 | CSP and hardening headers on every response | `http.test.js` |
| 41 | Input is rejected, never coerced | `http.test.js` |
| 42 | Oversized bodies are refused | `http.test.js` |
| 43 | Path traversal cannot escape the public directory | `http.test.js` |
| 44 | Order ids that are not ours are rejected | `http.test.js` |
| 45 | Internal errors never leak details | `http.test.js` |
| 46 | Open event streams are capped | `hardening.test.js` |

### Live payment detection (3)

| # | Check | Where |
|---|---|---|
| 47 | A payment is seen the moment it lands, with no sweep | `hardening.test.js` |
| 48 | A subscription is dropped once an order is terminal | `hardening.test.js` |
| 49 | The service still works against a node with no subscription support | `hardening.test.js` |

## Operational notes

- Yazo uses **`invoice.macaroon`**, not `admin.macaroon`. It can create and
  settle invoices and nothing else. The demo prints the resulting
  `permission denied` on `getinfo` rather than hiding it.
- No third-party origins. No CDN, no analytics, no external fonts, no price
  API. The CSP is `default-src 'self'` and the exchange rate is configuration,
  so nothing about an order depends on a third party being reachable.
- The database is SQLite with `journal_mode=WAL` and `synchronous=FULL`.
  Durability is chosen over speed because an order is a claim on money held in
  a live channel.
- Node credentials, chain state, wallets, seeds and `.env` files are excluded
  from version control, and `scripts/audit-staged.sh` scans staged content for
  key material before every commit.

## Reporting a vulnerability

Open an issue at <https://github.com/solutiono1/Yazo/issues>. If it concerns
money movement, describe the attack rather than posting a working exploit, and
a maintainer will respond before details are published.
