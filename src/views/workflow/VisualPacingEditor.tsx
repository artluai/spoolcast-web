import { useEffect, useMemo, useRef, useState } from 'react'
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
import { parseScreenplay } from '../../lib/screenplay-md'
import { actionUrl, activeSession, apiUrl, contentUrl, fileUrl, templatesUrl } from '../../lib/api'
import { useWorkflowStore } from '../../store/workflow'
import { VariantModule } from './VariantModule'
import { mergeKitWithDraft, patchDraftAudioLink, useWorldKitDraft } from '../../lib/kit-draft'
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

// A SHOT is one continuous take. Name the medium when the project has settled
// on one — "6 video clips" says more than "6 shots" and tells you where the
// money goes. Under a mixed project, or before the medium is known, the
// neutral word is the honest one. Never say "images" for generated video: that
// wording is what let a 2.5s "image" reach a 4s-minimum video model.
// Audio-kind kit objects: never on the visual wall; attachable to shots
// (music spans) or linked to characters (voices).
const AUDIO_KINDS = new Set(['voice', 'music', 'ambience', 'sfx', 'audio'])

const shotNoun = (n: number, medium?: string) => {
  if (medium === 'video') return n === 1 ? 'video clip' : 'video clips'
  if (medium === 'image') return n === 1 ? 'image' : 'images'
  return n === 1 ? 'shot' : 'shots'
}

export function VisualPacingEditor({ stageId }: { stageId: string }) {
  const draft = useWorkflowStore((s) => s.stageDrafts[stageId] ?? '')
  const setStageDraft = useWorkflowStore((s) => s.setStageDraft)
  const [history, setHistory] = useState<string[]>([])
  const [redoHistory, setRedoHistory] = useState<string[]>([])
  const [raw, setRaw] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; chunkId: string; beatCode?: string; imageId?: string } | null>(null)
  const [editing, setEditing] = useState<EditDraft | null>(null)
  // The MAPPING board is the primary view: Spoolcast is visual-first, and
  // which reference images each shot is shown matters more than its table row.
  const [view, setView] = useState<'table' | 'script' | 'map'>('map')
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
  // Session media preview URL, served by the engine.
  const assetSrc = (rel: string) => contentUrl(rel, 'preview')
  const fetchOverlayAsset = async () => {
    setEditing((d) => d) // keep editor open
    const cur = editing
    if (!cur || cur.scope !== 'overlay' || !assetUrl.trim()) return
    setFetchingAsset(true)
    setAssetErr(null)
    try {
      const r = await fetch(actionUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: activeSession(),
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

  // The project's shot medium and its CLOCK. Two different questions: the
  // medium is stills-vs-clips, the clock is who owns the timeline. An
  // audio-first project can use video clips (news-anime-bot does), so the
  // medium cannot answer whether audio is a separate track.
  // MUST sit above the early return below: hooks run in call order.
  const [shotMedium, setShotMedium] = useState('')
  const [audioIsSeparate, setAudioIsSeparate] = useState(true)
  useEffect(() => {
    let live = true
    Promise.all([
      fetch(fileUrl('session.json')).then((r) => (r.ok ? r.json() : null)),
      fetch(templatesUrl()).then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([sess, reg]) => {
        if (!live || typeof sess?.data?.content !== 'string') return
        const cfg = JSON.parse(sess.data.content)
        const m = String(cfg?.shot_medium || '')
        if (m === 'video' || m === 'image') setShotMedium(m)
        const hit = reg?.data?.templates?.find((t: { id?: string }) => t.id === String(cfg?.template || ''))
        // Video-first generates picture and sound together, so there is no
        // separate audio track to show. Default true: an unknown template is
        // audio-first-shaped, and hiding a real lane is worse than showing it.
        if (hit?.format === 'video-first') setAudioIsSeparate(false)
      })
      .catch(() => {
        /* engine offline — the neutral word still reads correctly */
      })
    return () => {
      live = false
    }
  }, [])

  // THE KIT, AS OBJECTS: every World Kit reference — kind, description, and
  // its picked image when one exists. OBJECT-FIRST: a prompt-only ref is a
  // real kit object and gets a real card; it just has no image yet.
  type KitObject = { name: string; kind: string; notes: string; image_path: string; group?: string; variant_of?: string; active_prompt?: string; active_model?: string }
  const [rawKit, setKit] = useState<KitObject[]>([])
  // THE KIT THE BOARD SEES = engine file + unsaved step-5 draft overlaid.
  // Linking audio in the World Kit shows here immediately, no save required.
  const wkDraft = useWorldKitDraft()
  const kit = useMemo(() => mergeKitWithDraft(rawKit, wkDraft), [rawKit, wkDraft])
  // The session's raw source pool (intake uploads, external assets). Images
  // here that no kit object maps yet show on the board as importable cards —
  // the shoe's side/detail views were sitting in external-assets, visible in
  // prompts but never importable from the board.
  const [srcPool, setSrcPool] = useState<{ path: string; ref?: string; imported_as?: string }[]>([])
  // heic included: /api/content transcodes for display, and import converts
  // to JPEG before registering (kie can't take HEIC itself).
  const isDisplayable = (p: string) => /\.(png|jpe?g|webp|heic)$/i.test(p)
  useEffect(() => {
    let live = true
    fetch(apiUrl('source-images', { session: activeSession(), include_refs: 1 }))
      .then((r) => (r.ok ? r.json() : null))
      .then((out) => {
        if (!live) return
        if (!Array.isArray(out?.data?.kit)) return
        const kitArr = out.data.kit as KitObject[]
        const srcArr = (Array.isArray(out.data.images) ? out.data.images : []) as { path: string; ref?: string }[]
        setKit(kitArr)
        setSrcPool(srcArr)
        // Measure every image OFF-DOM in one batch and commit ratios once.
        // Measuring via the cards' own onLoad re-packed the wall per image,
        // React remounted the migrating cards, their loads restarted, and
        // the loop meant no image ever finished. One batch, one commit.
        // Source-pool images key their ratio by PATH (that is their name on
        // the board until they are imported).
        const toMeasure = [
          ...kitArr.filter((k) => k.image_path).map((k) => ({ key: k.name, path: k.image_path })),
          ...srcArr.filter((s) => !s.ref && isDisplayable(s.path)).map((s) => ({ key: s.path, path: s.path })),
        ]
        Promise.allSettled(
          toMeasure.map(
            (m) =>
              new Promise<[string, number]>((resolve, reject) => {
                const im = new Image()
                im.onload = () => resolve([m.key, im.naturalHeight / im.naturalWidth || 1.25])
                im.onerror = reject
                im.src = contentUrl(m.path)
              }),
          ),
        ).then((results) => {
          if (!live) return
          const next: Record<string, number> = {}
          for (const r of results) if (r.status === 'fulfilled') next[r.value[0]] = r.value[1]
          if (Object.keys(next).length) setImgRatios((cur) => ({ ...cur, ...next }))
        })
      })
      .catch(() => {
        /* engine offline — the free-text refs field still works */
      })
    return () => {
      live = false
    }
  }, [])


  // MAPPING BOARD state: selected shot (expands + lights its threads, dims
  // unlinked refs), AI-mapping flight, and the measured thread geometry.
  // Threads are SVG curves between DOM cards — measured after paint,
  // re-measured on resize and settle timers; equality guard stops loops.
  const [mapSel, setMapSel] = useState('')
  const [mapAI, setMapAI] = useState(false)
  // null = no user preference yet: hidden by default on the mapping board
  // (the board is the star there), shown by default on script/table.
  const [tlOpen, setTlOpen] = useState<boolean | null>(null)
  // VARIANT creation: any kit object can get one — same setup, one
  // deliberate change. An image-backed base generates with its picked image
  // as the base reference; a prompt-only base varies the prompt itself.
  const [variantFor, setVariantFor] = useState<KitObject | null>(null)
  const [vInitPos, setVInitPos] = useState<{ x: number; y: number } | undefined>(undefined)
  // Lightbox: any kit/attachment image, full size.
  const [lightbox, setLightbox] = useState('')
  const refetchKit = async () => {
    const out = await fetch(apiUrl('source-images', { session: activeSession(), include_refs: 1 })).then((r) => (r.ok ? r.json() : null)).catch(() => null)
    if (Array.isArray(out?.data?.kit)) setKit(out.data.kit)
    if (Array.isArray(out?.data?.images)) setSrcPool(out.data.images)
    return (out?.data?.kit ?? []) as KitObject[]
  }
  // IMPORT a raw source image into the World Kit (registry row + mapped
  // manifest) — after this it is a normal kit object: attachable, variantable.
  const [importingSrc, setImportingSrc] = useState('')
  const importSource = async (path: string) => {
    if (importingSrc) return
    setImportingSrc(path)
    try {
      const r = await fetch(actionUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: activeSession(), tenant: 'local', action: 'import_source_ref', path }),
      })
      const out = await r.json().catch(() => null)
      if (r.ok && out?.ok !== false) {
        const name = out?.data?.name as string | undefined
        // The ratio was measured under the path key; the imported object is
        // the same pixels under its new name.
        if (name) setImgRatios((cur) => (cur[path] != null ? { ...cur, [name]: cur[path] } : cur))
        await refetchKit()
        // A shot is open: clicking a wall card means ATTACH — importing was
        // just the necessary first half (the engine dedupes by source path,
        // so a re-click attaches the existing object instead of duplicating).
        if (name && mapSel) toggleMapRef(mapSel, name)
      }
    } catch {
      /* engine offline — the card stays importable */
    } finally {
      setImportingSrc('')
    }
  }
  const tlShown = tlOpen ?? view !== 'map'
  const [threads, setThreads] = useState<{ shot: string; ref: string; d: string }[]>([])
  const boardRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  // The host .detail-card clips with overflow:hidden, and any overflow value
  // other than visible traps position:sticky inside the card — the World Kit
  // and the timeline bar can then never pin to the real scroller. Lift the
  // clip while this editor is mounted (fullscreen mode scrolls the card
  // itself, so it keeps its own overflow).
  // No dep array: the first render can be the no-draft early return (root div
  // absent, ref null), so a mount-only effect would never see the host.
  useEffect(() => {
    const host = rootRef.current?.closest('.detail-card') as HTMLElement | null
    if (!host) return
    host.classList.add('vp-sticky-host')
    // The step header is itself sticky at the top of the scroller; our own
    // sticky pieces (kit, timeline) must pin BELOW it, not slide under it.
    const head = host.querySelector<HTMLElement>('.detail-head')
    if (head) host.style.setProperty('--vp-head-h', `${head.offsetHeight}px`)
    return () => host.classList.remove('vp-sticky-host')
  })
  const measureThreads = () => {
    const board = boardRef.current
    if (!board) return
    const box = board.getBoundingClientRect()
    const out: { shot: string; ref: string; d: string }[] = []
    const listBox = board.querySelector('.vp-map-shotlist')?.getBoundingClientRect()
    // The VISIBLE window of the shot column: the list clipped to the viewport
    // and pushed below the sticky step header. The list's own rect extends
    // off-screen when the page scrolls — clamping against it anchored threads
    // to points nobody can see.
    const headEl = board.closest('.vp-sticky-host')?.querySelector('.detail-head')
    const scrollerBox = (board.closest('.workflow-view') as HTMLElement | null)?.getBoundingClientRect()
    const visTop = Math.max(listBox?.top ?? 0, headEl ? headEl.getBoundingClientRect().bottom : 0, scrollerBox?.top ?? 0, 0)
    const visBottom = Math.min(listBox?.bottom ?? Infinity, scrollerBox?.bottom ?? Infinity, window.innerHeight)
    board.querySelectorAll<HTMLElement>('[data-mapshot]').forEach((shotEl) => {
      const names = (shotEl.dataset.maprefs || '').split('|').filter(Boolean)
      const a = shotEl.getBoundingClientRect()
      // A shot with no part in the visible window gets no threads; a partly
      // visible one anchors them to its on-screen sliver.
      if (a.bottom < visTop + 4 || a.top > visBottom - 4) return
      for (const name of names) {
        const refEl = board.querySelector<HTMLElement>(`[data-mapref="${CSS.escape(name)}"]`)
        if (!refEl) continue
        const b = refEl.getBoundingClientRect()
        // BOTH ends obey the visible window — a kit card scrolled behind the
        // sticky header must not pull its thread up across it. The curve's
        // control points share the endpoints' y, so clamping the endpoints
        // bounds the whole path.
        if (b.bottom < visTop + 4 || b.top > visBottom - 4) continue
        const x1 = a.right - box.left
        let yAnchor = a.top + Math.min(28, a.height / 2)
        yAnchor = Math.max(visTop + 12, Math.min(visBottom - 12, yAnchor))
        const y1 = yAnchor - box.top
        const x2 = b.left - box.left
        const y2 = Math.max(visTop + 12, Math.min(visBottom - 12, b.top + Math.min(40, b.height / 2))) - box.top
        out.push({ shot: shotEl.dataset.mapshot!, ref: name, d: `M ${x1} ${y1} C ${x1 + 55} ${y1}, ${x2 - 55} ${y2}, ${x2} ${y2}` })
      }
    })
    setThreads((cur) => (JSON.stringify(cur) === JSON.stringify(out) ? cur : out))
  }
  // KIT LAYOUT IS OURS, NOT THE BROWSER'S. CSS multicol kept reverting to
  // sequential fill (balance is spec'd to switch off whenever content
  // overflows), which resurrected the dead-space staircase at laptop sizes.
  // So placement is explicit: measure the kit box, try column widths from
  // wide to narrow, greedily drop each card into the shortest column, and
  // accept the widest layout whose tallest column fits the window. A kit too
  // big at the narrowest width grows extra columns and scrolls SIDEWAYS.
  const [kitDims, setKitDims] = useState({ w: 1000, h: 700 })
  // User-hidden references (persisted per session): excluded from the wall
  // and the packing budget until "Show all".
  // Which shot's "♪ add audio" menu is open (img.id) — one at a time.
  const [audioMenuFor, setAudioMenuFor] = useState<string | null>(null)
  // Which attachment's position picker is open (`shotId:name`).
  const [posMenuFor, setPosMenuFor] = useState<string | null>(null)
  const [hiddenRefs, setHiddenRefs] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(`sc-map-hidden-${activeSession()}`) || '[]') } catch { return [] }
  })
  const persistHidden = (names: string[]) => {
    setHiddenRefs(names)
    try { localStorage.setItem(`sc-map-hidden-${activeSession()}`, JSON.stringify(names)) } catch { /* private mode */ }
  }
  // Consistency groups ride in from the screenplay (one clip = one shot, so
  // index i maps when the counts line up). Shown as badges on shot cards.
  const [clipGroups, setClipGroups] = useState<string[]>([])
  useEffect(() => {
    let live = true
    fetch(fileUrl('working/screenplay-v3.md'))
      .then((r) => (r.ok ? r.json() : null))
      .then((out) => {
        if (!live || typeof out?.data?.content !== 'string') return
        const doc = parseScreenplay(out.data.content)
        setClipGroups((doc.clips ?? []).map((c) => c.group))
      })
      .catch(() => {
        /* no screenplay yet — no badges */
      })
    return () => {
      live = false
    }
  }, [])
  // Threads vanish while scrolling and reappear (re-measured) at rest —
  // stale curves pointing at moved cards are worse than none.
  const [threadsHidden, setThreadsHidden] = useState(false)
  const scrollIdleRef = useRef(0)
  const onAnyScroll = () => {
    setThreadsHidden(true)
    window.clearTimeout(scrollIdleRef.current)
    scrollIdleRef.current = window.setTimeout(() => {
      measureThreads()
      setThreadsHidden(false)
    }, 150)
  }
  const [imgRatios, setImgRatios] = useState<Record<string, number>>({})
  const noteRatio = (name: string) => (e: React.SyntheticEvent<HTMLImageElement>) => {
    const im = e.currentTarget
    const r = im.naturalHeight / im.naturalWidth || 1.25
    setImgRatios((cur) => (Math.abs((cur[name] ?? 0) - r) < 0.01 ? cur : { ...cur, [name]: r }))
  }
  const fitKit = () => {
    const board = boardRef.current
    const kitEl = board?.querySelector<HTMLElement>('.vp-map-kit')
    const scroller = board?.closest('.workflow-view') as HTMLElement | null
    if (!board || !kitEl || !scroller) return
    // The height budget must come from the REAL window, however this app is
    // hosted — users don't send screenshots of their vh. The kit is sticky
    // inside the workflow scroller, so the honest budget is the scroller's
    // VISIBLE span: once the user scrolls the board to the top, the kit can
    // use all of it. Subtracting the kit's pre-scroll page position (the old
    // formula) permanently gave away everything above the board.
    const vh = Math.max(
      window.innerHeight || 0,
      document.documentElement.clientHeight || 0,
      window.visualViewport?.height || 0,
    )
    const sRect = scroller.getBoundingClientRect()
    let span = 0
    if (sRect.height > 0) {
      const top = Math.max(sRect.top, 0)
      const bottom = vh > 0 ? Math.min(sRect.bottom, vh) : sRect.bottom
      span = bottom - top
    }
    if (span <= 0) span = vh || 660
    // The sticky step header sits above us inside the same scroller; the kit
    // pins below it, so its height comes out of the budget.
    const headH = (board.closest('.detail-card')?.querySelector<HTMLElement>('.detail-head'))?.offsetHeight || 0
    const H = Math.max(420, Math.round(span - headH - 24))
    kitEl.style.maxHeight = `${H}px`
    // The shots column flows at natural height and scrolls WITH the page —
    // capping it to H would make the board's total height equal the kit's,
    // leaving the sticky kit zero travel (sticky can never pin inside a
    // parent its own size). The kit stays pinned while shots scroll past.
    const list = board.querySelector<HTMLElement>('.vp-map-shotlist')
    if (list) list.style.maxHeight = ''
    const w = kitEl.clientWidth || 1000
    // The wall's budget: kit height minus the column head, minus the bottom
    // "Show all" row when hidden refs exist (it lives in normal flow now).
    const h = H - 26 - (hiddenRefs.length ? 36 : 0)
    setKitDims((cur) => (Math.abs(cur.w - w) < 8 && Math.abs(cur.h - h) < 8 ? cur : { w, h }))
    measureThreads()
  }
  // THE PACKING EQUATION — equal square footage, NO ROWS. Every image gets
  // the SAME area A on screen, its shape computed from its own ratio
  // (w = √(A/r), h = w·r): a portrait and a landscape occupy identical
  // footprint, just shaped differently. Masters (and their variants) get a
  // deliberately larger area; prompt-only cards are a fixed box of
  // comparable size, never inflated — images are what the space is for.
  // Placement is bottom-left skyline: each card drops into the lowest open
  // pocket (leftmost on ties), so a tall portrait interlocks with stacked
  // landscapes instead of forcing a shared shelf line — there is no row to
  // align to and no row-justify stretch, so equal area is exact. Binary
  // search finds the LARGEST A whose packed height still fits the kit's
  // vertical budget: as big as the space mathematically allows without
  // vertical scrolling.
  const GAP = 10
  type Packed = { k: { name: string; kind: string; notes: string; image_path: string }; w: number; h: number; x: number; y: number }
  const packKit = (objects: { name: string; kind: string; notes: string; image_path: string }[]) => {
    const W = Math.max(320, kitDims.w)
    const HB = Math.max(240, kitDims.h - 8)
    const STEP = 8 // skyline resolution; cards land on an 8px grid
    const layout = (A: number): { items: Packed[]; totalH: number } => {
      // Text cards: a fixed 1.4:1 box at ~70% of the image area — comparable
      // to its neighbors, but the pictures always read larger.
      const tw = Math.round(Math.min(W - 8, Math.max(150, Math.sqrt(A * 0.7 * 1.4))))
      const th = Math.round(Math.max(105, tw / 1.4))
      const cols = Math.max(1, Math.floor(W / STEP))
      const heights = new Array<number>(cols).fill(0)
      const items: Packed[] = []
      let totalH = 0
      for (const k of objects) {
        let w = tw
        let h = th
        if (k.image_path) {
          const r = imgRatios[k.name] ?? 1.25
          const area = k.kind === 'master' || k.kind === 'variant' ? A * 1.5 : A
          w = Math.round(Math.min(W - 8, Math.max(90, Math.sqrt(area / r))))
          h = Math.round(w * r)
        }
        const span = Math.min(cols, Math.ceil((w + GAP) / STEP))
        let bestC = 0
        let bestY = Infinity
        for (let c = 0; c + span <= cols; c += 1) {
          let y = 0
          for (let i = c; i < c + span; i += 1) y = Math.max(y, heights[i])
          if (y < bestY - 0.5) {
            bestY = y
            bestC = c
          }
        }
        if (!Number.isFinite(bestY)) {
          bestY = Math.max(0, ...heights)
          bestC = 0
        }
        items.push({ k, w, h, x: bestC * STEP, y: bestY })
        const top = bestY + h + GAP
        for (let i = bestC; i < Math.min(cols, bestC + span); i += 1) heights[i] = top
        totalH = Math.max(totalH, bestY + h)
      }
      return { items, totalH }
    }
    let lo = 7000
    let hi = 220000
    let best = layout(lo)
    if (best.totalH > HB) return best // even minimal doesn't fit — show anyway
    for (let i = 0; i < 14; i += 1) {
      const mid = (lo + hi) / 2
      const cand = layout(mid)
      if (cand.totalH <= HB) {
        best = cand
        lo = mid
      } else hi = mid
    }
    return best
  }

  // Threads re-measure when the board's data settles.
  useEffect(() => {
    if (view !== 'map') return
    const settle = () => {
      fitKit()
      measureThreads()
    }
    const raf = requestAnimationFrame(settle)
    const timers = [150, 500, 1300, 2600].map((ms) => window.setTimeout(settle, ms))
    const ro = new ResizeObserver(() => measureThreads())
    if (boardRef.current) ro.observe(boardRef.current)
    window.addEventListener('resize', measureThreads)
    // The kit column is sticky: scrolling moves it relative to the board, so
    // thread endpoints go stale without a scroll re-measure (rAF-throttled).
    const scroller = boardRef.current?.closest('.workflow-view')
    let ticking = false
    const onScroll = () => {
      onAnyScroll()
      if (ticking) return
      ticking = true
      requestAnimationFrame(() => {
        ticking = false
        measureThreads()
      })
    }
    scroller?.addEventListener('scroll', onScroll)
    const shotList = boardRef.current?.querySelector('.vp-map-shotlist')
    shotList?.addEventListener('scroll', onScroll)
    // Scroll EVENTS are not trustworthy on this container (observed: scrollTop
    // changes with zero scroll events fired) — so threads went stale and drew
    // off-section. Watch the POSITION itself: any movement hides threads and
    // arms the idle re-measure, no event required.
    let lastPos = -1
    let watchId = 0
    const checkPos = () => {
      const pos = ((scroller as HTMLElement | null)?.scrollTop ?? 0) + ((shotList as HTMLElement | null)?.scrollTop ?? 0) + window.scrollY
      if (pos !== lastPos) {
        if (lastPos !== -1) onScroll()
        lastPos = pos
      }
    }
    const watchPos = () => {
      checkPos()
      watchId = requestAnimationFrame(watchPos)
    }
    watchId = requestAnimationFrame(watchPos)
    // rAF stops in hidden/embedded contexts — the interval is the backstop
    // that keeps threads honest wherever the page renders.
    const watchIv = window.setInterval(checkPos, 300)
    // The kit column must keep EVERY reference on screen while the shots
    // scroll: cap its height to the real scroller viewport (not 100vh — the
    // embedded preview reports a zero viewport, and the scroller is the truth
    // in any host). Inner scroll is the fallback if a huge kit still overflows.
    fitKit()
    const kro = new ResizeObserver(() => fitKit())
    if (scroller) kro.observe(scroller)
    const kitEl = boardRef.current?.querySelector('.vp-map-kit')
    if (kitEl) kro.observe(kitEl)
    return () => {
      cancelAnimationFrame(raf)
      timers.forEach((id) => window.clearTimeout(id))
      ro.disconnect()
      kro.disconnect()
      window.removeEventListener('resize', measureThreads)
      scroller?.removeEventListener('scroll', onScroll)
      shotList?.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(watchId)
      window.clearInterval(watchIv)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, draft, mapSel, kit, imgRatios, srcPool, hiddenRefs.length])

  // What C001 actually is. Only an audio-first project's chunks are audio.
  const chunkWord = audioIsSeparate ? 'audio chunk' : 'scene'

  if (!draft.trim()) {
    // One line — if the step is blocked, the blocker card below explains.
    return (
      <p style={{ color: 'var(--ink-2)', fontSize: 13, lineHeight: 1.6, margin: '4px 0 0' }}>
        No pacing plan yet — this step maps every narration beat to a shot (what the viewer
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

  // MAPPING BOARD actions — all through the same parse→mutate→serialize path
  // as every other edit (step Undo covers them). The refs cell is an ORDERED
  // comma list; `^name` marks the shot's FIRST FRAME (the generator opens on
  // that exact image — mirrors _first_frame_from_cell in build_shot_list.py).
  // "—" (and "-") is the plan's EMPTY-CELL placeholder, not a reference —
  // letting it through rendered a ghost attachment with no name and no image.
  const refsOf = (img: { refs: string }) => img.refs.split(',').map((s) => s.trim().replace(/^\^/, '')).filter((s) => s && s !== '—' && s !== '-')
  const firstFrameOf = (img: { refs: string }) =>
    img.refs.split(',').map((s) => s.trim()).find((s) => s.startsWith('^'))?.slice(1) ?? ''
  const writeRefs = (imageId: string, names: string[], firstFrame: string) => {
    const next = clone()
    for (const c of next.chunks)
      for (const b of c.beats)
        for (const i of b.images)
          if (i.id === imageId) i.refs = names.map((n) => (n === firstFrame ? `^${n}` : n)).join(', ')
    apply(next)
  }
  const toggleMapRef = (imageId: string, name: string) => {
    const img = images.find((i) => i.id === imageId)
    if (!img) return
    const cur = refsOf(img)
    const ff = firstFrameOf(img)
    const nextNames = cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name]
    writeRefs(imageId, nextNames, nextNames.includes(ff) ? ff : '')
  }
  // Reorder among the IMAGE refs only — that order is what kie receives;
  // text/audio associations have no order and stay behind.
  const moveImgToPos = (imageId: string, name: string, target: number) => {
    const img = images.find((i) => i.id === imageId)
    if (!img) return
    const cur = refsOf(img)
    const imgs = cur.filter((n) => kit.find((k) => k.name === n)?.image_path)
    const rest = cur.filter((n) => !imgs.includes(n))
    const from = imgs.indexOf(name)
    if (from < 0) return
    imgs.splice(from, 1)
    imgs.splice(Math.max(0, Math.min(imgs.length, target)), 0, name)
    writeRefs(imageId, [...imgs, ...rest], firstFrameOf(img))
  }
  // One kit object as a card: the IMAGE sizes the card (native ratio, full
  // column width); a prompt-only object gets an equally-weighted text card —
  // never a box sized by its name. Kind chip labels what it is.
  const kindLabel = (kind: string) =>
    kind === 'character' ? 'CAST' : kind === 'background' ? 'ENVIRONMENT' : kind === 'prop' ? 'PROP' : kind === 'master' ? 'MASTER' : kind === 'variant' ? 'VARIANT' : kind === 'source' ? 'SOURCE'
      : AUDIO_KINDS.has(kind) ? `♪ ${kind.toUpperCase()}` : 'REFERENCE'
  const kitCard = (k: { name: string; kind: string; notes: string; image_path: string }, w?: number, h?: number, x?: number, y?: number) => {
    const isSource = k.kind === 'source'
    const sel = images.find((i) => i.id === mapSel)
    const linkedToSel = sel ? refsOf(sel).includes(k.name) : false
    const linkedAtAll = images.some((i) => refsOf(i).includes(k.name))
    // A source card's "name" is its session path until it is imported.
    const shownName = k.name.includes('/') ? k.name.split('/').pop()! : k.name
    return (
      <button
        key={k.name}
        type="button"
        data-mapref={k.name}
        style={w ? { position: 'absolute', left: x, top: y, width: w, height: h, overflow: 'hidden' } : undefined}
        className={`vp-map-card ${k.image_path ? 'has-img' : 'is-text'} ${k.kind === 'master' || k.kind === 'variant' ? 'is-master' : ''} ${isSource ? 'is-source' : ''} ${mapSel && !isSource ? (linkedToSel ? 'on' : 'dim') : ''} ${!linkedAtAll && !isSource ? 'unlinked' : ''}`}
        title={isSource ? 'Source image not in the World Kit yet — click to import it' : mapSel ? (linkedToSel ? `Detach from ${mapSel}` : `Attach to ${mapSel}`) : k.name}
        onClick={() => (isSource ? void importSource(k.name) : mapSel && toggleMapRef(mapSel, k.name))}
      >
        <span className={`vp-map-chip k-${k.kind}`}>
          {isSource && importingSrc === k.name ? 'IMPORTING…' : kindLabel(k.kind)}
          {(k as { group?: string }).group ? ` · ${(k as { group?: string }).group}` : ''}
        </span>
        <span className="vp-map-cardacts" onClick={(e) => e.stopPropagation()}>
          {k.image_path ? (
            <span title="View large" onClick={() => setLightbox(k.image_path)}>⤢</span>
          ) : null}
          {!isSource ? (
            <span
              title={k.image_path ? 'Make a VARIANT — same shot, one deliberate change (this image is the base reference)' : 'Make a VARIANT of this prompt — one deliberate change to the description'}
              onClick={(e) => {
                const card = (e.target as HTMLElement).closest('.vp-map-card')?.getBoundingClientRect()
                setVInitPos({ x: Math.max(16, Math.min(window.innerWidth - 700, (card?.left ?? 200) - 690)), y: Math.max(70, (card?.top ?? 120) - 20) })
                setVariantFor(k as KitObject)
              }}
            >+</span>
          ) : null}
          <span title="Hide this reference (Show all brings it back)" onClick={() => persistHidden([...hiddenRefs, k.name])}>✕</span>
        </span>
        {k.image_path ? (
          <img src={contentUrl(k.image_path)} alt={shownName} loading="lazy" onLoad={noteRatio(k.name)} />
        ) : (
          <span className="vp-map-prompttext">{k.notes || 'Prompt-only reference — no image yet.'}</span>
        )}
        <span className="vp-map-cardname">{isSource ? `${shownName} · click to import` : AUDIO_KINDS.has(k.kind) ? `♪ ${shownName}` : shownName}</span>
      </button>
    )
  }

  const setFirstFrame = (imageId: string, name: string) => {
    const img = images.find((i) => i.id === imageId)
    if (!img) return
    writeRefs(imageId, refsOf(img), firstFrameOf(img) === name ? '' : name)
  }
  // ✦ Let AI decide: the engine proposes a full shot→refs mapping (paid call,
  // suggest_ref_map). It is APPLIED as one undoable edit — Undo is the veto.
  const runMapAI = async () => {
    setMapAI(true)
    try {
      const r = await fetch(actionUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: activeSession(), tenant: 'local', action: 'suggest_ref_map', allow_cost: true }),
      })
      const out = await r.json().catch(() => null)
      const mapping = out?.data?.mapping
      if (!r.ok || out?.ok === false || !mapping) return
      const next = clone()
      for (const c of next.chunks)
        for (const b of c.beats)
          for (const i of b.images)
            if (Array.isArray(mapping[i.id])) i.refs = mapping[i.id].join(', ')
      apply(next)
    } catch {
      /* engine offline — the board still maps by hand */
    } finally {
      setMapAI(false)
    }
  }

  if (!wellFormed || raw) {
    // RAW MODE (or the plan doesn't parse): edit the markdown directly. The
    // engine reads this exact text — the structured views come back as soon as
    // it parses again.
    return (
      <div className="vp panel-flat" ref={rootRef}>
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
  // Interval scales with the video, not a fixed minute grid — a 37s ad gets
  // 5s marks, a 5-minute devlog gets 30s ones. Zoom refines further.
  const baseTick = totalSec <= 45 ? 5 : totalSec <= 90 ? 10 : totalSec <= 180 ? 15 : totalSec <= 420 ? 30 : 60
  const tickStep = Math.max(totalSec <= 45 ? 1 : 5, zoom >= 4 ? baseTick / 4 : zoom >= 2 ? baseTick / 2 : baseTick)
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
    <div className="vp panel-flat" ref={rootRef}>
      {/* One line of facts — per-section counts live on the dimension lines
          below the timeline. No separate stats row, no divider (clean UI). */}
      <div className="ch" style={{ borderBottom: 'none', paddingBottom: 0 }}>
        <h3>
          Visual pacing — {audioIsSeparate ? `${stats.chunks} audio chunks · ` : ''}
          {stats.images} {shotNoun(stats.images, shotMedium)} · ~{fmtClock(stats.runtimeS)}
        </h3>
        <span>working/visual-pacing-plan.md</span>
      </div>


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
            <b>{editing.isNew ? 'New' : 'Editing'} {editing.scope === 'chunk' ? chunkWord : editing.scope}</b>
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
                <label className="vp-edit-field">Narration (the script lines this {chunkWord} covers)
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
              {/* THE REFERENCE MAP, per shot: the kit's image-backed refs as
                  toggle chips. These images now genuinely reach generation
                  (resolve_reference reads the kit), so what you attach here is
                  what the model is shown. Text-only refs stay in the field above. */}
              {kit.some((k) => k.image_path) ? (
                <div className="vp-ref-chips">
                  {kit.filter((k) => k.image_path).map((kr) => {
                    const current = editing.refs.split(',').map((s) => s.trim()).filter(Boolean)
                    const on = current.includes(kr.name)
                    return (
                      <button
                        key={kr.name}
                        type="button"
                        className={`vp-ref-chip ${on ? 'on' : ''}`}
                        title={on ? `Remove ${kr.name} from this shot` : `Attach ${kr.name} to this shot`}
                        onClick={() =>
                          setDraftField({
                            refs: (on ? current.filter((n) => n !== kr.name) : [...current, kr.name]).join(', '),
                          })
                        }
                      >
                        <img src={contentUrl(kr.image_path)} alt="" />
                        <span>{kr.name}</span>
                      </button>
                    )
                  })}
                </div>
              ) : null}
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
                <button type="button" onClick={() => startEditImage(menu.imageId!)}>Edit shot</button>
                <button type="button" onClick={() => startAddImage(menu.chunkId, { nearImageId: menu.imageId, pos: 'before' })}>Add shot before</button>
                <button type="button" onClick={() => startAddImage(menu.chunkId, { nearImageId: menu.imageId, pos: 'after' })}>Add shot after</button>
                <button type="button" className="danger" onClick={() => removeImage(menu.imageId!)}>Remove shot</button>
                <div className="vp-menu-div" />
              </>
            ) : null}
            <button type="button" onClick={() => startEditChunk(menu.chunkId)}>Edit {chunkWord}</button>
            <button type="button" onClick={() => startAddChunk(menu.chunkId, 'before')}>Add {chunkWord} before</button>
            <button type="button" onClick={() => startAddChunk(menu.chunkId, 'after')}>Add {chunkWord} after</button>
            <button type="button" className="danger" onClick={() => removeChunk(menu.chunkId)}>Remove {chunkWord}</button>
          </div>
        </>
      ) : null}


      <div className="vp-viewbar">
        <div className="vp-viewtoggle">
          <button type="button" className={view === 'map' ? 'on' : ''} onClick={() => setView('map')}>Mapping</button>
          <button type="button" className={view === 'script' ? 'on' : ''} onClick={() => setView('script')}>Script</button>
          <button type="button" className={view === 'table' ? 'on' : ''} onClick={() => setView('table')}>Table</button>
        </div>
        <button type="button" className="vp-undo" style={{ marginLeft: 8 }} onClick={() => setTlOpen(!tlShown)}>
          {tlShown ? '▾' : '▸'} Timeline · {fmtClock(stats.runtimeS)}
        </button>
        {view === 'map' ? (
          <button type="button" className="vp-undo vp-aimap" style={{ marginLeft: 8 }} disabled={mapAI} onClick={runMapAI}>
            ✦ {mapAI ? 'Mapping…' : 'Let AI map references'}
          </button>
        ) : null}
        {view !== 'map' ? (
        <button
          type="button"
          className="vp-undo"
          title="See or edit the exact text file the engine reads"
          style={{ marginLeft: 8 }}
          onClick={() => setRaw(true)}
        >
          Edit as text
        </button>
        ) : null}
      </div>

      {tlShown ? (
        <div className="vp-tl-sticky">
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
                className={`vp-seg ${img.id === activeId || img.id === mapSel ? 'on' : ''}`}
                style={{ left: `${pct(img.startS)}%`, width: `${pct(img.holdS)}%` }}
                onMouseEnter={() => setActiveFromTimeline(img.id)}
                onFocus={() => setActiveFromTimeline(img.id)}
                onClick={() => {
                  // Timeline and board are the same selection: clicking a
                  // block opens that shot's mapping with its references.
                  setView('map')
                  setActiveId(img.id)
                  setMapSel(img.id)
                  requestAnimationFrame(() =>
                    (document.querySelector(`[data-mapshot="${CSS.escape(img.id)}"]`) as HTMLElement | null)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }),
                  )
                }}
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

        {/* AUDIO LAYERS, video-editor style: one row per audio object that
            reaches any shot — attached to the shot itself (music spans) or
            linked to a character the shot references (voices; variants
            inherit). Sessions with no separate audio (voice generated with
            the picture, nothing attached) show no rows at all. */}
        {(() => {
          const audioObjs = kit.filter((k) => AUDIO_KINDS.has(k.kind))
          if (!audioObjs.length || !images.length) return null
          const layers = audioObjs.map((a) => {
            const covered = images.map((img) => {
              const names = refsOf(img)
              if (names.includes(a.name)) return 'shot'
              const linked = (a as { linked_to?: string }).linked_to
              if (linked && names.some((n) => n === linked || kit.find((k) => k.name === n)?.variant_of === linked)) return 'voice'
              return ''
            })
            const spans: { start: number; end: number; via: string }[] = []
            images.forEach((img, i) => {
              if (!covered[i]) return
              const prev = spans[spans.length - 1]
              if (prev && i > 0 && covered[i - 1] && Math.abs(prev.end - img.startS) < 0.01) {
                prev.end = img.startS + img.holdS
              } else {
                spans.push({ start: img.startS, end: img.startS + img.holdS, via: covered[i] })
              }
            })
            return { a, spans }
          }).filter((l) => l.spans.length)
          if (!layers.length) return null
          return layers.map(({ a, spans }) => (
            <div className="vp-tl-row" key={`al-${a.name}`}>
              <span className="vp-tl-label" title={(a as KitObject).notes || a.name}>♪ {a.name}</span>
              <div className="vp-tl-track" style={{ position: 'relative', height: 22 }}>
                {spans.map((sp, i) => (
                  <div
                    key={i}
                    title={`${a.name} (${a.kind}) · ${fmtClock(sp.start)}–${fmtClock(sp.end)}${sp.via === 'voice' ? ' · via character link' : ' · attached to shots'}`}
                    style={{
                      position: 'absolute', left: `${pct(sp.start)}%`, width: `${pct(sp.end - sp.start)}%`,
                      top: 3, bottom: 3, borderRadius: 5, overflow: 'hidden',
                      background: sp.via === 'voice' ? 'rgba(122,162,255,.16)' : 'rgba(122,255,196,.13)',
                      border: `1px solid ${sp.via === 'voice' ? 'rgba(122,162,255,.45)' : 'rgba(122,255,196,.4)'}`,
                      display: 'flex', alignItems: 'center', padding: '0 6px',
                      fontSize: 9.5, fontFamily: 'var(--mono)', color: 'var(--ink-2)', whiteSpace: 'nowrap',
                    }}
                  >
                    ♪ {a.name}
                  </div>
                ))}
              </div>
            </div>
          ))
        })()}

        {/* "Audio chunks": the narration owns these units — so the lane only
            means something when the narration is a separate track. Video-first
            generates picture and sound together: there is no second timeline to
            line up against, and drawing one says the audio is separate when it
            isn't. The chunks stay in the plan (they still group the shots);
            only the claim that they are an audio track goes away. */}
        {audioIsSeparate ? (
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
        ) : null}

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
                    {s.name} · {s.imageCount}{s.imageBudget ? `/${fmtBudget(s.imageBudget)}` : ''} shots
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
        </div>
      ) : null}


      {view === 'map' ? (
        <div
          className="vp-map"
          ref={boardRef}
          onClick={(e) => {
            // Click on background = collapse. Cards, shots and buttons handle
            // their own clicks and never fall through to here.
            if (!(e.target as HTMLElement).closest('.vp-map-shot, .vp-map-card, button')) setMapSel('')
          }}
        >
          {/* Two layers: unselected threads run BEHIND the cards; the selected
              shot's threads render on a front layer ABOVE everything. Both
              vanish while scrolling and return re-measured at rest. */}
          <svg className={`vp-map-svg ${threadsHidden ? 'hush' : ''}`}>
            {threads.filter((th) => th.shot !== mapSel).map((th, i) => (
              <path key={i} d={th.d} className={mapSel ? 'off' : ''} />
            ))}
          </svg>
          <svg className={`vp-map-svg front ${threadsHidden ? 'hush' : ''}`}>
            {mapSel ? threads.filter((th) => th.shot === mapSel).map((th, i) => <path key={i} d={th.d} className="lit" />) : null}
          </svg>

          <div className="vp-map-shots">
            <div className="vp-map-shotshead">
              <span className="vp-map-colhead">Shots</span>
            </div>
            <div className="vp-map-shotlist">
              {images.map((img) => {
                const names = refsOf(img)
                const ff = firstFrameOf(img)
                const on = mapSel === img.id
                // Threads include audio that RIDES IN via a character link
                // (variants inherit): if the object goes somewhere, its sound
                // goes too — the board shows that as a thread.
                const linkedAudioNames = kit
                  .filter((k) => AUDIO_KINDS.has(k.kind) && (k as { linked_to?: string }).linked_to)
                  .filter((k) => {
                    const target = (k as { linked_to?: string }).linked_to!
                    return names.some((n) => n === target || kit.find((x) => x.name === n)?.variant_of === target)
                  })
                  .map((k) => k.name)
                  .filter((n) => !names.includes(n))
                return (
                  <div
                    key={img.id}
                    data-mapshot={img.id}
                    data-maprefs={[...names, ...linkedAudioNames].join('|')}
                    className={`vp-map-shot ${on ? 'on' : ''} ${mapSel && !on ? 'dim' : ''}`}
                    onClick={() => {
                      setMapSel(on ? '' : img.id)
                      setActiveId(on ? '' : img.id)
                    }}
                  >
                    <div className="vp-map-rowhead">
                      <span className="vp-map-shotid">{img.id}</span>
                      <span className="vp-map-shotmeta">{img.holdS}s{img.narration ? '' : ' · silent'}</span>
                      {clipGroups.length === images.length && clipGroups[images.indexOf(img)] ? (
                        <span className="vp-map-grpchip" title="Visual consistency group — shares a master with its group">{clipGroups[images.indexOf(img)]}</span>
                      ) : null}
                      {on ? (
                        <button type="button" className="vp-map-collapse" title="Collapse and unselect" onClick={(e) => { e.stopPropagation(); setMapSel(''); setActiveId('') }}>▴</button>
                      ) : null}
                    </div>
                    <span className="vp-map-shotwhat">{img.what}</span>
                    {on ? (
                      <div className={`vp-map-shotline ${img.narration ? '' : 'silent'}`}>
                        {img.narration ? `“${img.narration}”` : 'Silent — music/SFX carry this shot.'}
                      </div>
                    ) : null}
                    {on ? (
                      <div className="vp-map-attached" onClick={(e) => e.stopPropagation()}>
                        {names.length === 0 ? <span className="vp-hint">No references yet — click kit cards on the right.</span> : null}
                        {(() => {
                          // IMAGE refs go to kie as reference images — order
                          // and 1st-frame apply. Prompt-only objects are
                          // ASSOCIATED with the scene (their description rides
                          // in the prompt) but they are not images and never
                          // occupy an image slot.
                          const visual = names.filter((name) => !AUDIO_KINDS.has(kit.find((k) => k.name === name)?.kind ?? ''))
                          const imgNames = visual.filter((name) => kit.find((k) => k.name === name)?.image_path)
                          const txtNames = visual.filter((name) => !kit.find((k) => k.name === name)?.image_path)
                          return (
                            <>
                              {imgNames.map((name, idx) => {
                                const obj = kit.find((k) => k.name === name)!
                                const hw = imgRatios[name]
                                const r = hw ? 1 / hw : 4 / 3
                                const posOpen = posMenuFor === `${img.id}:${name}`
                                return (
                                  <figure
                                    key={name}
                                    className={`vp-map-att ${ff === name ? 'ff' : ''}`}
                                    style={{ flexGrow: r, flexBasis: `${Math.round(r * 130)}px`, aspectRatio: `${r}`, minWidth: 0 }}
                                  >
                                    {/* Header ON the image: the position number
                                        (click to place it), the name below. */}
                                    <div className="vp-map-att-top">
                                      <button type="button" className="vp-map-detach" title="Detach" onClick={() => toggleMapRef(img.id, name)}>×</button>
                                      <span className="vp-map-ordgrp">
                                        <button
                                          type="button"
                                          className="vp-map-posnum"
                                          title="Reference order — the order the model receives. Click to choose the position."
                                          onClick={() => setPosMenuFor(posOpen ? null : `${img.id}:${name}`)}
                                        ><b>{idx + 1}</b></button>
                                        {posOpen ? imgNames.map((_, p) => (
                                          <button
                                            key={p}
                                            type="button"
                                            className="vp-map-posopt"
                                            disabled={p === idx}
                                            title={`Move to position ${p + 1}`}
                                            onClick={() => { moveImgToPos(img.id, name, p); setPosMenuFor(null) }}
                                          >{p + 1}</button>
                                        )) : null}
                                      </span>
                                      <span className="vp-map-attname">{name}</span>
                                    </div>
                                    <img src={contentUrl(obj.image_path)} alt={name} title="Click to view large" onLoad={noteRatio(name)} onClick={(e) => { e.stopPropagation(); setLightbox(obj.image_path) }} />
                                    <div className="vp-map-att-ov">
                                      <button type="button" className={`vp-map-ffbtn ${ff === name ? 'on' : ''}`} title="The video OPENS on this exact image (kie first-frame mode — other references can't attach as images and ride along as prompt text instead)" onClick={() => setFirstFrame(img.id, name)}>
                                        {ff === name ? '✓ 1st frame' : 'Set as 1st frame'}
                                      </button>
                                    </div>
                                  </figure>
                                )
                              })}
                              {txtNames.map((name) => {
                                const obj = kit.find((k) => k.name === name)
                                return (
                                  <div key={name} className="vp-map-txtatt" title={`${name} — associated with this scene; its description joins the prompt (no image goes to the model)`}>
                                    <span className="vp-map-chip">{obj?.kind || 'note'}</span>
                                    <span className="vp-map-attname">{name}</span>
                                    {obj?.notes ? <span className="txt-notes">{obj.notes}</span> : null}
                                    <button type="button" className="vp-map-detach" title="Detach" onClick={() => toggleMapRef(img.id, name)}>×</button>
                                  </div>
                                )
                              })}
                            </>
                          )
                        })()}
                      </div>
                    ) : null}
                    {on ? (() => {
                      // THE SHOT'S AUDIO, both kinds of belonging:
                      //   character-linked voices ride in via the shot's
                      //   references (variants inherit the base's link);
                      //   shot-attached audio (music across 4 shots) sits in
                      //   the shot's own refs like any attachment.
                      const audioObjs = kit.filter((k) => AUDIO_KINDS.has(k.kind))
                      if (!audioObjs.length) return null
                      const visualNames = names.filter((n) => !AUDIO_KINDS.has(kit.find((k) => k.name === n)?.kind ?? ''))
                      const attachedAudio = names.filter((n) => AUDIO_KINDS.has(kit.find((k) => k.name === n)?.kind ?? ''))
                      // EVERY audio kind rides its object's link — a song
                      // linked to the bedroom follows the bedroom, same as a
                      // voice follows its character (variants inherit).
                      const inherited = audioObjs
                        .filter((a) => !attachedAudio.includes(a.name))
                        .flatMap((a) => {
                          const target = (a as { linked_to?: string }).linked_to
                          if (!target) return []
                          const via = visualNames.find((n) => n === target || kit.find((k) => k.name === n)?.variant_of === target)
                          return via ? [{ audio: a, via }] : []
                        })
                      const unlinkedTargets = visualNames.filter((n) => !inherited.some((r) => r.via === n))
                      const linkAudio = async (audio: string, linkedTo: string) => {
                        await fetch(actionUrl(), {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ session: activeSession(), tenant: 'local', action: 'set_audio_link', audio, linked_to: linkedTo }),
                        }).catch(() => null)
                        // Keep the unsaved step-5 draft in agreement — the
                        // draft overlays the file everywhere the kit shows.
                        patchDraftAudioLink(audio, linkedTo)
                        await refetchKit()
                      }
                      return (
                        <div onClick={(e) => e.stopPropagation()} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
                          {attachedAudio.map((name) => {
                            const obj = kit.find((k) => k.name === name)
                            return (
                              <span key={name} className="vp-undo" style={{ display: 'inline-flex', gap: 8, alignItems: 'center', cursor: 'default' }} title={obj?.notes || name}>
                                ♪ {name} · this shot{obj?.kind && obj.kind !== 'voice' ? ` (${obj.kind})` : ''}
                                <button
                                  type="button"
                                  title={`Detach ${name} from this shot`}
                                  onClick={() => toggleMapRef(img.id, name)}
                                  style={{ background: 'none', border: 'none', color: 'var(--ink-3)', cursor: 'pointer', padding: 0, fontSize: 11 }}
                                >×</button>
                              </span>
                            )
                          })}
                          {inherited.map(({ audio, via }) => (
                            <span key={audio.name} className="vp-undo" style={{ display: 'inline-flex', gap: 8, alignItems: 'center', cursor: 'default' }} title={(audio as KitObject).notes || audio.name}>
                              ♪ {audio.name}{audio.kind !== 'voice' ? ` (${audio.kind})` : ''} · via {via}
                              <button
                                type="button"
                                title={`Unlink ${audio.name} from ${via} (everywhere — the link belongs to the object)`}
                                onClick={() => void linkAudio(audio.name, '')}
                                style={{ background: 'none', border: 'none', color: 'var(--ink-3)', cursor: 'pointer', padding: 0, fontSize: 11 }}
                              >×</button>
                            </span>
                          ))}
                          <button
                            type="button"
                            className="vp-undo"
                            style={audioMenuFor === img.id ? { borderColor: 'var(--accent)', color: 'var(--accent-2)' } : undefined}
                            title="Attach audio to THIS shot (music/ambience spans), or link a voice to a character (rides everywhere they appear)"
                            onClick={() => setAudioMenuFor(audioMenuFor === img.id ? null : img.id)}
                          >
                            {audioMenuFor === img.id ? '▾' : '♪'} add audio…
                          </button>
                          {audioMenuFor === img.id ? (
                            <div style={{ flexBasis: '100%', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', border: '1px dashed var(--line, #2a3142)', borderRadius: 10, padding: 8 }}>
                              {audioObjs.filter((a) => !attachedAudio.includes(a.name)).length > 0 && (
                                <>
                                  <span style={{ fontSize: 10.5, color: 'var(--ink-3)', fontFamily: 'var(--mono)' }}>THIS SHOT</span>
                                  {audioObjs.filter((a) => !attachedAudio.includes(a.name)).map((a) => (
                                    <button
                                      key={`s-${a.name}`}
                                      type="button"
                                      className="vp-undo"
                                      title={(a as KitObject).notes || `Attach ${a.name} to this shot`}
                                      onClick={() => { toggleMapRef(img.id, a.name); setAudioMenuFor(null) }}
                                    >
                                      ♪ {a.name} ({a.kind})
                                    </button>
                                  ))}
                                </>
                              )}
                              {unlinkedTargets.length > 0 && audioObjs.some((a) => !(a as { linked_to?: string }).linked_to) && (
                                <>
                                  <span style={{ fontSize: 10.5, color: 'var(--ink-3)', fontFamily: 'var(--mono)' }}>LINK TO OBJECT</span>
                                  {unlinkedTargets.flatMap((n) =>
                                    audioObjs.filter((a) => !(a as { linked_to?: string }).linked_to).map((a) => (
                                      <button
                                        key={`c-${a.name}-${n}`}
                                        type="button"
                                        className="vp-undo"
                                        title={`Link ${a.name} to ${n} — rides into every shot referencing it`}
                                        onClick={() => { void linkAudio(a.name, n); setAudioMenuFor(null) }}
                                      >
                                        ♪ {a.name} → {n}
                                      </button>
                                    )),
                                  )}
                                </>
                              )}
                            </div>
                          ) : null}
                        </div>
                      )
                    })() : null}
                  </div>
                )
              })}
            </div>
          </div>

          {/* THE WORLD KIT — masters first (upper-left, solid tint), sized to
              fit vertically; a huge kit overflows sideways, never down. */}
          <div className="vp-map-kit">
            <div className="vp-map-kithead">
              <span className="vp-map-colhead">World Kit</span>
            </div>
            {(() => {
              // Audio objects pack onto the wall as text cards too — they
              // attach to shots (music spans) and thread to the shots they
              // reach, including via their character link.
              const visible = kit.filter((k) => !hiddenRefs.includes(k.name))
              const masters = visible.filter((k) => k.kind === 'master')
              const ordered = [
                ...masters.flatMap((m) => [m, ...visible.filter((k) => k.kind === 'variant' && k.variant_of === m.name)]),
                ...visible.filter((k) => k.kind !== 'master' && !(k.kind === 'variant' && masters.some((m) => m.name === k.variant_of))),
              ]
              // Session source images no kit object maps yet (external assets,
              // intake uploads — the shoe's other views live here). They pack
              // WITH the images, as importable cards.
              const kitPaths = new Set(kit.map((k) => k.image_path).filter(Boolean))
              const sources = srcPool
                .filter((s) => !s.ref && !s.imported_as && isDisplayable(s.path) && !kitPaths.has(s.path) && !hiddenRefs.includes(s.path))
                .map((s) => ({ name: s.path, kind: 'source', notes: '', image_path: s.path }))
              // Images first, text-only refs last: image rows stay pure (every
              // pixel of row width goes to pictures) and the text cards form
              // their own bottom rows instead of punching holes.
              const sorted = [...ordered.filter((k) => k.image_path), ...sources, ...ordered.filter((k) => !k.image_path)]
              const { items, totalH } = packKit(sorted)
              return (
                <div className="vp-map-wall" style={{ position: 'relative', height: totalH }}>
                  {items.map((it) => kitCard(it.k, it.w, it.h, it.x, it.y))}
                </div>
              )
            })()}
            {/* Bottom of the section, normal flow — never overlaid on a card. */}
            {hiddenRefs.length ? (
              <button type="button" className="vp-map-showall" style={{ margin: '8px auto 0' }} onClick={() => persistHidden([])}>
                Show all · {hiddenRefs.length} hidden
              </button>
            ) : null}
          </div>

          {variantFor ? (
            <VariantModule
              base={variantFor}
              kit={kit}
              initialPos={vInitPos}
              anchorRect={() => boardRef.current?.querySelector(`[data-mapref="${CSS.escape(variantFor.name)}"]`)?.getBoundingClientRect()}
              onClose={() => setVariantFor(null)}
              onCreated={() => void refetchKit()}
            />
          ) : null}

          {lightbox ? (
            <div className="vp-var-overlay" onClick={() => setLightbox('')}>
              <img className="vp-lightbox" src={contentUrl(lightbox)} alt="" />
            </div>
          ) : null}
        </div>
      ) : null}


      {view === 'table' ? (
        <div className="table-wrap" ref={listRef} style={{ maxHeight: '48vh', overflowY: 'auto', paddingBottom: listOverflows ? '24vh' : 0 }}>
          <table className="shots vp-pacing">
            <thead>
              {/* "Img" was the devlog spelling; a shot is a clip or a still.
                  The chunk column only claims to be audio when audio is its
                  own track. */}
              <tr><th>Start</th><th>Shot</th><th>{audioIsSeparate ? 'Audio chunk' : 'Scene'}</th><th>Visual</th><th>Hold</th><th></th></tr>
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
      ) : view !== 'script' ? null : (
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
                {/* Beat-by-beat: spoken beats render their words (drag/tag
                    anchors keep their global word indices); SILENT beats have
                    no words, so the timeline text is the image description —
                    dimmed italics: seen, not heard. Timed by holds. */}
                {chunk.beats.map((b) => {
                  if (!b.narration.trim() && b.images.length) {
                    return (
                      <span key={`silent:${b.code}`} style={{ fontStyle: 'italic', color: 'var(--ink-3)' }}>
                        {b.images.map((im) => (
                          <span key={im.id}>
                            <span
                              className="vp-w-tag"
                              data-img={im.id}
                              title={`${im.what} — silent clip: no words, timed by its ${im.holdS}s hold`}
                            >
                              {im.id}
                            </span>
                            <span
                              className={'vp-w img' + (im.id === activeId ? ' on' : '')}
                              onMouseEnter={!scriptDrag ? () => setActiveId(im.id) : undefined}
                              onClick={!scriptDrag ? (e) => openMenu(e, { chunkId: chunk.id, beatCode: b.code, imageId: im.id }) : undefined}
                            >
                              {im.what} · {im.holdS}s
                            </span>{' '}
                          </span>
                        ))}
                      </span>
                    )
                  }
                  return words.map((cw, i) => {
                    if (cw.beatCode !== b.code) return null
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
                  })
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
