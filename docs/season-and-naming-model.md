# Season and naming model

**Status:** proposed for Ralph's review. This decides the migration shape; it does not
authorize or implement the migration or any season UI.

## 1. Canonical identity and URLs

The product has two shapes: **creator -> show -> season -> episode** and **creator ->
standalone video**. `series` is a legacy API/schema word during the cutover; a video
attached to a show is an episode. Database ids are permanent identity, while route slugs
are scoped:

```text
creators(id, handle)                              UNIQUE(handle)
shows(id, creator_id, slug)                       UNIQUE(creator_id, slug)
seasons(id, show_id, season_number)               UNIQUE(show_id, season_number)
videos(id, creator_id, show_id?, season_id?,
       slug, episode_number?)
  episode slug                                    UNIQUE(show_id, slug)
  episode order                                   UNIQUE(season_id, episode_number)
  standalone slug                                 UNIQUE(creator_id, slug) WHERE show_id IS NULL
creator_watch_roots(creator_id, slug, kind, id)    UNIQUE(creator_id, slug)
```

An episode must name a season belonging to the same show. A standalone video has neither
`show_id` nor `season_id`. `creator_watch_roots` reserves each creator-level slug for
either a show or a standalone video, so their short routes cannot collide. Templates are
recipes, not shows, and do not sit in either content hierarchy.

Canonical public routes do not expose seasons:

```text
Show or its sole episode: /watch/@<handle>/<show-slug>
Episode in a show:        /watch/@<handle>/<show-slug>/<episode-slug>
Standalone video:         /watch/@<handle>/<video-slug>
```

A single-episode show plays from the show URL with no episode segment. If the show later
grows, that root remains its stable show landing. Seasons remain first-class grouping,
ordering, and pricing data; selecting a season is state within the show page, not route
identity.

Published route history must never be recycled. Add a `watch_route_aliases` table keyed
by the complete old path and pointing to a show, season, or episode id. A handle or slug
rename first records the old canonical path there; the old path then returns a permanent
redirect to the current canonical path.

The one migration should:

1. Copy each current `series` row to a `show`, preserving its id and creator, then create
   a default `season-1` and move its `videos` into that season as episodes.
2. Leave each standalone video standalone, with null show/season ids, and reserve its
   creator-level slug in `creator_watch_roots`. Its canonical URL becomes
   `/watch/@<handle>/<video-slug>`; no synthetic show or season is created.
3. Record every existing `/watch/s/<series-slug>` and `/watch/v/<video-slug>` in
   `watch_route_aliases` before removing the global slug constraints. Those routes keep
   resolving and permanently redirect to the new canonical URL.
4. Keep existing R2 object keys. URL migration must not force a media move.

## 2. Show-tier ownership

The owned shared object is the **show**, not a flat series namespace. The site-side
authorization registry should use:

```text
engine_shows(show_id, user_id)
engine_seasons(show_id, season_id) -> engine_shows(show_id)
engine_templates(template_id, user_id)
engine_sessions(session_id, user_id, show_id?, season_id?, provisioning_state, creation_key?)
```

Season ownership is always inherited through `engine_shows`; do not duplicate a mutable
owner on each season. A normal one-off session may remain unattached, but a session linked
to a show or season must have the same user as its parent show. The show tier owns its cast,
world, rules, and season plans. Templates remain separately owned recipes; creating a show
from one does not grant write access back to the source template.

Every show/season/template write must be deny-by-default in both the bridge and engine,
with the bridge resolving child ownership through the show before forwarding. This closes
audit findings E24 and W2: current series writes have no ownership check at all.

## 3. Paywall: episode unlocks and season passes

Support both purchase shapes from the first money migration:

```text
videos.price_credits        nullable; null means an episode unlock is not offered
seasons.price_credits       nullable; null means a season pass is not offered
seasons.free_head_count     number of leading free episodes in this season
unlocks(user_id, scope, target_id, price_paid_credits, ledger_entry_id, created_at)
  scope                     CHECK scope IN ('episode', 'season')
  purchase identity         UNIQUE(user_id, scope, target_id)
```

Do not add an `episode_id` column to `unlocks`. The polymorphic `scope` plus `target_id`
keeps episode purchases and season passes in one immutable purchase record without a
later live-data migration. Purchase writes must validate the target type and snapshot
the paid price; later price changes do not rewrite old unlocks.

After visibility and owner checks, a viewer may watch when the episode is individually
unlocked, **or** its season is unlocked, **or** its position is within that season's free
head. The free head is **per season**, because each short-drama season is a separate
purchase decision and viewers expect a fresh sample when a new season starts. A per-show
head would make later seasons start fully locked and weaken that normal conversion path.

Standalone client/advertising videos are not silently treated as episodes for billing;
this unlock model covers show episodes and seasons.

## 4. Fan-out must reserve owned sessions first

A hosted fan-out may not let the engine invent twenty session ids and report them after
creation. That reproduces W6: sessions without `engine_sessions` rows are invisible,
unusable, and their ids are burned.

Use a two-phase, idempotent contract:

1. The engine performs a no-write planning call and returns the exact child-session
   manifest for the season.
2. The bridge verifies show ownership and atomically inserts all children in
   `engine_sessions` as `pending`, with the signed-in `user_id`, parent show/season, and
   one stable `creation_key` for the fan-out request.
3. Only after every reservation succeeds does the bridge tell the engine to create the
   exact manifest. The engine must reject extra or unreserved ids in hosted mode.
4. Success marks rows `active`. A retry with the same `creation_key` resumes/reconciles
   the same rows rather than returning “id already in use.” Rows are released only when
   the engine confirms that no session was created; created children are never orphaned.

This registration path is required for every future engine action that creates sessions,
not only season fan-out. The season-plan tier, series-scope cast design, and season shelf UI
remain separate board work.
