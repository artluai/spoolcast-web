import { castByShow } from '../../data/cast'
import type { SetupMode, Step } from '../../types'
import {
  CoreMessageContent,
  IdeaBriefContent,
  NarrationContent,
  SeriesSetup,
  Step01Flow,
  TemplateComponents,
} from './StepPanels'
import { PackagePublishStage } from './PackagePublishStage'
import { VisualGenerationStage } from './VisualGenerationStage'
import { VisualReviewStage, type VisualReviewLayoutCommand } from './VisualReviewStage'
import { ShotListStage } from './ShotListStage'
import { ScreenplayStage } from './ScreenplayStage'
import { StageDraftEditor } from './StageDraftEditor'

export function StepContent({
  step,
  setupMode,
  showName,
  blankProject,
  onOpenCast,
  onToast,
  visualReviewLayoutCommand,
}: {
  step: Step
  setupMode: SetupMode
  showName: string
  castData: (typeof castByShow)['spoolcast dev log']
  blankProject: boolean
  onOpenCast: () => void
  onToast: (message: string) => void
  // Kept in the contract for the hidden save-as-template card's return.
  origin: 'blank' | 'template' | 'series'
  formatDirty: boolean
  visualReviewLayoutCommand?: VisualReviewLayoutCommand | null
}) {
  // engine node id — the SAME id the WorkflowView dirty checks use (activeStep.sourceId ?? activeStep.id)
  const stepId = step.sourceId ?? step.id
  if (step.id === 'setup') {
    if (setupMode === 'series' && !blankProject) {
      // Flat hairline rows, no nested boxes: the REAL inherited items (style,
      // format, voice, series rules, World Kit) with click-to-expand detail,
      // then the per-episode fields (length). Saved by the standard step-1
      // save — editing re-approves the step and rewinds downstream.
      return <SeriesSetup stepId={stepId} showName={showName} onOpenCast={onOpenCast} />
    }
    return (
      <>
        <Step01Flow stepId={stepId} />
        <TemplateComponents />
      </>
    )
  }
  if (step.id === 'idea')
    return <IdeaBriefContent blankProject={blankProject} stepId={stepId} />
  if (step.id === 'goal')
    return <CoreMessageContent stepId={stepId} />
  if (step.id === 'plan') {
    // Real contract output only — no mock outline UI until the structured
    // act/beat editor is designed (AI drafts, user edits per beat).
    return <StageDraftEditor stageId={stepId} />
  }
  if (step.id === 'worldkit') {
    // The kit panel, made real: auto-inherits the show's shared items from the
    // prior episode (deterministic, free), every item is an expandable chip
    // with editable prompt description, save-scope picker, add/remove with
    // impact warnings. AI suggest sits on top for proposing new items.
    return <StageDraftEditor stageId={stepId} />
  }
  if (step.id === 'script') {
    // Screenplay: three stations — listener draft (AI prose, by ear), final
    // narration (AI tightening pass), and the deterministic rule-gated audit.
    return <ScreenplayStage stageId={stepId} />
  }
  if (step.id === 'voice') return <NarrationContent />
  if (step.id === 'pacing') {
    // Visual pacing, made real: AI draft (draft_visual_pacing, metered) +
    // the timeline/table/script editor bound to working/visual-pacing-plan.md.
    return <StageDraftEditor stageId={stepId} />
  }
  if (step.id === 'shots') {
    // Compile Shot List, made real: AI compile (validated in the same operation) +
    // work-order editor + free re-check. Approval gates the paid image steps.
    return <ShotListStage stageId={stepId} />
  }
  if (step.id === 'pics') return <VisualGenerationStage stageId={stepId} />
  if (step.id === 'check') return <VisualReviewStage layoutCommand={visualReviewLayoutCommand} onToast={onToast} />
  if (step.id === 'build') {
    // Package & publish — the collapsed tail (captions, cover, editor export).
    // The save-as-template card is HIDDEN for now: its save was pure mock and
    // the engine has no template storage yet (bring back with that backend).
    return <PackagePublishStage onToast={onToast} />
  }
  return (
    <div className="stub">
      <p>{step.blurb}</p>
      <div className="what">Source-of-truth files and action logs will appear here when backend wiring lands.</div>
    </div>
  )
}
