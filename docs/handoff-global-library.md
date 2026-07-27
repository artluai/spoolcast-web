# Handoff — global character library + ref panel rework

Written 2026-07-26. All commits are **local, not pushed**, in both repos.

| repo | commits |
|---|---|
| `spoolcast` (engine) | `92db2e7`, `8ed196c` |
| `spoolcast-web` | `43cc812`, `3595cfa`, `cba7930`, `95ab78b`, `5f45e4e`, `4ca0567`, `ed0541f`, `9d7b09a` |

Untouched user WIP: `.claude/launch.json` (modified), `docs/business-model.md`
(untracked). Leave both alone.

---

## 1. What the work is

The user's UGC ads look AI-generated because the *people* look AI-generated.
The fix is a curated library of 30 real-looking creator character sheets that
every project can use and nobody can edit.

That required a **three-tier asset model**, resolved at ONE chokepoint —
`_reference_registry()` in `scripts/validators/references.py`. Every consumer
(build_shot_list, batch_scenes, rewrite_generation_prompts, audit, final_cut)
already read through it, so adding a tier there changed nothing downstream.

```
session refs   session.json characters/objects   user, session-local
variation      world-kit row + `Variant of`      user, session-local
world kit      working/world-kit.md              user, session-local
style library  styles/<id>/style.json            (pre-existing)
GLOBAL         global/characters/<slug>/         NOBODY — read-only
```

Key rules, all load-bearing:

- **Pull-in is BY REFERENCE, never copy.** `use_global_asset` writes a row
  `| mika | character | global |  |` with an EMPTY notes cell. The description
  and portrait resolve from the library at read time, so improving a character
  improves every session already using it.
- **A variation is copy-on-write.** `make_ref_variation` writes an ordinary
  editable session ref that remembers its parent. Provenance lives in a real
  `Variant of` COLUMN, never in the notes cell — notes IS the image prompt, and
  a tag parked there gets read aloud to the image model. (That was a real bug;
  see §3.)
- **Read-only is enforced in one function**, `global_write_block()` in
  `local_api.py`, called by every ref-mutating action *including the paid
  generate path*, so a blocked edit never spends credits.
- **Global paths are CONTENT-ROOT relative** (`global/characters/…`), not
  session-relative. Web uses `globalContentUrl()`; the engine's
  `resolve_session_asset_path` already falls back to `CONTENT_ROOT`.

Templates got the identical two tiers: built-ins in the engine repo are
read-only, `duplicate_template` copies into `spoolcast-content/templates/<id>/`
where it is editable.

## 2. What landed

**Engine**
- `scripts/global_library.py` — the read-only tier (list/load/search/resolve).
- `scripts/import_character_library.py` + `scripts/assets/character-names.json`
  — imported 30 characters. Re-runnable; skips existing unless `--force`.
- `scripts/upload_global_assets.py` — R2 upload, **written but never run**
  (R2 is not enabled on the Cloudflare account yet).
- `draft_world_kit.py --section` — fill ONE kit section. For Cast the model
  PICKS from the library by slug instead of inventing a person.
- `suggest_template.py` — also decides whether a video needs a real presenter
  and casts one. Verified both directions: a Korean-skincare UGC brief cast
  Nari; a DNS explainer cast nobody.

**Web**
- `GlobalCharacterPicker.tsx` — the library, as a gallery: sheets edge to edge,
  name overlaid, description + actions on hover.
- `RefImagePanel.tsx` — heavily reworked; see §3.
- `VariantModule.tsx` — gained optional props (`actionsSlot`, `suggestedName`,
  `asVersion`, `hide*`) rather than being restructured. **Step 7's mapping board
  still uses it unchanged — do not break that.**

## 3. Mistakes I made (so you don't re-derive them)

**The `[variant of: …]` tag in the prompt.** I first wrote provenance inline
into the notes cell. Notes is the image prompt, so it appeared in the prompt box
and would have been sent to the image model. Fixed in `8ed196c` by adding a real
`Variant of` column (widening the header, separator and every existing row).
Both kit writers now build rows **by column name** — a positional row lands
values under the wrong headers once that column exists.

**Global items had no base reference.** A global character has no session
manifest, so `image_path` came through empty — "make my own version" of a
library character generated with nothing to stay faithful to. Fixed in
`4ca0567` by passing the content-root path.

**I misdiagnosed a layout bug as a stale dev server, twice.** The user kept
seeing an "older layout"; I blamed Vite and had them restart it. The real cause
was mine: I had unified the two modes' *controls* but not their *bodies*, so
update mode still rendered the old improve/upload rows. Fixed in `ed0541f` /
`9d7b09a`. **Lesson: there is exactly ONE `RefImagePanel` usage and ONE route to
step 5. If the UI looks wrong, it is the code, not the bundle.**

**The Options menu, "fixed" twice before it actually worked.** Three stacked
causes, all in `.vp-menu-anchored`:
1. `.vp-menu` gets its layout from `position: fixed`. Anchored absolute inside
   an inline parent, the `<span>` stayed inline and ignored `bottom`/`min-width`.
2. Its children are `<span>`s too, so even as a block it had nothing to wrap.
   The existing fixed-position menus never hit this — theirs are `<button>`s.
   Flex column makes every child a block regardless of tag.
3. **The actual squash:** `.vg-select-wrap .vp-menu` sets
   `top: calc(100% + 5px)`; with our `bottom` the box was pinned at BOTH edges —
   12px of menu around 411px of content.

**I made a mess deleting the old update body.** I removed it function-by-
function with a brace-matching script that cut too far, producing broken syntax.
I reset that one file to the last commit and redid it as a smaller change.
Nothing was lost, but see the debt below.

## 4. Known debt / things to check

- **NOT VERIFIED: clicking Generate in "take" mode.** `asVersion` is a new
  engine path — it skips `register_master_variant`, targets the base ref, and
  watches for the picture *changing* rather than a new kit item appearing.
  Nobody has run it end to end. **Check this first.**
- **The old update-mode body is still mounted but hidden** in `RefImagePanel`
  (`<div style={{display:'none'}}>`). It owns the hidden file input and the
  closures the ⚙ Options handlers use. It should be removed properly in a
  focused pass — do not rip it out mid-task.
- **R2 is not enabled** on the Cloudflare account. `upload_global_assets.py` is
  ready; it needs `npx wrangler r2 bucket create spoolcast-assets` after the
  dashboard toggle. Consumers already prefer `image_url` over the local path,
  so enabling it needs no code change. Note the r2.dev public URL is
  rate-limited and not for production traffic.
- **The `gcp-` CSS prefix** (GlobalCharacterPicker) reads as Google Cloud
  Platform. The user flagged it; a rename to `clib-` is pending.
- **No end-to-end ad has been generated with a library character.** That is the
  only real test of whether the people look less AI. Do it before adding more
  characters.
- **pytest is not installed** in either python environment, so the engine test
  suite could not be run. Verification was by direct module testing and live
  API calls instead.
- **Testing wrote rows into `asyllum-mary-jane-01`'s kit.** Verified removed —
  the Cast section is back to `ugc-creator-mia` / `ugc-creator-avery`. The one
  lasting trace is a `Variant of` column in that table's header, which is
  harmless and correct for future variations.

## 5. Verification notes

- Synthetic hover does **not** fire CSS `:hover` in the browser harness. The
  gallery's hover overlay was verified via `:focus-within` (the same rule) plus
  computed-style checks.
- The browser pane collapsed to 0 width at one point, which made a textarea
  report a 3600px `scrollHeight` and sent me chasing a phantom autosize bug.
  If measurements look absurd, check `innerWidth` before believing them.
- Build gate is `npm run build` (`tsc -b && vite build`) — never bare `tsc`.
