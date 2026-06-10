// Stages whose contract output is a single drafted file with no script behind
// it yet (the engine's UNIMPLEMENTED "ai-owned" drafting actions). The UI gives
// these a draft editor; on save the content is written to the engine via
// set_stage_output, then the stage's approval gate applies as usual.
// Screenplay and shot-list are NOT here: they have multi-file outputs plus
// gate-token audits and need their own flow.
export const STAGE_DRAFT_OUTPUTS: Record<string, { path: string; label: string; placeholder: string }> = {
  structure: {
    path: 'working/structure.md',
    label: 'Structure outline',
    placeholder:
      '# Structure\n\nThe high-level arc of the video — the beats from hook to outro.\nWrite or paste the outline here (markdown).',
  },
  // world_kit intentionally NOT here: its items are individually scoped
  // (episode / show / template) and need per-section editing UI, not a
  // freeform file editor. See WorldKitPanel design pass.
  visual_pacing: {
    path: 'working/visual-pacing-plan.md',
    label: 'Visual pacing plan',
    placeholder:
      '# Visual pacing\n\nPer-chunk visual moments, image counts, b-roll/meme/reaction candidates.\nWrite or paste the plan here (markdown).',
  },
}
