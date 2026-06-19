import { useEffect, useRef, useState } from 'react'
import {
  fmtBudget,
  fmtClock,
  isOverBudget,
  isUnderBudget,
  nextChunkId,
  nextImageId,
  pacingStats,
  parseHold,
  parseBudget,
  parsePacingPlan,
  planDurationS,
  planIsWellFormed,
  resolvedSections,
  serializePacingPlan,
  timelineOf,
  type PacingChunk,
  type PacingOverlay,
  type PacingPlan,
  type PacingSection,
  type ResolvedSection,
  type TimedImage,
} from '../../lib/pacing-md'
import { useWorkflowStore } from '../../store/workflow'
import { TimelineScroller } from './TimelineScroller'

// The Visual Pacing panel, made real: the timeline/table/script views are a
// VIEW over working/visual-pacing-plan.md (the engine's contract output for
// this stage). Every edit round-trips parse → mutate → serialize back into the
// stage draft, so the standard save/approve/dirty machinery stays untouched.
// AI drafting lives in StageDraftEditor above this panel (draft_visual_pacing
// via the engine, metered); this component is pure human review & editing.

type EditDraft =
  | { scope: 'image'; chunkId: string; beatCode: string; imageId: string; isNew: boolean; nearImageId?: string; insertPos?: 'before' | 'after'; what: string; why: string; hold: string; refs: string }
  | { scope: 'chunk'; chunkId: string; isNew: boolean; refChunkId?: string; insertPos?: 'before' | 'after'; title: string; summary: string; narration: string }
  | { scope: 'overlay'; overlayId: string; isNew: boolean; anchor: string; trigger: string; what: string; hold: string; placement: string; asset: string }
  | { scope: 'section'; index: number; isNew: boolean; name: string; to: string; imageBudget: string; overlayBudget: string }

export function VisualPacingEditor({ stageId }: { stageId: string }) {
  const draft = useWorkflowStore((s) => s.stageDrafts[stageId] ?? '')
  const setStageDraft = useWorkflowStore((s) => s.setStageDraft)
  const [history, setHistory] = useState<string[]>([])
  const [redoHistory, setRedoHistory] = useState<string[]>([])
  const [raw, setRaw] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; chunkId: string; beatCode?: string; imageId?: string } | null>(null)
  const [editing, setEditing] = useState<EditDraft | null>(null)
  const [view, setView] = useState<'table' | 'script'>('script')
  const [activeId, setActiveId] = useState('')
  // Step-level undo lives in the step header (Undo · Previous · Next) — the
  // editor registers its undo there instead of drawing its own button.
  const setStepUndo = useWorkflowStore((s) => s.setStepUndo)
  const undoRef = useRef<() => void>(() => {})
  const redoRef = useRef<() => void>(() => {})
  useEffect(() => {
    setStepUndo({
      count: history.length,
      run: () => undoRef.current(),
      redoCount: redoHistory.length,
      redo: () => redoRef.current(),
    })
    return () => setStepUndo(null)
  }, [history.length, redoHistory.length, setStepUndo])
  // TIMELINE EDGE DRAG: live hold overrides while dragging the boundary
  // between two images of the same beat (zero-sum — the words own the total).
  const [dragHolds, setDragHolds] = useState<Record<string, number> | null>(null)
  const dragHoldsRef = useRef<Record<string, number> | null>(null)
  // SCRIPT TAG DRAG: which image tag is being dragged to a new start word
  // (anywhere within its audio chunk).
  const [scriptDrag, setScriptDrag] = useState<{ chunkId: string; imageId: string; candidate: number | null } | null>(null)
  const scriptDragRef = useRef<typeof scriptDrag>(null)
  // OVERLAY ASSET FETCH: paste a direct GIF URL (Tenor/Giphy), the engine
  // downloads + converts it into the session. Search-by-text needs an API key.
  const [assetUrl, setAssetUrl] = useState('')
  const [fetchingAsset, setFetchingAsset] = useState(false)
  const [assetErr, setAssetErr] = useState<string | null>(null)
  // Dev-server path for previewing session media (vite fs.allow covers
  // spoolcast-content). Session id hardcode = known debt.
  const assetSrc = (rel: string) =>
    `/@fs/Users/ralphxu/Documents/Projects/spoolcast-content/sessions/spoolcast-dev-log-12/${rel}`
  const fetchOverlayAsset = async () => {
    setEditing((d) => d) // keep editor open
    const cur = editing
    if (!cur || cur.scope !== 'overlay' || !assetUrl.trim()) return
    setFetchingAsset(true)
    setAssetErr(null)
    try {
      const r = await fetch('http://localhost:8000/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: 'spoolcast-dev-log-12',
          tenant: 'local',
          action: 'fetch_overlay_asset',
          url: assetUrl.trim(),
          name: `overlay-${cur.overlayId.toLowerCase()}`,
        }),
      })
      const out = await r.json().catch(() => null)
      if (r.ok && out?.ok !== false && out?.data?.asset) {
        setEditing((d) => (d && d.scope === 'overlay' ? { ...d, asset: out.data.asset } : d))
        setAssetUrl('')
      } else {
        setAssetErr(out?.message || out?.error || 'Could not fetch the GIF.')
      }
    } catch {
      setAssetErr('Could not reach the engine.')
    } finally {
      setFetchingAsset(false)
    }
  }
  // SECTION BOUNDARY DRAG: live override of one boundary (dimension-line tick).
  const [secDrag, setSecDrag] = useState<{ index: number; toS: number } | null>(null)
  const secDragRef = useRef<typeof secDrag>(null)
  // TIMELINE ZOOM: 1 = fit to width; >1 widens the tracks inside a horizontal
  // scroll (busy openings, long videos). All drag math is %-based, so it
  // works unchanged at any zoom.
  const [zoom, setZoom] = useState(1)
  // FOLLOW THE TIMELINE: hovering a block centers its row/words inside the
  // pacing list (the list scrolls, never the page — no cursor feedback loop).
  // Only fires for hovers that come FROM the timeline, not from the list.
  const listRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(false)
  // The pacing list is content-height by default. Only when it actually
  // overflows its 48vh cap does it gain the bottom padding that lets the
  // last rows center on hover-follow.
  const [listOverflows, setListOverflows] = useState(false)
  useEffect(() => {
    const box = listRef.current
    if (!box) return
    const padPx = listOverflows ? window.innerHeight * 0.24 : 0
    const overflowing = box.scrollHeight - padPx > box.clientHeight + 2
    if (overflowing !== listOverflows) setListOverflows(overflowing)
  }, [draft, listOverflows, view])
  const setActiveFromTimeline = (id: string) => {
    followRef.current = true
    setActiveId(id)
  }
  useEffect(() => {
    if (!followRef.current) return
    followRef.current = false
    const box = listRef.current
    if (!box || !activeId) return
    const el = box.querySelector<HTMLElement>(`[data-img="${activeId}"]`)
    if (!el) return
    const boxRect = box.getBoundingClientRect()
    const elRect = el.getBoundingClientRect()
    box.scrollTo({
      top: box.scrollTop + (elRect.top - boxRect.top) - box.clientHeight / 2 + elRect.height / 2,
      behavior: 'smooth',
    })
  }, [activeId])

  const editKey = editing
    ? `${editing.scope}:${'imageId' in editing ? editing.imageId : 'overlayId' in editing ? editing.overlayId : 'index' in editing ? editing.index : editing.chunkId}`
    : ''
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
    // One line — if the step is blocked, the blocker card below explains.
    return (
      <p style={{ color: 'var(--ink-2)', fontSize: 13, lineHeight: 1.6, margin: '4px 0 0' }}>
        No pacing plan yet — this step maps every narration beat to an image (what the viewer
        sees, when it changes, how long it holds) before the shot list is compiled.
      </p>
    )
  }

  let plan: PacingPlan | null = null
  try {
    plan = parsePacingPlan(draft)
  } catch {
    plan = null
  }
  const wellFormed = plan != null && planIsWellFormed(plan)

  const snapshot = () => {
    setHistory((h) => [...h, draft].slice(-50))
    setRedoHistory([])
  }
  const undo = () => {
    if (history.length === 0) return
    const prev = history[history.length - 1]
    setRedoHistory((h) => [...h, draft].slice(-50))
    setHistory((h) => h.slice(0, -1))
    setStageDraft(stageId, prev)
    setEditing(null)
    setMenu(null)
  }
  // eslint-disable-next-line react-hooks/refs
  undoRef.current = undo
  const redo = () => {
    if (redoHistory.length === 0) return
    const next = redoHistory[redoHistory.length - 1]
    setHistory((h) => [...h, draft].slice(-50))
    setRedoHistory((h) => h.slice(0, -1))
    setStageDraft(stageId, next)
    setEditing(null)
    setMenu(null)
  }
  // eslint-disable-next-line react-hooks/refs
  redoRef.current = redo
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
            width: '100%', minHeight: 320, minWidth: 360, maxWidth: '100%', resize: 'both', background: 'transparent',
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
  // Sections (dimension lines): defaults apply until the user edits, then they
  // live in the plan file. During a tick drag, bounds + counts preview live.
  let secs: ResolvedSection[] = resolvedSections(dp)
  if (secDrag && secs[secDrag.index] && secs[secDrag.index + 1]) {
    secs = secs.map((s) => ({ ...s }))
    secs[secDrag.index].toS = secDrag.toS
    secs[secDrag.index + 1].fromS = secDrag.toS
    for (const s of secs) {
      const inWindow = images.filter((i) => i.startS >= s.fromS && i.startS < s.toS)
      s.imageCount = inWindow.length
      const ids = new Set(inWindow.map((i) => i.id))
      s.overlayCount = dp.overlays.filter((o) => ids.has(o.anchor)).length
    }
  }
  const overlayMarks = dp.overlays
    .map((o) => {
      const host = images.find((img) => img.id === o.anchor)
      return host ? { ...o, center: host.startS + host.holdS / 2 } : null
    })
    .filter(Boolean) as (PacingOverlay & { center: number })[]
  // Clock ticks: finer intervals when zoomed in; skip any tick that would
  // crowd the end label (a 2:01 video otherwise prints 2:00 on top of 2:01).
  const tickStep = zoom >= 4 ? 15 : zoom >= 2 ? 30 : 60
  const ticks: number[] = []
  const tickGuard = Math.max(8, (totalSec * 0.05) / zoom)
  for (let s = 0; s <= totalSec; s += tickStep) if (totalSec - s >= tickGuard) ticks.push(s)

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
    if (editing.scope === 'section') {
      const d = editing
      const updated = secs.map((s) => ({ ...s }))
      const s = updated[d.index]
      if (s) {
        s.name = d.name.trim() || s.name
        s.imageBudget = parseBudget(d.imageBudget)
        s.overlayBudget = parseBudget(d.overlayBudget)
        if (d.index < updated.length - 1 && d.to.trim()) {
          const toS = parseHold(d.to)
          if (toS > s.fromS + 1 && toS < updated[d.index + 1].toS - 1) {
            s.toS = toS
            updated[d.index + 1].fromS = toS
          }
        }
        writeSections(updated)
      }
      setEditing(null)
      return
    }
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
      const ov = { id: d.overlayId, anchor: d.anchor.trim(), trigger: d.trigger.trim(), what: d.what.trim(), holdS: parseHold(d.hold) || 2, placement: d.placement.trim() || 'centered', asset: d.asset.trim() }
      if (d.isNew) next.overlays.push(ov)
      else next.overlays = next.overlays.map((o) => (o.id === d.overlayId ? ov : o))
    }
    apply(next)
    setEditing(null)
  }
  // Latest-save ref for the document-level click-out listener.
  // eslint-disable-next-line react-hooks/refs
  applyOrDiscardRef.current = () => {
    const d = editing
    if (!d) return
    const blank =
      d.scope === 'image'
        ? !d.what.trim() && !d.why.trim()
        : d.scope === 'chunk'
          ? !d.title.trim() && !d.summary.trim()
          : d.scope === 'overlay'
            ? !d.what.trim() && !d.trigger.trim()
            : false
    if (d.isNew && blank) setEditing(null)
    else saveEdit()
  }

  // Script view: chunk-level word stream — the chunk's images distribute
  // across ALL its words proportionally to hold time, so a tag can be dragged
  // anywhere within its audio chunk (across beat boundaries too). Estimated
  // timing — real word alignment arrives with TTS at step 09.
  const chunkWordData = (chunk: PacingChunk) => {
    const words: { w: string; beatCode: string }[] = []
    for (const b of chunk.beats)
      for (const w of b.narration.split(/\s+/).filter(Boolean)) words.push({ w, beatCode: b.code })
    const imgs = chunk.beats.flatMap((b) => b.images)
    const total = imgs.reduce((n, i) => n + i.holdS, 0) || 1
    let acc = 0
    const spans = imgs.map((img) => {
      const from = Math.round((acc / total) * words.length)
      acc += img.holdS
      const to = Math.max(from, Math.round((acc / total) * words.length) - 1)
      return { id: img.id, from, to }
    })
    return { words, imgs, spans }
  }

  const setDraftField = (patch: Record<string, string>) => setEditing((d) => (d ? ({ ...d, ...patch } as EditDraft) : d))

  const round1 = (n: number) => Math.round(n * 10) / 10

  // --- sections (dimension lines): write resolved bounds back into the plan.
  // The last section's end is always written as 'end' so it follows runtime.
  function writeSections(resolved: ResolvedSection[]) {
    const next = clone()
    const runtime = planDurationS(next)
    next.sections = resolved.map(
      (s, k): PacingSection => ({
        name: s.name,
        fromS: Math.round(s.fromS),
        toS: k === resolved.length - 1 || s.toS >= runtime - 0.01 ? 'end' : Math.round(s.toS),
        imageBudget: s.imageBudget,
        overlayBudget: s.overlayBudget,
      }),
    )
    apply(next)
  }
  const startSecDrag = (e: React.PointerEvent, index: number) => {
    e.preventDefault()
    e.stopPropagation()
    const track = (e.currentTarget as HTMLElement).parentElement
    const rect = track?.getBoundingClientRect()
    if (!rect || !secs[index + 1]) return
    const lo = secs[index].fromS + 2
    const hi = secs[index + 1].toS - 2
    const onMove = (ev: PointerEvent) => {
      const frac = (ev.clientX - rect.left) / rect.width
      const toS = Math.round(Math.min(Math.max(frac * totalSec, lo), hi))
      const next = { index, toS }
      secDragRef.current = next
      setSecDrag(next)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      const d = secDragRef.current
      secDragRef.current = null
      setSecDrag(null)
      if (d) {
        const updated = secs.map((s) => ({ ...s }))
        updated[d.index].toS = d.toS
        updated[d.index + 1].fromS = d.toS
        writeSections(updated)
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  const splitSection = (index: number) => {
    const updated = secs.map((s) => ({ ...s }))
    const s = updated[index]
    const mid = Math.round((s.fromS + s.toS) / 2)
    if (mid - s.fromS < 2) return
    updated.splice(index + 1, 0, { ...s, name: `${s.name} b`, fromS: mid, imageBudget: null, overlayBudget: null, imageCount: 0, overlayCount: 0 })
    updated[index].toS = mid
    writeSections(updated)
    setEditing(null)
  }
  const mergeSection = (index: number) => {
    if (index <= 0 || secs.length <= 1) return
    const updated = secs.map((s) => ({ ...s }))
    updated[index - 1].toS = updated[index].toS
    updated.splice(index, 1)
    writeSections(updated)
    setEditing(null)
  }
  const openSectionEdit = (index: number) => {
    const s = secs[index]
    if (!s) return
    setEditing({
      scope: 'section', index, isNew: false, name: s.name,
      to: `${Math.round(s.toS)}s`,
      imageBudget: s.imageBudget ? fmtBudget(s.imageBudget) : '',
      overlayBudget: s.overlayBudget ? fmtBudget(s.overlayBudget) : '',
    })
  }

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

  // --- script tag drag (move an image's start to a different word, anywhere
  // within its audio chunk — the chunk's total time is preserved) ---
  const startTagDrag = (e: React.PointerEvent, chunkId: string, imageId: string) => {
    e.preventDefault()
    e.stopPropagation()
    const d = { chunkId, imageId, candidate: null as number | null }
    scriptDragRef.current = d
    setScriptDrag(d)
    const onMove = (ev: PointerEvent) => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY)
      const wordEl = el instanceof Element ? el.closest('[data-widx]') : null
      const cur = scriptDragRef.current
      if (!cur) return
      if (wordEl && wordEl.getAttribute('data-chunk') === cur.chunkId) {
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
      const chunk = next.chunks.find((c) => c.id === cur.chunkId)
      if (!chunk) return
      const { words, imgs, spans } = chunkWordData(chunk)
      const total = imgs.reduce((n, i) => n + i.holdS, 0)
      const k = imgs.findIndex((i) => i.id === cur.imageId)
      if (k <= 0 || words.length < 2) return // the chunk's first image starts the chunk
      const starts = spans.map((s) => s.from)
      const minStart = (starts[k - 1] ?? 0) + 1
      const maxStart = k + 1 < starts.length ? starts[k + 1] - 1 : words.length - 1
      if (minStart > maxStart) return
      starts[k] = Math.min(Math.max(cur.candidate, minStart), maxStart)
      const bounds = [...starts, words.length]
      imgs.forEach((img, i2) => {
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
      {/* One line of facts — per-section counts live on the dimension lines
          below the timeline. No separate stats row, no divider (clean UI). */}
      <div className="ch" style={{ borderBottom: 'none', paddingBottom: 0 }}>
        <h3>Visual pacing — {stats.chunks} audio chunks · {stats.images} images · ~{fmtClock(stats.runtimeS)}</h3>
        <span>working/visual-pacing-plan.md</span>
      </div>

      <TimelineScroller
        zoom={zoom}
        setZoom={setZoom}
        hint="Hover to inspect · right-click to edit, add, or remove · drag the edge between two blocks to rebalance their time · drag the timeline to pan when zoomed"
      >
        {/* Row order follows video-editor convention: overlays on top, then
            the visual track, the audio (chunks), sections, and the clock. */}
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

        <div className="vp-tl-row">
          <span className="vp-tl-label">Visuals</span>
          <div className="vp-tl-track visuals">
            {images.map((img) => (
              <button
                type="button"
                key={img.id}
                className={`vp-seg ${img.id === activeId ? 'on' : ''}`}
                style={{ left: `${pct(img.startS)}%`, width: `${pct(img.holdS)}%` }}
                onMouseEnter={() => setActiveFromTimeline(img.id)}
                onFocus={() => setActiveFromTimeline(img.id)}
                onContextMenu={(e) => openMenu(e, { chunkId: img.chunkId, beatCode: img.beatCode, imageId: img.id })}
                title={`${img.id} · ${img.holdS.toFixed(1)}s — right-click to edit`}
              >
                <span>{img.id}</span>
              </button>
            ))}
            {/* Drag handles on EVERY boundary between adjacent images —
                zero-sum: one grows, the other shrinks (total runtime fixed).
                Real timing supersedes these estimates when audio lands. */}
            {images.map((img, idx) => {
              const nxt = images[idx + 1]
              if (!nxt) return null
              return (
                <div
                  key={`h-${img.id}`}
                  data-no-pan
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

        {/* "Audio chunks": the narration owns these units — per-template
            naming can come from the contract once multi-template lands. */}
        <div className="vp-tl-row">
          <span className="vp-tl-label">Audio chunks</span>
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

        {/* SECTIONS at the bottom: dimension lines (|— opening · 5/9 img —|).
            Click a label to edit name/targets; drag the shared tick to move
            the boundary. Amber = outside a user-set target. */}
        <div className="vp-tl-row">
          <span className="vp-tl-label">Sections</span>
          <div className="vp-tl-track" style={{ position: 'relative', height: 20 }}>
            {secs.map((s, k) => {
              const over = isOverBudget(s.imageBudget, s.imageCount) || isOverBudget(s.overlayBudget, s.overlayCount)
              const under = isUnderBudget(s.imageBudget, s.imageCount) || isUnderBudget(s.overlayBudget, s.overlayCount)
              const color = over || under ? 'var(--amber)' : 'var(--ink-3)'
              return (
                <button
                  type="button"
                  key={`${s.name}-${k}`}
                  onClick={() => openSectionEdit(k)}
                  title={`${s.name}: ${fmtClock(s.fromS)}–${fmtClock(s.toS)} · ${s.imageCount}${s.imageBudget ? `/${fmtBudget(s.imageBudget)}` : ''} images${s.overlayBudget ? ` · ${s.overlayCount}/${fmtBudget(s.overlayBudget)} overlays` : ''} — click to set targets`}
                  style={{
                    position: 'absolute', left: `${pct(s.fromS)}%`, width: `${pct(s.toS - s.fromS)}%`,
                    top: 0, bottom: 0, display: 'flex', alignItems: 'center', gap: 6,
                    background: 'none', border: 'none',
                    borderLeft: `1px solid ${color}`, borderRight: `1px solid ${color}`,
                    padding: '0 4px', cursor: 'pointer', color, fontSize: 10, letterSpacing: '.04em',
                  }}
                >
                  <i style={{ flex: 1, height: 1, background: color, opacity: 0.5 }} />
                  <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {s.name} · {s.imageCount}{s.imageBudget ? `/${fmtBudget(s.imageBudget)}` : ''} img
                    {s.overlayBudget ? ` · ${s.overlayCount}/${fmtBudget(s.overlayBudget)} ovl` : ''}
                    {over ? ' · over budget' : under ? ' · under range' : ''}
                  </span>
                  <i style={{ flex: 1, height: 1, background: color, opacity: 0.5 }} />
                </button>
              )
            })}
            {secs.slice(0, -1).map((s, k) => (
              <div
                key={`sb-${k}`}
                data-no-pan
                title={`Drag to move the ${s.name} boundary (${fmtClock(s.toS)})`}
                onPointerDown={(e) => startSecDrag(e, k)}
                style={{
                  position: 'absolute', left: `calc(${pct(s.toS)}% - 4px)`,
                  top: -2, bottom: -2, width: 8, cursor: 'ew-resize', zIndex: 3, touchAction: 'none',
                }}
              />
            ))}
          </div>
        </div>

        {/* The clock — the very bottom row. */}
        <div className="vp-tl-row axis">
          <span className="vp-tl-label" />
          <div className="vp-tl-track">
            {ticks.map((t) => (
              <span key={t} className="vp-tick" style={{ left: `${pct(t)}%` }}>{fmtClock(t)}</span>
            ))}
            <span className="vp-tick end" style={{ left: '100%' }}>{fmtClock(totalSec)}</span>
          </div>
        </div>
      </TimelineScroller>

      {editing ? (
        <div
          className="vp-edit"
          ref={editBoxRef}
          style={{ resize: 'both', overflow: 'auto', minWidth: 380, minHeight: 150, maxWidth: '100%' }}
        >
          <div className="vp-edit-head">
            <span className="id">
              {editing.scope === 'image'
                ? editing.imageId
                : editing.scope === 'overlay'
                  ? editing.overlayId
                  : editing.scope === 'section'
                    ? (secs[editing.index]?.name ?? 'section')
                    : editing.chunkId}
            </span>
            <b>{editing.isNew ? 'New' : 'Editing'} {editing.scope === 'chunk' ? 'audio chunk' : editing.scope}</b>
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
                <label className="vp-edit-field">Narration (the script lines this audio chunk covers)
                  <textarea rows={2} value={editing.narration} onChange={(e) => setDraftField({ narration: e.target.value })} placeholder="Paste the narration sentence(s) from the script…" />
                </label>
              ) : null}
            </>
          ) : editing.scope === 'section' ? (
            <>
              <div className="vp-edit-grid">
                <label>Name<input value={editing.name} onChange={(e) => setDraftField({ name: e.target.value })} placeholder="opening" /></label>
                {editing.index < secs.length - 1 ? (
                  <label>Ends at<input value={editing.to} onChange={(e) => setDraftField({ to: e.target.value })} placeholder="45s" /></label>
                ) : null}
                <label>Image target<input value={editing.imageBudget} onChange={(e) => setDraftField({ imageBudget: e.target.value })} placeholder="e.g. 10 or 8-12" /></label>
                <label>Overlay target<input value={editing.overlayBudget} onChange={(e) => setDraftField({ overlayBudget: e.target.value })} placeholder="e.g. 2 or 1-3" /></label>
              </div>
              <p className="vp-hint" style={{ margin: '8px 0 0' }}>
                Targets are read by “Re-draft with AI” above — the AI must stay at or under them
                (checked by code, drafts over budget are rejected). Editing here doesn’t move
                images by itself.
              </p>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button type="button" className="vp-undo" onClick={() => splitSection(editing.index)}>Split in half</button>
                {editing.index > 0 ? (
                  <button type="button" className="vp-undo" onClick={() => mergeSection(editing.index)}>Merge into previous</button>
                ) : null}
              </div>
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
              {/* THE REAL FILE: paste a direct GIF link and the engine fetches
                  it into the session — the overlay stops being just an idea. */}
              <label className="vp-edit-field">Attach the actual GIF (paste a Tenor/Giphy direct link)
                <span style={{ display: 'flex', gap: 8 }}>
                  <input
                    value={assetUrl}
                    onChange={(e) => setAssetUrl(e.target.value)}
                    placeholder="https://media.tenor.com/….gif"
                    style={{ flex: 1 }}
                  />
                  <button type="button" className="vp-undo" disabled={fetchingAsset || !assetUrl.trim()} onClick={fetchOverlayAsset}>
                    {fetchingAsset ? 'Fetching…' : 'Fetch & attach'}
                  </button>
                </span>
              </label>
              {assetErr ? <p className="vp-hint" style={{ color: 'var(--red)', margin: '4px 0 0' }}>{assetErr}</p> : null}
              {editing.asset ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
                  <video src={assetSrc(editing.asset)} muted loop autoPlay playsInline style={{ maxHeight: 110, borderRadius: 6 }} />
                  <span className="label" style={{ flex: 1 }}>{editing.asset}</span>
                  <button type="button" className="vp-undo" onClick={() => setDraftField({ asset: '' })}>Detach</button>
                </div>
              ) : (
                <p className="vp-hint" style={{ margin: '6px 0 0' }}>
                  No file attached yet — the Compile Shot List step requires every overlay to have a file
                  or an explicit skip.
                </p>
              )}
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
            <button type="button" onClick={() => startEditChunk(menu.chunkId)}>Edit audio chunk</button>
            <button type="button" onClick={() => startAddChunk(menu.chunkId, 'before')}>Add audio chunk before</button>
            <button type="button" onClick={() => startAddChunk(menu.chunkId, 'after')}>Add audio chunk after</button>
            <button type="button" className="danger" onClick={() => removeChunk(menu.chunkId)}>Remove audio chunk</button>
          </div>
        </>
      ) : null}

      <div className="vp-viewbar">
        <h4 className="vp-sub-h">Pacing</h4>
        <div className="vp-viewtoggle">
          <button type="button" className={view === 'script' ? 'on' : ''} onClick={() => setView('script')}>Script</button>
          <button type="button" className={view === 'table' ? 'on' : ''} onClick={() => setView('table')}>Table</button>
        </div>
        <button
          type="button"
          className="vp-undo"
          title="See or edit the exact text file the engine reads"
          style={{ marginLeft: 8 }}
          onClick={() => setRaw(true)}
        >
          Edit as text
        </button>
      </div>

      {view === 'table' ? (
        <div className="table-wrap" ref={listRef} style={{ maxHeight: '48vh', overflowY: 'auto', paddingBottom: listOverflows ? '24vh' : 0 }}>
          <table className="shots vp-pacing">
            <thead>
              <tr><th>Start</th><th>Img</th><th>Audio chunk</th><th>Visual</th><th>Hold</th><th></th></tr>
            </thead>
            <tbody>
              {images.map((img) => (
                <tr key={img.id} data-img={img.id} className={img.id === activeId ? 'on' : ''} onMouseEnter={() => setActiveId(img.id)}>
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
        <div
          className="vp-script"
          ref={listRef}
          style={{ maxHeight: '48vh', overflowY: 'auto', paddingBottom: listOverflows ? '24vh' : 0, ...(scriptDrag ? { userSelect: 'none', cursor: 'grabbing' } : {}) }}
        >
          {dp.chunks.map((chunk) => {
            const { words, imgs, spans } = chunkWordData(chunk)
            const beatOf: Record<string, string> = {}
            for (const b of chunk.beats) for (const im of b.images) beatOf[im.id] = b.code
            const dragHere = scriptDrag && scriptDrag.chunkId === chunk.id
            return (
              <p className="vp-script-chunk" key={chunk.id}>
                <span className="vp-script-cid">{chunk.id}</span>
                {words.map((cw, i) => {
                  const ownerIdx = spans.findIndex((s) => i >= s.from && i <= s.to)
                  const owner = ownerIdx >= 0 ? spans[ownerIdx] : undefined
                  const cls = ['vp-w']
                  if (owner) cls.push('img')
                  if (owner && owner.id === activeId) cls.push('on')
                  const ownerImg = ownerIdx >= 0 ? imgs[ownerIdx] : undefined
                  const isDropTarget = !!dragHere && scriptDrag!.candidate === i
                  return (
                    <span key={`${chunk.id}:${i}`}>
                      {owner && i === owner.from ? (
                        <span
                          className="vp-w-tag"
                          data-img={owner.id}
                          title={
                            ownerIdx === 0
                              ? `${ownerImg?.what ?? ''} — starts the chunk (drag the tags after it)`
                              : `${ownerImg?.what ?? ''} — drag between words to change when this image appears`
                          }
                          onPointerDown={ownerIdx > 0 ? (e) => startTagDrag(e, chunk.id, owner.id) : undefined}
                          style={{
                            cursor: ownerIdx > 0 ? (scriptDrag?.imageId === owner.id ? 'grabbing' : 'grab') : 'default',
                            touchAction: 'none',
                            opacity: scriptDrag && scriptDrag.imageId !== owner.id ? 0.5 : undefined,
                          }}
                        >
                          {owner.id}
                        </span>
                      ) : null}
                      <span
                        className={cls.join(' ')}
                        data-chunk={chunk.id}
                        data-widx={i}
                        onMouseEnter={owner && !scriptDrag ? () => setActiveId(owner.id) : undefined}
                        onClick={owner && !scriptDrag ? (e) => openMenu(e, { chunkId: chunk.id, beatCode: beatOf[owner.id], imageId: owner.id }) : undefined}
                        style={isDropTarget ? { outline: '1px dashed var(--ink-2)', borderRadius: 3 } : undefined}
                      >{cw.w}</span>{' '}
                    </span>
                  )
                })}
              </p>
            )
          })}
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
              <tr><th>ID</th><th>Trigger</th><th>Overlay</th><th>File</th><th>On image</th><th>Hold</th><th>Placement</th><th></th></tr>
            </thead>
            <tbody>
              {p.overlays.map((o) => (
                <tr key={o.id}>
                  <td><span className="id">{o.id}</span></td>
                  <td className="narr">"{o.trigger}"</td>
                  <td>{o.what}</td>
                  <td>
                    {o.asset ? (
                      <video src={assetSrc(o.asset)} muted loop autoPlay playsInline title={o.asset} style={{ height: 36, borderRadius: 4, display: 'block' }} />
                    ) : (
                      <span className="label" title="No file yet — edit the overlay to attach one">idea only</span>
                    )}
                  </td>
                  <td><span className="id">{o.anchor}</span></td>
                  <td className="vp-mono">{o.holdS.toFixed(1)}s</td>
                  <td>{o.placement}</td>
                  <td className="vp-row-cell">
                    <button
                      type="button"
                      className="vp-row-menu"
                      title="Edit overlay"
                      onClick={() => setEditing({ scope: 'overlay', overlayId: o.id, isNew: false, anchor: o.anchor, trigger: o.trigger, what: o.what, hold: `${o.holdS}s`, placement: o.placement, asset: o.asset })}
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
          onClick={() => setEditing({ scope: 'overlay', overlayId: nextOverlayId(), isNew: true, anchor: active?.id ?? '', trigger: '', what: '', hold: '2s', placement: 'centered', asset: '' })}
        >
          + Add overlay
        </button>
      </details>
    </div>
  )
}
