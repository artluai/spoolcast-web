# Spoolcast vs OpenMontage — positioning

Written 2026-07-22. Spoolcast facts verified against the code on that date;
OpenMontage facts from its public README (github.com/calesthio/OpenMontage).

---

## 1. The argument

Most AI video tools guess at what a video workflow looks like. Spoolcast's was
extracted from doing the work: first AI movie trailers for a startup, then
converting ads for an ecommerce company the author owns. Those are opposite
ends of why people use AI video — one is mood and spectacle, the other is
conversion in under fifteen seconds.

Thousands of hours in, the finding was that they run the **same workflow**.
Source → core message → structure → references → screenplay → shots → assets →
cut → audit → publish. What differs between a trailer and an ad is the *rules
at each step*, not the steps.

Spoolcast is that workflow, built so anyone can run it — autopilot at the
beginner end, direct artifact editing at the advanced end. Same workflow,
different depth of engagement. Not two products.

This is a claim about the domain, not about software, and it is the part a
competitor cannot copy by reading the repo.

### The thesis is load-bearing in the architecture

Not a story told after the fact — it constrains the code:

- `contracts/base.json` is the shared lifecycle. `contracts/ad.json` is a
  merge-patch on it: changes `shot_medium_default` to video, adds product
  intake gates. It does **not** reorder or replace stages. Someone who thought
  ads and explainers were different workflows would have written two pipelines.
- `PIPELINE.md`'s stage table is deliberately genre-neutral — "production
  units", "assembly", "output audit". Not ad language, not trailer language.
- Templates are prefilled answers plus remembered per-step rules. That only
  works if the steps are already universal.

---

## 2. Any agent gets you a result. That is the problem.

An agent asked to make a video will always produce one. It has no way to fail.
So every shot gets generated from its own prompt, each locally plausible, and
the result is thirty clips that do not look like the same video. Nothing
errored. The output is simply incoherent — and the agent cannot detect this,
because it only ever sees one shot at a time.

**Consistency is not a property of any single generation.** It cannot be
produced shot by shot. It has to be locked once, early, and enforced from
above:

- **World kit** — written once; every downstream shot resolves references
  against it
- **Style anchor** — every clip forced through the same look
- **Story lock** — the promise fixed before structure can wander off it
- **Narration voice check** — the sound gated before assets are generated
- **Permanent shot ids** — shot 14 is still shot 14 after an edit, so
  references never drift

Every step exists to lock a decision that every later step must obey. That is
the whole design.

> Any agent will get you a result — that is its goal. It will not get you a
> video that looks like one video.

**Their gates are human review; these are machine-enforced constraints.**
OpenMontage pauses for sign-off at proposal, script, scene plan, assets, and
publish. Reviewing thirty inconsistent clips does not make them consistent.
Their README says "real quality enforcement", but what is described is
checkpoints and approvals. Asking the person to notice is not the same as the
system knowing.

---

## 3. AI interprets; code decides

The original agent-driven build had a failure that could not be prompted away:
**Claude and Codex skipped steps they found too complicated.** They reported
success and moved on. Nothing caught it.

That is structural, not a bug. It happens whenever the thing doing the work
also judges whether the work is done.

Spoolcast splits those roles:

> **AI's job is interpretation. Code's job is everything else.**

Concretely, at intake: a messy message arrives — a half-formed idea, three
photos, one of them described. AI works out what the video is about, fills
step 1's fields, and labels each reference so later steps can find them. **That
is the end of AI's role at that stage.** Code moves to step 2, gated on whether
the artifacts exist and validate.

The AI cannot advance anything, so it cannot skip. Code does not get bored.

This pattern was already present before it was named: `inventory_source.py`'s
docstring records that it *replaced* the agent writing `asset-inventory.md` by
hand, and describes itself as "purely mechanical — no AI, no network, no cost."

**Every step is a sandbox.** The AI works inside it, not on it. Code owns the
boundary: what runs, what files change, what must exist to pass. Contract
legality checks, audits, and transactional writes are that boundary being
enforced.

The UI was not a convenience layer over the agent path — it forced the steps to
become real, because a button cannot skip.

---

## 4. Layered guidance: genre is data, not code

One workflow, three layers of guidance stacked on it:

| Layer | What it is |
|---|---|
| **Project wiki** | Facts and guidelines for this video (surfaced in `RulesView` over the scoped rulebooks) |
| **Step rules** | How each step should behave — scoped template / series / video, individually toggleable |
| **Template** | A bundle of rules plus prefilled answers; users write their own |

Nothing is hardcoded per genre. A trailer template and an ad template are the
same pipeline with different text at each step. **The template system generates
the genre rather than enumerating it** — so there is no preset list to pick
from, and a user can invent a video type without writing code.

Compare to twelve fixed pipelines: every genre they did not anticipate is a
pipeline someone must write, in their repo, as code. A user cannot add one.

**Rules are enforced, not suggested.** `step_rules_block` loads into every
drafter — screenplay, structure, world kit, shot list, visual pacing. One
loader, so no drafter can silently drop its rules. A markdown skill asks an
agent to remember; this injects and cannot not.

In that frame their 500+ skills and 52 tools are surface area, not strength:
more for an agent to shortcut, maintained by them, unextendable by users.

---

## 5. Both are agent frameworks — one enforces

Both projects started in the same place: an agent driving video production off
local files. Spoolcast still carries it — `rules.md` is "the small
always-loaded rule surface for agents", `PIPELINE.md` has an Owner column per
stage (AI / script / human), and the contracts declare "legal actions".

The difference is enforcement. `spoolcast_action.py` states it directly:

> "Run only contract-legal Spoolcast actions… It does not decide workflow
> itself. It asks spoolcast_status.py what is legal, then refuses anything
> outside the active contract/current stage."

OpenMontage steers agents with markdown instructions. An instruction is a
suggestion — the agent can ignore it and the write still lands. Spoolcast
refuses illegal actions, gates stages on audits, and rolls back failed writes.
Theirs relies on the agent behaving; this does not have to.

**The UI is a second client over the same enforced action layer**
(`local_api.py` wraps the same legality checks), not a replacement for the
agent path.

---

## 6. Comparison

Verified against code / README. "Planned" means scoped but not yet running.

| | Spoolcast | OpenMontage |
|---|---|---|
| **Origin** | Extracted from thousands of hours making trailers + converting DTC ads | Designed as an agent framework |
| **Workflow claim** | One workflow for all video; genre = rules per step | Seven fixed stages, 12 pipelines |
| **Genre handling** | Merge-patch overlays + user-written templates (data) | Per-pipeline skills (code, theirs to write) |
| **Agent control** | Enforced — illegal actions refused by contract | Instructed — markdown skills the agent may ignore |
| **AI's role** | Interpretation only, inside a step; code advances | Does the work and decides when it is done |
| **Step skipping** | Structurally impossible — AI cannot advance | Observed failure mode of this design |
| **Consistency** | Locked globally: world kit, style anchor, story lock, voice check, permanent ids | Per-shot generation; human review after |
| **Gates** | Machine-enforced audits + transactional rollback | Human sign-off at 5 checkpoints |
| **Guidance layers** | Project wiki + scoped step rules + templates | Director skills (markdown) |
| **Clients** | Agent CLI, web UI, (planned) more intake surfaces | Terminal + coding assistant only |
| **Finishes the video** | Render, audits, mobile crops, caption burn-in, YouTube publish | Stops at compose |
| **Fix without re-running** | Permanent shot ids; polish only re-runs changed shots | Re-run and pay again |
| **Failure recovery** | Transactional writes, `.orig` baselines, revert window, stage health + waivers | Not present |
| **Series memory** | World kit, cast, style rules across episodes | Fresh each run |
| **User range** | Beginner (autopilot) → advanced (artifact editing) | Terminal + coding assistant required |
| **Research** | Planned (`gather_sources` reserved in contract) | Built — YouTube, Reddit, HN, news, academic, cited |
| **Cost caps** | Ledger tracks after the fact; no pre-run estimate or cap | Built — estimate first, `observe`/`warn`/`cap` |
| **Stock footage** | Planned (Pexels key reserved in `.env.example`, no code) | Built — Pexels, Unsplash, Pixabay, Archive.org, NASA |
| **Video-to-video** | Available via kie.ai (Seedance / Kling) — minor | Not the same feature (see below) |
| **Reference→plan** | Not present; fits the rules system if wanted | Built — transcript, pacing, keyframes → plan |
| **Autopilot** | Planned; current runner is an onboarding animation | Built, with approval gates |
| **Licence / model** | Proprietary, product | AGPLv3, sponsors, "nights and weekends" |
| **Status** | Mid-build | Shipped; tens of thousands of stars in days |

---

## 7. Reading the table

**Planned rows are unfinished work, not design gaps.** Research and stock
footage are missing *steps in a correct workflow*. Autopilot is auto-clicking
approve on steps that already work — the current runner calls a local state
setter, not the engine advance handler, so it is a rewire plus job-polling and
gate-stopping, not a build.

**One genuine idea worth taking: cost caps.** Governance, orthogonal to
workflow design, does not touch the thesis. The ledger already records every
priced call; what is missing is projecting it forward and refusing to exceed a
limit. Build clean — see the licence note.

**Reference video is two different features.** Video-to-video (feed a video,
get a stylised video) is a kie.ai call and `kie_client.py` already exists —
minor. Reference-*as-planning-input* (transcript, pacing, keyframes → structure
and beat timing) is what OpenMontage does; it would land as step rules, and it
is the lowest-priority item on the list because those rules can simply be
typed.

**Licence caution.** OpenMontage is AGPLv3 — aggressive copyleft. Take ideas,
never implementations. Cost caps and stock footage are simple enough to build
independently.

**Their star count validates the market they cannot serve.** Tens of thousands
of stars in days, topping GitHub Trending, with no hosted version, no company,
and a nights-and-weekends maintainer. Most of those people want a product, not
a terminal and a coding assistant.

---

## 8. CLI (post-launch)

Cheaper than a normal port, because the action layer already exists
(`spoolcast_action.py` with ~30 wired actions, `spoolcast_backend_cli.py` for
sessions/status/graph). Remaining work:

1. **Packaging** — `CONTENT_ROOT` and the venv path are hardcoded to this
   disk; needs config/env resolution, an install story, a `spoolcast` entry
   point, API key config.
2. **Job waiting** — heavy actions return a job id and exit; the CLI needs the
   same poll loop the UI has, or `spoolcast render` returns having rendered
   nothing. Small.
3. **The unimplemented actions** — `gather_sources`, `build_shot_list`,
   `generate_scene` and ~15 others in `UNIMPLEMENTED_ACTIONS` have no code
   behind them; the agent used to *be* the implementation. This is absence, not
   packaging — **but it is the same work the UI needs**, so it is shared, not
   extra.

Every front door is the same shape: messy input arrives, AI interprets it into
step 1, the pipeline behind is identical. CLI, web UI, and a future Telegram
intake are three intake surfaces on one workflow — not three products.

**Sequencing:** ship the app first. The CLI is a launch *asset* — a
distribution path that does not require open-sourcing the product — but
shipping both at once doubles the support surface at the worst moment. Let the
actions the app forces you to finish be what makes the CLI cheap.

---

## 9. Headline

> They built a plausible video workflow for agents. Spoolcast extracted the
> real one from doing the work, then built a system that lets anyone run it at
> their own level.
>
> Any agent gets you a result. This gets you one video.
>
> The gap is not features. One is a guess; one is evidence.
