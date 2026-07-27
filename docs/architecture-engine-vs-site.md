# Architecture: the engine side vs the user/site side

*The load-bearing rule of this codebase. If you are an agent or engineer about to add a
feature, first decide which side it belongs to — then respect the boundary below.*

## The two sides

**Engine side — "making videos."** The Spoolcast pipeline: the Python engine
(`../spoolcast`, `local_api.py`, contracts, drafter scripts) plus the editor UI in this
repo (`src/views/workflow/`, `src/views/*.tsx` except `src/views/site/`). Runs locally
against `../spoolcast-content` (plain files — sessions, media, the global asset library).
Single-user today, no accounts, no cloud dependency except the model APIs.

**User/site side — "showing and selling videos."** The public viewer site and everything
user-shaped: profiles, series, public/private videos, and (coming) accounts, roles,
credits, payments. Lives in:

| Piece | Where |
|---|---|
| Public pages `/watch`, `/u/:handle` | `src/views/site/SiteView.tsx` (own chrome, routed by `RouteSplit` in `App.tsx`) |
| API | `functions/api/site/` — Cloudflare Pages Functions |
| Database | Cloudflare D1 `spoolcast-site` — schema in `site/schema.sql` |
| Media | Cloudflare R2 `spoolcast-videos` (published videos), `spoolcast-assets` (global character library) |
| Publishing | `site/publish.py` — pushes one finished file + metadata to R2 + D1 |

## The boundary rule

**Nothing crosses the boundary except files and small metadata records.**

- The engine never reads the site's database. The site never calls the engine's API.
- The two crossing points, both file-shaped:
  1. **Publish handoff** — a finished video file is pushed (one-way) to the cloud by
     `site/publish.py` with its title/series/creator metadata.
  2. **Shared assets** — the global library (character sheets, later templates) is plain
     files (`spoolcast-content/global/…`, mirrored to R2). The engine consumes them
     through its single registry chokepoint (`_reference_registry`); it neither knows nor
     cares who owns them.
- Ownership, visibility (admin-global vs user-owned), roles, credits, payments: **site
  side only.** The engine only ever sees "here are the asset files this session may use."

## Why

So both sides can be built in parallel and separated cleanly if they ever become separate
products. The video-building protocol (contracts, steps, prompts) can change with zero
risk to accounts/payments; the user side can change with zero risk to the pipeline. The
cut line already exists: the site side needs only the publish handoff and the asset files.

## Practical rules for new work

- Editor feature, pipeline stage, prompt change → engine side; do not import from
  `src/views/site/` or touch `functions/`.
- Profile, account, role, payment, catalog feature → site side; do not fetch from the
  engine's `localhost:8000` API and do not read `spoolcast-content` at runtime.
- New shared asset type (e.g. global templates): define it as files + a metadata record.
  Site side stores ownership/visibility; engine side reads the files through its registry.
- Deploys are independent: site side ships with the normal Pages deploy; the engine never
  deploys (it runs locally).

## Planned clients (documented intent)

A **CLI client** is wanted at/soon after launch, alongside the web UI. Design consequence
today: anything a client needs must be an API, never a page — the CLI is just another
consumer of the site-side APIs (auth, catalog, publish) and, once the engine is hosted,
of the engine's job API. Auth for CLI: device-style login (CLI prints a link, user
approves in the browser, CLI receives a token). **Payments never happen in the CLI** —
credits are bought on the web (Stripe checkout in a browser, standard practice); the CLI
only spends them via the same ledger. No card data ever touches the terminal.

## Related docs

- `docs/business-model.md` — display layer vs (gated) money layer, marketplace framing.
- `../spoolcast/PIPELINE.md` — the engine's own pipeline documentation.
