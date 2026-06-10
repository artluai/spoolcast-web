import { useEffect, useRef, useState } from 'react'
import { STAGE_DRAFT_OUTPUTS } from '../../data/stage-outputs'
import { useWorkflowStore } from '../../store/workflow'

// Selectable OpenRouter models for AI drafting. The id is sent to the engine;
// pricing tiers will hang off this list when the credit system lands.
const DRAFT_MODELS = [
  { id: 'qwen/qwen-2.5-72b-instruct', label: 'Qwen 2.5 72B (default)' },
  { id: 'deepseek/deepseek-chat', label: 'DeepSeek' },
  { id: 'anthropic/claude-3.5-haiku', label: 'Claude Haiku' },
  { id: 'openai/gpt-4o-mini', label: 'GPT-4o mini' },
]

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
  const seededRef = useRef(false)
  const [open, setOpen] = useState(false)
  const [model, setModel] = useState(DRAFT_MODELS[0].id)
  const [confirming, setConfirming] = useState(false)
  const [drafting, setDrafting] = useState(false)
  const [draftError, setDraftError] = useState<string | null>(null)
  const [needRewind, setNeedRewind] = useState(false)

  // Prefill once per mount from the engine's real file — but never clobber
  // text the user has already typed (dirty steps keep their draft).
  useEffect(() => {
    if (!cfg || seededRef.current) return
    seededRef.current = true
    const store = useWorkflowStore.getState()
    if ((store.stageDrafts[stageId] ?? '').length > 0 || store.dirtySteps[stageId]) {
      setOpen(true)
      return
    }
    fetch(
      `http://localhost:8000/api/file?session=spoolcast-dev-log-12&path=${encodeURIComponent(cfg.path)}`,
    )
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
  }, [cfg, stageId, seedStageDraft])

  if (!cfg) return null

  const runDraft = async () => {
    setConfirming(false)
    setDrafting(true)
    setDraftError(null)
    try {
      const res = await fetch('http://localhost:8000/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: 'spoolcast-dev-log-12',
          tenant: 'local',
          action: 'draft_stage',
          stage_id: stageId,
          model,
          allow_cost: true, // user clicked the explicit confirm
        }),
      })
      const out = await res.json().catch(() => null)
      if (!res.ok || out?.ok === false) {
        if (out?.error === 'illegal_action') {
          // Stage already approved and the engine has moved past it. Offer to
          // invalidate (rewind) — the protocol-honest way to re-draft.
          setNeedRewind(true)
          return
        }
        setDraftError(out?.message || out?.error || 'Drafting failed.')
        return
      }
      // Pull the freshly written file and show it for review/editing.
      const fr = await fetch(
        `http://localhost:8000/api/file?session=spoolcast-dev-log-12&path=${encodeURIComponent(cfg.path)}`,
      )
      const fileOut = await fr.json().catch(() => null)
      if (fileOut?.ok && fileOut.data?.exists) {
        // setStageDraft (not seed): an AI draft awaiting review counts as an
        // un-approved change, so the step goes dirty until approved.
        setStageDraft(stageId, fileOut.data.content)
        setOpen(true)
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
      const res = await fetch('http://localhost:8000/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: 'spoolcast-dev-log-12',
          tenant: 'local',
          action: 'rewind_stage',
          stage_id: stageId,
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
      {needRewind && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          <span style={{ color: 'var(--amber)', fontSize: 13 }}>
            This step is already approved. Re-drafting will revoke its approval and every approval
            after it — later steps go back to pending and need re-approval.
          </span>
          <button className="save-continue" style={{ width: 'auto', padding: '8px 14px' }} onClick={rewindAndDraft}>
            Invalidate & re-draft
          </button>
          <button
            style={{ background: 'none', border: '1px solid var(--line, #2a3142)', borderRadius: 6, color: 'var(--ink-2)', padding: '8px 14px', cursor: 'pointer', fontSize: 13 }}
            onClick={() => setNeedRewind(false)}
          >
            Cancel
          </button>
        </div>
      )}
      {cfg.aiDraft ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          {!confirming ? (
            <>
              <button
                className="save-continue"
                style={{ width: 'auto', padding: '10px 18px' }}
                disabled={drafting}
                onClick={() => setConfirming(true)}
              >
                ✦ {drafting ? 'Drafting…' : draft.trim() ? 'Re-draft with AI' : 'Draft with AI'}
              </button>
              <select
                value={model}
                disabled={drafting}
                onChange={(e) => setModel(e.target.value)}
                style={{
                  background: 'transparent',
                  color: 'var(--ink-2)',
                  border: '1px solid var(--line, #2a3142)',
                  borderRadius: 6,
                  padding: '8px 10px',
                  fontSize: 13,
                }}
              >
                {DRAFT_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
              <span className="label">drafts from your earlier steps · uses model credits</span>
            </>
          ) : (
            <>
              <span style={{ color: 'var(--ink-2)', fontSize: 13 }}>
                Run {DRAFT_MODELS.find((m) => m.id === model)?.label} on your source material?
                {draft.trim() ? ' This replaces the current draft below.' : ''} Small model cost applies.
              </span>
              <button className="save-continue" style={{ width: 'auto', padding: '8px 14px' }} onClick={runDraft}>
                Generate
              </button>
              <button
                style={{ background: 'none', border: '1px solid var(--line, #2a3142)', borderRadius: 6, color: 'var(--ink-2)', padding: '8px 14px', cursor: 'pointer', fontSize: 13 }}
                onClick={() => setConfirming(false)}
              >
                Cancel
              </button>
            </>
          )}
          {draftError && (
            <span style={{ color: 'var(--red)', fontSize: 13, flexBasis: '100%' }}>Engine: {draftError}</span>
          )}
        </div>
      ) : (
        <p style={{ color: 'var(--ink-2)', fontSize: 13, margin: '0 0 10px' }}>
          AI drafting for this step isn’t wired up yet — write it below for now.
        </p>
      )}
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
          <textarea
            value={draft}
            placeholder={cfg.placeholder}
            onChange={(e) => setStageDraft(stageId, e.target.value)}
            style={{
              width: '100%',
              minHeight: 240,
              marginTop: 10,
              resize: 'vertical',
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
          <span className="label" style={{ display: 'block', marginTop: 6 }}>
            Saved to the engine on “Approve & continue” — this is the stage’s real contract output.
          </span>
        </>
      )}
    </div>
  )
}
