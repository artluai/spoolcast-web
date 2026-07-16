import { useCallback, useEffect, useRef, useState } from 'react'
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom'
import type { ChatState, ChatTab, OnboardSeed, SetupMode } from './types'
import { castByShow, showBySeries } from './data/cast'
import {
  FALLBACK_CONTRACT,
  buildGates,
  buildStepsFromContract,
  stageToStepMap,
  type WorkflowContract,
} from './lib/workflow-graph'
import { actionUrl, activeSession, contractUrl, fileUrl, getFileJson, getJson, postAction, sessionsUrl, setActiveSession, statusUrl } from './lib/api'
import { STAGE_DRAFT_OUTPUTS } from './data/stage-outputs'
import { useWorkflowStore } from './store/workflow'
import { AutopilotRunner } from './components/AutopilotRunner'
import { ChatWidget } from './components/ChatWidget'
import { ConfirmModal } from './components/ConfirmModal'
import { Footer } from './components/Footer'
import { Header } from './components/Header'
import { ProfileDrawer } from './components/ProfileDrawer'
import { SavePointsModal } from './components/SavePointsModal'
import { LibraryView } from './views/LibraryView'
import { LoginView, SignupModal } from './views/LoginView'
import { OnboardingView } from './views/OnboardingView'
import { PickerView } from './views/PickerView'
import { WorkflowView } from './views/workflow/WorkflowView'
import { WorldKitView } from './views/workflow/WorldKit'
import { RulesView } from './views/RulesView'

type ApiArtifact = {
  stage_id?: string
  pattern?: string
  matches?: number
  path?: string
  exists?: boolean
}

type ShotListBeat = { narration?: string }
type ShotListChunk = { beats?: ShotListBeat[]; id?: string; image_source?: string; boundary_kind?: string }
type ShotListBaseLayerEvent = { id?: string; role?: string; image_source?: string }
type ShotListData = { chunks?: ShotListChunk[]; base_layer?: ShotListBaseLayerEvent[] }
type SceneManifestData = {
  items?: {
    id?: string
    chunk_id?: string
    role?: string
    status?: string
    local_path?: string
    mime_type?: string
  }[]
}
type ApiStatusPayload = {
  data?: {
    artifacts?: ApiArtifact[]
    uiProgress?: Record<string, unknown>
    [key: string]: unknown
  }
  [key: string]: unknown
}

const countNarratedChunks = (shotList: ShotListData | null) =>
  (shotList?.chunks || []).filter((chunk) =>
    (chunk?.beats || []).some((beat) => String(beat?.narration || '').trim()),
  ).length

const countBaseVisuals = (shotList: ShotListData | null) =>
  Array.isArray(shotList?.base_layer)
    ? shotList.base_layer.filter((event) => (event?.role || 'base_visual') === 'base_visual').length
    : 0

const sceneManifestMediaIds = (manifest: SceneManifestData | null) => {
  const ids = new Set<string>()
  for (const item of manifest?.items || []) {
    if (item.status && item.status !== 'success') continue
    const id = String(item.id || item.chunk_id || '').trim()
    if (!id) continue
    const role = String(item.role || '').trim()
    const mime = String(item.mime_type || '').trim()
    const path = String(item.local_path || '').trim().toLowerCase()
    const isMedia =
      role === 'scene'
      || role === 'scene-video'
      || mime.startsWith('image/')
      || mime.startsWith('video/')
      || /\.(png|jpe?g|webp|mp4|mov|webm)$/.test(path)
    if (isMedia) ids.add(id)
  }
  return ids
}

const countVisualCoverage = (shotList: ShotListData | null, manifest: SceneManifestData | null, fallback: number) => {
  const coveredIds = sceneManifestMediaIds(manifest)
  if (!shotList?.base_layer?.length || !coveredIds.size) return fallback
  return shotList.base_layer.filter((event) => {
    if ((event?.role || 'base_visual') !== 'base_visual') return false
    const id = String(event.id || '').trim()
    return id && coveredIds.has(id)
  }).length
}

function App() {
  return (
    <BrowserRouter>
      <SpoolcastApp />
    </BrowserRouter>
  )
}

function SpoolcastApp() {
  const navigate = useNavigate()
  const location = useLocation()
  const route = location.pathname
  // THE SESSION COMES FROM THE ROUTE. /p/:id (and its /world-kit and /rules
  // children) names the engine session; everything below fetches through the
  // api.ts seam, which resolves to this. Set during render, before any
  // session-scoped child mounts and fetches. '/p/new' is the mock blank flow —
  // api.ts maps it to the dev fallback session.
  const routeSession = /^\/p\/([^/]+)/.exec(route)?.[1] ?? null
  setActiveSession(routeSession)
  const initialStandalone = route.startsWith('/p/new')
  const [setupMode, setSetupMode] = useState<SetupMode>(initialStandalone ? 'standalone' : 'series')
  // 'standalone' (no show, empty cast/kit) is the DEFAULT guess everywhere;
  // only the session's own series field — or an explicit mock flow — upgrades it.
  const [showName, setShowName] = useState('standalone')
  const [steps, setSteps] = useState(() => buildStepsFromContract(FALLBACK_CONTRACT, initialStandalone, null))
  const [gates, setGates] = useState(() => buildGates(FALLBACK_CONTRACT, initialStandalone, null))
  const [selected, setSelected] = useState<string>('setup') // Will be updated by useEffect once API loads
  const [autopilot, setAutopilot] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [savesOpen, setSavesOpen] = useState(false)
  const [chatState, setChatState] = useState<ChatState>('closed')
  const [chatTab, setChatTab] = useState<ChatTab>('chat')
  const [confirmAuto, setConfirmAuto] = useState(false)
  const [toast, setToast] = useState('')
  const [customChat, setCustomChat] = useState(false)
  const [headerScrolled, setHeaderScrolled] = useState(false)
  const [autopilotRun, setAutopilotRun] = useState<{ id: string; name: string }[] | null>(null)
  const [autopilotActiveId, setAutopilotActiveId] = useState<string | null>(null)
  const [onboardSeed, setOnboardSeed] = useState<OnboardSeed | null>(null)
  const [origin, setOrigin] = useState<'blank' | 'template' | 'series'>(
    initialStandalone ? 'blank' : 'series',
  )
  // mock auth: returning users sign in at the login screen; first-timers go
  // through onboarding and are gated into signing up before generation runs.
  const [signedIn, setSignedIn] = useState(false)
  const [pendingFinish, setPendingFinish] = useState<{ seed: OnboardSeed; auto: boolean } | null>(
    null,
  )

  // Live API State: Fetches real engine status to enforce gates
  const [apiStatus, setApiStatus] = useState<any>(null)
  const [apiLoading, setApiLoading] = useState(true)
  // The session's stage graph, served by the engine (GET /api/contract).
  // FALLBACK_CONTRACT covers engine-down and the /p/new mock flow only.
  const [contract, setContract] = useState<WorkflowContract>(FALLBACK_CONTRACT)
  // Last observed presence of the render-audit sentinel (null = not yet polled) —
  // 'done' is derived from load-seed or absent→present edges, never plain presence.
  const renderSentinelRef = useRef<boolean | null>(null)
  // AUTO-NAVIGATION RULE: Only run ONCE per opened session. Prevents race
  // conditions where manual navigation is overridden by background API updates.
  const hasAutoNavigatedRef = useRef(false)

  // SESSION SWITCH: moving to a different /p/:id drops the previous session's
  // truth everywhere — the per-session store (drafts, dirty flags, render
  // state), the cached status, and the once-per-session sentinels. A draft
  // leaking across sessions would be saved into the wrong project's files.
  const prevSessionRef = useRef<string | null | undefined>(undefined)
  // Set when the blank flow creates its real session (create-on-save): the
  // route change to that id is an ADOPTION, not a switch — the drafts typed
  // on /p/new belong to the new session and must survive.
  const adoptSessionRef = useRef<string | null>(null)
  useEffect(() => {
    if (prevSessionRef.current === routeSession) return
    const isFirstMount = prevSessionRef.current === undefined
    prevSessionRef.current = routeSession
    if (isFirstMount) return // fresh store, nothing to drop
    if (routeSession && adoptSessionRef.current === routeSession) {
      adoptSessionRef.current = null
      hasAutoNavigatedRef.current = false
      renderSentinelRef.current = null
      setApiStatus(null)
      setApiLoading(true)
      return // same project, now real — keep the store
    }
    useWorkflowStore.getState().resetSession()
    hasAutoNavigatedRef.current = false
    renderSentinelRef.current = null
    setApiStatus(null)
    setApiLoading(true)
    if (!routeSession || routeSession === 'new') {
      // Left a real session for the mock blank flow (or off the workflow):
      // rebuild the blank graph — no poll will reshape it, and the previous
      // session's completed steps must not linger.
      setSteps(buildStepsFromContract(FALLBACK_CONTRACT, true, null))
      setGates(buildGates(FALLBACK_CONTRACT, true, null))
      setSelected('setup')
    }
  }, [routeSession])

  // FORMAT FORK (blank flow): until Step 01's narrator answer picks the
  // format, the map's format-dependent stretch stays fogged. The answer is
  // live store state, so the fog lifts the moment the user clicks — no save
  // needed. Real sessions got their format from the template: never fogged.
  const narrator = useWorkflowStore((s) => s.s1.narrator)
  const fogState =
    routeSession === 'new'
      ? narrator === 'yes'
        ? ('lifted' as const)
        : narrator === 'no'
          ? ('video' as const)
          : ('undecided' as const)
      : ('lifted' as const)
  useEffect(() => {
    if (routeSession !== 'new') return
    setSteps(buildStepsFromContract(FALLBACK_CONTRACT, true, null, fogState))
    setGates(buildGates(FALLBACK_CONTRACT, true, null))
  }, [routeSession, fogState])

  // THE SHOW IDENTITY COMES FROM THE SESSION, NOT A GUESS: its series field
  // names the show (cast, style, world kit). No series — or an unknown one —
  // means no show behind it: 'standalone', the honest empty identity. Never
  // another show's cast.
  useEffect(() => {
    if (!routeSession || routeSession === 'new') return
    let cancelled = false
    getFileJson<{ series?: unknown }>('session.json').then((cfg) => {
      if (cancelled || cfg === null) return
      const series = typeof cfg.series === 'string' ? cfg.series : ''
      setShowName(series ? (showBySeries[series] ?? series) : 'standalone')
    })
    return () => {
      cancelled = true
    }
  }, [routeSession])

  // The contract is re-fetched per session — the engine copy is the single
  // source of truth (kills the bundled-mirror drift risk).
  useEffect(() => {
    if (!routeSession || routeSession === 'new') {
      setContract(FALLBACK_CONTRACT)
      return
    }
    let cancelled = false
    getJson<{ ok?: boolean; data?: { id?: string; contract?: { stages?: unknown[] } } }>(contractUrl())
      .then((out) => {
        if (cancelled) return
        const stages = out?.data?.contract?.stages
        if (out?.ok && Array.isArray(stages) && stages.length) {
          setContract({ id: out.data?.id ?? 'explainer', stages: stages as WorkflowContract['stages'] })
        }
      })
    return () => {
      cancelled = true
    }
  }, [routeSession])

  // Fetch real status from local API while a session route is open
  useEffect(() => {
    const withUiProgress = async (statusPayload: ApiStatusPayload) => {
      const data = statusPayload?.data
      if (!data) return statusPayload
      const audioArtifact = (data.artifacts || []).find(
        (artifact) => artifact.stage_id === 'narration_audio' && artifact.pattern === 'source/audio/*.mp3',
      )
      const visualArtifact = (data.artifacts || []).find(
        (artifact) => artifact.stage_id === 'visual_assets' && artifact.pattern === 'source/generated-assets/scenes/*.png',
      )
      let narrationTotal: number
      let visualTotal: number
      let visualDone = Number(visualArtifact?.matches || 0)
      try {
        const [shotRes, manifestRes] = await Promise.all([
          fetch(fileUrl('shot-list/shot-list.json')),
          fetch(fileUrl('manifests/scenes.manifest.json')).catch(() => null),
        ])
        const [shotOut, manifestOut] = await Promise.all([
          shotRes.json().catch(() => null),
          manifestRes?.ok ? manifestRes.json().catch(() => null) : Promise.resolve(null),
        ])
        const shotList = shotOut?.data?.content ? JSON.parse(shotOut.data.content) : null
        const manifest = manifestOut?.data?.content ? JSON.parse(manifestOut.data.content) : null
        narrationTotal = countNarratedChunks(shotList)
        visualTotal = countBaseVisuals(shotList)
        visualDone = countVisualCoverage(shotList, manifest, visualDone)
      } catch {
        narrationTotal = 0
        visualTotal = 0
      }
      return {
        ...statusPayload,
        data: {
          ...data,
          uiProgress: {
            ...(data.uiProgress || {}),
            narrationAudio: {
              done: Number(audioArtifact?.matches || 0),
              total: narrationTotal,
            },
            visualAssets: {
              done: visualDone,
              total: visualTotal,
            },
          },
        },
      }
    }
    const fetchStatus = async () => {
      try {
        const response = await fetch(statusUrl())
        if (response.ok) {
          const data = await withUiProgress(await response.json())
          setApiStatus(data)
          // Update steps and gates with live API data to remove fake mock statuses
          setSteps(buildStepsFromContract(contract, initialStandalone, data.data))
          setGates(buildGates(contract, initialStandalone, data.data))
          // FINAL RENDER TRUTH: the render audit's sentinel file. The render
          // script deletes it when a compile starts and the audit re-writes it
          // on pass — so only two observations mean "done": the sentinel already
          // exists on page load, or it re-appears after being absent (a running
          // compile passed). A plain "exists" check would race a fresh compile
          // against the PREVIOUS render's sentinel. Never overrides 'stale'/'failed'.
          const renderPassed = (data.data?.artifacts || []).some(
            (a) => (a.pattern === 'working/render-audit.passed' || a.path?.includes('render-audit.passed')) && a.exists === true,
          )
          const prevRenderPassed = renderSentinelRef.current
          renderSentinelRef.current = renderPassed
          if (renderPassed) {
            const fr = useWorkflowStore.getState().finalRender
            // 'idle'/'failed' with the sentinel present can only mean the store
            // missed (or lost) the truth: a REAL render deletes the sentinel at
            // start and only a passing audit rewrites it, so its presence IS a
            // finished, audited video. Heal to 'done' whenever observed — not
            // just on first load. 'rendering' flips only on the absent→present
            // edge (plain presence would race a fresh compile against the
            // previous render's sentinel); 'stale' is never overridden.
            const missedTruth = fr === 'idle' || fr === 'failed'
            const completionEdge = prevRenderPassed === false && fr === 'rendering'
            if (missedTruth || completionEdge) useWorkflowStore.getState().setFinalRender('done')
          }
        }
      } catch (error) {
        console.error('Failed to fetch Spoolcast API status:', error)
      } finally {
        setApiLoading(false)
      }
    }
    if (!routeSession || routeSession === 'new') {
      // No engine session to poll: login/projects/library, or the /p/new mock
      // blank flow — which must NEVER show a real session's state.
      setApiLoading(false)
      return
    }
    fetchStatus()
    // Light polling so the UI tracks engine changes (rewinds, drafts, external
    // script runs) without a manual refresh.
    const interval = setInterval(fetchStatus, 5000)
    return () => clearInterval(interval)
  }, [initialStandalone, routeSession, contract])

  useEffect(() => {
    if (!apiLoading && apiStatus?.data?.workflow_graph?.nodes) {
      if (hasAutoNavigatedRef.current) return // Skip if we've already auto-navigated once
      
      const nodes = apiStatus.data.workflow_graph.nodes
      const firstIncomplete = nodes.find((n: any) => n.status !== 'passed' && n.status !== 'approved')
      
      // Contract stage id -> UI step id, folded tail included — derived from
      // the session's contract instead of an explainer-only literal.
      const stepMap = stageToStepMap(contract)
      
      if (firstIncomplete && stepMap[firstIncomplete.id]) {
        setSelected(stepMap[firstIncomplete.id])
        hasAutoNavigatedRef.current = true
      } else if (nodes.length > 0) {
        // If everything is done, go to the last step
        const lastNode = nodes[nodes.length - 1]
        if (stepMap[lastNode.id]) {
          setSelected(stepMap[lastNode.id])
          hasAutoNavigatedRef.current = true
        }
      }
    }
  }, [apiLoading, apiStatus, contract])

  const markStepDone = useCallback(
    (id: string) =>
      setSteps((prev) => prev.map((step) => (step.id === id ? { ...step, status: 'done' } : step))),
    [],
  )
  // autopilot drives the real canvas: focus each step, then mark it done.
  const apSelect = useCallback((id: string) => {
    setSelected(id)
    setAutopilotActiveId(id)
  }, [])
  const apFinish = useCallback(() => {
    setAutopilotRun(null)
    setAutopilotActiveId(null)
    setToast('Autopilot finished your video.')
  }, [])
  const stopAutopilot = useCallback(() => {
    setAutopilotRun(null)
    setAutopilotActiveId(null)
    setAutopilot(false)
    setToast('Autopilot stopped — edit this step, then resume anytime.')
  }, [])

  const isWorkflow = route.startsWith('/p/')
  const isWorldKit = route.endsWith('/world-kit')
  const isRules = route.endsWith('/rules')
  const blankProject = setupMode === 'standalone'
  const castData =
    castByShow[showName as keyof typeof castByShow] ?? castByShow['standalone']
  const activeStep = steps.find((step) => step.id === selected) ?? steps[0]
  const isBlocked = apiStatus?.data?.status === 'blocked'

  useEffect(() => {
    document.body.classList.toggle('profile-open', profileOpen)
    document.body.classList.toggle('chat-open', chatState !== 'closed')
    document.body.classList.toggle('chat-pinned', chatState === 'pinned')
  }, [profileOpen, chatState])

  // header floats (no bg) at the top of the workflow + picker, becomes a solid
  // bar once you scroll
  const floatable = (isWorkflow && !isWorldKit) || route === '/projects' || route === '/library'
  useEffect(() => {
    document.body.classList.toggle('header-float', floatable && !headerScrolled)
    return () => document.body.classList.remove('header-float')
  }, [floatable, headerScrolled])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 2200)
    return () => window.clearTimeout(timer)
  }, [toast])

  const resetBlank = (chat = false) => {
    setOnboardSeed(null)
    setOrigin('blank')
    setSetupMode('standalone')
    setShowName('standalone')
    setSteps(buildStepsFromContract(FALLBACK_CONTRACT, true))
    setGates(buildGates(FALLBACK_CONTRACT, true))
    setSelected('setup')
    setAutopilot(false)
    setChatTab('chat')
    setChatState(chat ? 'floating' : 'closed')
    setCustomChat(chat)
  }

  // ENTRY SPINE, STEP 4: saving Project setup on the blank flow CREATES the
  // real video. The step-1 answers become engine truth — the narrator answer
  // picks the template (yes → Explainer, no → the video-first Ad template),
  // the choices persist to session.json, the setup approval records — then
  // the route adopts the new id.
  const createFromBlank = async (): Promise<boolean> => {
    const s1Now = useWorkflowStore.getState().s1
    if (s1Now.narrator !== 'yes' && s1Now.narrator !== 'no') {
      setToast('Answer the format question first.')
      return false
    }
    const template = s1Now.narrator === 'no' ? 'ad' : 'explainer'
    const base =
      s1Now.projectId.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-_]/g, '') || 'untitled'
    const listing = await getJson<{ ok?: boolean; data?: { sessions?: { id: string }[] } }>(sessionsUrl())
    if (!listing?.ok) {
      setToast('The engine is not reachable \u2014 is the local API running?')
      return false
    }
    const taken = new Set((listing.data?.sessions ?? []).map((existing) => existing.id))
    let id = base
    let n = 1
    while (taken.has(id)) id = `${base}-${String(++n).padStart(2, '0')}`
    const created = await postAction<{ session?: string }>({
      action: 'create_session',
      session: id,
      template,
    })
    if (!created?.ok || !created.data?.session) {
      setToast(`Engine: ${created?.error || created?.message || 'could not create the video.'}`)
      return false
    }
    const aspect = s1Now.output === '916' ? '9:16' : s1Now.output === '11' ? '1:1' : '16:9'
    await postAction({
      action: 'set_session_fields',
      session: id,
      fields: {
        target_length_s: s1Now.length,
        aspect_ratio: aspect,
        ...(s1Now.medium ? { shot_medium: s1Now.medium } : {}),
      },
    })
    await postAction({
      action: 'approve_stage',
      session: id,
      stage_id: 'format_setup',
      approval_note: 'Project setup approved at creation (blank flow).',
    })
    adoptSessionRef.current = id
    setOrigin('template')
    setSetupMode('series')
    navigate(`/p/${id}`)
    setToast(`Video created \u2014 saved as ${id}.`)
    return true
  }

  const restoreDemo = () => {
    setOnboardSeed(null)
    setOrigin('series')
    setSetupMode('series')
    setShowName('spoolcast dev log')
    setSteps(buildStepsFromContract(FALLBACK_CONTRACT, false))
    setGates(buildGates(FALLBACK_CONTRACT, false))
    setSelected('pics')
    setAutopilot(false)
    setChatState('closed')
    setCustomChat(false)
  }

  // finishing onboarding (steps 01-03) → land on step 04 (plan) in a new blank
  // project; autopilot finishes the rest if chosen.
  const finishOnboarding = (seed: OnboardSeed, auto: boolean) => {
    setSetupMode('standalone')
    setShowName('standalone')
    const fresh = buildStepsFromContract(FALLBACK_CONTRACT, true).map((step) =>
      step.id === 'setup' || step.id === 'idea' || step.id === 'goal'
        ? { ...step, status: 'done' as const }
        : step,
    )
    setSteps(fresh)
    setGates(buildGates(FALLBACK_CONTRACT, true))
    setOnboardSeed(seed)
    setOrigin('blank')
    setSelected('plan')
    setChatState('closed')
    setCustomChat(false)
    if (auto) {
      setAutopilot(true)
      const startIdx = Math.max(0, fresh.findIndex((s) => s.id === 'plan'))
      const remaining = fresh.slice(startIdx)
      setAutopilotRun(remaining.map((s) => ({ id: s.id, name: s.name })))
    } else {
      setAutopilot(false)
    }
    navigate('/p/new')
  }

  // gate generation behind sign-up: a first-timer must create an account before
  // autopilot or the manual continue takes them into the workflow.
  const onboardingFinish = (seed: OnboardSeed, auto: boolean) => {
    if (signedIn) finishOnboarding(seed, auto)
    else setPendingFinish({ seed, auto })
  }

  const header = (
    <Header
      route={route}
      setupMode={setupMode}
      showName={showName}
      isWorkflow={isWorkflow}
      isWorldKit={isWorldKit}
      autopilot={autopilot}
      onLogo={() => {
        restoreDemo()
        navigate('/projects')
      }}
      onBack={() => {
        if (isWorldKit || isRules) navigate(`/p/${routeSession ?? 'new'}`)
        else {
          restoreDemo()
          navigate('/projects')
        }
      }}
      onAutopilot={() => {
        const canRun =
          steps.find((s) => s.id === 'goal')?.status === 'done' &&
          steps.find((s) => s.id === 'plan')?.status === 'done'
        if (!canRun) {
          setToast('Lock the core message and structure first.')
          return
        }
        if (autopilot) {
          setAutopilot(false)
        } else {
          setConfirmAuto(true)
        }
      }}
      onCast={() => navigate(`/p/${routeSession ?? 'new'}/world-kit`)}
      onRules={() => navigate(`/p/${routeSession ?? 'new'}/rules`)}
      onSave={async () => {
        try {
          const r = await fetch(actionUrl(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session: activeSession(), tenant: 'local', action: 'create_save_point' }),
          })
          const out = await r.json().catch(() => null)
          if (r.ok && out?.ok !== false) setToast('Save point kept.')
          else setToast(`Engine: ${out?.message || out?.error || 'could not save.'}`)
        } catch {
          setToast('Could not reach the engine.')
        }
      }}
      onSaves={() => setSavesOpen(true)}
      isRules={isRules}
      onNew={() => {
        restoreDemo()
        navigate('/projects')
      }}
      onLibrary={() => navigate('/library')}
      onProfile={() => setProfileOpen(true)}
    />
  )

  return (
    <div className="app">
      {header}
      <main>
        <Routes>
          <Route
            path="/"
            element={
              <LoginView
                onFirstTime={() => navigate('/setup')}
                onGoogle={() => {
                  setSignedIn(true)
                  navigate('/projects')
                }}
              />
            }
          />
          <Route
            path="/setup"
            element={
              <OnboardingView onFinish={onboardingFinish} />
            }
          />
          <Route
            path="/projects"
            element={
              <PickerView
                onStandalone={() => {
                  resetBlank()
                  navigate('/p/new')
                }}
                onOpenSession={(id) => {
                  // A REAL session: /p/:id is the identity — the session-switch
                  // effect resets per-session state and auto-nav picks the step.
                  setOnboardSeed(null)
                  setOrigin('series')
                  setSetupMode('series')
                  // Provisional: the show identity resolves from the session's
                  // own series field the moment session.json loads.
                  setShowName('standalone')
                  setSelected('setup')
                  setAutopilot(false)
                  setChatState('closed')
                  setCustomChat(false)
                  navigate(`/p/${id}`)
                }}
                onScrolled={setHeaderScrolled}
              />
            }
          />
          <Route
            path="/p/:id"
            element={
              <WorkflowView
                key={routeSession ?? 'mock'}
                steps={steps}
                gates={gates}
                contractId={contract.id}
                seed={onboardSeed}
                selected={selected}
                setSelected={setSelected}
                activeStep={activeStep}
                apiStatus={apiStatus}
                apiLoading={apiLoading}
                isBlocked={isBlocked}
                setupMode={setupMode}
                showName={showName}
                castData={castData}
                blankProject={blankProject}
                autopilot={autopilot}
                onOpenCast={() => navigate(`/p/${routeSession ?? 'new'}/world-kit`)}
                onToast={setToast}
                onAdvance={async (id: string, opts?: { aiHandoff?: boolean }): Promise<boolean> => {
                  // BLANK FLOW: no engine session exists behind /p/new. Saving
                  // Project setup is the moment the video becomes real; every
                  // other step waits for that.
                  if (routeSession === 'new') {
                    const blankStep = steps.find((st) => st.id === id)
                    if ((blankStep?.sourceId || id) !== 'format_setup') {
                      setToast('Save Project setup first \u2014 that creates the video.')
                      return false
                    }
                    return createFromBlank()
                  }
                  // SAVE-TO-ENGINE PROTOCOL: Save/Approve must actually move the engine, for EVERY stage:
                  //   1. Persist the user's typed input into the session's source/ folder.
                  //   2. Run the stage's contract action (the engine produces the stage's artifacts).
                  //   3. Only report success if the engine accepts — the UI never advances on its own.
                  try {
                    // id is the UI step id, we need to map it to the sourceId (contract stage id)
                    const currentStep = steps.find((s: any) => s.id === id)
                    const sourceId = currentStep?.sourceId || id

                    const currentNode = apiStatus?.data?.workflow_graph?.nodes?.find((n: any) => n.id === sourceId)
                    const needsApproval = currentNode?.requires_approval === true
                    const wasAlreadyPassed = currentNode?.status === 'passed' || currentNode?.status === 'approved'

                    // 0. INVALIDATION: re-saving an already-approved step revokes its
                    //    approval and every downstream approval (the amber warning's
                    //    promise), making this stage current again so the engine will
                    //    accept the new input. Must happen BEFORE persisting, since the
                    //    rewind clears this stage's regenerable outputs.
                    //    ONLY when the user actually CHANGED something (dirty): a clean
                    //    re-click on an approved step must never destroy its outputs —
                    //    a rewind deletes artifacts (e.g. the render-audit sentinel)
                    //    that a re-approve cannot bring back.
                    const isDirtyNow = Boolean(useWorkflowStore.getState().dirtySteps[sourceId])
                    if (wasAlreadyPassed && isDirtyNow) {
                      const rw = await fetch(actionUrl(), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          session: activeSession(),
                          tenant: 'local',
                          action: 'rewind_stage',
                          stage_id: sourceId,
                          // Editing one field must never delete later steps' work
                          // (an already-cast World Kit): revoke approvals only.
                          // Deleting is reserved for the explicit Start over menu.
                          keep_files: true,
                        }),
                      })
                      const rwOut = await rw.json().catch(() => null)
                      if (!rw.ok || rwOut?.ok === false) {
                        setToast('Could not invalidate the earlier approval — nothing changed.')
                        return false
                      }
                    }

                    // 1. PERSIST USER INPUT: typed input must reach the engine before the
                    //    stage action runs — the engine only believes what's on disk.
                    if (sourceId === 'format_setup') {
                      // Step 1's target length feeds the AI structure drafter's runtime plan.
                      const s1Now = useWorkflowStore.getState().s1
                      const fields: Record<string, unknown> = {}
                      if (s1Now.length > 0) fields.target_length_s = s1Now.length
                      // The shot medium sets every clip's legal duration from
                      // step 06 on — it has to be on disk before the drafters run.
                      if (s1Now.medium) fields.shot_medium = s1Now.medium
                      if (Object.keys(fields).length > 0) {
                        await fetch(actionUrl(), {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            session: activeSession(),
                            tenant: 'local',
                            action: 'set_session_fields',
                            fields,
                          }),
                        }).catch(() => {})
                      }
                    }
                    if (sourceId === 'input_intake') {
                      // The idea brief is source material — write it to source/.
                      const ideaBrief = useWorkflowStore.getState().ideaBrief
                      if (ideaBrief.trim().length > 0) {
                        const toB64 = (s: string) => btoa(unescape(encodeURIComponent(s)))
                        const up = await fetch(actionUrl(), {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            session: activeSession(),
                            tenant: 'local',
                            action: 'upload_file',
                            filename: 'idea-brief.md',
                            content: toB64(`# Video idea\n\n${ideaBrief.trim()}\n`),
                          }),
                        })
                        if (!up.ok) {
                          setToast('Could not save your input to the engine.')
                          return false
                        }
                      }
                    }
                    if (sourceId in STAGE_DRAFT_OUTPUTS) {
                      // Drafted stage output (structure / world kit / visual pacing):
                      // write the contract-declared file via set_stage_output.
                      const draft = useWorkflowStore.getState().stageDrafts[sourceId] ?? ''
                      if (draft.trim().length > 0) {
                        const so = await fetch(actionUrl(), {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            session: activeSession(),
                            tenant: 'local',
                            action: 'set_stage_output',
                            stage_id: sourceId,
                            path: STAGE_DRAFT_OUTPUTS[sourceId].path,
                            content: draft,
                          }),
                        })
                        if (!so.ok) {
                          setToast('Could not save the draft to the engine.')
                          return false
                        }
                      }
                    }
                    if (sourceId === 'screenplay_plan') {
                      // MULTI-FILE STAGE: the auto-rewind above DELETED the
                      // screenplay's files. Persist both station drafts back
                      // from the store, then re-run the free checks so the
                      // stage's required audit artifacts exist again —
                      // otherwise approval fails on missing files.
                      const sd = useWorkflowStore.getState().stageDrafts
                      const files: [string, string][] = [
                        ['working/listener-draft.md', sd[`${sourceId}:listener`] ?? ''],
                        ['working/screenplay-v3.md', sd[`${sourceId}:screenplay`] ?? ''],
                      ]
                      for (const [path, content] of files) {
                        if (!content.trim()) continue
                        const so = await fetch(actionUrl(), {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            session: activeSession(),
                            tenant: 'local',
                            action: 'set_stage_output',
                            stage_id: sourceId,
                            path,
                            content,
                          }),
                        })
                        if (!so.ok) {
                          // Not every contract declares both files (the ad
                          // contract has only screenplay-v3.md) — an
                          // undeclared-output rejection is fine to skip; any
                          // other failure still blocks the approval.
                          const soOut = await so.json().catch(() => null)
                          if (String(soOut?.error || '').includes('not a declared output')) continue
                          setToast(`Could not save ${path} to the engine.`)
                          return false
                        }
                      }
                      if (wasAlreadyPassed) {
                        for (const stage of ['screenplay', 'narration']) {
                          await fetch(actionUrl(), {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ session: activeSession(), tenant: 'local', action: 'run_audit', stage }),
                          }).catch(() => {})
                        }
                      }
                    }
                    if (sourceId === 'story_lock') {
                      // The core message is the stage's contract output — record it in session.json.
                      const goal = useWorkflowStore.getState().goal
                      if (goal.text.trim().length > 0) {
                        const cm = await fetch(actionUrl(), {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            session: activeSession(),
                            tenant: 'local',
                            action: 'set_core_message',
                            content: goal.text.trim(),
                          }),
                        })
                        if (!cm.ok) {
                          setToast('Could not record the core message in the engine.')
                          return false
                        }
                      }
                    }

                    // 2. TELL THE ENGINE. Two distinct operations:
                    //    - approval-gated stages: record the human approval (approve_stage).
                    //      NEVER re-runs scripts — approving must not regenerate content
                    //      the user just reviewed or edited.
                    //    - non-approval stages: run the stage's legal contract action
                    //      (e.g. inventory_source) so the engine produces its artifacts.
                    {
                      let res: Response
                      if (needsApproval) {
                        res = await fetch(actionUrl(), {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            session: activeSession(),
                            tenant: 'local',
                            action: 'approve_stage',
                            stage_id: sourceId,
                            approval_note: 'User approved via UI',
                          }),
                        })
                      } else if (sourceId === 'input_intake') {
                        // WHITELIST: only deterministic, free stage actions run
                        // automatically on save. AI-drafting stages (screenplay,
                        // etc.) have explicit buttons — saving must never
                        // silently re-run a paid draft.
                        res = await fetch(actionUrl(), {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            session: activeSession(),
                            tenant: 'local',
                            action: 'inventory_source',
                            approve: false,
                          }),
                        })
                      } else {
                        res = new Response(JSON.stringify({ ok: true }))
                      }
                      const out = await res.json().catch(() => null)
                      const engineErr = out?.data?.error || out?.error
                      const alreadyPassed = currentNode?.status === 'passed' || currentNode?.status === 'approved'
                      if (engineErr === 'illegal_action' && alreadyPassed) {
                        // Re-saving an already-approved step: the engine has moved past this
                        // stage. The input above WAS persisted; the engine keeps its approval.
                        setToast('Input saved. The engine keeps its earlier approval for this step.')
                      } else if (!res.ok || out?.ok === false || out?.data?.ok === false) {
                        const msg = out?.message || out?.data?.message || out?.data?.error || out?.error || 'Engine rejected this step.'
                        setToast(`Engine: ${msg}`)
                        // Still refresh so blockers/statuses shown are the engine's current truth.
                        const r = await fetch(statusUrl())
                        if (r.ok) {
                          const apiData = await r.json()
                          setApiStatus(apiData)
                          setSteps(buildStepsFromContract(contract, initialStandalone, apiData.data))
                          setGates(buildGates(contract, initialStandalone, apiData.data))
                        }
                        return false
                      }
                    }

                    setToast(needsApproval ? 'Stage approved by engine.' : 'Saved.')

                    // 3a. AI HAND-OFF (user-checked): after approving this stage, AI
                    //     prepares the next one IN THE BACKGROUND. Defined here, but
                    //     STARTED only after the quick status refresh below, so the
                    //     long model call can never queue ahead of it.
                    const startHandoff = () => {
                    if (opts?.aiHandoff && (sourceId === 'structure' || sourceId === 'world_kit' || sourceId === 'screenplay_plan' || sourceId === 'visual_pacing')) {
                      const handoff =
                        sourceId === 'structure'
                          ? { stage_id: 'world_kit', variant: undefined, busy: 'AI is updating the World Kit from the new structure…', done: 'World Kit updated.', fail: 'World Kit update failed' }
                          : sourceId === 'world_kit'
                            ? { stage_id: 'screenplay_plan', variant: 'listener' as string | undefined, busy: 'AI is writing the draft script from the kit…', done: 'Draft script ready.', fail: 'Script drafting failed' }
                            : sourceId === 'screenplay_plan'
                              ? { stage_id: 'visual_pacing', variant: undefined, busy: 'AI is planning the visuals from the final script…', done: 'Visual pacing plan ready.', fail: 'Visual pacing draft failed' }
                              : { stage_id: 'shot_list_json', variant: undefined, busy: 'AI is compiling the shot list from the pacing plan…', done: 'Shot list built and validated.', fail: 'Shot-list build failed' }
                      useWorkflowStore.getState().setHandoff({ stageId: handoff.stage_id, label: handoff.busy })
                      ;(async () => {
                        try {
                          const r = await fetch(actionUrl(), {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                              session: activeSession(),
                              tenant: 'local',
                              action: 'draft_stage',
                              stage_id: handoff.stage_id,
                              ...(handoff.variant ? { variant: handoff.variant } : {}),
                              allow_cost: true,
                            }),
                          })
                          const out = await r.json().catch(() => null)
                          if (r.ok && out?.ok !== false) {
                            // Drop cached drafts so the step loads the fresh file.
                            useWorkflowStore.getState().clearStageDrafts(handoff.stage_id)
                            setToast(handoff.done)
                          } else {
                            setToast(`${handoff.fail}: ${out?.message || out?.error || 'engine error'} — you can draft it manually.`)
                          }
                        } catch {
                          setToast(`${handoff.fail} — you can draft it manually.`)
                        } finally {
                          useWorkflowStore.getState().setHandoff(null)
                          // Refresh so statuses/gates reflect the new artifacts.
                          try {
                            const res2 = await fetch(statusUrl())
                            if (res2.ok) {
                              const apiData = await res2.json()
                              setApiStatus(apiData)
                              setSteps(buildStepsFromContract(contract, initialStandalone, apiData.data))
                              setGates(buildGates(contract, initialStandalone, apiData.data))
                            }
                          } catch { /* polling will catch up */ }
                        }
                      })()
                    }
                    }

                    // 3. REFRESH: the UI reflects the engine's new state (green gate, statuses, no warning).
                    const res = await fetch(statusUrl())
                    if (res.ok) {
                      const apiData = await res.json()
                      setApiStatus(apiData)
                      setSteps(buildStepsFromContract(contract, initialStandalone, apiData.data))
                      setGates(buildGates(contract, initialStandalone, apiData.data))
                    }
                    // Only now start the background AI hand-off — the quick refresh
                    // above is already done, so the UI advances instantly.
                    startHandoff()
                    return true
                  } catch (err) {
                    console.error('Failed to advance stage:', err)
                    setToast('Error talking to the engine.')
                    return false
                  }
                }}
                onScrolledChange={setHeaderScrolled}
                onAutopilot={() => setConfirmAuto(true)}
                runningId={autopilotActiveId}
                origin={origin}
              />
            }
          />
          <Route
            path="/library"
            element={<LibraryView onScrolled={setHeaderScrolled} />}
          />
          <Route
            path="/p/:id/world-kit"
            element={<WorldKitView castData={castData} showName={showName} blank={showName === 'standalone'} />}
          />
          <Route path="/p/:id/rules" element={<RulesView />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      {route === '/setup' || route === '/' || route === '/projects' || route === '/library' ? null : (
        <Footer blank={setupMode === 'standalone'} />
      )}
      <ProfileDrawer open={profileOpen} onClose={() => setProfileOpen(false)} />
      {savesOpen ? <SavePointsModal onClose={() => setSavesOpen(false)} onToast={setToast} /> : null}
      {pendingFinish ? (
        <SignupModal
          auto={pendingFinish.auto}
          onCancel={() => setPendingFinish(null)}
          onSignup={() => {
            const { seed, auto } = pendingFinish
            setSignedIn(true)
            setPendingFinish(null)
            finishOnboarding(seed, auto)
          }}
        />
      ) : null}
      {isWorkflow && !isWorldKit ? (
        <ChatWidget
          state={chatState}
          tab={chatTab}
          selected={activeStep}
          customChat={customChat}
          onOpen={() => setChatState('floating')}
          onClose={() => setChatState('closed')}
          onPin={() => setChatState(chatState === 'pinned' ? 'floating' : 'pinned')}
          onTab={setChatTab}
        />
      ) : null}
      {confirmAuto ? (
        <ConfirmModal
          onCancel={() => setConfirmAuto(false)}
          onApprove={() => {
            setConfirmAuto(false)
            setAutopilot(true)
            const startIdx = Math.max(
              0,
              steps.findIndex((s) => s.id === selected),
            )
            const remaining = steps.slice(startIdx)
            setAutopilotRun(remaining.map((s) => ({ id: s.id, name: s.name })))
          }}
        />
      ) : null}
      {autopilotRun ? (
        <>
          <AutopilotRunner
            steps={autopilotRun}
            onSelect={apSelect}
            onStepComplete={markStepDone}
            onFinish={apFinish}
          />
          <div className="autopilot-bar">
            <span className="spin" />
            <span>Autopilot is completing your video — watch it move through each step</span>
            <button onClick={stopAutopilot}>Stop</button>
          </div>
        </>
      ) : null}
      <div className={`toast ${toast ? 'show' : ''}`}>{toast}</div>
    </div>
  )
}

export default App
