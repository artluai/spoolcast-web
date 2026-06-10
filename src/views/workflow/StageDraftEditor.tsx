import { useEffect, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { STAGE_DRAFT_OUTPUTS } from '../../data/stage-outputs'
import { FeedbackButton } from './FeedbackButton'
import { useSourceWords, ThinSourceNote } from '../../lib/useSourceWords'
import { useWorkflowStore } from '../../store/workflow'
import { WorldKitEditor } from './WorldKitEditor'

// Selectable OpenRouter models for AI drafting. The id is sent to the engine;
// pricing tiers will hang off this list when the credit system lands.
// Three everyday choices up front; the rest live behind "More models".
// `reasoning` overrides the engine default where it saves money (Opus bills
// its thinking tokens at full output rate — medium is the sweet spot).
type DraftModel = { id: string; label: string; desc: string; reasoning?: string }
const PRIMARY_MODELS: DraftModel[] = [
  { id: 'qwen/qwen3.7-plus', label: 'Qwen 3.7 fast', desc: 'best value — the default' },
  { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek v4 flash', desc: 'cheapest, quick drafts' },
  { id: 'anthropic/claude-opus-4.8', label: 'Claude Opus 4.8', desc: 'best writing, costs the most', reasoning: 'medium' },
]
const MORE_MODELS: DraftModel[] = [
  { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek v4 pro', desc: 'strong thinker, still cheap' },
  { id: 'openai/gpt-5-mini', label: 'GPT-5 mini', desc: 'balanced all-rounder' },
  { id: 'qwen/qwen3.7-max', label: 'Qwen 3.7 max', desc: 'stronger Qwen, mid price' },
  { id: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5', desc: 'high quality, mid price' },
]
const ALL_MODELS = [...PRIMARY_MODELS, ...MORE_MODELS]

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
  const sourceWords = useSourceWords()
  const [model, setModel] = useState(PRIMARY_MODELS[0].id)
  const [modelMenu, setModelMenu] = useState(false)
  const [showMore, setShowMore] = useState(false)
  const [drafting, setDrafting] = useState(false)
  const [draftError, setDraftError] = useState<string | null>(null)
  const [needRewind, setNeedRewind] = useState(false)
  // Markdown is RENDERED for reading; clicking the rendered view switches to
  // the raw markdown editor; clicking away renders again.
  const [editing, setEditing] = useState(false)

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

  const runDraft = async (feedback = '') => {
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
          allow_cost: true,
          ...(feedback.trim() ? { feedback: feedback.trim() } : {}),
          ...(ALL_MODELS.find((m) => m.id === model)?.reasoning
            ? { reasoning: ALL_MODELS.find((m) => m.id === model)!.reasoning }
            : {}),
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
      {!needRewind && cfg.aiDraft ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          <FeedbackButton
            label={draft.trim() ? 'Re-draft with AI' : 'Draft with AI'}
            busy={drafting}
            title="Runs the AI — uses model credits"
            onRun={(fb) => runDraft(fb)}
          />
          <span style={{ position: 'relative' }}>
            <button
              type="button"
              className="vp-menu-btn"
              disabled={drafting}
              onClick={() => { setModelMenu((v) => !v); setShowMore(false) }}
              style={{ fontSize: 12, padding: '8px 12px' }}
            >
              {ALL_MODELS.find((m) => m.id === model)?.label ?? model} ▾
            </button>
            {modelMenu && (
              <>
                <span className="vp-menu-backdrop" onClick={() => setModelMenu(false)} />
                <span className="vp-menu" style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, minWidth: 250 }}>
                  <span className="vp-menu-h">MODEL</span>
                  {(showMore ? ALL_MODELS : PRIMARY_MODELS).map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => { setModel(m.id); setModelMenu(false) }}
                      style={m.id === model ? { background: 'var(--bg-3)' } : undefined}
                    >
                      {m.label}
                      <span style={{ display: 'block', color: 'var(--ink-3)', fontSize: 11 }}>{m.desc}</span>
                    </button>
                  ))}
                  {!showMore && (
                    <>
                      <span className="vp-menu-div" style={{ display: 'block' }} />
                      <button type="button" onClick={() => setShowMore(true)}>More models ▸</button>
                    </>
                  )}
                </span>
              </>
            )}
          </span>
          <span className="label">
            drafts from your earlier steps · uses model credits{draft.trim() ? ' · replaces the text' : ''}
          </span>
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
      {needRewind ? null : cfg.structured ? (
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
  )
}
