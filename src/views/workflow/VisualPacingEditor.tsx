import { useEffect, useRef, useState } from 'react'
import {
  fmtClock,
  nextChunkId,
  nextImageId,
  OPENING_WINDOW_S,
  pacingStats,
  parseHold,
  parsePacingPlan,
  planIsWellFormed,
  serializePacingPlan,
  timelineOf,
  type PacingOverlay,
  type PacingPlan,
  type TimedImage,
} from '../../lib/pacing-md'
import { useWorkflowStore } from '../../store/workflow'

// The Visual Pacing panel, made real: the timeline/table/script views are a
// VIEW over working/visual-pacing-plan.md (the engine's contract output for
// this stage). Every edit round-trips parse → mutate → serialize back into the
// stage draft, so the standard save/approve/dirty machinery stays untouched.
// AI drafting lives in StageDraftEditor above this panel (draft_visual_pacing
// via the engine, metered); this component is pure human review & editing.

type EditDraft =
  | { scope: 'image'; chunkId: string; beatCode: string; imageId: string; isNew: boolean; nearImageId?: string; insertPos?: 'before' | 'after'; what: string; why: string; hold: string; refs: string }
  | { scope: 'chunk'; chunkId: string; isNew: boolean; refChunkId?: string; insertPos?: 'before' | 'after'; title: string; summary: string; narration: string }
  | { scope: 'overlay'; overlayId: string; isNew: boolean; anchor: string; trigger: string; what: string; hold: string; placement: string }

export function VisualPacingEditor({ stageId }: { stageId: string }) {
  const draft = useWorkflowStore((s) => s.stageDrafts[stageId] ?? '')
  const setStageDraft = useWorkflowStore((s) => s.setStageDraft)
  const [history, setHistory] = useState<string[]>([])
  const [raw, setRaw] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; chunkId: string; beatCode?: string; imageId?: string } | null>(null)
  const [editing, setEditing] = useState<EditDraft | null>(null)
  const [view, setView] = useState<'table' | 'script'>('table')
  const [activeId, setActiveId] = useState('')
  // TIMELINE EDGE DRAG: live hold overrides while dragging the boundary
  // between two images of the same beat (zero-sum — the words own the total).
  const [dragHolds, setDragHolds] = useState<Record<string, number> | null>(null)
  const dragHoldsRef = useRef<Record<string, number> | null>(null)
  // SCRIPT TAG DRAG: which image tag is being dragged to a new start word.
  const [scriptDrag, setScriptDrag] = useState<{ chunkId: string; beatCode: string; imageId: string; candidate: number | null } | null>(null)
  const scriptDragRef = useRef<typeof scriptDrag>(null)

  const editKey = editing ? `${editing.scope}:${'imageId' in editing ? editing.imageId : 'overlayId' in editing ? editing.overlayId : editing.chunkId}` : ''
  useEffect(() => {
    if (editKey) document.querySelector('.vp-edit')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [editKey])

  // CLICK-OUT BEHAVIOR: clicking outside the editor applies the edit (it's
  // local until the step is saved, and Undo covers regrets); Esc discards.
  // A brand-new, still-empty item is discarded instead of saved.
  const editBoxRef = useRef<HTMLDivElement>(null)
  const applyOrDiscardRef = useRef<() => void>(() => {})
  useEffect(() => {
    if (!editKey) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (editBoxRef.current && !editBoxRef.current.contains(t)) applyOrDiscardRef.current()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setEditing(null)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [editKey])

  if (!draft.trim()) {
    return (
      <div className="stub vp-empty">
        <span>VP</span>
        <h3>No pacing plan yet</h3>
        <p>
          The pacing pass maps every narration beat to an image — what the viewer sees, why it
          appears then, and how long it holds — before the storyboard is compiled. Use{' '}
          <b>Draft with AI</b> above (it reads the final script and World Kit), or write the plan
          by hand via “Review or write it yourself”.
        </p>
      </div>
    )
  }

  let plan: PacingPlan | null = null
  try {
    plan = parsePacingPlan(draft)
  } catch {
    plan = null
  }
  const wellFormed = plan != null && planIsWellFormed(plan)

  const snapshot = () => setHistory((h) => [...h, draft].slice(-50))
  const undo = () => {
    if (history.length === 0) return
    const prev = history[history.length - 1]
    setHistory((h) => h.slice(0, -1))
    setStageDraft(stageId, prev)
    setEditing(null)
    setMenu(null)
  }
  const apply = (p: PacingPlan) => {
    snapshot()
    setStageDraft(stageId, serializePacingPlan(p))
  }
  const clone = (): PacingPlan => JSON.parse(JSON.stringify(plan)) as PacingPlan

  if (!wellFormed || raw) {
    // RAW MODE (or the plan doesn't parse): edit the markdown directly. The
    // engine reads this exact text — the structured views come back as soon as
    // it parses again.
    return (
      <div className="vp panel-flat">
        <div className="ch">
          <h3>Visual pacing — as text</h3>
          <span>working/visual-pacing-plan.md</span>
        </div>
        {!wellFormed ? (
          <p className="vp-hint" style={{ color: 'var(--amber)' }}>
            This plan doesn’t match the house format yet (chunks → beats → image tables), so the
            timeline views are off. Fix it here or re-draft with AI.
          </p>
        ) : (
          <p className="vp-hint">Raw markdown — the exact text the engine reads.</p>
        )}
        <textarea
          value={draft}
          onChange={(e) => setStageDraft(stageId, e.target.value)}
          style={{
            width: '100%', minHeight: 320, resize: 'vertical', background: 'transparent',
            color: 'var(--ink-1, inherit)', border: '1px solid var(--line, #2a3142)',
            borderRadius: 8, padding: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 13, lineHeight: 1.55,
          }}
        />
        {wellFormed ? (
          <button type="button" className="vp-undo" style={{ marginTop: 8 }} onClick={() => setRaw(false)}>
            ← Back to the timeline view
          </button>
        ) : null}
      </div>
    )
  }
  const p = plan!
  // While a boundary drag is live, render from a hold-overridden copy so the
  // blocks follow the pointer; the real plan is updated once on release.
  const dp: PacingPlan = dragHolds
    ? {
        ...p,
        chunks: p.chunks.map((c) => ({
          ...c,
          beats: c.beats.map((b) => ({
            ...b,
            images: b.images.map((i) => (dragHolds[i.id] != null ? { ...i, holdS: dragHolds[i.id] } : i)),
          })),
        })),
      }
    : p
  const stats = pacingStats(dp)
  const images = timelineOf(dp)
  const totalSec = stats.runtimeS || 1
  const pct = (sec: number) => (sec / totalSec) * 100
  const active = images.find((img) => img.id === activeId) ?? images[0]

  const chunkSpans = dp.chunks.map((chunk) => {
    const imgs = images.filter((img) => img.chunkId === chunk.id)
    const start = imgs[0]?.startS ?? 0
    const last = imgs[imgs.length - 1]
    return { id: chunk.id, title: chunk.title, start, end: (last?.startS ?? 0) + (last?.holdS ?? 0) }
  })
  const openingEnd = Math.min(totalSec, OPENING_WINDOW_S)
  const overlayMarks = dp.overlays
    .map((o) => {
      const host = images.find((img) => img.id === o.anchor)
      return host ? { ...o, center: host.startS + host.holdS / 2 } : null
    })
    .filter(Boolean) as (PacingOverlay & { center: number })[]
  // Minute ticks, but skip any that would crowd the end label (a 2:01 video
  // otherwise prints "2:00" and "2:01" on top of each other).
  const ticks: number[] = []
  const tickGuard = Math.max(8, totalSec * 0.05)
  for (let s = 0; s <= totalSec; s += 60) if (totalSec - s >= tickGuard) ticks.push(s)

  // --- mutations (every one snapshots for undo, then serializes back) ---
  const openMenu = (e: React.MouseEvent, m: { chunkId: string; beatCode?: string; imageId?: string }) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, ...m })
  }
  const findImage = (imageId: string) => {
    for (const c of p.chunks)
      for (const b of c.beats) {
        const img = b.images.find((i) => i.id === imageId)
        if (img) return { chunk: c, beat: b, img }
      }
    return null
  }
  const startEditImage = (imageId: string) => {
    const hit = findImage(imageId)
    if (hit)
      setEditing({
        scope: 'image', chunkId: hit.chunk.id, beatCode: hit.beat.code, imageId, isNew: false,
        what: hit.img.what, why: hit.img.why, hold: `${hit.img.holdS}s`, refs: hit.img.refs,
      })
    setMenu(null)
  }
  const startAddImage = (chunkId: string, opts?: { nearImageId?: string; pos?: 'before' | 'after' }) => {
    const near = opts?.nearImageId ? findImage(opts.nearImageId) : null
    const chunk = p.chunks.find((c) => c.id === chunkId)
    const beatCode = near?.beat.code ?? chunk?.beats[chunk.beats.length - 1]?.code ?? ''
    setEditing({
      scope: 'image', chunkId, beatCode, imageId: nextImageId(p), isNew: true,
      nearImageId: opts?.nearImageId, insertPos: opts?.pos, what: '', why: '', hold: '6s', refs: '',
    })
    setMenu(null)
  }
  const startEditChunk = (chunkId: string) => {
    const chunk = p.chunks.find((c) => c.id === chunkId)
    if (chunk) setEditing({ scope: 'chunk', chunkId, isNew: false, title: chunk.title, summary: chunk.summary, narration: '' })
    setMenu(null)
  }
  const startAddChunk = (refChunkId: string, pos: 'before' | 'after') => {
    setEditing({ scope: 'chunk', chunkId: nextChunkId(p), isNew: true, refChunkId, insertPos: pos, title: '', summary: '', narration: '' })
    setMenu(null)
  }
  const removeImage = (imageId: string) => {
    const next = clone()
    for (const c of next.chunks)
      for (const b of c.beats) b.images = b.images.filter((i) => i.id !== imageId)
    for (const c of next.chunks) c.beats = c.beats.filter((b) => b.images.length > 0)
    next.chunks = next.chunks.filter((c) => c.beats.length > 0)
    next.overlays = next.overlays.filter((o) => o.anchor !== imageId)
    apply(next)
    setMenu(null)
  }
  const removeChunk = (chunkId: string) => {
    const next = clone()
    const gone = new Set(
      next.chunks.find((c) => c.id === chunkId)?.beats.flatMap((b) => b.images.map((i) => i.id)) ?? [],
    )
    next.chunks = next.chunks.filter((c) => c.id !== chunkId)
    next.overlays = next.overlays.filter((o) => !gone.has(o.anchor))
    apply(next)
    setMenu(null)
  }
  const removeOverlay = (overlayId: string) => {
    const next = clone()
    next.overlays = next.overlays.filter((o) => o.id !== overlayId)
    apply(next)
  }
  const nextOverlayId = () => {
    let max = 0
    for (const o of p.overlays) {
      const m = o.id.match(/(\d+)$/)
      if (m) max = Math.max(max, parseInt(m[1], 10))
    }
    return `R${String(max + 1).padStart(2, '0')}`
  }

  const saveEdit = () => {
    if (!editing) return
    const next = clone()
    if (editing.scope === 'image') {
      const d = editing
      const img = { id: d.imageId, holdS: parseHold(d.hold) || 6, refs: d.refs.trim(), what: d.what.trim() || 'New visual — describe it.', why: d.why.trim() }
      const chunk = next.chunks.find((c) => c.id === d.chunkId)
      if (chunk) {
        if (d.isNew) {
          const beat = chunk.beats.find((b) => b.code === d.beatCode) ?? chunk.beats[chunk.beats.length - 1]
          if (beat) {
            if (d.nearImageId) {
              const idx = beat.images.findIndex((i) => i.id === d.nearImageId)
              beat.images.splice(idx < 0 ? beat.images.length : d.insertPos === 'before' ? idx : idx + 1, 0, img)
            } else beat.images.push(img)
          }
        } else {
          for (const b of chunk.beats) b.images = b.images.map((i) => (i.id === d.imageId ? img : i))
        }
        setActiveId(d.imageId)
      }
    } else if (editing.scope === 'chunk') {
      const d = editing
      if (d.isNew) {
        const beatNum = d.chunkId.replace(/\D/g, '')
        const chunk = {
          id: d.chunkId, title: d.title.trim() || 'New chunk', summary: d.summary.trim(),
          beats: [{ code: `${beatNum}A`, narration: d.narration.trim() || '(narration for this chunk)', images: [{ id: nextImageId(next), holdS: 6, refs: '', what: 'New visual — right-click it to edit.', why: '' }] }],
        }
        let at = next.chunks.length
        if (d.refChunkId) {
          const ri = next.chunks.findIndex((c) => c.id === d.refChunkId)
          if (ri >= 0) at = d.insertPos === 'before' ? ri : ri + 1
        }
        next.chunks.splice(at, 0, chunk)
      } else {
        const chunk = next.chunks.find((c) => c.id === d.chunkId)
        if (chunk) {
          chunk.title = d.title.trim() || chunk.title
          chunk.summary = d.summary.trim()
        }
      }
    } else {
      const d = editing
      const ov = { id: d.overlayId, anchor: d.anchor.trim(), trigger: d.trigger.trim(), what: d.what.trim(), holdS: parseHold(d.hold) || 2, placement: d.placement.trim() || 'centered' }
      if (d.isNew) next.overlays.push(ov)
      else next.overlays = next.overlays.map((o) => (o.id === d.overlayId ? ov : o))
    }
    apply(next)
    setEditing(null)
  }
  // Latest-save ref for the document-level click-out listener.
  applyOrDiscardRef.current = () => {
    const d = editing
    if (!d) return
    const blank =
      d.scope === 'image'
        ? !d.what.trim() && !d.why.trim()
        : d.scope === 'chunk'
          ? !d.title.trim() && !d.summary.trim()
          : !d.what.trim() && !d.trigger.trim()
    if (d.isNew && blank) setEditing(null)
    else saveEdit()
  }

  // Script view: distribute each beat's words across its images proportionally
  // to hold time (estimated timing — real word alignment arrives with TTS).
  const beatSpans = (narration: string, imgs: { id: string; holdS: number }[]) => {
    const words = narration.split(/\s+/).filter(Boolean)
    const total = imgs.reduce((n, i) => n + i.holdS, 0) || 1
    let acc = 0
    return imgs.map((img) => {
      const from = Math.round((acc / total) * words.length)
      acc += img.holdS
      const to = Math.max(from, Math.round((acc / total) * words.length) - 1)
      return { id: img.id, from, to }
    })
  }

  const setDraftField = (patch: Record<string, string>) => setEditing((d) => (d ? ({ ...d, ...patch } as EditDraft) : d))

  const round1 = (n: number) => Math.round(n * 10) / 10

  // --- timeline edge drag (zero-sum hold rebalance between beat siblings) ---
  const startHoldDrag = (e: React.PointerEvent, left: TimedImage, right: TimedImage) => {
    e.preventDefault()
    e.stopPropagation()
    const total = left.holdS + right.holdS
    if (total < 2.2) return // nothing meaningful to rebalance
    const track = (e.currentTarget as HTMLElement).parentElement
    const width = track?.getBoundingClientRect().width ?? 1
    const pxPerSec = width / totalSec
    const startX = e.clientX
    const left0 = left.holdS
    const onMove = (ev: PointerEvent) => {
      const delta = (ev.clientX - startX) / pxPerSec
      const newLeft = round1(Math.min(Math.max(left0 + delta, 1), total - 1))
      const next = { [left.id]: newLeft, [right.id]: round1(total - newLeft) }
      dragHoldsRef.current = next
      setDragHolds(next)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      const dh = dragHoldsRef.current
      dragHoldsRef.current = null
      setDragHolds(null)
      if (dh) {
        const next = clone()
        for (const c of next.chunks)
          for (const b of c.beats)
            for (const i of b.images) if (dh[i.id] != null) i.holdS = dh[i.id]
        apply(next)
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // --- script tag drag (move an image's start to a different word) ---
  const startTagDrag = (e: React.PointerEvent, chunkId: string, beatCode: string, imageId: string) => {
    e.preventDefault()
    e.stopPropagation()
    const d = { chunkId, beatCode, imageId, candidate: null as number | null }
    scriptDragRef.current = d
    setScriptDrag(d)
    const onMove = (ev: PointerEvent) => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY)
      const wordEl = el instanceof Element ? el.closest('[data-widx]') : null
      const cur = scriptDragRef.current
      if (!cur) return
      if (wordEl && wordEl.getAttribute('data-beat') === `${cur.chunkId}:${cur.beatCode}`) {
        const idx = Number(wordEl.getAttribute('data-widx'))
        if (Number.isFinite(idx) && idx !== cur.candidate) {
          const next = { ...cur, candidate: idx }
          scriptDragRef.current = next
          setScriptDrag(next)
        }
      }
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      const cur = scriptDragRef.current
      scriptDragRef.current = null
      setScriptDrag(null)
      if (!cur || cur.candidate == null) return
      const next = clone()
      const beat = next.chunks.find((c) => c.id === cur.chunkId)?.beats.find((b) => b.code === cur.beatCode)
      if (!beat) return
      const words = beat.narration.split(/\s+/).filter(Boolean)
      const total = beat.images.reduce((n, i) => n + i.holdS, 0)
      const k = beat.images.findIndex((i) => i.id === cur.imageId)
      if (k <= 0 || words.length < 2) return // first image always starts the beat
      const starts = beatSpans(beat.narration, beat.images).map((s) => s.from)
      const minStart = (starts[k - 1] ?? 0) + 1
      const maxStart = k + 1 < starts.length ? starts[k + 1] - 1 : words.length - 1
      if (minStart > maxStart) return
      starts[k] = Math.min(Math.max(cur.candidate, minStart), maxStart)
      const bounds = [...starts, words.length]
      beat.images.forEach((img, i2) => {
        img.holdS = Math.max(0.5, round1(((bounds[i2 + 1] - bounds[i2]) / words.length) * total))
      })
      apply(next)
      setActiveId(cur.imageId)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <div className="vp panel-flat">
      <div className="ch">
        <h3>Visual pacing — {stats.chunks} chunks · {stats.images} images</h3>
        <span>working/visual-pacing-plan.md</span>
      </div>

      {/* Density line only — image/chunk totals already live in the title.
          Opening vs body is the one pacing number the law cares about. */}
      <div className="vp-stats">
        <span title={`images starting in the first ${OPENING_WINDOW_S}s — one every ${stats.openingSecPerImage.toFixed(1)}s`}>
          <b>{stats.openingImages}</b> opening
        </span>
        <span title={stats.bodyImages ? `one image every ${stats.bodySecPerImage.toFixed(1)}s after the opening` : undefined}>
          <b>{stats.bodyImages}</b> body
        </span>
        <span><b>{stats.overlays}</b> overlay{stats.overlays === 1 ? '' : 's'}</span>
        <b>~{fmtClock(stats.runtimeS)} est. · {p.meta['Style'] ?? ''}</b>
      </div>

      <div className="vp-timeline">
        <div className="vp-tl-row">
          <span className="vp-tl-label">Chunks</span>
          <div className="vp-tl-track ruler">
            {chunkSpans.map((c, i) => (
              <div
                key={c.id}
                className={`vp-ruler-seg ${i % 2 ? 'alt' : ''} ${active && active.chunkId === c.id ? 'on' : ''}`}
                style={{ left: `${pct(c.start)}%`, width: `${pct(c.end - c.start)}%` }}
                title={`${c.id} · ${c.title} — right-click to edit`}
                onContextMenu={(e) => openMenu(e, { chunkId: c.id, imageId: images.find((im) => im.chunkId === c.id)?.id })}
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
                style={{ left: `${pct(img.startS)}%`, width: `${pct(img.holdS)}%` }}
                onMouseEnter={() => setActiveId(img.id)}
                onFocus={() => setActiveId(img.id)}
                onContextMenu={(e) => openMenu(e, { chunkId: img.chunkId, beatCode: img.beatCode, imageId: img.id })}
                title={`${img.id} · ${img.holdS.toFixed(1)}s — right-click to edit`}
              >
                <span>{img.id}</span>
              </button>
            ))}
            {/* Drag handles on boundaries between images of the SAME beat —
                zero-sum: one grows, the other shrinks. Beat/chunk edges are
                owned by the narration words, so they don't get handles. */}
            {images.map((img, idx) => {
              const nxt = images[idx + 1]
              if (!nxt || nxt.chunkId !== img.chunkId || nxt.beatCode !== img.beatCode) return null
              return (
                <div
                  key={`h-${img.id}`}
                  title={`Drag to rebalance ${img.id} ↔ ${nxt.id} (total stays ${(img.holdS + nxt.holdS).toFixed(1)}s)`}
                  onPointerDown={(e) => startHoldDrag(e, img, nxt)}
                  style={{
                    position: 'absolute',
                    left: `calc(${pct(img.startS + img.holdS)}% - 4px)`,
                    top: 0,
                    bottom: 0,
                    width: 8,
                    cursor: 'ew-resize',
                    zIndex: 3,
                    touchAction: 'none',
                  }}
                />
              )
            })}
          </div>
        </div>

        <div className="vp-tl-row">
          <span className="vp-tl-label">Overlays</span>
          <div className="vp-tl-track overlays">
            {overlayMarks.length === 0 ? <span className="vp-tl-empty">none</span> : null}
            {overlayMarks.map((o) => (
              <div
                key={o.id}
                className="vp-overlay-mark"
                style={{ left: `${pct(o.center)}%` }}
                title={`${o.id} · "${o.trigger}" · ${o.holdS.toFixed(1)}s · ${o.what}`}
              >
                {o.id} · {o.holdS.toFixed(1)}s
              </div>
            ))}
          </div>
        </div>

        <div className="vp-tl-row axis">
          <span className="vp-tl-label" />
          <div className="vp-tl-track">
            {ticks.map((t) => (
              <span key={t} className="vp-tick" style={{ left: `${pct(t)}%` }}>{fmtClock(t)}</span>
            ))}
            <span className="vp-tick end" style={{ left: '100%' }}>{fmtClock(totalSec)}</span>
          </div>
        </div>
      </div>

      <div className="vp-hintbar">
        <p className="vp-hint">
          Hover to inspect · right-click to edit, add, or remove · drag the edge between two
          blocks to rebalance their time · timings are estimates until narration audio exists
        </p>
        <span style={{ display: 'inline-flex', gap: 8 }}>
          <button
            type="button"
            className="vp-undo"
            title="See or edit the exact text file the engine reads"
            onClick={() => setRaw(true)}
          >
            Edit as text
          </button>
          <button type="button" className="vp-undo" onClick={undo} disabled={history.length === 0}>
            ↶ Undo{history.length ? ` (${history.length})` : ''}
          </button>
        </span>
      </div>

      {editing ? (
        <div className="vp-edit" ref={editBoxRef}>
          <div className="vp-edit-head">
            <span className="id">
              {editing.scope === 'image' ? editing.imageId : editing.scope === 'overlay' ? editing.overlayId : editing.chunkId}
            </span>
            <b>{editing.isNew ? 'New' : 'Editing'} {editing.scope}</b>
            {editing.scope === 'image' ? <span className="vp-active-hold">in {editing.chunkId} · beat {editing.beatCode}</span> : null}
          </div>

          {editing.scope === 'chunk' ? (
            <>
              <div className="vp-edit-grid">
                <label>Title<input value={editing.title} onChange={(e) => setDraftField({ title: e.target.value })} placeholder="Chunk title" /></label>
              </div>
              <label className="vp-edit-field">Summary
                <textarea rows={2} value={editing.summary} onChange={(e) => setDraftField({ summary: e.target.value })} placeholder="One line: what this chunk does for the viewer" />
              </label>
              {editing.isNew ? (
                <label className="vp-edit-field">Narration (the script lines this chunk covers)
                  <textarea rows={2} value={editing.narration} onChange={(e) => setDraftField({ narration: e.target.value })} placeholder="Paste the narration sentence(s) from the script…" />
                </label>
              ) : null}
            </>
          ) : editing.scope === 'overlay' ? (
            <>
              <label className="vp-edit-field">Overlay (what pops on screen)
                <textarea rows={2} value={editing.what} onChange={(e) => setDraftField({ what: e.target.value })} placeholder="e.g. Price-check double-take GIF" />
              </label>
              <div className="vp-edit-grid">
                <label>Trigger phrase<input value={editing.trigger} onChange={(e) => setDraftField({ trigger: e.target.value })} placeholder="the spoken words that fire it" /></label>
                <label>On image<input value={editing.anchor} onChange={(e) => setDraftField({ anchor: e.target.value })} placeholder="e.g. I23" /></label>
                <label>Hold<input value={editing.hold} onChange={(e) => setDraftField({ hold: e.target.value })} placeholder="2s" /></label>
                <label>Placement<input value={editing.placement} onChange={(e) => setDraftField({ placement: e.target.value })} placeholder="centered" /></label>
              </div>
            </>
          ) : (
            <>
              <label className="vp-edit-field">What the viewer sees
                <textarea rows={3} value={editing.what} onChange={(e) => setDraftField({ what: e.target.value })} placeholder="Describe the on-screen visual — concrete and physical…" />
              </label>
              <label className="vp-edit-field">Why now
                <textarea rows={2} value={editing.why} onChange={(e) => setDraftField({ why: e.target.value })} placeholder="What changes in viewer understanding when this appears…" />
              </label>
              <div className="vp-edit-grid">
                <label>Hold<input value={editing.hold} onChange={(e) => setDraftField({ hold: e.target.value })} placeholder="6s" /></label>
                <label>References<input value={editing.refs} onChange={(e) => setDraftField({ refs: e.target.value })} placeholder="builder, meme-chad (from the World Kit)" /></label>
              </div>
            </>
          )}

          <div className="vp-edit-actions">
            <button type="button" className="vp-save" onClick={saveEdit}>Save</button>
            <button type="button" className="vp-cancel" onClick={() => setEditing(null)}>Cancel</button>
            <span className="vp-edit-note">Click outside to apply · Esc to discard · saved to the plan file when you save the step</span>
          </div>
        </div>
      ) : null}

      {menu ? (
        <>
          <div className="vp-menu-backdrop" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null) }} />
          <div className="vp-menu" style={{ left: menu.x, top: menu.y }}>
            <div className="vp-menu-h">{menu.imageId ? `${menu.imageId} · ` : ''}{menu.chunkId}</div>
            {menu.imageId ? (
              <>
                <button type="button" onClick={() => startEditImage(menu.imageId!)}>Edit image</button>
                <button type="button" onClick={() => startAddImage(menu.chunkId, { nearImageId: menu.imageId, pos: 'before' })}>Add image before</button>
                <button type="button" onClick={() => startAddImage(menu.chunkId, { nearImageId: menu.imageId, pos: 'after' })}>Add image after</button>
                <button type="button" className="danger" onClick={() => removeImage(menu.imageId!)}>Remove image</button>
                <div className="vp-menu-div" />
              </>
            ) : null}
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
                  <td className="vp-mono">{fmtClock(img.startS)}</td>
                  <td><span className="id">{img.id}</span></td>
                  <td><span className="id">{img.chunkId}</span></td>
                  <td>{img.what}</td>
                  <td className="vp-mono">{img.holdS.toFixed(1)}s</td>
                  <td className="vp-row-cell">
                    <button type="button" className="vp-row-menu" onClick={(e) => openMenu(e, { chunkId: img.chunkId, beatCode: img.beatCode, imageId: img.id })} title="Actions">⋯</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="vp-script" style={scriptDrag ? { userSelect: 'none', cursor: 'grabbing' } : undefined}>
          {dp.chunks.map((chunk) => (
            <p className="vp-script-chunk" key={chunk.id}>
              <span className="vp-script-cid">{chunk.id}</span>
              {chunk.beats.map((beat) => {
                const words = beat.narration.split(/\s+/).filter(Boolean)
                const spans = beatSpans(beat.narration, beat.images)
                const beatKey = `${chunk.id}:${beat.code}`
                const dragHere = scriptDrag && scriptDrag.chunkId === chunk.id && scriptDrag.beatCode === beat.code
                return words.map((w, i) => {
                  const owner = spans.find((s) => i >= s.from && i <= s.to)
                  const cls = ['vp-w']
                  if (owner) cls.push('img')
                  if (owner && owner.id === activeId) cls.push('on')
                  const ownerImg = owner ? beat.images.find((im) => im.id === owner.id) : undefined
                  const isDropTarget = dragHere && scriptDrag!.candidate === i
                  return (
                    <span key={`${beat.code}:${i}`}>
                      {owner && i === owner.from ? (
                        <span
                          className="vp-w-tag"
                          title={`${ownerImg?.what ?? ''} — drag to the word where this image should start`}
                          onPointerDown={(e) => startTagDrag(e, chunk.id, beat.code, owner.id)}
                          style={{
                            cursor: scriptDrag?.imageId === owner.id ? 'grabbing' : 'grab',
                            touchAction: 'none',
                            opacity: scriptDrag && scriptDrag.imageId !== owner.id ? 0.5 : undefined,
                          }}
                        >
                          {owner.id}
                        </span>
                      ) : null}
                      <span
                        className={cls.join(' ')}
                        data-beat={beatKey}
                        data-widx={i}
                        onMouseEnter={owner && !scriptDrag ? () => setActiveId(owner.id) : undefined}
                        onClick={owner && !scriptDrag ? (e) => openMenu(e, { chunkId: chunk.id, beatCode: beat.code, imageId: owner.id }) : undefined}
                        style={isDropTarget ? { outline: '1px dashed var(--ink-2)', borderRadius: 3 } : undefined}
                      >{w}</span>{' '}
                    </span>
                  )
                })
              })}
            </p>
          ))}
        </div>
      )}

      <details className="vp-section">
        <summary className="vp-section-sum">
          <span className="vp-sec-title">Overlays</span>
          <span className="vp-section-count">{p.overlays.length}</span>
        </summary>
        <div className="table-wrap">
          <table className="shots vp-table">
            <thead>
              <tr><th>ID</th><th>Trigger</th><th>Overlay</th><th>On image</th><th>Hold</th><th>Placement</th><th></th></tr>
            </thead>
            <tbody>
              {p.overlays.map((o) => (
                <tr key={o.id}>
                  <td><span className="id">{o.id}</span></td>
                  <td className="narr">"{o.trigger}"</td>
                  <td>{o.what}</td>
                  <td><span className="id">{o.anchor}</span></td>
                  <td className="vp-mono">{o.holdS.toFixed(1)}s</td>
                  <td>{o.placement}</td>
                  <td className="vp-row-cell">
                    <button
                      type="button"
                      className="vp-row-menu"
                      title="Edit overlay"
                      onClick={() => setEditing({ scope: 'overlay', overlayId: o.id, isNew: false, anchor: o.anchor, trigger: o.trigger, what: o.what, hold: `${o.holdS}s`, placement: o.placement })}
                    >✎</button>
                    <button type="button" className="vp-row-menu" title="Remove overlay" onClick={() => removeOverlay(o.id)}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button
          type="button"
          className="vp-undo"
          style={{ marginTop: 8 }}
          onClick={() => setEditing({ scope: 'overlay', overlayId: nextOverlayId(), isNew: true, anchor: active?.id ?? '', trigger: '', what: '', hold: '2s', placement: 'centered' })}
        >
          + Add overlay
        </button>
      </details>
    </div>
  )
}
