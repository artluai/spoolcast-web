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
import illContract from './contracts/illustration-chunk-remotion.json'
import newsContract from './contracts/news-anime-bot.json'

type Status = 'done' | 'work' | 'later'
type GateType = 'human' | 'token' | 'audit'
type GateState =
  | 'approved'
  | 'awaiting'
  | 'consumed'
  | 'not-yet'
  | 'passed'
  | 'failed'
  | 'pending'

type StageContract = {
  id: string
  label: string
  requires_approval?: boolean
  gate?: string
}

type Step = {
  id: string
  sourceId?: string
  num: string
  name: string
  blurb: string
  status: Status
  x: number
  y: number
  progress?: { done: number; total: number }
  optional?: boolean
  blockedBy?: string
}

type Gate = {
  id: string
  type: GateType
  step: string
  pos: 'before' | 'after'
  label: string
  state: GateState
  source: string
}

type SetupMode = 'series' | 'standalone'
type ChatState = 'closed' | 'floating' | 'pinned'
type ChatTab = 'chat' | 'history'

// assets are mirrored from the spoolcast-content repo into public/content/ so
// they ship with the build (the old /@fs/… path only worked in the dev server)
const asset = (path: string) => `/content/${path}`

const styleThumbs = [
  {
    id: 'wojak',
    name: 'Wojak',
    img: asset('styles/wojak-comic/references/chad.png'),
    narratorOnly: true,
  },
  {
    id: 'anime',
    name: 'Anime',
    img: asset('shows/news-anime-bot/characters/musk.png'),
    narratorOnly: true,
  },
  { id: 'realistic', name: 'Photoreal' },
  { id: 'handdrawn', name: 'Hand-drawn', narratorOnly: true },
  { id: 'mocku', name: 'Mockumentary' },
  { id: 'custom', name: 'Make my own', badge: 'CUSTOM' },
]

const castByShow = {
  'spoolcast dev log': {
    style: 'wojak-gpt2',
    chars: [
      {
        ref: 'builder',
        name: 'The builder',
        role: 'Hooded mid-wojak narrator. First-person voice. Doomer-leaning early, neutral late.',
        img: asset(
          'sessions/spoolcast-dev-log-06/source/generated-assets/scenes/C29.png',
        ),
        episodes: 6,
        lastUsed: 'Dev Log #06',
      },
      {
        ref: 'ai-figure',
        name: 'The AI',
        role: 'Cracked-face wojak with AI ink-stamp forehead. Cream hoodie. Flat-affect throughout.',
        img: asset('styles/wojak-gpt2/references/ai-figure.png'),
        episodes: 6,
        lastUsed: 'Dev Log #06',
      },
      {
        ref: 'meme-chad',
        name: 'Chad',
        role: 'Locked meme-chad reference. Confident-mode contrast beats, thumbs-up reactions, and when the script wants a chad-mode insert.',
        img: asset('styles/wojak-comic/references/chad.png'),
        episodes: 3,
        lastUsed: 'Dev Log #09',
      },
    ],
  },
  'faux7-news': {
    style: 'anime / nano-banana',
    chars: [
      {
        ref: 'musk',
        name: 'Musk',
        role: 'Recurring foil. Edgy reaction shots.',
        img: asset('shows/news-anime-bot/characters/musk.png'),
        episodes: 4,
        lastUsed: '2026-05-14',
      },
      {
        ref: 'altman',
        name: 'Altman',
        role: 'Lab-coat tech founder register.',
        img: asset('shows/news-anime-bot/characters/altman.png'),
        episodes: 5,
        lastUsed: '2026-05-14',
      },
      {
        ref: 'huang',
        name: 'Huang',
        role: 'Leather-jacket platform-vendor register.',
        img: asset('shows/news-anime-bot/characters/huang.png'),
        episodes: 3,
        lastUsed: '2026-05-09',
      },
    ],
  },
}

const shots = [
  ['C01', 'Cold open', 'Hero shot of editor with terminal output overlay.', '0:06', 'ok'],
  ['C02', 'Problem framing', 'Diagram of the three bottlenecks.', '0:08', 'ok'],
  ['C03', 'Issue 1', 'Waveform expanding sequentially across timeline.', '0:07', 'ok'],
  ['C04', 'Issue 2', 'Loading bar repeatedly resetting to zero.', '0:06', 'ok'],
  ['C05', 'Issue 3', 'Network graph with a glowing hallucinated edge.', '0:07', 'ok'],
  ['C06', 'Solution intro', 'Schematic of the contract structure.', '0:09', 'ok'],
  ['C07', 'Implementation', 'Stage diagram with status indicators lighting up.', '0:08', 'ok'],
  ['C08', 'Render path', 'Two parallel tracks merging into a render node.', '0:07', 'ok'],
  ['C09', 'Audit demo', 'Magnifier scanning a JSON audit report.', '0:08', 'ok'],
  ['C10', 'Approval gates', 'Approval ledger with timestamps and notes.', '0:07', 'ok'],
  ['C11', 'Mobile branch', 'Branching node tree, mobile path dashed.', '0:07', 'ok'],
  ['C12', 'Job runner', 'Terminal showing tailed log lines.', '0:06', 'ok'],
  ['C13', 'UI direction', 'Node graph with disabled-action affordances.', '0:08', 'ok'],
  ['C14', 'Cast handling', 'Character grid with selection state.', '0:08', 'ok'],
  ['C15', 'Build path', 'Remotion timeline composing layers.', '0:07', 'work'],
  ['C16', 'Audit sentinel', 'File-system tree with a green sentinel marker.', '0:06', 'pend'],
  ['C17', 'Caption pass', 'SRT file scrolling alongside thumbnail preview.', '0:06', 'pend'],
  ['C18', 'Mobile crop', '16:9 frame collapsing into 9:16 with subject lock.', '0:08', 'pend'],
  ['C19', 'Cost summary', 'Cost breakdown chart.', '0:07', 'pend'],
  ['C20', 'Lessons learned', 'Highlighted action list with disabled siblings.', '0:08', 'pend'],
  ['C21', "What's next", 'Sketch of the upcoming UI mockup.', '0:07', 'pend'],
  ['C22', 'Outro', 'End card with channel handle.', '0:09', 'pend'],
] as const

const sceneFiles = [
  'C1.png',
  'C2.png',
  'C10.png',
  'C11.png',
  'C12.png',
  'C13.png',
  'C15.png',
  'C16.png',
  'C20.png',
  'C21.png',
  'C22.png',
  'C26.png',
  'C30.png',
  'C31.png',
]

const outline = [
  ['01', 'Cold open', 'Hook with the central tension.'],
  ['02', 'Problem framing', 'Name the three constraints.'],
  ['03', 'Issue 1', 'Audio rendering serialized everything.'],
  ['04', 'Issue 2', 'Render pass had no caching.'],
  ['05', 'Issue 3', 'API surface drifted from the contract.'],
  ['06', 'Solution intro', 'Contract-locked workflow node.'],
  ['07', 'Implementation', 'Each stage names a status word.'],
  ['08', 'Render path', 'Parallel audio + visual generation.'],
  ['09', 'Audit demo', 'A failed gate bounces flow back.'],
  ['10', 'Approval gates', 'Human sign-off on three steps.'],
  ['11', 'Mobile branch', 'Vertical cut is optional.'],
  ['12', 'Outro', 'Close with the contract excerpt.'],
] as const

const stepAlias: Record<string, { id: string; name: string; blurb: string }> = {
  format_setup: {
    id: 'setup',
    name: 'Project setup',
    blurb: 'Project name, visual style, and budget.',
  },
  input_intake: {
    id: 'idea',
    name: 'Video idea',
    blurb: 'What the video is about, plus notes and references.',
  },
  story_lock: {
    id: 'goal',
    name: 'Core message',
    blurb: 'Lock the single-sentence angle before scripting.',
  },
  structure: {
    id: 'plan',
    name: 'Structure outline',
    blurb: 'High-level structural arc.',
  },
  screenplay_plan: {
    id: 'script',
    name: 'Screenplay',
    blurb: 'First narration draft.',
  },
  production_units: {
    id: 'shots',
    name: 'Storyboard',
    blurb: 'Visual breakdown of the script.',
  },
  narration_audio: {
    id: 'voice',
    name: 'Narration audio',
    blurb: 'Synthesized narration from the script.',
  },
  visual_assets: {
    id: 'pics',
    name: 'Visual generation',
    blurb: 'AI-rendered visuals for each shot.',
  },
  asset_audit: {
    id: 'check',
    name: 'Visual review',
    blurb: 'Quality audit of generated visuals.',
  },
  preprocess_review_render: {
    id: 'build',
    name: 'Final render',
    blurb: 'Compiled master video.',
  },
  package_widescreen: {
    id: 'caps',
    name: 'Captions and cover',
    blurb: 'Subtitle file and thumbnail image.',
  },
  mobile_variant: {
    id: 'phone',
    name: 'Vertical cut',
    blurb: 'Mobile-format version.',
  },
  publish: {
    id: 'post',
    name: 'Video output',
    blurb: 'Final video — export the file or publish to a platform.',
  },
}

function buildStepsFromContract(blank = false): Step[] {
  const stages = (illContract as { stages: StageContract[] }).stages
  // Node positions, in final main-line order. World Kit (05) sits between
  // Structure outline (04) and Screenplay (06); everything after Structure
  // shifts one column right to make room.
  const positions = [
    [30, 110], // 01 Project setup
    [288, 110], // 02 Video idea
    [498, 110], // 03 Core message
    [756, 110], // 04 Structure outline
    [1014, 110], // 05 World Kit
    [1272, 110], // 06 Screenplay
    [1530, 110], // 07 Storyboard
    [1788, 60], // 08 Narration audio
    [1788, 160], // 09 Visual generation
    [2046, 160], // 10 Visual review
    [2256, 110], // 11 Final render
    [2514, 110], // 12 Captions and cover
    [2514, 210], // 13 Vertical cut (optional branch off Captions)
    [2772, 110], // 14 Video output
  ]
  const contractSteps = stages
    .filter((stage) => stage.id !== 'narration_voice_check')
    .map((stage, index) => {
      const alias = stepAlias[stage.id] ?? {
        id: stage.id,
        name: stage.label,
        blurb: stage.gate ?? '',
      }
      const status: Status = blank ? 'later' : index < 7 ? 'done' : index === 7 ? 'work' : 'later'
      const progress = alias.id === 'pics' && !blank ? { done: 14, total: 22 } : undefined
      return {
        id: alias.id,
        sourceId: stage.id,
        name: alias.name,
        blurb: alias.blurb,
        status,
        progress,
        optional: alias.id === 'phone',
      }
    })
  // World Kit is the visual-reference planning stage between Structure outline
  // and Screenplay: it gathers the style anchor, cast, environments, props,
  // documents/screens, motion refs, and beat-specific refs the render reuses.
  // (Cast is just one subsection inside it.) Source of truth: working/world-kit.md.
  const worldKitNode = {
    id: 'worldkit',
    sourceId: 'worldkit',
    name: 'World Kit',
    blurb: 'Plan the visual references — style anchor, cast, environments, props, and beat-specific refs.',
    status: (blank ? 'later' : 'done') as Status,
    optional: false,
  }
  const merged = [...contractSteps.slice(0, 4), worldKitNode, ...contractSteps.slice(4)]
  return merged.map((step, index) => {
    const [x, y] = positions[index]
    return {
      ...step,
      num: String(index + 1).padStart(2, '0'),
      x,
      y,
    } satisfies Step
  })
}

function buildGates(blank = false): Gate[] {
  return [
    {
      id: 'g-setup',
      type: 'human',
      step: 'setup',
      pos: 'after',
      label: 'Approve project setup',
      state: blank ? 'awaiting' : 'approved',
      source: 'working/approvals.json',
    },
    {
      id: 'g-angle',
      type: 'human',
      step: 'goal',
      pos: 'after',
      label: 'Approve the core message / angle',
      state: blank ? 'awaiting' : 'approved',
      source: 'working/approvals.json',
    },
    {
      id: 'g-voice',
      type: 'token',
      step: 'script',
      pos: 'before',
      label: 'Narration voice rules force-fed',
      state: blank ? 'not-yet' : 'consumed',
      source: 'working/.rule-gates/voice-rules.json',
    },
    {
      id: 'g-style',
      type: 'token',
      step: 'shots',
      pos: 'before',
      label: 'Style + character rules force-fed',
      state: blank ? 'not-yet' : 'consumed',
      source: 'working/.rule-gates/style-rules.json',
    },
    {
      id: 'g-shotval',
      type: 'audit',
      step: 'shots',
      pos: 'after',
      label: 'Shot-list + character-registry validation',
      state: blank ? 'pending' : 'passed',
      source: 'validate_shot_list.py',
    },
    {
      id: 'g-narr',
      type: 'audit',
      step: 'voice',
      pos: 'after',
      label: 'Listener/script audits',
      state: blank ? 'pending' : 'passed',
      source: 'working/narration-voice-review-v2.json',
    },
    {
      id: 'g-scene',
      type: 'audit',
      step: 'pics',
      pos: 'after',
      label: 'Scene audit',
      state: blank ? 'pending' : 'failed',
      source: 'working/scene-audit.json',
    },
    {
      id: 'g-render',
      type: 'audit',
      step: 'build',
      pos: 'after',
      label: 'Render audit',
      state: 'pending',
      source: 'working/render-audit.passed',
    },
    {
      id: 'g-pub',
      type: 'human',
      step: 'post',
      pos: 'before',
      label: 'Per-platform publish approval',
      state: 'awaiting',
      source: 'working/approvals.json',
    },
  ]
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
  const initialStandalone = route === '/p/new' || route === '/p/new/world-kit'
  const [setupMode, setSetupMode] = useState<SetupMode>(initialStandalone ? 'standalone' : 'series')
  const [showName, setShowName] = useState(initialStandalone ? 'standalone' : 'spoolcast dev log')
  const [steps, setSteps] = useState(() => buildStepsFromContract(initialStandalone))
  const [gates, setGates] = useState(() => buildGates(initialStandalone))
  const [selected, setSelected] = useState(initialStandalone ? 'setup' : 'pics')
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
                setupMode={setupMode}
                showName={showName}
                castData={castData}
                blankProject={blankProject}
                autopilot={autopilot}
                onOpenCast={() => navigate(`/p/dev-log-06/world-kit`)}
                onToast={setToast}
                onAdvance={(id) =>
                  setSteps((prev) =>
                    prev.map((step) => (step.id === id ? { ...step, status: 'done' } : step)),
                  )
                }
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

function Header({
  route,
  setupMode,
  showName,
  isWorkflow,
  isWorldKit,
  autopilot,
  onLogo,
  onBack,
  onAutopilot,
  onCast,
  onNew,
  onLibrary,
  onProfile,
}: {
  route: string
  setupMode: SetupMode
  showName: string
  isWorkflow: boolean
  isWorldKit: boolean
  autopilot: boolean
  onLogo: () => void
  onBack: () => void
  onAutopilot: () => void
  onCast: () => void
  onNew: () => void
  onLibrary: () => void
  onProfile: () => void
}) {
  let crumb = null
  if (route === '/projects') {
    crumb = (
      <>
        <span>New project</span>
        <span className="sep">/</span>
        <b>Start a project</b>
      </>
    )
  } else if (route === '/library') {
    crumb = (
      <>
        <span>Projects</span>
        <span className="sep">/</span>
        <b>Library</b>
      </>
    )
  } else if (route === '/setup') {
    crumb = (
      <>
        <button className="back" onClick={onBack}>
          ←
        </button>
        <span>Projects</span>
        <span className="sep">/</span>
        <b>New video</b>
      </>
    )
  } else if (isWorkflow) {
    crumb = (
      <>
        <button className="back" onClick={onBack}>
          ←
        </button>
        <span className="crumb-secondary">Projects</span>
        <span className="sep">/</span>
        {isWorldKit ? (
          <>
            <span className="crumb-secondary">{showName}</span>
            <span className="sep">/</span>
            <b>World Kit</b>
          </>
        ) : setupMode === 'series' ? (
          <>
            <b>Dev Log #06</b>
            <span className="sep">·</span>
            <span className="crumb-secondary">{showName}</span>
          </>
        ) : (
          <>
            <b>Untitled video</b>
            <span className="sep">·</span>
            <span className="crumb-secondary">Standalone</span>
          </>
        )}
      </>
    )
  }

  return (
    <header>
      <button className="logo" type="button" onClick={onLogo}>
        <img className="mark" src="/favicon.svg" alt="" />
        <span>Spoolcast</span>
      </button>
      <div className="crumb">{crumb}</div>
      {isWorkflow ? (
        <div className="header-right">
          <div className="saving">
            <span className="pulse" />
            auto-saved
          </div>
          {!isWorldKit ? (
            <button
              className={`autopilot ${autopilot ? 'on' : ''}`}
              type="button"
              onClick={onAutopilot}
            >
              <span className="ap-dot" />
              <span>Autopilot</span>
              <span className="ap-state">{autopilot ? 'on' : 'off'}</span>
            </button>
          ) : null}
          <button className={`btn-soft ${isWorldKit ? 'active' : ''}`} onClick={onCast}>
            World Kit
          </button>
          <button
            className={`btn-soft ${route === '/library' ? 'active' : ''}`}
            onClick={onLibrary}
          >
            Library
          </button>
          <button className="btn-soft" onClick={onNew}>
            New<span className="np-extra"> project</span>
          </button>
          <button className="avatar-btn" onClick={onProfile}>
            R
          </button>
        </div>
      ) : route === '/projects' || route === '/library' ? (
        <div className="header-right">
          <button
            className={`btn-soft ${route === '/library' ? 'active' : ''}`}
            onClick={onLibrary}
          >
            Library
          </button>
          <button className="avatar-btn" onClick={onProfile}>
            R
          </button>
        </div>
      ) : null}
    </header>
  )
}

function LoginView({ onFirstTime, onGoogle }: { onFirstTime: () => void; onGoogle: () => void }) {
  return (
    <section className="login-view">
      <div className="login-card">
        <span className="mockup-pill">Interactive mockup</span>
        <div className="login-mark">S</div>
        <h1>Spoolcast</h1>
        <p>Script-first AI video pipeline.</p>
        <p className="mockup-note">
          This is a frontend design mockup — nothing here is real (no sign-in, no
          accounts, no video generation). Click anything to explore.
        </p>
        <button className="primary-cta" onClick={onFirstTime}>
          First time? Let's make your first video →
        </button>
        <div className="or-divider">Already have an account</div>
        <button className="google-btn" onClick={onGoogle}>
          <span className="g">G</span>
          Continue with Google
        </button>
        <div className="login-foot">By continuing, Terms & Privacy Policy apply.</div>
      </div>
    </section>
  )
}

// Sign-up gate at the end of onboarding: a first-timer must create an account
// before generation (autopilot or manual continue) takes them into the workflow.
function SignupModal({
  auto,
  onCancel,
  onSignup,
}: {
  auto: boolean
  onCancel: () => void
  onSignup: () => void
}) {
  return (
    <div className="modal-scrim" onClick={onCancel}>
      <div className="confirm-modal signup-modal" onClick={(e) => e.stopPropagation()}>
        <div className="login-mark">S</div>
        <h3>Create your account to continue</h3>
        <p>
          {auto
            ? 'Autopilot will generate the rest of your video — '
            : 'Your video is ready to build — '}
          sign up to save it and pick up on any device.
        </p>
        <button className="google-btn" onClick={onSignup}>
          <span className="g">G</span>
          Continue with Google
        </button>
        <button className="signup-cancel" onClick={onCancel}>
          Not now
        </button>
      </div>
    </div>
  )
}

type PickerTemplate = {
  id: string
  cls: string
  poster: string
  video: string
  badge: string
  series: boolean
  seriesBtn?: string
  duration: string
  name: string
  sig: string
  useLabel: string
  sub: { name: string; meta: string; cta: string } | null
  seed: OnboardSeed
}

const PICKER_TEMPLATES: PickerTemplate[] = [
  {
    id: 'dev',
    cls: 't-dev',
    poster: asset('sessions/spoolcast-dev-log-06/source/generated-assets/thumbnails/thumb-v2-three-answers.png'),
    video: asset('sessions/spoolcast-dev-log-06/renders/spoolcast-dev-log-06-1.0x.mp4'),
    badge: '1 series · weekly',
    series: true,
    duration: '4:08',
    name: 'Spoolcast dev-log',
    sig: '16:9 · narrated (TTS Schedar) · anime soft · animated stills',
    useLabel: 'Use base template →',
    sub: {
      name: 'Dev Log — weekly',
      meta: '10 episodes · cold-open intro & style locked · last: Dev Log #10',
      cta: 'Start episode #11 →',
    },
    seed: {
      s1: { narrator: 'yes', style: 'anime', output: '169', length: 248, projectId: 'spoolcast-dev-log-11', editing: '' },
      ideaBrief: '',
      goal: { text: '', mode: '' },
    },
  },
  {
    id: 'news',
    cls: 't-news',
    poster: '/news-poster.jpg',
    video: asset('shows/news-anime-bot/sessions/2026-05-28/episode/out/episode-15.mp4'),
    badge: '1 series · daily',
    series: true,
    seriesBtn: 'Series',
    duration: '1:21',
    name: 'Anime news',
    sig: '9:16 · narrated + cast · Bleach key-art anime · generated clips',
    useLabel: 'Use base →',
    sub: {
      name: 'faux7-news — daily',
      meta: '15 episodes · 11-character cast · last: Episode 15 (May 28)',
      cta: 'Start episode #16 →',
    },
    seed: {
      s1: { narrator: 'yes', style: 'anime', output: '916', length: 90, projectId: 'faux7-news-16', editing: '' },
      ideaBrief: '',
      goal: { text: '', mode: '' },
    },
  },
  {
    id: 'ugc',
    cls: 't-ugc',
    poster: '/ugc-poster.jpg',
    video: '/ugc-sample.mp4',
    badge: 'base template',
    series: false,
    duration: '0:56',
    name: 'UGC explainer',
    sig: '9:16 · in-video audio · photoreal · generated clips',
    useLabel: 'Use this template →',
    sub: null,
    seed: {
      s1: { narrator: 'no', style: 'realistic', output: '916', length: 56, projectId: 'ugc-explainer', editing: '' },
      ideaBrief: '',
      goal: { text: '', mode: '' },
    },
  },
  {
    id: 'expl',
    cls: 't-explainer',
    poster: '/explainer-poster.jpg',
    video: asset('sessions/spoolcast-explainer/source/external-assets/pilot-proof-22s.mp4'),
    badge: 'base template',
    series: false,
    duration: '0:22',
    name: 'Stick-figure explainer',
    sig: '16:9 · narrated · hand-drawn doodles (C&H / XKCD) · animated stills',
    useLabel: 'Use this template →',
    sub: null,
    seed: {
      s1: { narrator: 'yes', style: 'handdrawn', output: '169', length: 240, projectId: 'stick-figure-explainer', editing: '' },
      ideaBrief: '',
      goal: { text: '', mode: '' },
    },
  },
]

// In-progress projects — shown FIRST on /projects so returning users resume fast.
const RECENTS: {
  title: string
  sub: string
  step: string
  pct: number
  kind: 'series' | 'standalone'
  thumb: string
}[] = [
  {
    title: 'Dev Log #06',
    sub: 'spoolcast dev-log · 2h ago',
    step: '09 / 14',
    pct: 58,
    kind: 'series',
    thumb: asset('sessions/spoolcast-dev-log-06/source/generated-assets/thumbnails/thumb-v2-three-answers.png'),
  },
  {
    title: 'News drop · May 14',
    sub: 'faux7-news · yesterday',
    step: '13 / 14',
    pct: 92,
    kind: 'series',
    thumb: '/news-poster.jpg',
  },
  {
    title: 'Founder mode, explained',
    sub: 'standalone · 3d ago',
    step: '04 / 14',
    pct: 23,
    kind: 'standalone',
    thumb: '/explainer-poster.jpg',
  },
]

// /projects — pick a format template (or subtemplate/series), start blank, or resume.
// Choosing a template imports its format settings (s1) into the workflow.
function PickerView({
  onStandalone,
  onRecent,
  onTemplate,
  onScrolled,
}: {
  onStandalone: () => void
  onRecent: (kind: 'series' | 'standalone') => void
  onTemplate: (seed: OnboardSeed, series: boolean) => void
  onScrolled: (scrolled: boolean) => void
}) {
  const [q, setQ] = useState('')
  const [openId, setOpenId] = useState('')
  // the picker mounts at the top, so the nav bar starts in its floating state
  useEffect(() => {
    onScrolled(false)
  }, [onScrolled])
  const query = q.trim().toLowerCase()
  const matches = (t: PickerTemplate) =>
    !query || `${t.name} ${t.sig} ${t.badge} ${t.sub?.name ?? ''}`.toLowerCase().includes(query)
  const anyShown = PICKER_TEMPLATES.some(matches)

  return (
    <section className="tpl-picker" onScroll={(e) => onScrolled(e.currentTarget.scrollTop > 8)}>
      <div className="inner">
        <div className="head">
          <h1>Start a project</h1>
          <p className="lede">Pick up where you left off, or start something new.</p>
        </div>

        <button className="blank-top solo" onClick={onStandalone}>
          <span className="bt-glyph">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </span>
          <span className="bt-text">
            <span className="bt-title">Standalone — start blank</span>
            <span className="bt-sub">A true one-off. Choose format &amp; style from scratch — no template applied.</span>
          </span>
          <span className="bt-cta">Start blank →</span>
        </button>

        {RECENTS.length ? (
          <>
            <div className="section-label">
              <h2>Pick up where you left off</h2>
              <span className="hint">in-progress videos</span>
            </div>
            <div className="resume-list">
              {RECENTS.map((r) => (
                <ResumeRow
                  key={r.title}
                  title={r.title}
                  sub={r.sub}
                  step={r.step}
                  pct={r.pct}
                  thumb={r.thumb}
                  onClick={() => onRecent(r.kind)}
                />
              ))}
            </div>
          </>
        ) : null}

        <div className="section-label">
          <h2>Choose a template</h2>
          <div className="search">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="11" cy="11" r="7" />
              <path d="M21 21l-4.2-4.2" />
            </svg>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search format, style, cadence…"
            />
          </div>
        </div>

        <div className="bento">
          {PICKER_TEMPLATES.map((t) => (
            <PickerTile
              key={t.id}
              tpl={t}
              hidden={!matches(t)}
              open={openId === t.id}
              onToggle={() => setOpenId((cur) => (cur === t.id ? '' : t.id))}
              onUse={() => onTemplate(t.seed, false)}
              onSeries={() => onTemplate(t.seed, true)}
            />
          ))}
        </div>
        {!anyShown ? <div className="no-results show">No templates match “{q}”.</div> : null}
      </div>
    </section>
  )
}

// Global asset library (/library), mapped to the real spoolcast-content layout:
// Show (series/ or shows/) → Episode (a session folder) → assets (renders/,
// generated-assets/scenes, frames shots, working/ screenplay, characters).
type LibClip = { id: string; name: string; meta: string }
type LibImage = { id: string; name: string; meta: string; thumb: string }
type LibText = { id: string; name: string; meta: string; body?: string }
type LibChar = { id: string; name: string; meta: string; thumb: string }
type LibEpisode = {
  id: string
  name: string
  folder: string
  thumb: string
  render: string
  aspect: string
  clips: LibClip[]
  images: LibImage[]
  prompts: LibText[]
  charIds: string[]
}
type LibShow = {
  id: string
  name: string
  template: string
  thumb: string
  voice: LibText
  characters: LibChar[]
  episodes: LibEpisode[]
}

const DEVLOG_THUMB = asset('sessions/spoolcast-dev-log-06/source/generated-assets/thumbnails/thumb-v2-three-answers.png')
const devScene = (n: string) => asset(`sessions/spoolcast-dev-log-06/source/generated-assets/scenes/${n}.png`)

const SHOWS: LibShow[] = [
  {
    id: 'devlog', name: 'spoolcast dev-log', template: 'Wojak · GPT-image', thumb: DEVLOG_THUMB,
    voice: { id: 'v-puck', name: 'Google TTS · Puck', meta: 'series narration voice' },
    characters: [
      { id: 'builder', name: 'The builder', meta: 'Narrator · hooded wojak', thumb: devScene('C29') },
      { id: 'ai', name: 'The AI', meta: 'Cracked-face wojak', thumb: asset('styles/wojak-gpt2/references/ai-figure.png') },
      { id: 'chad', name: 'Chad', meta: 'Confident-mode insert', thumb: asset('styles/wojak-comic/references/chad.png') },
    ],
    episodes: [
      {
        id: 'dl06', name: 'Dev Log #06', folder: 'sessions/spoolcast-dev-log-06', thumb: DEVLOG_THUMB, render: '4:08 · 16:9 · MP4', aspect: '16 / 9',
        clips: [
          { id: 'dl06-b1', name: 'B1 · cold open', meta: 'shot' },
          { id: 'dl06-c1', name: 'C1 · context', meta: 'shot' },
          { id: 'dl06-c14', name: 'C14 · cast handling', meta: 'shot' },
        ],
        images: [
          { id: 'dl06-b1i', name: 'Scene B1', meta: '1K · PNG', thumb: devScene('B1') },
          { id: 'dl06-c1i', name: 'Scene C1', meta: '1K · PNG', thumb: devScene('C1') },
          { id: 'dl06-c14i', name: 'Scene C14', meta: '1K · PNG', thumb: devScene('C14') },
          { id: 'dl06-c29i', name: 'Scene C29', meta: '1K · PNG', thumb: devScene('C29') },
        ],
        prompts: [
          { id: 'dl06-p1', name: 'Screenplay v2', meta: 'working/', body: 'Spine: practical, dry, slightly deadpan. This pass tightens the wrong-diagnoses act so each one is "partly right, structurally incomplete" rather than wrong. Cold open keeps every line plain English, no jargon. Spoolcast context intro stays under a minute. Ending holds ≥2.5s of silence (settle-and-hold).' },
          { id: 'dl06-p2', name: 'Shot list · 44 shots', meta: 'shot-list.json', body: 'spoolcast-dev-log-06 — devlog about AI lying about progress and the tracker that fixed it. Audience: AI-curious non-coders. Cold-open shape: Hook → Objection → Context. Receipt visuals consumer-recognizable (phone tracker / checklist / sticky note), NOT terminal screenshots. 16:9 · 30fps · 44 shots.' },
          { id: 'dl06-p3', name: 'Core message', meta: 'session.json', body: 'AI agents handling long-running work need a mechanical job tracker as the source of truth. Without one, the agent guesses from logs, partial files, and stale shells — and the guesses sound confident even when they\'re wrong.' },
        ],
        charIds: ['builder', 'ai', 'chad'],
      },
      {
        id: 'dl05', name: 'Dev Log #05', folder: 'sessions/spoolcast-dev-log-05', thumb: asset('styles/wojak-comic/references/chad.png'), render: '3:52 · 16:9 · MP4', aspect: '16 / 9',
        clips: [
          { id: 'dl05-b1', name: 'B1 · cold open', meta: 'shot' },
          { id: 'dl05-c1', name: 'C1 · the pivot', meta: 'shot' },
        ],
        images: [{ id: 'dl05-c1i', name: 'Scene C1', meta: '1K · PNG', thumb: devScene('C1') }],
        prompts: [{ id: 'dl05-p1', name: 'Screenplay v1', meta: 'working/', body: 'First-pass draft — the original "wrong diagnosis 1/2/3/4" cadence, later reframed in v2.' }],
        charIds: ['builder', 'chad'],
      },
    ],
  },
  {
    id: 'news', name: 'faux7-news', template: 'Anime · Bleach key-art', thumb: '/news-poster.jpg',
    voice: { id: 'v-anchor', name: 'ElevenLabs · anchor', meta: 'show narration voice' },
    characters: [
      { id: 'musk', name: 'Musk', meta: 'Recurring foil', thumb: asset('shows/news-anime-bot/characters/musk.png') },
      { id: 'altman', name: 'Altman', meta: 'Tech-founder register', thumb: asset('shows/news-anime-bot/characters/altman.png') },
      { id: 'huang', name: 'Huang', meta: 'Platform-vendor register', thumb: asset('shows/news-anime-bot/characters/huang.png') },
    ],
    episodes: [
      {
        id: 'n0528', name: 'Episode · May 28', folder: 'shows/news-anime-bot/sessions/2026-05-28', thumb: '/news-poster.jpg', render: '1:21 · 9:16 · MP4', aspect: '9 / 16',
        clips: [
          { id: 'n-c1', name: 'Headline', meta: 'clip' },
          { id: 'n-c2', name: 'Reaction · Musk', meta: 'clip' },
          { id: 'n-c3', name: 'Sign-off', meta: 'clip' },
        ],
        images: [{ id: 'n-i1', name: 'Key-art · Altman', meta: 'PNG', thumb: asset('shows/news-anime-bot/characters/altman.png') }],
        prompts: [
          { id: 'n-p1', name: 'script.md', meta: 'episode/', body: 'faux7 satire desk read — headline, reaction cutaways, sign-off. 9:16, burned-in captions, Bleach key-art look.' },
          { id: 'n-p2', name: 'cast.txt', meta: 'session', body: 'Episode cast — Musk (recurring foil), Altman, Huang. Pinned character references so faces stay consistent.' },
        ],
        charIds: ['musk', 'altman', 'huang'],
      },
    ],
  },
  {
    id: 'standalone', name: 'standalone', template: 'Mixed · one-offs', thumb: '/explainer-poster.jpg',
    voice: { id: 'v-neutral', name: 'Google TTS · neutral', meta: 'per-video voice' },
    characters: [],
    episodes: [
      {
        id: 'expl', name: 'Stick-figure explainer', folder: 'sessions/spoolcast-explainer', thumb: '/explainer-poster.jpg', render: '0:22 · 16:9 · MP4', aspect: '16 / 9',
        clips: [{ id: 'e-c1', name: 'Hook', meta: 'shot' }],
        images: [{ id: 'e-i1', name: 'Doodle frame', meta: 'PNG', thumb: '/explainer-poster.jpg' }],
        prompts: [{ id: 'e-p1', name: 'Screenplay', meta: 'working/', body: 'Stick-figure explainer — hand-drawn doodle style, single hook + explainer beat, 16:9.' }],
        charIds: [],
      },
    ],
  },
]

// distinct style templates (column 1 of the flow)
const LIB_TEMPLATES = [...new Map(SHOWS.map((s) => [s.template, s.thumb])).entries()].map(([name, thumb]) => ({ name, thumb }))

// derived flat lists for the by-type browser
const LIB_VIDEOS = SHOWS.flatMap((sh) =>
  sh.episodes.map((ep) => ({ id: ep.id, name: ep.name, project: sh.name, meta: ep.render, thumb: ep.thumb, clips: ep.clips })),
)
const LIB_IMAGES = SHOWS.flatMap((sh) => sh.episodes.flatMap((ep) => ep.images.map((i) => ({ ...i, project: sh.name }))))
const LIB_CHARS = SHOWS.flatMap((sh) => sh.characters.map((c) => ({ ...c, project: sh.name })))
const LIB_VOICES = SHOWS.map((sh) => ({ id: sh.voice.id, name: sh.voice.name, project: sh.name, meta: sh.voice.meta }))
const LIB_PROMPTS = SHOWS.flatMap((sh) => sh.episodes.flatMap((ep) => ep.prompts.map((t) => ({ ...t, project: sh.name }))))

type TypeKey = 'videos' | 'images' | 'characters' | 'voices' | 'prompts'
const LIB_TABS: { key: TypeKey; label: string; count: number }[] = [
  { key: 'videos', label: 'Videos', count: LIB_VIDEOS.length },
  { key: 'images', label: 'Images', count: LIB_IMAGES.length },
  { key: 'characters', label: 'Characters', count: LIB_CHARS.length },
  { key: 'voices', label: 'Voices', count: LIB_VOICES.length },
  { key: 'prompts', label: 'Prompts', count: LIB_PROMPTS.length },
]

// each project's assets split across two generation sessions (mock)
// Flow view — lineage columns: Template → Project → Session → Assets, with
// connectors between the selected node in each column. Unselected branches dim.
type FlowAsset = { id: string; type: string; name: string; sub: string; thumb?: string; ar?: string; body?: string }
const ASSET_TYPES = ['Video', 'Image', 'Character', 'Prompt']

// rough grid span by aspect → landscape wide, portrait tall, ~equal area (Tetris)

// what an asset is + how it was generated (grounded in the real session layout)
function assetDetail(a: FlowAsset, ep: LibEpisode, show: LibShow): { prompt?: string; rows: [string, string][] } {
  if (a.type === 'Image')
    return {
      prompt: `${show.template} illustration — ${a.name.toLowerCase()}; ${ep.aspect} frame, flat cel shading, no on-image text.`,
      rows: [
        ['Model', 'gpt-image-2 · text-to-image'],
        ['Style', show.template],
        ['Output', `1K · ${ep.aspect} · PNG`],
        ['Source', `${ep.folder}/source/generated-assets/scenes/`],
        ['Episode', ep.name],
      ],
    }
  if (a.type === 'Character')
    return {
      prompt: `Locked character reference — ${a.name}. ${a.sub}. Pinned so every scene renders the same face & outfit.`,
      rows: [
        ['Model', 'nano-banana · reference sheet'],
        ['Style', show.template],
        ['Source', 'character / style references'],
        ['Reused in', `${show.episodes.length} episodes`],
      ],
    }
  if (a.type === 'Video')
    return {
      rows: [
        ['Pipeline', 'Remotion compose → ffmpeg stitch'],
        ['Duration / aspect', a.sub],
        ['Captions', `${ep.folder}/renders/*.srt`],
        ['Source', `${ep.folder}/renders/`],
        ['Episode', ep.name],
      ],
    }
  return {
    prompt: a.body ?? 'Source-of-truth text — hand-edited, then force-fed into the pipeline at the matching gate.',
    rows: [
      ['Kind', a.name],
      ['Location', `${ep.folder}/${a.sub}`],
      ['Episode', ep.name],
    ],
  }
}

function LibraryFlow() {
  // progressive disclosure: nothing downstream is revealed until its parent is picked
  const [tmpl, setTmpl] = useState<string | null>(null)
  const [showId, setShowId] = useState<string | null>(null)
  const [epId, setEpId] = useState<string | null>(null)
  const [assetView, setAssetView] = useState<'all' | 'type'>('all')
  const [openGroup, setOpenGroup] = useState<string>('Video')
  const [sel, setSel] = useState<FlowAsset | null>(null)

  const shows = tmpl ? SHOWS.filter((x) => x.template === tmpl) : []
  const show = shows.find((x) => x.id === showId) ?? null
  const episodes = show?.episodes ?? []
  const ep = episodes.find((x) => x.id === epId) ?? null

  const pickTmpl = (name: string) => {
    setTmpl(name)
    setShowId(null)
    setEpId(null)
    setSel(null)
  }
  const pickShow = (id: string) => {
    setShowId(id)
    setEpId(null)
    setSel(null)
  }
  const pickEp = (id: string) => {
    setEpId(id)
    setSel(null)
  }

  const assets: FlowAsset[] =
    ep && show
      ? [
          { id: `${ep.id}-vid`, type: 'Video', name: 'Compiled render', sub: ep.render, thumb: ep.thumb, ar: ep.aspect },
          ...ep.images.map((i) => ({ id: i.id, type: 'Image', name: i.name, sub: i.meta, thumb: i.thumb, ar: ep.aspect })),
          ...ep.charIds.flatMap((cid) => {
            const c = show.characters.find((x) => x.id === cid)
            return c ? [{ id: `${ep.id}-${c.id}`, type: 'Character', name: c.name, sub: c.meta, thumb: c.thumb, ar: '3 / 4' }] : []
          }),
          ...ep.prompts.map((p) => ({ id: p.id, type: 'Prompt', name: p.name, sub: p.meta, body: p.body })),
        ]
      : []

  const selAssetRef = useRef<HTMLButtonElement | null>(null)
  // each tile is sized by its image's real proportions (no forced aspect ratio)
  const tile = (a: FlowAsset) => {
    const selected = sel?.id === a.id
    return (
      <button
        key={a.id}
        ref={selected ? selAssetRef : undefined}
        className={`lib-asset ${a.thumb ? '' : 'noimg'} ${selected ? 'sel' : ''}`}
        onClick={() => setSel(a)}
      >
        {a.thumb ? <img src={a.thumb} alt="" loading="lazy" /> : null}
        <span className="lib-asset-badge">{a.type}</span>
        <span className="lib-asset-label">
          <b>{a.name}</b>
          <small>{a.sub}</small>
        </span>
      </button>
    )
  }

  const wrapRef = useRef<HTMLDivElement | null>(null)
  const tRef = useRef<HTMLButtonElement | null>(null)
  const pRef = useRef<HTMLButtonElement | null>(null)
  const sRef = useRef<HTMLButtonElement | null>(null)
  const dRef = useRef<HTMLDivElement | null>(null)
  const [lines, setLines] = useState<string[]>([])
  const [edgeSize, setEdgeSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })

  useLayoutEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    // coordinates are in scroll-content space (add scroll offset) so connectors
    // stay anchored to their nodes as the canvas scrolls horizontally
    const seg = (a: HTMLElement | null, b: HTMLElement | null) => {
      if (!a || !b) return null
      const wr = wrap.getBoundingClientRect()
      const ar = a.getBoundingClientRect()
      const br = b.getBoundingClientRect()
      const x1 = ar.right - wr.left + wrap.scrollLeft
      const y1 = ar.top + ar.height / 2 - wr.top + wrap.scrollTop
      const x2 = br.left - wr.left + wrap.scrollLeft
      const y2 = br.top + br.height / 2 - wr.top + wrap.scrollTop
      const dx = Math.max(18, (x2 - x1) / 2)
      return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
    }
    const measure = () => {
      setEdgeSize({ w: wrap.scrollWidth, h: wrap.scrollHeight })
      setLines(
        [seg(tRef.current, pRef.current), seg(pRef.current, sRef.current), seg(selAssetRef.current, dRef.current)].filter(
          (x): x is string => Boolean(x),
        ),
      )
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(wrap)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [tmpl, showId, epId, assetView, openGroup, sel])

  const selDetail = sel && ep && show ? assetDetail(sel, ep, show) : null

  return (
    <div className="lib-flow" ref={wrapRef}>
      <svg className="lib-flow-edges" aria-hidden="true" width={edgeSize.w || undefined} height={edgeSize.h || undefined}>
        {lines.map((d, i) => (
          <path key={i} d={d} fill="none" stroke="var(--accent)" strokeWidth="1.5" opacity="0.6" />
        ))}
      </svg>

      <div className="lib-col">
        <span className="lib-col-label">Template</span>
        {LIB_TEMPLATES.map((x) => (
          <button
            key={x.name}
            ref={x.name === tmpl ? tRef : undefined}
            className={`lib-node ${x.name === tmpl ? 'sel' : tmpl ? 'dim' : ''}`}
            onClick={() => pickTmpl(x.name)}
          >
            <span className="lib-node-thumb"><img src={x.thumb} alt="" loading="lazy" /></span>
            <span className="lib-node-meta">
              <span className="lib-node-name">{x.name}</span>
              <span className="lib-node-sub">style</span>
            </span>
          </button>
        ))}
      </div>

      {tmpl ? (
        <div className="lib-col">
          <span className="lib-col-label">Project</span>
          {shows.map((x) => (
            <button
              key={x.id}
              ref={x.id === show?.id ? pRef : undefined}
              className={`lib-node ${x.id === show?.id ? 'sel' : showId ? 'dim' : ''}`}
              onClick={() => pickShow(x.id)}
            >
              <span className="lib-node-thumb"><img src={x.thumb} alt="" loading="lazy" /></span>
              <span className="lib-node-meta">
                <span className="lib-node-name">{x.name}</span>
                <span className="lib-node-sub">{x.episodes.length} episodes</span>
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {show ? (
        <div className="lib-col">
          <span className="lib-col-label">Session</span>
          {episodes.map((x) => (
            <button
              key={x.id}
              ref={x.id === ep?.id ? sRef : undefined}
              className={`lib-node ${x.id === ep?.id ? 'sel' : epId ? 'dim' : ''}`}
              onClick={() => pickEp(x.id)}
            >
              <span className="lib-node-thumb"><img src={x.thumb} alt="" loading="lazy" /></span>
              <span className="lib-node-meta">
                <span className="lib-node-name">{x.name}</span>
                <span className="lib-node-sub">{x.render}</span>
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {ep ? (
      <div className="lib-col lib-col-assets-area">
        <div className="lib-assets-bar">
          <span className="lib-col-label">Assets · {assets.length}</span>
          <div className="lib-atoggle">
            <button className={assetView === 'all' ? 'sel' : ''} onClick={() => setAssetView('all')}>All</button>
            <button className={assetView === 'type' ? 'sel' : ''} onClick={() => setAssetView('type')}>By type</button>
          </div>
        </div>
        {assetView === 'all' ? (
          <div className="lib-assets">{assets.map((a) => tile(a))}</div>
        ) : (
          <div className="lib-bytype-cols">
            <div className="lib-col lib-col-types">
              {ASSET_TYPES.map((type) => {
                const items = assets.filter((a) => a.type === type)
                if (!items.length) return null
                const gsel = openGroup === type
                return (
                  <button
                    key={type}
                    className={`lib-node ${gsel ? 'sel' : 'dim'}`}
                    onClick={() => setOpenGroup(type)}
                  >
                    <span className="lib-node-meta">
                      <span className="lib-node-name">{type}s</span>
                      <span className="lib-node-sub">{items.length} items</span>
                    </span>
                  </button>
                )
              })}
            </div>
            {(() => {
              const items = assets.filter((a) => a.type === openGroup)
              return items.length ? (
                <div className="lib-col lib-col-items">
                  <span className="lib-col-label">{openGroup}s · {items.length}</span>
                  <div className="lib-asset-col">{items.map((a) => tile(a))}</div>
                </div>
              ) : null
            })()}
          </div>
        )}
      </div>
      ) : null}

      {sel ? (
        <div className="lib-col lib-col-detail" ref={dRef}>
          <div className="lib-assets-bar">
            <span className="lib-col-label">{sel.type}</span>
            <button className="lib-info-close" onClick={() => setSel(null)} aria-label="Close">✕</button>
          </div>
          {sel.thumb ? (
            <div className="lib-info-preview">
              <img src={sel.thumb} alt="" />
            </div>
          ) : null}
          <h3 className="lib-info-title">{sel.name}</h3>
          <p className="lib-info-sub">{sel.sub}</p>
          {selDetail?.prompt ? (
            <div className="lib-info-block">
              <span className="lib-info-label">{sel.type === 'Prompt' ? 'Text' : 'Prompt'}</span>
              <p className="lib-info-prompt">{selDetail.prompt}</p>
            </div>
          ) : null}
          <div className="lib-info-rows">
            {selDetail?.rows.map(([k, v]) => (
              <div className="lib-info-row" key={k}>
                <b>{k}</b>
                <span>{v}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* trailing empty canvas so you can always scroll well past the last column */}
      <div className="lib-flow-pad" aria-hidden="true" />
    </div>
  )
}

function LibraryView({ onScrolled }: { onScrolled: (scrolled: boolean) => void }) {
  const [view, setView] = useState<'flow' | 'type'>('flow')
  const [tab, setTab] = useState<TypeKey>('videos')
  const [videoMode, setVideoMode] = useState<'compiled' | 'all'>('compiled')
  const [q, setQ] = useState('')
  useEffect(() => {
    onScrolled(false)
  }, [onScrolled])

  const query = q.trim().toLowerCase()
  const hit = (s: string) => !query || s.toLowerCase().includes(query)

  return (
    <section
      className={`library ${view === 'flow' ? 'is-flow' : ''}`}
      onScrollCapture={(e) => onScrolled((e.target as HTMLElement).scrollTop > 8)}
    >
      <div className="lib-topbar">
        <h1>Library</h1>
        <div className="lib-view">
          <button className={view === 'flow' ? 'sel' : ''} onClick={() => setView('flow')}>
            Flow
          </button>
          <button className={view === 'type' ? 'sel' : ''} onClick={() => setView('type')}>
            By type
          </button>
        </div>
        <div className="search">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.2-4.2" />
          </svg>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search assets…" />
        </div>
      </div>

      {view === 'flow' ? (
        <LibraryFlow />
      ) : (
        <div className="lib-bytype">
          <div className="inner">
            <div className="lib-tabs">
              {LIB_TABS.map((t) => (
                <button key={t.key} className={`lib-tab ${tab === t.key ? 'sel' : ''}`} onClick={() => setTab(t.key)}>
                  {t.label}
                  <span className="lib-count">{t.count}</span>
                </button>
              ))}
            </div>

            {tab === 'videos' ? (
              <>
                <div className="lib-toggle">
                  <button className={videoMode === 'compiled' ? 'sel' : ''} onClick={() => setVideoMode('compiled')}>
                    Compiled
                  </button>
                  <button className={videoMode === 'all' ? 'sel' : ''} onClick={() => setVideoMode('all')}>
                    All clips
                  </button>
                </div>
                <div className="lib-grid">
                  {(videoMode === 'compiled'
                    ? LIB_VIDEOS.map((v) => ({ id: v.id, name: v.name, meta: v.meta, project: v.project, thumb: v.thumb, badge: `${v.clips.length} clips` }))
                    : LIB_VIDEOS.flatMap((v) => v.clips.map((c) => ({ id: c.id, name: c.name, meta: c.meta, project: v.project, thumb: v.thumb, badge: 'Clip' })))
                  )
                    .filter((a) => hit(`${a.name} ${a.project}`))
                    .map((a) => (
                      <button key={a.id} className="lib-card">
                        <span className="lib-thumb videos">
                          <img src={a.thumb} alt="" loading="lazy" />
                          <span className="lib-play">▶</span>
                          <span className="lib-card-badge">{a.badge}</span>
                        </span>
                        <span className="lib-card-name">{a.name}</span>
                        <span className="lib-card-meta">{a.meta} · {a.project}</span>
                      </button>
                    ))}
                </div>
              </>
            ) : tab === 'images' ? (
              <div className="lib-grid">
                {LIB_IMAGES.filter((a) => hit(`${a.name} ${a.project}`)).map((a) => (
                  <button key={a.id} className="lib-card">
                    <span className="lib-thumb images"><img src={a.thumb} alt="" loading="lazy" /></span>
                    <span className="lib-card-name">{a.name}</span>
                    <span className="lib-card-meta">{a.meta} · {a.project}</span>
                  </button>
                ))}
              </div>
            ) : tab === 'characters' ? (
              <div className="lib-grid">
                {LIB_CHARS.filter((a) => hit(`${a.name} ${a.project}`)).map((a) => (
                  <button key={a.id} className="lib-card">
                    <span className="lib-thumb characters"><img src={a.thumb} alt="" loading="lazy" /></span>
                    <span className="lib-card-name">{a.name}</span>
                    <span className="lib-card-meta">{a.meta} · {a.project}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="lib-list">
                {(tab === 'voices' ? LIB_VOICES : LIB_PROMPTS)
                  .filter((a) => hit(`${a.name} ${a.project}`))
                  .map((a) => (
                    <div key={a.id} className="lib-row">
                      <span className="lib-row-icon">{tab === 'voices' ? '◈' : '❝'}</span>
                      <span className="lib-row-meta">
                        <span className="lib-row-name">{a.name}</span>
                        <span className="lib-row-sub">{a.meta} · {a.project}</span>
                      </span>
                    </div>
                  ))}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

function PickerTile({
  tpl,
  hidden,
  open,
  onToggle,
  onUse,
  onSeries,
}: {
  tpl: PickerTemplate
  hidden: boolean
  open: boolean
  onToggle: () => void
  onUse: () => void
  onSeries: () => void
}) {
  const ref = useRef<HTMLVideoElement | null>(null)
  const [playing, setPlaying] = useState(false)
  return (
    <div
      className={`tile ${tpl.cls} ${open ? 'open' : ''} ${playing ? 'playing' : ''}`}
      style={hidden ? { display: 'none' } : undefined}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('.act, .sub-go, .subs-close, .tpl-subs')) return
        const v = ref.current
        if (!v) return
        // tap toggles play / pause
        if (v.paused) {
          v.muted = false
          void v.play().catch(() => {})
          setPlaying(true)
        } else {
          v.pause()
          setPlaying(false)
        }
      }}
    >
      <video ref={ref} src={tpl.video} poster={tpl.poster} preload="metadata" playsInline />
      <span className={`badge tl ${tpl.series ? 'series' : ''}`}>{tpl.badge}</span>
      <span className="badge tr">{tpl.duration}</span>
      <button className="play" aria-label="Play preview">
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M8 5v14l11-7z" />
        </svg>
      </button>
      <div className="scrim">
        <div className="t-name">{tpl.name}</div>
        <div className="t-sig">{tpl.sig}</div>
        <div className="acts">
          {tpl.series ? (
            <button className="act" onClick={(e) => { e.stopPropagation(); onToggle() }}>
              <span className="car">▾</span> {tpl.seriesBtn ?? 'Pick up a series'}
            </button>
          ) : null}
          <button className="act primary" onClick={(e) => { e.stopPropagation(); onUse() }}>
            {tpl.useLabel}
          </button>
        </div>
      </div>
      {tpl.sub ? (
        <div className="tpl-subs">
          <div className="subs-head">
            <b>Subtemplates · pick a series</b>
            <button className="subs-close" onClick={(e) => { e.stopPropagation(); onToggle() }}>×</button>
          </div>
          <div className="sub-row">
            <div className="sub-top"><span className="sub-dot" /><b>{tpl.sub.name}</b></div>
            <div className="sub-meta">{tpl.sub.meta}</div>
            <button className="sub-go" onClick={(e) => { e.stopPropagation(); onSeries() }}>{tpl.sub.cta}</button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function ResumeRow({
  title,
  sub,
  step,
  pct,
  thumb,
  onClick,
}: {
  title: string
  sub: string
  step: string
  pct: number
  thumb?: string
  onClick: () => void
}) {
  return (
    <button className="resume-row" onClick={onClick}>
      {thumb ? (
        <span className="r-thumb">
          <img src={thumb} alt="" loading="lazy" />
        </span>
      ) : null}
      <div className="r-meta">
        <div className="r-title">{title}</div>
        <div className="r-sub">{sub}</div>
      </div>
      <div className="r-prog">
        <span className="r-step">{step}</span>
        <span className="bar"><i style={{ width: `${pct}%` }} /></span>
      </div>
    </button>
  )
}

export type OnboardSeed = {
  s1: {
    narrator: string
    style: string
    output: string
    length: number
    projectId: string
    editing: string
  }
  ideaBrief: string
  goal: { text: string; mode: '' | 'ai' | 'skip' }
}

const ONB_VID_WIDE = asset(
  'sessions/spoolcast-dev-log-06/renders/spoolcast-dev-log-06-1.0x.mp4',
)
const ONB_VID_UGC = '/ugc-sample.mp4'
const ONB_LOADER_STEPS = [
  'Locking format & visual style',
  'Saving the idea & references',
  'Determining the core message',
  'Drafting the structure outline',
  'Opening your workflow at step 04',
]
const ONB_EYEBROWS = [
  '01 · Canvas',
  '02 · Audio',
  '03 · Visuals',
  '04 · Length',
  '05 · Style',
  '06 · Identity',
  '07 · Idea',
  '08 · Core message',
]

function FogVideoTile({
  selected,
  onClick,
  src,
  tag,
  title,
}: {
  selected: boolean
  onClick: (e: React.MouseEvent) => void
  src: string
  tag: string
  title: string
}) {
  const ref = useRef<HTMLVideoElement | null>(null)
  return (
    <button className={`fog-tile ${selected ? 'sel' : ''}`} onClick={onClick}>
      <span
        className="fog-vbox"
        onMouseEnter={() => {
          const v = ref.current
          if (!v) return
          v.muted = false
          v.volume = 1
          v.currentTime = 0
          void v.play().catch(() => {})
        }}
        onMouseLeave={() => {
          const v = ref.current
          if (!v) return
          v.pause()
          v.muted = true
          v.currentTime = 0
        }}
      >
        {/* #t=0.1 forces the browser to paint the first frame as a still poster */}
        <video ref={ref} src={`${src}#t=0.1`} muted playsInline preload="metadata" />
        <span className="fog-vtag">{tag}</span>
        <span className="fog-vhint">Hover to play</span>
      </span>
      <span className="fog-vtext">
        <b>{title}</b>
      </span>
    </button>
  )
}

// fog-of-war onboarding: one uniform module per question, the chain is always
// present, the current module zooms in while neighbors fade. Walks the user
// through steps 01-03 (format -> identity -> idea -> core message), saves the
// decisions, then lands them on step 04 (with the option to autopilot the rest).
function OnboardingView({
  onFinish,
}: {
  onFinish: (seed: OnboardSeed, autopilot: boolean) => void
}) {
  const QCOUNT = ONB_EYEBROWS.length
  const [cur, setCur] = useState(0)
  const [canvas, setCanvas] = useState('169')
  const [narrator, setNarrator] = useState('yes')
  const [motion, setMotion] = useState('stills')
  const [length, setLength] = useState(120)
  const [lengthMode, setLengthMode] = useState<'' | 'ai'>('')
  const [style, setStyle] = useState(styleThumbs[0].id)
  const [name, setName] = useState('')
  const [about, setAbout] = useState('')
  const [message, setMessage] = useState('')
  const [messageMode, setMessageMode] = useState<'' | 'ai' | 'skip'>('')
  const [finishing, setFinishing] = useState(false)
  const [finishAuto, setFinishAuto] = useState(false)
  const [loadStep, setLoadStep] = useState(0)
  const [vw, setVw] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1280))
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [navTop, setNavTop] = useState<number | null>(null)

  useEffect(() => {
    const onResize = () => setVw(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // desktop: park the Back/Next buttons just below the current module
  // (offsetHeight/clientHeight are transform-independent, so the .9→1 card scale
  // animation doesn't skew it; ResizeObserver re-measures once layout settles)
  useEffect(() => {
    const vp = viewportRef.current
    if (!vp) return
    const measure = () => {
      if (vw <= 760) {
        setNavTop(null)
        return
      }
      const card = vp.querySelector('.fog-mod.cur') as HTMLElement | null
      if (!card) return
      // all layout units (offset/client) so it stays consistent — the card is
      // centered in the viewport, so its bottom sits at clientHeight/2 + cardH/2.
      setNavTop(vp.offsetTop + vp.clientHeight / 2 + card.offsetHeight / 2 + 22)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(vp)
    const card = vp.querySelector('.fog-mod.cur') as HTMLElement | null
    if (card) ro.observe(card)
    return () => ro.disconnect()
  }, [cur, vw, QCOUNT])

  const go = (i: number) => setCur(Math.max(0, Math.min(QCOUNT - 1, i)))

  const startFinish = (auto: boolean) => {
    setFinishAuto(auto)
    setLoadStep(0)
    setFinishing(true)
  }

  useEffect(() => {
    if (!finishing) return
    if (loadStep >= ONB_LOADER_STEPS.length) {
      const seed: OnboardSeed = {
        s1: {
          narrator,
          style,
          output: canvas,
          length: lengthMode === 'ai' ? 0 : length,
          projectId: name.trim() || 'untitled-01',
          editing: '',
        },
        ideaBrief: about.trim(),
        goal:
          messageMode === 'ai'
            ? { text: '', mode: 'ai' }
            : messageMode === 'skip'
              ? { text: '', mode: 'skip' }
              : { text: message.trim(), mode: '' },
      }
      const t = window.setTimeout(() => onFinish(seed, finishAuto), 360)
      return () => window.clearTimeout(t)
    }
    const t = window.setTimeout(() => setLoadStep((v) => v + 1), 820)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finishing, loadStep])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (finishing) return
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === 'ArrowRight' && cur < QCOUNT - 1) setCur((v) => v + 1)
      if (e.key === 'ArrowLeft' && cur > 0) setCur((v) => v - 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cur, finishing, QCOUNT])

  // narrator-only styles can't apply to a no-narrator video — keep the seed valid
  const chooseNarrator = (value: string) => {
    setNarrator(value)
    if (value === 'no') {
      const picked = styleThumbs.find((s) => s.id === style)
      if (picked?.narratorOnly) {
        const valid = styleThumbs.find((s) => !s.narratorOnly)
        if (valid) setStyle(valid.id)
      }
    }
  }

  // card width + gap must match the rendered module exactly or the filmstrip
  // mis-centers — drive both the transform and the CSS off the same numbers.
  const isNarrow = vw <= 640
  const CARD_W = isNarrow ? Math.min(Math.round(vw * 0.84), 460) : 560
  const GAP = isNarrow ? 28 : 64
  const offset = -(cur * (CARD_W + GAP) + CARD_W / 2)
  const modClass = (i: number) =>
    `fog-mod ${i === cur ? 'cur' : ''} ${i < cur ? 'done' : ''}`
  const stop = (e: React.MouseEvent) => e.stopPropagation()
  const mins = Math.round((length / 60) * 10) / 10

  return (
    <section className="fog-view">
      <div className="fog-top">
        <div className="fog-bar">
          {ONB_EYEBROWS.map((_, i) => (
            <span key={i} className={i < cur ? 'done' : i === cur ? 'active' : ''} />
          ))}
        </div>
        <div className="fog-count">
          {cur + 1} of {QCOUNT} · {ONB_EYEBROWS[cur].split('·')[1].trim()}
        </div>
      </div>

      <div className="fog-viewport" ref={viewportRef}>
        <div
          className="fog-strip"
          style={
            {
              transform: `translate(${offset}px, -50%)`,
              gap: `${GAP}px`,
              '--fog-card-w': `${CARD_W}px`,
              '--fog-gap': `${GAP}px`,
            } as React.CSSProperties
          }
        >
          {/* 0 — canvas */}
          <div className={modClass(0)} onClick={() => cur !== 0 && go(0)}>
            <div className="fog-eyebrow">{ONB_EYEBROWS[0]}</div>
            <h2 className="fog-q">What shape is this video?</h2>
            <div className="fog-content">
              {[
                ['169', 'A', 'Widescreen', '16:9', ''],
                ['916', 'B', 'Vertical', '9:16', 'r916'],
                ['11', 'C', 'Square', '1:1', 'r11'],
              ].map((o) => (
                <button
                  key={o[0]}
                  className={`fog-opt ${canvas === o[0] ? 'sel' : ''}`}
                  onClick={(e) => {
                    stop(e)
                    setCanvas(o[0])
                  }}
                >
                  <span className="fog-stripe" />
                  <span className="fog-num">{o[1]}</span>
                  <span className={`fog-ratio ${o[4]}`} />
                  <span className="fog-nm">{o[2]}</span>
                  <span className="fog-ds">{o[3]}</span>
                </button>
              ))}
            </div>
          </div>

          {/* 1 — narrator */}
          <div className={modClass(1)} onClick={() => cur !== 1 && go(1)}>
            <div className="fog-eyebrow">{ONB_EYEBROWS[1]}</div>
            <h2 className="fog-q">Is there a narrator?</h2>
            <div className="fog-content">
              <div className="fog-vrow">
                <FogVideoTile
                  selected={narrator === 'yes'}
                  onClick={(e) => {
                    stop(e)
                    chooseNarrator('yes')
                  }}
                  src={ONB_VID_WIDE}
                  tag="NARRATED"
                  title="Yes, a separate narrator tells the story"
                />
                <FogVideoTile
                  selected={narrator === 'no'}
                  onClick={(e) => {
                    stop(e)
                    chooseNarrator('no')
                  }}
                  src={ONB_VID_UGC}
                  tag="IN-VIDEO"
                  title="No, the people in the video do the talking"
                />
              </div>
            </div>
          </div>

          {/* 2 — motion */}
          <div className={modClass(2)} onClick={() => cur !== 2 && go(2)}>
            <div className="fog-eyebrow">{ONB_EYEBROWS[2]}</div>
            <h2 className="fog-q">What do the visuals look like?</h2>
            <div className="fog-content">
              {[
                ['stills', 'A', 'Animated still images', 'cheap · consistent'],
                ['clips', 'B', 'Generated video clips', 'full motion · pricier'],
              ].map((o) => (
                <button
                  key={o[0]}
                  className={`fog-opt ${motion === o[0] ? 'sel' : ''}`}
                  onClick={(e) => {
                    stop(e)
                    setMotion(o[0])
                  }}
                >
                  <span className="fog-stripe" />
                  <span className="fog-num">{o[1]}</span>
                  <span className="fog-nm">{o[2]}</span>
                  <span className="fog-ds">{o[3]}</span>
                </button>
              ))}
            </div>
          </div>

          {/* 3 — length */}
          <div className={modClass(3)} onClick={() => cur !== 3 && go(3)}>
            <div className="fog-eyebrow">{ONB_EYEBROWS[3]}</div>
            <h2 className="fog-q">How long, roughly?</h2>
            <div className="fog-content">
              <div className={`fog-slider-val ${lengthMode === 'ai' ? 'muted' : ''}`}>
                {lengthMode === 'ai' ? (
                  <>Auto <em>(AI sizes it at the structure outline — step 04)</em></>
                ) : (
                  <>~{mins} min <em>({length}s · ~{Math.round(length / 8)} scenes)</em></>
                )}
              </div>
              <input
                type="range"
                min={30}
                max={600}
                step={15}
                value={length}
                disabled={lengthMode === 'ai'}
                onClick={stop}
                onChange={(e) => {
                  setLength(Number(e.target.value))
                  setLengthMode('')
                }}
              />
              <div className="fog-or">or</div>
              <button
                className={`ai-btn ${lengthMode === 'ai' ? 'sel' : ''}`}
                onClick={(e) => {
                  stop(e)
                  setLengthMode((m) => (m === 'ai' ? '' : 'ai'))
                }}
              >
                <span className="ap-spark">✦</span> Let AI decide
              </button>
              <p className="skip-note">
                AI reads everything you've shared and finds the perfect length.
              </p>
            </div>
          </div>

          {/* 4 — style */}
          <div className={modClass(4)} onClick={() => cur !== 4 && go(4)}>
            <div className="fog-eyebrow">{ONB_EYEBROWS[4]}</div>
            <h2 className="fog-q">Pick a visual style.</h2>
            <div className="fog-content">
              <div className="fog-style-grid">
                {styleThumbs.map((st) => {
                  const disabled = narrator === 'no' && st.narratorOnly
                  return (
                    <button
                      key={st.id}
                      disabled={disabled}
                      className={`fog-style-cell ${style === st.id ? 'sel' : ''}`}
                      onClick={(e) => {
                        stop(e)
                        if (!disabled) setStyle(st.id)
                      }}
                    >
                      <span className="fog-pv">
                        {st.img ? <img src={st.img} alt="" /> : null}
                      </span>
                      <span className="fog-lbl">
                        {st.name}
                        {disabled ? <em> · narrator only</em> : null}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          </div>

          {/* 5 — name */}
          <div className={modClass(5)} onClick={() => cur !== 5 && go(5)}>
            <div className="fog-eyebrow">{ONB_EYEBROWS[5]}</div>
            <h2 className="fog-q">What's the name of this video?</h2>
            <div className="fog-content">
              <input
                className="fog-tb one"
                placeholder="e.g. Spoolcast Dev Log #07 — the UI wrapper"
                value={name}
                onClick={stop}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          </div>

          {/* 6 — about */}
          <div className={modClass(6)} onClick={() => cur !== 6 && go(6)}>
            <div className="fog-eyebrow">{ONB_EYEBROWS[6]}</div>
            <h2 className="fog-q">What's this video about?</h2>
            <div className="fog-content">
              <textarea
                className="fog-tb tall"
                placeholder="Be as descriptive as you want — the idea, topic, opinion, or story this should turn into."
                value={about}
                onClick={stop}
                onChange={(e) => setAbout(e.target.value)}
              />
              <button className="fog-attach" onClick={stop} type="button">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M12 5v14" />
                  <path d="M5 12h14" />
                </svg>{' '}
                Attach references &amp; images
              </button>
            </div>
          </div>

          {/* 7 — core message */}
          <div className={modClass(7)} onClick={() => cur !== 7 && go(7)}>
            <div className="fog-eyebrow">{ONB_EYEBROWS[7]}</div>
            <h2 className="fog-q">What's the one core message of this video?</h2>
            <div className="fog-content">
              <textarea
                className={`fog-tb ${messageMode ? 'muted' : ''}`}
                style={{ height: 96 }}
                placeholder="The one thing a viewer should walk away believing."
                value={message}
                onClick={stop}
                onChange={(e) => {
                  setMessage(e.target.value)
                  if (e.target.value) setMessageMode('')
                }}
              />
              <div className="fog-or">or</div>
              <div className="fog-msg-actions">
                <button
                  className={`ai-btn ${messageMode === 'ai' ? 'sel' : ''}`}
                  onClick={(e) => {
                    stop(e)
                    setMessageMode((m) => (m === 'ai' ? '' : 'ai'))
                  }}
                >
                  <span className="ap-spark">✦</span> Let AI decide
                </button>
                <button
                  className={`fog-msg-btn ${messageMode === 'skip' ? 'sel' : ''}`}
                  onClick={(e) => {
                    stop(e)
                    setMessageMode((m) => (m === 'skip' ? '' : 'skip'))
                  }}
                >
                  Skip for now
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {cur === QCOUNT - 1 ? (
        <>
          {/* the two end choices — bottom-right corner on desktop, stacked on mobile */}
          <div className="fog-end">
            <span className="fog-ap-sub">AI finishes the rest — no input needed.</span>
            <div className="fog-end-row">
              <button className="ai-btn" onClick={() => startFinish(true)}>
                <span className="ap-spark">✦</span> Autopilot to the end
              </button>
              <span className="fog-navor">or</span>
              <button className="fog-primary" onClick={() => startFinish(false)}>
                Continue manual setup →
              </button>
            </div>
          </div>
          {/* Back floats below the module like every other step (placeholder balances its x) */}
          <div className="fog-nav last-back" style={navTop != null ? { top: navTop } : undefined}>
            <button className="fog-back" onClick={() => go(cur - 1)}>
              ← Back
            </button>
            <span className="fog-next-ph" aria-hidden="true" />
          </div>
        </>
      ) : (
        <div
          className="fog-nav"
          style={{ width: CARD_W, ...(navTop != null ? { top: navTop } : {}) }}
        >
          <button className="fog-primary" onClick={() => go(cur + 1)}>
            Next →
          </button>
          <button className="fog-back" onClick={() => go(cur - 1)} disabled={cur === 0}>
            ← Back
          </button>
        </div>
      )}

      <div className={`fog-loader ${finishing ? 'show' : ''}`}>
        <div className="fog-loader-card">
          <div className="fog-eyebrow accent">
            {finishAuto ? 'Autopilot engaged' : 'Building your project'}
          </div>
          <h2>{finishAuto ? 'Setting up & taking over…' : 'Setting up the workflow…'}</h2>
          <div className="fog-loader-steps">
            {ONB_LOADER_STEPS.map((s, i) => (
              <div
                key={s}
                className={`fog-lstep ${i < loadStep ? 'ok' : i === loadStep ? 'run' : ''}`}
              >
                <span className="fog-lic">
                  <span className="fog-dot" />
                  <svg className="fog-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </span>
                {s}
              </div>
            ))}
          </div>
          <div className="fog-lbar">
            <i style={{ width: `${Math.round((loadStep / ONB_LOADER_STEPS.length) * 100)}%` }} />
          </div>
        </div>
      </div>
    </section>
  )
}

function WorkflowView({
  steps,
  gates,
  seed,
  selected,
  setSelected,
  activeStep,
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
  // on phones the detail card is always full-screen (focused single-surface view)
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
    seed
      ? seed.ideaBrief
      : blankProject
        ? ''
        : 'A behind-the-scenes dev log about turning Spoolcast into a contract-locked video pipeline, with the UI as the next wrapper around the engine.',
  )
  const [goal, setGoal] = useState<{ text: string; mode: '' | 'ai' | 'skip' }>(() =>
    seed
      ? seed.goal
      : blankProject
        ? { text: '', mode: '' }
        : { text: 'The engine is stable enough to build a product wrapper around it.', mode: '' },
  )
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
      ['script', 'shots'],
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
  const statusLabel =
    activeStep.status === 'done'
      ? 'Complete'
      : activeStep.status === 'work'
        ? 'In progress'
        : 'Pending'
  const showWide = ['setup', 'idea', 'pics', 'shots', 'plan', 'worldkit'].includes(activeStep.id)

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
      <div className="canvas">
        <svg className="edges" viewBox="0 0 3080 850" preserveAspectRatio="none" aria-hidden="true">
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
            <span className={`status-pill ${activeStep.status}`}>{statusLabel}</span>
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
              disabled={selectableIndex >= orderedSteps.length - 1}
              onClick={() => setSelected(orderedSteps[selectableIndex + 1].id)}
            >
              Next ›
            </button>
            <button className="icon-btn expand-btn" onClick={() => setFull((value) => !value)}>
              {fullView ? '⤡' : '⤢'}
            </button>
          </div>
          <div className="detail-body">
            <StepContent
              step={activeStep}
              setupMode={setupMode}
              showName={showName}
              castData={castData}
              s1={s1}
              setS1={setS1}
              ideaBrief={ideaBrief}
              setIdeaBrief={setIdeaBrief}
              goal={goal}
              setGoal={setGoal}
              blankProject={blankProject}
              onOpenCast={onOpenCast}
              onToast={onToast}
              origin={origin}
              formatDirty={formatDirty}
            />
            <div className="detail-foot">
              {(() => {
                // whether a step counts as resolved: already saved (done), or its
                // own inputs are filled. display-only steps only count once saved.
                const isComplete = (st: Step) => {
                  if (st.status === 'done') return true
                  if (st.id === 'setup') return blankProject ? Boolean(s1.narrator && s1.style && s1.output) : true
                  if (st.id === 'idea') return ideaBrief.trim().length > 0
                  if (st.id === 'goal') return goal.text.trim().length > 0 || goal.mode === 'ai' || goal.mode === 'skip'
                  return false
                }
                // the CURRENT step's own inputs (a display step has none to fill).
                const currentInputComplete =
                  activeStep.id === 'setup' && blankProject
                    ? Boolean(s1.narrator && s1.style && s1.output)
                    : activeStep.id === 'idea'
                      ? ideaBrief.trim().length > 0
                      : activeStep.id === 'goal'
                        ? goal.text.trim().length > 0 || goal.mode === 'ai' || goal.mode === 'skip'
                        : true
                // every earlier step must be resolved before you can act on this one.
                const priorsComplete = orderedSteps.slice(0, selectableIndex).every(isComplete)
                const stepComplete = currentInputComplete && priorsComplete
                const isLast = selectableIndex >= orderedSteps.length - 1
                // autopilot becomes available from the core-message step onward —
                // the creative input is captured, AI can finish the rest.
                const goalIndex = orderedSteps.findIndex((s) => s.id === 'goal')
                const canAutopilot =
                  !autopilot &&
                  goalIndex >= 0 &&
                  selectableIndex >= goalIndex &&
                  activeStep.id !== 'post' // the final Video output step is the finish line — nothing left to autopilot
                const saveChoice = (
                  <div className="foot-choice">
                    <button
                      className="save-continue"
                      disabled={!stepComplete || autopilot}
                      onClick={() => {
                        if (!stepComplete || autopilot) return
                        onAdvance(activeStep.id)
                        if (isLast) onToast('Saved.')
                        else setSelected(orderedSteps[selectableIndex + 1].id)
                      }}
                    >
                      {isLast ? 'Save and finish' : 'Save and continue →'}
                    </button>
                    <span className="foot-sub">
                      {autopilot
                        ? 'Autopilot is running — stop it to edit by hand'
                        : stepComplete
                          ? 'You review each remaining step'
                          : !priorsComplete
                            ? 'Complete the earlier steps first'
                            : 'Finish this step’s sections first'}
                    </span>
                  </div>
                )
                if (!canAutopilot) return saveChoice
                return (
                  <>
                    <div className="foot-choice">
                      <button
                        className="autopilot-btn"
                        disabled={!stepComplete}
                        title={
                          stepComplete
                            ? undefined
                            : !priorsComplete
                              ? 'Complete the earlier steps first'
                              : 'Make a choice for this step first'
                        }
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
                    {saveChoice}
                  </>
                )
              })()}
            </div>
          </div>
        </div>
        <span className="canvas-meta">
          Format template: illustration-chunk-remotion · {((illContract as { stages: unknown[] }).stages.length)} steps
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
    return <WorldKitPanel castData={castData} onManage={onOpenCast} compact />
  }
  if (step.id === 'voice') return <NarrationContent />
  if (step.id === 'shots') return <ShotTable />
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

// The basic carry-over checklist handles the obvious reusable setup (format,
// style, structure, cast). This section captures the soft, creative show
// behavior that only exists as prompt fragments / patterns in the first video:
// overlays, title cards, caption + humor style, recurring memes, motifs, etc.
// AI suggestions are NEVER saved automatically — a rule is only saved once the
// user keeps it (or adds one by hand).
type TplRule = {
  id: number
  category: string
  text: string
  source?: string
}

const SCAN_SUGGESTIONS: Omit<TplRule, 'id'>[] = [
  {
    category: 'Ending style',
    text: 'End each video with a notification-style teaser card for the next episode.',
    source: 'Source: Storyboard · Beat 12',
  },
  {
    category: 'Humor',
    text: 'Dry, deadpan narration — undercut every serious claim with a one-line aside.',
    source: 'Source: Screenplay · Scene 4',
  },
  {
    category: 'Overlay',
    text: 'Keep the persistent “DEV LOG” title bar in the top-left for the full runtime.',
    source: 'Source: Final output · 0:00–end',
  },
  {
    category: 'Caption style',
    text: 'Burned-in captions, two lines max, bottom-center, bold weight.',
    source: 'Source: Captions and cover',
  },
  {
    category: 'Meme',
    text: 'Reuse the “contract-locked” running gag whenever the engine is mentioned.',
    source: 'Source: Screenplay · Scene 7',
  },
]

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
type TplComponent = { key: string; label: string; locked: boolean; on: boolean }

const INHERITED_COMPONENTS: TplComponent[] = [
  { key: 'titlebar', label: 'Title bar', locked: false, on: true },
  { key: 'lowerthird', label: 'Lower-third', locked: false, on: true },
  { key: 'endcard', label: 'End card', locked: false, on: true },
  { key: 'watermark', label: 'Watermark', locked: false, on: true },
  { key: 'caption', label: 'Caption style', locked: true, on: true },
  { key: 'introoutro', label: 'Intro / outro pattern', locked: false, on: true },
]

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
      : [
          {
            id: 'f1',
            name: 'contract-locked-engine.md',
            meta: '12 KB · markdown',
            kind: 'doc',
            desc: 'Design doc explaining the contract → engine boundary. Use for sections 2 + 4.',
          },
          {
            id: 'f2',
            name: 'dev-log-05-transcript.txt',
            meta: '38 KB · text',
            kind: 'clock',
            desc: 'Last episode’s transcript — pull the “why this matters” framing from the cold open.',
          },
          {
            id: 'f3',
            name: 'workflow-shot-2026-05-22.png',
            meta: '412 KB · image',
            kind: 'image',
            desc: '',
          },
        ],
  )

  const setDesc = (id: string, desc: string) =>
    setFiles((current) => current.map((file) => (file.id === id ? { ...file, desc } : file)))
  const removeFile = (id: string) =>
    setFiles((current) => current.filter((file) => file.id !== id))

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

        <button className="idea-attach">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14" />
            <path d="M5 12h14" />
          </svg>
          Attach files
        </button>
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

function ShotTable() {
  let imageIndex = 0
  return (
    <div className="card">
      <div className="ch">
        <h3>Shot list — 22 chunks</h3>
        <span>shot-list/shot-list.json</span>
      </div>
      <div className="table-wrap">
        <table className="shots">
          <thead>
            <tr>
              <th>ID</th>
              <th>Scene</th>
              <th>Narration</th>
              <th>Visual direction</th>
              <th>Duration</th>
              <th>Preview</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {shots.map(([id, scene, visual, dur, state]) => {
              const file = state === 'ok' ? sceneFiles[imageIndex++ % sceneFiles.length] : ''
              return (
                <tr key={id}>
                  <td><span className="id">{id}</span></td>
                  <td><b>{scene}</b></td>
                  <td className="narr">"{scene} narration beat."</td>
                  <td>{visual}</td>
                  <td>{dur}</td>
                  <td>
                    {file ? (
                      <img className="mini-thumb" src={asset(`sessions/spoolcast-dev-log-04/source/generated-assets/scenes/${file}`)} alt="" />
                    ) : (
                      <span className="mini-thumb empty" />
                    )}
                  </td>
                  <td><span className={`st ${state}`}>{state === 'ok' ? 'Ready' : state === 'work' ? 'Working' : 'Pending'}</span></td>
                </tr>
              )
            })}
          </tbody>
        </table>
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

// World Kit subsections — the visual-reference planning model. Cast is one of
// them; nothing here implies a fixed "1 character + 1 environment" recipe.
// Share scope is kept to single words so the control stays tiny.
const WORLD_KIT_SCOPES = ['Episode', 'Show', 'Template'] as const

type WorldKitSection = {
  id: string
  name: string
  desc: string
  scope: string
  cast?: boolean
  locked?: boolean
  image?: string
  caption?: string
  items?: string[]
}

const WORLD_KIT_SECTIONS: WorldKitSection[] = [
  // Style Anchor is owned by Project setup (Step 01) — shown here read-only.
  { id: 'style', name: 'Style Anchor', desc: 'Set in Project setup — locked here.', scope: 'Template', locked: true, image: asset('styles/wojak-comic/references/chad.png'), caption: 'Wojak comic' },
  { id: 'cast', name: 'Cast', desc: 'Characters who appear. Manifest: cast.txt.', scope: 'Show', cast: true },
  { id: 'env', name: 'Environments', desc: 'Locations and backdrops.', scope: 'Show', items: ['Hooded-desk home office', 'Whiteboard wall', 'Night-city skyline'] },
  { id: 'props', name: 'Props / Objects', desc: 'Recurring objects and held items.', scope: 'Episode', items: ['"OUCH!" mug', 'Job-tracker board', 'Mechanical keyboard'] },
  { id: 'docs', name: 'Documents / Screens', desc: 'On-screen UI, documents, and charts.', scope: 'Episode', items: ['shot-list.json table', 'session.json core_message', 'Terminal log'] },
  { id: 'motion', name: 'Motion / Camera References', desc: 'Camera moves and motion cues.', scope: 'Template', items: ['Slow push-in', 'Static medium', 'Whip-pan to reaction'] },
  { id: 'beat', name: 'Beat-Specific References', desc: 'One-off refs scoped to a single beat.', scope: 'Episode', items: ['B1 — "THE SYMPTOM" title card', 'C14 — four thought-bubble inserts'] },
]

function WorldKitPanel({
  castData,
  onManage,
  compact = false,
}: {
  castData: (typeof castByShow)['spoolcast dev log']
  onManage?: () => void
  compact?: boolean
}) {
  const [scopes, setScopes] = useState<Record<string, string>>(() =>
    Object.fromEntries(WORLD_KIT_SECTIONS.map((s) => [s.id, s.scope])),
  )
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
                      <option key={o} value={o}>{o}</option>
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
        <WorldKitPanel castData={castData} />
      </div>
    </section>
  )
}

function CastGrid({
  castData,
  compact = false,
}: {
  castData: (typeof castByShow)['spoolcast dev log']
  compact?: boolean
}) {
  return (
    <div className={`cast-grid ${compact ? 'compact' : ''}`}>
      {castData.chars.map((char) => (
        <div className="cast-card" key={char.ref}>
          <div className="portrait">
            <img src={char.img} alt="" />
            <span>{char.ref}</span>
          </div>
          <div className="body">
            <h3>{char.name}</h3>
            <p>{char.role}</p>
            {!compact ? <small>{char.episodes} episodes · last: {char.lastUsed}</small> : null}
          </div>
        </div>
      ))}
    </div>
  )
}

function ChatWidget({
  state,
  tab,
  selected,
  customChat,
  onOpen,
  onClose,
  onPin,
  onTab,
}: {
  state: ChatState
  tab: ChatTab
  selected: Step
  customChat: boolean
  onOpen: () => void
  onClose: () => void
  onPin: () => void
  onTab: (tab: ChatTab) => void
}) {
  const [messages, setMessages] = useState(
    customChat
      ? []
      : [
          {
            who: 'Spoolcast',
            text: 'Looking at Visual generation — clip C15 failed the scene audit. I can re-prompt it with a calmer pose, or skip it and use a cutaway.',
          },
        ],
  )
  const [text, setText] = useState('')
  const suggestions =
    selected.id === 'pics'
      ? ['Regenerate C15 with a calmer pose', 'Skip C15 and use a cutaway']
      : ['Switch to standalone', 'Show inherited rules']

  if (state === 'closed') {
    return (
      <button className="chat-bubble" onClick={onOpen} aria-label="Ask Spoolcast">
        □
      </button>
    )
  }
  return (
    <aside className={`chat-root ${state}`}>
      <div className="chat-panel">
        <div className="chat-head">
          <div className="chat-tabs">
            <button className={tab === 'chat' ? 'active' : ''} onClick={() => onTab('chat')}>
              Chat
            </button>
            <button className={tab === 'history' ? 'active' : ''} onClick={() => onTab('history')}>
              History
            </button>
          </div>
          <button onClick={onPin}>⇱</button>
          <button onClick={onClose}>×</button>
        </div>
        {tab === 'chat' ? (
          <div className="chat-body">
            <div className="chat-suggestions">
              {suggestions.map((suggestion) => (
                <button key={suggestion} onClick={() => setText(suggestion)}>
                  {suggestion}
                </button>
              ))}
            </div>
            {messages.map((message, index) => (
              <div className="chat-msg" key={`${message.who}-${index}`}>
                <span>{message.who}</span>
                {message.text}
              </div>
            ))}
          </div>
        ) : (
          <div className="chat-history">
            {[
              ['REGEN', 'Regenerated clip C12 — "Job runner"', '12 min ago'],
              ['EDIT', 'Tightened narration on C09 ("Audit demo")', '42 min ago'],
              ['ADD', 'Added new gate: render audit (working/render-audit.passed)', '1 hr ago'],
              ['EDIT', 'Shot list — split C07 into two beats for pacing', '2 hr ago'],
              ['ADD', 'Added Chad (meme-chad) to the dev log roster', '5 hr ago'],
            ].map(([kind, what, when]) => (
              <div className="history-row" key={`${kind}-${what}`}>
                <b className={kind.toLowerCase()}>{kind}</b>
                <span>{what}</span>
                <i>{when}</i>
              </div>
            ))}
          </div>
        )}
        <div className="chat-input">
          <div className="chat-input-box">
            <textarea
              placeholder={customChat ? 'Start by describing what type of video you would like to make…' : 'Ask Spoolcast anything…'}
              value={text}
              autoFocus={customChat}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  if (!text.trim()) return
                  setMessages((items) => [...items, { who: 'Ralph', text }])
                  setText('')
                }
              }}
            />
            <button
              className="chat-send"
              aria-label="Send"
              disabled={!text.trim()}
              onClick={() => {
                if (!text.trim()) return
                setMessages((items) => [...items, { who: 'Ralph', text }])
                setText('')
              }}
            >
              ↑
            </button>
          </div>
        </div>
      </div>
    </aside>
  )
}

function ProfileDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <>
      <button className={`profile-scrim ${open ? 'open' : ''}`} onClick={onClose} aria-label="Close profile" />
      <aside className={`profile-panel ${open ? 'open' : ''}`}>
        <div className="pp-head">
          <div className="pp-avatar">R</div>
          <div>
            <b>Ralph Xu</b>
            <span>ralph@spoolcast.dev</span>
          </div>
          <button onClick={onClose}>×</button>
        </div>
        <div className="credits-card">
          <span>Credits</span>
          <b>2,140 <em>/ 5,000 this month</em></b>
          <i><u style={{ width: '42%' }} /></i>
          <div><small>Resets May 28</small><button>Top up</button></div>
        </div>
        <section>
          <h3>Plan</h3>
          <p>Creator · $24/mo</p>
          <small>5,000 credits · 4 active shows · billed monthly</small>
        </section>
        <section>
          <h3>Defaults</h3>
          {['Autopilot pauses on audit failures', 'Auto-approve mobile variant', 'Email when a step finishes'].map((item, i) => (
            <div className="pp-row" key={item}>
              <span>{item}<small>{i === 0 ? 'Recommended. Turn off only if the gates are trusted.' : i === 1 ? 'Skip the human gate when the vertical cut passes audits.' : 'One email per project, not per step.'}</small></span>
              <button className={`toggle ${i !== 1 ? 'on' : ''}`} />
            </div>
          ))}
        </section>
        <section>
          <h3>Account</h3>
          <p>Manage API keys ›</p>
          <p>Connected platforms ›</p>
          <p>Sign out ›</p>
        </section>
      </aside>
    </>
  )
}

/* headless — drives the real canvas: focuses each remaining step, then marks
   it done, one at a time, until the run finishes or the user stops it. */
function AutopilotRunner({
  steps,
  onSelect,
  onStepComplete,
  onFinish,
}: {
  steps: { id: string; name: string }[]
  onSelect: (id: string) => void
  onStepComplete: (id: string) => void
  onFinish: () => void
}) {
  const [idx, setIdx] = useState(0)
  useEffect(() => {
    if (idx >= steps.length) {
      onFinish()
      return
    }
    onSelect(steps[idx].id)
    const t = window.setTimeout(() => {
      onStepComplete(steps[idx].id)
      setIdx((i) => i + 1)
    }, 1100)
    return () => window.clearTimeout(t)
  }, [idx, steps, onSelect, onStepComplete, onFinish])
  return null
}

function ConfirmModal({
  onCancel,
  onApprove,
}: {
  onCancel: () => void
  onApprove: () => void
}) {
  return (
    <div className="modal-scrim">
      <div className="confirm-modal">
        <span className="need">USES CREDITS</span>
        <h3>Turn on Autopilot?</h3>
        <p>Spoolcast will run every remaining step automatically. This costs credits as it runs — about 380 credits for an episode of this length.</p>
        <div className="check">
          <b>Before turning it on</b>
          <ul>
            <li>About 380 credits needed · 2,140 available</li>
            <li>Autopilot pauses if credits run out</li>
            <li>Autopilot pauses if an audit gate fails</li>
            <li>Human-approval gates still pause unless turned off in Defaults</li>
          </ul>
        </div>
        <div className="actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={onApprove}>Approve and run</button>
        </div>
      </div>
    </div>
  )
}

function Footer({ blank }: { blank: boolean }) {
  return (
    <footer>
      <div>
        <span className="dot run" />
        <b>{blank ? 'Project setup' : 'Visual generation'}</b> · {blank ? 'just started' : '14 / 22'}
      </div>
      <div>
        <span className="dot ok" />
        {blank ? '0 of 14 steps complete' : 'Narration audio complete'}
      </div>
      <div className="footer-right">
        <span>{blank ? '0 approvals on file' : '4 approvals on file'}</span>
        <span>Project: {blank ? 'Untitled video' : 'Dev Log #06'}</span>
      </div>
    </footer>
  )
}

export default App
