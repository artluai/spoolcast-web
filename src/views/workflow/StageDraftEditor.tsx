import { useEffect, useRef, useState } from 'react'
import { STAGE_DRAFT_OUTPUTS } from '../../data/stage-outputs'
import { useWorkflowStore } from '../../store/workflow'

/**
 * Draft editor for stages whose contract output is a single drafted file
 * (structure, visual pacing). Prefills from the engine's real on-disk artifact
 * via GET /api/file — never fake data — and writes back via set_stage_output
 * when the user saves (handled in App.tsx onAdvance).
 *
 * UX rules (per Romy):
 * - No box-in-box: the textarea is the only box; the step panel is the frame.
 * - AI drafting will be the default path for these stages; writing it yourself
 *   is the secondary option, collapsed by default (auto-expanded when content
 *   already exists on disk or the user has typed).
 */
export function StageDraftEditor({ stageId }: { stageId: string }) {
  const cfg = STAGE_DRAFT_OUTPUTS[stageId]
  const draft = useWorkflowStore((s) => s.stageDrafts[stageId] ?? '')
  const setStageDraft = useWorkflowStore((s) => s.setStageDraft)
  const seedStageDraft = useWorkflowStore((s) => s.seedStageDraft)
  const seededRef = useRef(false)
  const [open, setOpen] = useState(false)

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

  return (
    <div style={{ marginBottom: 24 }}>
      {/* AI drafting is the intended default for this stage. Not wired up yet —
          stated honestly rather than faked with a dead button. */}
      <p style={{ color: 'var(--ink-2)', fontSize: 13, margin: '0 0 10px' }}>
        AI will draft the {cfg.label.toLowerCase()} from the earlier steps — that flow lands next.
        Until then, write it yourself below.
      </p>
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
        Write it yourself
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
