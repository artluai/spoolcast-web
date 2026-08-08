import { useEffect, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { STAGE_DRAFT_OUTPUTS } from '../../data/stage-outputs'
import { useSourceWords, ThinSourceNote } from '../../lib/useSourceWords'
import { useWorkflowStore, type StageProcess } from '../../store/workflow'
import { VisualPacingEditor } from './VisualPacingEditor'
import { WorldKitEditor } from './WorldKitEditor'
import { RulesPanel } from './RulesPanel'
import { activeSession, actionUrl, apiUrl, fileUrl, jobsUrl, statusUrl } from '../../lib/api'
import { DEFAULT_MODEL_ID, draftReasoning } from '../../lib/draft-models'
import { ruleFindingMessage, type RuleFinding } from '../../lib/rule-findings'

// The model catalog + dropdown live in ModelPicker.tsx — ONE list and ONE
// design shared by every AI-suggest button.
type DraftJob = {
  id: string
  status: 'queued' | 'retrying' | 'running' | 'cancelling' | 'cancelled' | 'done' | 'failed'
  error?: string | null
  message?: string | null
  log_tail?: string | null
  result?: {
    ok?: boolean
    error?: string
    message?: string
    rule_findings?: RuleFinding[]
    data?: { rule_findings?: RuleFinding[] }
    details?: { world_kit_fill?: WorldKitFillReport }
  } | null
}
type WorldKitFillReport = {
  mode?: string
  counts?: {
    generated?: number
    reused?: number
    skipped?: number
    failed?: number
  }
}

const JOB_STATE_EVENT_PREFIX = 'SPOOLCAST_JOB_STATE:'

const worldKitFillReportFromJob = (job: DraftJob): WorldKitFillReport | null => {
  const direct = job.result?.details?.world_kit_fill
  if (direct && typeof direct === 'object') return direct

  const lines = String(job.log_tail || '').split('\n').reverse()
  for (const line of lines) {
    if (!line.startsWith(JOB_STATE_EVENT_PREFIX)) continue
    try {
      const details = JSON.parse(line.slice(JOB_STATE_EVENT_PREFIX.length))
      const report = details?.world_kit_fill
      if (report && typeof report === 'object') return report as WorldKitFillReport
    } catch {
      // Ignore unrelated or truncated log lines and keep looking.
    }
  }
  return null
}

/**
 * Draft editor for stages whose contract output is a single drafted file.
 * Default path: AI drafts via the engine (draft_stage → OpenRouter, metered in
 * working/usage-ledger.json). Secondary path: write it yourself (collapsed).
 * Prefills from the engine's real on-disk artifact — never fake data.
 */
export function StageDraftEditor({ stageId }: { stageId: string }) {
  const cfg = STAGE_DRAFT_OUTPUTS[stageId]
  const draft = useWorkflowStore((s) => s.stageDrafts[stageId] ?? '')
  const setStageDraft = useWorkflowStore((s) => s.setStageDraft)
  const seedStageDraft = useWorkflowStore((s) => s.seedStageDraft)
  const stageProcess = useWorkflowStore((s) => s.stageProcesses[stageId] ?? null)
  const setStageProcess = useWorkflowStore((s) => s.setStageProcess)
  const registerStepAIAction = useWorkflowStore((s) => s.registerStepAIAction)
  const [open, setOpen] = useState(false)
  const sourceWords = useSourceWords()
  const [drafting, setDrafting] = useState(false)
  const [draftError, setDraftError] = useState<string | null>(null)
  const [draftWarning, setDraftWarning] = useState<string | null>(null)
  const [completionNote, setCompletionNote] = useState<string | null>(null)
  const [, setDraftJob] = useState<DraftJob | null>(null)
  const pollingJobRef = useRef<string | null>(null)
  const mountedRef = useRef(true)
  const [needRewind, setNeedRewind] = useState(false)
  // Engine truth: a PAID draft button must never look ready on a blocked
  // step — only show it when this stage is current (or content exists).
  const [stageCurrent, setStageCurrent] = useState<boolean | null>(null)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  useEffect(() => {
    fetch(statusUrl())
      .then((r) => (r.ok ? r.json() : null))
      .then((out) => {
        const cur = out?.data?.current_contract_stage?.id
        if (typeof cur === 'string') setStageCurrent(cur === stageId)
      })
      .catch(() => {})
  }, [stageId])
  useEffect(() => {
    if (!stageProcess?.jobId || !['queued', 'running'].includes(stageProcess.status)) return
    if (pollingJobRef.current === stageProcess.jobId) return
    setDrafting(true)
    setDraftJob({ id: stageProcess.jobId, status: stageProcess.status, error: stageProcess.error, message: stageProcess.message })
    void pollDraftJob(stageProcess.jobId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageProcess?.jobId, stageProcess?.status])
  // PROPOSAL: when the AI couldn't stay inside the user's targets after its
  // self-correct retries, the engine saves the last attempt as a *.proposed.md
  // file and the user chooses: keep the current plan, or accept it anyway
  // (an explicit human override is an approval, not a leak).
  const [proposal, setProposal] = useState<{ content: string; issues: string[] } | null>(null)
  // Markdown is RENDERED for reading; clicking the rendered view switches to
  // the raw markdown editor; clicking away renders again.
  const [editing, setEditing] = useState(false)

  // Prefill from the engine's real file — and REFETCH whenever the cached
  // draft is empty (e.g. a background hand-off cleared it so the step reloads
  // fresh content). Never clobber text the user has typed (dirty steps keep
  // their draft).
  useEffect(() => {
    if (!cfg) return
    const store = useWorkflowStore.getState()
    // DIRTY drafts are unsaved user edits — never overwritten. A NON-dirty
    // draft is only a mirror of the file, so when the file moved on (AI
    // update, engine-side rewrite) the mirror re-seeds instead of shadowing
    // the new content forever.
    if (store.dirtySteps[stageId]) {
      setOpen(true)
      return
    }
    if ((store.stageDrafts[stageId] ?? '').length > 0) setOpen(true)
    fetch(fileUrl(cfg.path))
      .then((r) => (r.ok ? r.json() : null))
      .then((out) => {
        if (out?.ok && out.data?.exists && typeof out.data.content === 'string') {
          const current = useWorkflowStore.getState()
          if (!current.dirtySteps[stageId] && (current.stageDrafts[stageId] ?? '') !== out.data.content) {
            seedStageDraft(stageId, out.data.content)
            setOpen(true) // real content exists on disk — show it
          }
        }
      })
      .catch(() => {
        /* engine offline: editor stays blank; the blocker/status UI explains */
      })
  }, [cfg, stageId, seedStageDraft, draft])

  if (!cfg) return null
  const activeProcess = !!stageProcess && ['queued', 'running'].includes(stageProcess.status)
  const processLabel = stageProcess?.label || 'AI is drafting…'
  const isBusy = drafting || activeProcess

  const loadFreshDraft = async () => {
    const fr = await fetch(fileUrl(cfg.path))
    const fileOut = await fr.json().catch(() => null)
    if (fileOut?.ok && fileOut.data?.exists) {
      // setStageDraft (not seed): an AI draft awaiting review counts as an
      // un-approved change, so the step goes dirty until approved.
      setStageDraft(stageId, fileOut.data.content)
      setOpen(true)
      return true
    }
    return false
  }

  const loadWorldKitFillReport = async (): Promise<WorldKitFillReport | null> => {
    try {
      const response = await fetch(fileUrl('working/world-kit-fill.json'))
      const out = await response.json().catch(() => null)
      if (!out?.ok || !out.data?.exists) return null
      const report = JSON.parse(out.data.content || '{}')
      return report && typeof report === 'object' ? report : null
    } catch {
      return null
    }
  }

  const handleDraftFailure = async (out: { error?: string; message?: string } | null) => {
    if (out?.error === 'illegal_action') {
      // Stage already approved and the engine has moved past it. Offer to
      // invalidate (rewind) — the protocol-honest way to re-draft.
      setNeedRewind(true)
      return
    }
    const msg: string = out?.message || ''
    if (msg.includes('PROPOSAL:')) {
      // The draft broke the user's targets even after retries — the engine
      // saved it as a proposal. Offer the human the explicit choice.
      const proposedPath = cfg.path.replace(/\.md$/, '.proposed.md')
      try {
        const pr = await fetch(fileUrl(proposedPath))
        const pOut = await pr.json().catch(() => null)
        if (pOut?.ok && pOut.data?.exists && typeof pOut.data.content === 'string') {
          const issues = msg
            .split('\n')
            .map((l: string) => l.trim())
            .filter((l: string) => l.startsWith('- '))
            .map((l: string) => l.slice(2))
          setProposal({ content: pOut.data.content, issues })
          return
        }
      } catch {
        /* fall through to the plain error */
      }
    }
    setDraftError(out?.message || out?.error || 'Drafting failed.')
  }

  const updateProcess = (job: DraftJob, label = processLabel) => {
    const status: StageProcess['status'] = ['queued', 'retrying'].includes(job.status)
      ? 'queued'
      : ['running', 'cancelling'].includes(job.status)
        ? 'running'
        : job.status === 'done'
          ? 'done'
          : 'failed'
    const next: StageProcess = {
      stageId,
      jobId: job.id,
      status,
      label,
      error: job.error || job.result?.error || null,
      message: job.message || job.result?.message || null,
      updatedAt: new Date().toISOString(),
    }
    setStageProcess(stageId, next)
  }

  const pollDraftJob = async (jobId: string) => {
    pollingJobRef.current = jobId
    for (let i = 0; i < 450; i += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 2000))
      if (!mountedRef.current) {
        pollingJobRef.current = null
        return
      }
      const jr = await fetch(jobsUrl(jobId))
      const jout = await jr.json().catch(() => null)
      if (!jr.ok || jout?.ok === false) {
        setDraftError(jout?.message || jout?.error || 'Could not read draft job status.')
        setStageProcess(stageId, {
          stageId,
          jobId,
          status: 'failed',
          label: processLabel,
          error: jout?.error || 'job_status_failed',
          message: jout?.message || 'Could not read draft job status.',
          updatedAt: new Date().toISOString(),
        })
        setDrafting(false)
        pollingJobRef.current = null
        return
      }
      const job = jout.data as DraftJob
      setDraftJob(job)
      updateProcess(job, job.message || processLabel)
      if (job.status === 'done') {
        const warning = ruleFindingMessage(
          job.result?.data?.rule_findings ?? job.result?.rule_findings,
        )
        setDraftWarning(warning || null)
        if (stageId === 'world_kit') {
          const report = worldKitFillReportFromJob(job) ?? await loadWorldKitFillReport()
          const counts = report?.counts
          if (report?.mode === 'text-only' || report?.mode === 'refresh-text-only') {
            setCompletionNote('World Kit text is ready. Image generation was intentionally skipped.')
          } else if (counts) {
            setCompletionNote(
              `World Kit filled: ${Number(counts.generated || 0)} image${Number(counts.generated || 0) === 1 ? '' : 's'} generated, `
              + `${Number(counts.reused || 0)} reused, ${Number(counts.skipped || 0)} text-only or skipped.`,
            )
          } else {
            setCompletionNote('World Kit fill finished. Review the text and reference images below.')
          }
        }
        if (!(await loadFreshDraft())) setDraftError('Draft finished, but the output file was not found.')
        setStageProcess(stageId, null)
        setDrafting(false)
        pollingJobRef.current = null
        return
      }
      if (job.status === 'failed' || job.status === 'cancelled') {
        await handleDraftFailure({
          error: job.result?.error || job.error || undefined,
          // Queue failures often put the useful traceback in `error` while
          // `message` only says "exited with code N". Surface the real cause.
          message: job.result?.message || job.error || job.message || undefined,
        })
        updateProcess(job)
        setDrafting(false)
        pollingJobRef.current = null
        return
      }
    }
    setDraftError('Draft job is still running. You can leave this page and check back later.')
    setDrafting(false)
    pollingJobRef.current = null
  }

  useEffect(() => {
    if (stageId !== 'world_kit' || stageProcess?.jobId || pollingJobRef.current) return
    let alive = true
    fetch(apiUrl('jobs', {
      session: activeSession(),
      status: 'queued,running',
      limit: 20,
    }))
      .then((response) => (response.ok ? response.json() : null))
      .then((out) => {
        if (!alive) return
        const live = (out?.data?.jobs ?? []).find(
          (job: { kind?: string; status?: string; id?: string }) =>
            job.kind === 'fill_world_kit'
            && ['queued', 'running'].includes(String(job.status || '')),
        )
        if (!live?.id) return
        const job = live as DraftJob
        setDrafting(true)
        setDraftJob(job)
        setStageProcess(stageId, {
          stageId,
          jobId: job.id,
          status: job.status === 'running' ? 'running' : 'queued',
          label: job.message || 'AI is filling the World Kit…',
          error: job.error || null,
          message: job.message || null,
          updatedAt: new Date().toISOString(),
        })
        void pollDraftJob(job.id)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
    // pollDraftJob intentionally follows the current mounted editor instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageId, stageProcess?.jobId])

  const runDraft = async (
    feedback = '',
    requestedModel = DEFAULT_MODEL_ID,
    requestedMode = '',
    refreshExisting = false,
  ) => {
    setDrafting(true)
    setDraftError(null)
    setDraftWarning(null)
    setCompletionNote(null)
    setDraftJob(null)
    try {
      if (stageId === 'world_kit') {
        const textOnly = requestedMode === 'text_only'
        const res = await fetch(actionUrl(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session: activeSession(),
            tenant: 'local',
            action: 'fill_world_kit',
            text_only: textOnly,
            refresh_existing: refreshExisting,
            model: requestedModel,
            allow_cost: true,
            ...(feedback.trim() ? { feedback: feedback.trim() } : {}),
            ...(draftReasoning(requestedModel) ? { reasoning: draftReasoning(requestedModel) } : {}),
          }),
        })
        const out = await res.json().catch(() => null)
        const jobId = String(out?.data?.job_id || '')
        if (!res.ok || out?.ok === false || !jobId) {
          await handleDraftFailure(out)
          return
        }
        const job: DraftJob = { id: jobId, status: 'queued' }
        const label = refreshExisting
          ? textOnly
            ? 'AI is refreshing the World Kit text…'
            : 'AI is refreshing the World Kit and creating new image versions…'
          : textOnly
            ? 'AI is drafting the World Kit text…'
            : 'AI is filling the World Kit and creating missing images…'
        setDraftJob(job)
        setStageProcess(stageId, {
          stageId,
          jobId,
          status: 'queued',
          label,
          error: null,
          message: null,
          updatedAt: new Date().toISOString(),
        })
        await pollDraftJob(jobId)
        return
      }
      // Long-running drafts go through the jobs queue instead of the
      // synchronous 180s action path: pacing plans can be large.
      const useJob = stageId === 'visual_pacing'
      const res = await fetch(useJob ? jobsUrl() : actionUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: activeSession(),
          tenant: 'local',
          ...(useJob ? { kind: 'draft_stage' } : { action: 'draft_stage' }),
          stage_id: stageId,
          model: requestedModel,
          allow_cost: true,
          ...(feedback.trim() ? { feedback: feedback.trim() } : {}),
          ...(draftReasoning(requestedModel) ? { reasoning: draftReasoning(requestedModel) } : {}),
        }),
      })
      const out = await res.json().catch(() => null)
      if (!res.ok || out?.ok === false) {
        await handleDraftFailure(out)
        return
      }
      if (useJob) {
        const job = out.data as DraftJob
        setDraftJob(job)
        setStageProcess(stageId, {
          stageId,
          jobId: job.id,
          status: job.status === 'running' ? 'running' : 'queued',
          label: 'AI is drafting the visual pacing plan…',
          error: null,
          message: null,
          updatedAt: new Date().toISOString(),
        })
        await pollDraftJob(job.id)
      } else {
        const warning = ruleFindingMessage(out?.data?.rule_findings)
        setDraftWarning(warning || null)
        // Pull the freshly written file and show it for review/editing.
        await loadFreshDraft()
      }
    } catch {
      setDraftError('Could not reach the engine.')
    } finally {
      setDrafting(false)
    }
  }

  const rewindAndDraft = async () => {
    setNeedRewind(false)
    try {
      const res = await fetch(actionUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: activeSession(),
          tenant: 'local',
          action: 'rewind_stage',
          stage_id: stageId,
          // Re-drafting THIS stage overwrites its own file — later steps'
          // work (e.g. a cast World Kit) survives; only approvals reset.
          keep_files: true,
        }),
      })
      const out = await res.json().catch(() => null)
      if (!res.ok || out?.ok === false) {
        setDraftError(out?.message || out?.error || 'Could not invalidate the stage.')
        return
      }
      await runDraft()
    } catch {
      setDraftError('Could not reach the engine.')
    }
  }

  useEffect(() => {
    if (!cfg.aiDraft) {
      registerStepAIAction(stageId, null)
      return
    }
    registerStepAIAction(stageId, {
      stageId,
      label: draft.trim() ? 'Update with AI' : 'Complete step with AI',
      ...(stageId === 'world_kit' ? {
        label: 'Fill with AI',
        busyLabel: 'Filling World Kit…',
        modes: [
          {
            id: 'complete',
            label: 'Complete World Kit',
            description: 'Draft text and create only missing or stale images.',
            actionLabel: 'Fill with AI',
          },
          {
            id: 'text_only',
            label: 'Text only',
            description: 'Draft the plan without generating images.',
            actionLabel: 'Draft text only',
          },
        ],
        defaultMode: 'complete',
      } : {}),
      busy: isBusy,
      disabled: !(stageCurrent || Boolean(draft.trim())),
      disabledReason: 'Complete the earlier step first',
      usesTextModel: true,
      run: ({ instructions, model, mode, refreshExisting }) => (
        runDraft(instructions, model, mode, Boolean(refreshExisting))
      ),
    })
    return () => registerStepAIAction(stageId, null)
  }, [cfg.aiDraft, draft, isBusy, registerStepAIAction, stageCurrent, stageId])

  return (
    <div style={{ marginBottom: 24 }}>
      {proposal && (
        <div className="modal-scrim">
          <div className="confirm-modal">
            <span className="need">YOUR CALL</span>
            <h3>The AI couldn’t stay inside your targets</h3>
            <p>
              It tried {`3 times`} and the best attempt still breaks the limits you set. Your
              current plan is untouched — you choose what happens with the new draft.
            </p>
            {proposal.issues.length > 0 && (
              <div className="check">
                <b>What’s over the line</b>
                <ul>
                  {proposal.issues.slice(0, 6).map((issue, i) => (
                    <li key={i}>{issue}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="actions">
              <button onClick={() => setProposal(null)}>Keep my current plan</button>
              <button
                className="primary"
                onClick={() => {
                  // Accepting an over-target draft is an explicit human
                  // decision — it lands as an unsaved edit you still review.
                  setStageDraft(stageId, proposal.content)
                  setOpen(true)
                  setProposal(null)
                }}
              >
                Use it anyway
              </button>
            </div>
          </div>
        </div>
      )}
      {needRewind && (
        <div style={{ marginBottom: 16 }}>
          <p style={{ color: 'var(--amber)', fontSize: 13, margin: '0 0 10px', lineHeight: 1.5 }}>
            This step is already approved. Making a new draft will <b>un-approve it and every step
            after it</b> — you’ll review and approve them again as you go.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="save-continue" style={{ width: 'auto', padding: '8px 14px' }} onClick={rewindAndDraft}>
              Un-approve & make a new draft
            </button>
            <button
              style={{ background: 'none', border: '1px solid var(--line, #2a3142)', borderRadius: 6, color: 'var(--ink-2)', padding: '8px 14px', cursor: 'pointer', fontSize: 13 }}
              onClick={() => setNeedRewind(false)}
            >
              Never mind, keep it
            </button>
          </div>
        </div>
      )}
      {!needRewind && cfg.structured !== 'pacing' && !cfg.aiDraft ? (
        <p style={{ color: 'var(--ink-2)', fontSize: 13, margin: '0 0 10px' }}>
          AI drafting for this step isn’t wired up yet — write it below for now.
        </p>
      ) : null}
      {!needRewind && draftError ? (
        <p style={{ color: 'var(--red)', fontSize: 13, margin: '0 0 10px' }}>Engine: {draftError}</p>
      ) : null}
      {!needRewind && draftWarning ? (
        <p style={{ color: 'var(--amber)', fontSize: 13, margin: '0 0 10px', lineHeight: 1.5 }}>
          Rule check: {draftWarning} The draft was kept so you can review or edit it.
        </p>
      ) : null}
      {!needRewind && completionNote ? (
        <p style={{ color: 'var(--green)', fontSize: 13, margin: '0 0 10px', lineHeight: 1.5 }}>
          {completionNote}
        </p>
      ) : null}
      {!needRewind && ['input_intake', 'story_lock', 'format_setup'].includes(stageId) ? (
        <ThinSourceNote words={sourceWords} />
      ) : null}
      {needRewind ? null : (
        <div style={{ position: 'relative' }}>
          {isBusy ? (
            <div style={{ position: 'absolute', inset: 0, zIndex: 3, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, background: 'rgba(10,12,18,.45)', borderRadius: 8, minHeight: 120 }}>
              <span className="spin" />
              <span style={{ color: 'var(--ink-1)', fontSize: 13 }}>{processLabel}</span>
            </div>
          ) : null}
          <div style={isBusy ? { opacity: 0.4, pointerEvents: 'none' } : undefined}>
            {cfg.structured === 'pacing' ? (
              // STRUCTURED MODE (visual pacing): timeline/table/script views over the
              // plan markdown — parse → edit → serialize, same draft the engine reads.
              // The redraft control renders INSIDE the editor, below Overlays.
              <VisualPacingEditor stageId={stageId} aiUpdate={Boolean(cfg.aiDraft && draft.trim())} />
            ) : cfg.structured === 'worldkit' ? (
              // STRUCTURED MODE (world kit): per-item editor with scope-aware remove
              // warnings, undo, and reset-to-default — always visible when content exists.
              <WorldKitEditor stageId={stageId} refreshToken={completionNote || ''} />
            ) : (
              <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          color: 'var(--ink-2)',
          fontSize: 13,
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <span style={{ fontSize: 10 }}>{open ? '▾' : '▸'}</span>
        {cfg.aiDraft ? 'Review or write it yourself' : 'Write it yourself'}
        <span className="label" style={{ marginLeft: 8 }}>{cfg.path}</span>
      </button>
      {open && (
        <>
          {draft.trim() && !editing ? (
            // READ MODE: rendered markdown. Click anywhere to edit the raw .md.
            <div
              className="md-preview"
              title="Click to edit"
              onClick={() => setEditing(true)}
              style={{
                marginTop: 10,
                border: '1px solid var(--line, #2a3142)',
                borderRadius: 8,
                padding: '4px 16px',
                cursor: 'text',
              }}
              dangerouslySetInnerHTML={{
                __html: DOMPurify.sanitize(marked.parse(draft, { async: false }) as string),
              }}
            />
          ) : (
            // EDIT MODE: raw markdown. Clicking away returns to the rendered view.
            <textarea
              className="raw-source-textarea"
              autoFocus={editing}
              value={draft}
              placeholder={cfg.placeholder}
              onChange={(e) => setStageDraft(stageId, e.target.value)}
              onBlur={() => setEditing(false)}
              style={{
                width: '100%',
                minHeight: 240,
                minWidth: 360,
                maxWidth: '100%',
                marginTop: 10,
                resize: 'both',
                background: 'transparent',
                color: 'var(--ink-1, inherit)',
                border: '1px solid var(--line, #2a3142)',
                borderRadius: 8,
                padding: 12,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: 13,
                lineHeight: 1.55,
              }}
            />
          )}
          <span className="label" style={{ display: 'block', marginTop: 6 }}>
            {draft.trim() && !editing ? 'Click the text to edit the raw markdown · ' : ''}
            Saved to the engine on “Approve & continue” — this is the stage’s real contract output.
          </span>
              </>
            )}
              </>
            )}
          </div>
        </div>
      )}
      {/* Every AI-drafted step gets its RULES panel — one quality list:
          rules steer each draft AND the step's review grades against them. */}
      {cfg?.aiDraft && <RulesPanel step={stageId} />}
    </div>
  )
}
