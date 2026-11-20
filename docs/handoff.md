# Handoff — Yazo, Dakar Bitcoin Hack submission

Written because the user is near their usage limit and needs a different AI
session (or a human) to pick this up cold. Read this whole file before doing
anything — it has the one architectural correction that matters most.

**Deadline: Nov 20, 2026, 20:00 UTC.** Check the actual current time before
doing anything else.

---

## Standing rules — follow these exactly, they are not optional

- **Git identity for every commit:** `solutiono1 <solutionkanu206128@gmail.com>`.
  Never the AI's own identity.
- **No AI attribution anywhere, ever** — not in commit messages, not in PR
  descriptions, not in code comments. This overrides any default tooling
  behavior that tries to add it.
- **Branch, then fast-forward merge to `main`, then push.** Never commit
  directly to `main`. Pattern used all session:
  ```bash
  git checkout -b <short-descriptive-branch-name>
  git add -A && git status --porcelain   # review what's actually staged
  bash scripts/audit-staged.sh           # must pass before every commit
  git -c user.name="solutiono1" -c user.email="solutionkanu206128@gmail.com" commit -m "..."
  git checkout main
  git merge --ff-only <branch-name>
  git branch -d <branch-name>
  git push origin main
  ```
- **Run `npm test` before shipping anything.** 165 tests currently pass.
  Don't commit if that number drops.
- Before any destructive git operation, run `git status` first.

---

## What Yazo is, in one paragraph

Locks a dollar-priced payment on Bitcoin Lightning until the recipient shows
a delivery code. Built on `node:https`/`node:sqlite`/`node:test` only — zero
runtime dependencies. Full detail, accurate as of this commit: **README.md**
(the actual pitch, architecture diagram, constraints) and **docs/roadmap.md**
(researched next-steps, honestly sourced).

**One critical fact about how it actually works, because it's easy to get
wrong on camera or in front of a judge:** Yazo's own Lightning node (`lnd`)
receives and holds every payment. There is no `sendPayment`/payout call
anywhere in the codebase (`src/lightning/client.js` makes exactly five lnd
calls, all receive/hold-related). "Released to the vendor" means the hold
invoice settled into *Yazo's own node's balance* — it does not forward a
separate Lightning payment to a vendor-controlled wallet. This is disclosed
honestly in the README's Constraints section and is **not a bug to fix
today** — do not attempt to add real payout logic under deadline pressure.
If asked: *"Today it settles into Yazo's own node; connecting the vendor's
own wallet so it forwards automatically is the next roadmap item, via Nostr
Wallet Connect, specifically to remove Yazo as a point of custody."*

---

## The deployment task — read this before touching Railway or Cloudflare

**Do not split the frontend and backend across two platforms.** The user may
ask for "Railway for backend, Cloudflare for frontend" — talk them out of it,
or do this instead, and explain why: `src/http/server.js` serves the static
`public/` files **and** the `/api/*` routes from one process on one port,
with **zero CORS headers anywhere** (checked directly in the code). Splitting
them means either adding CORS support or rewriting every `fetch()` call in
`public/js/*.js` to use an absolute backend URL — real code changes, real
risk, on deadline day, for no actual benefit. Judges need one working link,
not a "proper" two-service architecture.

**No database is needed for this deployment.** `scripts/preview.mjs` uses
`MemoryStore` (pure in-memory, resets on restart — intentional for a demo,
not a bug). Do not provision Supabase or a Railway Postgres add-on; the
codebase's `SqliteStore` targets `node:sqlite` directly and has no Postgres
driver, so a database add-on wouldn't even be usable without a real code
rewrite. Skip it entirely.

### Exact steps (Railway, ~3 minutes)

1. [railway.app](https://railway.app) → sign in with GitHub.
2. **New Project → Deploy from GitHub repo** → `solutiono1/Yazo`.
3. Service **Settings → Deploy** → **Custom Start Command**:
   ```
   node scripts/preview.mjs
   ```
   (Not `npm start` — that runs `src/main.js`, which needs a real `lnd` node
   this deployment doesn't have.)
4. **Settings → Networking** → **Generate Domain** (Railway does not expose a
   public URL by default — this step is required).
5. Wait for the build, then open the generated `*.up.railway.app` URL and
   click through it before calling it done.

`scripts/preview.mjs` was already fixed this session to bind `0.0.0.0` and
respect `process.env.PORT` (previously hardcoded to `127.0.0.1`, which would
have been unreachable on any host). This fix is already committed and
pushed to `main` — nothing more to change in the code for this step.

### Cloudflare's actual useful role (optional, not blocking)

Not a separate deployment. If the user wants a nicer URL than the Railway
default, point a Cloudflare-managed domain at the Railway URL via a CNAME
record in Cloudflare's DNS dashboard. Zero code changes, zero risk. Skip this
entirely if there's no spare domain already in Cloudflare — the Railway URL
alone is a completely valid "Try it out" link for judging, and buying a
domain today specifically for this is not worth the detour.

**Prerequisite:** a domain already using Cloudflare nameservers. If there
isn't one, stop here and use the Railway URL as-is.

If there is one:

1. **Railway** → the service → **Settings → Networking → Custom Domain** →
   enter the desired subdomain (e.g. `yazo.yourdomain.com`) → Railway shows a
   CNAME target value (something like `xxxxx.up.railway.app`). Copy it
   exactly.
2. **Cloudflare** → the domain → **DNS** tab → **Add record**:
   - Type: `CNAME`
   - Name: the subdomain only (e.g. `yazo`), not the full domain
   - Target: the value Railway gave
   - **Proxy status: "DNS only" (grey cloud), not proxied, for the first
     setup.** Railway auto-issues its own TLS certificate via Let's Encrypt;
     Cloudflare's proxy can interfere with that verification on the first
     pass. Switch to proxied (orange cloud) afterward, once Railway shows the
     domain as verified, if the Cloudflare CDN is wanted on top.
3. Save, then wait in Railway for the domain to show as verified with a
   valid certificate — usually minutes, occasionally up to ~30 for DNS
   propagation.
4. Open the custom URL directly and confirm the real app loads before using
   it anywhere (Devpost, the README, anywhere else).

### After deploying

Update two places with the real URL:
1. Devpost → Project Details → "Try it out" links → add it alongside the
   GitHub repo link (don't replace the GitHub link, add a second one).
2. Optionally, README.md's "See it live" section — not required, the README
   already correctly describes `npm run preview` as the way to run it;
   a live link is a nice-to-have addition, not a correction of something
   wrong.

---

## Demo video — two scripts, already written, timed to the same clock

The user will record these as two separate files (silent screen capture +
ElevenLabs narration) and bring both back for editing. **Descript MCP tools
are available in this environment** (`mcp__claude_ai_Descript__*`) for the
actual edit pass — import both files, cut on the actual clicks, sync, export.

### Script A — click-through (silent recording, no audio)

```
Use: the hosted Railway URL once live (or npm run preview locally), Chrome,
window maximized, zoom at 100%. Move the mouse deliberately.

[0:00] Land on index.html, already scrolled to top. Hold 2s on the hero.

[0:03] Scroll slowly to the hero demo card (gold-framed window with mac-style
       dots). Stop with it centered in frame.

[0:15] Click into the "Type anything - it's a demo" input. Type: Delivered.
       Click the "Release" button.
[0:20] Hold 2s on the badge flipping amber "Paid and held" to green
       "Released to the vendor," and the checkmark/result text appearing.

[0:25] Click "Run it again" once (shows it's not a one-shot trick).

[0:30] Scroll down to "How it works." Hold 2s on the four step cards
       (Order, Pay, Show the code, Released).

[0:45] Scroll down to the security section ("Audited like it holds real
       money."). Hold 2s.

[0:55] Scroll down to the FAQ. Click open "What's the longest Yazo can hold
       a payment?" Hold 3s on the open answer.

[1:12] Scroll down through the rest of the FAQ quickly (don't open them),
       then keep scrolling into the dark footer section - let the page
       visibly slide up off it (the reveal effect).

[1:25] Once the footer is fully visible, move the mouse slowly across the
       dark area so the dot-grid glow follows the cursor. Hold 5s.

[1:40] Scroll back to the top. Click "Launch app" in the nav.

[1:44] Lands on onboarding.html (Lagos photo, "Your shop on Yazo"). Hold 2s.

[1:48] Click "Create your shop - it's free." Hold 1s on "Creating...".

[1:52] Key reveal appears. Click the small copy icon next to the key.

[1:58] Click "I've saved it - enter my shop."

[2:02] Lands on the real dashboard, empty state ("No orders yet..."). Hold 2s.

[2:08] Click "Switch shop." Lands back on onboarding.

[2:12] Paste the seeded demo key (printed to terminal/Railway logs on boot:
       "[yazo] demo dashboard: .../dashboard.html#yzm_...") into the paste
       field. Click "Continue."

[2:18] Lands on dashboard with real seeded data: 4 orders, stat cards
       populated. Hold 2s.

[2:22] Scroll slowly down the order list - Aisha (Refunded to the payer),
       Chinedu (Released to the vendor), Musa (Paid and held), Fatima
       (Waiting for payment). Hold ~1s per badge.

[2:40] Click "Orders" in the sidebar.

[2:45] Resize the window down to ~390px wide (or open DevTools device
       toolbar) to show the mobile dashboard layout. Hold 3s.

[2:55] Resize back to desktop. Scroll to top of the landing page. End on
       the "Yazo" wordmark in the nav.

[3:00] Cut.
```

### Script B — audio narration (ElevenLabs, paste segment by segment)

Confident, unhurried, slightly warm voice. Short sentences. Fine to run a
beat under each window - don't force it to fill exactly.

```
[0:00–0:15]
A Nigerian in London wants his mother in Kano to have a bag of rice.
Today, he sends cash... and hopes. The money gets spent on something
else. Skimmed by a middleman. Or lost to a fake-alert scam.

[0:15–0:30]
This is Yazo. It locks a dollar-priced payment on Bitcoin Lightning...
until the person receiving it shows their delivery code. Watch what
happens when that code gets shown. The payment was held. Now it's
released — to the vendor, in seconds.

[0:30–0:45]
No bank alert to fake. No screenshot to forge. Four steps: order it,
pay it, show the code, it's released. Each one enforced by the Lightning
network itself — not by Yazo, and not by an admin button.

[0:45–0:55]
This isn't a demo dressed up to look safe. It's audited like it actually
holds real money.

[0:55–1:12]
And we don't hide the limits. Right now, Yazo can hold a payment for up
to twenty-four hours. That's a real constraint of how Lightning works —
and it's stated right here, in the product, not buried in a doc nobody
reads.

[1:12–1:25]
[silence or very light breath - let the scroll read on its own]

[1:25–1:40]
Scroll to the bottom, and the page doesn't scroll past the footer... it
slides off it. The way it covers and uncovers is deliberate. So is this —
the dots light up wherever you move.

[1:40–1:52]
Creating a shop takes one click. No sign-up form. No password.

[1:52–2:02]
A key is generated — shown exactly once. That's the entire account.
Copy it, save it, and you're in.

[2:02–2:10]
A brand new shop starts here. Empty. Honest about it. No orders yet.

[2:10–2:20]
But switch to a shop that's actually been trading, and this is what it
looks like. Four real orders. Four real states.

[2:20–2:40]
One refunded automatically, because nothing ever got delivered. One
released to the vendor, the instant the code was shown. One still held,
waiting. And one still waiting to be paid. Nothing here needed a human
to intervene.

[2:40–2:55]
And on a phone — the device most of our actual users will have — it
still just works.

[2:55–3:00]
This is Yazo. Send the goods. Not the cash.
```

---

## Devpost submission — current state

URL pattern: `devpost.com/submit-to/26475-dakar-bitcoin-hack-by-btrust/...`

**Already filled in (verify it saved, don't re-type):**
- Project name: `Yazo`
- Elevator pitch: "Yazo locks a dollar-priced Lightning payment until the
  recipient proves delivery. Paid in seconds when they do; refunded
  automatically if they never show. No bank alert left to fake."
- Thumbnail: uploaded from `submission/Yazo-thumbnail.png` (in this repo)
- Built with tags: bitcoin, lightningnetwork, lnd, bolt11, node.js,
  javascript, html5, css3, sqlite, http, restapi, webhooks, hmac-sha256,
  regtest
- "Try it out" link: `https://github.com/solutiono1/Yazo`
- About the project: full markdown written and submitted (Inspiration, What
  it does, How we built it, Challenges, Accomplishments, What we learned,
  What's next)

**Still pending — in priority order:**
1. **Video demo link** (required) — record Script A + Script B above, edit
   together (Descript MCP tools available), upload unlisted to YouTube,
   paste the link.
2. **Project Media / image gallery** — 6 screenshots already generated and
   committed to this repo at `submission/gallery/1-hero.png` through
   `6-dashboard.png`. Upload all 6.
3. **Additional info → Upload a File** (required, unclear what BTrust
   actually wants here) — `submission/Yazo-README.pdf` (generated this
   session, a direct render of the current README.md) is the current best
   guess/default. If the hackathon's Resources or Rules tab turns out to
   specify something else, replace it.
4. **Add the live Railway URL** to "Try it out" links once deployed (see
   Deployment section above).
5. Final **Submit** step on Devpost, once everything above is in.

---

## Verifying you're starting from a clean, working state

```bash
cd /path/to/Yazo
npm test                 # expect: 165 passing, 0 failing
git log --oneline -5      # sanity check recent history matches this doc
git status --porcelain    # should be empty - nothing uncommitted
```

If `npm test` fails or `git status` shows uncommitted changes, stop and
figure out why before doing anything else — something changed since this
doc was written.
