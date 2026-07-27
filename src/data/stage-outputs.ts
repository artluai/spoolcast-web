// Stages whose contract output is a single drafted file with no script behind
// it yet (the engine's UNIMPLEMENTED "ai-owned" drafting actions). The UI gives
// these a draft editor; on save the content is written to the engine via
// set_stage_output, then the stage's approval gate applies as usual.
// Screenplay and shot-list are NOT here: they have multi-file outputs plus
// gate-token audits and need their own flow.
export const STAGE_DRAFT_OUTPUTS: Record<
  string,
  { path: string; label: string; placeholder: string; aiDraft?: boolean; autoSuggest?: boolean; structured?: 'worldkit' | 'pacing' }
> = {
  structure: {
    path: 'working/structure.md',
    label: 'Structure outline',
    aiDraft: true, // engine has a drafting script (draft_structure via OpenRouter)
    placeholder:
      '# Structure\n\nThe high-level arc of the video — the beats from hook to outro.\nWrite or paste the outline here (markdown).',
  },
  world_kit: {
    path: 'working/world-kit.md',
    label: 'World Kit',
    aiDraft: true, // draft_world_kit: inherits show-shared items, proposes episode-only ones
    autoSuggest: true, // arriving with no kit pre-opens the one-click suggest confirm
    structured: 'worldkit', // per-item editor (WorldKitEditor) instead of the md preview/textarea
    placeholder:
      '# World Kit\n\nStyle anchor, cast, environments, props, beat refs — house table format.\nUse “Draft with AI” to suggest items from the approved structure.',
  },
  visual_pacing: {
    path: 'working/visual-pacing-plan.md',
    label: 'Visual pacing plan',
    aiDraft: true, // draft_visual_pacing: plans every visual moment from the final script + World Kit
    structured: 'pacing', // timeline/table/script editor (VisualPacingEditor) over the plan markdown
    placeholder:
      '# Visual Pacing Plan — spoolcast-dev-log-12\n\n## Meta\n\n| Field | Value |\n|---|---|\n| Style | wojak-gpt2 |\n\n## C001 — Cold Open\n\nSummary: What this chunk does for the viewer.\n\n**Beat 001A**: "First narration line…"\n\n| Img | Hold | Refs | What | Why now |\n|---|---|---|---|---|\n| I01 | 4.0s | builder | What the viewer sees. | Why the image changes here. |\n\n## Overlays\n\n| ID | Anchor | Trigger phrase | Overlay | Hold | Placement |\n|---|---|---|---|---|---|',
  },
}
