import explainerContract from '../contracts/explainer.json'
import { stepAlias } from '../data/cast'
import type { Gate, StageContract, Status, Step } from '../types'

// The workflow is built from the SESSION'S CONTRACT SERVED BY THE ENGINE
// (GET /api/contract) — the engine copy is the single source of truth.
// The bundled explainer.json survives ONLY as the offline fallback so the
// mock flows (login demo, /p/new blank project) render without an engine.
export type WorkflowContract = { id: string; stages: StageContract[] }

export const FALLBACK_CONTRACT: WorkflowContract = {
  id: (explainerContract as { adapter?: string }).adapter ?? 'explainer',
  stages: (explainerContract as { stages: StageContract[] }).stages,
}

// Per-contract PRESENTATION hints — how to DRAW a contract, never what it is:
// which engine stages fold into another step's card (the collapsed tail), and
// which adjacent pair renders stacked as parallel branches. A contract with no
// entry here gets a plain main line with every stage visible — new templates
// work before they get hints.
const UI_HINTS: Record<
  string,
  { foldInto: Record<string, string>; branchPairs: [string, string][] }
> = {
  explainer: {
    // narration_voice_check folds into Compile Shot List (08); the packaging
    // tail folds into Package & publish (12), whose card is carried by
    // preprocess_review_render.
    foldInto: {
      narration_voice_check: 'shots',
      package_widescreen: 'build',
      mobile_variant: 'build',
      publish: 'build',
    },
    branchPairs: [['narration_audio', 'visual_assets']],
  },
}
const NO_HINTS = { foldInto: {}, branchPairs: [] as [string, string][] }
export const uiHints = (contractId: string) => UI_HINTS[contractId] ?? NO_HINTS

// TEMPLATE-OWNED PRESENTATION. The hardcoded maps above are explainer-only
// legacy; every other contract carries its display data in its own stages'
// `ui` blocks (docs/format-templates.md "UI hints"), served by the engine —
// a user-made template adapts presentation by editing its contract file,
// never this bundle. Module NAMES are canonical per UI step (users learn the
// app once — "Core message" is the same box in every template); the
// template's meaning lives in the SUBTITLE (ui.blurb).
const CANONICAL_STEP_NAME: Record<string, string> = Object.fromEntries(
  Object.values(stepAlias).map((a) => [a.id, a.name]),
)

const presentStage = (stage: StageContract) => {
  const alias = stepAlias[stage.id]
  const id = stage.ui?.step ?? alias?.id ?? stage.id
  return {
    id,
    name: CANONICAL_STEP_NAME[id] ?? alias?.name ?? stage.label,
    blurb: stage.ui?.description ?? stage.ui?.blurb ?? alias?.blurb ?? stage.gate ?? '',
    subtitle: stage.ui?.blurb,
    description: stage.ui?.description,
  }
}

const foldTargets = (contract: WorkflowContract): Record<string, string> => {
  const map: Record<string, string> = { ...uiHints(contract.id).foldInto }
  for (const stage of contract.stages) {
    if (stage.ui?.fold_into) map[stage.id] = stage.ui.fold_into
  }
  return map
}

// FORMAT FORK (blank flow only). Until Step 01's narrator answer picks the
// format, the map must not pretend to know it: the shared spine renders
// normally, the format-dependent stretch renders FOGGED. 'undecided' = ghost
// fork + dimmed tail; 'video' = narrator said no — narration stage drops out
// and the tail stays ghost until create-on-save stamps the Ad template (the
// blank map is drawn from the explainer fallback contract, so it can't
// honestly draw the ad stages before the real session exists); 'lifted' =
// format known, normal map.
export type FogState = 'lifted' | 'undecided' | 'video'

// Which engine stages the answer decides, for the explainer/fallback shape.
// ALL of them render as nameless skeletons: a dimmed-but-readable name (or an
// arrow between ghosts) still narrates an ending the answer hasn't written.
const FOG_STAGES = new Set([
  'narration_audio',
  'visual_assets',
  'asset_audit',
  'preprocess_review_render',
])

/** Contract stage id → UI step id, INCLUDING folded (hidden) stages, so engine
 *  state on any stage can be attributed to the step that presents it. */
export function stageToStepMap(contract: WorkflowContract): Record<string, string> {
  const folds = foldTargets(contract)
  const map: Record<string, string> = {}
  for (const stage of contract.stages) {
    map[stage.id] = folds[stage.id] ?? presentStage(stage).id
  }
  return map
}

// Node positions are COMPUTED from the visible stage list — a main line on
// y=110, branch pairs stacked on one x slot (y 60/160). Nothing to keep in
// sync when a contract adds or removes stages.
const X_START = 30
const X_STEP = 258

export function buildStepsFromContract(
  contract: WorkflowContract,
  blank = false,
  apiStatusData?: any,
  fogState: FogState = 'lifted',
): Step[] {
  const hints = uiHints(contract.id)
  const hidden = new Set(Object.keys(foldTargets(contract)))
  const pairRole = new Map<string, 0 | 1>()
  for (const [first, second] of hints.branchPairs) {
    pairRole.set(first, 0)
    pairRole.set(second, 1)
  }

  const visible = contract.stages.filter(
    (stage) =>
      !hidden.has(stage.id)
      // While the format is unknown (or resolves video-first), the map must
      // not draw the two-branch fork — the fork SHAPE is the answer. The
      // undecided stretch is ONE ghost slot; answering "narrator: yes" is
      // what materializes the voice/pics pair.
      && !(fogState !== 'lifted' && stage.id === 'narration_audio'),
  )
  let x = X_START
  let pairX: number | null = null
  const positions: [number, number][] = visible.map((stage) => {
    const role = pairRole.get(stage.id)
    if (role === 0) {
      pairX = x
      x += X_STEP
      return [pairX, 60]
    }
    if (role === 1 && pairX !== null) {
      const px = pairX
      pairX = null
      return [px, 160]
    }
    const pos: [number, number] = [x, 110]
    x += X_STEP
    return pos
  })

  return visible.map((stage, index) => {
    const alias = presentStage(stage)

    // Derive status from live API data if available, otherwise default to 'later'
    let status: Status = 'later'
    if (apiStatusData?.workflow_graph?.nodes) {
      const apiNode = apiStatusData.workflow_graph.nodes.find((n: any) => n.id === stage.id)
      if (apiNode) {
        if (apiNode.status === 'passed' || apiNode.status === 'approved') status = 'done'
        else if (apiNode.status === 'running') status = 'work'
        else status = 'later'
      }
    } else if (blank) {
      status = 'later'
    }
    const progress =
      alias.id === 'voice' && apiStatusData?.uiProgress?.narrationAudio
        ? apiStatusData.uiProgress.narrationAudio
        : alias.id === 'pics' && apiStatusData?.uiProgress?.visualAssets
          ? apiStatusData.uiProgress.visualAssets
          : undefined
    if (
      progress
      && Number(progress.total || 0) > 0
      && Number(progress.done || 0) < Number(progress.total || 0)
      && status === 'done'
    ) {
      status = Number(progress.done || 0) > 0 ? 'work' : 'later'
    }
    const fog = fogState !== 'lifted' && FOG_STAGES.has(stage.id) ? ('ghost' as const) : undefined
    const [x, y] = positions[index]
    return {
      id: alias.id,
      sourceId: stage.id,
      name: alias.name,
      blurb: alias.blurb,
      ...(alias.subtitle && !fog ? { subtitle: alias.subtitle } : {}),
      ...(alias.description && !fog ? { description: alias.description } : {}),
      status,
      progress,
      optional: false,
      // Fogged steps have no honest number — the count depends on the answer.
      num: fog ? '?' : String(index + 1).padStart(2, '0'),
      x,
      y,
      ...(fog ? { fog } : {}),
    } satisfies Step
  })
}

export function buildGates(
  contract: WorkflowContract,
  _blank: boolean = false,
  apiStatusData?: any,
): Gate[] {
  // The gate list below is explainer presentation data (which engine artifacts
  // and approvals to surface BETWEEN which steps). Other contracts render
  // gateless until they bring their own list.
  if (contract.id !== 'explainer') return []

  const artifacts = apiStatusData?.artifacts || []

  // DATA SHAPE ADAPTER: Engine returns nested { approvals: [...] }, but UI expects flat array.
  const approvalsList = Array.isArray(apiStatusData?.approvals)
    ? apiStatusData.approvals
    : (apiStatusData?.approvals?.approvals || [])

  const isPassed = (pattern: string) => {
    const match = artifacts.find((a: any) => a.pattern === pattern || a.path?.includes(pattern))
    return match?.exists === true
  }

  // HUMAN GATE RULE: a human gate is approved when the engine has either
  // (a) an explicit approval recorded in working/approvals.json for that stage, or
  // (b) marked the stage itself as passed/approved in the workflow graph.
  // This is one rule for ALL human gates — no per-gate hardcoding.
  const engineNodes = apiStatusData?.workflow_graph?.nodes || []
  const humanGateState = (stageId: string): Gate['state'] => {
    const explicitlyApproved = approvalsList.some((a: any) => a.stage_id === stageId)
    const node = engineNodes.find((n: any) => n.id === stageId)
    const stagePassed = node?.status === 'passed' || node?.status === 'approved'
    return explicitlyApproved || stagePassed ? 'approved' : 'awaiting'
  }

  // STRICT RULE: All gates default to pending/awaiting. They ONLY turn green if the engine explicitly confirms it.

  return [
    {
      id: 'g-setup',
      type: 'human',
      step: 'setup',
      pos: 'after',
      label: 'Approve project setup',
      // STRICT: Human gates require explicit approval or engine-confirmed stage pass.
      state: humanGateState('format_setup'),
      source: 'session.json',
    },
    {
      id: 'g-angle',
      type: 'human',
      step: 'goal',
      pos: 'after',
      label: 'Approve the core message / angle',
      state: humanGateState('story_lock'),
      source: 'session.json:core_message',
    },
    {
      id: 'g-voice',
      type: 'token',
      step: 'script',
      pos: 'before',
      label: 'Narration voice rules force-fed',
      state: isPassed('working/narration-voice-review-v2.json') ? 'consumed' : 'not-yet',
      source: 'working/narration-voice-review-v2.json',
    },
    {
      id: 'g-style',
      type: 'token',
      step: 'shots',
      pos: 'before',
      label: 'Style + character rules force-fed',
      state: isPassed('shot-list/shot-list.json') ? 'consumed' : 'not-yet',
      source: 'working/.rule-gates/style-rules.json',
    },
    {
      id: 'g-shotval',
      type: 'audit',
      step: 'shots',
      pos: 'after',
      label: 'Shot-list + character-registry validation',
      state: isPassed('working/shot-list-validation.passed.json') ? 'passed' : 'pending',
      source: 'validate_shot_list.py',
    },
    {
      id: 'g-narr',
      type: 'audit',
      step: 'voice',
      pos: 'after',
      label: 'Listener/script audits',
      state: isPassed('working/narration-voice-review-v2.json') ? 'passed' : 'pending',
      source: 'working/narration-voice-review-v2.json',
    },
    {
      id: 'g-scene',
      type: 'audit',
      step: 'pics',
      pos: 'after',
      label: 'Scene audit',
      state: isPassed('working/scene-audit.json') ? 'passed' : 'pending',
      source: 'working/scene-audit.json',
    },
    // The render gate is retired: the render runs inside Final cut (11), so its
    // audit has no between-steps home anymore. Publish approval survives — it
    // gates the upload inside Package & publish (12).
    {
      id: 'g-pub',
      type: 'human',
      step: 'build',
      pos: 'after',
      label: 'Per-platform publish approval',
      state: humanGateState('publish'),
      source: 'working/approvals.json',
    },
  ]
}
