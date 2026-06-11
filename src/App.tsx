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
import { castByShow } from './data/cast'
import { buildGates, buildStepsFromContract } from './lib/workflow-graph'
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
    // Light polling so the UI tracks engine changes (rewinds, drafts, external
    // script runs) without a manual refresh.
    const interval = setInterval(fetchStatus, 5000)
    return () => clearInterval(interval)
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
  const isRules = route.endsWith('/rules')
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
        if (isWorldKit || isRules) navigate(`/p/${setupMode === 'series' ? 'dev-log-12' : 'new'}`)
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
      onRules={() => navigate(`/p/${setupMode === 'series' ? 'dev-log-12' : 'new'}/rules`)}
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
                onAdvance={async (id: string, opts?: { aiHandoff?: boolean }): Promise<boolean> => {
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
                    if (wasAlreadyPassed) {
                      const rw = await fetch('http://localhost:8000/api/action', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          session: 'spoolcast-dev-log-12',
                          tenant: 'local',
                          action: 'rewind_stage',
                          stage_id: sourceId,
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
                      if (s1Now.length > 0) {
                        await fetch('http://localhost:8000/api/action', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            session: 'spoolcast-dev-log-12',
                            tenant: 'local',
                            action: 'set_session_fields',
                            fields: { target_length_s: s1Now.length },
                          }),
                        }).catch(() => {})
                      }
                    }
                    if (sourceId === 'input_intake') {
                      // The idea brief is source material — write it to source/.
                      const ideaBrief = useWorkflowStore.getState().ideaBrief
                      if (ideaBrief.trim().length > 0) {
                        const toB64 = (s: string) => btoa(unescape(encodeURIComponent(s)))
                        const up = await fetch('http://localhost:8000/api/action', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            session: 'spoolcast-dev-log-12',
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
                        const so = await fetch('http://localhost:8000/api/action', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            session: 'spoolcast-dev-log-12',
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
                    if (sourceId === 'story_lock') {
                      // The core message is the stage's contract output — record it in session.json.
                      const goal = useWorkflowStore.getState().goal
                      if (goal.text.trim().length > 0) {
                        const cm = await fetch('http://localhost:8000/api/action', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            session: 'spoolcast-dev-log-12',
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
                        res = await fetch('http://localhost:8000/api/action', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            session: 'spoolcast-dev-log-12',
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
                        res = await fetch('http://localhost:8000/api/action', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            session: 'spoolcast-dev-log-12',
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
                        const r = await fetch('http://localhost:8000/api/status?session=spoolcast-dev-log-12&tenant=local')
                        if (r.ok) {
                          const apiData = await r.json()
                          setApiStatus(apiData)
                          setSteps(buildStepsFromContract(initialStandalone, apiData.data))
                          setGates(buildGates(initialStandalone, apiData.data))
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
                              : { stage_id: 'shot_list_json', variant: undefined, busy: 'AI is compiling the storyboard from the pacing plan…', done: 'Storyboard built and validated.', fail: 'Storyboard build failed' }
                      useWorkflowStore.getState().setHandoff({ stageId: handoff.stage_id, label: handoff.busy })
                      ;(async () => {
                        try {
                          const r = await fetch('http://localhost:8000/api/action', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                              session: 'spoolcast-dev-log-12',
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
                            const res2 = await fetch('http://localhost:8000/api/status?session=spoolcast-dev-log-12&tenant=local')
                            if (res2.ok) {
                              const apiData = await res2.json()
                              setApiStatus(apiData)
                              setSteps(buildStepsFromContract(initialStandalone, apiData.data))
                              setGates(buildGates(initialStandalone, apiData.data))
                            }
                          } catch { /* polling will catch up */ }
                        }
                      })()
                    }
                    }

                    // 3. REFRESH: the UI reflects the engine's new state (green gate, statuses, no warning).
                    const res = await fetch('http://localhost:8000/api/status?session=spoolcast-dev-log-12&tenant=local')
                    if (res.ok) {
                      const apiData = await res.json()
                      setApiStatus(apiData)
                      setSteps(buildStepsFromContract(initialStandalone, apiData.data))
                      setGates(buildGates(initialStandalone, apiData.data))
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
            element={<WorldKitView castData={castData} showName={showName} />}
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
