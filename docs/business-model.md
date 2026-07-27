# Spoolcast — Business Model & Strategy

*Consolidated from research + strategy discussion, July 2026. Supersedes scattered notes.
Two separate businesses share the Spoolcast pipeline: (1) the **content site** — the focus —
and (2) the **creator tool**, left running passively behind it.*

---

## TL;DR — the decisions

- **Focus on ONE userbase: viewers** (people who watch anime/drama adaptations), not tool users.
  Viewers are the compounding asset; the tool commoditizes.
- **Rights-clean sources only.** Ladder, easiest→hardest: your own originals → public domain →
  willing English web-fiction authors → a narrow platform license (Kakao/Naver/Webnovel).
  **Never** unlicensed manga — it's unbankable (see Legality).
- **Hard paywall**, not freemium: first 3–5 episodes free per title, everything past that locked
  at **$0.50/episode**. Credit packs $4.99 / $19.99 / $49.99.
- **The whole validation path costs < one month of ecommerce profit.** Gate every phase on evidence.
- **Undecided until Phase 3:** LN-partnered vs. own-originals as the sourcing strategy. Held loosely
  until ~10 author pitches and live metrics vote.

---

## The product (content site)

| | |
|---|---|
| Free head per title | **3–5 episodes** (~5 min each) — trial + shareable marketing surface |
| Past the wall | **$0.50/episode, no free path** = $0.10/min, cheapest paid video in market |
| Credit packs | $4.99 / $19.99 / $49.99 (breakage adds ~2–3% margin) |
| Adaptation votes | $1 = 10 votes — the uncapped whale lane (spend not capped by catalogue) |
| Per-title support tier | $5–10/mo (Royal Road→Patreon behavior imported) |
| Catalogue at steady state | 30–50 titles, one episode per title per week (Asura-style: deep + cadence, not broad) |

**NO early-access tier** — meaningless under a hard paywall (nothing to be "early" to when non-payment = no access).

Blended payer: **~$15/mo** = 60% casual ($4) + 30% regular ($12.50) + 10% voracious ($45–65).
Top decile ≈ 40% of revenue, matching every comparable.

---

## Costs

| Unit | Cost |
|---|---|
| Episode (5 min) | **~$12** (→ ~$9 if fal.ai Kling rate verifies — UNVERIFIED) |
| Full series (60–125 eps) | ~$750–1,500 |
| Full year of catalogue (30–50 titles, weekly) | **~$35K** |
| Payment fees | ~5% of revenue |
| Author share (partnered titles only) | 25% of gross |
| Acquisition budget | ≤25% of revenue (THE load-bearing assumption) |
| Video delivery (Cloudflare Stream, at 8K payers) | ~$1,200/mo (~1% of revenue) |

**100–200× content-cost advantage over live-action short-drama; still 5–10× over Chinese AI studios.**

---

## Margin per $0.50 unlock

| | Owned title | Author-partnered |
|---|---|---|
| After fees + content amortization | **$0.45 (90%)** | — |
| After 25% author share too | — | **$0.33 (66%)** |
| Net after acquisition (~25% of rev) | ~65–70% | ~45–50% |

---

## Per-payer economics (all three zoom levels)

### One payer, one month
| | $ |
|---|---|
| Spends | $15.00 |
| − fees (5%) | −0.75 |
| − acquisition (25%) | −3.75 |
| − content share (@8K payers) | −0.37 |
| **Profit / payer / month** | **≈ $10** (~$120/yr) |

Author-partnered: **≈ $6.25/mo (~$75/yr)** after their 25%.

### The business, per month
| Payers | Rev/mo | Content* | Acquisition | **Profit/mo** |
|---|---|---|---|---|
| 1,000 | $15K | $2.9K | $3.8K | **~$7.5K** |
| 3,000 | $45K | $2.9K | $11.3K | **~$28.5K** |
| **8,000** | **$120K** | $2.9K | $30K | **~$81K** |
| 20,000 | $300K | $2.9K | $75K | **~$207K** |

\* Content is **FLAT ~$2.9K/mo at every scale** — the entire catalogue. 19% of costs at 1K payers, 3% at 20K. That column is the whole business.

### Annual totals
| Payers | Rev/yr | **Profit/yr** | Margin |
|---|---|---|---|
| 1,000 | $180K | **~$91K** | 51% |
| 3,000 | $540K | **~$343K** | 64% |
| **8,000** | **$1.44M** | **~$975K ≈ $1M** | 68% |
| 20,000 | $3.6M | **~$2.5M** | 69% |

**$1M/yr ≈ 8,000 payers** (owned titles) / **~13,000** (author-partnered, after 25% share).
Sensitivity on the $1M mark: floor ($11/mo, weak conversion) ~11K · **central 8K** · upside ($22/mo binge thesis) ~4.5K.

---

## The funnel (per 100 trial visitors, hard paywall)

| Stage | Count | Basis |
|---|---|---|
| Start free head | 100 | — |
| Reach the wall (hooked) | 40–60 | short-drama completion norms |
| **Convert to payer** | **~10** | hard gate at cliffhanger; short-drama does 12–18% install→pay |
| Payer spends | ~$15/mo | tiered |

CAC target on fandom channels: **$1–5/payer** (search intent + author announce + clips) vs $20–30 in short-drama. **This gap is the model's one load-bearing unverified assumption.**

---

## Ramp (don't judge it early)

| Phase | Catalogue | Blended payer spend |
|---|---|---|
| Months 0–6 | 5–10 titles | $5–8/mo (whales catalogue-capped; revenue lags userbase) |
| Months 6–15 | 15–30 titles | $10–15/mo (votes launch; back-catalogue binges begin) |
| Steady | 30–50 titles | $15–22/mo (whale lane fully open) |

**LN portfolio path:** Yr1 ~8 signed titles (expect ~50 pitches) → ~4K payers, ~$150K profit.
Yr2 ~20 titles → ~10–12K payers, ~$700–900K. Yr3 35+ titles → $1.5M+.
Per signed title on seed audience alone: small author nets you ~$11K, solid ~$38K, large ~$110K.

---

## Competitors

### Content side
| | Viewer pays/min | Content cost/series | Net margin |
|---|---|---|---|
| **You (modeled)** | $0.10 | $0.75–1.5K | **~55–60%** |
| ReelShort | $0.20–0.35 | $150–200K | reportedly LOSS-making (UA eats it) |
| DramaBox | $0.20–0.35 | similar | ~3% ($10M on $323M) — the *profitable* one |
| Webtoon | ~$0.30–0.50/chapter | ~50% to creators | ~1% Adj EBITDA on $1.38B |
| Dashverse (AI) | freemium | low (AI, own IP) | n/a — proof AI serials retain (10M MAU, 68% claimed) |
| Crunchyroll | ~$0.01 (unlimited sub) | licensing | healthy — WTP ceiling: 21M subs × $10–18 |

### Tool side (normalized to $/sec and per-30s video)
| | $/sec | $/30s video | Note |
|---|---|---|---|
| **You** (35% markup) | $0.038 | $1.14 | your *price* |
| Your raw cost | $0.028 | $0.84 | — |
| Kling own app | $0.04–0.06 | $1.20–1.80 | matches you — price is NOT a moat |
| OpenCreator | $0.085–0.11 | $2.55–3.30 | nearest workflow rival, no traction evidence |
| Runway | $0.10–0.23 | $2.88–6.90 | — |
| Higgsfield | $0.17–0.54 | $5.10–16.20 | wins on distribution, not tech/price |
| Arcads / MakeUGC | $0.20–0.73 | **$6–11 flat/finished video** | buyers pay 10–20× markup → price tool ~$150/mo, NOT cost-plus |

Caveat: Arcads' $11 = a *finished* video; credit tools charge per *attempt*. At 2–3 takes/kept second your
effective finished-30s cost ≈ $2.30–3.40 — still cheapest, but honest gap to Arcads is ~3–4×, not 10×.

---

## Three-userbase mix (if you DON'T fully focus)

Per-user profit: **viewer ~$110/yr** (from $180 spend, 60% margin) · **hobby creator ~$100/yr** (from $300, 33% cost-plus) · **business ad-maker ~$1,440/yr** (from $1,800, 80% at market pricing). One ad-maker ≈ 13 of either other type.

| | Case 1 Tool-led | Case 2 Balanced | Case 3 Content-led |
|---|---|---|---|
| Ad-makers / Hobby / Viewers | 300 / 1,000 / 2,000 | 150 / 500 / 8,000 | 50 / 200 / 20,000 |
| Revenue/yr | $1.2M | $1.86M | $3.75M |
| **Profit/yr** | **~$750K** | **~$1.15M** | **~$2.3M** |
| Hardest thing | 300 B2B sales | both funnels | 20K payers |

**Decision: go content-led (Case 3-ish).** Keep the tool self-serve + unmarketed behind it — a door, not a
project. Ecommerce business stays a tool user (dogfooding). Viewers are creator-leads you got paid to acquire.

---

## Legality (why rights-clean, non-negotiable)

- Berne Convention: a Korean/Japanese work is auto-protected in the US. "Licensed in Korea" ≠ "free in US."
  An AI adaptation is a **derivative work**; that right belongs to the IP holder, enforceable in US federal court.
- Kakao is the most aggressive enforcer in this space (shut down Reaper Scans). A US storefront selling
  unlicensed adaptations = the easiest possible enforcement target.
- **Asura survives by being unbankable** — anonymous operators, disposable domains, gray payment rails,
  nothing seizable. The moment you want Stripe + an LLC that collects profit + a sellable catalogue, you
  inherit all the vulnerabilities of a real business. You CANNOT have both bankable and walk-away.
- Rights are sold by territory + medium. The realistic ask is narrow: *English, streaming-only, AI-animated,
  specific titles, rev-share, limited term* — cheap, and nobody else is bidding on title #300 in the catalogue.

**Anyone who can out-pirate you can't out-legitimate you, and vice versa.**

---

## The moat (in order of durability — the pipeline itself is NOT the moat)

The tool commoditizes (OpenMontage is building the open-source version; models cheapen for everyone).
What survives when the tech is commodity:

1. **Legal payment rails** — ~20× revenue capture vs ghost sites. Structural.
2. **Rights + author relationships** — compound, can't be downloaded.
3. **Canon status per title** — author links to you, search resolves to you, communities embed you.
4. **Editorial taste per episode** — the founding Spoolcast lesson: perfect tooling still ships garbage without judgment.
5. **Cost advantage** — real today, eroding for everyone. NOT durable alone.

Five years out, the business defensibly *is* the catalogue + relationships; the machinery is just how it got built cheap.

---

## Architecture note (content site)

Keep the viewer site a **separate, dumb app** that reads finished episodes + manages credits. Do NOT entangle
with the Spoolcast engine. Engine produces files; site serves them. Content repo is the handoff point
(site ingest = "new episode file appears, register it").

**MVP scope (~2–3 weeks, one title, web only):**
- Cloudflare Stream (signed URLs = both playback AND unlock enforcement)
- Magic-link email auth, no passwords
- Stripe Checkout for packs + one-table credit ledger (D1/Supabase)
- 3 screens: title page (lock icons past free head), player, buy-credits modal

**Do NOT build:** native apps (web wallet + Stripe fine; app stores take 30%), DRM beyond signed URLs
(determined rippers win anyway; real anti-piracy = $0.50 + one click beats hunting a rip), recs/comments/
history, votes/support tiers (Phase 3).

---

## The plan (1-man team)

- **Phase 0 (~2wk):** Let Codex finish timeline → ship World Kit voice samples (last quality blocker).
  Verify real kie.ai Kling rate. Buy credits in $500+ block (10% off). Ecommerce untouched (it's the funding).
- **Phase 1 (~2–4wk): the $12 episode.** One full episode, rights-clean (own writing / public domain).
  Gate: does someone who isn't you want episode 2? Watch behavior, not compliments.
- **Phase 1.5: measure your own hours/episode.** THE unmodeled constraint. Steady state = 30–50 eps/week solo →
  only possible at <~30–45 min human attention/episode. If it's half a day, near-term catalogue is 3–5 titles
  and eng priority becomes automation, not features. **Your time, not money, is the scarce input.**
- **Phase 2 (~1–2mo): one title, one paywall.** 10–20 eps on a minimal web-only site, 3–5 free, $0.50 unlocks.
  $200–500 ad test into the fandom. Measures all 3 load-bearing numbers: cost/trial-visitor, trial→pay, spend/payer.
  Gate: payer CAC << $10 and any repeat unlocking.
- **Phase 3 (from ~mo 4): compound.** +1–2 series/mo. Author outreach NOW (finished revenue-generating series
  as the pitch, ~10 pitches/yes, target willing tail). Add votes + support tiers once 2–3 titles live.

**Standing rules:** tool stays unmarketed. No apps / B2B / second funnel until viewers work or clearly die.
Weekly cadence is sacred once a title launches. Every phase has a kill signal costing $12–500 + weeks.

---

## Creator profiles + marketplace (display layer now, money layer gated)

*Reframed July 2026: public profiles are a PRODUCT FEATURE, not a business phase. Two layers:*

- **Display layer — built now** (July 2026): every creator gets a public profile (`/u/<handle>`),
  videos grouped into series, per-video public/private flag, Netflix-style browse at `/watch`.
  Lives inside spoolcast-web (Pages Functions + D1 `spoolcast-site` + R2 `spoolcast-videos`);
  `site/publish.py` pushes a finished file to the cloud. No accounts yet — publishing is
  operator-run until auth lands.
- **Money layer — still gated on Phase 3 evidence** (≥2–3 curated titles holding weekly payers):
  credits, unlocks, 50% split, Stripe Connect payouts, real moderation. Everything below is about
  this layer.

**What:** public creator profiles + series pages (portfolio front, Netflix-style rows). Creators
publish **original work only** made through Spoolcast, grouped into series. Viewers unlock episodes
with the same $0.50 credits from the same $4.99/$19.99/$49.99 packs. **Creators get 50% of their
unlock revenue.**

**Why it's the right Phase 4:**
- Attacks the binding constraint (unverified #5): catalogue scales without founder minutes.
- Creators bring their own readers — the $1–5 CAC thesis, self-serve. Their announcement post is the ad.
- **Both sides of the marketplace pay:** the creator already paid tool credits (35% markup) to produce
  the series, then the platform keeps ~half the viewer revenue. Supply is a revenue line, not a cost.
- The tool stops being "a door" and becomes the supply funnel — without ever being marketed to businesses.

**Per $4.99 pack (10 unlocks):** fees ~$0.45 (9%) → creator $2.50 (50%) → **platform ~$2.04 (~41%)**
before ~1% delivery. Three deal tiers, three margins for three levels of founder effort:

| | Owned | Author-partnered | Marketplace |
|---|---|---|---|
| Who produces | you | you | creator (and pays generation) |
| Platform gross margin | ~90% | ~66% | ~41% |

**Structure:** Spoolcast itself is just the house creator account — the curated catalogue lives on the
same rails. The homepage stays **editorial** (moat #4): curated rows only. The marketplace tail is
searchable but never promoted; curation is what keeps this Netflix-smashed-into-DeviantArt instead of
just DeviantArt.

**Rights line (non-negotiable, see Legality):** original work only — no fan fiction of existing IP.
Monetizing derivatives makes the bankable platform the enforcement target for every upload it can't vet.
ToS originality warranty + registered DMCA agent + takedown flow on day one.

**New build at that point:** upload/ingest + review queue, profile/series pages, rev-share ledger,
payouts (Stripe Connect), moderation. **First version:** 3–5 hand-picked outside creators, not open
signup — same evidence-gated pattern as every other phase.

---

## Still unverified (in order of importance)

1. **Watchability** — the $12 episode. Gates everything. UNTESTED.
2. **CAC on fandom channels** — the $1–5 vs $20–30 assumption. A $200 search-ads test measures it.
3. **Trial→pay @ 10% and $15/mo blended** — measurable within weeks of a live paywall.
4. **Real kie.ai Kling rate** — ~25% swing on content costs.
5. **Your human-minutes/episode** — determines whether solo catalogue is 5 titles or 50.
6. **LN author willingness** — most say no (anti-AI); need ~8 yeses/yr from the willing tail out of thousands.

---

## Naming (content site — kept fully separate from "Spoolcast" brand)

- Wanted: a `-scans`-style association but the "3D/motion" version (scans:2D :: this:3D/motion).
- Leading candidate: **oniframes.com** (~$11, was available July 2026). *Oni* = mythic register like
  *Asura*/*Reaper*; *scans→frames* = the 2D→motion sentence; oni mask = ready logo. Commits to otaku audience.
- Killed: anything with "-cels" (incel-suffix read); anything with "binge" (makes users feel bad);
  anything echoing "spool"/Spoolcast (must be 2 unrelated sites).
- Diligence before buying: Google + USPTO TESS for "oni frames"; register via Cloudflare at-cost;
  grab @oniframes on TikTok/YouTube/X same sitting. Own domain via a NEW LLC (not the ecommerce entity)
  + WHOIS privacy — normal liability separation, protects ecommerce assets.

---

## Research sources (July 2026, verify before betting on any single number)

- Short-drama: Sensor Tower State of Short Drama 2025/2026; ReelShort ~$1.2B gross spend (loss-making);
  DramaBox $323M rev / $10M net; conversion 12–18% install→pay (analyst); UA ~90% of budgets.
- AI video tools: Higgsfield ~$500M ARR run-rate / 25M users / ~300K paying (~1.2%); Arcads ~$15M ARR /
  ~6K customers / ~$11 per video; AdCreative exit $38.7M @ $15.9M ARR.
- Manga/LN: Webtoon 160M MAU / 5% paying / ARPPU $6.6–23; China Literature >⅓ revenue from AI-translated
  works (+39% YoY) — key precedent audience pays for AI-made content; Asura ~130 deep titles, 275M visits;
  Crunchyroll 21M subs @ $10–18; DCC 10M copies sold; HWFWM 44K Audible ratings on book 1.
- AI serial precedent: Dashverse 10M MAU / 68% retention; Neural Viz; Twins Hinahima (mixed reception).
- Caveats that survive everything: conversion %, ARPU, CAC, watchability all anchored to ADJACENT products —
  no AI-adaptation comparable exists yet.
