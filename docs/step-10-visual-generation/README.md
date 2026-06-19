# Step 10 — Visual generation (design hand-off)

Artifacts in this folder:
- `mockup.html` — self-contained, interactive-looking mockup of every state (open in a browser; no build needed, no external assets).
- `mockup.png` — rendered screenshot of `mockup.html` for quick viewing.

The mockup uses the app's real dark tokens and **only the app's existing glyphs** (`✦` AI/regenerate, `▾` caret, `⋯` overflow, `✓`, `↻`, `↓`, `▶`). Type/status are mono **text pills**, not icons — do not introduce an icon font.

## Scope & entry point
- Replace `VisualGallery` in `src/views/workflow/VisualPacing.tsx` (rendered at `src/views/workflow/StepContent.tsx` for `step.id === 'pics'`). Prefer extracting a new `VisualGenerationStage.tsx`.
- **Reuse existing UI only** (AGENTS.md). Mirror `ShotListStage.tsx` (job polling + build button + stage process) and `NarrationContent` in `StepPanels.tsx` (the `vp-menu-btn` dropdown, batch job via `/api/action`→`/api/jobs`, per-row regenerate, progress bar).

## Flow
1. **Empty start** (State A): no prompts yet. Primary `Generate prompts as images` resolves the **format-template default** so the user need not choose. A `Default` segmented toggle (Images `template` / Videos / Let AI choose) allows override. Copy reassures the choice isn't locked in.
2. **Build prompts**: `POST /api/action { action:"build_generation_prompts", session, tenant }` → writes `working/generation-prompts.json`. Long/paid → run as a job, show spin + greyed panel.
3. **Working panel** (State B): one editable row per prompt. Generate / regenerate image or video per row, or in batch.
4. **Regenerate menu** (State C): batch `✦ Regenerate prompts ▾` can rewrite the set as the **opposite type** (the type switch), or regenerate with a note.

## Two views (toggle, `vp-viewtoggle` style — same as Visual Pacing's Script/Table)
- **Prompts** (default, State B): the editable list — one row per prompt, large prompt textarea, references, per-row generate/regenerate. This is where writing/editing happens.
- **Gallery** (State D): visuals dominate, text drops to a one-line caption + `id`. A responsive grid of the generated outputs; `▶` marks finished videos, a spinner marks rendering, dashed "not run" tiles still expose a quick `Generate` button. Selection rings blue; the batch bar adapts (e.g. `Animate N selected` when stills are selected — this is where the "generate images first, then animate some" pass happens). Clicking a tile jumps back to its row in Prompts.

## Aspect ratio
The canvas ratio comes from the project (Step 01) — read `canvas.aspect_ratio` from `shot-list.json`. One ratio for the whole project (no per-item mixing). It drives:
- the Prompts-view preview box and reference thumbs,
- the Gallery grid column count: **16:9 → 2-up · 9:16 → 3-up · 1:1 → 3–4-up**, with each tile boxed at that ratio.

## Row states (drive off `type` + `status`)
| type | status | actions |
|---|---|---|
| image | not_run | `Generate image` · `✦ Regenerate prompt ▾` |
| image | image_ready | `↻ Regenerate image` · `▶ Video from image` (image→video) |
| any | generating | content `opacity:.5`, pointer-events off, amber `status-pill` + `spin` |
| video | not_run | `▶ Generate video` · `✦ Regenerate prompt ▾` |
| video | video_ready | `↻ Regenerate video` · `↓ Download`; preview plays |

`✦ Regenerate prompt ▾` (per row) includes "Make it a video/image prompt" (type switch) + "with a note…", mirroring the batch menu.

## Layout → CSS (reuse, don't invent)
- `panel-flat` container; `ch` header.
- One-line row header: checkbox · `id` chip · type pill · `aspect·res` · `status-pill` (`.status-pill .done/.work`). No tall left rail.
- Body grid `minmax(0,1fr) ~200px`: left = large prompt `textarea` (mono, tall by default, scroll on overflow — extend `.vg-prompt textarea`); right = preview sized to the output aspect + reference slots beneath.
- Reference slots: small square thumbs, each with a role toggle (`vp-menu-btn`) defaulting to **Reference**, switchable to **First frame** (video rows), plus a dashed **Add** slot. Pre-fill from the prompt's `reference_image_urls`.
- Buttons: primary `save-continue`; secondary/mono `vp-undo`; dropdowns `vp-menu-btn` + `vp-menu`/`vp-menu-h` (menu ≥300px, items `white-space:nowrap` so labels/pills never wrap).
- Batch bar: `Select all`/`Clear`, `▶ Generate selected` (label reflects selection: "Generate N images/videos"), `✦ Regenerate prompts ▾`, Image/Video model dropdowns (show only the relevant model for the selection), `voice-runbar`-style progress meter while running.

## Proposed `generation-prompts.json` shape — VERIFY against engine output
```json
{ "prompts": [ {
  "id": "I01", "chunk_id": "C001",
  "type": "image",
  "aspect_ratio": "9:16", "resolution": "720p", "duration": 7,
  "prompt": "…full text the engine sends…",
  "reference_image_urls": ["char-musk.png", "bg-ai-furnace-chamber.png"],
  "first_frame": null,
  "status": "not_run",
  "output_path": null
} ] }
```
Render the full object in the editable textarea; parse `type`/aspect/status for the header. File is source of truth; debounce edits → `set_stage_output`.

## Engine API — confirm in `/Users/ralphxu/Documents/Projects/spoolcast/local_api.py`
- ✅ `build_generation_prompts` (given).
- ❓ image / video / image-to-video generation actions — names unknown. Model as `/api/jobs`. **If absent, this is engine (cross-repo) work — flag and scope explicitly per AGENTS.md.**
- ❓ regenerate-with-type/feedback params on `build_generation_prompts` (`type`, `feedback`, `only:[ids]`).
- ✅ persist edits via `set_stage_output`.
- ❓ reference/first-frame upload endpoint (URL fetch precedent: `fetch_overlay_asset` in `VisualPacingEditor.tsx`).
- ❓ where the format-template default prompt type lives (session.json vs template manifest).

## Stage process / jobs (AGENTS.md)
- All paid/long work via `/api/jobs`, polled like `pollBuildJob` in `ShotListStage.tsx`.
- Store running state in `stageProcesses` keyed by **engine stage id**, not step number; survive navigation/remount. Per-row generation needs per-id sub-state (cf. `regeneratingChunkId` in `NarrationContent`).
- Disable conflicting actions while running; surface errors inline (`var(--red)`).

## Open questions for the user
1. Batch type-switch scope: respect per-row overrides, or hard-reset all selected rows to the chosen type?
2. Do the engine generation actions exist, or is that engine work to request?
3. Confirm `generation-prompts.json` schema + template-default field.

## Done criteria
`npm run build` clean; `npm run lint` on touched files (report pre-existing debt, don't fix unrelated files). No new design tokens or loading animations.
