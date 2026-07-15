import { useEffect, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { STAGE_DRAFT_OUTPUTS } from '../../data/stage-outputs'
import { FeedbackButton } from './FeedbackButton'
import { useSourceWords, ThinSourceNote } from '../../lib/useSourceWords'
import { useWorkflowStore, type StageProcess } from '../../store/workflow'
import { VisualPacingEditor } from './VisualPacingEditor'
import { WorldKitEditor } from './WorldKitEditor'
import { activeSession, actionUrl, fileUrl, jobsUrl, statusUrl } from '../../lib/api'
import { ModelPicker } from './ModelPicker'
import { DEFAULT_MODEL_ID, draftReasoning } from '../../lib/draft-models'

// The model catalog + dropdown live in ModelPicker.tsx — ONE list and ONE
// design shared by every AI-suggest button.
type DraftJob = {
  id: string
  status: 'queued' | 'running' | 'done' | 'failed'
  error?: string | null
  message?: string | null
  result?: { ok?: boolean; error?: string; message?: string } | null
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
  const [open, setOpen] = useState(false)
  const sourceWords = useSourceWords()
  const [model, setModel] = useState(DEFAULT_MODEL_ID)
  const [drafting, setDrafting] = useState(false)
  const [draftError, setDraftError] = useState<string | null>(null)
  const [draftJob, setDraftJob] = useState<DraftJob | null>(null)
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
    if ((store.stageDrafts[stageId] ?? '').length > 0 || store.dirtySteps[stageId]) {
      setOpen(true)
      return
    }
    fetch(fileUrl(cfg.path))
      .then((r) => (r.ok ? r.json() : null))
      .then((out) => {
        if (out?.ok && out.data?.exists && typeof out.data.content === 'string') {
          const current = useWorkflowStore.getState()
          if ((current.stageDrafts[stageId] ?? '').length === 0 && !current.dirtySteps[stageId]) {
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
    const next: StageProcess = {
      stageId,
      jobId: job.id,
      status: job.status,
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
        pollingJobRef.current = null
        return
      }
      const job = jout.data as DraftJob
      setDraftJob(job)
      updateProcess(job)
      if (job.status === 'done') {
        if (!(await loadFreshDraft())) setDraftError('Draft finished, but the output file was not found.')
        setStageProcess(stageId, null)
        pollingJobRef.current = null
        return
      }
      if (job.status === 'failed') {
        await handleDraftFailure(job.result || { error: job.error || undefined, message: job.message || undefined })
        updateProcess(job)
        pollingJobRef.current = null
        return
      }
    }
    setDraftError('Draft job is still running. You can leave this page and check back later.')
    pollingJobRef.current = null
  }

  const runDraft = async (feedback = '') => {
    setDrafting(true)
    setDraftError(null)
    setDraftJob(null)
    try {
      const useJob = stageId === 'visual_pacing'
      const res = await fetch(useJob ? jobsUrl() : actionUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: activeSession(),
          tenant: 'local',
          ...(useJob ? { kind: 'draft_stage' } : { action: 'draft_stage' }),
          stage_id: stageId,
          model,
          allow_cost: true,
          ...(feedback.trim() ? { feedback: feedback.trim() } : {}),
          ...(draftReasoning(model) ? { reasoning: draftReasoning(model) } : {}),
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
          status: job.status,
          label: 'AI is drafting the visual pacing plan…',
          error: null,
          message: null,
          updatedAt: new Date().toISOString(),
        })
        await pollDraftJob(job.id)
      } else {
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
      {!needRewind && cfg.aiDraft && (stageCurrent || draft.trim()) ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          <FeedbackButton
            label={draft.trim() ? 'Re-draft with AI' : 'Draft with AI'}
            busy={isBusy}
            busyLabel={(draftJob?.status || stageProcess?.status) === 'queued' ? 'Queued…' : 'Working…'}
            title="Runs the AI — uses model credits"
            rulesFocus={stageId === 'structure' ? 'story' : stageId === 'world_kit' ? 'visuals' : stageId === 'visual_pacing' ? 'visual-pacing' : 'series-rules'}
            historyKey={`draft-notes-${stageId.replace(/_/g, '-')}`}
            onRun={(fb) => runDraft(fb)}
          />
          <ModelPicker model={model} onChange={setModel} disabled={isBusy} />
          <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>uses model credits</span>
          {(draftJob || stageProcess) && isBusy && (
            <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>
              job {draftJob?.status || stageProcess?.status}
            </span>
          )}
          <ThinSourceNote words={sourceWords} />
          {draftError && (
            <span style={{ color: 'var(--red)', fontSize: 13, flexBasis: '100%' }}>Engine: {draftError}</span>
          )}
        </div>
      ) : !needRewind ? (
        <p style={{ color: 'var(--ink-2)', fontSize: 13, margin: '0 0 10px' }}>
          AI drafting for this step isn’t wired up yet — write it below for now.
        </p>
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
              <VisualPacingEditor stageId={stageId} />
            ) : cfg.structured === 'worldkit' ? (
              // STRUCTURED MODE (world kit): per-item editor with scope-aware remove
              // warnings, undo, and reset-to-default — always visible when content exists.
              <WorldKitEditor stageId={stageId} path={cfg.path} />
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
    </div>
  )
}
