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
    blurb: stage.ui?.description ?? alias?.description ?? stage.ui?.blurb ?? alias?.blurb ?? stage.gate ?? '',
    subtitle: stage.ui?.blurb,
    description: stage.ui?.description ?? alias?.description,
    moreInfo: stage.ui?.more_info ?? alias?.moreInfo,
  }
}

const foldTargets = (contract: WorkflowContract): Record<string, string> => {
  const map: Record<string, string> = { ...uiHints(contract.id).foldInto }
  for (const stage of contract.stages) {
    if (stage.ui?.fold_into) map[stage.id] = stage.ui.fold_into
  }
  return map
}

// FORMAT FORK. Until Step 1 picks a template, the map must not pretend to know
// audio-first vs video-first: the shared spine renders normally and the
// format-dependent stretch renders FOGGED. This applies to both the legacy
// blank mock and real engine-backed sessions with template: "".
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
      ...(alias.moreInfo && !fog ? { moreInfo: alias.moreInfo } : {}),
      status,
      progress,
      optional: false,
      // Fogged steps have no honest number — the count depends on the answer.
      // Show-plan sessions number hierarchically (P1…Pn, then S·, then E··.·)
      // so planning, season, and episode nodes read as one tree.
      num: fog ? '?' : contract.id === 'show-plan' ? `P${index + 1}` : String(index + 1).padStart(2, '0'),
      x,
      y,
      ...(fog ? { fog } : {}),
    } satisfies Step
  })
}

// ---------------------------------------------------------------------------
// SHOW CANVAS EXTENSION (series tier model §6, v5 spec). A show-plan session's
// map keeps growing rightward: seasons fan off the Series World Kit node, an
// approved season fans into its episode flows. The nodes returned here are
// ordinary Steps so the EXISTING map renderer draws them — same anatomy
// (stripe / num / name / status foot), same curved SVG edges. The episode
// lanes are each episode's REAL contract stages as the engine reports them,
// never a redrawn copy.

export type ShowEpisodeStage = {
  id: string
  label: string
  status: string
  requires_approval: boolean
}
export type ShowEpisode = {
  session_id: string
  episode: number
  title: string
  template: string
  current_stage: string
  needs_you: boolean
  stages: ShowEpisodeStage[]
}
export type ShowSeason = {
  season: number
  arc: string
  plan_state: string
  episode_count: number
  episodes: ShowEpisode[]
}
export type ShowStatus = { series: string; template: string; seasons: ShowSeason[] }

export type ShowExtension = {
  nodes: Step[]
  // Explicit connections (node ids) — fan edges draw dashed (inheritance),
  // in-lane edges draw solid (sequence), through the same curved paths.
  fanEdges: [string, string][]
  laneEdges: [string, string][]
  // Canvas-space anchor for the expand/collapse-all dropdown (above the
  // episode column).
  toolbar: { x: number; y: number } | null
}

const EMPTY_EXTENSION: ShowExtension = { nodes: [], fanEdges: [], laneEdges: [], toolbar: null }

// Vertical pitches in canvas units (node box is 172×88 at +24/+14 offsets).
// Y_TOP matches the contract spine's main-line y so every column's top row —
// planning, seasons, episodes — sits at the same height.
const ROW_PITCH = 118
const SEASON_GAP = 60
const Y_TOP = 110

const epNum = (episode: number) => `E${String(episode).padStart(2, '0')}`
const epTitle = (ep: ShowEpisode) => ep.title.replace(/^E\d+\s*[—-]\s*/, '').trim() || ep.title

const stageDone = (stage: ShowEpisodeStage) =>
  stage.status === 'passed' || stage.status === 'approved' || stage.status === 'skipped'

/** The map's one connector rule, shared by the contract spine and the episode
 *  lanes: steps sharing an x slot are a parallel group; every member links to
 *  every member of the next group. */
export function deriveSequentialEdges(steps: Step[]): [string, string][] {
  const groups: Step[][] = []
  for (const step of steps) {
    const last = groups[groups.length - 1]
    if (last && last[0].x === step.x) last.push(step)
    else groups.push([step])
  }
  const out: [string, string][] = []
  for (let i = 0; i < groups.length - 1; i++)
    for (const a of groups[i]) for (const b of groups[i + 1]) out.push([a.id, b.id])
  return out
}

export function buildShowExtension(
  steps: Step[],
  status: ShowStatus | null,
  openLanes: Record<string, boolean>,
): ShowExtension {
  if (!status || !status.seasons.length || !steps.length) return EMPTY_EXTENSION
  // Seasons fan off the Series World Kit stage — the last planning node —
  // falling back to whatever stage IS last if a contract reorders.
  const anchor =
    steps.find((s) => s.sourceId === 'world_cast')
    ?? steps.reduce((a, b) => (b.x > a.x ? b : a))
  const seasonX = anchor.x + 258
  const epX = seasonX + 258

  const nodes: Step[] = []
  const fanEdges: [string, string][] = []
  const laneEdges: [string, string][] = []
  // TOP-ALIGNED columns: S1 tops the season column level with E01 and the
  // planning row; each later season sits ~1.5 rows below the previous SEASON
  // NODE — enough drop that its fan leaves from a clearly lower point and
  // stays visually separate from the previous season's fan (episode blocks
  // still stack in order, so a later season's connectors just travel
  // farther down). Not a full block down: the season column stays compact.
  let blockTop = Y_TOP
  let seasonY = Y_TOP

  status.seasons.forEach((season) => {
    const seasonId = `season-${season.season}`
    const approved = season.plan_state === 'approved'
    const episodes = season.episodes

    nodes.push({
      id: seasonId,
      kind: 'season',
      num: `S${season.season}`,
      name: `Season ${season.season}`,
      blurb: season.arc,
      ...(season.arc ? { subtitle: season.arc } : {}),
      status: approved ? 'done' : 'later',
      foot: approved
        ? episodes.length
          ? `Approved · ${episodes.length} episodes`
          : `Approved · ${season.episode_count || '?'} planned`
        : 'Proposed',
      x: seasonX,
      y: seasonY,
    })
    fanEdges.push([anchor.id, seasonId])
    seasonY += ROW_PITCH + SEASON_GAP

    for (const ep of episodes) {
      const done = ep.stages.filter(stageDone).length
      const total = ep.stages.length
      const currentIndex = ep.stages.findIndex((s) => s.id === ep.current_stage)
      const href = `/p/${ep.session_id}`

      if (!openLanes[ep.session_id]) {
        const id = `ep-${ep.session_id}`
        fanEdges.push([seasonId, id])
        nodes.push({
          id,
          kind: 'episode',
          num: epNum(ep.episode),
          name: epTitle(ep),
          blurb: '',
          status: done === total && total > 0 ? 'done' : ep.needs_you ? 'work' : 'later',
          foot: ep.needs_you
            ? `Needs you · ${epNum(ep.episode)}.${currentIndex + 1}`
            : done === total && total > 0
              ? 'Complete'
              : done > 0
                ? 'In progress'
                : 'Queued',
          ...(total > 0 ? { progress: { done, total } } : {}),
          href,
          toggleEpisode: ep.session_id,
          toggleKind: 'expand',
          x: epX,
          y: blockTop,
        })
        blockTop += ROW_PITCH
        continue
      }

      // OPEN LANE: the episode's flow drawn by the SAME builder its own map
      // uses — same presentation hints (folds, stacked branch pairs), same
      // canonical step names — then shifted into the lane's slot. A contract
      // with a branch pair makes a taller lane, exactly like its map.
      const laneSteps = buildStepsFromContract(
        { id: ep.template || 'base', stages: ep.stages.map((s) => ({ id: s.id, label: s.label })) },
        false,
        { workflow_graph: { nodes: ep.stages } },
      )
      const minY = Math.min(...laneSteps.map((s) => s.y))
      const maxY = Math.max(...laneSteps.map((s) => s.y))
      const byId = new Map(ep.stages.map((s) => [s.id, s]))
      const placed = laneSteps.map((step, index) => {
        const stage = step.sourceId ? byId.get(step.sourceId) : undefined
        const isCurrent = stage?.id === ep.current_stage
        const needsYou = Boolean(isCurrent && stage?.requires_approval)
        return {
          ...step,
          id: `ep-${ep.session_id}-${step.sourceId ?? step.id}`,
          kind: 'stage' as const,
          num: `${epNum(ep.episode)}.${index + 1}`,
          ...(needsYou ? { status: 'work' as const } : {}),
          foot: stage && stageDone(stage)
            ? 'Complete'
            : needsYou
              ? 'Needs you'
              : stage?.status === 'running'
                ? 'In progress'
                : 'Pending',
          href,
          x: epX + (step.x - 30),
          y: blockTop + (step.y - minY),
        }
      })
      placed[0].toggleEpisode = ep.session_id
      placed[0].toggleKind = 'collapse'
      nodes.push(...placed)
      laneEdges.push(...deriveSequentialEdges(placed))
      const headX = Math.min(...placed.map((s) => s.x))
      for (const head of placed.filter((s) => s.x === headX)) fanEdges.push([seasonId, head.id])
      blockTop += maxY - minY + ROW_PITCH
    }

    if (episodes.length) blockTop += SEASON_GAP
  })

  // The dropdown holds the expand/collapse-all actions; per-episode toggles
  // live on the nodes themselves. Only exists once a season has fanned out.
  const anyEpisodes = status.seasons.some((s) => s.episodes.length > 0)
  return { nodes, fanEdges, laneEdges, toolbar: anyEpisodes ? { x: epX + 24, y: 18 } : null }
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
