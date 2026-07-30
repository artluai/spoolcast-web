# Spoolcast tasks

The engineering source of truth for the roadmap. The live board (tools/board, deployed as its own
Cloudflare Pages project) is seeded from this file and then maintained through the board API.

**The launch goal this roadmap is built around:** a writer feeds Spoolcast their own writing, and
it produces a whole series (~20 episodes) from it, designs the characters and world, runs the
pipeline hands-off if the creator wants, and publishes the result as a streaming-style show on the
creator's public profile, watchable for credits. The same pipeline stays a general video workflow:
ad makers and client work use it privately, without the storefront.

**Status legend:** `[ ]` todo · `[~]` in progress · `[x]` done.
**Roles:** `**[FABLE]**` `**[CODEX]**` `**[RALPH]**` — the recommended team for the task. A todo
task is unowned until someone claims it on the board.

**Format:** every task is one checkbox line plus two sub-bullets:

```
- [ ] **[CODEX]** Technical title, as specific as a ticket
  - plain: Short plain-language name
  - why: One sentence on what changes for the product when this lands.
```

## Run hosted, from anywhere (goal: cloud)

- [x] **[FABLE]** Editor and public site hosted on Cloudflare Pages, built from this repo
  - plain: The UI loads anywhere
  - why: The editor and the watch pages are already reachable from any device.

- [x] **[FABLE]** Storage seam: all engine file IO routed through scripts/storage.py, with an R2
  mirror bucket laid out as users/<uid>/ and a scratch-sync r2 backend
  - plain: Cloud file storage
  - why: Session content lives in Cloudflare R2 instead of only on the Mac.

- [~] **[FABLE]** Railway engine deploy: Dockerfile and bearer-token auth are committed but
  unpushed; pushing triggers the auto-deploy once the usage cap is set and Ralph gives the go
  - plain: Engine runs on a server
  - why: Drafting, generation, and review stop depending on the Mac being awake.

- [ ] **[FABLE]** Mint R2 S3 API keys for the hosted engine and replace the wrangler-OAuth
  fallback used by storage_r2.py and sync_content_mirror.py; verify the seam works from Railway
  - plain: Server can reach cloud storage
  - why: The hosted engine reads and writes session content without a logged-in Mac.

- [x] **[RALPH]** Mirror the content that matters into R2: the two active sessions
  (spoolcast-dev-log-12 and the asyllum ad) plus the global characters, series overlays, and
  styles; the older archive sessions intentionally stay local-only
  - plain: Active projects are in the cloud
  - why: The hosted engine has everything current; archives stay on the Mac by choice.

- [ ] **[CODEX]** Editor switch: point VITE_API_BASE at the hosted engine and send its bearer
  token on engine calls, which currently go out with no auth at all
  - plain: Editor talks to the server
  - why: The phone workflow becomes real: open the editor anywhere and drive the hosted engine.

- [ ] **[CODEX]** Remotion render worker: a separate container image with Node and Chromium that
  picks up render jobs through the existing durable job-file pattern and produces every export
  format in the cloud
  - plain: Cloud video rendering
  - why: The last Mac-only render step disappears, and renders can scale past one machine.

- [ ] **[CODEX]** Fix the per-session public/ symlink repointing in init_session.py: it is a
  global mutable pointer, so two concurrent renders corrupt each other
  - plain: Renders can run side by side
  - why: A 20-episode season cannot render one episode at a time through a shared symlink.

- [ ] **[CODEX]** Unify the two job runners (the sqlite worker loop in local_api.py and the
  per-session job files of spoolcast_job.py) behind one queue
  - plain: One job system
  - why: Autopilot and the render worker need a single queue to schedule against.

- [ ] **[CODEX]** Move YouTube publishing off the browser-interactive OAuth flow and the local
  token file so publish runs headless from the hosted engine
  - plain: Cloud publishing to YouTube
  - why: The final upload step also works away from the Mac.

- [~] **[FABLE]** Project board: this board, a private Cloudflare Pages site with a KV-backed
  API, seeded from docs/TASKS.md
  - plain: Shared roadmap board
  - why: Ralph, Fable, and Codex see and update the same plan instead of chat-session notes.

## Pipeline reliability (goal: editor)

- [ ] **[FABLE]** Rule violations rewrite instead of refuse: step rules already go into drafting
  prompts via step_rules.py, but the deterministic em-dash and rhetoric post-scan dead-ends with
  "not writing"; feed the named violations back for one automatic rewrite pass
  - plain: Rules fix the draft, not block it
  - why: Step 04 stops erroring out; a compliant draft appears without a human retry.

- [x] **[CODEX]** Fix the Project setup step so "Complete step with AI" is clickable
  - plain: Un-stick the setup button
  - why: Step 03 can be AI-completed like every other step.

- [x] **[CODEX]** Carry the world kit chosen at step 1 into Project setup instead of starting
  blank
  - plain: Choices carry forward
  - why: Selecting a world kit once is enough; step 3 respects it.

- [ ] **[CODEX]** Publish thumbnails: pull world kit references (character and prop images) into
  thumbnail generation the same way shot generation already does
  - plain: Thumbnails match the video
  - why: Thumbnails show the actual cast and props instead of ignoring the world kit.

- [ ] **[CODEX]** Publish thumbnails: fix the crop so the thumbnail frames the actual image
  - plain: Thumbnails stop cropping wrong
  - why: What you approve is what the platform shows.

- [ ] **[CODEX]** Per-project setting for who writes thumbnail text: the image model or Remotion,
  defaulting to the image model
  - plain: Choose who draws the title text
  - why: Projects that want baked-in, art-directed text get it from the image model.

- [ ] **[CODEX]** Stale-state audit: steps re-read predecessor files by design, so find the
  places that break the rule (approved snapshots like generation-prompts.approved.json, .prev
  files, editor-side caches) where a change made early never reaches a later step
  - plain: Map where edits get lost
  - why: Pinpoints why the pipeline feels like disjointed flows instead of one flow.

- [ ] **[FABLE]** Forward propagation fixes from that audit: later steps resolve inputs fresh
  from the current files when opened or drafted, never from a stale snapshot
  - plain: Later steps remember earlier edits
  - why: Change something on step 2 and step 5 already knows about it.

## Writing in: manuscript to season plan (goal: ingest)

- [ ] **[FABLE]** Manuscript ingestion: accept long-form writing as a first-class source with a
  chunked index and summaries; today inventory_source.py inlines only text files under 16 KB and
  drafters read at most 8,000 characters, so a novel is invisible to the pipeline
  - plain: Feed it a whole book
  - why: The launch input is a writer's actual manuscript, not a one-paragraph idea brief.

- [ ] **[FABLE]** Season plan tier: a new artifact above per-episode structure, owned by the
  series, holding the episode breakdown, arcs, and a continuity ledger drafted from the
  manuscript index
  - plain: One plan for twenty episodes
  - why: Nothing today sits between "source text" and one episode's structure.md.

- [ ] **[FABLE]** Series-scope world and cast design: draft the shared world kit and character
  sheets once from the manuscript, before episode 1; the inheritance path through
  world-kit-shared.md already works
  - plain: Design the cast once
  - why: Every episode opens with the same characters, places, and style already in place.

- [ ] **[CODEX]** Fan-out: an action that creates N episode sessions from a season plan, each
  pre-seeded with the series world kit, cast, rules, and its own episode structure;
  create_session currently makes exactly one session and nothing spawns siblings
  - plain: A season becomes twenty sessions
  - why: The season plan turns into real, runnable episodes in one step.

## Autopilot: hands-off production (goal: autopilot)

- [ ] **[FABLE]** Autopilot driver: chain the contract's stage edges by calling run_action with
  approve and allow_cost, advancing until done or blocked; the UI pill exists but is a mock that
  runs nothing
  - plain: One click runs the pipeline
  - why: This is the core of "the writer does nothing": ~16 stages advance without a human.

- [ ] **[FABLE]** Autopilot failure policy: when an audit flags, a validation blocks, or a gate
  token goes stale, decide between retry, waive via waivers.json, and pause for a human; built on
  recheck_session.py and stage_health.py, which nothing consumes autonomously today
  - plain: Knows when to stop and ask
  - why: A 20-episode run is ~320 unattended stage transitions; each one can fail.

- [ ] **[FABLE]** Budget enforcement: a pre-run credit estimate and a hard ceiling the runner
  checks mid-flight; session.json stores ai_budget but nothing enforces it, and
  usage-ledger.json only records spend after the fact
  - plain: A spending limit that actually stops it
  - why: Hands-off generation without a working ceiling is an unbounded bill.

- [ ] **[CODEX]** Wire the Autopilot UI to the real runner: the pill, the confirm modal with the
  credit estimate, and pause-on-failure states per the existing handoff spec
  - plain: The autopilot button works
  - why: Creators start, watch, and stop hands-off runs from the editor.

- [ ] **[CODEX]** Season batch: queue N episode sessions through autopilot in sequence or
  parallel, with per-episode review gates optional
  - plain: Generate a whole season
  - why: The twenty-episode promise becomes one queued run instead of twenty babysat ones.

## Publish like a show (goal: show)

- [ ] **[CODEX]** Automated publish from the engine: a real publish action that pushes the
  render plus video-meta.json to the site publish API; today site/publish.py is a hand-run local
  script and manual_publish is listed as unimplemented
  - plain: Publishing is a button, not a script
  - why: Twenty episodes publish themselves instead of twenty manual CLI invocations.

- [ ] **[CODEX]** Publish carries the full show shape: episode number, poster, duration, and
  series cover and description; the API path writes none of these today and the editor omits the
  episode number it already knows
  - plain: Episodes look like a show
  - why: Series pages render like a streaming shelf instead of blank text cards.

- [ ] **[CODEX]** Direct-to-R2 upload path for publishes to bypass the ~100 MB Pages request cap
  - plain: Big episodes upload fine
  - why: A full-length episode at reasonable bitrate does not fit through the current API.

- [x] **[CODEX]** Owner dashboard: list my videos, toggle public/private after publish, and let
  creators watch their own private videos; the site API filters public=1 unconditionally, so an
  ad maker cannot view their own ad
  - plain: Manage your own videos
  - why: The private-use half of the product (ads, client work) becomes actually usable.

- [x] **[CODEX]** Private-by-default publishing for non-show work; the endpoint defaults private
  but the editor button currently flips it public
  - plain: Private unless you say so
  - why: Ad makers do not accidentally publish client work to their public profile.

- [x] **[CODEX]** Creator profile editing: bio and avatar; the columns exist and nothing writes
  them
  - plain: Creators own their page
  - why: The public profile looks like a creator's page, not an empty stub.

## Credits and creator earnings (goal: money)

- [ ] **[FABLE]** Signed media URLs: stop serving video from the hardcoded public r2.dev base in
  the site API; move to short-lived signed URLs (R2 presigned or Cloudflare Stream per
  docs/business-model.md)
  - plain: Videos stop being free links
  - why: Until URLs expire, any paywall is decorative; this is the prerequisite for credits.

- [ ] **[CODEX]** Money schema and endpoints: unlocks table, per-series pricing and free-episode
  head, balance endpoint; the ledger table exists and nothing writes to it
  - plain: The credit system exists
  - why: Watching past the free episodes has something real to check against.

- [ ] **[CODEX]** Stripe Checkout and credit packs per docs/business-model.md, with the webhook
  writing purchases into the ledger
  - plain: Buy credits
  - why: Viewers can actually pay; the ledger becomes the source of truth for balances.

- [ ] **[CODEX]** Locked-episode viewer experience: lock states on series and watch pages, the
  unlock flow, and a signed-in viewer's library and balance
  - plain: Watching and unlocking feels right
  - why: The paywall reads as a streaming show, not an error page.

- [ ] **[FABLE]** Creator earnings: revenue-share accounting in the ledger on every unlock, with
  payouts as a later, separate step
  - plain: Creators earn from views
  - why: "Charge credits for it" pays the creator, which is the point of the storefront.

## Founder decisions (goal: founder)

- [ ] **[RALPH]** Set the Railway usage cap and give the go to push the engine deploy
  - plain: Approve the server spend
  - why: Unblocks the hosted engine; the cap keeps the bill bounded.

- [ ] **[RALPH]** Set the two board passwords (ralph and agents) as Cloudflare secrets and run
  the one-time seed
  - plain: Turn the board on
  - why: The board goes live for all three users.

- [ ] **[RALPH]** Confirm the pricing model from docs/business-model.md (per-episode price, free
  head, revenue share) and open the Stripe account
  - plain: Decide the prices
  - why: The money build implements exact numbers; changing them later is cheap, deciding is not.

- [ ] **[RALPH]** Remotion company license for cloud rendering
  - plain: License the renderer
  - why: Rendering on servers is a licensed use; render minutes are the dominant unit cost.
