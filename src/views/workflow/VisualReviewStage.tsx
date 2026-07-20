import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, Dispatch, DragEvent as ReactDragEvent, PointerEvent as ReactPointerEvent, ReactNode, SetStateAction } from 'react'
import { activeSession, contentUrl, downloadUrl, fileUrl, getFileJson, getJson, postAction } from '../../lib/api'
import { useWorkflowStore } from '../../store/workflow'
import { TimelineScroller } from './TimelineScroller'

// The engine's render job: started via POST /api/action (heavy actions route to
// the durable job runner), tracked through its state file + log under
// working/jobs/ — ordinary session files. Output path is the script's default.
const RENDER_JOB_STORAGE_KEY = () => `spoolcast:render-job:${activeSession()}`
const RENDER_OUTPUT_PATH = () => `renders/${activeSession()}-1.0x.mp4`
const RENDER_OUTPUT_NAME = () => `${activeSession()}-1.0x.mp4`

type ShotBeat = {
  id?: string
  narration?: string
}

type ShotChunk = {
  id?: string
  scene_title?: string
  summary?: string
  beats?: ShotBeat[]
}

type BaseVisual = {
  id?: string
  role?: string
  image_source?: string
  image_path?: string
  generated_video_path?: string
  chunk_id?: string
  pacing_image_id?: string
  visual_direction?: string
  prompt?: string
  image_prompt?: string
  video_prompt?: string
  start_s?: number
  end_s?: number
  duration_s?: number
  slot_duration_s?: number
  generated_duration_s?: number
  first_word?: string
  last_word?: string
  summary?: string
  reason?: string
  video_model?: string
}

type ShotList = {
  chunks?: ShotChunk[]
  base_layer?: BaseVisual[]
}

type SceneManifestItem = {
  id?: string
  chunk_id?: string
  role?: string
  status?: string
  local_path?: string
  mime_type?: string
  prompt?: string
  slot_duration_s?: number
  generated_duration_s?: number
}

type SceneManifest = {
  items?: SceneManifestItem[]
}

type GenerationPromptItem = {
  id?: string
  chunk_id?: string
  output_type?: 'image' | 'video' | 'auto'
  prompt?: string
  prompt_variants?: Partial<Record<'image' | 'video', { prompt?: string }>>
}

type GenerationPromptsDoc = {
  items?: GenerationPromptItem[]
  default_output_type?: 'image' | 'video' | 'auto'
}

type ReviewSegment = {
  id: string
  chunkId: string
  title: string
  start: number
  end: number
  duration: number
  mediaType: 'image' | 'video' | 'missing'
  mediaSrc: string
  prompt: string
  firstWord: string
  lastWord: string
  // The narration phrase this visual is word-aligned to (its timed subtitle line).
  caption: string
  selectedType: 'image' | 'video'
  generatedDuration?: number
}

type AudioChunk = {
  id: string
  title: string
  start: number
  end: number
  narration: string
  src: string
}

type ReviewPanelId = 'video' | 'script' | 'details' | 'gallery' | 'timeline'

export type VisualReviewLayoutCommand = {
  id: number
  action: 'save' | 'reset'
}

type ReviewLayoutMode = 'normal' | 'expanded' | 'mobile'

type ReviewLayoutColumn = {
  id: string
  panels: ReviewPanelId[]
}

type ReviewLayoutRow = {
  id: string
  columns: ReviewLayoutColumn[]
}

type ReviewDropTarget =
  | { kind: 'panel'; targetPanelId: ReviewPanelId; position: 'before' | 'after' }
  | { kind: 'column'; rowId: string; columnId: string }
  | { kind: 'new-column'; rowId: string; columnId: string; position: 'before' | 'after' }
  | { kind: 'new-row'; rowId: string; position: 'before' | 'after' }

type RowPanelResizeSlot = {
  id: string
  minHeight: number
  maxHeight: number
  startHeight: number
}

type RowPanelResizeColumn = {
  slots: RowPanelResizeSlot[]
}

// PORTRAIT SESSIONS put the freed horizontal space to work: script and
// details sit BESIDE the tall video instead of under an ocean of gutter.
const normalPortraitLayoutRows: ReviewLayoutRow[] = [
  {
    id: 'normal-video',
    columns: [
      { id: 'normal-video-col', panels: ['video'] },
      { id: 'normal-side-col', panels: ['script', 'details'] },
    ],
  },
  {
    id: 'normal-timeline',
    columns: [
      { id: 'normal-timeline-col', panels: ['timeline'] },
    ],
  },
  {
    id: 'normal-review',
    columns: [
      { id: 'normal-gallery-col', panels: ['gallery'] },
    ],
  },
]

const normalReviewLayoutRows: ReviewLayoutRow[] = [
  {
    id: 'normal-video',
    columns: [
      { id: 'normal-video-col', panels: ['video'] },
    ],
  },
  {
    id: 'normal-timeline',
    columns: [
      { id: 'normal-timeline-col', panels: ['timeline'] },
    ],
  },
  {
    id: 'normal-script',
    columns: [
      { id: 'normal-script-col', panels: ['script'] },
    ],
  },
  {
    id: 'normal-review',
    columns: [
      { id: 'normal-details-col', panels: ['details'] },
      { id: 'normal-gallery-col', panels: ['gallery'] },
    ],
  },
]

const expandedReviewLayoutRows: ReviewLayoutRow[] = [
  {
    id: 'editor',
    columns: [
      { id: 'preview', panels: ['video'] },
      { id: 'side', panels: ['script', 'details', 'gallery'] },
    ],
  },
  {
    id: 'timeline',
    columns: [
      { id: 'timeline', panels: ['timeline'] },
    ],
  },
]

const mobileReviewLayoutRows: ReviewLayoutRow[] = [
  { id: 'mobile-video', columns: [{ id: 'mobile-video-col', panels: ['video'] }] },
  { id: 'mobile-timeline', columns: [{ id: 'mobile-timeline-col', panels: ['timeline'] }] },
  { id: 'mobile-script', columns: [{ id: 'mobile-script-col', panels: ['script'] }] },
  { id: 'mobile-details', columns: [{ id: 'mobile-details-col', panels: ['details'] }] },
  { id: 'mobile-gallery', columns: [{ id: 'mobile-gallery-col', panels: ['gallery'] }] },
]

const reviewLayoutDefaultsKey = () => `${activeSession()}:visual-review-layout-defaults`

type SavedReviewLayout = {
  rows: ReviewLayoutRow[]
  rowSizes: Record<string, number>
  columnSizes: Record<string, number>
  panelSizes: Record<string, number>
  // Which ids the user explicitly drag-sized. Older saves omit these; on restore
  // we treat every saved size as manual so the saved arrangement is preserved.
  manualRowIds?: string[]
  manualPanelIds?: string[]
}

// Only these sections start clipped at a viewport-fraction cap. Video and timeline
// always flex to their natural/fill height (rule: timeline fully visible, video as
// large as possible) so they never carry an explicit starting size.
function cappableSection(panelId: ReviewPanelId) {
  return panelId === 'script' || panelId === 'details' || panelId === 'gallery'
}

// Interactive controls inside a panel own their own pointer drag (the player
// scrubber, buttons, the timeline's drag-to-scroll). A press that lands on one of
// these must NOT arm the panel's HTML5 drag — otherwise the browser enters
// drag-detection on mousedown and the control never receives its move events.
function dragFromInteractiveControl(target: EventTarget | null) {
  return target instanceof Element &&
    Boolean(target.closest('input, button, select, textarea, a, label, .vr-player-controls, .vr-player-top-actions, .vp-timeline-scroll'))
}

type SavedReviewLayouts = Partial<Record<ReviewLayoutMode, SavedReviewLayout>>

function cloneReviewLayout(rows: ReviewLayoutRow[]) {
  return rows.map((row) => ({
    ...row,
    columns: row.columns.map((column) => ({ ...column, panels: [...column.panels] })),
  }))
}

function defaultReviewLayoutRows(mode: ReviewLayoutMode) {
  if (mode === 'mobile') return cloneReviewLayout(mobileReviewLayoutRows)
  if (mode === 'expanded') return cloneReviewLayout(expandedReviewLayoutRows)
  return cloneReviewLayout(normalReviewLayoutRows)
}

function reviewLayoutIds(rows: ReviewLayoutRow[]) {
  const rowIds = new Set<string>()
  const columnIds = new Set<string>()
  const panelSlotIds = new Set<string>()

  for (const row of rows) {
    rowIds.add(row.id)
    for (const column of row.columns) {
      columnIds.add(column.id)
      for (const panelId of column.panels) {
        panelSlotIds.add(`${column.id}-${panelId}`)
      }
    }
  }

  return { rowIds, columnIds, panelSlotIds }
}

function mergeIdSets(...sets: Set<string>[]) {
  const ids = new Set<string>()
  for (const set of sets) {
    for (const id of set) ids.add(id)
  }
  return ids
}

function pickSizes(sizes: Record<string, number>, ids: Set<string>) {
  const picked: Record<string, number> = {}
  for (const id of ids) {
    if (id in sizes) picked[id] = sizes[id]
  }
  return picked
}

function replaceSizesForIds(current: Record<string, number>, ids: Set<string>, next: Record<string, number>) {
  const merged = { ...current }
  for (const id of ids) delete merged[id]
  return { ...merged, ...next }
}

function readSavedReviewLayouts(): SavedReviewLayouts {
  try {
    const raw = window.localStorage.getItem(reviewLayoutDefaultsKey())
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as SavedReviewLayouts : {}
  } catch {
    return {}
  }
}

function cleanupReviewLayout(rows: ReviewLayoutRow[]) {
  return rows
    .map((row) => ({
      ...row,
      columns: row.columns.filter((column) => column.panels.length > 0),
    }))
    .filter((row) => row.columns.length > 0)
}

function panelLayoutId(panelId: ReviewPanelId) {
  return `${panelId}-${Date.now()}-${Math.round(Math.random() * 1000)}`
}

function moveReviewPanel(rows: ReviewLayoutRow[], panelId: ReviewPanelId, target: ReviewDropTarget | null) {
  if (!target || (target.kind === 'panel' && target.targetPanelId === panelId)) return rows

  const next = cloneReviewLayout(rows)
  let sourceFound = false
  for (const row of next) {
    for (const column of row.columns) {
      const index = column.panels.indexOf(panelId)
      if (index >= 0) {
        column.panels.splice(index, 1)
        sourceFound = true
      }
    }
  }
  if (!sourceFound) return rows

  if (target.kind === 'panel') {
    for (const row of next) {
      for (const column of row.columns) {
        const index = column.panels.indexOf(target.targetPanelId)
        if (index >= 0) {
          column.panels.splice(target.position === 'before' ? index : index + 1, 0, panelId)
          return cleanupReviewLayout(next)
        }
      }
    }
  }

  if (target.kind === 'column') {
    const column = next.flatMap((row) => row.columns).find((item) => item.id === target.columnId)
    if (column) {
      column.panels.push(panelId)
      return cleanupReviewLayout(next)
    }
  }

  if (target.kind === 'new-column') {
    const row = next.find((item) => item.id === target.rowId)
    if (row) {
      const index = row.columns.findIndex((column) => column.id === target.columnId)
      const insertAt = index >= 0 && target.position === 'before' ? index : index + 1
      row.columns.splice(index >= 0 ? insertAt : row.columns.length, 0, {
        id: `${target.rowId}-${panelLayoutId(panelId)}-col`,
        panels: [panelId],
      })
      return cleanupReviewLayout(next)
    }
  }

  if (target.kind === 'new-row') {
    const index = next.findIndex((row) => row.id === target.rowId)
    next.splice(target.position === 'before' ? Math.max(0, index) : index + 1, 0, {
      id: `${panelLayoutId(panelId)}-row`,
      columns: [{ id: `${panelLayoutId(panelId)}-col`, panels: [panelId] }],
    })
    return cleanupReviewLayout(next)
  }

  return cleanupReviewLayout(next)
}

function readJsonFile<T>(path: string): Promise<T | null> {
  return fetch(fileUrl(path))
    .then((res) => (res.ok ? res.json() : null))
    .then((out) => {
      if (!out?.ok || !out.data?.content) return null
      return JSON.parse(out.data.content) as T
    })
    .catch(() => null)
}

// 'tenths' for playback/scrub readouts; 'whole' for summary lines (export notes)
// where sub-second precision is just noise.
function fmtTime(seconds: number, precision: 'tenths' | 'whole' = 'tenths') {
  const safe = Math.max(0, seconds || 0)
  const mins = Math.floor(safe / 60)
  const secs = Math.floor(safe % 60)
  if (precision === 'whole') return `${mins}:${String(secs).padStart(2, '0')}`
  const tenths = Math.floor((safe % 1) * 10)
  return `${mins}:${String(secs).padStart(2, '0')}.${tenths}`
}

function manifestContentPath(item: SceneManifestItem | undefined) {
  const value = String(item?.local_path || '').trim()
  if (!value) return ''
  const marker = '/spoolcast-content/'
  const index = value.indexOf(marker)
  return index >= 0 ? value.slice(index + marker.length) : value.replace(/^\/+/, '')
}

function contentSrc(path: string) {
  const clean = path.trim().replace(/^\/+/, '')
  return clean ? contentUrl(clean, 'preview') : ''
}

function audioSrc(chunkId: string) {
  return downloadUrl(`source/audio/${chunkId}.mp3`)
}

function mediaKindFromPath(path: string): 'image' | 'video' | 'missing' {
  const clean = path.toLowerCase()
  if (/\.(mp4|mov|webm)$/.test(clean)) return 'video'
  if (/\.(png|jpe?g|webp|gif)$/.test(clean)) return 'image'
  return 'missing'
}

function manifestItemType(item: SceneManifestItem): 'image' | 'video' | '' {
  const role = String(item.role || '')
  const mime = String(item.mime_type || '')
  const path = String(item.local_path || '').toLowerCase()
  if (role === 'scene-video' || mime.startsWith('video/') || /\.(mp4|mov|webm)$/.test(path)) return 'video'
  if (role === 'scene' || mime.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/.test(path)) return 'image'
  return ''
}

function mediaManifestItem(manifest: SceneManifest | null, id: string, type: 'image' | 'video') {
  return (manifest?.items ?? []).find((item) => {
    if (item.status && item.status !== 'success') return false
    const itemId = String(item.id || item.chunk_id || '').trim()
    if (itemId !== id) return false
    return manifestItemType(item) === type
  })
}

function promptItemId(item: GenerationPromptItem) {
  return String(item.id || item.chunk_id || '').trim()
}

function selectedMediaType(item: GenerationPromptItem | undefined, fallback: 'image' | 'video') {
  return item?.output_type === 'video' ? 'video' : item?.output_type === 'image' ? 'image' : fallback
}

function promptForType(item: GenerationPromptItem | undefined, type: 'image' | 'video') {
  return String(item?.prompt_variants?.[type]?.prompt || item?.prompt || '').trim()
}

function eventPathForType(event: BaseVisual, type: 'image' | 'video') {
  const generatedVideo = String(event.generated_video_path || '').trim()
  const imagePath = String(event.image_path || '').trim()
  if (type === 'video') {
    if (mediaKindFromPath(generatedVideo) === 'video') return generatedVideo
    if (mediaKindFromPath(imagePath) === 'video') return imagePath
    return ''
  }
  return mediaKindFromPath(imagePath) === 'image' ? imagePath : ''
}

function chunkNarration(chunk: ShotChunk | undefined) {
  return (chunk?.beats ?? [])
    .map((beat) => String(beat.narration || '').trim())
    .filter(Boolean)
    .join(' ')
}

const eventId = (event: BaseVisual) => String(event.id || event.pacing_image_id || event.chunk_id || '').trim()

// One timed subtitle phrase per visual event. The visuals are word-aligned to the
// audio, so when the beat count matches the event count (the overwhelming case) each
// visual simply shows its beat — a clean sentence phrase with the event's real
// timing. When counts diverge (e.g. the script was edited after alignment), we fall
// back to splitting the narration across events proportional to their duration, so
// there's never a dumped full-chunk block or a blank line. Returns eventId -> phrase.
function captionsForChunk(chunk: ShotChunk | undefined, eventsInOrder: BaseVisual[]) {
  const captions = new Map<string, string>()
  if (!eventsInOrder.length) return captions
  const beats = (chunk?.beats ?? []).map((beat) => String(beat.narration || '').trim()).filter(Boolean)

  if (beats.length === eventsInOrder.length) {
    eventsInOrder.forEach((event, index) => {
      const id = eventId(event)
      if (id) captions.set(id, beats[index])
    })
    return captions
  }

  const words = beats.join(' ').split(/\s+/).filter(Boolean)
  if (!words.length) return captions
  const durations = eventsInOrder.map((event) => Math.max(0.01, eventEnd(event) - eventStart(event)))
  const totalDuration = durations.reduce((sum, value) => sum + value, 0)
  let cursor = 0
  eventsInOrder.forEach((event, index) => {
    const id = eventId(event)
    if (!id) return
    const isLast = index === eventsInOrder.length - 1
    const take = isLast ? words.length - cursor : Math.max(1, Math.round((words.length * durations[index]) / totalDuration))
    const end = Math.min(words.length, cursor + take)
    captions.set(id, words.slice(cursor, end).join(' '))
    cursor = end
  })
  return captions
}

function eventStart(event: BaseVisual) {
  return Number(event.start_s ?? 0)
}

function eventEnd(event: BaseVisual) {
  const start = eventStart(event)
  return Number(event.end_s ?? start + Number(event.duration_s ?? 0))
}

function chunkLocalTime(chunk: AudioChunk, nextTime: number) {
  return Math.min(Math.max(0, nextTime - chunk.start), Math.max(0, chunk.end - chunk.start))
}

function ReviewPanel({
  title,
  meta,
  actions,
  className = '',
  defaultOpen = true,
  draggable = false,
  panelId,
  onPanelDragStart,
  onPanelDragOver,
  onPanelDrop,
  onPanelDragEnd,
  onOpenChange,
  children,
}: {
  title: string
  meta?: string
  // Controls living in the title row; hidden while the panel is collapsed.
  actions?: ReactNode
  className?: string
  defaultOpen?: boolean
  draggable?: boolean
  panelId?: ReviewPanelId
  onPanelDragStart?: (event: ReactDragEvent<HTMLElement>, panelId: ReviewPanelId) => void
  onPanelDragOver?: (event: ReactDragEvent<HTMLElement>, panelId: ReviewPanelId) => void
  onPanelDrop?: (event: ReactDragEvent<HTMLElement>, panelId: ReviewPanelId) => void
  onPanelDragEnd?: () => void
  onOpenChange?: (open: boolean) => void
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  // Disarm dragging the instant a press lands on an interactive control, so the
  // browser never starts drag-detection and the control (e.g. the scrubber) keeps
  // its pointer moves. Local state survives the frequent playback re-renders.
  const [dragArmed, setDragArmed] = useState(true)

  return (
    <details
      className={`vr-panel vr-layout-panel ${className}`}
      open={open}
      onToggle={(event) => {
        const nextOpen = event.currentTarget.open
        setOpen(nextOpen)
        onOpenChange?.(nextOpen)
      }}
      onPointerDown={draggable ? (event) => {
        if (!dragFromInteractiveControl(event.target)) return
        // Turn dragging off immediately (imperative, before the browser's
        // drag-detection runs on the following mousedown) and mirror it in state so
        // re-renders agree. Restore both on release — imperatively too, so a fast
        // tap that disarms+rearms within one frame can't leave it stuck off.
        const el = event.currentTarget
        el.draggable = false
        setDragArmed(false)
        const rearm = () => {
          el.draggable = true
          setDragArmed(true)
          window.removeEventListener('pointerup', rearm)
          window.removeEventListener('pointercancel', rearm)
        }
        window.addEventListener('pointerup', rearm)
        window.addEventListener('pointercancel', rearm)
      } : undefined}
      draggable={draggable && dragArmed}
      onDragStart={panelId ? (event) => onPanelDragStart?.(event, panelId) : undefined}
      onDragOver={panelId ? (event) => onPanelDragOver?.(event, panelId) : undefined}
      onDrop={panelId ? (event) => onPanelDrop?.(event, panelId) : undefined}
      onDragEnd={onPanelDragEnd}
    >
      <summary>
        <span>{title}</span>
        {meta ? <small>{meta}</small> : null}
        {open && actions ? (
          <span onClick={(event) => { event.preventDefault(); event.stopPropagation() }} style={{ flex: 'none', display: 'inline-flex' }}>
            {actions}
          </span>
        ) : null}
      </summary>
      <div className="vr-panel-body">{children}</div>
    </details>
  )
}

export function VisualReviewStage({
  layoutCommand,
  onToast,
}: {
  layoutCommand?: VisualReviewLayoutCommand | null
  onToast?: (message: string) => void
}) {
  const [shotList, setShotList] = useState<ShotList | null>(null)
  const [manifest, setManifest] = useState<SceneManifest | null>(null)
  const [promptDoc, setPromptDoc] = useState<GenerationPromptsDoc | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [selectedId, setSelectedId] = useState('')
  const [zoom, setZoom] = useState(1)
  const [controlsAwake, setControlsAwake] = useState(true)
  const [subtitlesOn, setSubtitlesOn] = useState(false)
  const [seeking, setSeeking] = useState(false)
  const [scrubbing, setScrubbing] = useState(false)
  // networkUrl -> seekable Blob object URL, once fetched. Preview <video> elements
  // render from here so they can seek; the audio element is pointed at blobs imperatively.
  const [mediaBlobs, setMediaBlobs] = useState<Record<string, string>>({})
  // Chunks whose narration audio is missing/broken (video-first sessions):
  // their clip videos are unmuted so the clips' own sound plays instead.
  const [videoSoundChunks, setVideoSoundChunks] = useState<Set<string>>(new Set())
  // Gallery "Fit": pack every tile into the panel's current box (with a small
  // minimum so a thumb stays recognizable). Off = the normal flowing grid.
  const [galleryFit, setGalleryFit] = useState(false)
  const [galleryFitCols, setGalleryFitCols] = useState<number | null>(null)
  const galleryStripRef = useRef<HTMLDivElement | null>(null)
  // Mirror for the sizing pass (its dep list is deliberately minimal).
  const galleryFitRef = useRef(false)
  // REAL compile/export: the engine's render_with_audit job. State lives in the
  // workflow store (the step footer gates Save/Autopilot on it and it must
  // survive step navigation); progress/error details are transient and local.
  // renderPct is null until the log yields a real frame count — no fake bars.
  const renderState = useWorkflowStore((s) => s.finalRender)
  const setRenderState = useWorkflowStore((s) => s.setFinalRender)
  const renderError = useWorkflowStore((s) => s.finalRenderError)
  const setRenderError = useWorkflowStore((s) => s.setFinalRenderError)
  const [renderPct, setRenderPct] = useState<number | null>(null)
  const [renderStatus, setRenderStatus] = useState('')
  const renderJobRef = useRef<string | null>(null)
  const renderTimerRef = useRef<number | null>(null)
  const [normalLayoutRows, setNormalLayoutRows] = useState(() => cloneReviewLayout(normalReviewLayoutRows))
  const [canvasRatio, setCanvasRatio] = useState(16 / 9)
  const canvasRatioRef = useRef(16 / 9)
  const [expandedLayoutRows, setExpandedLayoutRows] = useState(() => cloneReviewLayout(expandedReviewLayoutRows))
  const [mobileLayoutRows, setMobileLayoutRows] = useState(() => cloneReviewLayout(mobileReviewLayoutRows))
  const [rowSizes, setRowSizes] = useState<Record<string, number>>({})
  const [columnSizes, setColumnSizes] = useState<Record<string, number>>({})
  const [panelSizes, setPanelSizes] = useState<Record<string, number>>({})
  const [isExpandedCard, setIsExpandedCard] = useState(false)
  const [isMobileReview, setIsMobileReview] = useState(false)
  const [draggedPanel, setDraggedPanel] = useState<ReviewPanelId | null>(null)
  const [dropTarget, setDropTarget] = useState<ReviewDropTarget | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const previewRef = useRef<HTMLDivElement | null>(null)
  const workspaceRef = useRef<HTMLDivElement | null>(null)
  const videoRefs = useRef<Map<string, HTMLVideoElement>>(new Map())
  const lastAudioChunkRef = useRef('')
  const playAnchorRef = useRef({ timeline: 0, startedAt: 0 })
  const controlsTimerRef = useRef<number | null>(null)
  const scrubWasPlayingRef = useRef(false)
  const scrubActiveRef = useRef(false)
  const lastScrubValueRef = useRef(0)
  const timelineTimeRef = useRef(0)
  const seekTokenRef = useRef(0)
  const audioPlayRequestRef = useRef(0)
  // The id of the video segment currently driven on screen, so the loop only
  // re-seeks a <video> when crossing into a different segment (not every tick).
  const activeVideoIdRef = useRef('')
  // The engine API serves media without HTTP Range support, so a streamed
  // <audio>/<video> reports an empty seekable range and currentTime writes snap
  // back to 0 — mid-clip seeking is impossible. Loading the file into a Blob and
  // playing the object URL makes it fully seekable. networkUrl -> objectURL.
  const mediaUrlCacheRef = useRef<Map<string, string>>(new Map())
  const mediaPromiseRef = useRef<Map<string, Promise<string>>>(new Map())
  const manualRowSizeIdsRef = useRef<Set<string>>(new Set())
  const manualPanelSizeIdsRef = useRef<Set<string>>(new Set())
  const manualColumnSizeIdsRef = useRef<Set<string>>(new Set())
  const layoutClampFrameRef = useRef<number | null>(null)
  // Stable handle to the single starting-size pass so Save/Reset (declared above
  // the pass) can invoke the exact same logic initial load uses — no divergence.
  const applyDefaultSizesRef = useRef<() => void>(() => {})
  const lastLayoutCommandIdRef = useRef(0)
  const layoutRows = isMobileReview ? mobileLayoutRows : isExpandedCard ? expandedLayoutRows : normalLayoutRows
  const setLayoutRows = isMobileReview ? setMobileLayoutRows : isExpandedCard ? setExpandedLayoutRows : setNormalLayoutRows
  const layoutMode: ReviewLayoutMode = isMobileReview ? 'mobile' : isExpandedCard ? 'expanded' : 'normal'

  const saveCurrentLayoutDefault = useCallback(() => {
    const ids = reviewLayoutIds(layoutRows)
    const defaults = readSavedReviewLayouts()
    defaults[layoutMode] = {
      rows: cloneReviewLayout(layoutRows),
      rowSizes: pickSizes(rowSizes, ids.rowIds),
      columnSizes: pickSizes(columnSizes, ids.columnIds),
      panelSizes: pickSizes(panelSizes, ids.panelSlotIds),
      manualRowIds: [...ids.rowIds].filter((id) => manualRowSizeIdsRef.current.has(id)),
      manualPanelIds: [...ids.panelSlotIds].filter((id) => manualPanelSizeIdsRef.current.has(id)),
    }
    try {
      window.localStorage.setItem(reviewLayoutDefaultsKey(), JSON.stringify(defaults))
      onToast?.('Visual review layout saved.')
    } catch {
      onToast?.('Could not save layout.')
    }
  }, [columnSizes, layoutMode, layoutRows, onToast, panelSizes, rowSizes])

  // Reset is deliberately the SAME path as initial load: pick the arrangement
  // (saved or built-in default), clear sizing intent for this mode's ids, restore
  // only the manual overrides a save pinned, then run the one starting-size pass.
  // No saved layout => identical to a fresh refresh.
  const resetCurrentLayoutDefault = useCallback(() => {
    const savedLayout = readSavedReviewLayouts()[layoutMode]
    const nextRows = savedLayout ? cloneReviewLayout(savedLayout.rows) : defaultReviewLayoutRows(layoutMode)
    const currentIds = reviewLayoutIds(layoutRows)
    const nextIds = reviewLayoutIds(nextRows)
    const rowIds = mergeIdSets(currentIds.rowIds, nextIds.rowIds)
    const columnIds = mergeIdSets(currentIds.columnIds, nextIds.columnIds)
    const panelSlotIds = mergeIdSets(currentIds.panelSlotIds, nextIds.panelSlotIds)

    if (layoutMode === 'mobile') setMobileLayoutRows(cloneReviewLayout(nextRows))
    else if (layoutMode === 'expanded') setExpandedLayoutRows(cloneReviewLayout(nextRows))
    else setNormalLayoutRows(cloneReviewLayout(nextRows))

    setRowSizes((currentSizes) => replaceSizesForIds(currentSizes, rowIds, savedLayout?.rowSizes ?? {}))
    setColumnSizes((currentSizes) => replaceSizesForIds(currentSizes, columnIds, savedLayout?.columnSizes ?? {}))
    setPanelSizes((currentSizes) => replaceSizesForIds(currentSizes, panelSlotIds, savedLayout?.panelSizes ?? {}))

    for (const id of rowIds) manualRowSizeIdsRef.current.delete(id)
    for (const id of panelSlotIds) manualPanelSizeIdsRef.current.delete(id)
    for (const id of columnIds) manualColumnSizeIdsRef.current.delete(id)
    if (savedLayout) {
      // Default for legacy saves (no manual ids stored): every saved size was pinned.
      for (const id of savedLayout.manualRowIds ?? Object.keys(savedLayout.rowSizes)) manualRowSizeIdsRef.current.add(id)
      for (const id of savedLayout.manualPanelIds ?? Object.keys(savedLayout.panelSizes)) manualPanelSizeIdsRef.current.add(id)
      for (const id of Object.keys(savedLayout.columnSizes)) manualColumnSizeIdsRef.current.add(id)
    }

    if (layoutClampFrameRef.current) window.cancelAnimationFrame(layoutClampFrameRef.current)
    layoutClampFrameRef.current = window.requestAnimationFrame(() => {
      layoutClampFrameRef.current = null
      applyDefaultSizesRef.current()
    })

    onToast?.(savedLayout ? 'Visual review layout reset.' : 'Visual review layout restored.')
  }, [layoutMode, layoutRows, onToast])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError('')
      const [shot, scenes, prompts] = await Promise.all([
        readJsonFile<ShotList>('shot-list/shot-list.json'),
        readJsonFile<SceneManifest>('manifests/scenes.manifest.json'),
        readJsonFile<GenerationPromptsDoc>('working/generation-prompts.json'),
      ])
      if (cancelled) return
      if (!shot) setError('Could not load shot-list/shot-list.json.')
      setShotList(shot)
      setManifest(scenes)
      setPromptDoc(prompts)
      // THE CANVAS SHAPE drives the player box and the default layout. One
      // source: the shot list's canvas, falling back to the first prompt's
      // request aspect.
      // The GENERATION REQUEST'S aspect is the truth — the shot list's canvas
      // block can be stale scaffold data (observed: canvas 16:9, clips 9:16).
      const ar = String((prompts?.items?.[0] as { kie_request_preview?: { input?: { aspect_ratio?: string } } } | undefined)?.kie_request_preview?.input?.aspect_ratio
        || (shot as { canvas?: { aspect_ratio?: string } } | null)?.canvas?.aspect_ratio || '')
      const m = ar.match(/^(\d+):(\d+)$/)
      if (m) {
        const ratio = Number(m[1]) / Number(m[2])
        canvasRatioRef.current = ratio
        setCanvasRatio(ratio)
        if (ratio < 1 && !readSavedReviewLayouts().normal) {
          setNormalLayoutRows(cloneReviewLayout(normalPortraitLayoutRows))
        }
      }
      setLoading(false)
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!layoutCommand || layoutCommand.id === lastLayoutCommandIdRef.current) return
    lastLayoutCommandIdRef.current = layoutCommand.id
    const timer = window.setTimeout(() => {
      if (layoutCommand.action === 'save') saveCurrentLayoutDefault()
      else resetCurrentLayoutDefault()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [layoutCommand, resetCurrentLayoutDefault, saveCurrentLayoutDefault])

  const chunksById = useMemo(
    () => new Map((shotList?.chunks ?? []).map((chunk) => [String(chunk.id || ''), chunk])),
    [shotList],
  )
  const promptsById = useMemo(
    () => new Map((promptDoc?.items ?? []).map((item) => [promptItemId(item), item])),
    [promptDoc],
  )

  const segments = useMemo<ReviewSegment[]>(() => {
    const baseEvents = (shotList?.base_layer ?? []).filter((event) => (event.role || 'base_visual') === 'base_visual')
    // Per-event timed subtitle phrases, derived per chunk from the word-aligned events.
    const captionById = new Map<string, string>()
    const eventsByChunk = new Map<string, BaseVisual[]>()
    for (const event of baseEvents) {
      const cid = String(event.chunk_id || '').trim()
      const list = eventsByChunk.get(cid)
      if (list) list.push(event)
      else eventsByChunk.set(cid, [event])
    }
    for (const [cid, events] of eventsByChunk) {
      const ordered = [...events].sort((a, b) => eventStart(a) - eventStart(b))
      for (const [id, phrase] of captionsForChunk(chunksById.get(cid), ordered)) captionById.set(id, phrase)
    }
    return baseEvents
      .map((event) => {
        const id = String(event.id || event.pacing_image_id || event.chunk_id || '').trim()
        const promptItem = promptsById.get(id)
        const fallbackType = event.image_source === 'generated_video' || mediaKindFromPath(String(event.generated_video_path || event.image_path || '')) === 'video'
          ? 'video'
          : 'image'
        const activeType = selectedMediaType(promptItem, fallbackType)
        const manifestItem = mediaManifestItem(manifest, id, activeType)
        const manifestPath = manifestContentPath(manifestItem)
        const path = manifestPath.replace(new RegExp(`^sessions/${activeSession()}/`), '')
          || eventPathForType(event, activeType)
        const mediaType = mediaKindFromPath(path)
        const chunkId = String(event.chunk_id || '').trim()
        const chunk = chunksById.get(chunkId)
        const start = eventStart(event)
        const end = Math.max(start + 0.1, eventEnd(event))
        return {
          id,
          chunkId,
          title: String(event.summary || chunk?.scene_title || chunk?.summary || id),
          start,
          end,
          duration: end - start,
          mediaType,
          mediaSrc: contentSrc(path),
          prompt: String(promptForType(promptItem, activeType) || manifestItem?.prompt || event.video_prompt || event.prompt || event.image_prompt || event.visual_direction || ''),
          firstWord: String(event.first_word || ''),
          lastWord: String(event.last_word || ''),
          caption: captionById.get(id) || '',
          selectedType: activeType,
          generatedDuration: Number(manifestItem?.generated_duration_s || event.generated_duration_s || 0) || undefined,
        }
      })
      .filter((segment) => segment.id)
      .sort((a, b) => a.start - b.start)
  }, [chunksById, manifest, promptsById, shotList])

  const totalSec = useMemo(() => Math.max(0, ...segments.map((segment) => segment.end)), [segments])

  const audioChunks = useMemo<AudioChunk[]>(() => {
    return (shotList?.chunks ?? [])
      .map((chunk) => {
        const id = String(chunk.id || '').trim()
        const chunkSegments = segments.filter((segment) => segment.chunkId === id)
        const start = chunkSegments.length ? Math.min(...chunkSegments.map((segment) => segment.start)) : 0
        const end = chunkSegments.length ? Math.max(...chunkSegments.map((segment) => segment.end)) : start
        return {
          id,
          title: String(chunk.scene_title || chunk.summary || id),
          start,
          end,
          narration: chunkNarration(chunk),
          src: audioSrc(id),
        }
      })
      .filter((chunk) => chunk.id && chunk.end > chunk.start)
      .sort((a, b) => a.start - b.start)
  }, [segments, shotList])

  const segmentAtTime = useCallback((nextTime: number) => {
    return segments.find((segment) => nextTime >= segment.start && nextTime < segment.end)
      ?? (nextTime >= totalSec && segments.length ? segments[segments.length - 1] : undefined)
      ?? null
  }, [segments, totalSec])

  const chunkAtTime = useCallback((nextTime: number) => {
    return audioChunks.find((item) => nextTime >= item.start && nextTime < item.end)
      ?? (nextTime >= totalSec && audioChunks.length ? audioChunks[audioChunks.length - 1] : undefined)
      ?? null
  }, [audioChunks, totalSec])

  const activeSegment = useMemo(() => {
    return segmentAtTime(time)
      ?? segments.find((segment) => segment.id === selectedId)
      ?? segments[0]
  }, [segmentAtTime, segments, selectedId, time])

  const activeChunk = useMemo(() => {
    return chunkAtTime(time)
      ?? audioChunks.find((chunk) => chunk.id === activeSegment?.chunkId)
      ?? audioChunks[0]
  }, [chunkAtTime, activeSegment, audioChunks, time])

  const previewSegments = useMemo(() => {
    if (!activeSegment) return []
    const index = segments.findIndex((segment) => segment.id === activeSegment.id)
    const ids = new Set<string>()
    for (const item of [
      segments[index - 2],
      segments[index - 1],
      activeSegment,
      segments[index + 1],
      segments[index + 2],
    ]) {
      if (item?.id) ids.add(item.id)
    }
    return segments.filter((segment) => ids.has(segment.id))
  }, [activeSegment, segments])

  const setTimelineTime = (nextTime: number) => {
    timelineTimeRef.current = nextTime
    setTime(nextTime)
  }

  // Fit to container: the largest tile size where EVERY tile fits a bounded
  // box — BOTH dimensions. The height bound is the panel's real budget (its
  // slot in expanded, one-third of the screen in the normal view where the
  // slot otherwise grows with content), floored at a barely-readable minimum.
  const computeGalleryFit = useCallback(() => {
    const strip = galleryStripRef.current
    if (!strip) return
    const count = Math.max(1, segments.length)
    const width = strip.clientWidth
    const slot = strip.closest<HTMLElement>('.vr-panel-slot')
    const bound = Math.min(slot?.clientHeight ?? strip.clientHeight, window.innerHeight / 3)
    const height = Math.max(120, bound - 76)
    const gap = 10
    const labelBlock = 42
    const minTile = 56
    const ratio = canvasRatioRef.current || 16 / 9
    let pick: number | null = null
    for (let cols = 1; cols <= count; cols++) {
      const tileW = (width - (cols - 1) * gap) / cols
      if (tileW < minTile) break
      const rowsNeeded = Math.ceil(count / cols)
      const tileH = tileW / ratio + labelBlock
      if (rowsNeeded * tileH + (rowsNeeded - 1) * gap <= height) { pick = cols; break }
    }
    setGalleryFitCols(pick ?? Math.max(1, Math.min(count, Math.floor((width + gap) / (minTile + gap)))))
  }, [segments.length])

  const toggleGalleryFit = () => {
    setGalleryFit((current) => {
      const next = !current
      galleryFitRef.current = next
      if (!next) setGalleryFitCols(null)
      return next
    })
  }

  useEffect(() => {
    if (galleryFit) computeGalleryFit()
    // The gallery slot's own height depends on the packed grid — re-run the
    // one sizing pass so the slot snaps to it (and back when Fit turns off).
    applyDefaultSizesRef.current()
  }, [computeGalleryFit, galleryFit, isExpandedCard])

  const setVideoRef = (segmentId: string, node: HTMLVideoElement | null) => {
    if (node) videoRefs.current.set(segmentId, node)
    else videoRefs.current.delete(segmentId)
  }

  const pauseInactiveVideos = (activeId = '') => {
    videoRefs.current.forEach((video, id) => {
      if (id !== activeId) video.pause()
    })
  }

  const requestAudioPlay = (audio: HTMLAudioElement) => {
    const token = ++audioPlayRequestRef.current
    void audio.play().catch(() => {
      if (audioPlayRequestRef.current !== token || !audio.paused) return
      // A BROKEN/MISSING narration file (video-first sessions have none) must
      // not stop the timeline: mark the chunk so its clips play their own
      // sound, and let the wall clock carry time forward.
      if (audio.error) {
        const chunkId = lastAudioChunkRef.current
        if (chunkId) {
          setVideoSoundChunks((current) => {
            if (current.has(chunkId)) return current
            const next = new Set(current)
            next.add(chunkId)
            return next
          })
        }
        return
      }
      // Autoplay blocked (no gesture yet) — stop cleanly.
      setPlaying(false)
      setControlsAwake(true)
    })
  }

  // Fetch a media file into an in-memory Blob and return a seekable object URL,
  // caching per network URL. Falls back to the (non-seekable) streaming URL if the
  // fetch fails. Resolved URLs are also published to state so preview <video>
  // elements re-render onto the seekable source.
  const blobUrlFor = (networkUrl: string): Promise<string> => {
    if (!networkUrl) return Promise.resolve('')
    const cached = mediaUrlCacheRef.current.get(networkUrl)
    if (cached) return Promise.resolve(cached)
    let promise = mediaPromiseRef.current.get(networkUrl)
    if (!promise) {
      promise = fetch(networkUrl)
        .then((res) => { if (!res.ok) throw new Error('media fetch failed'); return res.blob() })
        .then((blob) => {
          const url = URL.createObjectURL(blob)
          mediaUrlCacheRef.current.set(networkUrl, url)
          setMediaBlobs((current) => (current[networkUrl] === url ? current : { ...current, [networkUrl]: url }))
          return url
        })
        .catch(() => networkUrl)
      mediaPromiseRef.current.set(networkUrl, promise)
    }
    return promise
  }

  const waitForMedia = (
    media: HTMLMediaElement,
    eventNames: string[],
    ready: () => boolean,
    timeoutMs = 1200,
  ) => new Promise<void>((resolve) => {
    if (ready()) {
      resolve()
      return
    }
    let done = false
    let timer = 0
    const cleanup = () => {
      if (done) return
      done = true
      window.clearTimeout(timer)
      for (const eventName of eventNames) media.removeEventListener(eventName, cleanup)
      resolve()
    }
    for (const eventName of eventNames) media.addEventListener(eventName, cleanup, { once: true })
    timer = window.setTimeout(cleanup, timeoutMs)
  })

  const waitForVideoRef = (segmentId: string, timeoutMs = 600) => new Promise<HTMLVideoElement | null>((resolve) => {
    const existing = videoRefs.current.get(segmentId)
    if (existing) {
      resolve(existing)
      return
    }
    const started = window.performance.now()
    const poll = () => {
      const video = videoRefs.current.get(segmentId)
      if (video) {
        resolve(video)
        return
      }
      if (window.performance.now() - started >= timeoutMs) {
        resolve(null)
        return
      }
      window.setTimeout(poll, 40)
    }
    poll()
  })

  // Put the on-screen video in sync with a timeline position. Only a SEGMENT
  // CROSSING swaps/seeks the <video>; once a segment is active it plays freely and
  // is never re-seeked per tick (per-tick reseeking was the playback glitch).
  const reconcileVideo = (nextTime: number, shouldPlay: boolean) => {
    const segment = segmentAtTime(nextTime)
    if (!segment || segment.mediaType !== 'video') {
      pauseInactiveVideos()
      activeVideoIdRef.current = ''
      return
    }
    const crossing = activeVideoIdRef.current !== segment.id
    const video = videoRefs.current.get(segment.id)
    pauseInactiveVideos(segment.id)
    activeVideoIdRef.current = segment.id
    if (!video) return
    if (crossing) {
      const local = Math.max(0, nextTime - segment.start)
      try { if (Math.abs(video.currentTime - local) > 0.1) video.currentTime = local } catch { /* non-seekable */ }
    }
    if (shouldPlay) { if (video.paused) void video.play().catch(() => {}) }
    else if (!video.paused) video.pause()
  }

  // Forward reconcile used by the play loop. Keeps the correct audio chunk loaded
  // and playing (loading the next chunk's seekable blob and playing from the
  // boundary on a crossing), and the correct video segment active. Nothing that is
  // already correct gets re-seeked.
  const reconcileForward = (nextTime: number, shouldPlay: boolean) => {
    const audio = audioRef.current
    if (audio) {
      const chunk = chunkAtTime(nextTime)
      if (!chunk) {
        if (!audio.paused) { audioPlayRequestRef.current += 1; audio.pause() }
      } else if (lastAudioChunkRef.current !== chunk.id) {
        lastAudioChunkRef.current = chunk.id
        void blobUrlFor(chunk.src).then((url) => {
          const a = audioRef.current
          if (!a || lastAudioChunkRef.current !== chunk.id) return
          a.src = url
          a.load()
          try { a.currentTime = chunkLocalTime(chunk, timelineTimeRef.current) } catch { /* seek once metadata is ready */ }
          if (shouldPlay) requestAudioPlay(a)
        })
      } else if (shouldPlay) {
        // Same chunk: keep playing, but don't replay an audio that finished early
        // (a chunk whose visuals run longer than its narration).
        if (audio.paused && !audio.ended) requestAudioPlay(audio)
      } else if (!audio.paused) {
        audioPlayRequestRef.current += 1
        audio.pause()
      }
    }
    reconcileVideo(nextTime, shouldPlay)
  }

  // Explicit seek to an exact time. Audio/video are loaded as seekable blobs, so
  // currentTime holds at a mid-clip position. Returns the bounded time, or null if
  // a newer seek superseded this one.
  const seekTo = async (target: number, resume: boolean) => {
    const token = ++seekTokenRef.current
    const bounded = Math.min(Math.max(target, 0), totalSec || 0)
    setSeeking(true)
    setTimelineTime(bounded)
    playAnchorRef.current = { timeline: bounded, startedAt: window.performance.now() }

    const audio = audioRef.current
    const chunk = chunkAtTime(bounded)
    if (audio) {
      if (!chunk) {
        audioPlayRequestRef.current += 1
        audio.pause()
      } else {
        if (lastAudioChunkRef.current !== chunk.id) {
          const url = await blobUrlFor(chunk.src)
          if (seekTokenRef.current !== token) return null
          audio.src = url
          lastAudioChunkRef.current = chunk.id
          audio.load()
        }
        if (!resume) { audioPlayRequestRef.current += 1; audio.pause() }
        // A broken narration file never becomes ready — don't sit on the timeout.
        await waitForMedia(audio, ['loadedmetadata', 'canplay', 'error'], () => audio.readyState >= 1 || Boolean(audio.error))
        if (seekTokenRef.current !== token) return null
        const localTime = chunkLocalTime(chunk, bounded)
        try { audio.currentTime = localTime } catch { /* ignore */ }
        await waitForMedia(audio, ['seeked', 'canplay', 'error'], () => (!audio.seeking && audio.readyState >= 2) || Boolean(audio.error), 900)
        if (seekTokenRef.current !== token) return null
      }
    }

    const segment = segmentAtTime(bounded)
    if (segment && segment.mediaType === 'video') {
      const video = await waitForVideoRef(segment.id)
      if (seekTokenRef.current !== token) return null
      pauseInactiveVideos(segment.id)
      activeVideoIdRef.current = segment.id
      if (video) {
        await waitForMedia(video, ['loadedmetadata', 'canplay'], () => video.readyState >= 1)
        if (seekTokenRef.current !== token) return null
        const local = Math.max(0, bounded - segment.start)
        try { video.currentTime = local } catch { /* non-seekable */ }
        await waitForMedia(video, ['seeked', 'canplay'], () => !video.seeking && video.readyState >= 2, 1200)
        if (seekTokenRef.current !== token) return null
      }
    } else {
      pauseInactiveVideos()
      activeVideoIdRef.current = ''
    }

    setSeeking(false)
    if (resume) {
      playAnchorRef.current = { timeline: bounded, startedAt: window.performance.now() }
      setPlaying(true)
      if (audio && chunk) requestAudioPlay(audio)
      const video = segment && segment.mediaType === 'video' ? videoRefs.current.get(segment.id) : null
      if (video) void video.play().catch(() => {})
    }
    return bounded
  }

  // Click-to-seek (gallery / timeline segment / chunk). Fire-and-forget.
  const setPlaybackTime = (nextTime: number, keepPlaying = playing) => {
    void seekTo(nextTime, keepPlaying)
  }

  const beginScrub = () => {
    if (scrubActiveRef.current) return
    scrubActiveRef.current = true
    setScrubbing(true)
    lastScrubValueRef.current = timelineTimeRef.current
    scrubWasPlayingRef.current = playing
    if (playing) setPlaying(false)
    seekTokenRef.current += 1
    audioPlayRequestRef.current += 1
    audioRef.current?.pause()
    pauseInactiveVideos()
    wakeControls()
  }

  // While dragging we only move the playhead and preview the current segment frame
  // (cheap); the precise audio+video seek happens once on release.
  const updateScrub = (value: number) => {
    const bounded = Math.min(Math.max(value, 0), totalSec || 0)
    lastScrubValueRef.current = bounded
    setTimelineTime(bounded)
    reconcileVideo(bounded, false)
    wakeControls()
  }

  const endScrub = (value = lastScrubValueRef.current) => {
    if (!scrubActiveRef.current && !scrubWasPlayingRef.current) return
    scrubActiveRef.current = false
    setScrubbing(false)
    lastScrubValueRef.current = value
    wakeControls()
    const shouldResume = scrubWasPlayingRef.current
    scrubWasPlayingRef.current = false
    void seekTo(value, shouldResume)
  }

  const togglePlay = () => {
    const next = !playing
    const currentTime = timelineTimeRef.current
    const nextTime = currentTime >= totalSec ? 0 : currentTime
    if (next) {
      void seekTo(nextTime, true)
    } else {
      setPlaying(false)
      setControlsAwake(true)
      if (controlsTimerRef.current) window.clearTimeout(controlsTimerRef.current)
      audioPlayRequestRef.current += 1
      audioRef.current?.pause()
      pauseInactiveVideos()
    }
  }

  const wakeControls = () => {
    setControlsAwake(true)
    if (controlsTimerRef.current) window.clearTimeout(controlsTimerRef.current)
    if (playing) {
      controlsTimerRef.current = window.setTimeout(() => setControlsAwake(false), 1700)
    }
  }

  const openPlayerFullscreen = () => {
    void previewRef.current?.requestFullscreen?.()
    wakeControls()
  }

  // REAL render: POST /api/action {action: render_with_audit} → the engine spawns
  // a durable job (scripts/spoolcast_job.py); its state JSON and log are session
  // files we poll through the api.ts seam. The audit writes
  // working/render-audit.passed on success — App's 5s status poll also watches
  // that sentinel, so completion is detected even while this step is closed.
  const stopRenderPolling = () => {
    if (renderTimerRef.current) {
      window.clearInterval(renderTimerRef.current)
      renderTimerRef.current = null
    }
  }

  const readSessionText = async (path: string) => {
    const out = await getJson<{ ok?: boolean; data?: { content?: string } }>(fileUrl(path))
    return out?.ok ? (out.data?.content ?? '') : ''
  }

  // Progress from the job log: the wrapper's "[render-with-audit] <stage>" lines
  // give the phase; Remotion's frame counters ("123/4567") give a real percent.
  // Only counters with a plausible frame total count — no fake progress.
  const applyRenderLog = (log: string) => {
    const tail = log.slice(-4000)
    let pct: number | null = null
    for (const match of tail.matchAll(/(\d+)\/(\d+)/g)) {
      const done = Number(match[1])
      const total = Number(match[2])
      if (total >= 50 && done <= total) pct = Math.round((done / total) * 100)
    }
    if (pct != null) setRenderPct(pct)
    const stage = [...tail.matchAll(/\[render-with-audit\] ([^\n]+)/g)].pop()?.[1]
    // Remotion's frame lines flood the tail once rendering starts and push the
    // wrapper's phase lines out — a live frame count IS the phase then.
    if (stage) setRenderStatus(stage.trim())
    else if (pct != null) setRenderStatus('Rendering frames')
  }

  const finishRenderJob = (job: { state?: string; exit_code?: number | null }, log = '') => {
    stopRenderPolling()
    window.localStorage.removeItem(RENDER_JOB_STORAGE_KEY())
    renderJobRef.current = null
    setRenderPct(null)
    if (job.state === 'succeeded') {
      setRenderError(null)
      setRenderState('done')
      return
    }
    // exit codes from scripts/render_with_audit.sh: 2 audit failed · 3 render
    // failed · 4 retry limit; 'lost' = the runner process died mid-flight.
    const friendly =
      job.exit_code === 2
        ? 'The video rendered but its quality audit failed — review the visuals and compile again.'
        : job.exit_code === 3
          ? 'The render failed before finishing.'
          : job.exit_code === 4
            ? 'The render hit its retry limit without a passing audit.'
            : job.state === 'lost'
              ? 'The render process disappeared before finishing (engine restarted?). Compile again.'
              : 'The render stopped before finishing. Compile again.'
    // The engine log usually states the actual reason — surface its last one.
    const detail = log
      .split('\n')
      .reverse()
      .find((line) => /refused|Reason:|ERROR|failed:/i.test(line))
      ?.replace(/^\[[^\]]+\]\s*/, '')
      .trim()
    setRenderError(detail ? `${friendly} ${detail}` : friendly)
    setRenderState('failed')
  }

  const resolveRenderJob = async (jobId: string, job: { state?: string; exit_code?: number | null }) => {
    finishRenderJob(job, await readSessionText(`working/jobs/${jobId}.log`))
  }

  const pollRenderJob = async () => {
    const jobId = renderJobRef.current
    if (!jobId) return
    const job = await getFileJson<{ state?: string; exit_code?: number | null }>(`working/jobs/${jobId}.json`)
    if (!job) return // transient read failure — keep polling
    if (job.state === 'running' || job.state === 'created') {
      applyRenderLog(await readSessionText(`working/jobs/${jobId}.log`))
      return
    }
    await resolveRenderJob(jobId, job)
  }

  const beginRenderPolling = (jobId: string) => {
    renderJobRef.current = jobId
    stopRenderPolling()
    renderTimerRef.current = window.setInterval(() => { void pollRenderJob() }, 2500)
    void pollRenderJob()
  }

  const startRender = async () => {
    // A failure to START is not a failed render: nothing was produced or
    // destroyed, so bounce back to whatever state we were in (a finished
    // video stays "done") and just explain why the click didn't take.
    const stateBeforeStart = renderState
    setRenderError(null)
    setRenderPct(null)
    setRenderStatus('Starting the render…')
    setRenderState('rendering')
    const out = await postAction<{ status?: string; stdout?: string }>({ action: 'render_with_audit' })
    // The runner refuses a duplicate while one is in flight — resume that one.
    const alreadyRunning = /already running as (\S+)/.exec(out?.details || '')?.[1]
    const jobId = alreadyRunning ?? /job (\S+)/.exec(out?.data?.stdout || '')?.[1] ?? null
    if (!out || (!out.ok && !alreadyRunning)) {
      setRenderState(stateBeforeStart === 'rendering' ? 'idle' : stateBeforeStart)
      setRenderError(
        out
          ? out.details || out.error || 'The engine could not start the render.'
          : 'The compile could not start — the engine is not reachable. Nothing was changed; try again.',
      )
      return
    }
    if (jobId) {
      window.localStorage.setItem(RENDER_JOB_STORAGE_KEY(), jobId)
      beginRenderPolling(jobId)
    }
    // No job id parsed (unexpected): stay in 'rendering' — the App status poll
    // flips to done when the audit sentinel appears.
  }

  // A compile started in a previous visit/page-load may still be running (or
  // have finished while this step was closed) — resume polling to resolve it.
  useEffect(() => {
    const jobId = window.localStorage.getItem(RENDER_JOB_STORAGE_KEY())
    if (!jobId) return
    if (useWorkflowStore.getState().finalRender === 'done') {
      window.localStorage.removeItem(RENDER_JOB_STORAGE_KEY())
      return
    }
    setRenderState('rendering')
    beginRenderPolling(jobId)
    // Resume-once on mount; polling helpers intentionally aren't dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const downloadFinalVideo = () => {
    const link = document.createElement('a')
    link.href = downloadUrl(RENDER_OUTPUT_PATH())
    link.download = RENDER_OUTPUT_NAME()
    link.click()
  }

  // Drag anywhere on a timeline track to scrub. The time maps from the pointer x
  // within the track (which spans 0..totalSec), accounting for zoom and pan via the
  // live bounding rect. Reuses the same begin/update/end scrub path as the player
  // scrubber, so the seek logic is shared.
  const timelineTimeFromPointer = (event: ReactPointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = (event.clientX - rect.left) / Math.max(1, rect.width)
    return Math.min(totalSec, Math.max(0, ratio * totalSec))
  }

  const timelineScrubHandlers = {
    'data-no-pan': true,
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!totalSec) return
      // Do NOT stopPropagation: panning is already blocked by `data-no-pan`, and the
      // pointerdown must reach the panel's drag-disarm gate (which matches
      // `.vp-timeline-scroll`) so dragging a track scrubs instead of grabbing the
      // whole timeline section to rearrange it.
      try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* ignore */ }
      beginScrub()
      updateScrub(timelineTimeFromPointer(event))
    },
    onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!scrubActiveRef.current) return
      updateScrub(timelineTimeFromPointer(event))
    },
    onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => {
      if (scrubActiveRef.current) endScrub(timelineTimeFromPointer(event))
    },
    onPointerCancel: () => { if (scrubActiveRef.current) endScrub() },
  }

  const layoutResizerSize = 10

  const collapsedHeaderHeight = (target: HTMLElement, fallback = 32) => {
    const panel = target.classList.contains('vr-panel-slot')
      ? target.querySelector<HTMLElement>(':scope > .vr-panel')
      : target.classList.contains('vr-panel')
        ? target
        : null
    const summary = panel?.querySelector<HTMLElement>(':scope > summary')
    return Math.max(fallback, summary?.offsetHeight || fallback)
  }

  const slotMinHeight = (slot: HTMLElement, fallback = 32) => collapsedHeaderHeight(slot, fallback)

  // Height of the body's content, measured relative to the BODY itself. Uses
  // bounding rects (+ scrollTop) rather than offsetTop — offsetTop is relative to
  // the nearest positioned ancestor (.vr-panel), which double-counted the summary
  // and left ~header-height of dead space below a short section when dragged.
  const bodyContentHeight = (body: HTMLElement) => {
    const bodyStyle = getComputedStyle(body)
    const paddingBottom = parseFloat(bodyStyle.paddingBottom || '0')
    const bodyTop = body.getBoundingClientRect().top - body.scrollTop
    const children = Array.from(body.children) as HTMLElement[]
    const childrenBottom = children.length
      ? Math.max(...children.map((child) => {
          const marginBottom = parseFloat(getComputedStyle(child).marginBottom || '0')
          return child.getBoundingClientRect().bottom - bodyTop + marginBottom
        }))
      : 0
    return Math.ceil(Math.max(body.scrollHeight, childrenBottom + paddingBottom))
  }

  const panelSlotContentHeight = (slot: HTMLElement, fallback = 32) => {
    const panel = slot.querySelector<HTMLElement>(':scope > .vr-panel')
    const minHeight = slotMinHeight(slot, fallback)
    if (!panel) return minHeight
    if (panel.classList.contains('vr-player-panel')) {
      // The SESSION'S canvas ratio, not an assumed 16:9 — capped to the
      // viewport so a 9:16 clip is tall, not endless.
      const ideal = slot.getBoundingClientRect().width / canvasRatioRef.current
      return Math.max(minHeight, Math.min(ideal, window.innerHeight * 0.78))
    }

    const summary = panel.querySelector<HTMLElement>(':scope > summary')
    const body = panel.querySelector<HTMLElement>(':scope > .vr-panel-body')
    const summaryHeight = summary && getComputedStyle(summary).position !== 'absolute' ? summary.offsetHeight : 0
    if (!panel.hasAttribute('open')) return Math.max(minHeight, summaryHeight)
    if (!body) return Math.max(minHeight, summaryHeight)
    return Math.max(minHeight, summaryHeight + bodyContentHeight(body))
  }

  const columnSlots = (column: HTMLElement) => (
    Array.from(column.querySelectorAll<HTMLElement>(':scope > .vr-panel-slot'))
  )

  const columnHeight = (column: HTMLElement, mode: 'min' | 'content') => {
    const slots = columnSlots(column)
    if (!slots.length) return 0
    const sectionsHeight = slots.reduce((sum, slot) => (
      sum + (mode === 'min' ? slotMinHeight(slot) : panelSlotContentHeight(slot))
    ), 0)
    return sectionsHeight + Math.max(0, slots.length - 1) * layoutResizerSize
  }

  const resizeMinHeight = (target: HTMLElement, fallback = 32) => {
    if (target.classList.contains('vr-panel-slot') || target.classList.contains('vr-panel')) {
      return collapsedHeaderHeight(target, fallback)
    }

    const columns = Array.from(target.querySelectorAll<HTMLElement>(':scope > .vr-layout-col'))
    if (columns.length) {
      return Math.max(
        fallback,
        ...columns.map((column) => columnHeight(column, 'min')),
      )
    }

    return fallback
  }

  const resizeContentHeight = (target: HTMLElement, min: number) => {
    if (target.classList.contains('vr-panel-slot')) {
      return panelSlotContentHeight(target, min)
    }

    const columns = Array.from(target.querySelectorAll<HTMLElement>(':scope > .vr-layout-col'))
    if (columns.length) {
      return Math.max(
        min,
        ...columns.map((column) => columnHeight(column, 'content')),
      )
    }

    return Math.max(min, target.scrollHeight)
  }

  // The single source of truth for starting/default sizes. Initial load, a window
  // resize, a rearrange, a panel toggle and Reset all funnel through this one pass,
  // so a fresh refresh and pressing Reset always produce the identical layout.
  //
  //  - collapsed section      -> its header height
  //  - manually-dragged slot  -> keep the user's height, only re-clamp to content
  //  - script/details/gallery -> clamp(header, content, 33vh)   (clip if taller)
  //  - video / timeline       -> no explicit size; flex to content / fill the row
  //
  // Expanded mode additionally fills the fixed card: the timeline row keeps its full
  // height and the remaining rows split the leftover height (video grows to fill).
  type SlotMeasure = { id: string; panelId: ReviewPanelId; open: boolean; minHeight: number; contentHeight: number; availableHeight: number | null }
  const applyDefaultSizes = useCallback(() => {
    const workspace = workspaceRef.current
    if (!workspace) return
    const cap = window.innerHeight / 3

    const measured = Array.from(workspace.querySelectorAll<HTMLElement>('.vr-panel-slot'))
      .map((slot): SlotMeasure | null => {
        const id = slot.dataset.layoutId
        const panelId = slot.dataset.panelId as ReviewPanelId | undefined
        if (!id || !panelId) return null
        const panel = slot.querySelector<HTMLElement>(':scope > .vr-panel')
        const open = panel ? panel.hasAttribute('open') : true
        const minHeight = resizeMinHeight(slot)
        // Sections BESIDE the video may fill down to the row's bottom edge
        // (where the timeline starts) — minus room for the sections below
        // them in the same column. That is their real budget, not the
        // one-third-screen cap.
        let availableHeight: number | null = null
        const row = slot.closest<HTMLElement>('.vr-layout-row')
        if (open && row && row.querySelector('.vr-player-panel') && !slot.querySelector('.vr-player-panel')) {
          let reserved = 0
          let sibling = slot.nextElementSibling
          while (sibling) {
            if (sibling instanceof HTMLElement && sibling.classList.contains('vr-panel-slot')) reserved += resizeMinHeight(sibling) + 8
            sibling = sibling.nextElementSibling
          }
          availableHeight = Math.max(
            minHeight,
            row.getBoundingClientRect().bottom - slot.getBoundingClientRect().top - reserved - 6,
          )
        }
        return { id, panelId, open, minHeight, contentHeight: open ? resizeContentHeight(slot, minHeight) : minHeight, availableHeight }
      })
      .filter((entry): entry is SlotMeasure => Boolean(entry))

    if (measured.length) {
      setPanelSizes((current) => {
        let changed = false
        const next = { ...current }
        for (const slot of measured) {
          const manual = manualPanelSizeIdsRef.current.has(slot.id)
          let target: number | null
          if (!slot.open) target = slot.minHeight
          else if (manual) target = Math.min(slot.contentHeight, Math.max(slot.minHeight, current[slot.id] ?? slot.contentHeight))
          // Beside the video: fill to content, or to the row's bottom edge
          // (the timeline) — whichever comes first.
          else if (cappableSection(slot.panelId) && slot.availableHeight != null) {
            target = Math.max(slot.minHeight, Math.min(slot.contentHeight, slot.availableHeight))
          }
          // The gallery in the NORMAL view grows to its content (the card just
          // gets taller) — no scroll, no clipping unless Fit packs it.
          else if (slot.panelId === 'gallery' && !isExpandedCard) {
            target = galleryFitRef.current
              ? Math.max(slot.minHeight, Math.min(slot.contentHeight, cap))
              : Math.max(slot.minHeight, slot.contentHeight)
          }
          else if (cappableSection(slot.panelId)) {
            target = Math.max(slot.minHeight, Math.min(slot.contentHeight, cap))
            // Snap to content when the cap would leave a sliver — a default
            // that hides half a line of text reads as broken, not capped.
            if (slot.contentHeight - target < 32) target = slot.contentHeight
          }
          else target = null
          if (target == null) {
            if (slot.id in next) { delete next[slot.id]; changed = true }
          } else if (!(slot.id in next) || Math.abs(next[slot.id] - target) > 1) {
            next[slot.id] = target
            changed = true
          }
        }
        return changed ? next : current
      })
    }

    // The height the pass just decided for the video's row — used below so the
    // column split works from assigned numbers, not a pre-layout rect.
    let assignedVideoRowHeight: number | null = null
    if (isExpandedCard && !isMobileReview) {
      const rows = Array.from(workspace.querySelectorAll<HTMLElement>(':scope > .vr-layout-row'))
      if (rows.length) {
        // 172 = fixed chrome above/below the layout in full mode: card top 56 +
        // bottom 32 + header 66 + body top padding 18. Matches the CSS min-height.
        const workspaceMin = Math.max(520, window.innerHeight - 172)
        // one lane between each pair of rows, plus the end-of-layout lane
        const resizerSpace = rows.length * layoutResizerSize
        const timelineRow = rows.find((row) => row.querySelector('.vr-timeline-panel')) ?? null
        const timelineHeight = timelineRow ? resizeContentHeight(timelineRow, resizeMinHeight(timelineRow)) : 0
        const otherRows = rows.filter((row) => row !== timelineRow)
        const remaining = Math.max(0, workspaceMin - timelineHeight - resizerSpace)
        const each = otherRows.length ? remaining / otherRows.length : 0
        setRowSizes((current) => {
          let changed = false
          const next = { ...current }
          const assign = (row: HTMLElement, height: number) => {
            const id = row.dataset.layoutId
            if (!id || manualRowSizeIdsRef.current.has(id)) return
            if (!(id in next) || Math.abs(next[id] - height) > 1) { next[id] = height; changed = true }
          }
          if (timelineRow) assign(timelineRow, timelineHeight)
          for (const row of otherRows) assign(row, Math.max(resizeMinHeight(row), each))
          return changed ? next : current
        })
        const videoRow = rows.find((row) => row.querySelector('.vr-player-panel'))
        if (videoRow) {
          const id = videoRow.dataset.layoutId || ''
          assignedVideoRowHeight = manualRowSizeIdsRef.current.has(id)
            ? videoRow.getBoundingClientRect().height
            : Math.max(resizeMinHeight(videoRow), each)
        }
      }
    }
    // PORTRAIT (both views): the video column only needs the video's own
    // width — hand the rest to the side column instead of leaving gutters.
    // Same single sizing pass; manual drags and saved splits win.
    {
      const ratio = canvasRatioRef.current
      const videoRow = Array.from(workspace.querySelectorAll<HTMLElement>(':scope > .vr-layout-row'))
        .find((row) => row.querySelector('.vr-player-panel'))
      const cols = videoRow ? Array.from(videoRow.querySelectorAll<HTMLElement>(':scope > .vr-layout-col')) : []
      if (ratio && ratio < 1 && videoRow && cols.length === 2) {
        const videoCol = cols.find((col) => col.querySelector('.vr-player-panel'))
        const sideCol = cols.find((col) => col !== videoCol)
        const videoId = videoCol?.dataset.layoutId
        const sideId = sideCol?.dataset.layoutId
        if (videoId && sideId && !manualColumnSizeIdsRef.current.has(videoId) && !manualColumnSizeIdsRef.current.has(sideId)) {
          // Expanded rows are pass-sized; the normal view's preview is capped
          // at 78vh. Either way ~74px of chrome sits above the video, +30
          // breathing room around its width.
          const previewHeight = isExpandedCard && !isMobileReview
            ? Math.max(140, (assignedVideoRowHeight ?? videoRow.getBoundingClientRect().height) - 74)
            : window.innerHeight * 0.78
          const wantWidth = Math.max(window.innerWidth * 0.2, previewHeight * ratio + 30)
          const totalWidth = Math.max(1, workspace.clientWidth)
          const videoWeight = Math.min(wantWidth, totalWidth * 0.6)
          setColumnSizes((current) => {
            const sideWeight = Math.max(1, totalWidth - videoWeight)
            if (Math.abs((current[videoId] ?? 0) - videoWeight) < 2 && Math.abs((current[sideId] ?? 0) - sideWeight) < 2) return current
            return { ...current, [videoId]: videoWeight, [sideId]: sideWeight }
          })
        }
      }
    }
    // Resize helpers intentionally read the live DOM after layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isExpandedCard, isMobileReview])

  useEffect(() => {
    applyDefaultSizesRef.current = applyDefaultSizes
  }, [applyDefaultSizes])

  const startPairResize = (
    event: ReactPointerEvent<HTMLButtonElement>,
    axis: 'x' | 'y',
    firstId: string,
    secondId: string,
    sizes: Record<string, number>,
    update: Dispatch<SetStateAction<Record<string, number>>>,
    onResize?: (delta: number) => void,
  ) => {
    const first = document.querySelector<HTMLElement>(`[data-layout-id="${firstId}"]`)
    const second = document.querySelector<HTMLElement>(`[data-layout-id="${secondId}"]`)
    if (!first || !second) return
    const firstRect = first.getBoundingClientRect()
    const secondRect = second.getBoundingClientRect()
    const firstStart = sizes[firstId] ?? (axis === 'x' ? firstRect.width : firstRect.height)
    const secondStart = sizes[secondId] ?? (axis === 'x' ? secondRect.width : secondRect.height)
    const total = Math.max(1, firstStart + secondStart)
    const start = axis === 'x' ? event.clientX : event.clientY
    const move = (moveEvent: PointerEvent) => {
      const current = axis === 'x' ? moveEvent.clientX : moveEvent.clientY
      const delta = current - start
      if (axis === 'y') {
        const minHeight = resizeMinHeight(first)
        const maxHeight = resizeContentHeight(first, minHeight)
        const nextFirst = Math.min(maxHeight, Math.max(minHeight, firstStart + delta))
        onResize?.(nextFirst - firstStart)
        update((currentSizes) => ({
          ...currentSizes,
          [firstId]: nextFirst,
        }))
        return
      }
      const minWidth = Math.max(72, window.innerWidth * 0.2)
      const nextFirst = Math.max(minWidth, firstStart + delta)
      const nextSecond = Math.max(minWidth, secondStart - delta)
      const scale = total / Math.max(1, nextFirst + nextSecond)
      update((currentSizes) => ({
        ...currentSizes,
        [firstId]: nextFirst * scale,
        [secondId]: nextSecond * scale,
      }))
    }
    const stop = () => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', stop)
    }
    move(event.nativeEvent)
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', stop)
    event.preventDefault()
  }

  const startSingleResize = (
    event: ReactPointerEvent<HTMLButtonElement>,
    axis: 'x' | 'y',
    id: string,
    sizes: Record<string, number>,
    update: Dispatch<SetStateAction<Record<string, number>>>,
    min = 72,
    onResize?: (delta: number) => void,
  ) => {
    const target = document.querySelector<HTMLElement>(`[data-layout-id="${id}"]`)
    if (!target) return
    const rect = target.getBoundingClientRect()
    const startSize = sizes[id] ?? (axis === 'x' ? rect.width : rect.height)
    const start = axis === 'x' ? event.clientX : event.clientY
    const move = (moveEvent: PointerEvent) => {
      const current = axis === 'x' ? moveEvent.clientX : moveEvent.clientY
      const delta = current - start
      const maxSize = axis === 'y' ? resizeContentHeight(target, min) : Infinity
      const nextSize = Math.min(maxSize, Math.max(min, startSize + delta))
      onResize?.(nextSize - startSize)
      update((currentSizes) => ({
        ...currentSizes,
        [id]: nextSize,
      }))
    }
    const stop = () => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', stop)
    }
    move(event.nativeEvent)
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', stop)
    event.preventDefault()
  }

  const startReviewColumnResize = (
    event: ReactPointerEvent<HTMLButtonElement>,
    firstId: string,
    secondId: string,
  ) => {
    // A hand-dragged column split is the user's — the default-sizing pass
    // must never overwrite it.
    manualColumnSizeIdsRef.current.add(firstId)
    manualColumnSizeIdsRef.current.add(secondId)
    startPairResize(event, 'x', firstId, secondId, columnSizes, setColumnSizes)
  }

  // Every column in the row participates — including single-section columns, which
  // the old plan skipped (that was bug #2: dragging a row taller left a clipped
  // gallery untouched). Only open, cappable sections can grow; video/timeline are
  // already at their natural height and carry no explicit size.
  const rowPanelResizePlan = (rowId: string): RowPanelResizeColumn[] => {
    const row = document.querySelector<HTMLElement>(`[data-layout-id="${rowId}"]`)
    if (!row) return []
    return Array.from(row.querySelectorAll<HTMLElement>(':scope > .vr-layout-col'))
      .map((column) => ({
        slots: columnSlots(column)
          .map((slot) => {
            const id = slot.dataset.layoutId
            const panelId = slot.dataset.panelId as ReviewPanelId | undefined
            const panel = slot.querySelector<HTMLElement>(':scope > .vr-panel')
            if (!id || !panelId || !cappableSection(panelId) || !panel?.hasAttribute('open')) return null
            const minHeight = resizeMinHeight(slot)
            return {
              id,
              minHeight,
              maxHeight: resizeContentHeight(slot, minHeight),
              startHeight: panelSizes[id] ?? slot.getBoundingClientRect().height,
            }
          })
          .filter((plan): plan is RowPanelResizeSlot => Boolean(plan)),
      }))
      .filter((column) => column.slots.length > 0)
  }

  const distributeColumnResize = (slots: RowPanelResizeSlot[], delta: number) => {
    const heights = new Map(slots.map((slot) => [slot.id, slot.startHeight]))
    let remaining = delta

    while (Math.abs(remaining) > 0.5) {
      const candidates = slots.filter((slot) => {
        const currentHeight = heights.get(slot.id) ?? slot.startHeight
        return remaining > 0
          ? currentHeight < slot.maxHeight - 0.5
          : currentHeight > slot.minHeight + 0.5
      })
      if (!candidates.length) break

      const share = remaining / candidates.length
      let applied = 0
      for (const slot of candidates) {
        const currentHeight = heights.get(slot.id) ?? slot.startHeight
        const nextHeight = remaining > 0
          ? Math.min(slot.maxHeight, currentHeight + share)
          : Math.max(slot.minHeight, currentHeight + share)
        heights.set(slot.id, nextHeight)
        applied += nextHeight - currentHeight
      }
      if (Math.abs(applied) < 0.5) break
      remaining -= applied
    }

    return heights
  }

  const applyRowPanelResize = (
    plan: RowPanelResizeColumn[],
    delta: number,
  ) => {
    if (!plan.length) return
    setPanelSizes((currentSizes) => {
      let changed = false
      const nextSizes = { ...currentSizes }
      for (const column of plan) {
        const heights = distributeColumnResize(column.slots, delta)
        for (const slot of column.slots) {
          const nextHeight = heights.get(slot.id) ?? slot.startHeight
          if (Math.abs((nextSizes[slot.id] ?? slot.startHeight) - nextHeight) > 0.5) {
            nextSizes[slot.id] = nextHeight
            changed = true
          }
        }
      }
      return changed ? nextSizes : currentSizes
    })
  }

  // Expanded mode fills a fixed-height card, so its rows trade height (zero-sum):
  // dragging the boundary grows one row's basis and pulls clipped sections with it.
  const startReviewRowResize = (
    event: ReactPointerEvent<HTMLButtonElement>,
    firstId: string,
    secondId: string,
  ) => {
    manualRowSizeIdsRef.current.add(firstId)
    const plan = rowPanelResizePlan(firstId)
    startPairResize(event, 'y', firstId, secondId, rowSizes, setRowSizes, (delta) => {
      applyRowPanelResize(plan, delta)
    })
  }

  const startReviewLastRowResize = (
    event: ReactPointerEvent<HTMLButtonElement>,
    rowId: string,
  ) => {
    manualRowSizeIdsRef.current.add(rowId)
    const plan = rowPanelResizePlan(rowId)
    const row = document.querySelector<HTMLElement>(`[data-layout-id="${rowId}"]`)
    startSingleResize(event, 'y', rowId, rowSizes, setRowSizes, row ? resizeMinHeight(row) : 32, (delta) => {
      applyRowPanelResize(plan, delta)
    })
  }

  // Normal/mobile height is free (the card just grows), so a row-height drag is
  // additive: the drag delta flows straight into the row's clipped cappable
  // sections — across ALL columns, including single-section ones — up to content.
  const startRowAdditiveResize = (
    event: ReactPointerEvent<HTMLButtonElement>,
    rowId: string,
  ) => {
    const plan = rowPanelResizePlan(rowId)
    event.preventDefault()
    if (!plan.length) return
    for (const column of plan) for (const slot of column.slots) manualPanelSizeIdsRef.current.add(slot.id)
    const start = event.clientY
    const move = (moveEvent: PointerEvent) => applyRowPanelResize(plan, moveEvent.clientY - start)
    const stop = () => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', stop)
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', stop)
  }

  // A splitter between two stacked sections grows the section above it (clamped to
  // its content), consistent with the additive height model.
  const startReviewPanelResize = (
    event: ReactPointerEvent<HTMLButtonElement>,
    firstId: string,
    secondId: string,
  ) => {
    manualPanelSizeIdsRef.current.add(firstId)
    startPairResize(event, 'y', firstId, secondId, panelSizes, setPanelSizes)
  }

  // Toggling open/closed only changes intent; the unified pass (next frame) sizes
  // the slot — open => clamp(header, content, 33vh), closed => header. Collapsing
  // also forgets a prior manual height so reopening returns to the standard default.
  const handleReviewPanelToggle = (slotId: string, open: boolean) => {
    if (!open) manualPanelSizeIdsRef.current.delete(slotId)
    if (layoutClampFrameRef.current) window.cancelAnimationFrame(layoutClampFrameRef.current)
    layoutClampFrameRef.current = window.requestAnimationFrame(() => {
      layoutClampFrameRef.current = null
      applyDefaultSizes()
    })
  }

  const updateLayoutRows = useCallback((update: (rows: ReviewLayoutRow[]) => ReviewLayoutRow[]) => {
    setLayoutRows((rows) => update(rows))
  }, [setLayoutRows])

  const edgeDropTarget = (
    event: ReactDragEvent<HTMLElement>,
    rowId: string,
    columnId: string,
    fallback: ReviewDropTarget,
  ): ReviewDropTarget => {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    const edgeX = Math.min(44, Math.max(24, rect.width * 0.16))
    const edgeY = Math.min(44, Math.max(24, rect.height * 0.16))

    if (y <= edgeY) return { kind: 'new-row', rowId, position: 'before' }
    if (y >= rect.height - edgeY) return { kind: 'new-row', rowId, position: 'after' }
    if (x <= edgeX) return { kind: 'new-column', rowId, columnId, position: 'before' }
    if (x >= rect.width - edgeX) return { kind: 'new-column', rowId, columnId, position: 'after' }

    return fallback
  }

  const panelDropTarget = (
    event: ReactDragEvent<HTMLElement>,
    panelId: ReviewPanelId,
    rowId: string,
    columnId: string,
  ): ReviewDropTarget => {
    const rect = event.currentTarget.getBoundingClientRect()
    const position = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
    return edgeDropTarget(event, rowId, columnId, { kind: 'panel', targetPanelId: panelId, position })
  }

  const startPanelDrag = (event: ReactDragEvent<HTMLElement>, panelId: ReviewPanelId) => {
    // Fallback: even if a drag somehow arms over a control, don't let it proceed.
    if (dragFromInteractiveControl(event.target)) {
      event.preventDefault()
      return
    }
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', panelId)
    setDraggedPanel(panelId)
  }

  const finishPanelDrag = () => {
    setDraggedPanel(null)
    setDropTarget(null)
  }

  const dragPanelOver = (event: ReactDragEvent<HTMLElement>, panelId: ReviewPanelId, rowId: string, columnId: string) => {
    if (!draggedPanel) return
    const target = panelDropTarget(event, panelId, rowId, columnId)
    if (draggedPanel === panelId && target.kind === 'panel') return
    event.preventDefault()
    event.stopPropagation()
    setDropTarget(target)
  }

  const dragColumnOver = (event: ReactDragEvent<HTMLElement>, rowId: string, columnId: string) => {
    if (!draggedPanel) return
    event.preventDefault()
    setDropTarget(edgeDropTarget(event, rowId, columnId, { kind: 'column', rowId, columnId }))
  }

  const dragNewColumnOver = (
    event: ReactDragEvent<HTMLElement>,
    rowId: string,
    columnId: string,
    position: 'before' | 'after',
  ) => {
    if (!draggedPanel) return
    event.preventDefault()
    event.stopPropagation()
    setDropTarget({ kind: 'new-column', rowId, columnId, position })
  }

  const dragNewRowOver = (event: ReactDragEvent<HTMLElement>, rowId: string, position: 'before' | 'after') => {
    if (!draggedPanel) return
    event.preventDefault()
    event.stopPropagation()
    setDropTarget({ kind: 'new-row', rowId, position })
  }

  const dropPanelOnTarget = (event: ReactDragEvent<HTMLElement>, fallbackTarget?: ReviewDropTarget) => {
    if (!draggedPanel) return
    event.preventDefault()
    event.stopPropagation()
    const target = fallbackTarget ?? dropTarget
    updateLayoutRows((rows) => moveReviewPanel(rows, draggedPanel, target))
    finishPanelDrag()
  }

  useEffect(() => {
    if (!playing) return
    if (controlsTimerRef.current) window.clearTimeout(controlsTimerRef.current)
    controlsTimerRef.current = window.setTimeout(() => setControlsAwake(false), 1700)
    const timer = window.setInterval(() => {
      const audio = audioRef.current
      const now = window.performance.now()
      const prev = timelineTimeRef.current
      const chunk = chunkAtTime(prev)
      // The audio element is the master clock whenever it is actually playing the
      // chunk for the current position; otherwise (gap, loading, finished-early)
      // the wall clock carries time forward from the last known point.
      const audioIsMaster = Boolean(
        chunk && audio && lastAudioChunkRef.current === chunk.id &&
        !audio.paused && !audio.ended && Number.isFinite(audio.currentTime),
      )
      let nextTime: number
      if (audioIsMaster && audio && chunk) {
        nextTime = Math.min(totalSec, chunk.start + audio.currentTime)
      } else {
        const elapsed = (now - playAnchorRef.current.startedAt) / 1000
        nextTime = Math.min(totalSec, playAnchorRef.current.timeline + elapsed)
      }
      playAnchorRef.current = { timeline: nextTime, startedAt: now }
      setTimelineTime(nextTime)
      reconcileForward(nextTime, true)
      if (nextTime >= totalSec - 0.05) {
        setPlaying(false)
        setControlsAwake(true)
        if (controlsTimerRef.current) window.clearTimeout(controlsTimerRef.current)
        audioPlayRequestRef.current += 1
        audioRef.current?.pause()
        pauseInactiveVideos()
      }
    }, 100)
    return () => window.clearInterval(timer)
    // The playback loop intentionally reads the latest media refs and clock
    // anchors; re-creating it on every helper identity change causes jitter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, totalSec])

  useEffect(() => {
    if (!scrubbing) return
    const finish = () => endScrub()
    window.addEventListener('pointerup', finish)
    window.addEventListener('mouseup', finish)
    window.addEventListener('touchend', finish)
    return () => {
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('mouseup', finish)
      window.removeEventListener('touchend', finish)
    }
    // Scrub listeners are only active while scrubbing; the current scrub value
    // is held in refs so listener identity does not need to drive rebinds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrubbing])

  useEffect(() => () => {
    if (controlsTimerRef.current) window.clearTimeout(controlsTimerRef.current)
    if (layoutClampFrameRef.current) window.cancelAnimationFrame(layoutClampFrameRef.current)
    // Only the POLLING stops on unmount — the render job itself keeps running
    // on the engine; the mount effect resumes watching it via localStorage.
    if (renderTimerRef.current) window.clearInterval(renderTimerRef.current)
    mediaUrlCacheRef.current.forEach((url) => URL.revokeObjectURL(url))
    mediaUrlCacheRef.current.clear()
  }, [])

  // Prefetch the seekable blobs: all audio chunks (tiny) and the video segments
  // (only a handful) so playback and scrubbing seek instantly and reliably.
  useEffect(() => {
    for (const chunk of audioChunks) void blobUrlFor(chunk.src)
    for (const segment of segments) {
      if (segment.mediaType === 'video' && segment.mediaSrc) void blobUrlFor(segment.mediaSrc)
    }
    // blobUrlFor only reads/writes refs + setState; it is stable for this purpose.
  }, [audioChunks, segments])

  useEffect(() => {
    const query = window.matchMedia('(max-width: 760px)')
    const update = () => setIsMobileReview(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    const workspace = workspaceRef.current
    if (!workspace) return
    const card = workspace.closest('.detail-card')
    if (!card) return

    const update = () => setIsExpandedCard(card.classList.contains('full'))
    update()
    const observer = new MutationObserver(update)
    observer.observe(card, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [segments.length])

  // Sync the active video only when the active SEGMENT changes (or play toggles),
  // not on every time tick — so a playing clip is left to run smoothly. Reads the
  // live time from the ref to position a freshly-mounted clip without a time dep.
  useEffect(() => {
    if (!activeSegment || activeSegment.mediaType !== 'video') {
      pauseInactiveVideos()
      activeVideoIdRef.current = ''
      return
    }
    const video = videoRefs.current.get(activeSegment.id)
    pauseInactiveVideos(activeSegment.id)
    activeVideoIdRef.current = activeSegment.id
    if (!video) return
    const local = Math.max(0, timelineTimeRef.current - activeSegment.start)
    try { if (Math.abs(video.currentTime - local) > 0.25) video.currentTime = local } catch { /* non-seekable */ }
    if (playing) void video.play().catch(() => {})
    else video.pause()
    // Intentionally not depending on `time`: re-seeking every tick caused the glitch.
  }, [activeSegment, playing])

  // Re-run the starting-size pass when the workspace WIDTH changes (card expand,
  // window resize). Height-only changes are ignored so the pass writing heights
  // can't feed back into a loop. segments.length re-subscribes once content mounts.
  useEffect(() => {
    const workspace = workspaceRef.current
    if (!workspace) return
    let frame = 0
    let lastWidth = -1
    const run = () => { frame = 0; applyDefaultSizes() }
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(run) }
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0
      if (Math.abs(width - lastWidth) < 1) return
      lastWidth = width
      schedule()
    })
    observer.observe(workspace)
    return () => {
      observer.disconnect()
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [applyDefaultSizes, segments.length])

  // Re-run after a rearrange (new slots need a starting height) and once content
  // first mounts. Starting size is stable per (mode, arrangement, width): mode flips
  // re-create applyDefaultSizes, width changes go through the observer above, and
  // toggles/reset call the pass directly — so per-chunk content changes during
  // playback deliberately do NOT resize sections (no height jitter).
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => applyDefaultSizes())
    return () => window.cancelAnimationFrame(frame)
  }, [applyDefaultSizes, layoutRows, segments.length])

  const pct = (value: number) => (totalSec ? (value / totalSec) * 100 : 0)
  const ticks = useMemo(() => {
    const step = totalSec > 180 ? 30 : totalSec > 90 ? 15 : 10
    const list: number[] = []
    for (let t = 0; t < totalSec; t += step) list.push(t)
    return list
  }, [totalSec])

  const panelClassName = (panelId: ReviewPanelId, className: string) => {
    const dropClass = dropTarget?.kind === 'panel' && dropTarget.targetPanelId === panelId
      ? ` is-drop-target drop-${dropTarget.position}`
      : ''
    const dragClass = draggedPanel === panelId ? ' is-drag-source' : ''
    return `${className}${dragClass}${dropClass}`
  }

  const panelDragProps = (panelId: ReviewPanelId, rowId: string, columnId: string) => ({
    panelId,
    draggable: true,
    onPanelDragStart: startPanelDrag,
    onPanelDragOver: (event: ReactDragEvent<HTMLElement>, targetPanelId: ReviewPanelId) => {
      dragPanelOver(event, targetPanelId, rowId, columnId)
    },
    onPanelDrop: (event: ReactDragEvent<HTMLElement>, targetPanelId: ReviewPanelId) => {
      dropPanelOnTarget(event, panelDropTarget(event, targetPanelId, rowId, columnId))
    },
    onPanelDragEnd: finishPanelDrag,
    onOpenChange: (open: boolean) => handleReviewPanelToggle(`${columnId}-${panelId}`, open),
  })

  const layoutSizeStyle = (id: string, sizes: Record<string, number>, disabled = false): CSSProperties => (
    !disabled && sizes[id] ? { flex: `0 0 ${sizes[id]}px` } : {}
  )

  const columnSizeStyle = (id: string, disabled = false): CSSProperties => (
    !disabled && columnSizes[id] ? { flex: `${columnSizes[id]} 1 0` } : {}
  )

  const renderReviewPanel = (panelId: ReviewPanelId, rowId: string, columnId: string) => {
    if (panelId === 'video') {
      return (
        <ReviewPanel
          {...panelDragProps('video', rowId, columnId)}
          className={panelClassName('video', 'vr-player-panel')}
          title="Video preview"
          meta={`${activeSegment?.id || 'visual'} · ${activeSegment?.mediaType || 'missing'}`}
        >
          <div className="vr-player">
            <div
              ref={previewRef}
              className={`vr-preview ${playing && !controlsAwake ? 'idle' : ''} ${seeking ? 'seeking' : ''}`}
              style={isExpandedCard && !isMobileReview
                // Expanded: CSS gives the preview its slot's height via
                // container-query units — it tracks every row drag with no
                // clipping. Only the ratio and centering live inline.
                ? { aspectRatio: `${canvasRatio}`, width: 'auto', margin: '0 auto', maxWidth: '100%' }
                : { aspectRatio: `${canvasRatio}`, maxHeight: '78vh', width: 'auto', margin: '0 auto', maxWidth: '100%' }}
              onMouseMove={wakeControls}
              onMouseEnter={wakeControls}
              onFocus={wakeControls}
            >
              {previewSegments.map((segment) => (
                segment.mediaType === 'video' ? (
                  <video
                    ref={(node) => setVideoRef(segment.id, node)}
                    className={`vr-media ${segment.id === activeSegment?.id ? 'on' : ''}`}
                    key={segment.id}
                    src={mediaBlobs[segment.mediaSrc] ?? segment.mediaSrc}
                    muted={!videoSoundChunks.has(segment.chunkId)}
                    playsInline
                    preload="auto"
                    controls={false}
                  />
                ) : segment.mediaType === 'image' ? (
                  <img
                    className={`vr-media ${segment.id === activeSegment?.id ? 'on' : ''}`}
                    key={segment.id}
                    src={segment.mediaSrc}
                    alt=""
                  />
                ) : segment.id === activeSegment?.id ? (
                  <span className="vr-media on" key={segment.id}>missing visual</span>
                ) : null
              ))}
              <div className="vr-title-overlay">
                <b>{activeSegment?.title || 'Visual review'}</b>
                <span>
                  {activeSegment?.id || 'visual'} · {activeSegment?.selectedType || 'image'} → {activeSegment?.mediaType || 'missing'} · {fmtTime(activeSegment?.start || 0)}-{fmtTime(activeSegment?.end || 0)}
                </span>
              </div>
              <div className="vr-player-top-actions">
                <button
                  type="button"
                  className={`vr-text-control ${subtitlesOn ? 'on' : ''}`}
                  onClick={() => {
                    setSubtitlesOn((value) => !value)
                    wakeControls()
                  }}
                  aria-pressed={subtitlesOn}
                  title="Toggle script subtitles"
                >
                  CC
                </button>
                <button
                  type="button"
                  className="vr-text-control"
                  onClick={openPlayerFullscreen}
                  title="Fullscreen player"
                >
                  ⤢
                </button>
              </div>
              {subtitlesOn && (activeSegment?.caption || activeChunk?.narration) ? (
                <p className="vr-subtitles">
                  {activeSegment?.caption || activeChunk?.narration}
                </p>
              ) : null}
              {seeking ? <span className="vr-seeking">Seeking…</span> : null}
              <div className="vr-player-controls">
                <button type="button" className="save-continue" onClick={togglePlay}>
                  {playing ? 'Pause' : 'Play'}
                </button>
                <span className="vr-time">{fmtTime(time)} / {fmtTime(totalSec)}</span>
                <input
                  type="range"
                  min={0}
                  max={Math.max(0, totalSec)}
                  step={0.05}
                  value={Math.min(time, totalSec)}
                  onPointerDown={beginScrub}
                  onMouseDown={beginScrub}
                  onTouchStart={beginScrub}
                  onChange={(event) => updateScrub(Number(event.target.value))}
                  onPointerUp={(event) => endScrub(Number(event.currentTarget.value))}
                  onMouseUp={(event) => endScrub(Number(event.currentTarget.value))}
                  onTouchEnd={(event) => endScrub(Number(event.currentTarget.value))}
                  onBlur={(event) => endScrub(Number(event.currentTarget.value))}
                  onKeyDown={beginScrub}
                  onKeyUp={(event) => endScrub(Number(event.currentTarget.value))}
                  aria-label="Timeline scrubber"
                />
              </div>
            </div>
          </div>
        </ReviewPanel>
      )
    }

    if (panelId === 'script') {
      return (
        <ReviewPanel
          {...panelDragProps('script', rowId, columnId)}
          className={panelClassName('script', 'vr-script-panel')}
          title={activeSegment?.title || 'Script'}
          meta={`${activeSegment?.id || 'visual'} · ${fmtTime(activeSegment?.start || 0)}-${fmtTime(activeSegment?.end || 0)}`}
        >
          <section className="vr-script">
            <p className="vp-active-narr">{activeChunk?.narration || 'No narration found for this audio chunk.'}</p>
          </section>
        </ReviewPanel>
      )
    }

    if (panelId === 'details') {
      return (
        <ReviewPanel
          {...panelDragProps('details', rowId, columnId)}
          className={panelClassName('details', 'vr-details-panel')}
          title="Prompt"
          meta={`selected ${activeSegment?.selectedType || 'image'} · showing ${activeSegment?.mediaType || 'missing'}`}
        >
          <p className="vp-active-what">{activeSegment?.prompt || 'No prompt stored for this segment.'}</p>
          <p className="vp-active-refs">
            slot {(activeSegment?.duration || 0).toFixed(1)}s
            {activeSegment?.generatedDuration ? ` · generated ${activeSegment.generatedDuration.toFixed(1)}s` : ''}
            {activeSegment?.firstWord || activeSegment?.lastWord ? ` · ${activeSegment.firstWord} to ${activeSegment.lastWord}` : ''}
          </p>
        </ReviewPanel>
      )
    }

    if (panelId === 'gallery') {
      return (
        <ReviewPanel
          {...panelDragProps('gallery', rowId, columnId)}
          className={panelClassName('gallery', 'vr-gallery-panel')}
          title="Gallery"
          meta={`${segments.length} visuals`}
          actions={(
            <button
              type="button"
              className={`vp-undo ${galleryFit ? 'on' : ''}`}
              title="Pack every thumbnail into the panel's box — height and width (small floor so they stay readable)"
              onClick={toggleGalleryFit}
            >
              Fit to container
            </button>
          )}
        >
          <div
            className="vr-strip"
            ref={galleryStripRef}
            style={galleryFit && galleryFitCols ? { gridTemplateColumns: `repeat(${galleryFitCols}, 1fr)` } : undefined}
          >
            {segments.map((segment) => (
              <button
                type="button"
                key={segment.id}
                className={segment.id === activeSegment?.id ? 'on' : ''}
                onClick={() => {
                  setSelectedId(segment.id)
                  setPlaybackTime(segment.start, false)
                }}
              >
                {/* True proportion — tiles adopt the canvas ratio (the same
                    source the player box uses), not a fixed 16:9 crop. */}
                {segment.mediaType === 'video' ? (
                  <video src={segment.mediaSrc} style={{ aspectRatio: `${canvasRatio}` }} muted playsInline preload="metadata" />
                ) : segment.mediaType === 'image' ? (
                  <img src={segment.mediaSrc} alt="" style={{ aspectRatio: `${canvasRatio}` }} />
                ) : (
                  <span style={{ aspectRatio: `${canvasRatio}` }}>{segment.id}</span>
                )}
                <b>{segment.id}</b>
                <small>{segment.selectedType} · {segment.duration.toFixed(1)}s</small>
              </button>
            ))}
          </div>
        </ReviewPanel>
      )
    }

    return (
      <ReviewPanel
        {...panelDragProps('timeline', rowId, columnId)}
        className={panelClassName('timeline', 'vr-timeline-panel')}
        title="Timeline"
        meta={`${segments.length} visuals · ${audioChunks.length} audio chunks · ${fmtTime(totalSec)}`}
      >
        <TimelineScroller
          zoom={zoom}
          setZoom={setZoom}
          hint="Click a segment to preview it · drag the scrubber to review an exact time"
        >
          <div className="vp-tl-row">
            <span className="vp-tl-label">Visuals</span>
            <div className="vp-tl-track visuals vr-scrubbable" {...timelineScrubHandlers}>
              <span className={`vr-playhead ${scrubbing ? 'scrubbing' : ''}`} style={{ left: `${pct(time)}%` }}>
                <span className="vr-playhead-knob" />
              </span>
              {segments.map((segment) => (
                <button
                  type="button"
                  key={segment.id}
                  className={`vp-seg ${segment.id === activeSegment?.id ? 'on' : ''} ${segment.mediaType === 'video' ? 'video' : ''}`}
                  style={{ left: `${pct(segment.start)}%`, width: `${Math.max(0.35, pct(segment.duration))}%` }}
                  onClick={() => {
                    setSelectedId(segment.id)
                    setPlaybackTime(segment.start, false)
                  }}
                  title={`${segment.id} · selected ${segment.selectedType} · showing ${segment.mediaType} · ${segment.duration.toFixed(1)}s`}
                >
                  <span>{segment.id}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="vp-tl-row">
            <span className="vp-tl-label">Audio</span>
            <div className="vp-tl-track ruler vr-scrubbable" {...timelineScrubHandlers}>
              {audioChunks.map((chunk, index) => (
                <button
                  type="button"
                  key={chunk.id}
                  className={`vp-ruler-seg ${index % 2 ? 'alt' : ''} ${chunk.id === activeChunk?.id ? 'on' : ''}`}
                  style={{ left: `${pct(chunk.start)}%`, width: `${Math.max(0.35, pct(chunk.end - chunk.start))}%` }}
                  onClick={() => {
                    setSelectedId('')
                    setPlaybackTime(chunk.start, false)
                  }}
                  title={`${chunk.id} · ${chunk.title}`}
                >
                  <span>{chunk.id}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="vp-tl-row axis">
            <span className="vp-tl-label" />
            <div className="vp-tl-track vr-scrubbable" {...timelineScrubHandlers}>
              {ticks.map((tick) => (
                <span key={tick} className="vp-tick" style={{ left: `${pct(tick)}%` }}>{fmtTime(tick)}</span>
              ))}
              <span className="vp-tick end" style={{ left: '100%' }}>{fmtTime(totalSec)}</span>
            </div>
          </div>
        </TimelineScroller>
      </ReviewPanel>
    )
  }

  return (
    <div className="vr panel-flat" onClick={(event) => {
      if (event.target === event.currentTarget) setSelectedId('')
    }}>
      <audio
        ref={audioRef}
        preload="metadata"
        onError={() => {
          const chunkId = lastAudioChunkRef.current
          if (!chunkId) return
          setVideoSoundChunks((current) => {
            if (current.has(chunkId)) return current
            const next = new Set(current)
            next.add(chunkId)
            return next
          })
        }}
      />

      {loading ? <p className="vp-hint">Loading generated visual timeline...</p> : null}
      {error ? <p className="vp-hint">{error}</p> : null}

      {segments.length ? (
        <div
          ref={workspaceRef}
          className={`vr-layout ${isMobileReview ? 'is-mobile' : ''} ${draggedPanel ? 'is-dragging' : ''}`}
          style={renderState === 'rendering' ? { opacity: 0.4, pointerEvents: 'none' } : undefined}
        >
          {layoutRows.map((row, rowIndex) => (
            <Fragment key={row.id}>
              <div
                data-layout-id={row.id}
                className={`vr-layout-row vr-layout-row-${row.id} ${dropTarget?.kind === 'new-row' && dropTarget.rowId === row.id ? `is-drop-target drop-${dropTarget.position}` : ''}`}
                style={layoutSizeStyle(row.id, rowSizes)}
              >
                {row.columns.map((column, columnIndex) => (
                  <Fragment key={column.id}>
                    <div
                      data-layout-id={column.id}
                      className={`vr-layout-col vr-layout-col-${column.id} ${
                        dropTarget?.kind === 'column' && dropTarget.columnId === column.id
                          ? 'is-drop-target'
                          : dropTarget?.kind === 'new-column' && dropTarget.columnId === column.id
                            ? `is-drop-target drop-${dropTarget.position}`
                            : ''
                      }`}
                      style={columnSizeStyle(column.id, row.columns.length === 1)}
                      onDragOver={(event) => dragColumnOver(event, row.id, column.id)}
                      onDrop={(event) => dropPanelOnTarget(event)}
                    >
                      {column.panels.map((panelId, panelIndex) => (
                        <Fragment key={panelId}>
                          <div
                            data-layout-id={`${column.id}-${panelId}`}
                            data-panel-id={panelId}
                            // is-sized: this slot has an explicit height, so CSS
                            // can budget its body (scroll instead of clipping).
                            className={`vr-panel-slot${panelSizes[`${column.id}-${panelId}`] ? ' is-sized' : ''}`}
                            style={layoutSizeStyle(`${column.id}-${panelId}`, panelSizes)}
                          >
                            {renderReviewPanel(panelId, row.id, column.id)}
                          </div>
                          {panelIndex < column.panels.length - 1 ? (
                            <button
                              type="button"
                              className="vr-layout-resizer vr-layout-resizer-panel"
                              onPointerDown={(event) => startReviewPanelResize(
                                event,
                                `${column.id}-${panelId}`,
                                `${column.id}-${column.panels[panelIndex + 1]}`,
                              )}
                              title="Drag to resize adjacent sections"
                              aria-label="Resize adjacent sections"
                            />
                          ) : null}
                        </Fragment>
                      ))}
                    </div>
                    {columnIndex < row.columns.length - 1 ? (
                      <button
                        type="button"
                        className={`vr-layout-resizer vr-layout-resizer-col ${dropTarget?.kind === 'new-column' && dropTarget.columnId === column.id ? 'is-drop-target' : ''}`}
                        onPointerDown={(event) => startReviewColumnResize(event, column.id, row.columns[columnIndex + 1].id)}
                        onDragOver={(event) => dragNewColumnOver(event, row.id, column.id, 'after')}
                        onDrop={(event) => dropPanelOnTarget(event, { kind: 'new-column', rowId: row.id, columnId: column.id, position: 'after' })}
                        title="Drag to resize adjacent sections"
                        aria-label="Resize adjacent columns"
                      />
                    ) : null}
                  </Fragment>
                ))}
              </div>
              {rowIndex < layoutRows.length - 1 ? (
                <button
                  type="button"
                  className={`vr-layout-resizer vr-layout-resizer-row ${dropTarget?.kind === 'new-row' && dropTarget.rowId === row.id ? 'is-drop-target' : ''}`}
                  onPointerDown={(event) => (isExpandedCard && !isMobileReview)
                    ? startReviewRowResize(event, row.id, layoutRows[rowIndex + 1].id)
                    : startRowAdditiveResize(event, row.id)}
                  onDragOver={(event) => dragNewRowOver(event, row.id, 'after')}
                  onDrop={(event) => dropPanelOnTarget(event, { kind: 'new-row', rowId: row.id, position: 'after' })}
                  title="Drag to resize adjacent rows"
                  aria-label="Resize adjacent rows"
                />
              ) : (
                <button
                  type="button"
                  className="vr-layout-resizer vr-layout-resizer-row vr-layout-resizer-end"
                  onPointerDown={(event) => (isExpandedCard && !isMobileReview)
                    ? startReviewLastRowResize(event, row.id)
                    : startRowAdditiveResize(event, row.id)}
                  onDragOver={(event) => dragNewRowOver(event, row.id, 'after')}
                  onDrop={(event) => dropPanelOnTarget(event, { kind: 'new-row', rowId: row.id, position: 'after' })}
                  title="Drag to resize this row"
                  aria-label="Resize this row"
                />
              )}
            </Fragment>
          ))}
        </div>
      ) : !loading ? (
        <p className="vp-hint">No generated base-layer visuals found yet.</p>
      ) : null}

      {segments.length ? (
        <section className="vr-export">
          {renderState === 'done' ? (
            <>
              <div className="vr-export-actions">
                <button type="button" onClick={downloadFinalVideo}>Download video</button>
                <button type="button" onClick={startRender}>Compile again</button>
              </div>
              <p className="vr-export-note">{RENDER_OUTPUT_NAME()} · 1920×1080 · {fmtTime(totalSec, 'whole')}</p>
            </>
          ) : (
            <>
              <div className="vr-export-run">
                {renderState === 'rendering' ? (
                  <span className="voice-run-progress">
                    <span className="voice-run-status">
                      {renderStatus || 'Compiling'}{renderPct != null ? ` · ${renderPct}%` : ''}
                    </span>
                    {/* The track is always visible while compiling; it fills with
                        REAL frame counts once Remotion starts (setup phases sit at 0). */}
                    <span className="progress"><i style={{ width: `${renderPct ?? 0}%` }} /></span>
                  </span>
                ) : null}
                <button type="button" className="save-continue" onClick={startRender} disabled={renderState === 'rendering'}>
                  {renderState === 'rendering'
                    ? (<><span className="spin" /> Compiling…</>)
                    : renderState === 'idle' ? 'Compile final video' : 'Compile again'}
                </button>
              </div>
              {renderState === 'stale' ? (
                <p className="vr-export-note">The visuals or timing changed since the last compile — compile again so the video matches.</p>
              ) : renderState === 'failed' && !renderError ? (
                <p className="vr-export-note">The last compile did not finish — compile again.</p>
              ) : renderState !== 'failed' ? (
                <p className="vr-export-note">
                  Combines all {segments.length} visuals + narration · 1920×1080 · {fmtTime(totalSec, 'whole')}
                </p>
              ) : null}
            </>
          )}
          {/* The failure/why-it-didn't-start explanation survives remounts (store)
              and shows in ANY settled state — a start-failure bounces back to
              "done" and still explains itself here. */}
          {renderError && renderState !== 'rendering' ? (
            <p className="voice-error" style={{ textAlign: 'right' }}>{renderError}</p>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}
