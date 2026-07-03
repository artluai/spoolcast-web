import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import explainerContract from '../../contracts/explainer.json'
import { postAction } from '../../lib/api'
import newsContract from '../../contracts/news-anime-bot.json'
import { castByShow } from '../../data/cast'
import { STAGE_DRAFT_OUTPUTS } from '../../data/stage-outputs'
import { useWorkflowStore } from '../../store/workflow'
import type { Gate, OnboardSeed, SetupMode, Step } from '../../types'
import { StepContent } from './StepContent'
import type { VisualReviewLayoutCommand } from './VisualReviewStage'

type WorkflowArtifact = {
  required?: boolean
  exists?: boolean
  pattern?: string
}

type WorkflowNode = {
  id: string
  label?: string
  status?: string
  requires_approval?: boolean
  artifacts?: WorkflowArtifact[]
}

type CheckFinding = {
  kind: string
  message: string
  severity: 'stale' | 'editorial' | 'mechanical'
  waivable: boolean
  waived: boolean
  key: string
}
type CheckStageHealth = { stage_id: string; state: string; findings: CheckFinding[] }
type CheckHealth = { stages?: CheckStageHealth[]; needs_recheck?: boolean; failing?: boolean }

type WorkflowApiStatus = {
  data?: {
    workflow_graph?: { nodes?: WorkflowNode[] }
    blockers?: string[]
    check_health?: CheckHealth
  }
}

// Which UI step owns each health-checked engine stage — where "Go to step" lands.
const HEALTH_OWNER_STEP: Record<string, { id: string; label: string }> = {
  screenplay_plan: { id: 'script', label: 'Screenplay' },
  narration_voice_check: { id: 'script', label: 'Screenplay' },
  shot_list_json: { id: 'shots', label: 'Compile Shot List' },
  asset_audit: { id: 'check', label: 'Final cut' },
}

type CardSize = { w: number | null; h: number | null }
// Stable "automatic" fallback so reading an unsized step's entry never mints a
// fresh object (the measure effect depends on the size by identity).
const AUTO_CARD_SIZE: CardSize = { w: null, h: null }

export function WorkflowView({
  steps: rawSteps,
  gates,
  seed,
  selected,
  setSelected,
  activeStep: rawActiveStep,
  apiStatus,
  apiLoading,
  isBlocked,
  setupMode,
  showName,
  castData,
  blankProject,
  autopilot,
  onOpenCast,
  onToast,
  onAdvance,
  onScrolledChange,
  onAutopilot,
  runningId,
  origin,
}: {
  steps: Step[]
  gates: Gate[]
  seed: OnboardSeed | null
  selected: string
  setSelected: (id: string) => void
  activeStep: Step
  apiStatus: WorkflowApiStatus | null
  apiLoading: boolean
  isBlocked: boolean
  setupMode: SetupMode
  showName: string
  castData: (typeof castByShow)['spoolcast dev log']
  blankProject: boolean
  autopilot: boolean
  onOpenCast: () => void
  onToast: (message: string) => void
  onAdvance: (id: string, opts?: { aiHandoff?: boolean }) => void | boolean | Promise<boolean | void>
  onScrolledChange: (scrolled: boolean) => void
  onAutopilot: () => void
  runningId: string | null
  origin: 'blank' | 'template' | 'series'
}) {
  const [full, setFull] = useState(false)
  const [visualReviewLayoutCommand, setVisualReviewLayoutCommand] = useState<VisualReviewLayoutCommand | null>(null)
  // Step 4 → 5 hand-off: after approving the structure, AI refreshes the World
  // Kit with what the new structure needs. On by default; the checkbox is the
  // user's spend consent.
  const [updateKitAfter, setUpdateKitAfter] = useState(true)
  // While the engine records a save/approval (a couple of seconds), the button
  // shows it's working instead of sitting silent.
  const [advancing, setAdvancing] = useState(false)
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches,
  )
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)')
    const onChange = () => setIsMobile(mq.matches)
    mq.addEventListener('change', onChange)
    window.addEventListener('resize', onChange)
    return () => {
      mq.removeEventListener('change', onChange)
      window.removeEventListener('resize', onChange)
    }
  }, [])
  const fullView = full || isMobile
  const sendVisualReviewLayoutCommand = (action: VisualReviewLayoutCommand['action']) => {
    setVisualReviewLayoutCommand((command) => ({ id: (command?.id ?? 0) + 1, action }))
  }

  // IN-PROGRESS RULE: a step the user has started typing in (dirty) shows as
  // "In progress" instead of "Pending" — derived here, in one place, from the
  // store's per-step dirty flags. Engine-confirmed statuses (done) win.
  const dirtyStepsMap = useWorkflowStore((s) => s.dirtySteps)
  const stageProcesses = useWorkflowStore((s) => s.stageProcesses)
  const workflowNodes = apiStatus?.data?.workflow_graph?.nodes || []
  const firstIncompleteNode = workflowNodes.find((n) => n.status !== 'passed' && n.status !== 'approved')
  const firstIncompleteStageId = firstIncompleteNode?.id
  const finalRender = useWorkflowStore((s) => s.finalRender)
  const steps = rawSteps.map((step) => {
    const key = step.sourceId ?? step.id
    const process = stageProcesses[key]
    if (process && ['queued', 'running'].includes(process.status)) {
      return { ...step, status: 'work' as const }
    }
    // Final cut's node reflects the RENDER truth: the engine's audit stage can
    // be approved while no compiled video exists (or the last one went stale/
    // failed) — the map must not show COMPLETE then.
    if (step.id === 'check' && step.status === 'done' && finalRender !== 'done') {
      return { ...step, status: 'work' as const }
    }
    if (step.status !== 'done' && key === firstIncompleteStageId) {
      return { ...step, status: 'work' as const }
    }
    if (step.status === 'later' && dirtyStepsMap[key]) return { ...step, status: 'work' as const }
    return step
  })
  const activeStep = steps.find((step) => step.id === selected) ?? rawActiveStep

  // DIRTY STATE TRACKING: per-step dirty flags live in the zustand workflow store,
  // keyed by the engine node id (activeStep.sourceId) the approval logic compares against.
  const s1 = useWorkflowStore((s) => s.s1)
  const stepUndo = useWorkflowStore((s) => s.stepUndo)
  const ideaBrief = useWorkflowStore((s) => s.ideaBrief)
  const goal = useWorkflowStore((s) => s.goal)
  const seedDrafts = useWorkflowStore((s) => s.seedDrafts)
  const stageDrafts = useWorkflowStore((s) => s.stageDrafts)
  const clearDirty = useWorkflowStore((s) => s.clearDirty)
  const clearStageDrafts = useWorkflowStore((s) => s.clearStageDrafts)
  // START OVER: a guarded door to the engine's rewind — revoke approvals and
  // clear produced files from a step onward. Deliberately two clicks deep
  // (menu → confirm) so it can't be hit by accident.
  const [resetMenu, setResetMenu] = useState(false)
  const [resetConfirm, setResetConfirm] = useState<{ stageId: string; name: string; whole: boolean } | null>(null)
  const [resetting, setResetting] = useState(false)
  const doReset = async () => {
    if (!resetConfirm || resetting) return
    setResetting(true)
    try {
      const res = await fetch('http://localhost:8000/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: 'spoolcast-dev-log-12',
          tenant: 'local',
          action: 'rewind_stage',
          stage_id: resetConfirm.stageId,
        }),
      })
      const out = await res.json().catch(() => null)
      if (!res.ok || out?.ok === false) {
        onToast(`Engine: ${out?.message || out?.error || 'could not set things back to pending.'}`)
        return
      }
      // Drop every cached draft so the editors reload the engine's truth.
      for (const s of orderedSteps) clearStageDrafts(s.sourceId ?? s.id)
      onToast(
        resetConfirm.whole
          ? 'Project set back to step 1 — approvals revoked, produced files cleared.'
          : `“${resetConfirm.name}” and everything after set back to pending.`,
      )
      setResetConfirm(null)
    } catch {
      onToast('Could not reach the engine.')
    } finally {
      setResetting(false)
    }
  }
  const handoff = useWorkflowStore((s) => s.handoff)
  // The step an AI hand-off is currently preparing: locked, shows a waiting state.
  const handoffHere = !!handoff && (activeStep.sourceId ?? activeStep.id) === handoff.stageId
  const dirty = useWorkflowStore((s) => s.isStepDirty(activeStep.sourceId ?? activeStep.id))

  // ENGINE PREFILL: the engine is the source of truth — on load, pull the saved
  // idea brief (source/idea-brief.md) and core message (session.json) back into
  // the store so completed steps show their real content instead of blanks.
  // Never clobbers text the user has typed (dirty steps keep their draft).
  const prefilledRef = useRef(false)
  useEffect(() => {
    if (prefilledRef.current) return
    prefilledRef.current = true
    const base = 'http://localhost:8000/api/file?session=spoolcast-dev-log-12&path='
    fetch(base + encodeURIComponent('source/idea-brief.md'))
      .then((r) => (r.ok ? r.json() : null))
      .then((out) => {
        if (out?.ok && out.data?.exists && typeof out.data.content === 'string') {
          const store = useWorkflowStore.getState()
          if (store.ideaBrief.trim() === '' && !store.dirtySteps['input_intake']) {
            const text = out.data.content.replace(/^#\s*Video idea\s*\n+/, '').trim()
            if (text) seedDrafts({ ideaBrief: text })
          }
        }
      })
      .catch(() => {})
    fetch(base + encodeURIComponent('session.json'))
      .then((r) => (r.ok ? r.json() : null))
      .then((out) => {
        if (out?.ok && out.data?.exists && typeof out.data.content === 'string') {
          try {
            const cfg = JSON.parse(out.data.content)
            const cm = String(cfg?.core_message || '').trim()
            const store = useWorkflowStore.getState()
            if (cm && store.goal.text.trim() === '' && store.goal.mode === '' && !store.dirtySteps['story_lock']) {
              seedDrafts({ goal: { text: cm, mode: '' } })
            }
          } catch { /* unparseable session.json: leave blank */ }
        }
      })
      .catch(() => {})
  }, [seedDrafts])

  // initialize drafts from the onboarding/template seed WITHOUT marking any step dirty
  useEffect(() => {
    seedDrafts(
      seed
        ? { s1: seed.s1, ideaBrief: seed.ideaBrief, goal: seed.goal }
        : {
            s1: {
              narrator: '',
              style: '',
              output: '',
              length: 120,
              projectId: 'untitled-01',
              editing: '',
            },
            ideaBrief: '', // ZERO DUMMY DATA RULE: Always start blank if no seed
            goal: { text: '', mode: '' }, // ZERO DUMMY DATA RULE: Always start blank if no seed
          },
    )
  }, [seed, seedDrafts])
  
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null)
  const [cardBox, setCardBox] = useState<{ left: number; top: number; width: number } | null>(null)
  // USER-SIZED CARD: edge/corner handles set an explicit size the layout
  // respects (null = automatic), remembered PER STEP — sizing one step's card
  // must never change another step's. Double-click a handle to reset.
  const [userSizes, setUserSizes] = useState<Record<string, CardSize>>({})
  const userSize = userSizes[activeStep.id] ?? AUTO_CARD_SIZE
  const setUserSize = (action: CardSize | ((s: CardSize) => CardSize)) =>
    setUserSizes((all) => {
      const current = all[activeStep.id] ?? AUTO_CARD_SIZE
      return { ...all, [activeStep.id]: typeof action === 'function' ? action(current) : action }
    })
  const startCardResize = (e: React.PointerEvent, dir: 'e' | 's' | 'se') => {
    e.preventDefault()
    e.stopPropagation()
    const card = cardRef.current
    if (!card) return
    const startX = e.clientX
    const startY = e.clientY
    const w0 = card.offsetWidth
    const h0 = card.offsetHeight
    const onMove = (ev: PointerEvent) => {
      setUserSize((s) => ({
        w: dir !== 's' ? Math.max(420, w0 + (ev.clientX - startX)) : s.w,
        h: dir !== 'e' ? Math.max(320, h0 + (ev.clientY - startY)) : s.h,
      }))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  const [restLeft, setRestLeft] = useState<number | null>(null)
  const [tetherAnim, setTetherAnim] = useState(false)
  // did the format diverge from the template it started from?
  const formatDirty = !!seed && (
    s1.narrator !== seed.s1.narrator ||
    s1.style !== seed.s1.style ||
    s1.output !== seed.s1.output ||
    s1.length !== seed.s1.length
  )
  const cardRef = useRef<HTMLDivElement | null>(null)
  const landedStepRef = useRef('')

  const edges = useMemo(() => {
    return [
      ['setup', 'idea'],
      ['idea', 'goal'],
      ['goal', 'plan'],
      ['plan', 'worldkit'],
      ['worldkit', 'script'],
      ['script', 'pacing'],
      ['pacing', 'shots'],
      ['shots', 'voice'],
      ['shots', 'pics'],
      ['pics', 'check'],
      ['voice', 'check'],
      ['check', 'build'],
    ] as const
  }, [])

  const orderedSteps = steps
  const selectableIndex = orderedSteps.findIndex((step) => step.id === selected)
  
  // RULE 3: "In Progress" = THIS step is dirty (user typed in it since last
  // approval). Per-step via the store's dirty flags — covers the seed fields
  // AND the stage draft editors, and never bleeds across steps.
  const isCurrentlyEditing = dirty

  const engineNode = workflowNodes.find((n) => n.id === activeStep.sourceId)
  const engineStatus = engineNode?.status || 'not_started'
  const activeStageProcess = stageProcesses[activeStep.sourceId ?? activeStep.id]
  const hasActiveStageProcess = !!activeStageProcess && ['queued', 'running'].includes(activeStageProcess.status)

  // INVALIDATION WARNING as a toast (not an inline card that displaces the
  // footer layout): fire once when the user starts editing an already-approved
  // step; re-arm when the step is re-approved (dirty resets).
  const warnedRef = useRef<Record<string, boolean>>({})
  const activeEngineId = activeStep.sourceId ?? activeStep.id
  const activeApproved = engineStatus === 'passed' || engineStatus === 'approved'
  useEffect(() => {
    if (activeApproved && dirty && !warnedRef.current[activeEngineId]) {
      warnedRef.current[activeEngineId] = true
      onToast('Editing this step un-approves it and every step after it — they’ll need approval again.')
    }
    if (!dirty) warnedRef.current[activeEngineId] = false
  }, [activeApproved, dirty, activeEngineId, onToast])

  // CHECK-HEALTH AUTO-HEAL (ROADMAP item 11): when the engine reports stale
  // receipts/sentinels, the fix is re-running free deterministic checks — so
  // do it automatically (rate-limited; the recheck job is idempotent). Only
  // findings that need a human (fix or bypass) ever surface as a card.
  const checkHealth = apiStatus?.data?.check_health
  const recheckFiredAtRef = useRef(0)
  useEffect(() => {
    if (!checkHealth?.needs_recheck) return
    const now = Date.now()
    if (now - recheckFiredAtRef.current < 90_000) return
    recheckFiredAtRef.current = now
    void postAction({ action: 'recheck' })
    onToast('Some earlier checks went out of date — re-running them automatically.')
  }, [checkHealth, onToast])

  const bypassFinding = async (stageId: string, key: string) => {
    const out = await postAction({
      action: 'record_waiver',
      stage_id: stageId,
      key,
      note: `Bypassed from ${activeStep.name} (step ${activeStep.num})`,
    })
    onToast(out?.ok
      ? 'Bypassed — recorded as an accepted exception.'
      : 'Could not record the bypass — is the engine running?')
  }

  // Also consider it "In progress" if this is the first incomplete step and it's just waiting to be worked on
  const nodes = workflowNodes
  const firstIncomplete = firstIncompleteNode
  const isFirstIncompleteStep = activeStep.sourceId === firstIncomplete?.id
  const blockedStepIndex = firstIncomplete ? nodes.findIndex((n) => n.id === firstIncomplete.id) : -1
  const currentStepIndex = nodes.findIndex((n) => n.id === activeStep.sourceId)
  const isBeyondBlocked = firstIncomplete ? currentStepIndex > blockedStepIndex : false
  const activeProgressIncomplete =
    Boolean(activeStep.progress)
    && Number(activeStep.progress?.total || 0) > 0
    && Number(activeStep.progress?.done || 0) < Number(activeStep.progress?.total || 0)

  const statusLabel =
    isCurrentlyEditing ? 'In progress' :
    hasActiveStageProcess ? 'In progress' :
    activeProgressIncomplete ? 'In progress' :
    // Final cut is only Complete when the compiled video actually exists.
    activeStep.id === 'check' && finalRender !== 'done' ? (finalRender === 'failed' ? 'Blocked' : 'In progress') :
    engineStatus === 'passed' || engineStatus === 'approved' ? 'Complete' :
    engineStatus === 'running' ? 'In progress' :
    engineStatus === 'blocked' ? 'Blocked' :
    isFirstIncompleteStep && (engineStatus === 'ready' || engineStatus === 'not_started') ? 'In progress' :
    engineStatus === 'not_started' ? 'Not started' :
    engineStatus === 'ready' ? 'Ready' :
    'Pending'
  // Width should serve the content: wide is for big editors, grids, and
  // timelines. Steps that are reading columns or rows/options (setup, the
  // script's revision chain) stay at normal width.
  const showWide = ['idea', 'pics', 'shots', 'plan', 'worldkit', 'pacing', 'voice', 'check'].includes(activeStep.id)
  const mediaFitPanel = ['check', 'build'].includes(activeStep.id)

  const NODE_W = 172
  const NODE_H = 88
  const NODE_OFF_X = 24
  const NODE_OFF_Y = 14
  const GATE_SZ = 36
  const gatePos = (gate: Gate) => {
    const step = steps.find((s) => s.id === gate.step)
    if (!step) return null
    const nodeLeft = step.x + NODE_OFF_X
    const nodeRight = nodeLeft + NODE_W
    const cx = gate.pos === 'before' ? nodeLeft - 39 : nodeRight + 39
    const cy = step.y + NODE_OFF_Y + NODE_H / 2
    return { cx, cy }
  }
  const gateOnEdge = (fromId: string, toId: string): Gate | null => {
    const after = gates.find((g) => g.step === fromId && g.pos === 'after')
    if (after) return after
    const before = gates.find((g) => g.step === toId && g.pos === 'before')
    if (before) return before
    return null
  }
  const seg = (x1: number, y1: number, x2: number, y2: number) => {
    const dx = Math.max(28, (x2 - x1) / 2)
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
  }
  const vSeg = (x1: number, y1: number, x2: number, y2: number) => {
    const dy = Math.max(24, (y2 - y1) / 2)
    return `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`
  }
  const edgeAnchors = (from: Step, to: Step) => {
    const fromLeft = from.x + NODE_OFF_X
    const fromRight = fromLeft + NODE_W
    const fromTop = from.y + NODE_OFF_Y
    const fromBottom = fromTop + NODE_H
    const fromMidX = fromLeft + NODE_W / 2
    const fromMidY = fromTop + NODE_H / 2
    const toLeft = to.x + NODE_OFF_X
    const toTop = to.y + NODE_OFF_Y
    const toMidX = toLeft + NODE_W / 2
    const toMidY = toTop + NODE_H / 2
    if (toLeft >= fromRight) {
      return { x1: fromRight, y1: fromMidY, x2: toLeft, y2: toMidY, vertical: false }
    }
    if (toTop >= fromBottom) {
      return { x1: fromMidX, y1: fromBottom, x2: toMidX, y2: toTop, vertical: true }
    }
    return { x1: fromRight, y1: fromMidY, x2: toLeft, y2: toMidY, vertical: false }
  }
  const failedAuditGates = gates.filter((g) => g.type === 'audit' && g.state === 'failed')

  useLayoutEffect(() => {
    const card = cardRef.current
    if (!card) return
    const canvas = card.parentElement as HTMLElement | null
    const view = card.closest('.workflow-view') as HTMLElement | null

    const measure = () => {
      if (!card) return
      const isLanding = Boolean(view) && !fullView && !dragPos && landedStepRef.current !== activeStep.id
      // When the detail card lands on a step, pan the canvas so the active node
      // is centered too. This keeps refresh/auto-selected steps from showing a
      // Step 11 card while the viewport is still parked near Step 1.
      if (isLanding && view) {
        const nodeCenterX = activeStep.x + NODE_OFF_X + NODE_W / 2
        const maxLeft = Math.max(0, view.scrollWidth - view.clientWidth)
        view.scrollLeft = Math.max(0, Math.min(nodeCenterX - view.clientWidth / 2, maxLeft))
      }
      // size the card from the view's ACTUAL width (not 100vw) so width and
      // centering always use the same basis — fits any viewport incl. mobile.
      if (view && !fullView) {
        const pinned = document.body.classList.contains('chat-pinned')
        const maxW = showWide ? (pinned ? 1120 : 1280) : 760
        const viewportW = Math.max(420, view.clientWidth - 48)
        const autoW = (() => {
          if (!mediaFitPanel) return Math.min(maxW, Math.max(280, viewportW))
          const viewRect = view.getBoundingClientRect()
          const cardRect = card.getBoundingClientRect()
          const cardTopInView = Math.max(0, cardRect.top - viewRect.top)
          const availableFromCardTop = Math.max(360, view.clientHeight - cardTopInView - 28)
          // Media review panels are driven by a 16:9 player. Reserve vertical
          // room for the card header, script, timeline, footer, and normal
          // spacing; derive width from the remaining player height.
          const reservedHeight = activeStep.id === 'check' ? 430 : 480
          const playerH = Math.max(activeStep.id === 'check' ? 220 : 250, availableFromCardTop - reservedHeight)
          const bodyHorizontalPadding = activeStep.id === 'check' ? 48 : 84
          const fitW = Math.round(playerH * (16 / 9) + bodyHorizontalPadding)
          const viewportFloor = activeStep.id === 'check' ? Math.round(viewportW * 0.78) : 640
          return Math.min(maxW, viewportW, Math.max(viewportFloor, fitW))
        })()
        // A user-set size wins over the automatic width (clamped to the view).
        const targetW =
          userSize.w != null
            ? Math.min(Math.max(420, userSize.w), Math.max(420, view.clientWidth - 32))
            : autoW
        card.style.width = `${targetW}px`
        // Height applies to the card BOX only — scrolling happens inside
        // .detail-body (via the h-sized class), never on the card itself: a
        // scrolling card put its scrollbar over the right resize handle and
        // dragged the bottom handles down with the content.
        card.style.height = userSize.h != null ? `${Math.max(320, userSize.h)}px` : ''
      } else if (fullView) {
        card.style.width = ''
        card.style.height = ''
      }
      const cw = card.offsetWidth
      // center the card horizontally in the visible viewport so it never runs
      // off the right edge and uses the empty space on the left.
      const desiredLeft =
        view && !fullView && !dragPos
          ? Math.round(view.scrollLeft + Math.max(16, (view.clientWidth - cw) / 2))
          : card.offsetLeft
      if (view && !fullView && !dragPos) {
        setRestLeft((prev) => (prev === desiredLeft ? prev : desiredLeft))
      }
      setCardBox({ left: desiredLeft, top: card.offsetTop, width: cw })
      const top = card.offsetTop
      const h = card.offsetHeight
      const vh = view ? view.clientHeight : 0
      // grow the canvas so a tall card is fully reachable by scrolling down.
      if (canvas) {
        if (fullView) {
          canvas.style.minHeight = ''
        } else {
          canvas.style.minHeight = `${Math.max(850, top + h + 80)}px`
        }
      }
      if (view && !fullView && !dragPos) {
        const maxScroll = Math.max(0, view.scrollHeight - vh)
        if (isLanding) {
          landedStepRef.current = activeStep.id
          setTetherAnim(false)
          // keep the clicked node AND the top of the card in view (the nodes sit
          // at the top of the canvas, the card just below). a tall card extends
          // past the fold — scroll down to inspect the rest.
          view.scrollTop = 0
        } else {
          // in-step growth / re-measure (e.g. expanding an inline section):
          // leave the user's scroll position alone — never yank back to the
          // card's top. only clamp if content SHRANK and left us scrolled past
          // the new bottom into empty space.
          if (view.scrollTop > maxScroll) view.scrollTop = maxScroll
        }
      }
    }

    measure()
    // re-measure after paint too, in case late content (images/video) changes height
    const raf = window.requestAnimationFrame(measure)
    window.addEventListener('resize', measure)
    const ro = new ResizeObserver(measure)
    ro.observe(card)
    return () => {
      window.cancelAnimationFrame(raf)
      window.removeEventListener('resize', measure)
      ro.disconnect()
    }
  }, [activeStep.id, activeStep.x, showWide, mediaFitPanel, fullView, dragPos, s1, runningId, userSize])

  // reset the header-float state when the workflow mounts (always starts at top)
  useEffect(() => {
    onScrolledChange(false)
  }, [onScrolledChange])

  const scrollHideRef = useRef(0)
  const handleViewScroll = (e: React.UIEvent<HTMLElement>) => {
    const el = e.currentTarget
    onScrolledChange(el.scrollTop > 8)
    // show scrollbars while scrolling, fade out ~1s after it stops
    el.classList.add('is-scrolling')
    window.clearTimeout(scrollHideRef.current)
    scrollHideRef.current = window.setTimeout(() => el.classList.remove('is-scrolling'), 1000)
  }

  return (
    <section className="workflow-view" onScroll={handleViewScroll}>
      <div
        className="canvas"
        onMouseDown={(event) => {
          // Drag-to-pan the canvas — but only when starting on empty background,
          // never on a node, the step panel, a gate, or any interactive control.
          if ((event.target as HTMLElement).closest('.node, .detail-card, .gate, .gate-legend, button, a, input, textarea, summary')) return
          const view = (event.currentTarget as HTMLElement).parentElement as HTMLElement | null
          if (!view) return
          const startX = event.clientX
          const startY = event.clientY
          const sl = view.scrollLeft
          const st = view.scrollTop
          document.body.style.cursor = 'grabbing'
          const move = (moveEvent: MouseEvent) => {
            view.scrollLeft = sl - (moveEvent.clientX - startX)
            view.scrollTop = st - (moveEvent.clientY - startY)
          }
          const up = () => {
            document.removeEventListener('mousemove', move)
            document.removeEventListener('mouseup', up)
            document.body.style.cursor = ''
          }
          document.addEventListener('mousemove', move)
          document.addEventListener('mouseup', up)
          event.preventDefault()
        }}
      >
        <svg className="edges" viewBox="0 0 3340 850" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
              <path d="M0 0 L10 5 L0 10 z" fill="#414866" />
            </marker>
            <marker id="aropt" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
              <path d="M0 0 L10 5 L0 10 z" fill="#323849" />
            </marker>
            <marker id="aract" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
              <path d="M0 0 L10 5 L0 10 z" fill="#7aa2ff" />
            </marker>
            <marker id="arfail" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0 0 L10 5 L0 10 z" fill="#e96a6a" />
            </marker>
          </defs>
          {edges.map(([a, b]) => {
            const from = steps.find((step) => step.id === a)
            const to = steps.find((step) => step.id === b)
            if (!from || !to) return null
            const anchors = edgeAnchors(from, to)
            const { x1, y1, x2, y2, vertical } = anchors
            const active = from.status === 'done' && to.status === 'work'
            const color = active ? '#7aa2ff' : '#414866'
            const dash = active ? '4 6' : undefined
            const marker = active ? 'aract' : 'ar'
            const drawSeg = vertical ? vSeg : seg
            const gate = vertical ? null : gateOnEdge(a, b)
            if (gate) {
              const gp = gatePos(gate)
              if (gp) {
                const pad = GATE_SZ / 2 + 4
                return (
                  <g key={`${a}-${b}`}>
                    <path
                      d={drawSeg(x1, y1, gp.cx - pad, gp.cy)}
                      fill="none"
                      stroke={color}
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeDasharray={dash}
                    >
                      {active ? (
                        <animate attributeName="stroke-dashoffset" from="20" to="0" dur="0.9s" repeatCount="indefinite" />
                      ) : null}
                    </path>
                    <path
                      d={drawSeg(gp.cx + pad, gp.cy, x2, y2)}
                      fill="none"
                      stroke={color}
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeDasharray={dash}
                      markerEnd={`url(#${marker})`}
                    >
                      {active ? (
                        <animate attributeName="stroke-dashoffset" from="20" to="0" dur="0.9s" repeatCount="indefinite" />
                      ) : null}
                    </path>
                  </g>
                )
              }
            }
            return (
              <path
                key={`${a}-${b}`}
                d={drawSeg(x1, y1, x2, y2)}
                fill="none"
                stroke={color}
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeDasharray={dash}
                markerEnd={`url(#${marker})`}
              >
                {active ? (
                  <animate attributeName="stroke-dashoffset" from="20" to="0" dur="0.9s" repeatCount="indefinite" />
                ) : null}
              </path>
            )
          })}
          {failedAuditGates.map((gate) => {
            const gp = gatePos(gate)
            const step = steps.find((s) => s.id === gate.step)
            if (!gp || !step) return null
            const sx = gp.cx
            const sy = gp.cy - GATE_SZ / 2
            const ex = step.x + NODE_OFF_X + NODE_W / 2
            const ey = step.y + NODE_OFF_Y
            const archY = Math.min(sy, ey) - 46
            return (
              <path
                key={`fail-${gate.id}`}
                className="fail-loop"
                d={`M ${sx} ${sy} C ${sx} ${archY}, ${ex} ${archY}, ${ex} ${ey}`}
                fill="none"
                stroke="#e96a6a"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeDasharray="5 5"
                markerEnd="url(#arfail)"
              />
            )
          })}
          {!fullView && cardBox && activeStep
            ? (() => {
                const x1 = activeStep.x + NODE_OFF_X + NODE_W / 2
                const y1 = activeStep.y + NODE_OFF_Y + NODE_H
                const x2 = cardBox.left + cardBox.width / 2
                const y2 = cardBox.top
                if (y2 <= y1 + 8) return null
                const my = (y1 + y2) / 2
                const d = `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`
                return (
                  <g
                    className="detail-tether-g"
                    onClick={() => setTetherAnim((a) => !a)}
                    style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                  >
                    <path d={d} fill="none" stroke="transparent" strokeWidth="16" />
                    <path
                      className={`detail-tether ${tetherAnim ? 'anim' : ''}`}
                      d={d}
                      fill="none"
                      stroke="#7aa2ff"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeDasharray="5 6"
                      opacity="0.7"
                      style={{ pointerEvents: 'none' }}
                    />
                  </g>
                )
              })()
            : null}
        </svg>
        {steps.map((step) => {
          const progressIncomplete =
            Boolean(step.progress)
            && Number(step.progress?.total || 0) > 0
            && Number(step.progress?.done || 0) < Number(step.progress?.total || 0)
          const displayStatus = progressIncomplete && step.status === 'done' ? 'work' : step.status
          return (
            <button
              className={`node s-${displayStatus} ${selected === step.id ? 'selected' : ''} ${
                step.optional ? 'optional' : ''
              } ${runningId === step.id ? 'running' : ''} ${step.progress ? 'has-progress' : ''}`}
              key={step.id}
              style={{ left: step.x + 24, top: step.y + 14 }}
              onClick={() => setSelected(step.id)}
            >
              <span className="node-stripe" />
              {autopilot && displayStatus !== 'done' ? (
                <span className="auto-badge">AUTO</span>
              ) : null}
              <span className="num">
                {`${step.num}${step.optional ? ' · OPTIONAL' : ''}`}
              </span>
              <span className="node-name">{step.name}</span>
              {step.progress ? (
                <span className="progress">
                  <i style={{ width: `${Math.round((step.progress.done / step.progress.total) * 100)}%` }} />
                </span>
              ) : null}
              <span className="node-foot">
                <b>{displayStatus === 'done' ? 'Complete' : displayStatus === 'work' ? 'In progress' : 'Pending'}</b>
                {step.progress ? <small>{step.progress.done}/{step.progress.total}</small> : null}
              </span>
            </button>
          )
        })}
        {gates.map((gate) => (
          <GateMarker key={gate.id} gate={gate} steps={steps} />
        ))}
        <div className="gate-legend">
          <span>Gates</span>
          <i className="token" />
          <i className="audit" />
          <i className="human" />
          <span>›</span>
        </div>
        <div
          ref={cardRef}
          className={`detail-card step-${activeStep.id} ${showWide ? 'wide' : ''} ${fullView ? 'full' : ''} ${!fullView && userSize.h != null ? 'h-sized' : ''}`}
          style={
            fullView
              ? undefined
              : dragPos
                ? { left: dragPos.x, top: dragPos.y }
                : restLeft != null
                  ? { left: restLeft }
                  : undefined
          }
        >
          {/* RESIZE HANDLES (right edge · bottom edge · corner): drag to set
              the card's size, double-click to go back to automatic. */}
          {!fullView ? (
            <>
              <div
                title="Drag to resize · double-click for automatic width"
                onPointerDown={(e) => startCardResize(e, 'e')}
                onDoubleClick={() => setUserSize((s) => ({ ...s, w: null }))}
                style={{ position: 'absolute', top: 0, bottom: 0, right: -3, width: 7, cursor: 'ew-resize', zIndex: 12, touchAction: 'none' }}
              />
              <div
                title="Drag to resize · double-click for automatic height"
                onPointerDown={(e) => startCardResize(e, 's')}
                onDoubleClick={() => setUserSize((s) => ({ ...s, h: null }))}
                style={{ position: 'absolute', left: 0, right: 0, bottom: -3, height: 7, cursor: 'ns-resize', zIndex: 12, touchAction: 'none' }}
              />
              <div
                title="Drag to resize · double-click for automatic size"
                onPointerDown={(e) => startCardResize(e, 'se')}
                onDoubleClick={() => setUserSize({ w: null, h: null })}
                style={{ position: 'absolute', right: -3, bottom: -3, width: 16, height: 16, cursor: 'nwse-resize', zIndex: 13, touchAction: 'none' }}
              />
            </>
          ) : null}
          <div
            className="detail-head"
            onMouseDown={(event) => {
              if (fullView || (event.target as HTMLElement).closest('button')) return
              const card = cardRef.current
              const canvas = card?.parentElement
              if (!card || !canvas) return
              const cardRect = card.getBoundingClientRect()
              const canvasRect = canvas.getBoundingClientRect()
              const offX = event.clientX - cardRect.left
              const offY = event.clientY - cardRect.top
              const maxX = canvas.clientWidth - card.offsetWidth
              document.body.style.cursor = 'grabbing'
              const move = (moveEvent: MouseEvent) => {
                const nx = Math.max(0, Math.min(maxX, moveEvent.clientX - canvasRect.left - offX))
                const ny = Math.max(0, moveEvent.clientY - canvasRect.top - offY)
                setDragPos({ x: nx, y: ny })
              }
              const up = () => {
                document.removeEventListener('mousemove', move)
                document.removeEventListener('mouseup', up)
                document.body.style.cursor = ''
              }
              document.addEventListener('mousemove', move)
              document.addEventListener('mouseup', up)
              event.preventDefault()
            }}
          >
            <span className="label">
              STEP {activeStep.num}
              {activeStep.optional ? ' · OPTIONAL' : ''}
            </span>
            <h2>{activeStep.name}</h2>
            {apiLoading ? (
              <span className="status-pill work">Checking engine...</span>
            ) : (
              // PER-STEP STATUS: always show this step's own status (statusLabel already
              // turns "In progress" while the user is editing), never the session-wide one.
              <span className={`status-pill ${statusLabel === 'Complete' ? 'done' : statusLabel === 'In progress' || statusLabel === 'Blocked' ? 'work' : activeStep.status}`}>
                {statusLabel.toUpperCase()}
              </span>
            )}
            {activeStep.status === 'done' ? <button>View output</button> : null}
            {activeStep.progress ? (
              <>
                <span className="head-meter">
                  {activeStep.progress.done} / {activeStep.progress.total} ·{' '}
                  {Math.round((activeStep.progress.done / activeStep.progress.total) * 100)}%
                </span>
                <button>Watch live</button>
              </>
            ) : null}
            <span className="spacer" />
            {/* Step-level history, when the active step's editor offers it. */}
            {stepUndo ? (
              <>
                <button disabled={stepUndo.count === 0} onClick={() => stepUndo.run()} title="Undo the last edit on this step">
                  ↶ Undo{stepUndo.count ? ` (${stepUndo.count})` : ''}
                </button>
                {stepUndo.redo ? (
                  <button disabled={(stepUndo.redoCount ?? 0) === 0} onClick={() => stepUndo.redo?.()} title="Redo the last undone edit on this step">
                    ↷ Redo{stepUndo.redoCount ? ` (${stepUndo.redoCount})` : ''}
                  </button>
                ) : null}
              </>
            ) : null}
            <button disabled={selectableIndex <= 0} onClick={() => setSelected(orderedSteps[selectableIndex - 1].id)}>
              ‹ Previous
            </button>
            <button
              disabled={selectableIndex >= orderedSteps.length - 1 || isBlocked}
              onClick={() => setSelected(orderedSteps[selectableIndex + 1].id)}
            >
              Next ›
            </button>
            <span style={{ position: 'relative' }}>
              <button
                className="icon-btn"
                title="Start over — deletes work (asks first)"
                style={{ color: 'var(--amber)' }}
                onClick={() => setResetMenu((v) => !v)}
              >
                ⚠
              </button>
              {resetMenu ? (
                <>
                  <span className="vp-menu-backdrop" onClick={() => setResetMenu(false)} />
                  <span className="vp-menu" style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, minWidth: 290 }}>
                    <span className="vp-menu-h">START OVER</span>
                    <button
                      type="button"
                      onClick={() => {
                        setResetMenu(false)
                        setResetConfirm({ stageId: activeStep.sourceId ?? activeStep.id, name: activeStep.name, whole: false })
                      }}
                    >
                      Start over from this step
                    </button>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => {
                        setResetMenu(false)
                        const first = orderedSteps[0]
                        setResetConfirm({ stageId: first.sourceId ?? first.id, name: first.name, whole: true })
                      }}
                    >
                      Start over from the beginning
                    </button>
                  </span>
                </>
              ) : null}
            </span>
            {activeStep.id === 'check' ? (
              <span className="detail-layout-actions">
                <button
                  type="button"
                  className="layout-mini-btn"
                  title="Save the current Step 11 layout"
                  onClick={() => sendVisualReviewLayoutCommand('save')}
                >
                  Save layout
                </button>
                <button
                  type="button"
                  className="layout-mini-btn"
                  title="Reset to saved layout"
                  onClick={() => sendVisualReviewLayoutCommand('reset')}
                >
                  Reset
                </button>
              </span>
            ) : null}
            <button className="icon-btn expand-btn" onClick={() => setFull((value) => !value)}>
              {fullView ? '⤡' : '⤢'}
            </button>
          </div>
          {resetConfirm ? (
            <div className="modal-scrim">
              <div className="confirm-modal">
                <span className="need">SAVE POINT KEPT</span>
                <h3>
                  {resetConfirm.whole
                    ? 'Start over from the beginning?'
                    : `Start over from “${resetConfirm.name}”?`}
                </h3>
                <p>
                  {resetConfirm.whole
                    ? 'Everything the steps produced is removed and every approval is undone.'
                    : 'This step and everything after it go back to square one — their approvals are undone and the files they produced are removed.'}{' '}
                  Your source material and project settings stay, and a save point of everything
                  removed is kept automatically (the last 5), so it can be brought back if you
                  change your mind.
                </p>
                <div className="actions">
                  <button onClick={() => setResetConfirm(null)}>Never mind</button>
                  <button className="primary" onClick={doReset} disabled={resetting}>
                    {resetting ? 'Working…' : 'Yes, start over'}
                  </button>
                </div>
              </div>
            </div>
          ) : null}
          <div className="detail-body">
            {handoffHere ? (
              // AI HAND-OFF IN FLIGHT: this step is being prepared — show a
              // waiting state and lock interaction until the draft lands.
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '48px 0', justifyContent: 'center' }}>
                <span className="spin" />
                <span style={{ color: 'var(--ink-2)', fontSize: 14 }}>{handoff!.label}</span>
              </div>
            ) : (
              isBeyondBlocked ? null : (
                <StepContent
                  step={activeStep}
                  setupMode={setupMode}
                  showName={showName}
                  castData={castData}
                  blankProject={blankProject}
                  onOpenCast={onOpenCast}
                  onToast={onToast}
                  origin={origin}
                  formatDirty={formatDirty}
                  visualReviewLayoutCommand={visualReviewLayoutCommand}
                />
              )
            )}
            
            {/* SCOPED BLOCKER RULE: The single blocker card. It NEVER shows on the step the user is
                supposed to be working on (the first incomplete step) — there, the disabled
                Save/Approve button is the signal. It ONLY shows on steps strictly AFTER the first
                incomplete step, telling the user which prior step must be completed first. */}
            {!apiLoading && (() => {
              const firstIncomplete = firstIncompleteNode

              if (!firstIncomplete) return null

              // SCOPE CHECK: only steps strictly downstream of the first incomplete step get the card.
              if (currentStepIndex <= blockedStepIndex) {
                return null // On or before the step being worked on — never show the blocker here.
              }

              // Number and name come from the USER-VISIBLE step list, not the
              // engine node index (the graph has internal nodes the UI folds
              // away — counting them said "Step 08 (Visual Pacing)" while the
              // header called the same screen Step 07).
              const blockedUiIndex = orderedSteps.findIndex(
                (s) => (s.sourceId ?? s.id) === firstIncomplete.id,
              )
              const stepNumber = String((blockedUiIndex >= 0 ? blockedUiIndex : blockedStepIndex) + 1).padStart(2, '0')
              const stepName = blockedUiIndex >= 0 ? orderedSteps[blockedUiIndex].name : firstIncomplete.label
              // Detail lines only when the engine explicitly marks the stage blocked (missing artifacts etc.)
              const missingArtifacts = firstIncomplete.status === 'blocked'
                ? (firstIncomplete.artifacts?.filter((a) => a.required && !a.exists) || [])
                : []
              const blockersToShow = missingArtifacts.length > 0
                ? missingArtifacts.map((a) => `Missing required: ${a.pattern}`)
                : firstIncomplete.status === 'blocked'
                  ? (apiStatus?.data?.blockers?.slice(0, 1) || ['Unknown blocker'])
                  : []

              return (
                <div className="card" style={{ marginTop: 24, borderColor: 'var(--red)', background: 'rgba(233,106,106,.06)' }}>
                  <div className="ch" style={{ marginBottom: blockersToShow.length > 0 ? 12 : 0 }}>
                    <h3 style={{ color: 'var(--red)' }}>Step {stepNumber} ({stepName}) must be completed first</h3>
                    <span className="label">Finish that step before this one unlocks</span>
                  </div>
                  {blockersToShow.length > 0 && (
                    <ul style={{ margin: 0, paddingLeft: 20, color: 'var(--ink-2)', fontSize: 13, lineHeight: 1.6 }}>
                      {blockersToShow.map((blocker: string, idx: number) => (
                        <li key={idx}>{blocker}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )
            })()}

            {/* CHECK-HEALTH FINDINGS (ROADMAP item 11): earlier-step check
                failures that need a human, surfaced BEFORE compile with the
                two doors — go fix at the source, or bypass (recorded waiver).
                Stale-only items never appear here; they auto-heal above. */}
            {(() => {
              const findings = (checkHealth?.stages ?? []).flatMap((stage) =>
                (stage.findings || [])
                  .filter((f) => !f.waived && f.severity !== 'stale')
                  .map((f) => ({ ...f, stageId: stage.stage_id })),
              )
              if (!findings.length) return null
              const showHere =
                activeStep.id === 'check'
                || findings.some((f) => HEALTH_OWNER_STEP[f.stageId]?.id === activeStep.id)
              if (!showHere) return null
              return (
                <div className="card" style={{ marginTop: 24, borderColor: 'var(--red)', background: 'rgba(233,106,106,.06)' }}>
                  <div className="ch" style={{ marginBottom: 12 }}>
                    <h3 style={{ color: 'var(--red)' }}>
                      Earlier checks found {findings.length} issue{findings.length === 1 ? '' : 's'}
                    </h3>
                    <span className="label">Fix at the source, or bypass</span>
                  </div>
                  <div style={{ display: 'grid', gap: 10 }}>
                    {findings.map((f) => {
                      const owner = HEALTH_OWNER_STEP[f.stageId]
                      return (
                        <div key={`${f.stageId}:${f.key}`} style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                          <span style={{ flex: 1, color: 'var(--ink-2)', fontSize: 13, lineHeight: 1.5 }}>{f.message}</span>
                          {owner && owner.id !== activeStep.id ? (
                            <button type="button" className="vp-undo" onClick={() => setSelected(owner.id)}>
                              Go to {owner.label}
                            </button>
                          ) : null}
                          {f.waivable ? (
                            <button type="button" className="vp-undo" onClick={() => void bypassFinding(f.stageId, f.key)}>
                              Bypass
                            </button>
                          ) : null}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })()}

            {/* AI HAND-OFF option (content area — the standard button block below
                stays untouched): after approving this step, AI prepares the next. */}
            {(activeStep.id === 'plan' || activeStep.id === 'worldkit' || activeStep.id === 'script' || activeStep.id === 'pacing') && (
              <label
                title="Runs right after your approval — uses model credits"
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 7,
                  marginTop: 16, color: 'var(--ink-3)', fontSize: 12, cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={updateKitAfter}
                  onChange={(e) => setUpdateKitAfter(e.target.checked)}
                  style={{ accentColor: 'var(--ink-2)', margin: 0 }}
                />
                {activeStep.id === 'plan'
                  ? 'after approval, AI adds this structure’s new characters, places & props to the World Kit'
                  : activeStep.id === 'worldkit'
                    ? 'after approval, AI writes the initial script from this kit on the next step'
                    : activeStep.id === 'script'
                      ? 'after approval, AI plans the visuals — what appears on screen, when, and why'
                      : 'after approval, AI builds the storyboard from this plan — checked by the validator before you see it'}
              </label>
            )}

            <div className="detail-foot">
              {(() => {
                const nodes = workflowNodes
                
                // 1. STATE CALCULATOR: Pure logic, isolated from UI rendering
                const hasStageDraft = (st: Step) =>
                  (stageDrafts[st.sourceId ?? st.id] ?? '').trim().length > 0
                const isDraftStage = (st: Step) =>
                  st.sourceId != null && st.sourceId in STAGE_DRAFT_OUTPUTS

                const isComplete = (st: Step) => {
                  // Final cut FIRST, before the engine-status short-circuit: its
                  // backing stage (the visual audits) can be approved while no
                  // video exists. "Complete" here means the compiled, audited
                  // video is actually on disk (the store tracks its sentinel).
                  if (st.id === 'check') return finalRender === 'done'
                  if (st.status === 'done') return true
                  if (st.id === 'setup') return blankProject ? Boolean(s1.narrator && s1.style && s1.output) : true
                  if (st.id === 'idea') return ideaBrief.trim().length > 0
                  if (st.id === 'goal') return goal.text.trim().length > 0 || goal.mode === 'ai' || goal.mode === 'skip'
                  if (isDraftStage(st)) return hasStageDraft(st)
                  if (st.id === 'script') {
                    // Screenplay completes only when the engine confirms it: all
                    // three output files exist AND the rule-gated audit passed.
                    const n = nodes.find((x) => x.id === st.sourceId)
                    return n?.status === 'passed' || n?.status === 'approved'
                  }
                  return false
                }

                const currentInputComplete =
                  activeStep.id === 'setup' && blankProject
                    ? Boolean(s1.narrator && s1.style && s1.output)
                    : activeStep.id === 'idea'
                      ? ideaBrief.trim().length > 0
                      : activeStep.id === 'goal'
                        ? goal.text.trim().length > 0 || goal.mode === 'ai' || goal.mode === 'skip'
                        : isDraftStage(activeStep)
                          ? hasStageDraft(activeStep)
                          : activeStep.id === 'script' || activeStep.id === 'check'
                            ? isComplete(activeStep)
                            : true
                        
                const priorsComplete = orderedSteps.slice(0, selectableIndex).every(isComplete)
                const stepComplete = currentInputComplete && priorsComplete
                
                const currentNode = nodes.find((n) => n.id === activeStep.sourceId)
                const isAlreadyApproved = currentNode?.status === 'passed' || currentNode?.status === 'approved'
                const needsApproval = currentNode?.requires_approval === true
                
                // PROGRESSION RULE: complete approved stages can still move to
                // the next card. Dirty approved stages re-run approval first.
                const canProceed = !autopilot && stepComplete && !isBeyondBlocked && !handoffHere
                
                const goalIndex = orderedSteps.findIndex((s) => s.id === 'goal')
                const isLast = selectableIndex >= orderedSteps.length - 1
                // Autopilot stays VISIBLE on blocked-downstream steps — just disabled, like the save button.
                const canAutopilot = !autopilot && goalIndex >= 0 && selectableIndex >= goalIndex && !isLast

                // 2. UI RENDERER: Dumb display based on calculator outputs
                return (
                  <>
                    {/* Autopilot UI (Always renders first to stay on the left) */}
                    {canAutopilot && (
                      <>
                        <div className="foot-choice">
                          <button
                            className="autopilot-btn"
                            disabled={!stepComplete || isBeyondBlocked}
                            title={isBeyondBlocked ? 'Complete the earlier steps first' : !stepComplete ? (!priorsComplete ? 'Complete the earlier steps first' : activeStep.id === 'check' ? (finalRender === 'stale' ? 'Visuals changed — compile the final video again' : 'Compile the final video first') : 'Make a choice for this step first') : undefined}
                            onClick={() => {
                              if (!stepComplete || isBeyondBlocked) return
                              onAutopilot()
                            }}
                          >
                            <span className="ap-spark">✦</span> Autopilot
                          </button>
                          <span className="foot-sub">AI finishes every step — no input needed</span>
                        </div>
                        <span className="foot-or">or</span>
                      </>
                    )}

                    {/* Main Save/Continue Choice — the foot-sub under the button
                        explains what's missing, so no extra hint that would
                        displace the button layout. */}
                    <div className="foot-choice">
                      {/* Invalidation warning is a toast (fired on first edit of an
                          approved step) — nothing inline that shifts the buttons. */}
                      {/* Native button: relies entirely on .save-continue:disabled CSS for muted styling */}
                      <button
                        className="save-continue"
                        disabled={!canProceed}
                        onClick={async () => {
                          if (!canProceed || advancing) return
                          // Approved-and-clean is a TERMINAL click state: navigate on,
                          // or (on the last step) do nothing. It must NEVER fall
                          // through to onAdvance — that path starts with the
                          // invalidation rewind and would revoke a good approval.
                          if (isAlreadyApproved && !dirty) {
                            if (!isLast) setSelected(orderedSteps[selectableIndex + 1].id)
                            return
                          }
                          // ENGINE-FIRST RULE: only advance and clear the dirty flag if the
                          // engine actually accepted the save/approval. If it refused, stay
                          // put — the step keeps its "in progress" state and the refreshed
                          // blockers explain what's missing.
                          setAdvancing(true)
                          try {
                            const ok = await onAdvance(activeStep.id, {
                              aiHandoff: (activeStep.id === 'plan' || activeStep.id === 'worldkit' || activeStep.id === 'script' || activeStep.id === 'pacing') && updateKitAfter,
                            })
                            if (ok === false) return
                            clearDirty(activeStep.sourceId ?? activeStep.id)
                            if (isLast) onToast('Approved and finished.')
                            else {
                              setSelected(orderedSteps[selectableIndex + 1].id)
                              onToast(isAlreadyApproved ? 'Stage re-approved.' : (needsApproval ? 'Stage approved.' : 'Saved.'))
                            }
                          } finally {
                            setAdvancing(false)
                          }
                        }}
                      >
                        {advancing
                          ? 'Working…'
                          : isAlreadyApproved && !dirty && stepComplete
                            ? (isLast ? 'Completed' : 'Save and continue →')
                            : needsApproval
                              ? (isLast ? 'Approve & finish' : 'Approve & continue →')
                              : (isLast ? 'Save and finish' : 'Save and continue →')
                        }
                      </button>
                      <span className="foot-sub">
                        {autopilot
                          ? 'Autopilot is running — stop it to edit by hand'
                          : isAlreadyApproved && !dirty && stepComplete
                            ? (isLast ? 'Step is complete.' : 'Step is complete. Go to the next step.')
                            : !stepComplete
                              ? activeStep.id === 'script'
                                ? 'The rule checks must pass — or be skipped — before this step can be approved'
                                : activeStep.id === 'check'
                                  ? (finalRender === 'stale'
                                    ? 'Visuals changed — compile the final video again'
                                    : 'Compile the final video first')
                                  : 'Finish this step’s sections first'
                              : isBeyondBlocked
                                ? 'Resolve the blocker above before continuing'
                                : needsApproval
                                  ? 'Click to grant approval and proceed'
                                  : 'You review each remaining step'}
                      </span>
                    </div>
                  </>
                )
              })()}
            </div>
          </div>
        </div>
        <span className="canvas-meta">
          Format template: explainer · {((explainerContract as { stages: unknown[] }).stages.length)} steps
          · anime-news-video available ({((newsContract as { stages: unknown[] }).stages.length)} steps)
        </span>
      </div>
    </section>
  )
}

function GateMarker({ gate, steps }: { gate: Gate; steps: Step[] }) {
  const step = steps.find((item) => item.id === gate.step)
  if (!step) return null
  const nodeLeft = step.x + 24
  const nodeRight = nodeLeft + 172
  const cx = gate.pos === 'before' ? nodeLeft - 39 : nodeRight + 39
  const cy = step.y + 14 + 88 / 2
  const left = cx - 18
  const top = cy - 18
  const tone =
    gate.state === 'approved' || gate.state === 'consumed' || gate.state === 'passed'
      ? 'good'
      : gate.state === 'failed'
        ? 'failed'
        : 'pending'
  return (
    <span className={`gate ${gate.type} ${tone}`} style={{ left, top }}>
      {gate.type === 'human' ? 'H' : gate.type === 'token' ? 'T' : 'A'}
      {tone === 'good' ? <b>✓</b> : tone === 'failed' ? <b>!</b> : null}
      <span className="tip">
        <strong>{gate.type} gate · {gate.pos === 'before' ? 'on entry' : 'on exit'}</strong>
        <em>{gate.label}</em>
        <small>State · {gate.state}</small>
        <small>{gate.source}</small>
      </span>
    </span>
  )
}
