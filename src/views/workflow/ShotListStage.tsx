import { useEffect, useRef, useState } from 'react'
import { FeedbackButton } from './FeedbackButton'
import { useWorkflowStore } from '../../store/workflow'

// STORYBOARD (step 08): the machine-precise lens over the pacing plan.
// The engine compiles shot-list/shot-list.json (code-law structure, AI polish,
// validated + xlsx in the same operation); this screen is the review desk:
// timeline of chunks, click one to open its full work order, free re-check
// after edits, and approval gates the steps where image money starts.

type Beat = { id: string; narration: string }
type Chunk = {
  id: string
  scene?: string
  scene_title?: string
  summary?: string
  boundary_kind?: string
  weight?: string
  visual_direction?: string
  references?: string[]
  on_screen_text?: string[]
  frame_design_receipt?: { first_read?: string; physical_action?: string; visual_contrast?: string; detail_anchors?: string[] }
  beats?: Beat[]
  overlays?: { id?: string; source?: string; trigger?: string; duration_s?: number }[]
  reaction_candidate?: boolean
  reaction_note?: string
  [k: string]: unknown
}
type ShotList = { session_id?: string; canvas?: { aspect_ratio?: string; fps?: number }; notes?: string; chunks: Chunk[]; [k: string]: unknown }

type Audit = { passed?: boolean; findings?: string; stderr?: string } | null

const WORDS_PER_SEC = 2.5
const SESSION = 'spoolcast-dev-log-12'
const FILE_PATH = 'shot-list/shot-list.json'

const estSec = (c: Chunk) =>
  Math.max(1, (c.beats ?? []).reduce((n, b) => n + (b.narration ?? '').split(/\s+/).filter(Boolean).length, 0) / WORDS_PER_SEC)

export function ShotListStage({ stageId }: { stageId: string }) {
  const draft = useWorkflowStore((s) => s.stageDrafts[stageId] ?? '')
  const setStageDraft = useWorkflowStore((s) => s.setStageDraft)
  const seedStageDraft = useWorkflowStore((s) => s.seedStageDraft)
  const seededRef = useRef(false)
  const [building, setBuilding] = useState(false)
  const [checking, setChecking] = useState(false)
  const [audit, setAudit] = useState<Audit>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState('')
  const [edited, setEdited] = useState(false)

  // Prefill from the engine's real file — never clobber an edit in progress.
  useEffect(() => {
    if (seededRef.current) return
    seededRef.current = true
    const store = useWorkflowStore.getState()
    if ((store.stageDrafts[stageId] ?? '').length > 0) return
    fetch(`http://localhost:8000/api/file?session=${SESSION}&path=${encodeURIComponent(FILE_PATH)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((out) => {
        if (out?.ok && out.data?.exists && typeof out.data.content === 'string') {
          const cur = useWorkflowStore.getState()
          if ((cur.stageDrafts[stageId] ?? '').length === 0) seedStageDraft(stageId, out.data.content)
        }
      })
      .catch(() => {})
  }, [stageId, seedStageDraft])

  let list: ShotList | null = null
  try {
    list = draft.trim() ? (JSON.parse(draft) as ShotList) : null
  } catch {
    list = null
  }
  const chunks = list?.chunks ?? []
  const totalSec = chunks.reduce((n, c) => n + estSec(c), 0) || 1
  const unresolved = chunks.filter((c) => c.reaction_candidate === true)

  const apply = (mut: (l: ShotList) => void) => {
    if (!list) return
    const next = JSON.parse(JSON.stringify(list)) as ShotList
    mut(next)
    setStageDraft(stageId, JSON.stringify(next, null, 2) + '\n')
    setEdited(true)
  }

  const build = async (feedback = '') => {
    setBuilding(true)
    setError(null)
    setAudit(null)
    try {
      const res = await fetch('http://localhost:8000/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: SESSION, tenant: 'local', action: 'draft_stage', stage_id: stageId,
          allow_cost: true, ...(feedback.trim() ? { feedback: feedback.trim() } : {}),
        }),
      })
      const out = await res.json().catch(() => null)
      if (!res.ok || out?.ok === false) {
        setError(out?.message || out?.error || 'Build failed.')
        return
      }
      setAudit(out?.data?.audits?.shot_list ?? null)
      const fr = await fetch(`http://localhost:8000/api/file?session=${SESSION}&path=${encodeURIComponent(FILE_PATH)}`)
      const fileOut = await fr.json().catch(() => null)
      if (fileOut?.ok && fileOut.data?.exists) {
        seedStageDraft(stageId, fileOut.data.content) // fresh from engine = clean state
        setEdited(false)
      }
    } catch {
      setError('Could not reach the engine.')
    } finally {
      setBuilding(false)
    }
  }

  // FREE RE-CHECK after manual edits: persist the edited JSON (contract-
  // whitelisted output), then run the official gate-token validation.
  const recheck = async () => {
    setChecking(true)
    setError(null)
    try {
      if (edited && draft.trim()) {
        const so = await fetch('http://localhost:8000/api/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session: SESSION, tenant: 'local', action: 'set_stage_output',
            stage_id: stageId, path: FILE_PATH, content: draft,
          }),
        })
        if (!so.ok) {
          setError('Could not save your edits to the engine.')
          return
        }
      }
      const res = await fetch('http://localhost:8000/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: SESSION, tenant: 'local', action: 'run_audit', stage: 'shot-list' }),
      })
      const out = await res.json().catch(() => null)
      if (!res.ok || out?.ok === false) {
        setError(out?.message || out?.error || 'Re-check failed to run.')
        return
      }
      setAudit(out?.data ?? out)
      setEdited(false)
    } catch {
      setError('Could not reach the engine.')
    } finally {
      setChecking(false)
    }
  }

  const active = chunks.find((c) => c.id === selected) ?? null
  const pct = (s: number) => (s / totalSec) * 100

  // Scene spans for the ruler row.
  let cursor = 0
  const positioned = chunks.map((c) => {
    const start = cursor
    cursor += estSec(c)
    return { c, start, dur: estSec(c) }
  })
  const scenes: { scene: string; title: string; start: number; end: number }[] = []
  for (const p of positioned) {
    const sc = p.c.scene ?? ''
    const last = scenes[scenes.length - 1]
    if (last && last.scene === sc) last.end = p.start + p.dur
    else scenes.push({ scene: sc, title: p.c.scene_title ?? '', start: p.start, end: p.start + p.dur })
  }

  return (
    <div className="vp panel-flat">
      {/* Build / re-build (paid, validated in the same operation) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        <FeedbackButton
          label={chunks.length ? 'Re-build storyboard' : 'Build storyboard'}
          busyLabel="Building…"
          busy={building}
          title="Compiles the approved pacing plan — structure copied by code, AI writes the picture directions, validator certifies it. Uses model credits."
          onRun={(fb) => build(fb)}
        />
        <span className="label">
          from the approved pacing plan · validated + Excel in the same run · uses model credits
        </span>
        {chunks.length > 0 ? (
          <button type="button" className="vp-undo" disabled={checking} onClick={recheck} title="Free — saves your edits and reruns the validator">
            {checking ? 'Checking…' : edited ? 'Save & re-check' : 'Re-check'}
          </button>
        ) : null}
        {error ? <span style={{ color: 'var(--red)', fontSize: 13, flexBasis: '100%' }}>Engine: {error}</span> : null}
      </div>

      {/* Validation status — what the code certified, in plain sight. */}
      {audit ? (
        <div style={{ marginBottom: 14, fontSize: 13, color: audit.passed ? 'var(--ink-2)' : 'var(--amber)' }}>
          {audit.passed
            ? '✓ Validator passed — this storyboard is certified for image generation.'
            : 'Validator found problems — fix and re-check before approving:'}
          {!audit.passed && audit.findings ? (
            <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, color: 'var(--ink-2)', margin: '8px 0 0', maxHeight: 220, overflow: 'auto' }}>
              {audit.findings}
            </pre>
          ) : null}
        </div>
      ) : null}
      {edited && chunks.length > 0 ? (
        <p className="vp-hint" style={{ color: 'var(--amber)', margin: '0 0 12px' }}>
          Edited since the last check — “Save & re-check” before approving.
        </p>
      ) : null}

      {!list && draft.trim() ? (
        <p style={{ color: 'var(--amber)', fontSize: 13 }}>The storyboard file doesn’t parse as JSON — rebuild it, or fix it by hand on disk.</p>
      ) : null}

      {!chunks.length ? (
        <div className="stub vp-empty">
          <span>SB</span>
          <h3>No storyboard yet</h3>
          <p>
            The storyboard is the machine-precise work order compiled from your approved pacing
            plan: every image's generation prompt, references, timing, and on-screen text —
            validated before you ever see it. Build it with the button above, or tick the
            hand-off checkbox when approving Visual Pacing.
          </p>
        </div>
      ) : (
        <>
          {/* One line of facts. */}
          <div className="ch" style={{ borderBottom: 'none', paddingBottom: 0 }}>
            <h3>Storyboard — {scenes.length} scenes · {chunks.length} images · ~{Math.floor(totalSec / 60)}:{String(Math.round(totalSec % 60)).padStart(2, '0')}</h3>
            <span>shot-list/shot-list.json · shot-list.xlsx</span>
          </div>
          {unresolved.length > 0 ? (
            <p className="vp-hint" style={{ color: 'var(--amber)' }}>
              {unresolved.length} overlay idea{unresolved.length === 1 ? '' : 's'} still without a file
              ({unresolved.map((c) => c.id).join(', ')}) — attach the GIF at Visual Pacing or record a skip; the validator blocks until resolved.
            </p>
          ) : null}

          {/* Timeline: same language as pacing — scenes ruler + image chunks. */}
          <div className="vp-timeline">
            <div className="vp-tl-row">
              <span className="vp-tl-label">Scenes</span>
              <div className="vp-tl-track ruler">
                {scenes.map((s, i) => (
                  <div
                    key={`${s.scene}-${i}`}
                    className={`vp-ruler-seg ${i % 2 ? 'alt' : ''} ${active && active.scene === s.scene ? 'on' : ''}`}
                    style={{ left: `${pct(s.start)}%`, width: `${pct(s.end - s.start)}%` }}
                    title={`Scene ${s.scene} · ${s.title}`}
                  >
                    <span>{s.title || s.scene}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="vp-tl-row">
              <span className="vp-tl-label">Images</span>
              <div className="vp-tl-track visuals">
                {positioned.map(({ c, start, dur }) => (
                  <button
                    type="button"
                    key={c.id}
                    className={`vp-seg ${c.id === selected ? 'on' : ''}`}
                    style={{ left: `${pct(start)}%`, width: `${pct(dur)}%` }}
                    onClick={() => setSelected((cur) => (cur === c.id ? '' : c.id))}
                    title={`${c.id} · ~${dur.toFixed(1)}s — click to open the work order`}
                  >
                    <span>{c.id}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
          <p className="vp-hint" style={{ margin: '6px 0 14px' }}>
            Click an image to open its work order · timings are estimates until narration audio exists
          </p>

          {/* THE WORK ORDER: everything the image generator will be told. */}
          {active ? (
            <div className="vp-edit" style={{ resize: 'both', overflow: 'auto', minWidth: 380, minHeight: 150, maxWidth: '100%' }}>
              <div className="vp-edit-head">
                <span className="id">{active.id}</span>
                <b>Work order</b>
                <span className="vp-active-hold">scene {active.scene} · {active.scene_title}</span>
              </div>
              <p style={{ margin: '0 0 10px', color: 'var(--ink-2)', fontSize: 13 }}>
                “{active.beats?.[0]?.narration ?? ''}”
              </p>
              <label className="vp-edit-field">What the image generator is told (visual direction)
                <textarea
                  rows={3}
                  value={active.visual_direction ?? ''}
                  onChange={(e) => apply((l) => { const c = l.chunks.find((x) => x.id === active.id); if (c) c.visual_direction = e.target.value })}
                />
              </label>
              <div className="vp-edit-grid">
                <label>References (from the World Kit)
                  <input
                    value={(active.references ?? []).join(', ')}
                    onChange={(e) => apply((l) => {
                      const c = l.chunks.find((x) => x.id === active.id)
                      if (!c) return
                      const refs = e.target.value.split(',').map((s) => s.trim()).filter(Boolean)
                      if (refs.length) { c.references = refs; c.reference_image_policy = c.reference_image_policy ?? 'character_and_art_detail' }
                      else { delete c.references; delete c.reference_image_policy }
                    })}
                    placeholder="builder, meme-chad"
                  />
                </label>
                <label>On-screen text (comma-separated, sparing)
                  <input
                    value={(active.on_screen_text ?? []).join(', ')}
                    onChange={(e) => apply((l) => { const c = l.chunks.find((x) => x.id === active.id); if (c) c.on_screen_text = e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
                  />
                </label>
              </div>
              {active.frame_design_receipt ? (
                <div className="vp-edit-grid">
                  {(['first_read', 'physical_action', 'visual_contrast'] as const).map((k) => (
                    <label key={k}>{k.replace(/_/g, ' ')}
                      <input
                        value={active.frame_design_receipt?.[k] ?? ''}
                        onChange={(e) => apply((l) => { const c = l.chunks.find((x) => x.id === active.id); if (c) c.frame_design_receipt = { ...c.frame_design_receipt, [k]: e.target.value } })}
                      />
                    </label>
                  ))}
                  <label>detail anchors (comma-separated)
                    <input
                      value={(active.frame_design_receipt?.detail_anchors ?? []).join(', ')}
                      onChange={(e) => apply((l) => { const c = l.chunks.find((x) => x.id === active.id); if (c) c.frame_design_receipt = { ...c.frame_design_receipt, detail_anchors: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) } })}
                    />
                  </label>
                </div>
              ) : null}
              {(active.overlays ?? []).length > 0 ? (
                <p className="vp-hint" style={{ margin: '8px 0 0' }}>
                  Overlay: {(active.overlays ?? []).map((o) => `${o.id} (${o.source})`).join(' · ')}
                </p>
              ) : null}
              {active.reaction_candidate ? (
                <p className="vp-hint" style={{ color: 'var(--amber)', margin: '8px 0 0' }}>{active.reaction_note}</p>
              ) : null}
              <div className="vp-edit-actions">
                <button type="button" className="vp-cancel" onClick={() => setSelected('')}>Close</button>
                <span className="vp-edit-note">Edits land on “Save & re-check” · approval gates the paid image steps</span>
              </div>
            </div>
          ) : null}

          {/* The full list, scene by scene. */}
          <div className="table-wrap" style={{ maxHeight: '46vh', overflowY: 'auto', marginTop: 14 }}>
            <table className="shots vp-pacing">
              <thead>
                <tr><th>Img</th><th>Scene</th><th>Narration</th><th>Visual direction</th><th>~Hold</th></tr>
              </thead>
              <tbody>
                {positioned.map(({ c, dur }) => (
                  <tr key={c.id} className={c.id === selected ? 'on' : ''} onClick={() => setSelected(c.id)} style={{ cursor: 'pointer' }}>
                    <td><span className="id">{c.id}</span></td>
                    <td><span className="id">{c.scene}</span></td>
                    <td className="narr" style={{ maxWidth: 260 }}>{c.beats?.[0]?.narration}</td>
                    <td style={{ maxWidth: 420 }}>{c.visual_direction}</td>
                    <td className="vp-mono">{dur.toFixed(1)}s</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
