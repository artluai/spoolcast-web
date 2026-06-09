import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router-dom'
import { Pill } from './components/common/Pill'
import explainerContract from './contracts/explainer.json'
import newsContract from './contracts/news-anime-bot.json'
import type {
  ChatState,
  ChatTab,
  Gate,
  OnboardSeed,
  SetupMode,
  Step,
} from './types'
import { asset } from './lib/assets'
import { castByShow, outline, sceneFiles, shots, styleThumbs } from './data/cast'
import { INHERITED_COMPONENTS, SCAN_SUGGESTIONS, type TplRule } from './data/template-rules'
import { FORMAT_TEMPLATE_NAMES, WORLD_KIT_SCOPES, WORLD_KIT_SECTIONS } from './data/worldkit'
import { buildGates, buildStepsFromContract } from './lib/workflow-graph'
import { AutopilotRunner } from './components/AutopilotRunner'
import { CastGrid } from './components/CastGrid'
import { ChatWidget } from './components/ChatWidget'
import { ConfirmModal } from './components/ConfirmModal'
import { Footer } from './components/Footer'
import { Header } from './components/Header'
import { ProfileDrawer } from './components/ProfileDrawer'
import { LibraryView } from './views/LibraryView'
import { LoginView, SignupModal } from './views/LoginView'
import { OnboardingView } from './views/OnboardingView'
import { PickerView } from './views/PickerView'

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
  const initialStandalone = route === '/p/new' || route === '/p/new/world-kit'
  const [setupMode, setSetupMode] = useState<SetupMode>(initialStandalone ? 'standalone' : 'series')
  const [showName, setShowName] = useState(initialStandalone ? 'standalone' : 'spoolcast dev log')
  const [steps, setSteps] = useState(() => buildStepsFromContract(initialStandalone, null))
  const [gates, setGates] = useState(() => buildGates(initialStandalone, null))
  const [selected, setSelected] = useState<string>('setup') // Will be updated by useEffect once API loads
  const [autopilot, setAutopilot] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
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

  // Fetch real status from local API on mount
  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const response = await fetch('http://localhost:8000/api/status?session=spoolcast-dev-log-12&tenant=local')
        if (response.ok) {
          const data = await response.json()
          setApiStatus(data)
          // Update steps and gates with live API data to remove fake mock statuses
          setSteps(buildStepsFromContract(initialStandalone, data.data))
          setGates(buildGates(initialStandalone, data.data))
        }
      } catch (error) {
        console.error('Failed to fetch Spoolcast API status:', error)
      } finally {
        setApiLoading(false)
      }
    }
    fetchStatus()
  }, [initialStandalone])

  // AUTO-NAVIGATION RULE: Only run ONCE on initial load to set the starting point.
  // Prevents race conditions where manual navigation is overridden by background API updates.
  const hasAutoNavigatedRef = useRef(false)
  
  useEffect(() => {
    if (!apiLoading && apiStatus?.data?.workflow_graph?.nodes) {
      if (hasAutoNavigatedRef.current) return // Skip if we've already auto-navigated once
      
      const nodes = apiStatus.data.workflow_graph.nodes
      const firstIncomplete = nodes.find((n: any) => n.status !== 'passed' && n.status !== 'approved')
      
      // Map the contract stage id to our UI step id
      const stepMap: Record<string, string> = {
        'format_setup': 'setup',
        'input_intake': 'idea',
        'story_lock': 'goal',
        'structure': 'plan',
        'world_kit': 'worldkit',
        'screenplay_plan': 'script',
        'visual_pacing': 'pacing',
        'shot_list_json': 'shots',
        'narration_audio': 'voice',
        'visual_assets': 'pics',
        'asset_audit': 'check',
        'preprocess_review_render': 'build',
        'package_widescreen': 'caps',
        'mobile_variant': 'phone',
        'publish': 'post'
      }
      
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
  }, [apiLoading, apiStatus])

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
  const blankProject = setupMode === 'standalone'
  const castData =
    castByShow[showName as keyof typeof castByShow] ?? castByShow['spoolcast dev log']
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
    setSteps(buildStepsFromContract(true))
    setGates(buildGates(true))
    setSelected('setup')
    setAutopilot(false)
    setChatTab('chat')
    setChatState(chat ? 'floating' : 'closed')
    setCustomChat(chat)
  }

  const restoreDemo = () => {
    setOnboardSeed(null)
    setOrigin('series')
    setSetupMode('series')
    setShowName('spoolcast dev log')
    setSteps(buildStepsFromContract(false))
    setGates(buildGates(false))
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
    const fresh = buildStepsFromContract(true).map((step) =>
      step.id === 'setup' || step.id === 'idea' || step.id === 'goal'
        ? { ...step, status: 'done' as const }
        : step,
    )
    setSteps(fresh)
    setGates(buildGates(true))
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
        if (isWorldKit) navigate(`/p/${setupMode === 'series' ? 'dev-log-06' : 'new'}`)
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
      onCast={() => navigate(`/p/${setupMode === 'series' ? 'dev-log-06' : 'new'}/world-kit`)}
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
                onRecent={(kind) => {
                  if (kind === 'standalone') resetBlank()
                  else restoreDemo()
                  setOrigin(kind === 'standalone' ? 'template' : 'series')
                  navigate(kind === 'standalone' ? '/p/new' : '/p/dev-log-06')
                }}
                onTemplate={(seed, series) => {
                  // choosing a template imports its format settings into the workflow
                  setOnboardSeed(seed)
                  setOrigin(series ? 'series' : 'template')
                  setSetupMode('standalone')
                  setShowName('standalone')
                  const fresh = buildStepsFromContract(true).map((step) =>
                    step.id === 'setup'
                      ? { ...step, status: 'done' as const }
                      : series && step.id === 'worldkit'
                        ? { ...step, status: 'done' as const }
                        : step,
                  )
                  setSteps(fresh)
                  setGates(buildGates(true))
                  setSelected('idea')
                  setAutopilot(false)
                  setChatState('closed')
                  setCustomChat(false)
                  navigate('/p/new')
                }}
                onScrolled={setHeaderScrolled}
              />
            }
          />
          <Route
            path="/p/:id"
            element={
              <WorkflowView
                steps={steps}
                gates={gates}
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
                onOpenCast={() => navigate(`/p/dev-log-06/world-kit`)}
                onToast={setToast}
                onAdvance={async (id: string) => {
                  // REAL APPROVAL RULE: Actually tell the engine we are approving this stage.
                  try {
                    // id is the UI step id, we need to map it to the sourceId (contract stage id)
                    const currentStep = steps.find((s: any) => s.id === id)
                    const sourceId = currentStep?.sourceId || id
                    
                    const currentNode = apiStatus?.data?.workflow_graph?.nodes?.find((n: any) => n.id === sourceId)
                    const needsApproval = currentNode?.requires_approval === true
                    
                    if (needsApproval && currentNode?.actions?.length > 0) {
                      const actionToApprove = currentNode.actions[0]
                      await fetch('http://localhost:8000/api/action', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          session: 'spoolcast-dev-log-12',
                          tenant: 'local',
                          action: actionToApprove,
                          approve: true,
                          approval_note: 'User approved via UI'
                        })
                      })
                    }
                    
                    // Update local state
                    setSteps((prev) =>
                      prev.map((step) => (step.id === id ? { ...step, status: 'done' } : step)),
                    )
                    setToast(needsApproval ? 'Stage approved by engine.' : 'Saved.')
                    
                    // Force a status refresh so the UI immediately reflects the engine's new state (green gate, no warning)
                    const res = await fetch('http://localhost:8000/api/status?session=spoolcast-dev-log-12&tenant=local')
                    if (res.ok) {
                      const apiData = await res.json()
                      setApiStatus(apiData)
                      setSteps(buildStepsFromContract(initialStandalone, apiData.data))
                      setGates(buildGates(initialStandalone, apiData.data))
                    }
                  } catch (err) {
                    console.error('Failed to approve stage:', err)
                    setToast('Error approving stage.')
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
            element={<WorldKitView castData={castData} showName={showName} />}
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      {route === '/setup' || route === '/' || route === '/projects' || route === '/library' ? null : (
        <Footer blank={setupMode === 'standalone'} />
      )}
      <ProfileDrawer open={profileOpen} onClose={() => setProfileOpen(false)} />
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

function WorkflowView({
  steps,
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
  onAdvance: (id: string) => void
  onScrolledChange: (scrolled: boolean) => void
  onAutopilot: () => void
  runningId: string | null
  origin: 'blank' | 'template' | 'series'
}) {
  const [full, setFull] = useState(false)
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
  
  // DIRTY STATE TRACKING: Define inside WorkflowView where it's actually used
  const [isDirty, setIsDirty] = useState(false)
  
  useEffect(() => {
    setIsDirty(false) // Reset dirty state when navigating to a new step
  }, [selected])

  const [s1, setS1] = useState(
    () =>
      seed?.s1 ?? {
        narrator: '',
        style: '',
        output: '',
        length: 120,
        projectId: 'untitled-01',
        editing: '',
      },
  )
  const [ideaBrief, setIdeaBrief] = useState(() =>
    seed ? seed.ideaBrief : '' // ZERO DUMMY DATA RULE: Always start blank if no seed
  )
  const [goal, setGoal] = useState<{ text: string; mode: '' | 'ai' | 'skip' }>(() =>
    seed ? seed.goal : { text: '', mode: '' } // ZERO DUMMY DATA RULE: Always start blank if no seed
  )
  
  // DIRTY STATE TRACKING: Wrapped setters to flag the step as modified
  const dirtySetIdeaBrief = (val: string) => {
    setIsDirty(true)
    setIdeaBrief(val)
  }
  const dirtySetGoal: React.Dispatch<React.SetStateAction<{ text: string; mode: '' | 'ai' | 'skip' }>> = (updater) => {
    setIsDirty(true)
    setGoal(updater)
  }
  const dirtySetS1: React.Dispatch<React.SetStateAction<typeof s1>> = (updater) => {
    setIsDirty(true)
    setS1(updater)
  }
  
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
  
  // RULE 3: Robust "In Progress" State Rule
  // EVENT-DRIVEN DIRTY STATE RULE: If the user has typed ANYTHING in the main fields of the current step, force "In progress".
  const isCurrentlyEditing = 
    ideaBrief.trim().length > 0 || 
    goal.text.trim().length > 0 || 
    (s1.narrator && s1.narrator.trim().length > 0) ||
    (s1.style && s1.style.trim().length > 0)

  const engineNode = apiStatus?.data?.workflow_graph?.nodes?.find((n: any) => n.id === activeStep.sourceId)
  const engineStatus = engineNode?.status || 'not_started'
  
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
            ) : apiStatus?.data?.status ? (
              <span className={`status-pill ${apiStatus.data.status === 'blocked' ? 'work' : 'done'}`}>
                {apiStatus.data.status.toUpperCase()}
              </span>
            ) : (
              <span className={`status-pill ${activeStep.status}`}>{statusLabel}</span>
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
              s1={s1}
              setS1={dirtySetS1}
              ideaBrief={ideaBrief}
              setIdeaBrief={dirtySetIdeaBrief}
              goal={goal}
              setGoal={dirtySetGoal}
              blankProject={blankProject}
              onOpenCast={onOpenCast}
              onToast={onToast}
              origin={origin}
              formatDirty={formatDirty}
            />
            
            {/* SCOPED BLOCKER RULE: Show engine blocker card ONLY if the current step is at or beyond the blocked step. 
                Includes explicit step labeling so the user knows exactly where the problem is.
                UX RULE: Hide the blocker while the user is actively typing/working on the step. */}
            {!apiLoading && (() => {
              const nodes = apiStatus?.data?.workflow_graph?.nodes || []
              const firstIncomplete = nodes.find((n: any) => n.status !== 'passed' && n.status !== 'approved')
              
              if (!firstIncomplete) return null

              // Only show the red blocker card if the engine explicitly marks the stage as "blocked"
              if (firstIncomplete.status !== 'blocked') {
                return null
              }

              // UX FIX: If the user is actively working on this step (isDirty is true), get out of their way.
              // The machine still knows it's blocked, but we don't scream "BLOCKED" while they are typing.
              if (isDirty) {
                return null
              }

              // SCOPE CHECK: Only show this blocker if we are currently viewing this step or a downstream step.
              const blockedStepIndex = nodes.findIndex((n: any) => n.id === firstIncomplete.id)
              const currentStepIndex = nodes.findIndex((n: any) => n.id === activeStep.sourceId)
              
              if (currentStepIndex < blockedStepIndex) {
                return null // We are on an earlier, already-completed step. Don't show downstream blockers here.
              }

              const missingArtifacts = firstIncomplete.artifacts?.filter((a: any) => a.required && !a.exists) || []
              
              const stepNumber = String(blockedStepIndex + 1).padStart(2, '0')
              const blockersToShow = missingArtifacts.length > 0 
                ? missingArtifacts.map((a: any) => `Missing required: ${a.pattern}`)
                : (apiStatus.data.blockers?.slice(0, 1) || ['Unknown blocker'])

              return (
                <div className="card" style={{ marginTop: 24, borderColor: 'var(--red)', background: 'rgba(233,106,106,.06)' }}>
                  <div className="ch" style={{ marginBottom: 12 }}>
                    <h3 style={{ color: 'var(--red)' }}>Step {stepNumber} ({firstIncomplete.label}) is blocked</h3>
                    <span className="label">Fix this first before proceeding</span>
                  </div>
                  <ul style={{ margin: 0, paddingLeft: 20, color: 'var(--ink-2)', fontSize: 13, lineHeight: 1.6 }}>
                    {blockersToShow.map((blocker: string, idx: number) => (
                      <li key={idx}>{blocker}</li>
                    ))}
                  </ul>
                </div>
              )
            })()}

            <div className="detail-foot">
              {(() => {
                const nodes = apiStatus?.data?.workflow_graph?.nodes || []
                const firstIncomplete = nodes.find((n: any) => n.status !== 'passed' && n.status !== 'approved')
                
                // 1. STATE CALCULATOR: Pure logic, isolated from UI rendering
                const isComplete = (st: Step) => {
                  if (st.status === 'done') return true
                  if (st.id === 'setup') return blankProject ? Boolean(s1.narrator && s1.style && s1.output) : true
                  if (st.id === 'idea') return ideaBrief.trim().length > 0
                  if (st.id === 'goal') return goal.text.trim().length > 0 || goal.mode === 'ai' || goal.mode === 'skip'
                  return false
                }
                
                const currentInputComplete =
                  activeStep.id === 'setup' && blankProject
                    ? Boolean(s1.narrator && s1.style && s1.output)
                    : activeStep.id === 'idea'
                      ? ideaBrief.trim().length > 0
                      : activeStep.id === 'goal'
                        ? goal.text.trim().length > 0 || goal.mode === 'ai' || goal.mode === 'skip'
                        : true
                        
                const priorsComplete = orderedSteps.slice(0, selectableIndex).every(isComplete)
                const stepComplete = currentInputComplete && priorsComplete
                
                const currentNode = nodes.find((n: any) => n.id === activeStep.sourceId)
                const isAlreadyApproved = currentNode?.status === 'passed' || currentNode?.status === 'approved'
                const needsApproval = currentNode?.requires_approval === true
                
                const isFirstIncomplete = activeStep.sourceId === firstIncomplete?.id
                const blockedStepIndex = firstIncomplete ? nodes.findIndex((n: any) => n.id === firstIncomplete.id) : -1
                const currentStepIndex = nodes.findIndex((n: any) => n.id === activeStep.sourceId)
                const isBeyondBlocked = firstIncomplete ? currentStepIndex > blockedStepIndex : false
                
                // PROGRESSION RULE: Can proceed only if complete, not beyond a blocker, and not already approved (unless dirty)
                const canProceed = !autopilot && stepComplete && !isBeyondBlocked && !(isAlreadyApproved && !isDirty)
                
                const goalIndex = orderedSteps.findIndex((s) => s.id === 'goal')
                const canAutopilot = !autopilot && !isBeyondBlocked && goalIndex >= 0 && selectableIndex >= goalIndex && activeStep.id !== 'post'
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
                            disabled={!stepComplete}
                            title={!stepComplete ? (!priorsComplete ? 'Complete the earlier steps first' : 'Make a choice for this step first') : undefined}
                            onClick={() => {
                              if (!stepComplete) return
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

                    {/* Main Save/Continue Choice */}
                    <div className="foot-choice">
                      {/* Subtle hint if on the current blocked step */}
                      {isFirstIncomplete && !stepComplete && (
                        <div style={{ color: 'var(--ink-3)', fontSize: 13, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span>ℹ️</span> Complete all requirements in this step to proceed.
                        </div>
                      )}

                      {/* Blocker card ONLY for steps beyond the blocked step */}
                      {isBeyondBlocked && firstIncomplete && (
                        <div className="card" style={{ marginTop: 12, marginBottom: 12, borderColor: 'var(--red)', background: 'rgba(233,106,106,.06)' }}>
                          <div className="ch" style={{ marginBottom: 8 }}>
                            <h3 style={{ color: 'var(--red)', fontSize: 14, margin: 0 }}>Step {String(blockedStepIndex + 1).padStart(2, '0')} ({firstIncomplete.label}) must be completed first</h3>
                          </div>
                        </div>
                      )}
                      
                      {/* Native button: relies entirely on .save-continue:disabled CSS for muted styling */}
                      <button
                        className="save-continue"
                        disabled={!canProceed}
                        onClick={() => {
                          if (!canProceed) return
                          onAdvance(activeStep.id)
                          if (isLast) onToast('Approved and finished.')
                          else {
                            setSelected(orderedSteps[selectableIndex + 1].id)
                            onToast(isAlreadyApproved ? 'Stage re-approved.' : (needsApproval ? 'Stage approved.' : 'Saved.'))
                          }
                        }}
                      >
                        {isAlreadyApproved && !isDirty 
                          ? 'Completed' 
                          : needsApproval 
                            ? (isLast ? 'Approve & finish' : 'Approve & continue →') 
                            : (isLast ? 'Save and finish' : 'Save and continue →')
                        }
                      </button>
                      <span className="foot-sub">
                        {autopilot
                          ? 'Autopilot is running — stop it to edit by hand'
                          : isAlreadyApproved && !isDirty
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

function StepContent({
  step,
  setupMode,
  showName,
  castData,
  s1,
  setS1,
  ideaBrief,
  setIdeaBrief,
  goal,
  setGoal,
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
  s1: { narrator: string; style: string; output: string; length: number; projectId: string; editing: string }
  setS1: React.Dispatch<
    React.SetStateAction<{
      narrator: string
      style: string
      output: string
      length: number
      projectId: string
      editing: string
    }>
  >
  ideaBrief: string
  setIdeaBrief: (value: string) => void
  goal: { text: string; mode: '' | 'ai' | 'skip' }
  setGoal: React.Dispatch<React.SetStateAction<{ text: string; mode: '' | 'ai' | 'skip' }>>
  blankProject: boolean
  onOpenCast: () => void
  onToast: (message: string) => void
  origin: 'blank' | 'template' | 'series'
  formatDirty: boolean
}) {
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
        <Step01Flow s1={s1} setS1={setS1} />
        <TemplateComponents />
      </>
    )
  }
  if (step.id === 'idea')
    return <IdeaBriefContent blankProject={blankProject} brief={ideaBrief} onBriefChange={setIdeaBrief} />
  if (step.id === 'goal')
    return <CoreMessageContent goal={goal} setGoal={setGoal} ideaBrief={ideaBrief} />
  if (step.id === 'plan') {
    return (
      <>
        <div className="struct-head">
          <span className="sub">12-beat outline</span>
          <button onClick={() => onToast('Outline editor is not wired up in this mock app.')}>
            Edit outline
          </button>
        </div>
        <div className="beat-list">
          {outline.map(([num, title, note]) => (
            <div className="beat-row" key={num}>
              <span>{num}</span>
              <b>{title}</b>
              <small>{note}</small>
            </div>
          ))}
        </div>
      </>
    )
  }
  if (step.id === 'worldkit') {
    return <WorldKitPanel castData={castData} showName={showName} onManage={onOpenCast} compact />
  }
  if (step.id === 'voice') return <NarrationContent />
  if (step.id === 'pacing') return <VisualPacingPanel blankProject={blankProject} />
  if (step.id === 'shots') return <ShotListPanel />
  if (step.id === 'pics') return <VisualGallery />
  if (step.id === 'post')
    return <SaveTemplateContent step={step} origin={origin} formatDirty={formatDirty} s1={s1} onToast={onToast} />
  return (
    <div className="stub">
      <p>{step.blurb}</p>
      <div className="what">Source-of-truth files and action logs will appear here when backend wiring lands.</div>
    </div>
  )
}

// Last step (Video output): once the video exists, offer to immortalize its setup.
// The kind is predetermined — a brand-new/standalone video saves a NEW format
// template; a video that came from an existing series saves a SUBTEMPLATE (a new
// episode pattern). If the format never diverged from what it started from, there's
// nothing new to save, so the action is greyed out.
function SaveTemplateContent({
  step,
  origin,
  formatDirty,
  s1,
  onToast,
}: {
  step: Step
  origin: 'blank' | 'template' | 'series'
  formatDirty: boolean
  s1: { narrator: string; style: string; output: string; length: number; projectId: string; editing: string }
  onToast: (message: string) => void
}) {
  const kind: 'template' | 'subtemplate' = origin === 'series' ? 'subtemplate' : 'template'
  // a brand-new video is always worth saving as a template; otherwise only once
  // the inherited format has actually been changed.
  const canSave = origin === 'blank' || formatDirty
  const kindLabel = kind === 'subtemplate' ? 'series template' : 'reusable template'
  const [name, setName] = useState(s1.projectId || '')
  const [locks, setLocks] = useState<Record<string, boolean>>({
    format: true,
    style: true,
    structure: kind === 'subtemplate',
    worldkit: kind === 'subtemplate',
  })
  const lockRows: [string, string][] = [
    ['format', 'Format & canvas'],
    ['style', 'Visual style'],
    ['structure', 'Structure outline'],
    ['worldkit', 'World Kit'],
  ]
  return (
    <div className="save-tpl">
      <div className="stub">
        <p>{step.blurb}</p>
        <div className="what">Source-of-truth files and action logs will appear here when backend wiring lands.</div>
      </div>
      <div className="save-tpl-card">
        <span className="eyebrow">REUSE THIS SETUP</span>
        <h3>Save as a {kindLabel}</h3>
        <p>
          {canSave
            ? kind === 'subtemplate'
              ? 'Save this as a new episode pattern under the series — pick what every future episode inherits.'
              : 'Save this video’s format so your next project can start from it instead of from scratch.'
            : 'Nothing has changed from the template yet — edit the format, structure, or cast to save a new version.'}
        </p>
        {canSave ? (
          <div className="st-detail">
            <label className="st-field">
              <span>{kind === 'subtemplate' ? 'Subtemplate name' : 'Template name'}</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={kind === 'subtemplate' ? 'e.g. Morning drop' : 'e.g. Spoolcast dev-log'}
              />
            </label>
            <div className="st-locks-wrap">
              <span className="st-locks-label">What carries over to every new video</span>
              <div className="st-locks">
                {lockRows.map(([k, label]) => (
                  <label key={k} className="st-lock">
                    <input
                      type="checkbox"
                      checked={locks[k]}
                      onChange={(e) => setLocks((l) => ({ ...l, [k]: e.target.checked }))}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
              <span className="st-locks-hint">Unchecked items stay open — chosen fresh for each new video.</span>
            </div>
            <AdditionalTemplateRules />
          </div>
        ) : null}
        <button
          className="st-save"
          disabled={!canSave || !name.trim()}
          onClick={() => {
            if (!canSave || !name.trim()) return
            onToast(`Saved “${name.trim()}” as a ${kindLabel}.`)
          }}
        >
          Save {kind === 'subtemplate' ? 'subtemplate' : 'template'} →
        </button>
      </div>
    </div>
  )
}

function AdditionalTemplateRules() {
  const idRef = useRef(0)
  const nextId = () => (idRef.current += 1)
  const [rules, setRules] = useState<TplRule[]>([])
  const [open, setOpen] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const [manual, setManual] = useState('')
  const [focus, setFocus] = useState('')
  const [confirmRemove, setConfirmRemove] = useState<number | null>(null)

  // each rule's text is an editable, auto-growing textarea — tap in to edit.
  const grow = (el: HTMLTextAreaElement | null) => {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }

  // any rule shown here is carried into the template on Save — there's no
  // separate confirm step; removing one (the ✕) is the only opt-out.
  const addRules = (incoming: Omit<TplRule, 'id'>[]) =>
    setRules((prev) => {
      const have = new Set(prev.map((r) => r.text))
      const fresh = incoming.filter((r) => !have.has(r.text)).map((r) => ({ ...r, id: nextId() }))
      return [...prev, ...fresh]
    })

  const addManual = () => {
    const text = manual.trim()
    if (!text) return
    setRules((prev) => [...prev, { id: nextId(), category: 'Custom', text }])
    setManual('')
  }

  const scanFocused = () => {
    const term = focus.trim()
    if (!term) return
    addRules([
      {
        category: 'Humor',
        text: `Lean into ${term} — keep the tone consistent with the pilot.`,
        source: 'Source: Screenplay · Scene 2',
      },
      {
        category: 'Visual motif',
        text: `Carry the ${term} motif into title cards and recurring beats.`,
        source: 'Source: Storyboard · Beat 6',
      },
    ])
    setFocus('')
  }

  return (
    <div className={`tpl-rules ${open ? 'open' : ''}`}>
      <button className="tpl-rules-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="st-locks-label">Additional template rules</span>
        <svg
          className={`tpl-chevron ${open ? 'open' : ''}`}
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {!open ? null : (
        <>
          <p className="tpl-rules-lede">
            Reusable show behavior the checklist can’t capture — humor, overlays, captions,
            recurring memes, motifs.
          </p>

          <div className="tpl-input-row">
            <input
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addManual()
              }}
              placeholder="Example: End each video with a notification-style teaser card."
            />
            <button className="tpl-btn" disabled={!manual.trim()} onClick={addManual}>
              Add rule
            </button>
          </div>

          <div className="tpl-or-sep">or</div>

          <button
            className={`ai-btn tpl-ai-toggle ${aiOpen ? 'sel' : ''}`}
            onClick={() => setAiOpen((o) => !o)}
            aria-expanded={aiOpen}
          >
            <span className="ap-spark">✦</span> Let AI decide
            <svg
              className={`tpl-chevron ${aiOpen ? 'open' : ''}`}
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>

          {aiOpen ? (
            <div className="tpl-scan">
              <button className="tpl-scan-btn" onClick={() => addRules(SCAN_SUGGESTIONS)}>
                <span className="ap-spark">✦</span> Scan project for reusable rules
              </button>
              <span className="scan-note">
                AI reviews the structure, screenplay, storyboard, cast, and final output, then
                suggests rules to carry forward.
              </span>
              <span className="tpl-or-line">or focus on something specific</span>
              <div className="tpl-input-row">
                <input
                  value={focus}
                  onChange={(e) => setFocus(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') scanFocused()
                  }}
                  placeholder="Example: dark humor, title cards, recurring memes"
                />
                <button className="tpl-btn ai" disabled={!focus.trim()} onClick={scanFocused}>
                  <span className="ap-spark">✦</span> Scan with focus
                </button>
              </div>
            </div>
          ) : null}

      {rules.length ? (
        <div className="tpl-rule-list">
          {rules.map((r) => (
            <div key={r.id} className="tpl-rule">
              <div className="tpl-rule-top">
                <span className="tpl-rule-cat">{r.category}</span>
                <button
                  className="tpl-rule-x"
                  aria-label="Remove rule"
                  onClick={() => setConfirmRemove(r.id)}
                >
                  ✕
                </button>
              </div>
              <textarea
                className="tpl-rule-field"
                value={r.text}
                rows={1}
                ref={grow}
                onChange={(e) => {
                  grow(e.target)
                  setRules((prev) =>
                    prev.map((x) => (x.id === r.id ? { ...x, text: e.target.value } : x)),
                  )
                }}
              />
              {r.source ? <span className="tpl-rule-src">{r.source}</span> : null}
            </div>
          ))}
            </div>
          ) : null}

          {confirmRemove != null ? (
            <div className="modal-scrim" onClick={() => setConfirmRemove(null)}>
              <div className="confirm-modal" onClick={(e) => e.stopPropagation()}>
                <h3>Remove this rule?</h3>
                <p>It won’t be carried forward into the template. This can’t be undone.</p>
                <div className="actions">
                  <button onClick={() => setConfirmRemove(null)}>Cancel</button>
                  <button
                    className="primary"
                    onClick={() => {
                      setRules((prev) => prev.filter((x) => x.id !== confirmRemove))
                      setConfirmRemove(null)
                    }}
                  >
                    Remove rule
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}

// Inherited show elements, surfaced inside Step 01 (Project setup) — NOT a
// workflow node. A series shows what it inherited from its template (each
// element On/Off, or Locked); a standalone shows an empty state pointing at
// the save-as-template step. Toggling an inherited element warns first, since
// it overrides the template for this one episode.

function TemplateComponents({
  inherited,
  templateName,
}: {
  inherited?: boolean
  templateName?: string
}) {
  const [comps, setComps] = useState(INHERITED_COMPONENTS)
  const [pending, setPending] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  const pendingComp = comps.find((c) => c.key === pending)
  return (
    <div className={`tc-card ${open ? 'open' : ''}`}>
      <button className="tc-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="eyebrow">Template components</span>
        <svg
          className={`tpl-chevron ${open ? 'open' : ''}`}
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {!open ? null : !inherited ? (
        <>
          <p className="tc-empty-title">No template components yet.</p>
          <p className="tc-empty-sub">
            Reusable show elements — title bar, end card, watermark, caption style — are added when
            you save this video as a template (the final step).
          </p>
        </>
      ) : (
        <>
          <p className="tc-inherited">
            Inherited from <b>{templateName}</b>
          </p>
          <div className="tc-list">
            {comps.map((c) => (
              <div className="tc-row" key={c.key}>
                <span className="tc-label">{c.label}</span>
                {c.locked ? (
                  <span className="tc-chip locked">Locked</span>
                ) : (
                  <button
                    className={`tc-toggle ${c.on ? 'on' : 'off'}`}
                    aria-pressed={c.on}
                    onClick={() => setPending(c.key)}
                  >
                    {c.on ? 'On' : 'Off'}
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      )}
      {pendingComp ? (
        <div className="modal-scrim" onClick={() => setPending(null)}>
          <div className="confirm-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Override an inherited component?</h3>
            <p>
              Turning <b>{pendingComp.label}</b> {pendingComp.on ? 'off' : 'on'} changes it for this
              episode only — the {templateName} template stays as it is.
            </p>
            <div className="actions">
              <button onClick={() => setPending(null)}>Cancel</button>
              <button
                className="primary"
                onClick={() => {
                  setComps((prev) =>
                    prev.map((x) => (x.key === pending ? { ...x, on: !x.on } : x)),
                  )
                  setPending(null)
                }}
              >
                Change for this episode
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function NarrationContent() {
  return (
    <div className="idea-v2">
      <h3 className="idea-q">What voice narrates this video?</h3>
      <p className="idea-sources-caption">
        The script is read by this voice reference. Defaults to Google TTS — swap it for any voice in the library.
      </p>
      <div className="voice-card">
        <span className="voice-play">▶</span>
        <span className="voice-meta">
          <span className="voice-name">Google TTS · Schedar</span>
          <span className="voice-sub">English · male · default</span>
        </span>
        <button className="voice-change">Change voice →</button>
      </div>
    </div>
  )
}

function Step01DoneRow({
  field,
  title,
  value,
  onEdit,
}: {
  field: string
  title: string
  value: string
  onEdit?: (field: string) => void
}) {
  const interactive = Boolean(onEdit)
  return (
    <button
      type="button"
      className={`s1-question done ${interactive ? 'done-head' : 'done-static'}`}
      onClick={() => onEdit?.(field)}
      disabled={!interactive}
    >
      <div className="s1-q-head">
        <span className="s1-q-title">{title}</span>
        <span className="s1-q-summary">{value}</span>
        {interactive ? <span className="s1-edit">EDIT</span> : null}
      </div>
    </button>
  )
}

function Step01Flow({
  s1,
  setS1,
}: {
  s1: { narrator: string; style: string; output: string; length: number; projectId: string; editing: string }
  setS1: React.Dispatch<
    React.SetStateAction<{
      narrator: string
      style: string
      output: string
      length: number
      projectId: string
      editing: string
    }>
  >
}) {
  const active =
    s1.editing ||
    (!s1.narrator ? 'narrator' : !s1.style ? 'style' : !s1.output ? 'output' : '')
  const setField = (field: string, value: string | number) =>
    setS1((current) => ({ ...current, [field]: value, editing: '' }))
  const editField = (field: string) =>
    setS1((current) => ({ ...current, editing: field }))

  return (
    <div className="s1-flow">
      {s1.narrator && active !== 'narrator' ? (
        <Step01DoneRow
          field="narrator"
          title="Narrator"
          value={s1.narrator === 'yes' ? 'Narrator (TTS)' : 'In-video audio'}
          onEdit={editField}
        />
      ) : (
        <div className="s1-question active">
          <div className="s1-q-head">
            <span className="s1-q-title">Is there a narrator?</span>
          </div>
          <div className="s1-pills">
            <Pill selected={s1.narrator === 'yes'} onClick={() => setField('narrator', 'yes')}>
              <span className="opt-num">A</span>
              <span className="name">Yes, narrator reads it</span>
              <a>example →</a>
            </Pill>
            <Pill selected={s1.narrator === 'no'} onClick={() => setField('narrator', 'no')}>
              <span className="opt-num">B</span>
              <span className="name">No, audio with the video</span>
              <a>example →</a>
            </Pill>
          </div>
        </div>
      )}
      {s1.narrator ? (
        s1.style && active !== 'style' ? (
          <Step01DoneRow
            field="style"
            title="Style"
            value={styleThumbs.find((style) => style.id === s1.style)?.name ?? s1.style}
            onEdit={editField}
          />
        ) : (
          <div className="s1-question active">
            <div className="s1-q-head">
              <span className="s1-q-title">Pick a starting style</span>
            </div>
            <div className="s1-style-grid">
              {styleThumbs.map((style) => {
                const disabled = s1.narrator === 'no' && style.narratorOnly
                return (
                  <Pill
                    key={style.id}
                    className="thumb-pill small"
                    selected={s1.style === style.id}
                    disabled={disabled}
                    onClick={() => setField('style', style.id)}
                  >
                    <span className="preview">
                      {style.img ? <img src={style.img} alt="" /> : <span className="person-icon" />}
                      {style.badge ? <b>{style.badge}</b> : null}
                    </span>
                    <span className="name">{style.name}</span>
                    {disabled ? <span className="lock-text">narrator only</span> : null}
                  </Pill>
                )
              })}
            </div>
          </div>
        )
      ) : null}
      {s1.style ? (
        s1.output && active !== 'output' ? (
          <Step01DoneRow
            field="output"
            title="Output"
            value={s1.output === '916' ? '9:16 vertical' : s1.output === '169' ? '16:9 widescreen' : '1:1 square'}
            onEdit={editField}
          />
        ) : (
          <div className="s1-question active">
            <div className="s1-q-head">
              <span className="s1-q-title">Where will this play?</span>
            </div>
            <div className="s1-pills">
              {[
                ['169', 'A', 'Widescreen', '16:9'],
                ['916', 'B', 'Vertical', '9:16'],
                ['11', 'C', 'Square', '1:1'],
              ].map((item) => (
                <Pill key={item[0]} selected={s1.output === item[0]} onClick={() => setField('output', item[0])}>
                  <span className="opt-num">{item[1]}</span>
                  <span className="name">{item[2]}</span>
                  <span className="desc">{item[3]}</span>
                </Pill>
              ))}
            </div>
          </div>
        )
      ) : null}
      {s1.output ? (
        active === 'length' ? (
          <div className="s1-question active s1-length-q">
            <div className="s1-q-head">
              <span className="s1-q-title">How long?</span>
              <button className="s1-edit" onClick={() => setS1((c) => ({ ...c, editing: '' }))}>
                DONE
              </button>
            </div>
            <div className={`s1-length-val ${s1.length === 0 ? 'muted' : ''}`}>
              {s1.length === 0 ? (
                <>Auto <em>· set at the structure outline (step 04)</em></>
              ) : (
                <>
                  ~{Math.round((s1.length / 60) * 10) / 10} min{' '}
                  <em>({s1.length}s · ~{Math.round(s1.length / 8)} scenes)</em>
                </>
              )}
            </div>
            <input
              type="range"
              min={30}
              max={600}
              step={15}
              value={s1.length || 120}
              disabled={s1.length === 0}
              onChange={(event) => setS1((c) => ({ ...c, length: Number(event.target.value) }))}
            />
            <button
              className={`ai-btn ${s1.length === 0 ? 'sel' : ''}`}
              onClick={() => setS1((c) => ({ ...c, length: c.length === 0 ? 120 : 0 }))}
            >
              <span className="ap-spark">✦</span> Let AI decide
            </button>
          </div>
        ) : (
          <Step01DoneRow
            field="length"
            title="How long"
            value={
              s1.length === 0
                ? 'Auto · set at step 04'
                : `~${Math.round((s1.length / 60) * 10) / 10} min · ${Math.round(s1.length / 8)} scenes`
            }
            onEdit={editField}
          />
        )
      ) : null}
      {s1.output ? (
        <div className="s1-question active project-id">
          <div className="s1-q-head">
            <span className="s1-q-title">Name this project</span>
          </div>
          <input
            value={s1.projectId}
            onChange={(event) => setS1((current) => ({ ...current, projectId: event.target.value }))}
          />
        </div>
      ) : null}
    </div>
  )
}

type SourceFile = { id: string; name: string; meta: string; kind: 'doc' | 'clock' | 'image'; desc: string }

function IdeaBriefContent({
  blankProject,
  brief,
  onBriefChange,
}: {
  blankProject: boolean
  brief: string
  onBriefChange: (value: string) => void
}) {
  const [files, setFiles] = useState<SourceFile[]>(
    blankProject
      ? []
      : [], // ZERO DUMMY DATA RULE: Source material must come from the engine, not hardcoded mocks.
  )

  const setDesc = (id: string, desc: string) =>
    setFiles((current) => current.map((file) => (file.id === id ? { ...file, desc } : file)))
  const removeFile = (id: string) =>
    setFiles((current) => current.filter((file) => file.id !== id))

  // RULE 5: Functional Input Rule - Handle real file uploads to the local API
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    try {
      // Read file as base64
      const buffer = await file.arrayBuffer()
      const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)))
      
      // Send to local API
      const res = await fetch('http://localhost:8000/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: 'spoolcast-dev-log-12',
          tenant: 'local',
          action: 'upload_file',
          filename: file.name,
          content: base64
        })
      })

      if (res.ok) {
      await res.json() // Consume the response to ensure request completes
        setFiles(prev => [...prev, { 
          id: `f${Date.now()}`, 
          name: file.name, 
          meta: `${(file.size / 1024).toFixed(1)} KB · Uploaded`, 
          kind: 'doc', 
          desc: '' 
        }])
        alert(`Successfully uploaded ${file.name} to the engine!`)
      } else {
        alert('Failed to upload file to the engine.')
      }
    } catch (err) {
      console.error('Upload error:', err)
      alert('Error uploading file. Is the local API running?')
    }
    // Clear input so the same file can be selected again
    e.target.value = ''
  }

  return (
    <div className="idea-v2">
      <h3 className="idea-q">What's this video about?</h3>

      <textarea
        className="idea-textbox"
        rows={5}
        value={brief}
        onChange={(event) => onBriefChange(event.target.value)}
        placeholder="A short explanation of the idea, topic, opinion, or story this video should turn into."
      />

      <div className="idea-helpers">
        <a>Generate angles</a>
        <a>Ask clarifying questions</a>
        <a>Turn notes into a thesis</a>
      </div>

      <section className="idea-sources">
        <span className="eyebrow">SOURCE MATERIAL</span>
        <p className="idea-sources-caption">
          Links, notes, transcripts, screenshots, and reference files can attach here after the idea is clear.
        </p>

        {files.length ? (
          <div className="file-list">
            {files.map((file) => (
              <div className="file-row" key={file.id}>
                <span className="file-icon">
                  <FileGlyph kind={file.kind} />
                </span>
                <span className="file-meta-col">
                  <span className="file-name">{file.name}</span>
                  <span className="file-desc">
                    <input
                      value={file.desc}
                      onChange={(event) => setDesc(file.id, event.target.value)}
                      placeholder="Add a one-line description so the model knows how to use this file…"
                    />
                  </span>
                  <span className="file-size">{file.meta}</span>
                </span>
                <button className="file-remove" onClick={() => removeFile(file.id)}>
                  Remove
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <label className="idea-attach" style={{ cursor: 'pointer' }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14" />
            <path d="M5 12h14" />
          </svg>
          Attach files
          <input 
            type="file" 
            style={{ display: 'none' }} 
            onChange={handleFileUpload} 
          />
        </label>
      </section>
    </div>
  )
}

function CoreMessageContent({
  goal,
  setGoal,
  ideaBrief,
}: {
  goal: { text: string; mode: '' | 'ai' | 'skip' }
  setGoal: React.Dispatch<React.SetStateAction<{ text: string; mode: '' | 'ai' | 'skip' }>>
  ideaBrief: string
}) {
  const [generating, setGenerating] = useState(false)
  const genTimer = useRef(0)
  useEffect(() => () => window.clearTimeout(genTimer.current), [])

  const createWithAI = () => {
    setGenerating(true)
    setGoal({ text: '', mode: 'ai' })
    genTimer.current = window.setTimeout(() => {
      const suggestion = ideaBrief.trim()
        ? 'The Spoolcast engine is finally stable enough that the product is now the UI wrapped around it — not the pipeline itself.'
        : 'One clear, memorable idea your audience should walk away believing.'
      setGoal({ text: suggestion, mode: '' })
      setGenerating(false)
    }, 1600)
  }

  return (
    <div className="idea-v2">
      <h3 className="idea-q">What's the one core message of this video?</h3>

      <div className={`idea-textbox-wrap ${generating ? 'generating' : ''}`}>
        <textarea
          className="idea-textbox"
          rows={4}
          value={goal.text}
          disabled={generating}
          onChange={(event) => setGoal({ text: event.target.value, mode: '' })}
          placeholder="The one thing a viewer should walk away believing."
        />
        {generating ? (
          <span className="gen-overlay">
            <span className="spin" /> Drafting a core message…
          </span>
        ) : null}
      </div>

      <div className="core-or">or</div>

      <div className="core-opts">
        <div className="core-ai">
          <span className="ap-spark">✦</span>
          <span className="core-ai-text">
            <span className="nm">Let AI suggest one</span>
            <span className="ds">drafted from your idea &amp; answers — you can edit it</span>
          </span>
          <button type="button" className="core-create" disabled={generating} onClick={createWithAI}>
            {generating ? (
              <>
                <span className="spin" /> Generating…
              </>
            ) : (
              'Create with AI'
            )}
          </button>
        </div>
        <button
          type="button"
          className={`core-opt ${goal.mode === 'skip' ? 'sel' : ''}`}
          onClick={() => {
            window.clearTimeout(genTimer.current)
            setGenerating(false)
            setGoal({ text: '', mode: 'skip' })
          }}
        >
          <span className="nm">Skip — no core message needed</span>
          <span className="ds">freeform / vibe-based</span>
        </button>
      </div>
    </div>
  )
}

function FileGlyph({ kind }: { kind: 'doc' | 'clock' | 'image' }) {
  if (kind === 'clock') {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
    )
  }
  if (kind === 'image') {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
        <circle cx="9" cy="9" r="2" />
        <path d="M21 15l-5-5L5 21" />
      </svg>
    )
  }
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  )
}

// Shot-List (step 08): read-only, hierarchical chunk → beat → image view that
// mirrors shot-list.json (base_layer + overlay_layer). It reads the confirmed pacing plan
// directly — editing happens upstream in Visual Pacing, then "exports" here.
function ShotListPanel() {
  const plan = visualPacingPlan
  const images = plan.chunks.flatMap((c) => c.beats.flatMap((b) => b.images))
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`
  return (
    <div className="panel-flat shotlist">
      <div className="ch">
        <h3>Shot list — {plan.chunks.length} chunks · {images.length} images</h3>
        <span>shot-list/shot-list.json</span>
      </div>
      <p className="vp-hint">Read-only — exported from Visual Pacing. Grouped chunk → beat → image, mirroring the JSON. Edit the pacing upstream to change it.</p>
      <div className="vp-chunks">
        {plan.chunks.map((chunk) => (
          <details className="vp-chunk" key={chunk.id}>
            <summary>
              <span className="id">{chunk.id}</span>
              <b>{chunk.title}</b>
              <small>{chunk.range}</small>
              <em>{chunk.beats.reduce((n, b) => n + b.images.length, 0)} img</em>
            </summary>
            <div className="vp-beats">
              {chunk.summary ? <p className="sl-summary">{chunk.summary}</p> : null}
              {chunk.beats.map((beat) => (
                <div className="sl-beat" key={beat.code}>
                  <p className="sl-narr">
                    <span className="sl-beatcode">{beat.code}</span>
                    "{beat.narration}" <small>{beat.range}</small>
                  </p>
                  {beat.images.map((img) => (
                    <div className="sl-img" key={img.id}>
                      <span className="id">{img.id}</span>
                      <span className="sl-words">{img.firstWord} … {img.lastWord}</span>
                      <span className="sl-time vp-mono">{fmt(img.startS)}–{fmt(img.endS)}</span>
                      <span className="sl-what">{img.what}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </details>
        ))}
      </div>
    </div>
  )
}

function VisualGallery() {
  let imageIndex = 0
  const counts = {
    ready: shots.filter((shot) => shot[4] === 'ok').length,
    generating: shots.filter((shot) => shot[4] === 'work').length,
    pending: shots.filter((shot) => shot[4] === 'pend').length,
  }
  return (
    <div className="card">
      <div className="gal-bar">
        <span><i className="dot ok" />{counts.ready} ready</span>
        <span><i className="dot work" />{counts.generating} generating</span>
        <span><i className="dot pend" />{counts.pending} pending</span>
        <b>22 visuals total · anime · soft</b>
      </div>
      <div className="gallery">
        {shots.map(([id, scene, , , state]) => {
          const file = state === 'ok' ? sceneFiles[imageIndex++ % sceneFiles.length] : ''
          return (
            <div className="gcard" key={id}>
              <div className={`img ${state}`}>
                {file ? <img src={asset(`sessions/spoolcast-dev-log-04/source/generated-assets/scenes/${file}`)} alt="" /> : null}
                <span className="badge">{id}</span>
                <span className={`st ${state}`}>{state === 'ok' ? 'Ready' : state === 'work' ? 'Generating' : 'Pending'}</span>
                <div className="scene">{scene}</div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// Visual Pacing mock plan. Mirrors working/visual-pacing-plan.md: chunk → beat
// (one narration line) → one or more images, each with a "why now" rationale,
// hold time, and whether it's distinct from the previous image. Inventory and
// summary counts are derived from this single source so they can't drift.
// (Sample content adapted from a real 5-minute devlog pacing plan.)
type VPImage = { id: string; what: string; why: string; hold: string; distinct: boolean; refs: string; firstWord: string; lastWord: string; startS: number; endS: number; firstIdx: number; lastIdx: number }
type VPBeat = { code: string; range: string; narration: string; images: VPImage[] }
type VPChunk = { id: string; title: string; range: string; summary: string; words: string[]; beats: VPBeat[] }
type VPOverlay = { id: string; trigger: string; image: string; dur: string; placement: string; anchor: string; chunk: string; firstIdx: number; lastIdx: number }

// Mock pacing plan — extracted from spoolcast-dev-log-11 (33 images, C001 split to 6).
// Nested chunk → beat → image; each image carries its Whisper-aligned time + word span.
const visualPacingPlan: {
  source: string; style: string; runtime: string
  opening: number; body: number
  chunks: VPChunk[]; overlays: VPOverlay[]
} = {
  source: "spoolcast-dev-log-06", style: "wojak-gpt2", runtime: "~5.0 min",
  opening: 9, body: 24,
  chunks: [
    {
      id: "C001", title: "Cold Open", range: "0–22s", summary: "Agent failed mid-ship. VPN drops. Three compaction attempts, all dead.",
      words: ["I", "was", "in", "the", "middle", "of", "shipping", "a", "video", "when", "my", "AI", "agent", "failed.", "Not", "because", "it", "crashed,", "not", "because", "it", "ran", "out", "of", "tokens,", "because", "the", "VPN", "connection", "to", "the", "server", "it", "was", "running", "on", "kept", "dropping.", "Every", "time", "the", "agent", "tried", "to", "compress", "the", "conversation,", "the", "connection", "cut", "out", "and", "the", "session", "died.", "Three", "failed", "attempts", "in", "a", "row.", "After", "the", "third,", "I", "gave", "up."],
      beats: [
        {
          code: "001A", range: "0.0–3.4s", narration: "I was in the middle of shipping a video when my AI agent failed.",
          images: [
            { id: "IMG01", what: "Builder slams machine shut at dimly-lit airport gate at midnight. Departure board behind: every flight CANCELLED in red.", why: "Immediate visual hook — failure + frustration. Sets tone before a word of explanation.", hold: "3.4s", distinct: true, refs: "builder", firstWord: "I", lastWord: "failed.", startS: 0.0, endS: 3.4, firstIdx: 0, lastIdx: 13 },
          ],
        },
        {
          code: "001B", range: "4.1–22.0s", narration: "split into 5 visual moments at sentence boundaries:",
          images: [
            { id: "IMG02", what: "Crash icon with red circle-slash overlaid, beside a token counter also struck through. Both false causes being dismissed. Dark background with a single green checkmark appearing: \"Not this.\"", why: "\"Not because it crashed. Not because it ran out of tokens.\" — visually eliminate the wrong answers before revealing the real one. The viewer sees two theories rejected in 3 seconds.", hold: "3.4s", distinct: true, refs: "—", firstWord: "Not", lastWord: "tokens.", startS: 4.1, endS: 7.54, firstIdx: 17, lastIdx: 27 },
            { id: "IMG03", what: "Close-up of closed machine screen. Progress bar frozen at 87%, sparks from the crack in the percentage.", why: "\"Because the VPN connection kept dropping.\" — the real cause. Frozen progress = the stall. Sparks = the connection breaking.", hold: "3.4s", distinct: true, refs: "—", firstWord: "Because", lastWord: "dropping.", startS: 8.52, endS: 11.9, firstIdx: 32, lastIdx: 44 },
            { id: "IMG04", what: "AI-figure struggles to cram papers through a narrow tube labeled COMPACTION. A lightning bolt strikes the tube mid-cram, shattering it. Papers fly everywhere. The shattered tube pieces float in the air.", why: "\"Every time the agent tried to compress the conversation, the connection cut out and the session died.\" — the failure loop made physical. Lightning = connection drop, shattered tube = dead session.", hold: "4.5s", distinct: true, refs: "ai-figure", firstWord: "Every", lastWord: "died.", startS: 12.72, endS: 17.24, firstIdx: 47, lastIdx: 61 },
            { id: "IMG05", what: "Three red X marks stacked vertically on dark screen. Each X pulses slightly larger than the last.", why: "\"Three failed attempts in a row.\" — visual counting of the failures. Quick flash (~1.5s) — the stacking Xs make the repetition feel physical.", hold: "1.5s", distinct: true, refs: "—", firstWord: "Three", lastWord: "row.", startS: 18.22, endS: 19.72, firstIdx: 66, lastIdx: 66 },
            { id: "IMG06", what: "Builder's hand releasing the machine handle, turning away from the gate. Silhouette against the red CANCELLED board.", why: "\"After the third, I gave up.\" — the surrender moment. Emotional pivot from frustration to defeat. Quick cut (~1.4s), holds through transition to promise.", hold: "1.4s", distinct: true, refs: "builder", firstWord: "After", lastWord: "up.", startS: 20.6, endS: 22.02, firstIdx: 66, lastIdx: 66 },
          ],
        },
      ],
    },
    {
      id: "C002", title: "Promise + Spoolcast Intro", range: "23–48s", summary: "Promise what viewer will learn. Introduce Spoolcast pipeline.",
      words: ["By", "the", "end,", "you", "will", "understand", "why", "I", "switched", "tools", "mid", "-project", "and", "why", "the", "software", "that", "wraps", "around", "an", "AI", "model", "matters", "as", "much", "as", "the", "model", "itself.", "Quick", "context.", "Spoolcast", "is", "my", "AI", "video", "pipeline.", "I", "give", "it", "messy", "source", "material,", "build", "notes,", "screenshots,", "chat", "logs,", "and", "agents", "help", "turn", "that", "into", "videos.", "Understand", "the", "source.", "Write", "the", "story.", "Plan", "what", "appears", "on", "screen.", "Make", "the", "narration", "and", "visuals.", "Render", "the", "final", "video."],
      beats: [
        {
          code: "002A", range: "23.2–30.4s", narration: "By the end, you will understand why I switched tools mid-project, and why the software that wraps around an AI model matters as much as the model itself.",
          images: [
            { id: "IMG07", what: "Video-making machine on bright TV-show set with stage lights. Builder stands beside it, hand on lever. Clean video reel glowing at output end.", why: "Orientation: introduces the system that makes this video. \"You will understand\" paired with \"here's the machine that makes it.\"", hold: "7.2s", distinct: true, refs: "builder", firstWord: "By", lastWord: "itself.", startS: 23.25, endS: 30.35, firstIdx: 0, lastIdx: 24 },
          ],
        },
        {
          code: "002B", range: "31.3–47.9s", narration: "Quick context. Spoolcast is my AI video pipeline... understand the source, write the story, plan what appears on screen, make the narration and visuals, render the final video.",
          images: [
            { id: "IMG08", what: "Five glass chambers light up in sequence: eye icon → pen icon → canvas icon → speaker icon → film strip icon. Each glows as the narration reaches it. Dark background, clean progression.", why: "Visualize the pipeline steps as they're spoken. Each step gets its own visual activation.", hold: "9.2s", distinct: true, refs: "—", firstWord: "Quick", lastWord: "turn", startS: 31.29, endS: 40.49, firstIdx: 28, lastIdx: 50 },
            { id: "IMG09", what: "Same machine, wide shot. Messy inputs drop into left side: chat bubbles, screenshot cards, text file pages. Clean glowing video reel emerges right side. Builder pulls lever, activating a stage.", why: "Show the messy-input → clean-output contrast. The Spoolcast promise made visual.", hold: "7.4s", distinct: true, refs: "builder", firstWord: "that", lastWord: "video.", startS: 40.49, endS: 47.91, firstIdx: 51, lastIdx: 71 },
          ],
        },
      ],
    },
    {
      id: "C003", title: "Almost Shipped", range: "49–70s", summary: "Tool stopped working. Hotel room in China. Ep 17 almost done.",
      words: ["This", "episode", "is", "about", "what", "happened", "when", "the", "tool", "I", "was", "using", "stopped", "working", "and", "I", "had", "to", "find", "a", "new", "one", "from", "a", "hotel", "room", "in", "China.", "The", "video", "was", "episode", "17", "of", "a", "daily", "AI", "news", "show.", "Script", "done,", "clips", "generated,", "final", "render", "complete,", "one", "command", "left", "to", "publish,", "and", "the", "tool", "that", "was", "supposed", "to", "run", "that", "command", "could", "no", "longer", "finish", "a", "sentence."],
      beats: [
        {
          code: "003A", range: "49.2–55.3s", narration: "This episode is about what happened when the tool I was using stopped working, and I was in a hotel room in China with a video almost finished.",
          images: [
            { id: "IMG10", what: "Factory conveyor belt. Three completed packages move toward a launch pad: SCRIPT ✓, CLIPS ✓, RENDER ✓. Builder walks alongside, checking each.", why: "Stakes: show the progress that's about to stall. Three green checks build expectation.", hold: "6.1s", distinct: true, refs: "builder", firstWord: "This", lastWord: "China.", startS: 49.24, endS: 55.28, firstIdx: 0, lastIdx: 25 },
          ],
        },
        {
          code: "003B", range: "56.2–69.5s", narration: "The video was episode seventeen of a daily AI news show. Script written, clips generated, final render running. One command left to publish. And the tool that had been doing this for months could no longer finish a sentence.",
          images: [
            { id: "IMG11", what: "Launch pad close-up. One empty slot labeled PUBLISH. The red button is cracked. A cable between builder's outstretched hand and the console sparks and breaks, inches away.", why: "The almost-shipped moment: everything done except the one thing that failed. The sparking cable = the broken connection.", hold: "13.3s", distinct: true, refs: "builder", firstWord: "The", lastWord: "sentence.", startS: 56.22, endS: 69.48, firstIdx: 29, lastIdx: 66 },
          ],
        },
      ],
    },
    {
      id: "C004", title: "Codex Remote Server", range: "71–86s", summary: "Codex was the tool. Remote server. Desktop is just a window.",
      words: ["The", "tool", "was", "codex,", "open", "-AI's", "coding", "agent.", "For", "months,", "it", "was", "how", "I", "shipped", "everything,", "but", "it", "runs", "on", "a", "remote", "server.", "Your", "desktop", "is", "just", "a", "window.", "When", "the", "connection", "drops,", "you", "feel", "every", "mile", "between", "you", "and", "the", "machine", "doing", "the", "work."],
      beats: [
        {
          code: "004A", range: "70.8–76.3s", narration: "The tool was Codex, OpenAI's coding agent. For months, it was how I shipped everything.",
          images: [
            { id: "IMG12", what: "Builder at a table with open notebook showing Codex interface. Behind the notebook, a giant transparent screen shows a distant server room across an ocean. A thin glowing cable stretches from the notebook across the water.", why: "Introduce the tool that failed. Show the physical distance between builder and server — the cable across the ocean is the metaphor.", hold: "5.5s", distinct: true, refs: "builder", firstWord: "The", lastWord: "everything,", startS: 70.81, endS: 76.27, firstIdx: 0, lastIdx: 16 },
          ],
        },
        {
          code: "004B", range: "77.2–85.5s", narration: "But it runs on a remote server. Your desktop is just a window. When the connection drops, you feel every mile between you and the machine doing the work.",
          images: [
            { id: "IMG13", what: "Same scene, but the cable now has three visible breaks with sparking ends. Builder's reflection in the screen staring at the breaks. The server room on the other side glows, bright and unreachable.", why: "The cable breaks = the three failed compactions. The distance becomes the problem.", hold: "8.3s", distinct: true, refs: "builder", firstWord: "but", lastWord: "work.", startS: 77.17, endS: 85.51, firstIdx: 22, lastIdx: 44 },
          ],
        },
      ],
    },
    {
      id: "C005", title: "Context Compaction Explained", range: "87–115s", summary: "What compaction is. One interrupted call = dead session.",
      words: ["Here", "is", "what", "context", "compaction", "means.", "Every", "message", "stays", "in", "the", "chat", "history.", "After", "hours,", "that", "is", "tens", "of", "thousands", "of", "words.", "The", "model", "can", "only", "hold", "so", "much,", "so", "the", "agent", "summarizes", "the", "early", "parts", "and", "keeps", "going.", "But", "that", "summary", "needs", "one", "uninterrupted", "call.", "If", "your", "connection", "drops,", "the", "compaction", "fails,", "the", "context", "window", "fills", "up,", "and", "the", "session", "dies.", "I", "watch", "the", "four", "-second", "drop", "destroy", "hours", "of", "work", "three", "times.", "I", "didn't", "try", "a", "fourth."],
      beats: [
        {
          code: "005A", range: "86.8–100.1s", narration: "Here is what context compaction means. Every message stays in the chat history. After a few hundred messages, the history is longer than what the model can read at once. To keep going, the agent summarizes the early parts and keeps going.",
          images: [
            { id: "IMG14", what: "Ai-figure feeds a giant scroll of chat messages into a funnel labeled CONTEXT WINDOW. The funnel is overflowing with paper. The ai-figure works methodically, feeding more scroll.", why: "Visualize the chat history as a physical object. Overflowing funnel = context window full. Ai-figure = the agent trying to manage it.", hold: "13.3s", distinct: true, refs: "ai-figure", firstWord: "Here", lastWord: "going.", startS: 86.79, endS: 100.13, firstIdx: 0, lastIdx: 40 },
          ],
        },
        {
          code: "005B", range: "101.0–114.5s", narration: "But that summary needs one uninterrupted call to the model. If the connection drops mid-compaction, the session dies. I watched a four-second drop destroy hours of work three times. I didn't try a fourth.",
          images: [
            { id: "IMG15", what: "A machine labeled COMPACTION tries to cram the overflow through a narrow tube. A lightning bolt strikes the tube mid-cram, shattering it. Papers fly everywhere. Ai-figure throws up its hands. The shattered tube pieces float in the air.", why: "The failure: lightning bolt = connection drop, shattered tube = dead session, flying papers = lost work. Physical consequence of a digital failure.", hold: "13.5s", distinct: true, refs: "ai-figure", firstWord: "But", lastWord: "fourth.", startS: 100.97, endS: 114.49, firstIdx: 43, lastIdx: 78 },
          ],
        },
      ],
    },
    {
      id: "C006", title: "Shenzhen Context", range: "116–121s", summary: "Builder in Shenzhen. VPS via VPN from China. Failure context.",
      words: ["I", "was", "in", "Xinjiang,", "on", "vacation,", "shipping", "a", "daily", "news", "show", "through", "a", "VPN", "from", "mainland", "China", "at", "midnight."],
      beats: [
        {
          code: "006A", range: "115.8–120.9s", narration: "I was in Shenzhen, on vacation, shipping a daily news show through a VPN from mainland China at midnight.",
          images: [
            { id: "IMG16", what: "Builder at a busy Shenzhen night market food stall. Chopsticks in one hand, phone in the other. Phone screen: server rack with giant red X, VPN shield cracked in half. Neon signs in Chinese characters glow behind. Builder looks at phone with exhausted disbelief, arm held out like the phone personally betrayed them.", why: "Location context: the absurdity of the situation. Vibrant night market vs dead server. The \"on vacation\" detail makes the frustration feel specific.", hold: "5.1s", distinct: true, refs: "builder", firstWord: "I", lastWord: "midnight.", startS: 115.78, endS: 120.86, firstIdx: 0, lastIdx: 15 },
          ],
        },
      ],
    },
    {
      id: "C007", title: "Infrastructure Gap", range: "122–143s", summary: "AI agents ranked by code, not network reliability. But software needs infrastructure.",
      words: ["This", "is", "the", "problem", "you", "don't", "anticipate", "when", "picking", "a", "tool.", "AI", "agents", "are", "ranked", "by", "benchmarks", "and", "code", "quality.", "Nobody", "ranks", "them", "by", "what", "happens", "when", "the", "network", "is", "unreliable,", "but", "they", "are", "software", "and", "software", "needs", "infrastructure.", "If", "that", "infrastructure", "is", "a", "server", "across", "the", "world", "and", "your", "connection", "is", "fragile,", "you", "have", "a", "very", "smart", "program", "that", "cannot", "finish", "a", "sentence."],
      beats: [
        {
          code: "007A", range: "122.2–132.6s", narration: "This is the problem you don't anticipate when picking a tool. AI agents are ranked by benchmarks and code quality.",
          images: [
            { id: "IMG17", what: "Giant glowing AI brain the size of a hot air balloon, suspended inside a glass server room over an ocean. A single frayed network cable dangles from it into the water below, sparking where it touches the waves. Builder stands on a tiny raft beneath, holding the severed end, looking up. The brain is brilliant, powerful, and completely unreachable.", why: "Visual metaphor for the core problem: brilliant intelligence, unreachable because of a fragile connection. The scale (giant brain, tiny raft) reinforces the absurdity.", hold: "10.4s", distinct: true, refs: "builder", firstWord: "This", lastWord: "unreliable.", startS: 122.23, endS: 132.63, firstIdx: 0, lastIdx: 32 },
          ],
        },
        {
          code: "007B", range: "133.5–143.4s", narration: "Nobody ranks them by what happens when the network is unreliable. But they're software, and software needs infrastructure.",
          images: [
            { id: "IMG18", what: "Meme-chad (clean-shaven, yellow spike hair, red OUCH! shirt) sits in a tiny lifeguard chair attached to the raft. He holds a scorecard: \"BENCHMARKS: 10/10 — CONNECTION: 0/10\". Builder looks from the scorecard to the sparking cable with flat expression.", why: "Chad adds comedic contrast. The scorecard makes the irony explicit: perfect benchmarks, zero connection. The builder's flat reaction = the deadpan punchline.", hold: "9.9s", distinct: true, refs: "builder, meme-chad", firstWord: "But", lastWord: "sentence.", startS: 133.51, endS: 143.45, firstIdx: 36, lastIdx: 63 },
          ],
        },
      ],
    },
    {
      id: "C008", title: "Looking for Local", range: "145–147s", summary: "Went looking for something that runs on my machine.",
      words: ["So", "I", "went", "looking", "for", "something", "that", "runs", "on", "my", "machine."],
      beats: [
        {
          code: "008A", range: "144.8–147.3s", narration: "So I went looking for something that runs on my machine.",
          images: [
            { id: "IMG19", what: "Builder in a dark room lit only by a laptop screen. Search query glowing: \"AI coding agent runs locally no server\". The screen shoots a beam of light across the dark room toward a distant opening. Silhouettes of remote-server-shaped monsters lurk in the shadows between builder and the light. Builder leans forward, squinting.", why: "The search moment. Transition from problem to solution. Server-monsters = the things being left behind. Beam of light = the path forward.", hold: "2.5s", distinct: true, refs: "builder", firstWord: "So", lastWord: "machine.", startS: 144.76, endS: 147.32, firstIdx: 0, lastIdx: 10 },
          ],
        },
      ],
    },
    {
      id: "C009", title: "Hermes Discovery", range: "149–156s", summary: "Found Hermes. Open-source, same category. Three differences.",
      words: ["What", "I", "found", "was", "Hermes,", "an", "open", "source", "agent", "from", "News", "Research.", "Same", "category.", "Three", "differences", "turned", "out", "to", "matter."],
      beats: [
        {
          code: "009A", range: "148.7–156.4s", narration: "What I found was Hermes, an open-source agent from Nous Research. Same category. Three differences turned out to matter.",
          images: [
            { id: "IMG20", what: "Builder kicks open a heavy vault door, light flooding in from behind the camera. Inside the vault: three pedestals on a stone floor. Left pedestal: open terminal with blinking cursor and green checkmark. Center: three glowing abstract provider shapes connected by arrows to one central hub. Right: notebook radiating warmth with a house icon on screen. Builder strides toward them, hand reaching for the terminal.", why: "The discovery. Three pedestals = the three differences about to be revealed. Vault door = something valuable found. The dramatic entrance earns the reveal.", hold: "7.7s", distinct: true, refs: "builder", firstWord: "What", lastWord: "matter.", startS: 148.65, endS: 156.37, firstIdx: 0, lastIdx: 19 },
          ],
        },
      ],
    },
    {
      id: "C010", title: "Terminal Access", range: "158–186s", summary: "First difference: sandbox vs shell. Agent directions from back seat vs driver's seat.",
      words: ["First,", "terminal", "access.", "Desktop", "agents", "run", "inside", "a", "sandbox.", "They", "can", "read", "files,", "but", "they", "cannot", "run", "commands", "or", "make", "network", "requests.", "To", "reach", "anything", "outside", "the", "file", "system,", "you", "need", "a", "separate", "bridge", "server.", "That", "is", "a", "lot", "of", "work", "just", "to", "run", "git", "push.", "Hermes", "has", "a", "shell.", "Anything", "you", "would", "type", "into", "a", "terminal,", "it", "can", "run.", "In", "a", "sandbox,", "the", "agent", "gives", "directions", "from", "the", "backseat.", "With", "a", "shell,", "it", "is", "in", "the", "driver's", "seat."],
      beats: [
        {
          code: "010A", range: "157.6–173.9s", narration: "First: terminal access. Desktop agents run inside a sandbox. They can suggest commands but they can't run them. Anything real — git push, npm install, reading a file — you need a separate bridge server. A lot of work just to run git push.",
          images: [
            { id: "IMG21", what: "Split screen, left side emphasized. A character pounds both fists against the inside of a glass box labeled SANDBOX. Outside the box, a database server, an API endpoint, and a build tool sit on shelves — bright, available, unreachable. The character's hands are pressed flat against the glass, face desperate.", why: "The sandbox problem: trapped with resources visible but unreachable. The glass box makes the barrier physical.", hold: "16.3s", distinct: true, refs: "—", firstWord: "First,", lastWord: "push.", startS: 157.64, endS: 173.94, firstIdx: 0, lastIdx: 50 },
          ],
        },
        {
          code: "010B", range: "174.9–185.7s", narration: "Hermes has a shell. Real terminal. It can read files, run commands, install packages, start servers. In a sandbox, the agent gives directions from the back seat. With a shell, it's in the driver's seat.",
          images: [
            { id: "IMG22", what: "Split screen, right side now emphasized. Builder at open terminal, hands flying across keyboard. Cables shoot out in all directions, connecting to the same database, API, and build tool with crackling energy. Small label below: \"Back seat → Driver's seat\".", why: "The shell solution. Same resources, now reachable. The \"back seat → driver's seat\" label makes the metaphor explicit.", hold: "10.8s", distinct: true, refs: "builder", firstWord: "Hermes", lastWord: "seat.", startS: 174.9, endS: 185.7, firstIdx: 55, lastIdx: 78 },
          ],
        },
      ],
    },
    {
      id: "C011", title: "Model Choice + Pricing", range: "187–217s", summary: "Second difference: model-agnostic. 87¢ vs $14. Real numbers.",
      words: ["Second,", "Model", "Choice.", "Most", "agents", "are", "locked", "to", "one", "provider.", "Hermes", "works", "with", "any", "of", "them.", "I", "switched", "to", "DeepSeek", "about", "87", "cents", "per", "million", "output", "tokens.", "The", "model", "I", "was", "using", "before", "costs", "$14", ".16", "more.", "A", "heavy", "session", "on", "the", "old", "tool,", "$30.", "Same", "session", "on", "DeepSeek,", "$2.", "Ship", "every", "day", "and", "that", "is", "900", "a", "month", "versus", "60.", "For", "someone", "building", "on", "their", "own,", "that", "difference", "is", "real."],
      beats: [
        {
          code: "011A", range: "187.0–202.7s", narration: "Second: model choice. I can use any model with an API key. I switched to DeepSeek, about eighty-seven cents per million tokens. The model I was using before costs fourteen dollars. Sixteen times more.",
          images: [
            { id: "IMG23", what: "Game-show set with two podiums under bright stage lights. Left podium: a tiny stack of three coins with label \"87¢/M\". Builder stands behind it, looking right with jaw dropped. Right podium: a coin tower so tall it goes off-frame, label \"$14/M\", with scaffolding holding it up.", why: "The price contrast. The visual scale (three coins vs tower needing scaffolding) makes the 16x difference feel physical and absurd.", hold: "15.7s", distinct: true, refs: "builder", firstWord: "Second,", lastWord: "16", startS: 186.99, endS: 202.71, firstIdx: 0, lastIdx: 42 },
          ],
        },
        {
          code: "011B", range: "202.7–216.6s", narration: "A heavy session on the old tool: thirty bucks. Same session on DeepSeek: two. Ship every day and that's nine hundred a month versus sixty. That's real.",
          images: [
            { id: "IMG24", what: "Meme-chad (clean-shaven, yellow spike hair, red OUCH! shirt) stands between the two podiums, arms confidently crossed, smug grin — clearly the game-show host. Below each podium, a digital calculator display: left shows \"$2 / session\", right shows \"$30 / session\". Builder points at the coin difference with jaw still dropped.", why: "Chad hosts the comparison — makes the price gap feel like a game-show reveal. The calculator numbers make the abstraction concrete.", hold: "13.9s", distinct: true, refs: "builder, meme-chad", firstWord: "times", lastWord: "real.", startS: 202.71, endS: 216.63, firstIdx: 43, lastIdx: 70 },
          ],
        },
      ],
    },
    {
      id: "C012", title: "Local-First", range: "218–232s", summary: "Third difference: everything on laptop. No VPS, no VPN. WiFi drops, nothing dies.",
      words: ["Third,", "it", "runs", "entirely", "on", "my", "laptop.", "No", "virtual", "private", "server,", "no", "remote", "server,", "no", "VPN.", "The", "agent,", "the", "model", "calls,", "the", "tools,", "the", "memory,", "everything", "lives", "on", "the", "machine", "in", "front", "of", "me.", "I", "lose", "Wi", "-Fi,", "nothing", "dies."],
      beats: [
        {
          code: "012A", range: "217.9–232.0s", narration: "Third: it runs entirely on my laptop. No VPS, no remote server, no VPN. The agent, the model calls, the tools, the memory — everything lives on the machine in front of me. I lose WiFi, nothing dies.",
          images: [
            { id: "IMG25", what: "Builder sits cross-legged on a mountaintop at sunrise, MacBook open on lap, screen glowing. From the screen radiate five glowing constellation lines connecting to orbiting labels: AGENT, MODEL, MEMORY, TOOLS, MCP. Each label orbits like a small moon. No server racks, no cloud icons, no VPN tunnels anywhere in the vast landscape. A tiny WiFi icon in the corner of the screen has a red X — builder doesn't even notice. Calm, in control.", why: "The freedom moment. Self-contained system as a mountaintop — vast empty landscape, everything needed is right there. The dead WiFi with no reaction is the punchline.", hold: "14.1s", distinct: true, refs: "builder", firstWord: "Third,", lastWord: "dies.", startS: 217.9, endS: 232.02, firstIdx: 0, lastIdx: 39 },
          ],
        },
      ],
    },
    {
      id: "C013", title: "MCP Bridge Test", range: "233–255s", summary: "First test: MCP server bridge. Built for Codex. Would it work with Hermes?",
      words: ["The", "first", "real", "test", "was", "the", "bridge", "to", "my", "project", "tracker.", "I", "built", "a", "small", "server", "that", "lets", "AI", "agents", "write", "directly", "to", "my", "project", "database.", "Built", "it", "for", "codecs.", "Work", "with", "another", "agent", "I", "use.", "Would", "it", "work", "with", "something", "completely", "different?", "Plug", "it", "into", "Hermes.", "Same", "config.", "Same", "protocol.", "Zero", "changes."],
      beats: [
        {
          code: "013A", range: "233.3–248.3s", narration: "The first real test was the bridge to my project tracker. I built a small server that lets AI agents write directly to my project database. Built it for Codex. Worked with another agent I use.",
          images: [
            { id: "IMG26", what: "Universal power strip labeled MCP sits center frame. Already connected: a square plug labeled \"Codex\" and a round plug labeled \"Claude Code\". On the other end of the strip, a database labeled PROJECTS glows steady green. Builder kneels beside the strip, holding a triangular plug labeled \"Hermes\", examining it — about to connect.", why: "The bridge: show the universal protocol. Two plugs already working, third about to try. The database glowing green = it's alive and waiting.", hold: "15.0s", distinct: true, refs: "builder", firstWord: "The", lastWord: "database.", startS: 233.33, endS: 240.91, firstIdx: 0, lastIdx: 25 },
          ],
        },
        {
          code: "013B", range: "249.2–255.4s", narration: "Plugged it into Hermes. Same config. Same protocol. Zero changes.",
          images: [
            { id: "IMG27", what: "Close-up: builder plugging the triangular Hermes connector into the MCP strip. A satisfying spark jumps as the connection completes. The PROJECTS database pulses brighter, green intensifying. Builder's face: relief and satisfaction.", why: "The connection moment. \"Zero changes\" made physical — plug fits, spark confirms, database brightens. The relief on builder's face is the payoff.", hold: "6.2s", distinct: true, refs: "builder", firstWord: "Dilt", lastWord: "changes.", startS: 241.85, endS: 255.43, firstIdx: 29, lastIdx: 52 },
          ],
        },
      ],
    },
    {
      id: "C014", title: "Success", range: "257–276s", summary: "One hour, four changes. Stuck video shipped. No drops.",
      words: ["Within", "an", "hour,", "I", "finished", "shipping", "the", "video", "stuck", "behind", "three", "dead", "sessions.", "Then", "another", "video", "stuck", "for", "a", "week.", "Then", "I", "fixed", "where", "videos", "were", "miscategorized", "on", "my", "project", "site.", "Then", "I", "fixed", "how", "source", "links", "display.", "For", "changes,", "one", "session.", "No", "drops.", "No", "dead", "compactions."],
      beats: [
        {
          code: "014A", range: "256.9–269.7s", narration: "Within an hour, I finished shipping the video stuck behind three dead sessions. Then another video stuck for a week. Then I fixed where videos were miscategorized. Then I fixed how source links display.",
          images: [
            { id: "IMG28", what: "Victory parade float with four giant banners, each lighting up as named. Banner 1: EPISODE 17 SHIPPED (rocket launching). Banner 2: DEV-LOG SHIPPED (film reel spinning). Banner 3: CATEGORIES FIXED (puzzle piece clicking in). Banner 4: LINKS FIXED (chain links connecting). Builder stands on the float platform, watching each banner light up.", why: "Four wins visualized as celebration floats. Each banner activates as the narration names it — the viewer tracks the count.", hold: "12.8s", distinct: true, refs: "builder", firstWord: "Within", lastWord: "fixed", startS: 256.89, endS: 264.49, firstIdx: 0, lastIdx: 25 },
          ],
        },
        {
          code: "014B", range: "270.6–275.6s", narration: "Four changes, one session. No drops. No dead compactions.",
          images: [
            { id: "IMG29", what: "Builder riding on top of the float, arms raised, confetti raining down from above. All four banners fully lit and glowing. No finish line flag anywhere — just forward momentum. Pure celebration.", why: "The payoff: builder celebrating, confetti, no finish line. Forward momentum, not completion. The emotional peak of the video.", hold: "5.0s", distinct: true, refs: "builder", firstWord: "where", lastWord: "compactions.", startS: 264.49, endS: 275.61, firstIdx: 26, lastIdx: 46 },
          ],
        },
      ],
    },
    {
      id: "C015", title: "The Lesson", range: "277–296s", summary: "Not that Hermes is better. Models are comparable. Difference is access.",
      words: ["Here's", "what", "I", "actually", "learned.", "It", "is", "not", "that", "Hermes", "is", "better", "than", "Codex.", "The", "models", "are", "comparable.", "The", "difference", "is", "what", "the", "model", "is", "allowed", "to", "do.", "Put", "any", "of", "these", "systems", "in", "a", "sandbox", "with", "no", "terminal", "and", "no", "network,", "and", "you", "get", "a", "knowledgeable", "chatbot.", "Give", "them", "the", "keys", "to", "the", "machine,", "and", "they", "can", "actually", "build."],
      beats: [
        {
          code: "015A", range: "276.9–283.7s", narration: "Here's what I actually learned. It's not that Hermes is better than Codex. The models are comparable.",
          images: [
            { id: "IMG30", what: "Two identical glowing brains sit side by side on a stone table. Left brain has a glass dome lowered over it, label: CODEX. Right brain has no dome, label: HERMES. Both glow with the same intensity. A set of keys on a steel ring sits on the table between them. Builder stands behind the table, one hand on each pedestal, looking directly at the viewer.", why: "The comparison: same intelligence, different access. The glass dome vs open air is the entire thesis in one image. Builder looking at viewer = \"here's what I actually learned.\"", hold: "6.8s", distinct: true, refs: "builder", firstWord: "Here", lastWord: "comparable.", startS: 276.95, endS: 283.73, firstIdx: 0, lastIdx: 23 },
          ],
        },
        {
          code: "015B", range: "284.6–296.0s", narration: "split into 2 visual moments:",
          images: [
            { id: "IMG31", what: "Same scene, but action: the glass dome is now fully lowered over the CODEX brain. A hand (builder's) picks up the key ring from the table and places it next to the HERMES brain. The HERMES brain glows slightly brighter. An arrow graphic traces from the keys to the brain, with the word \"ACCESS\" along the arrow.", why: "\"The difference is what the model is allowed to do. Put any of these systems in a sandbox, you get a knowledgeable chatbot.\" — the transfer: keys move from center to Hermes. The dome lowering = the sandbox closing.", hold: "5.5s", distinct: true, refs: "builder", firstWord: "The", lastWord: "terminal", startS: 284.65, endS: 290.05, firstIdx: 28, lastIdx: 47 },
            { id: "IMG32", what: "Wide shot: the table now. CODEX brain trapped under dome, glowing dimly. HERMES brain with keys beside it, glowing bright. Builder has stepped back from the table, arms crossed, looking at both. The choice is clear.", why: "\"Give them the keys to the machine, and they can actually build.\" — the wide shot shows the full contrast. The viewer can compare both states simultaneously. Builder's crossed arms = this isn't a question anymore.", hold: "5.9s", distinct: true, refs: "builder", firstWord: "and", lastWord: "build.", startS: 290.05, endS: 296.01, firstIdx: 47, lastIdx: 59 },
          ],
        },
      ],
    },
    {
      id: "C016", title: "Closing Thesis", range: "297–301s", summary: "The harness matters as much as the model. Maybe more.",
      words: ["The", "harness", "matters", "as", "much", "as", "the", "model.", "Maybe", "more."],
      beats: [
        {
          code: "016A", range: "297.4–300.9s", narration: "The harness matters as much as the model. Maybe more.",
          images: [
            { id: "IMG33", what: "Builder walking away from camera down a long road at golden hour. Over one shoulder: a laptop bag. In one hand: a single key, glinting in the sunset light. Far behind in the distance: a giant glass cage sits empty and shattered. No text. No labels. Just the road, the key, and the broken cage fading into the background.", why: "The closing thesis. Walking away = moving forward. Key in hand = owns the access now. Shattered cage behind = the sandbox is broken and left behind. Golden hour = earned optimism. No text = the image speaks.", hold: "3.5s", distinct: true, refs: "builder", firstWord: "The", lastWord: "more.", startS: 297.35, endS: 300.87, firstIdx: 0, lastIdx: 9 },
          ],
        },
      ],
    },
  ],
  overlays: [
    { id: "R01", trigger: "sixteen times more", image: "Price-check double-take GIF (shocked face zoom)", dur: "2.0s", placement: "Centered", anchor: "IMG23", chunk: "C011", firstIdx: 35, lastIdx: 37 },
    { id: "R02", trigger: "Four changes, one session", image: "Victory celebration GIF (confetti burst)", dur: "2.5s", placement: "Centered", anchor: "IMG29", chunk: "C014", firstIdx: 38, lastIdx: 42 },
  ],
}

type VPPlan = typeof visualPacingPlan
type VPEditDraft = {
  scope: 'image' | 'chunk'
  chunkId: string
  imageId?: string
  afterChunkId?: string
  beforeChunkId?: string
  nearImageId?: string
  insertPos?: 'before' | 'after'
  isNew: boolean
  what: string
  why: string
  hold: string
  refs: string
  title: string
  range: string
  idea: string
}

function VisualPacingPanel({ blankProject }: { blankProject: boolean }) {
  const [plan, setPlan] = useState<VPPlan>(() => structuredClone(visualPacingPlan))
  const [history, setHistory] = useState<VPPlan[]>([])
  const [menu, setMenu] = useState<{ x: number; y: number; chunkId: string; imageId?: string } | null>(null)
  const [editing, setEditing] = useState<VPEditDraft | null>(null)
  const [aiBusy, setAiBusy] = useState(false)
  const [view, setView] = useState<'table' | 'script'>('table')
  const seqImg = useRef(visualPacingPlan.chunks.reduce((n, c) => n + c.beats.reduce((m, b) => m + b.images.length, 0), 0))
  const seqChunk = useRef(visualPacingPlan.chunks.length)
  // When an edit session opens (from the timeline or the breakdown), scroll the
  // editor into view — the breakdown rows can be far below the editor's spot.
  const editKey = editing ? `${editing.scope}:${editing.imageId ?? editing.chunkId}:${editing.isNew}` : ''
  useEffect(() => {
    if (editKey) document.querySelector('.vp-edit')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [editKey])

  // Flatten to a timeline: each image laid end-to-end, width ∝ its hold time, so
  // every block boundary is a visual change. Each block carries its chunk + beat
  // context so hovering it can scrub the full moment into the detail strip.
  let cursor = 0
  const images = plan.chunks.flatMap((chunk) =>
    chunk.beats.flatMap((beat) =>
      beat.images.map((img) => {
        const holdSec = parseInt(img.hold, 10) || 0
        const start = cursor
        cursor += holdSec
        return { ...img, chunk: chunk.id, chunkTitle: chunk.title, narration: beat.narration, beatRange: beat.range, holdSec, start }
      }),
    ),
  )
  const totalSec = cursor || 1
  const [activeId, setActiveId] = useState(images[0]?.id ?? '')

  if (blankProject) {
    return (
      <div className="stub vp-empty">
        <span>VP</span>
        <h3>No pacing plan yet</h3>
        <p>
          Once the screenplay is locked, the visual pacing pass maps every narration beat to an image —
          what the viewer sees, why it appears then, and how long it holds — before the shot-list is built.
        </p>
        <div className="vp-stats empty">
          <span><b>—</b> images</span>
          <span><b>—</b> opening</span>
          <span><b>—</b> body</span>
          <span><b>—</b> overlays</span>
        </div>
      </div>
    )
  }

  const pct = (sec: number) => (sec / totalSec) * 100
  const active = images.find((img) => img.id === activeId) ?? images[0]
  // Group consecutive images into their chunk spans for the ruler.
  const chunkSpans = plan.chunks.map((chunk) => {
    const imgs = images.filter((img) => img.chunk === chunk.id)
    const start = imgs[0]?.start ?? 0
    const last = imgs[imgs.length - 1]
    return { id: chunk.id, title: chunk.title, start, end: (last?.start ?? 0) + (last?.holdSec ?? 0) }
  })
  // The dense "opening" band covers the first N images (per the plan's count).
  const openImg = images[plan.opening - 1]
  const openingEnd = openImg ? openImg.start + openImg.holdSec : 0
  // Place each overlay centered over the image it triggers on — the layer on top.
  const overlayMarks = plan.overlays
    .map((r) => {
      const host = images.find((img) => img.id === r.anchor)
      return host ? { ...r, center: host.start + host.holdSec / 2 } : null
    })
    .filter(Boolean) as (VPOverlay & { center: number })[]
  const ticks: number[] = []
  for (let s = 0; s <= totalSec; s += 60) ticks.push(s)
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`

  // --- editing operations (in-session only; mock app has no backend) ---
  // Every mutation snapshots the prior plan so Undo can step back through edits.
  const mutate = (updater: (p: VPPlan) => VPPlan) => {
    setHistory((h) => [...h, plan].slice(-50))
    setPlan(updater(plan))
  }
  const undo = () => {
    if (history.length === 0) return
    setPlan(history[history.length - 1])
    setHistory((h) => h.slice(0, -1))
    setEditing(null)
    setMenu(null)
  }
  const openMenu = (e: React.MouseEvent, m: { chunkId: string; imageId?: string }) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, ...m })
  }
  const startEditImage = (chunkId: string, imageId: string) => {
    const img = images.find((i) => i.id === imageId)
    if (img) setEditing({ scope: 'image', chunkId, imageId, isNew: false, what: img.what, why: img.why, hold: img.hold, refs: img.refs, title: '', range: '', idea: '' })
    setMenu(null)
  }
  const startEditChunk = (chunkId: string) => {
    const chunk = plan.chunks.find((c) => c.id === chunkId)
    if (chunk) setEditing({ scope: 'chunk', chunkId, isNew: false, what: '', why: '', hold: '', refs: '', title: chunk.title, range: chunk.range, idea: '' })
    setMenu(null)
  }
  const startAddImage = (chunkId: string, opts?: { nearImageId?: string; pos?: 'before' | 'after' }) => {
    const id = `IMG${String(++seqImg.current).padStart(2, '0')}`
    setEditing({ scope: 'image', chunkId, imageId: id, nearImageId: opts?.nearImageId, insertPos: opts?.pos, isNew: true, what: '', why: '', hold: '6s', refs: 'builder', title: '', range: '', idea: '' })
    setMenu(null)
  }
  const startAddChunk = (refChunkId: string, pos: 'before' | 'after') => {
    const id = `C${String(++seqChunk.current).padStart(3, '0')}`
    setEditing({
      scope: 'chunk',
      chunkId: id,
      afterChunkId: pos === 'after' ? refChunkId : undefined,
      beforeChunkId: pos === 'before' ? refChunkId : undefined,
      isNew: true,
      what: '', why: '', hold: '', refs: '', title: '', range: '', idea: '',
    })
    setMenu(null)
  }
  const removeImage = (chunkId: string, imageId: string) => {
    mutate((p) => ({
      ...p,
      chunks: p.chunks.map((c) =>
        c.id !== chunkId ? c : { ...c, beats: c.beats.map((b) => ({ ...b, images: b.images.filter((im) => im.id !== imageId) })).filter((b) => b.images.length > 0) },
      ),
      overlays: p.overlays.filter((r) => r.anchor !== imageId),
    }))
    setMenu(null)
  }
  const removeChunk = (chunkId: string) => {
    const gone = new Set(plan.chunks.find((c) => c.id === chunkId)?.beats.flatMap((b) => b.images.map((im) => im.id)) ?? [])
    mutate((p) => ({ ...p, chunks: p.chunks.filter((c) => c.id !== chunkId), overlays: p.overlays.filter((r) => !gone.has(r.anchor)) }))
    setMenu(null)
  }
  const saveEdit = () => {
    if (!editing) return
    const d = editing
    if (d.scope === 'image') {
      const next = { id: d.imageId!, what: d.what || 'New visual — describe it.', why: d.why, hold: d.hold || '6s', distinct: true, refs: d.refs, firstWord: '', lastWord: '', startS: 0, endS: 0, firstIdx: 0, lastIdx: 0 }
      mutate((p) => ({
        ...p,
        chunks: p.chunks.map((c) => {
          if (c.id !== d.chunkId) return c
          if (d.isNew) {
            if (d.nearImageId) {
              return {
                ...c,
                beats: c.beats.map((b) => {
                  const idx = b.images.findIndex((im) => im.id === d.nearImageId)
                  if (idx < 0) return b
                  const imgs = [...b.images]
                  imgs.splice(d.insertPos === 'before' ? idx : idx + 1, 0, next)
                  return { ...b, images: imgs }
                }),
              }
            }
            const beats = c.beats.length
              ? c.beats.map((b, i) => (i === c.beats.length - 1 ? { ...b, images: [...b.images, next] } : b))
              : [{ code: `${c.id}A`, range: c.range, narration: d.idea || '(new beat)', images: [next] }]
            return { ...c, beats }
          }
          return { ...c, beats: c.beats.map((b) => ({ ...b, images: b.images.map((im) => (im.id === d.imageId ? next : im)) })) }
        }),
      }))
      setActiveId(d.imageId!)
    } else if (d.isNew) {
      const seed = { id: `IMG${String(++seqImg.current).padStart(2, '0')}`, what: 'New visual — right-click it to edit.', why: '', hold: '6s', distinct: true, refs: '', firstWord: '', lastWord: '', startS: 0, endS: 0, firstIdx: 0, lastIdx: 0 }
      const newChunk = { id: d.chunkId, title: d.title || 'New chunk', range: d.range, summary: d.idea || '', words: [] as string[], beats: [{ code: `${d.chunkId}A`, range: d.range, narration: d.idea || '(describe this beat)', images: [seed] }] }
      mutate((p) => {
        const chunks = [...p.chunks]
        let at = chunks.length
        if (d.beforeChunkId) {
          const bi = chunks.findIndex((c) => c.id === d.beforeChunkId)
          if (bi >= 0) at = bi
        } else if (d.afterChunkId) {
          const ai = chunks.findIndex((c) => c.id === d.afterChunkId)
          if (ai >= 0) at = ai + 1
        }
        chunks.splice(at, 0, newChunk)
        return { ...p, chunks }
      })
      setActiveId(seed.id)
    } else {
      mutate((p) => ({ ...p, chunks: p.chunks.map((c) => (c.id === d.chunkId ? { ...c, title: d.title, range: d.range } : c)) }))
    }
    setEditing(null)
  }
  const aiFill = () => {
    if (!editing) return
    setAiBusy(true)
    const idea = editing.idea.trim()
    const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)
    window.setTimeout(() => {
      setEditing((e) => {
        if (!e) return e
        if (e.scope === 'image')
          return {
            ...e,
            what: `${idea ? cap(idea) : 'A new visual moment'} — staged in the ${plan.style} style: builder mid-frame, bold flat color, one clear focal action.`,
            why: `Reinforces ${idea ? `“${idea}”` : 'this beat'} at the cut; distinct from the previous image and readable in about ${e.hold || '6s'}.`,
          }
        return { ...e, title: idea ? cap(idea).slice(0, 40) : 'New chunk' }
      })
      setAiBusy(false)
    }, 700)
  }
  const setDraft = (patch: Partial<VPEditDraft>) => setEditing((d) => (d ? { ...d, ...patch } : d))

  return (
    <div className="vp panel-flat">
      <div className="ch">
        <h3>Visual pacing — {plan.chunks.length} chunks · {images.length} images</h3>
        <span>working/visual-pacing-plan.md</span>
      </div>

      <div className="vp-stats">
        <span><b>{images.length}</b> images</span>
        <span><b>{plan.opening}</b> opening</span>
        <span><b>{plan.body}</b> body</span>
        <span><b>{plan.overlays.length}</b> overlays</span>
        <span><b>{plan.chunks.length}</b> chunks</span>
        <b>{plan.runtime} · {plan.style}</b>
      </div>

      <div className="vp-timeline">
        <div className="vp-tl-row">
          <span className="vp-tl-label">Chunks</span>
          <div className="vp-tl-track ruler">
            {chunkSpans.map((c, i) => (
              <div
                key={c.id}
                className={`vp-ruler-seg ${i % 2 ? 'alt' : ''} ${active && active.chunk === c.id ? 'on' : ''}`}
                style={{ left: `${pct(c.start)}%`, width: `${pct(c.end - c.start)}%` }}
                title={`${c.id} · ${c.title} — right-click to edit`}
                onContextMenu={(e) => openMenu(e, { chunkId: c.id, imageId: images.find((i) => i.chunk === c.id)?.id })}
              >
                <span>{c.id}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="vp-tl-row">
          <span className="vp-tl-label">Visuals</span>
          <div className="vp-tl-track visuals">
            <div className="vp-opening-band" style={{ width: `${pct(openingEnd)}%` }}>
              <span>opening · dense</span>
            </div>
            {images.map((img) => (
              <button
                type="button"
                key={img.id}
                className={`vp-seg ${img.id === activeId ? 'on' : ''}`}
                style={{ left: `${pct(img.start)}%`, width: `${pct(img.holdSec)}%` }}
                onMouseEnter={() => setActiveId(img.id)}
                onFocus={() => setActiveId(img.id)}
                onContextMenu={(e) => openMenu(e, { chunkId: img.chunk, imageId: img.id })}
                title={`${img.id} · ${img.hold} — right-click to edit`}
              >
                <span>{img.id}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="vp-tl-row">
          <span className="vp-tl-label">Overlays</span>
          <div className="vp-tl-track overlays">
            {overlayMarks.length === 0 ? <span className="vp-tl-empty">none</span> : null}
            {overlayMarks.map((r) => (
              <div
                key={r.id}
                className="vp-overlay-mark"
                style={{ left: `${pct(r.center)}%` }}
                title={`${r.id} · "${r.trigger}" · ${r.dur} · ${r.image}`}
              >
                {r.id} · {r.dur}
              </div>
            ))}
          </div>
        </div>

        <div className="vp-tl-row axis">
          <span className="vp-tl-label" />
          <div className="vp-tl-track">
            {ticks.map((t) => (
              <span key={t} className="vp-tick" style={{ left: `${pct(t)}%` }}>{fmt(t)}</span>
            ))}
            <span className="vp-tick end" style={{ left: '100%' }}>{fmt(totalSec)}</span>
          </div>
        </div>
      </div>

      <div className="vp-hintbar">
        <p className="vp-hint">Hover a block to inspect · right-click a block or chunk to edit, add, or remove</p>
        <button type="button" className="vp-undo" onClick={undo} disabled={history.length === 0}>
          ↶ Undo{history.length ? ` (${history.length})` : ''}
        </button>
      </div>

      {editing ? (
        <div className="vp-edit">
          <div className="vp-edit-head">
            <span className="id">{editing.scope === 'image' ? editing.imageId : editing.chunkId}</span>
            <b>{editing.isNew ? 'New' : 'Editing'} {editing.scope}</b>
            {editing.scope === 'image' ? <span className="vp-active-hold">in {editing.chunkId}</span> : null}
          </div>

          {editing.scope === 'chunk' ? (
            <div className="vp-edit-grid">
              <label>Title<input value={editing.title} onChange={(e) => setDraft({ title: e.target.value })} placeholder="Scene title" /></label>
              <label>Time range<input value={editing.range} onChange={(e) => setDraft({ range: e.target.value })} placeholder="e.g. 25–48s" /></label>
            </div>
          ) : (
            <>
              <label className="vp-edit-field">What the viewer sees
                <textarea rows={3} value={editing.what} onChange={(e) => setDraft({ what: e.target.value })} placeholder="Describe the on-screen visual…" />
              </label>
              <label className="vp-edit-field">Why now
                <textarea rows={2} value={editing.why} onChange={(e) => setDraft({ why: e.target.value })} placeholder="Why this image at this beat…" />
              </label>
              <div className="vp-edit-grid">
                <label>Hold<input value={editing.hold} onChange={(e) => setDraft({ hold: e.target.value })} placeholder="6s" /></label>
                <label>References<input value={editing.refs} onChange={(e) => setDraft({ refs: e.target.value })} placeholder="builder, meme-chad" /></label>
              </div>
            </>
          )}

          <div className="vp-ai">
            <input className="vp-ai-input" value={editing.idea} onChange={(e) => setDraft({ idea: e.target.value })} placeholder="…or write an idea and let AI draft it" />
            <button type="button" className="vp-ai-btn" onClick={aiFill} disabled={aiBusy}>{aiBusy ? 'Drafting…' : '✨ AI fill'}</button>
          </div>

          <div className="vp-edit-actions">
            <button type="button" className="vp-save" onClick={saveEdit}>Save</button>
            <button type="button" className="vp-cancel" onClick={() => setEditing(null)}>Cancel</button>
            <span className="vp-edit-note">Mock editor — changes stay in this session</span>
          </div>
        </div>
      ) : null}

      {menu ? (
        <>
          <div className="vp-menu-backdrop" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null) }} />
          <div className="vp-menu" style={{ left: menu.x, top: menu.y }}>
            <div className="vp-menu-h">{menu.imageId ? `${menu.imageId} · ` : ''}{menu.chunkId}</div>
            <button type="button" onClick={() => startEditImage(menu.chunkId, menu.imageId!)}>Edit image</button>
            <button type="button" onClick={() => startAddImage(menu.chunkId, { nearImageId: menu.imageId, pos: 'before' })}>Add image before</button>
            <button type="button" onClick={() => startAddImage(menu.chunkId, { nearImageId: menu.imageId, pos: 'after' })}>Add image after</button>
            <button type="button" className="danger" onClick={() => removeImage(menu.chunkId, menu.imageId!)}>Remove image</button>
            <div className="vp-menu-div" />
            <button type="button" onClick={() => startEditChunk(menu.chunkId)}>Edit chunk</button>
            <button type="button" onClick={() => startAddChunk(menu.chunkId, 'before')}>Add chunk before</button>
            <button type="button" onClick={() => startAddChunk(menu.chunkId, 'after')}>Add chunk after</button>
            <button type="button" className="danger" onClick={() => removeChunk(menu.chunkId)}>Remove chunk</button>
          </div>
        </>
      ) : null}

      <div className="vp-viewbar">
        <h4 className="vp-sub-h">Pacing</h4>
        <div className="vp-viewtoggle">
          <button type="button" className={view === 'table' ? 'on' : ''} onClick={() => setView('table')}>Table</button>
          <button type="button" className={view === 'script' ? 'on' : ''} onClick={() => setView('script')}>Script</button>
        </div>
      </div>

      {view === 'table' ? (
        <div className="table-wrap">
          <table className="shots vp-pacing">
            <thead>
              <tr><th>Start</th><th>Img</th><th>Chunk</th><th>Visual</th><th>Hold</th><th></th></tr>
            </thead>
            <tbody>
              {images.map((img) => (
                <tr key={img.id} className={img.id === activeId ? 'on' : ''} onMouseEnter={() => setActiveId(img.id)}>
                  <td className="vp-mono">{fmt(img.start)}</td>
                  <td><span className="id">{img.id}</span></td>
                  <td><span className="id">{img.chunk}</span></td>
                  <td>{img.what}</td>
                  <td className="vp-mono">{img.hold}</td>
                  <td className="vp-row-cell"><button type="button" className="vp-row-menu" onClick={(e) => openMenu(e, { chunkId: img.chunk, imageId: img.id })} title="Actions">⋯</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="vp-script">
          {plan.chunks.map((chunk) => {
            const cimgs = chunk.beats.flatMap((b) => b.images)
            return (
              <p className="vp-script-chunk" key={chunk.id}>
                <span className="vp-script-cid">{chunk.id}</span>
                {chunk.words.map((w, i) => {
                  const owner = cimgs.find((im) => i >= im.firstIdx && i <= im.lastIdx)
                  const ov = plan.overlays.find((o) => o.chunk === chunk.id && i >= o.firstIdx && i <= o.lastIdx)
                  const cls = ['vp-w']
                  if (owner) cls.push('img')
                  if (owner && owner.id === activeId) cls.push('on')
                  if (ov) cls.push('ov')
                  return (
                    <span key={i}>
                      {owner && i === owner.firstIdx ? <span className="vp-w-tag" title={owner.what}>{owner.id}</span> : null}
                      {ov && i === ov.firstIdx ? <span className="vp-w-tag ovtag" title={ov.image}>{ov.id}</span> : null}
                      <span
                        className={cls.join(' ')}
                        onMouseEnter={owner ? () => setActiveId(owner.id) : undefined}
                        onClick={owner ? (e) => openMenu(e, { chunkId: chunk.id, imageId: owner.id }) : undefined}
                      >{w}</span>{' '}
                    </span>
                  )
                })}
              </p>
            )
          })}
        </div>
      )}

      <details className="vp-section">
        <summary className="vp-section-sum"><span className="vp-sec-title">Overlays</span><span className="vp-section-count">{plan.overlays.length}</span></summary>
        <div className="table-wrap">
          <table className="shots vp-table">
            <thead>
              <tr><th>ID</th><th>Trigger</th><th>Overlay</th><th>Duration</th><th>Placement</th></tr>
            </thead>
            <tbody>
              {plan.overlays.map((r) => (
                <tr key={r.id}>
                  <td><span className="id">{r.id}</span></td>
                  <td className="narr">"{r.trigger}"</td>
                  <td>{r.image}</td>
                  <td>{r.dur}</td>
                  <td>{r.placement}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  )
}

function WorldKitPanel({
  castData,
  showName,
  onManage,
  compact = false,
}: {
  castData: (typeof castByShow)['spoolcast dev log']
  showName: string
  onManage?: () => void
  compact?: boolean
}) {
  const [scopes, setScopes] = useState<Record<string, string>>(() =>
    Object.fromEntries(WORLD_KIT_SECTIONS.map((s) => [s.id, s.scope])),
  )
  // the format template (series pipeline), NOT the visual style
  const templateName = FORMAT_TEMPLATE_NAMES[showName] ?? 'format template'
  const scopeLabels: Record<string, string> = {
    Episode: 'Episode only',
    Show: `Show: ${showName}`,
    Template: `Template: ${templateName}`,
  }
  return (
    <div className="wk-panel">
      <div className="wk-note">
        <span>
          Source of truth: <code>working/world-kit.md</code> · Cast manifest: <code>cast.txt</code>
        </span>
        <span className="wk-flex">Each beat pulls whatever references it needs — there's no fixed recipe.</span>
      </div>
      <div className="wk-grid">
        {WORLD_KIT_SECTIONS.map((sec) => (
          <div className={`wk-card ${sec.locked ? 'wk-card-locked' : ''}`} key={sec.id}>
            <div className="wk-card-head">
              <div className="wk-card-meta">
                <h3>{sec.name}</h3>
                <p>{sec.desc}</p>
              </div>
              {sec.locked ? (
                <span className="wk-locked-tag">Step 01</span>
              ) : (
                <label className="wk-scope" title="Where this reference can be reused">
                  <span>Share</span>
                  <select
                    value={scopes[sec.id]}
                    onChange={(e) => setScopes((p) => ({ ...p, [sec.id]: e.target.value }))}
                  >
                    {WORLD_KIT_SCOPES.map((o) => (
                      <option key={o} value={o}>{scopeLabels[o]}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            {sec.locked ? (
              sec.image ? (
                <div className="wk-style">
                  <img src={sec.image} alt="" />
                  <span>{sec.caption}</span>
                </div>
              ) : (
                <div className="wk-empty">No style reference set</div>
              )
            ) : sec.cast ? (
              <>
                <CastGrid castData={castData} compact={compact} />
                {onManage ? (
                  <button className="wk-manage" onClick={onManage}>Manage cast →</button>
                ) : null}
              </>
            ) : (
              <div className="wk-items">
                {sec.items?.map((it) => (
                  <span className="wk-item" key={it}>{it}</span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function WorldKitView({
  castData,
  showName,
}: {
  castData: (typeof castByShow)['spoolcast dev log']
  showName: string
}) {
  const navigate = useNavigate()
  const params = useParams()
  return (
    <section className="cast-view">
      <div className="cast-wrap">
        <div className="cast-head">
          <button className="back-btn" onClick={() => navigate(`/p/${params.id ?? 'dev-log-06'}`)}>←</button>
          <div>
            <div className="eyebrow">World Kit · {showName}</div>
            <div className="title-row">
              <h1>Visual references for this episode</h1>
              <button>+ New reference</button>
            </div>
            <p>Style, cast, environments, props, screens, motion, and beat-specific refs — each with its own reuse scope. Style library: {castData.style}.</p>
          </div>
        </div>
        <WorldKitPanel castData={castData} showName={showName} />
      </div>
    </section>
  )
}

export default App
