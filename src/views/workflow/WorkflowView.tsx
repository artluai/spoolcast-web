import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import explainerContract from '../../contracts/explainer.json'
import newsContract from '../../contracts/news-anime-bot.json'
import { castByShow } from '../../data/cast'
import { STAGE_DRAFT_OUTPUTS } from '../../data/stage-outputs'
import { useWorkflowStore } from '../../store/workflow'
import type { Gate, OnboardSeed, SetupMode, Step } from '../../types'
import { StepContent } from './StepContent'

export function WorkflowView({
  steps: rawSteps,
  gates,
  seed,
  selected,
  setSelected,
  activeStep,
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
  apiStatus: any
  apiLoading: boolean
  isBlocked: boolean
  setupMode: SetupMode
  showName: string
  castData: (typeof castByShow)['spoolcast dev log']
  blankProject: boolean
  autopilot: boolean
  onOpenCast: () => void
  onToast: (message: string) => void
  onAdvance: (id: string, opts?: { updateWorldKit?: boolean }) => void | boolean | Promise<boolean | void>
  onScrolledChange: (scrolled: boolean) => void
  onAutopilot: () => void
  runningId: string | null
  origin: 'blank' | 'template' | 'series'
}) {
  const [full, setFull] = useState(false)
  // Step 4 → 5 hand-off: after approving the structure, AI refreshes the World
  // Kit with what the new structure needs. On by default; the checkbox is the
  // user's spend consent.
  const [updateKitAfter, setUpdateKitAfter] = useState(true)
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

  // IN-PROGRESS RULE: a step the user has started typing in (dirty) shows as
  // "In progress" instead of "Pending" — derived here, in one place, from the
  // store's per-step dirty flags. Engine-confirmed statuses (done) win.
  const dirtyStepsMap = useWorkflowStore((s) => s.dirtySteps)
  const steps = useMemo(
    () =>
      rawSteps.map((step) =>
        step.status === 'later' && dirtyStepsMap[step.sourceId ?? step.id]
          ? { ...step, status: 'work' as const }
          : step,
      ),
    [rawSteps, dirtyStepsMap],
  )

  // DIRTY STATE TRACKING: per-step dirty flags live in the zustand workflow store,
  // keyed by the engine node id (activeStep.sourceId) the approval logic compares against.
  const s1 = useWorkflowStore((s) => s.s1)
  const ideaBrief = useWorkflowStore((s) => s.ideaBrief)
  const goal = useWorkflowStore((s) => s.goal)
  const seedDrafts = useWorkflowStore((s) => s.seedDrafts)
  const stageDrafts = useWorkflowStore((s) => s.stageDrafts)
  const clearDirty = useWorkflowStore((s) => s.clearDirty)
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
      ['check', 'build'],
      ['voice', 'build'],
      ['build', 'caps'],
      ['caps', 'post'],
      ['caps', 'phone'],
      ['phone', 'post'],
    ] as const
  }, [])

  const orderedSteps = steps
  const selectableIndex = orderedSteps.findIndex((step) => step.id === selected)
  
  // RULE 3: "In Progress" = THIS step is dirty (user typed in it since last
  // approval). Per-step via the store's dirty flags — covers the seed fields
  // AND the stage draft editors, and never bleeds across steps.
  const isCurrentlyEditing = dirty

  const engineNode = apiStatus?.data?.workflow_graph?.nodes?.find((n: any) => n.id === activeStep.sourceId)
  const engineStatus = engineNode?.status || 'not_started'

  // INVALIDATION WARNING as a toast (not an inline card that displaces the
  // footer layout): fire once when the user starts editing an already-approved
  // step; re-arm when the step is re-approved (dirty resets).
  const warnedRef = useRef<Record<string, boolean>>({})
  const activeEngineId = activeStep.sourceId ?? activeStep.id
  const activeApproved = engineStatus === 'passed' || engineStatus === 'approved'
  useEffect(() => {
    if (activeApproved && dirty && !warnedRef.current[activeEngineId]) {
      warnedRef.current[activeEngineId] = true
      onToast('Changes here will invalidate downstream approvals — re-approve to continue.')
    }
    if (!dirty) warnedRef.current[activeEngineId] = false
  }, [activeApproved, dirty, activeEngineId, onToast])

  // Also consider it "In progress" if this is the first incomplete step and it's just waiting to be worked on
  const nodes = apiStatus?.data?.workflow_graph?.nodes || []
  const firstIncomplete = nodes.find((n: any) => n.status !== 'passed' && n.status !== 'approved')
  const isFirstIncompleteStep = activeStep.sourceId === firstIncomplete?.id

  const statusLabel = 
    isCurrentlyEditing ? 'In progress' :
    engineStatus === 'passed' || engineStatus === 'approved' ? 'Complete' :
    engineStatus === 'running' ? 'In progress' :
    engineStatus === 'blocked' ? 'Blocked' :
    isFirstIncompleteStep && (engineStatus === 'ready' || engineStatus === 'not_started') ? 'In progress' :
    engineStatus === 'not_started' ? 'Not started' :
    engineStatus === 'ready' ? 'Ready' :
    'Pending'
  const showWide = ['setup', 'idea', 'pics', 'shots', 'plan', 'worldkit', 'pacing'].includes(activeStep.id)

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
      // during AUTOPILOT, pan the canvas so the active node stays centered/visible.
      // on a manual click we leave the view where it is — the card just centers
      // in whatever the user is currently looking at.
      if (isLanding && view && runningId) {
        const nodeCenterX = activeStep.x + NODE_OFF_X + NODE_W / 2
        const maxLeft = Math.max(0, view.scrollWidth - view.clientWidth)
        view.scrollLeft = Math.max(0, Math.min(nodeCenterX - view.clientWidth / 2, maxLeft))
      }
      // size the card from the view's ACTUAL width (not 100vw) so width and
      // centering always use the same basis — fits any viewport incl. mobile.
      if (view && !fullView) {
        const pinned = document.body.classList.contains('chat-pinned')
        const maxW = showWide ? (pinned ? 1120 : 1280) : 760
        const targetW = Math.min(maxW, Math.max(280, view.clientWidth - 48))
        card.style.width = `${targetW}px`
      } else if (fullView) {
        card.style.width = ''
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
  }, [activeStep.id, activeStep.x, showWide, fullView, dragPos, s1, runningId])

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
            const optional = a === 'caps' && b === 'phone'
            const active = from.status === 'done' && to.status === 'work'
            const color = optional ? '#323849' : active ? '#7aa2ff' : '#414866'
            const dash = optional ? '6 6' : active ? '4 6' : undefined
            const marker = optional ? 'aropt' : active ? 'aract' : 'ar'
            const drawSeg = vertical ? vSeg : seg
            const gate = optional || vertical ? null : gateOnEdge(a, b)
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
        {steps.map((step) => (
          <button
            className={`node s-${step.status} ${selected === step.id ? 'selected' : ''} ${
              step.optional ? 'optional' : ''
            } ${runningId === step.id ? 'running' : ''}`}
            key={step.id}
            style={{ left: step.x + 24, top: step.y + 14 }}
            onClick={() => setSelected(step.id)}
          >
            <span className="node-stripe" />
            {autopilot && step.status !== 'done' ? (
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
              <b>{step.status === 'done' ? 'Complete' : step.status === 'work' ? 'In progress' : 'Pending'}</b>
              {step.progress ? <small>{step.progress.done}/{step.progress.total}</small> : null}
            </span>
          </button>
        ))}
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
          className={`detail-card ${showWide ? 'wide' : ''} ${fullView ? 'full' : ''}`}
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
            <button disabled={selectableIndex <= 0} onClick={() => setSelected(orderedSteps[selectableIndex - 1].id)}>
              ‹ Previous
            </button>
            <button
              disabled={selectableIndex >= orderedSteps.length - 1 || isBlocked}
              onClick={() => setSelected(orderedSteps[selectableIndex + 1].id)}
            >
              Next ›
            </button>
            <button className="icon-btn expand-btn" onClick={() => setFull((value) => !value)}>
              {fullView ? '⤡' : '⤢'}
            </button>
          </div>
          <div className="detail-body">
            {/* 1. Always show the normal step content first */}
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
            />
            
            {/* SCOPED BLOCKER RULE: The single blocker card. It NEVER shows on the step the user is
                supposed to be working on (the first incomplete step) — there, the disabled
                Save/Approve button is the signal. It ONLY shows on steps strictly AFTER the first
                incomplete step, telling the user which prior step must be completed first. */}
            {!apiLoading && (() => {
              const nodes = apiStatus?.data?.workflow_graph?.nodes || []
              const firstIncomplete = nodes.find((n: any) => n.status !== 'passed' && n.status !== 'approved')

              if (!firstIncomplete) return null

              // SCOPE CHECK: only steps strictly downstream of the first incomplete step get the card.
              const blockedStepIndex = nodes.findIndex((n: any) => n.id === firstIncomplete.id)
              const currentStepIndex = nodes.findIndex((n: any) => n.id === activeStep.sourceId)

              if (currentStepIndex <= blockedStepIndex) {
                return null // On or before the step being worked on — never show the blocker here.
              }

              const stepNumber = String(blockedStepIndex + 1).padStart(2, '0')
              // Detail lines only when the engine explicitly marks the stage blocked (missing artifacts etc.)
              const missingArtifacts = firstIncomplete.status === 'blocked'
                ? (firstIncomplete.artifacts?.filter((a: any) => a.required && !a.exists) || [])
                : []
              const blockersToShow = missingArtifacts.length > 0
                ? missingArtifacts.map((a: any) => `Missing required: ${a.pattern}`)
                : firstIncomplete.status === 'blocked'
                  ? (apiStatus.data.blockers?.slice(0, 1) || ['Unknown blocker'])
                  : []

              return (
                <div className="card" style={{ marginTop: 24, borderColor: 'var(--red)', background: 'rgba(233,106,106,.06)' }}>
                  <div className="ch" style={{ marginBottom: blockersToShow.length > 0 ? 12 : 0 }}>
                    <h3 style={{ color: 'var(--red)' }}>Step {stepNumber} ({firstIncomplete.label}) must be completed first</h3>
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

            <div className="detail-foot">
              {(() => {
                const nodes = apiStatus?.data?.workflow_graph?.nodes || []
                const firstIncomplete = nodes.find((n: any) => n.status !== 'passed' && n.status !== 'approved')
                
                // 1. STATE CALCULATOR: Pure logic, isolated from UI rendering
                const hasStageDraft = (st: Step) =>
                  (stageDrafts[st.sourceId ?? st.id] ?? '').trim().length > 0
                const isDraftStage = (st: Step) =>
                  st.sourceId != null && st.sourceId in STAGE_DRAFT_OUTPUTS

                const isComplete = (st: Step) => {
                  if (st.status === 'done') return true
                  if (st.id === 'setup') return blankProject ? Boolean(s1.narrator && s1.style && s1.output) : true
                  if (st.id === 'idea') return ideaBrief.trim().length > 0
                  if (st.id === 'goal') return goal.text.trim().length > 0 || goal.mode === 'ai' || goal.mode === 'skip'
                  if (isDraftStage(st)) return hasStageDraft(st)
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
                          : true
                        
                const priorsComplete = orderedSteps.slice(0, selectableIndex).every(isComplete)
                const stepComplete = currentInputComplete && priorsComplete
                
                const currentNode = nodes.find((n: any) => n.id === activeStep.sourceId)
                const isAlreadyApproved = currentNode?.status === 'passed' || currentNode?.status === 'approved'
                const needsApproval = currentNode?.requires_approval === true
                
                const blockedStepIndex = firstIncomplete ? nodes.findIndex((n: any) => n.id === firstIncomplete.id) : -1
                const currentStepIndex = nodes.findIndex((n: any) => n.id === activeStep.sourceId)
                const isBeyondBlocked = firstIncomplete ? currentStepIndex > blockedStepIndex : false
                
                // PROGRESSION RULE: Can proceed only if complete, not beyond a blocker, and not already approved (unless dirty)
                const canProceed = !autopilot && stepComplete && !isBeyondBlocked && !(isAlreadyApproved && !dirty)
                
                const goalIndex = orderedSteps.findIndex((s) => s.id === 'goal')
                // Autopilot stays VISIBLE on blocked-downstream steps — just disabled, like the save button.
                const canAutopilot = !autopilot && goalIndex >= 0 && selectableIndex >= goalIndex && activeStep.id !== 'post'
                const isLast = selectableIndex >= orderedSteps.length - 1

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
                            title={isBeyondBlocked ? 'Complete the earlier steps first' : !stepComplete ? (!priorsComplete ? 'Complete the earlier steps first' : 'Make a choice for this step first') : undefined}
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
                      {activeStep.id === 'plan' && (
                        <label
                          style={{
                            display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10,
                            color: 'var(--ink-2)', fontSize: 13, cursor: 'pointer',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={updateKitAfter}
                            onChange={(e) => setUpdateKitAfter(e.target.checked)}
                            style={{ accentColor: 'var(--ink-2)' }}
                          />
                          <span>
                            <span className="ap-spark">✦</span> After approval, AI updates the World Kit — new
                            characters, places and props this structure needs
                            <span style={{ color: 'var(--ink-3)', fontSize: 12 }}> · uses model credits</span>
                          </span>
                        </label>
                      )}
                      {/* Invalidation warning is a toast (fired on first edit of an
                          approved step) — nothing inline that shifts the buttons. */}
                      {/* Native button: relies entirely on .save-continue:disabled CSS for muted styling */}
                      <button
                        className="save-continue"
                        disabled={!canProceed}
                        onClick={async () => {
                          if (!canProceed) return
                          // ENGINE-FIRST RULE: only advance and clear the dirty flag if the
                          // engine actually accepted the save/approval. If it refused, stay
                          // put — the step keeps its "in progress" state and the refreshed
                          // blockers explain what's missing.
                          const ok = await onAdvance(activeStep.id, {
                            updateWorldKit: activeStep.id === 'plan' && updateKitAfter,
                          })
                          if (ok === false) return
                          clearDirty(activeStep.sourceId ?? activeStep.id)
                          if (isLast) onToast('Approved and finished.')
                          else {
                            setSelected(orderedSteps[selectableIndex + 1].id)
                            onToast(isAlreadyApproved ? 'Stage re-approved.' : (needsApproval ? 'Stage approved.' : 'Saved.'))
                          }
                        }}
                      >
                        {isAlreadyApproved && !dirty 
                          ? 'Completed' 
                          : needsApproval 
                            ? (isLast ? 'Approve & finish' : 'Approve & continue →') 
                            : (isLast ? 'Save and finish' : 'Save and continue →')
                        }
                      </button>
                      <span className="foot-sub">
                        {autopilot
                          ? 'Autopilot is running — stop it to edit by hand'
                          : isAlreadyApproved && !dirty
                            ? 'Step is complete. Edit to re-approve.'
                            : !stepComplete
                              ? 'Finish this step’s sections first'
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
