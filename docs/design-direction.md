# Design direction

Written after studying talise.io and comparta.xyz directly, before any pixel
was drawn. This is the record of what was decided and why, so later work
(the four app screens) stays consistent with it rather than drifting.

## What the research actually found

**awsmd.com is not a motion gallery.** It's the marketing site of Awsmd, a
dev/design agency (mobile apps, Figma, web). There's no catalogue of
animation techniques to extract from it. Motion decisions below come from
general current practice, not from that site — flagged here so it isn't
quietly treated as sourced when it wasn't.

**Talise uses no photography at all.** Its only imagery is a set of 3D-style
icons (send, globe, lock, piggy-bank, …) and card-skin images. No people, no
lifestyle photos, no AI-looking faces. Copy is terse — 5–12 word sentences —
and the page structure is a conventional fintech stack: hero, feature grid,
abroad/card/earn sections, safety section, closing CTA. Hero headline:
*"Dollars that move like messages."*

**Comparta leans on illustration, 3D icons, and dashboard screenshots**, not
confirmed lifestyle photography (the fetch could not render images, only
filenames — the NYLifeStyle photo credits mentioned earlier were not actually
present in the live markup). Copy voice: confident, fragment-driven,
contrast-based — *"Banks make you wait. We don't."* Structure: hero, feature
grid, contrast block, persona cards, FAQ, closing CTA.

**The shared signal, independent of either site's specifics:** light canvas,
pill-shaped buttons, tight negative letter-spacing on big display type, and a
short declarative hero sentence rather than a paragraph. Two unrelated teams
converging on the same three choices is worth following. Everything else
below is Yazo's own, not borrowed.

## Decisions

**Typography.** Clash Display for headings, General Sans for body — both
Fontshare (Indian Type Foundry) releases, free for commercial use, licence
explicitly permits self-hosting. Downloaded, extracted, and shipped as local
`.woff2` files under `public/fonts/`; nothing is fetched from a font CDN at
runtime, which matches the CSP (`default-src 'self'`) this app already
commits to. Licence text kept at `vendor/fonts/`.

**Colour.** A warm paper canvas (not stark white) with a near-black warm ink,
and one accent — a Lightning gold — used sparingly. Neither reference defines
a semantic colour ramp (both explicitly have none), so Yazo's is original and
tied to what can actually happen to an order, not to decoration:

| State | Colour | Meaning |
|---|---|---|
| Locked | amber | a hold is active |
| Released | deep green | the vendor was paid |
| Refunded | deep teal/blue — deliberately **not** red | the system returned the money correctly; a refund is not a failure |

**No mascot.** The brainstorming prompt that came with this brief included a
full mascot/character system. Neither reference uses one, and Yazo's
positioning is "audited like it holds real money" — a cute character cuts
against that register rather than supporting it. Declined; a simple geometric
motif (the hold/lock shape already in the wordmark and favicon) carries the
brand instead.

**Imagery: icons and diagrams, not stock photography.** Both references
favour icon- and illustration-led visual storytelling over lifestyle photos,
and that turns out to be the right call here too: sourcing authentic,
non-AI, correctly-licensed photography of "a Nigerian market" or "a diaspora
sender" without it reading as generic stock is a real risk, and a wrong
guess reads as worse than no photo at all. The four hand-drawn line icons
(hold, code, release, receipt) and the formula/flow diagrams are bespoke SVG,
written directly as path data — not sourced from an icon CDN, not
AI-generated.

**Motion.** Calm, not bouncy: scroll-reveals (fade + 16px rise, `cubic-bezier(0.16,1,0.3,1)`),
a count-up on the three stat numbers the first time they're seen, a hover
lift on cards and the primary button, and an underline wipe on nav links.
Everything is inert under `prefers-reduced-motion`, and nothing requires
WebGL or a library.

**Legal readiness, scoped to what's actually true today.** Yazo currently
sets no cookies, has no accounts, and stores no identity beyond a first name
label on an order — so the honest move is to *say that plainly* rather than
ship a cookie-consent banner for cookies that don't exist, or a Terms of
Service page implying a licensed money-service business this testnet build
isn't. The footer states the testnet status and data-minimisation stance
directly. Revisit this the day real funds or accounts are added.

## What's built

- `public/css/fonts.css` — self-hosted `@font-face`, no CDN
- `public/css/tokens.css` — colour/type/space/radius/motion tokens, with a
  dark-mode variant computed from the same palette
- `public/css/base.css` — reset, focus rings, `prefers-reduced-motion` kill switch
- `public/css/landing.css` — the landing page only; app screens get their own sheet
- `public/js/motion.js` — scroll reveals, stat count-up, smooth anchor scroll; zero dependencies
- `public/index.html` — the landing page
- `scripts/preview.mjs` (`npm run preview`) — serves the real HTTP app with a
  `FakeLnd` behind it, so the frontend can be reviewed without the regtest network

Verified against the real server (`src/http/server.js`), not opened as a bare
file: every asset returns 200 with the CSP headers intact, and no inline
`style=`/`<script>` exists anywhere in the page (the CSP has no
`unsafe-inline`, so that isn't optional).

## Navigation: landing vs. app

The landing page keeps a top nav that collapses into a floating island once
the page scrolls (narrower, pill-shaped, shadowed) and reverts to the full
width bar the moment the page is back at the top (`#siteNav`, `.is-scrolled`,
handled by a rAF-throttled scroll listener in `public/js/motion.js`). That
pattern is for the marketing page only.

The four product screens (order + pay, show-the-code, collect, receipt) get a
**sidebar**, not a top nav. A capability-scoped screen is closer to a tool
than a page you scroll through, and a sidebar leaves room to grow into
multiple orders later without a redesign. Not built yet.

## Accounts and identity

**There are no accounts today, on purpose.** An order mints four link keys
(`payer`, `recipient`, `vendor`, `proof`), each scoped to exactly one
capability (`src/core/capability.js`). That is already a form of identity:
whoever holds the `payer` link *is* the payer, as far as the system is
concerned, with no email, password or session required. For a payer who uses
Yazo once a month and a recipient who may use it once ever, that is the right
amount of friction: zero.

**The one real gap: a vendor who takes many orders has no single place to
see them all.** Right now that vendor collects one capability link per order
and has to keep track of each. The fix is not a username-and-password
account. It is a **merchant key**: a vendor picks a shop name once, gets back
one long-lived capability credential, and that key is scoped to "view and
collect on every order created under this `vendorId`" rather than one order.
It is the exact same mechanism `capability.js` already implements, extended
by one more scope, not a parallel auth system with sessions, password
resets, or email infrastructure bolted on beside it. That merchant key is
also exactly what the sidebar above is for: today it shows one order; the
day a merchant key exists, it lists all of them.

**Not building this before the deadline**, deliberately. The four
role-scoped links are the actual demonstration of the idea; a multi-order
vendor dashboard is a real improvement but not what's being judged, and
login/session machinery is more surface area to audit under a clock that's
already running. Documented here so it isn't lost, built only if time
remains after the four core screens.

## Round 2: real screen recordings, a real mobile bug, and a font correction

Watched two of the user's own screen recordings before touching anything
else, per instruction: Talise's actual logged-in app (not just its
marketing page) and Comparta's full onboarding through to its dashboard.

**Talise's app**, not just its site: a "Choose your Talise name" onboarding
modal with a skip option, a big centered balance (`₦0.00`), two pill
buttons (`Add money` filled, `Send` outlined), an empty-activity state with
an icon and a CTA, and an Earn tab with an APY chart and a short account
list. Confirms the token system here (pill buttons, big display balance,
quiet empty states) is pointed the right way.

**Comparta's onboarding**: a split screen repeated across every step - a
full-bleed, confident, candid photo (a man walking, looking up at the sky)
on one side, the actual form on the other ("Create account" → business vs.
individual → "Finish setting up": org name, full name, country, role →
"Continue to dashboard"). The photography is real, warm, and specific, not
generic stock - worth saying plainly, because it contradicts what the
earlier text-only fetch of the same site could not confirm. The dashboard
that follows: sidebar nav, a greeting, a row of quick-action buttons, and
two-column summary cards.

**Correction to the earlier "no stock photography" call.** That decision
stands for the *landing* page, where hand-drawn icons keep the story
ownable without betting on found photography. But Comparta's onboarding
proves curated, specific, real photography (not generic stock) earns its
keep in a *flow*, not just a hero. Yazo's order-creation screen is the
right place to revisit this - noted as an open call for whoever builds
that screen, not decided here.

### A real mobile bug, found and fixed with the right tool

`--window-size` on headless Chrome's `--screenshot` does **not** set the
CSS layout viewport - it renders at a desktop width and crops the image to
the requested pixel size. Every earlier "mobile" screenshot in this session
was measuring that crop, not a phone. Confirmed with a two-line test file
and fixed by driving Chrome through the DevTools Protocol directly
(`Emulation.setDeviceMetricsOverride` with `mobile: true`), which is what
Puppeteer and Playwright do under the hood and is the only way to get an
honest mobile render from the CLI.

Real mobile rendering (390×844, 2x) surfaced one actual bug, not the
overflow first suspected: on the dashboard, `.app-main`'s padding and
`.stat-grid`'s column count were each declared twice - once inside a
`@media (max-width: 860px)` block placed near the *top* of
`dashboard.css`, and once again, unconditionally, by a later rule of equal
specificity further down the file. Same-specificity rules resolve by source
order, so the later, non-mobile rule always won, silently cancelling the
responsive one. The symptom: the fixed mobile menu button sat on top of the
page heading, because the padding meant to clear it was never actually
applied. Fixed by moving every media query in `dashboard.css` to the end of
the file, after every base rule it touches - the only ordering that can't
lose this way. `public/css/base.css` also gained a defensive
`overflow-x: hidden` backstop on `body`, and `.formula`'s missing
`white-space: pre` (which made its three-line code block collapse and
reflow like prose on a narrow screen) is fixed too.

The mobile sidebar had no way to open at all - the CSS hid it off-canvas
but nothing ever showed a toggle. Added a fixed hamburger button, a
backdrop that closes it on tap, and verified the open/close interaction by
driving an actual click through the DevTools Protocol, not by reading the
CSS and assuming.

### Font correction: evidenced, not guessed

The user's own DevTools screenshots of talise.io show its computed
`font-family` naming **"Neue Montreal"** directly inside the fallback
chain - confirmation, not a guess, that the real font is related to PP
Neue Montreal (Pangram Pangram), a paid commercial face. Clash Display -
the earlier pick - is a different, more expressive geometric display face;
closer in spirit but not in actual letterform. Replaced it everywhere with
**Switzer** (Fontshare, free for commercial use, self-hosted under
`public/fonts/`), the standard free substitute for Neue Montreal: a
single-family, 100–900 variable neo-grotesque that reads correctly at both
display and body sizes, the way Talise's own type does. General Sans stays
for body where Switzer at small sizes reads slightly too wide; worth
revisiting once real copy is finalised.

### Icon assets: a concrete sourcing plan, not yet pulled in

Talise's own icon language is glossy 3D renders (padlock, globe,
verification badge, paper plane, piggy bank), not flat line icons - the
user's own research surfaced two free, human-made, non-AI sources that
cover exactly the shapes Yazo already needs: **ICONZ** (480 handcrafted 3D
icons, free) and **Craftwork's Essential Objects pack** (padlock, trophy,
bell, badge). The plan: pull a padlock (the hold), a verification badge
(released), a paper plane (send), and a globe (cross-border) from one of
these two packs to replace the current hand-drawn line icons in the hero
and how-it-works strip. Not done yet - the next concrete step, not a
deferral.

## What's next

1. Design the order-creation screen (the real equivalent of Comparta's
   onboarding split-screen) - the actual order+pay flow, not yet built.
2. The remaining three product screens (show-the-code, collect, receipt)
   on this same token set, icon language, and sidebar pattern.
3. **Before submission: re-read and rewrite README.md from scratch once
   the UI work above is done.** It was written early and hasn't been
   revisited against what actually shipped since - it needs to match the
   real screens, the real stack (see below), and speak directly to the
   judging criteria (problem -> solution -> impact -> next steps,
   architecture, constraints, metrics to track). Not a task for now;
   a hard gate before the hackathon submission goes in.

## The actual stack, for anyone reading the repo

GitHub's language bar only sees source bytes, not what's running, so it
undercounts what this project touches. For the record:

- **Backend**: plain Node.js (>=22), zero npm dependencies by design -
  `node:https`, `node:sqlite`, `node:test`, nothing installed before a
  judge can run it. See `src/store/sqlite.js` and `src/lightning/client.js`
  for why that's a deliberate choice, not an oversight.
- **Bitcoin/Lightning**: real LND (Lightning Network Daemon) over its
  REST interface, using hold invoices - `AddHoldInvoice` /
  `LookupInvoice` / `SettleInvoice` / `CancelInvoice`. The escrow is a
  real Lightning HTLC (Hashed Timelock Contract), Bitcoin's own native
  "hold until proof, release or refund" primitive - not an Ethereum-style
  deployed smart contract, and not raw on-chain Bitcoin Core transactions
  either. `scripts/regtest/` spins up a local btcd + lnd pair purely for
  testing; the payment path itself is Lightning end to end.
  `src/core/escrow.js` is our orchestration logic on top of that, not a
  contract in the Solidity sense - there is no such thing on Lightning.
- **Frontend**: plain HTML/CSS/vanilla JS, no framework, no build step.
- **Tooling**: shell scripts (`scripts/`) for setup, preview, and the
  pre-commit secret audit.
