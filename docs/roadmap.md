# Where Yazo goes next

A working note, written after a second research pass. It exists because Yazo
is not meant to end as a hackathon entry: the question driving it is what a
real business on this idea would have to be true about, and what is missing
today.

Each pain point below is evidence first, conclusion second. Where a source is
weak, it says so rather than borrowing its confidence.

---

## 1. What the research actually found

### 1.1 The fake-alert problem is industrial, not anecdotal

Yazo's whole premise is that a transfer is not a delivery. That premise holds
up harder than expected.

- Nigerian fraud-prevention writing describes a **"double alert"** tactic: the
  buyer makes one small real transfer and supplies a forged alert for the
  balance, so the seller believes the full amount landed.
- A regional intelligence brief describes a **platform that generates fake
  payment receipts, promoted to 61,000+ Telegram subscribers**, which works by
  exploiting the delay between a real transfer and the bank's alert.
- NIBSS-sourced reporting puts Nigerian digital payment fraud losses at
  **₦25.85bn in 2025**, down about 51% from ₦52.26bn in 2024.
- The consistent advice given to sellers is that **the only trustworthy check
  is the actual account balance**, never an SMS or a screenshot.

**Conclusion.** The fraud Yazo targets is tooled, subscription-scale, and
specifically attacks the gap between *claimed* payment and *settled* payment.
A Lightning hold closes that gap by construction: there is no alert to forge,
because the vendor is not asked to believe anything. That is the pitch, and it
should be said in those words.

**Caveat.** The strongest numbers here (NIBSS) are about payment fraud broadly,
not about undelivered goods specifically. I found no dataset isolating
"diaspora buyer paid, goods never arrived." Do not claim one exists.

### 1.2 The fiat rails Yazo bypasses are tightening

- The Central Bank of Nigeria has **banned foreign-currency payouts for
  diaspora remittances from 1 May 2026**, directing International Money
  Transfer Operators to settle exclusively through designated naira accounts.

**Conclusion.** This is positioning, not a feature. Yazo is not an IMTO and
does not move naira, so it sits outside that particular squeeze — but the
direction of travel is more regulation of cross-border value, not less. A real
business here needs a deliberate compliance posture before it needs more
features. That belongs on this roadmap as a workstream, not a footnote.

### 1.3 Yazo's hard ceiling: Lightning will not hold money for days

This is the most important technical finding, and it is a limit, not a bug.

- An unsettled HTLC that reaches its **CLTV expiry forces a channel close**,
  costing on-chain fees and locking capital. This is how naive hold-invoice
  designs lose channels.
- A channel carries at most **483 concurrent HTLCs per direction**, so a
  modest number of simultaneous holds can saturate it — the channel-jamming
  surface.
- Some routing nodes **cap how long they will hold an HTLC** and will fail
  anything longer, so a long hold may simply not route.

**What Yazo already does.** This was handled before the research, and the
research confirms the approach rather than correcting it: the final CLTV is
derived from the hold window plus 40 blocks of slack
(`requiredFinalCltvBlocks`), the invoice is created to outlive the window, the
hold defaults to 6h with a 24h hard ceiling, and a watcher refunds on expiry
without anyone asking.

**What it does not solve.** 24h is a ceiling imposed by physics, not by
product choice. A bag of rice moving London → Kano can take longer than that.
**Yazo today cannot escrow a delivery that takes three days.** That is the
single biggest gap between what Yazo is and what the pitch implies, and it is
item 1 on the roadmap below.

### 1.4 The vendor does not live in a dashboard. They live in a chat.

- GSMA: **56% of Nigerian MSMEs sell online exclusively through social media**;
  another 19% combine social with a site or marketplace.
- PwC (2024): **WhatsApp Business is the most-used technology among surveyed
  MSMEs**, at 23%.
- Nigeria's Minister of Communications: **67% of online purchases reportedly
  begin with a chat**.
- From **1 October 2026 Meta began charging businesses per message** on the
  WhatsApp Business platform, which bites hardest at the micro end.

**Conclusion.** Two things follow, and the second is the non-obvious one.

1. Yazo's real interface is **a link pasted into a chat**, not a dashboard. The
   dashboard is where a vendor checks on things; the chat is where they sell.
2. Building on the **WhatsApp Business API would be a mistake right now** — it
   now costs per message and needs Meta approval. The right move is the free
   one: a prefilled `wa.me` link, a copyable message, and a QR. Zero per-message
   cost, no platform dependency, works on day one.

**Caveat.** User-count figures for WhatsApp in Nigeria conflict wildly between
sources (51m vs 90m). The GSMA, PwC and ministerial figures are the ones worth
repeating; the blog numbers are not.

### 1.5 If Yazo touches Nostr, it should not build a marketplace

- **NIP-15** (the Nostr marketplace protocol) is marked in the canonical NIPs
  repository as **draft, optional and unrecommended**, with the note that it
  became too complicated; NIP-99 is pointed at instead. A 2026 discussion also
  flags its reliance on deprecated NIP-04 DMs as a drawback.
- The live, useful pieces are **NIP-47 (Nostr Wallet Connect)** for connecting
  a wallet, and **NIP-17** for private messaging.

**Conclusion.** Implementing NIP-15 would be building on something its own
authors discourage. The two genuinely valuable Nostr integrations for Yazo are
narrower and better: NWC so a vendor settles to *their own* wallet, and private
DMs as a delivery channel for the release code.

---

## 2. What got built in this pass

### Signed, durable webhooks (`src/webhooks/`)

Yazo already had an SSE stream, which is fine for a browser watching one order
and useless for a merchant's server. Webhooks are what turns Yazo from an app
into something other software can be built on.

What it does, and why each part is there:

- **A delivery is enqueued in the same database transaction as the state change
  that caused it.** Not after. A crash between committing a release and queuing
  its notification would otherwise lose the notification for money that really
  moved.
- **Every delivery is HMAC-SHA256 signed over `${timestamp}.${body}`**, sent as
  `Yazo-Signature: t=…,v1=…`. The timestamp is inside the signed material so a
  captured delivery cannot be replayed forever; receivers reject anything
  outside a five-minute window. `verifySignature()` is exported so integrators
  get the reference implementation rather than a prose description of it.
- **The target is checked twice** — once as written (scheme, credentials,
  literal private addresses) and again at send time against what the hostname
  actually resolves to. A vendor hands us a URL our server will fetch; left
  unchecked that is a server-side request forgery primitive, and
  `169.254.169.254` is the address that makes it expensive.
- **Redirects are refused, not followed**, because a 302 would otherwise walk
  straight past both of those checks.
- **Retries back off** (10s → 1m → 5m → 25m → 2h) and then dead-letter with the
  last error kept, rather than retrying a broken endpoint forever.
- **The body is the same projection the API serves** (`orderView`), so a webhook
  can never expose a field the HTTP layer would have withheld.

Routes: `PUT`/`GET`/`DELETE /api/merchants/webhook`, authenticated by merchant
key. The signing secret is returned exactly once — the same rule as the
merchant key and the release secret.

### A router fix this surfaced

Registering three methods on one path exposed that the router returned 405 at
the first *path* match, so any path could only ever carry one method and the
second route registered on it was unreachable. Now it matches path first, then
method, and only 405s when the path matched but no method did.

---

## 3. Roadmap

Ordered by what would most change whether this can be a business.

### P0 — Escrow that outlives a Lightning hold

The 24h ceiling (§1.3) is the gap between the product and the pitch. Options,
roughly in order of how much they cost to be wrong:

1. **Make the limit explicit and honest first.** Surface the hold window in the
   order UI and the docs, and refuse to create an order whose promised delivery
   obviously exceeds it. Cheap, immediate, and stops Yazo over-promising.
2. **On-chain HTLC for long holds.** Same hash, same release secret, different
   rail. Slower and costs fees, but has no 24h ceiling.
3. **Two-phase:** Lightning for the deposit, with the escrow held off-HTLC and
   re-invoiced on release. Needs a custody story — which is exactly the trust
   Yazo removed, so it is last for a reason.

Decide by writing the threat model for each, not by picking the easiest.

### P1 — Share-to-chat order handoff

Directly from §1.4. A created order should produce, in one tap: a short link, a
prefilled `wa.me` message, a copyable block of text, and a QR. No WhatsApp
Business API, no per-message cost. This is probably the highest
value-per-hour item on the list.

Blocked on the order-creation screen, which does not exist yet — the real
order+pay flow is still API-only.

### P1 — The order creation flow itself

The dashboard lists orders but cannot create one. Until that exists, a vendor
cannot actually use Yazo without curl.

### P2 — Nostr, narrowly (§1.5)

- **NIP-47 / Nostr Wallet Connect** — let a vendor connect their own Lightning
  wallet so Yazo stops being the one node everything settles through. This is
  the strongest decentralisation story available and removes Yazo as a single
  point of custody.
- **NIP-17 private DMs** — deliver the release code to the recipient over Nostr.
  Censorship-resistant, no SMS cost, and no phone number required.

### P2 — Reaching a recipient who has no smartphone

Typed codes exist for feature phones, and are weaker than QR codes precisely
because a human can be talked into reading one aloud. USSD or SMS delivery
would widen reach, but both reintroduce a telco dependency and a cost per
message. Worth designing before building.

### P2 — Merchant tooling

- API keys with scopes, distinct from the all-powerful merchant key.
- CSV export for bookkeeping.
- A hosted API reference, generated from the routes rather than hand-written.

### P3 — Dispute path

Today an order either releases or refunds. Real commerce has a middle: goods
arrived damaged, or partially. Any answer here involves a human arbiter, which
is new trust — so this needs a design that keeps Yazo out of the judging seat.

### Ongoing — Compliance posture (§1.2)

Not a feature, and not optional for a real business. Needs a written position
on what Yazo is and is not under Nigerian and EU rules before it holds anyone's
money for real.

---

## Sources

Fraud and remittance context:
- https://www.clari5.com/africa-regional-intelligence-brief-october-2026-roundup-newsletter/
- https://cire.com.ng/blogs/how-to%20spot-fake-arlert
- https://www.legit.ng/business-economy/money/1741496-nersi-scam-alert-6-fake-messages-nigerians-receiving-n50000-grant/
- https://allafrica.com/stories/202603260150.html

Lightning hold invoices:
- https://voltage.cloud/blog/understanding-hold-invoices-on-the-lightning-network
- https://www.spark.money/glossary/hodl-invoice
- https://learn.robosats.org/docs/escrow/

Chat commerce:
- https://avodagroup.org/whatsapp-tiktok-commerce-africa/
- https://www.researchgate.net/publication/415537467_Social_Commerce_as_a_Pathway_to_Financial_Inclusion_A_Policy_Analysis_of_WhatsApp-Based_Retail_in_Nigeria_Amidst_Rising_Platform_Costs
- https://thebusinesstimesng.com/from-websites-to-whatsapp-sales/

Nostr commerce:
- https://www.crays.org/nostr/commerce/standards/
- https://github.com/lnbits/nostrmarket
