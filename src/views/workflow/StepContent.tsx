import { castByShow } from '../../data/cast'
import { asset } from '../../lib/assets'
import type { SetupMode, Step } from '../../types'
import {
  CoreMessageContent,
  IdeaBriefContent,
  NarrationContent,
  SaveTemplateContent,
  Step01Flow,
  TemplateComponents,
} from './StepPanels'
import { ShotListPanel, VisualGallery, VisualPacingPanel } from './VisualPacing'
import { ScreenplayStage } from './ScreenplayStage'
import { StageDraftEditor } from './StageDraftEditor'

export function StepContent({
  step,
  setupMode,
  showName,
  castData: _castData, // cast images now resolved inside WorldKitEditor
  blankProject,
  onOpenCast,
  onToast,
  origin,
  formatDirty,
}: {
  step: Step
  setupMode: SetupMode
  showName: string
  castData: (typeof castByShow)['spoolcast dev log']
  blankProject: boolean
  onOpenCast: () => void
  onToast: (message: string) => void
  origin: 'blank' | 'template' | 'series'
  formatDirty: boolean
}) {
  // engine node id — the SAME id the WorkflowView dirty checks use (activeStep.sourceId ?? activeStep.id)
  const stepId = step.sourceId ?? step.id
  if (step.id === 'setup') {
    if (setupMode === 'series' && !blankProject) {
      return (
        <div className="inherited-block">
          <div className="field-card">
            <span className="eyebrow">SHOW</span>
            <b>{showName}</b>
          </div>
          <div className="inherited-card">
            <img src={asset('styles/wojak-comic/references/chad.png')} alt="" />
            <div>
              <span className="eyebrow">LOCKED STYLE</span>
              <h3>Wojak comic</h3>
              <p>Format · Illustration video</p>
              <p>Output · 16:9 widescreen</p>
              <p>Narration voice · schedar-en-male-01</p>
              <button onClick={onOpenCast}>World Kit →</button>
            </div>
          </div>
          <TemplateComponents inherited templateName={showName} />
        </div>
      )
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
  if (step.id === 'pacing')
    return (
      <>
        <StageDraftEditor stageId={stepId} />
        <VisualPacingPanel blankProject={blankProject} />
      </>
    )
  if (step.id === 'shots') return <ShotListPanel />
  if (step.id === 'pics') return <VisualGallery />
  if (step.id === 'post')
    return <SaveTemplateContent step={step} origin={origin} formatDirty={formatDirty} onToast={onToast} />
  return (
    <div className="stub">
      <p>{step.blurb}</p>
      <div className="what">Source-of-truth files and action logs will appear here when backend wiring lands.</div>
    </div>
  )
}
