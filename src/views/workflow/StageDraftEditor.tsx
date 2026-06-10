import { useEffect, useRef } from 'react'
import { STAGE_DRAFT_OUTPUTS } from '../../data/stage-outputs'
import { useWorkflowStore } from '../../store/workflow'

/**
 * Draft editor for stages whose contract output is a single drafted file
 * (structure, world kit, visual pacing). Prefills from the engine's real
 * on-disk artifact via GET /api/file — never fake data — and writes back via
 * set_stage_output when the user saves (handled in App.tsx onAdvance).
 */
export function StageDraftEditor({ stageId }: { stageId: string }) {
  const cfg = STAGE_DRAFT_OUTPUTS[stageId]
  const draft = useWorkflowStore((s) => s.stageDrafts[stageId] ?? '')
  const setStageDraft = useWorkflowStore((s) => s.setStageDraft)
  const seedStageDraft = useWorkflowStore((s) => s.seedStageDraft)
  const seededRef = useRef(false)

  // Prefill once per mount from the engine's real file — but never clobber
  // text the user has already typed (dirty steps keep their draft).
  useEffect(() => {
    if (!cfg || seededRef.current) return
    seededRef.current = true
    const store = useWorkflowStore.getState()
    if ((store.stageDrafts[stageId] ?? '').length > 0 || store.dirtySteps[stageId]) return
    fetch(
      `http://localhost:8000/api/file?session=spoolcast-dev-log-12&path=${encodeURIComponent(cfg.path)}`,
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((out) => {
        if (out?.ok && out.data?.exists && typeof out.data.content === 'string') {
          const current = useWorkflowStore.getState()
          if ((current.stageDrafts[stageId] ?? '').length === 0 && !current.dirtySteps[stageId]) {
            seedStageDraft(stageId, out.data.content)
          }
        }
      })
      .catch(() => {
        /* engine offline: editor stays blank; the blocker/status UI explains */
      })
  }, [cfg, stageId, seedStageDraft])

  if (!cfg) return null

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="ch" style={{ marginBottom: 10 }}>
        <h3>{cfg.label}</h3>
        <span className="label">{cfg.path}</span>
      </div>
      <textarea
        value={draft}
        placeholder={cfg.placeholder}
        onChange={(e) => setStageDraft(stageId, e.target.value)}
        style={{
          width: '100%',
          minHeight: 260,
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
      <span className="label" style={{ display: 'block', marginTop: 8 }}>
        Saved to the engine on “Save / Approve & continue”. This is the stage’s real contract output —
        no placeholder data.
      </span>
    </div>
  )
}
