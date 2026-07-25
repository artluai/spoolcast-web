import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, Dispatch, DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode, SetStateAction } from 'react'
import { activeSession, apiUrl, contentUrl, downloadUrl, fileUrl, getFileJson, getJson, jobsUrl, postAction, renderInfoUrl, templatesUrl, uploadFinalCutAsset } from '../../lib/api'
import { useWorkflowStore } from '../../store/workflow'
import { TimelineScroller } from './TimelineScroller'

// The engine's render job: started via POST /api/action (heavy actions route to
// the durable job runner), tracked through its state file + log under
// working/jobs/ — ordinary session files. Output path is the script's default.
const RENDER_JOB_STORAGE_KEY = () => `spoolcast:render-job:${activeSession()}`
const RENDER_QUALITY_STORAGE_KEY = () => `spoolcast:render-quality:${activeSession()}`
const RENDER_OUTPUT_PATH = () => `renders/${activeSession()}-1.0x.mp4`
const RENDER_OUTPUT_NAME = () => `${activeSession()}-1.0x.mp4`
const AUDIO_WAVEFORM_SOURCE_BINS = 360
const AUDIO_WAVEFORM_VISIBLE_BARS = 84

type DecodedWaveform = {
  duration: number
  peaks: number[]
}

const decodedWaveformCache = new Map<string, Promise<DecodedWaveform>>()

async function decodeWaveform(src: string): Promise<DecodedWaveform> {
  const cached = decodedWaveformCache.get(src)
  if (cached) return cached
  const pending = (async () => {
    const response = await fetch(src)
    if (!response.ok) throw new Error(`Could not load waveform source (${response.status})`)
    const context = new window.AudioContext()
    try {
      const decoded = await context.decodeAudioData(await response.arrayBuffer())
      const peaks = Array.from({ length: AUDIO_WAVEFORM_SOURCE_BINS }, (_, index) => {
        let peak = 0
        for (let channelIndex = 0; channelIndex < decoded.numberOfChannels; channelIndex += 1) {
          const samples = decoded.getChannelData(channelIndex)
          const start = Math.floor((index / AUDIO_WAVEFORM_SOURCE_BINS) * samples.length)
          const end = Math.max(start + 1, Math.floor(((index + 1) / AUDIO_WAVEFORM_SOURCE_BINS) * samples.length))
          const stride = Math.max(1, Math.floor((end - start) / 180))
          for (let cursor = start; cursor < end; cursor += stride) {
            peak = Math.max(peak, Math.abs(samples[cursor] || 0))
          }
        }
        return peak
      })
      const max = Math.max(0.01, ...peaks)
      return {
        duration: decoded.duration,
        peaks: peaks.map((peak) => peak / max),
      }
    } finally {
      await context.close().catch(() => undefined)
    }
  })()
  decodedWaveformCache.set(src, pending)
  pending.catch(() => decodedWaveformCache.delete(src))
  return pending
}

function visibleWaveform(
  decoded: DecodedWaveform,
  sourceIn = 0,
  sourceOut = decoded.duration,
) {
  const duration = Math.max(0.001, decoded.duration)
  const startRatio = Math.max(0, Math.min(1, sourceIn / duration))
  const endRatio = Math.max(startRatio, Math.min(1, sourceOut / duration))
  const first = Math.floor(startRatio * decoded.peaks.length)
  const last = Math.max(first + 1, Math.ceil(endRatio * decoded.peaks.length))
  const visible = decoded.peaks.slice(first, last)
  return Array.from({ length: AUDIO_WAVEFORM_VISIBLE_BARS }, (_, index) => {
    const start = Math.floor((index / AUDIO_WAVEFORM_VISIBLE_BARS) * visible.length)
    const end = Math.max(start + 1, Math.ceil(((index + 1) / AUDIO_WAVEFORM_VISIBLE_BARS) * visible.length))
    return Math.max(0.02, ...visible.slice(start, end))
  })
}

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
  // Trim window (basic editing): start_from_sec is the renderer contract
  // (OffthreadVideo startFrom); trim_out bounds the slot via timing sync.
  start_from_sec?: number
  trim_in_s?: number
  trim_out_s?: number
  clip_duration_s?: number
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

type FinalCutItem = {
  id: string
  workspace_asset_id?: string
  shot_id?: string
  source_shot_id?: string
  target_shot_id?: string
  worldkit_ref?: string
  source: string
  source_sha?: string
  media_kind?: 'image' | 'video' | 'audio' | 'gap'
  start_s: number
  duration_s: number
  source_in_s: number
  source_out_s: number
  clip_duration_s: number
  muted?: boolean
  audio_detached?: boolean
  volume_pct?: number
  audio_fade_in_s?: number
  audio_fade_out_s?: number
  excluded?: boolean
  locked?: boolean
  manual_move?: boolean
  borrowed?: boolean
  link_group_id?: string
  detached_audio_item_id?: string
  detached_from_item_id?: string
}

type FinalCutLayer = {
  id: string
  kind: 'video' | 'audio'
  label: string
  muted?: boolean
  volume_pct?: number
  locked?: boolean
  custom_label?: boolean
  edit_mode?: 'magnetic' | 'free'
  sync_lock?: boolean
  z_index?: number
  items: FinalCutItem[]
}

type FinalCutWorkspaceAsset = {
  id: string
  shot_id?: string
  source_shot_id?: string
  worldkit_ref?: string
  origin_path?: string
  label?: string
  source: string
  source_sha?: string
  media_kind: 'image' | 'video' | 'audio'
  duration_s?: number
  origin?: string
}

type FinalCutDoc = {
  version: number
  session_id: string
  revision: number
  layers: FinalCutLayer[]
  workspace_assets?: FinalCutWorkspaceAsset[]
  conflicts?: { item_id?: string; shot_id?: string; reason?: string }[]
}

type TimelineHistoryState = {
  undo: number
  redo: number
}

type RenderQuality = 'social' | 'compact' | 'master'

type RenderProfile = {
  id: RenderQuality
  label: string
  description: string
  crf: number
  audio_bitrate: string
  estimated_mbps: number
  estimated_size_mb: number
  default?: boolean
}

type RenderExportRecord = {
  quality?: RenderQuality | string
  quality_label?: string
  compiled_at?: string
  archived_at?: string
  path?: string
  name?: string
  audited?: boolean
  arrangement_revision?: number
  render_fps?: number
  duration_s?: number
  size_bytes?: number
  size_mb?: number
  width?: number
  height?: number
  exists?: boolean
  matches_timeline?: boolean
}

type RenderInfo = {
  arrangement_revision: number
  duration_s: number
  profiles: RenderProfile[]
  current?: RenderExportRecord | null
  history: RenderExportRecord[]
}

type WorldKitVisual = {
  name: string
  kind: string
  notes?: string
  image_path?: string
  media_path?: string
  audio_samples?: {
    id?: string
    path?: string
    duration_s?: number
  }[]
  primary_audio?: string
}

type LayerAttachTarget = {
  id: string
  kind: 'video' | 'audio'
  label: string
}

type WorkspaceDropState = {
  assetId: string
  start: number
  layerId: string
  mode: 'pending' | 'new' | 'free' | 'insert' | 'replace' | 'incompatible'
  replaceItemId?: string
  relativeLayerId?: string
  stackPosition?: 'above' | 'below'
  snapLabel?: string
}

type WorkspacePointerGesture = {
  assetId: string
  startX: number
  startY: number
  dragging: boolean
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

type RecentGenerationTake = {
  path: string
  kind: 'image' | 'video' | 'audio'
  active: boolean
  stamp: string
  mtime?: number
  origin: string
  model?: string
  original_name?: string
}

type RecentGenerationGroup = {
  id: string
  on_board: boolean | null
  takes: RecentGenerationTake[]
}

type GenerationPromptItem = {
  id?: string
  chunk_id?: string
  output_type?: 'image' | 'video' | 'auto'
  prompt?: string
  prompt_variants?: Partial<Record<'image' | 'video', { prompt?: string }>>
}

function AudioFadeEnvelope({
  duration,
  fadeIn,
  fadeOut,
}: {
  duration: number
  fadeIn?: number
  fadeOut?: number
}) {
  const safeDuration = Math.max(0.1, Number(duration || 0))
  const fadeInPct = Math.max(0, Math.min(100, (Number(fadeIn || 0) / safeDuration) * 100))
  const fadeOutPct = Math.max(0, Math.min(100 - fadeInPct, (Number(fadeOut || 0) / safeDuration) * 100))
  if (fadeInPct < 0.1 && fadeOutPct < 0.1) return null
  const fadeOutStart = 100 - fadeOutPct
  const envelopePoints = [
    fadeInPct > 0 ? '0,100' : '0,0',
    `${fadeInPct},0`,
    `${fadeOutStart},0`,
    fadeOutPct > 0 ? '100,100' : '100,0',
  ].join(' ')
  return (
    <svg
      className="vr-audio-fade-envelope"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {fadeInPct > 0 ? <path d={`M 0 100 L ${fadeInPct} 0 L ${fadeInPct} 100 Z`} /> : null}
      {fadeOutPct > 0 ? <path d={`M ${fadeOutStart} 0 L 100 100 L ${fadeOutStart} 100 Z`} /> : null}
      <polyline points={envelopePoints} vectorEffect="non-scaling-stroke" />
    </svg>
  )
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
  /** PERMANENT shot id — what reorder and trim address. */
  pid: string
  /** Seconds into the source clip where playback starts (trim-in). */
  trimIn: number
  trimOut?: number
  clipDuration?: number
  layerId?: string
  layerLabel?: string
  muted?: boolean
  audioDetached?: boolean
  excluded?: boolean
  locked?: boolean
  borrowed?: boolean
  worldKitRef?: string
  linkGroupId?: string
  displayLabel?: string
  sourceLabel?: string
  volumePct?: number
  layerVolumePct?: number
  audioFadeIn?: number
  audioFadeOut?: number
}

type AudioChunk = {
  id: string
  title: string
  start: number
  end: number
  duration?: number
  narration: string
  src: string
  layerId?: string
  muted?: boolean
  excluded?: boolean
  locked?: boolean
  borrowed?: boolean
  sourceIn?: number
  sourceOut?: number
  clipDuration?: number
  linkGroupId?: string
  volumePct?: number
  layerVolumePct?: number
  audioFadeIn?: number
  audioFadeOut?: number
}

type ReviewPanelId = 'video' | 'script' | 'details' | 'gallery' | 'timeline'

export type VisualReviewLayoutCommand = {
  id: number
  action: 'save' | 'reset' | 'undo' | 'redo' | 'sync'
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
  // Full stack height (every slot + lanes) when the drag started — shrinks
  // only start once the row pinches this, not while the column has slack.
  stackStart: number
}

type RowPanelResizePlanData = {
  rowStart: number
  columns: RowPanelResizeColumn[]
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
const workspaceSectionHeightsKey = () => `${activeSession()}:final-cut-workspace-section-heights`
const recentGenerationPreferencesKey = () => `${activeSession()}:final-cut-recent-generation-preferences`

type RecentGenerationSort = 'default' | 'newest' | 'oldest' | 'name'

type WorkspaceSectionHeights = Partial<Record<ReviewLayoutMode, {
  visuals?: number
  audio?: number
}>>

function readWorkspaceSectionHeights(): WorkspaceSectionHeights {
  try {
    const raw = window.localStorage.getItem(workspaceSectionHeightsKey())
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? parsed as WorkspaceSectionHeights : {}
  } catch {
    return {}
  }
}

function readRecentGenerationPreferences(): {
  group: string
  sort: RecentGenerationSort
  types: Array<'image' | 'video' | 'audio'>
} {
  try {
    const raw = window.localStorage.getItem(recentGenerationPreferencesKey())
    const parsed = raw ? JSON.parse(raw) : null
    const sort = ['default', 'newest', 'oldest', 'name'].includes(parsed?.sort)
      ? parsed.sort as RecentGenerationSort
      : 'default'
    const types = Array.isArray(parsed?.types)
      ? parsed.types.filter((kind: string) => ['image', 'video', 'audio'].includes(kind))
      : ['image', 'video', 'audio']
    return {
      group: String(parsed?.group || 'all'),
      sort,
      types: types.length ? types : ['image', 'video', 'audio'],
    }
  } catch {
    return { group: 'all', sort: 'default', types: ['image', 'video', 'audio'] }
  }
}

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

// The Timeline panel may be rearranged from genuine background space without
// stealing clip, scrub, layer-label, menu, or zoom interactions. This restores
// the flexible layout gesture while preventing the former whole-panel drag ghost
// when the user intended to move a clip.
function timelinePanelEmptyDragTarget(target: EventTarget | null) {
  if (!(target instanceof Element) || !target.closest('.vr-timeline-panel')) return false
  return !target.closest([
    'input',
    'button',
    'select',
    'textarea',
    'a',
    'label',
    '[data-no-pan]',
    '.vp-tl-track',
    '.vp-tl-label',
    '.vp-hintbar',
    '.vp-timeline-overview',
    '.vp-seg',
    '.vp-ruler-seg',
  ].join(','))
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

function formatMegabytes(value: number | undefined) {
  if (!Number.isFinite(value)) return ''
  return `${Number(value).toFixed(Number(value) >= 10 ? 0 : 1)} MB`
}

function renderDimensionsForRatio(ratio: number) {
  if (Math.abs(ratio - 1) < 0.02) return { width: 1080, height: 1080 }
  if (Math.abs(ratio - (4 / 5)) < 0.02) return { width: 1080, height: 1350 }
  if (Math.abs(ratio - (9 / 16)) < 0.02) return { width: 1080, height: 1920 }
  if (ratio < 1) return { width: 1080, height: Math.round(1080 / ratio) }
  return { width: 1920, height: Math.round(1920 / ratio) }
}

function readRenderQuality(): RenderQuality {
  try {
    const value = window.localStorage.getItem(RENDER_QUALITY_STORAGE_KEY())
    if (value === 'social' || value === 'compact' || value === 'master') return value
  } catch {
    /* The engine default below is still safe. */
  }
  return 'social'
}

function formatGenerationStamp(stamp: string) {
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(stamp)
  if (!match) return stamp
  const [, year, month, day, hour, minute] = match
  return `${month}/${day}/${year.slice(2)} ${hour}:${minute}`
}

function round3(value: number) {
  return Math.round(value * 1000) / 1000
}

function manifestContentPath(item: SceneManifestItem | undefined) {
  const value = String(item?.local_path || '').trim()
  if (!value) return ''
  const marker = '/spoolcast-content/'
  const index = value.indexOf(marker)
  return index >= 0 ? value.slice(index + marker.length) : value.replace(/^\/+/, '')
}

function contentSrc(path: string, version = '') {
  const clean = path.trim().replace(/^\/+/, '')
  if (!clean) return ''
  const source = contentUrl(clean, 'preview')
  return version
    ? `${source}${source.includes('?') ? '&' : '?'}v=${encodeURIComponent(version)}`
    : source
}

function downloadSrc(path: string, version = '') {
  const clean = path.trim().replace(/^\/+/, '')
  if (!clean) return ''
  const source = downloadUrl(clean)
  return version
    ? `${source}${source.includes('?') ? '&' : '?'}v=${encodeURIComponent(version)}`
    : source
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

function workspaceMediaKindFromPath(path: string): 'image' | 'video' | 'audio' | 'missing' {
  if (/\.(mp3|wav|m4a|aac)$/.test(path.toLowerCase())) return 'audio'
  return mediaKindFromPath(path)
}

function worldKitAudioPath(item: WorldKitVisual) {
  const samples = item.audio_samples ?? []
  const primary = samples.find((sample) => sample.id === item.primary_audio)
  return String(primary?.path || samples[0]?.path || '').trim()
}

function compactLayerLabel(kind: 'video' | 'audio', index: number) {
  return `${kind === 'video' ? 'Vid' : 'Aud'} ${index + 1}`
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

function shortTimelineLabel(value: string, fallback = 'Clip', max = 28) {
  const clean = value.replace(/^workspace:(?:media-|audio-)?/i, '').replace(/[-_:]+/g, ' ').trim()
  if (!clean) return fallback
  return clean.length > max ? `${clean.slice(0, Math.max(1, max - 1)).trimEnd()}…` : clean
}

function workspaceTimelineLabel(asset: FinalCutWorkspaceAsset | undefined, fallback: string) {
  const source = String(asset?.label || fallback || '').trim()
  if (asset?.origin === 'recent-generation') {
    const shot = source.match(/\b[A-Za-z]{1,8}\d+[a-z]?\b/)?.[0]
    return `${shot || 'Previous'} · prev`
  }
  return shortTimelineLabel(source, fallback)
}

function effectiveVolume(volumePct = 100, layerVolumePct = 100) {
  return Math.max(0, Math.min(2, (volumePct / 100) * (layerVolumePct / 100)))
}

function audioFadeGain(localTime: number, duration: number, fadeIn = 0, fadeOut = 0) {
  const safeDuration = Math.max(0, duration)
  const position = Math.max(0, Math.min(safeDuration, localTime))
  const fadeInGain = fadeIn > 0 ? Math.min(1, position / fadeIn) : 1
  const fadeOutGain = fadeOut > 0 ? Math.min(1, (safeDuration - position) / fadeOut) : 1
  return Math.max(0, Math.min(fadeInGain, fadeOutGain))
}

function fitItemAudioFades(item: FinalCutItem) {
  const duration = Math.max(0, Number(item.duration_s || 0))
  const fadeIn = Math.max(0, Number(item.audio_fade_in_s || 0))
  const fadeOut = Math.max(0, Number(item.audio_fade_out_s || 0))
  const total = fadeIn + fadeOut
  if (total <= duration || total === 0) return
  const scale = duration / total
  item.audio_fade_in_s = round3(fadeIn * scale)
  item.audio_fade_out_s = round3(fadeOut * scale)
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
      onPointerDownCapture={draggable ? (event) => {
        const target = event.target as Element
        const startedOnHeader = Boolean(target.closest('summary'))
        const canStartPanelDrag = (
          (startedOnHeader && !dragFromInteractiveControl(event.target))
          || timelinePanelEmptyDragTarget(event.target)
        )
        if (canStartPanelDrag) return
        // Turn dragging off immediately (imperative, before the browser's
        // drag-detection runs on the following mousedown) and mirror it in state so
        // re-renders agree. Panel rearranging is intentionally header-only:
        // media/timeline gestures in the body must never produce a whole-panel
        // browser drag ghost. Restore both on release — imperatively too, so a
        // fast tap that disarms+rearms within one frame can't leave it stuck off.
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

function WorkspaceSection({
  title,
  count,
  unit,
  height,
  onResizeStart,
  onOpenChange,
  children,
}: {
  title: string
  count: number
  unit: string
  height?: number
  onResizeStart?: (event: ReactPointerEvent<HTMLButtonElement>) => void
  onOpenChange?: (open: boolean) => void
  children: ReactNode
}) {
  const [open, setOpen] = useState(count > 0)
  return (
    <details
      className="vr-workspace-section"
      open={open}
      onToggle={(event) => {
        setOpen(event.currentTarget.open)
        onOpenChange?.(event.currentTarget.open)
      }}
    >
      <summary><span>{title}</span><small>{count} {unit}</small></summary>
      <div
        className={`vr-workspace-section-body ${height ? 'is-sized' : ''}`}
        style={height ? { height } : undefined}
      >
        {children}
      </div>
      {open && onResizeStart ? (
        <button
          type="button"
          className="vr-workspace-section-resizer"
          data-no-pan
          aria-label={`Resize ${title} Workspace row`}
          title={`Drag to resize ${title.toLowerCase()} row`}
          onPointerDown={onResizeStart}
        />
      ) : null}
    </details>
  )
}

export function VisualReviewStage({
  stageId,
  layoutCommand,
  onToast,
}: {
  stageId: string
  layoutCommand?: VisualReviewLayoutCommand | null
  onToast?: (message: string) => void
}) {
  const setStepUndo = useWorkflowStore((s) => s.setStepUndo)
  const registerStepAIAction = useWorkflowStore((s) => s.registerStepAIAction)
  const [shotList, setShotList] = useState<ShotList | null>(null)
  // Timeline operations (sync-to-clips / trim / reorder) bump this to
  // re-pull the session files; '' | 'sync' | 'trim' | 'reorder' gates the
  // controls while one runs.
  const [reloadTick, setReloadTick] = useState(0)
  const [timelineBusy, setTimelineBusy] = useState('')
  // VIDEO-FIRST: every clip carries its own sound, so a separate audio-chunk
  // row spanning several clips is a fiction — hide it (a real music track is
  // a future feature).
  const [videoFirstSession, setVideoFirstSession] = useState(false)
  const [sessionModeReady, setSessionModeReady] = useState(false)
  useEffect(() => {
    let live = true
    Promise.all([
      fetch(fileUrl('session.json')).then((r) => (r.ok ? r.json() : null)),
      getJson<{ data?: { templates?: { id?: string; format?: string }[] } }>(templatesUrl()),
    ])
      .then(([sess, reg]) => {
        if (!live || typeof sess?.data?.content !== 'string') return
        const cfg = JSON.parse(sess.data.content)
        const hit = reg?.data?.templates?.find((t) => t.id === String(cfg?.template || ''))
        if (hit?.format === 'video-first' || String(cfg?.shot_medium || '') === 'video') setVideoFirstSession(true)
      })
      .catch(() => { /* engine offline — keep the audio row */ })
      .finally(() => {
        if (live) setSessionModeReady(true)
      })
    return () => { live = false }
  }, [])
  const [finalCut, setFinalCut] = useState<FinalCutDoc | null>(null)
  const [finalCutLoaded, setFinalCutLoaded] = useState(false)
  const [timelineHistoryState, setTimelineHistoryState] = useState<TimelineHistoryState>({ undo: 0, redo: 0 })
  const [timelineHistoryReady, setTimelineHistoryReady] = useState(false)
  const timelineHistoryRef = useRef<(direction: 'undo' | 'redo') => void>(() => {})
  const [worldKitVisuals, setWorldKitVisuals] = useState<WorldKitVisual[]>([])
  const [worldKitOpen, setWorldKitOpen] = useState(false)
  const [attachMenuOpen, setAttachMenuOpen] = useState(false)
  const [attachMenuPosition, setAttachMenuPosition] = useState({ left: 12, top: 12 })
  const [attachTarget, setAttachTarget] = useState<LayerAttachTarget | null>(null)
  const [recentGenerationsOpen, setRecentGenerationsOpen] = useState(false)
  const [recentGenerationLibrary, setRecentGenerationLibrary] = useState<RecentGenerationGroup[] | null>(null)
  const [recentGenerationError, setRecentGenerationError] = useState('')
  const [recentGenerationTarget, setRecentGenerationTarget] = useState<LayerAttachTarget | null>(null)
  const [selectedRecentGenerations, setSelectedRecentGenerations] = useState<Set<string>>(new Set())
  const [recentGenerationGroup, setRecentGenerationGroup] = useState(() => readRecentGenerationPreferences().group)
  const [recentGenerationSort, setRecentGenerationSort] = useState<RecentGenerationSort>(() => readRecentGenerationPreferences().sort)
  const [recentGenerationTypes, setRecentGenerationTypes] = useState<Set<'image' | 'video' | 'audio'>>(
    () => new Set(readRecentGenerationPreferences().types),
  )
  const [worldKitTarget, setWorldKitTarget] = useState<LayerAttachTarget | null>(null)
  const [uploadTarget, setUploadTarget] = useState<LayerAttachTarget | null>(null)
  const [selectedWorldKit, setSelectedWorldKit] = useState<Set<string>>(new Set())
  const [workspaceLayoutMenuOpen, setWorkspaceLayoutMenuOpen] = useState(false)
  const [workspaceLayoutMenuPosition, setWorkspaceLayoutMenuPosition] = useState({ left: 12, top: 12 })
  const [workspaceVisualsOpen, setWorkspaceVisualsOpen] = useState(true)
  const [workspaceContextMenu, setWorkspaceContextMenu] = useState<{
    x: number
    y: number
    assetId: string
  } | null>(null)
  const [workspaceRemoveConfirm, setWorkspaceRemoveConfirm] = useState<{
    assetId: string
    directPlacements: number
    affectedPlacements: number
  } | null>(null)
  const [timelineMenuOpen, setTimelineMenuOpen] = useState(false)
  const [timelineMenuPosition, setTimelineMenuPosition] = useState({ left: 12, top: 12 })
  const [timelineContextMenu, setTimelineContextMenu] = useState<{
    x: number
    y: number
    kind: 'video' | 'audio'
    id: string
  } | null>(null)
  const timelineContextMenuRef = useRef<HTMLDivElement | null>(null)
  const [layerContextMenu, setLayerContextMenu] = useState<{
    x: number
    y: number
    layerId: string
    rename?: boolean
  } | null>(null)
  const [volumeEditor, setVolumeEditor] = useState<{
    kind: 'item' | 'layer'
    id: string
    label: string
    x: number
    y: number
    value: number
    initial: number
  } | null>(null)
  const [audioFadeEditor, setAudioFadeEditor] = useState<{
    id: string
    label: string
    x: number
    y: number
    duration: number
    fadeIn: number
    fadeOut: number
    initialFadeIn: number
    initialFadeOut: number
  } | null>(null)
  const [workspaceDrop, setWorkspaceDropView] = useState<WorkspaceDropState | null>(null)
  const workspaceDropRef = useRef<WorkspaceDropState | null>(null)
  const workspacePointerGestureRef = useRef<WorkspacePointerGesture | null>(null)
  const workspaceSuppressClickRef = useRef(false)
  const commitWorkspaceDrop = useCallback((next: WorkspaceDropState | null) => {
    workspaceDropRef.current = next
    setWorkspaceDropView(next)
  }, [])
  const [selectedTimelineIds, setSelectedTimelineIds] = useState<Set<string>>(new Set())
  const [activeLayerId, setActiveLayerId] = useState('')
  const [draggedLayerId, setDraggedLayerId] = useState('')
  const [clipClipboard, setClipClipboard] = useState<{
    kind: 'video' | 'audio'
    sourceLayerId: string
    items: FinalCutItem[]
  } | null>(null)
  const [timelineUndoNotice, setTimelineUndoNotice] = useState('')
  const [timelineSaveState, setTimelineSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')
  useLayoutEffect(() => {
    const menu = timelineContextMenuRef.current
    if (!menu || !timelineContextMenu) return
    const margin = 12
    const rect = menu.getBoundingClientRect()
    const left = Math.max(margin, Math.min(timelineContextMenu.x, window.innerWidth - rect.width - margin))
    const top = Math.max(margin, Math.min(
      timelineContextMenu.y,
      window.innerHeight - rect.height - margin,
    ))
    menu.style.left = `${left}px`
    menu.style.top = `${top}px`
  }, [timelineContextMenu])
  const [timelineTooltip, setTimelineTooltip] = useState<{ x: number; y: number; text: string } | null>(null)
  const [audioWaveforms, setAudioWaveforms] = useState<Record<string, number[]>>({})
  useEffect(() => {
    if (!sessionModeReady) return
    let live = true
    if (videoFirstSession) {
      void Promise.all([
        postAction<{ final_cut?: FinalCutDoc; history?: TimelineHistoryState }>({ action: 'get_final_cut' }),
        getJson<{ ok?: boolean; data?: { kit?: WorldKitVisual[] } }>(
          apiUrl('source-images', { session: activeSession(), include_refs: 1 }),
        ),
      ]).then(([cut, kit]) => {
        if (!live) return
        if (cut?.ok !== false && cut?.data?.final_cut) setFinalCut(cut.data.final_cut)
        if (cut?.data?.history) setTimelineHistoryState(cut.data.history)
        setWorldKitVisuals((kit?.data?.kit ?? []).filter((item) => (
          Boolean(item.media_path || item.image_path || item.audio_samples?.length)
        )))
      }).finally(() => {
        if (live) {
          setTimelineHistoryReady(true)
          setFinalCutLoaded(true)
        }
      })
    } else {
      void postAction<{ undo_depth?: number; redo_depth?: number }>({
        action: 'get_timeline_history',
      }).then((out) => {
        if (!live || out?.ok === false) return
        setTimelineHistoryState({
          undo: Number(out?.data?.undo_depth || 0),
          redo: Number(out?.data?.redo_depth || 0),
        })
      }).finally(() => {
        if (live) {
          setTimelineHistoryReady(true)
          setFinalCutLoaded(true)
        }
      })
    }
    return () => { live = false }
  }, [reloadTick, sessionModeReady, videoFirstSession])
  const finalCutRevision = finalCut?.revision
  useEffect(() => {
    if (!videoFirstSession || finalCutRevision == null) return
    let live = true
    void postAction<{ history?: TimelineHistoryState }>({
      action: 'get_final_cut_history',
    }).then((out) => {
      if (live && out?.ok !== false && out?.data?.history) {
        setTimelineHistoryState(out.data.history)
      }
    })
    return () => { live = false }
  }, [finalCutRevision, videoFirstSession])
  const [manifest, setManifest] = useState<SceneManifest | null>(null)
  const [promptDoc, setPromptDoc] = useState<GenerationPromptsDoc | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [selectedId, setSelectedId] = useState('')
  const [selectedAudioId, setSelectedAudioId] = useState('')
  const previewReady = Boolean(
    !loading
    && sessionModeReady
    && (!videoFirstSession || (finalCutLoaded && finalCut)),
  )
  useEffect(() => {
    if (!finalCut) return
    const clearTimelineSelection = () => {
      setSelectedTimelineIds((current) => current.size ? new Set() : current)
      setSelectedId('')
      setSelectedAudioId('')
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.closest('.vr-timeline-panel, .vp-menu, .vp-menu-backdrop, .vr-volume-editor')) return
      clearTimelineSelection()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      clearTimelineSelection()
      setTimelineContextMenu(null)
      setLayerContextMenu(null)
      setVolumeEditor(null)
      setWorkspaceContextMenu(null)
      setWorkspaceRemoveConfirm(null)
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [finalCut])
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
  // Workspace opens packed into its current panel; people can still switch to
  // the roomier standard and width-filling views from the existing layout menu.
  const [galleryFit, setGalleryFit] = useState<'normal' | 'width' | 'all'>('all')
  const [galleryFitCols, setGalleryFitCols] = useState<number | null>(null)
  const [workspaceSectionHeights, setWorkspaceSectionHeights] = useState<WorkspaceSectionHeights>(
    () => readWorkspaceSectionHeights(),
  )
  const galleryStripRef = useRef<HTMLDivElement | null>(null)
  const finalCutUploadRef = useRef<HTMLInputElement | null>(null)
  const timelineMenuButtonRef = useRef<HTMLButtonElement | null>(null)
  // Mirror for the sizing pass (its dep list is deliberately minimal).
  const galleryFitRef = useRef<'normal' | 'width' | 'all'>('all')
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
  const [renderInfo, setRenderInfo] = useState<RenderInfo | null>(null)
  const [renderQuality, setRenderQuality] = useState<RenderQuality>(() => readRenderQuality())
  const [renderQualityMenuOpen, setRenderQualityMenuOpen] = useState(false)
  const [renderHistoryMenuOpen, setRenderHistoryMenuOpen] = useState(false)
  const refreshRenderInfo = useCallback(async () => {
    const out = await getJson<{ ok?: boolean; data?: RenderInfo }>(renderInfoUrl())
    if (out?.ok === false || !out?.data) return null
    setRenderInfo(out.data)
    const currentState = useWorkflowStore.getState().finalRender
    if (out.data.current?.matches_timeline && currentState === 'idle') {
      useWorkflowStore.getState().setFinalRender('done')
    } else if (
      out.data.current?.exists
      && !out.data.current.matches_timeline
      && currentState === 'done'
    ) {
      useWorkflowStore.getState().setFinalRender('stale')
    }
    return out.data
  }, [])
  useEffect(() => {
    try {
      window.localStorage.setItem(RENDER_QUALITY_STORAGE_KEY(), renderQuality)
    } catch {
      /* Local preference storage is optional. */
    }
  }, [renderQuality])
  useEffect(() => {
    if (!videoFirstSession || finalCutRevision == null) return
    const timer = window.setTimeout(() => void refreshRenderInfo(), 0)
    return () => window.clearTimeout(timer)
  }, [finalCutRevision, refreshRenderInfo, videoFirstSession])
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
  const finalCutAudioRefs = useRef<Map<string, HTMLAudioElement>>(new Map())
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
  const activeVideoIdsRef = useRef<Set<string>>(new Set())
  const activeFinalCutAudioIdsRef = useRef<Set<string>>(new Set())
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
  const currentWorkspaceSectionHeights = workspaceSectionHeights[layoutMode] ?? {}

  useEffect(() => {
    try {
      window.localStorage.setItem(workspaceSectionHeightsKey(), JSON.stringify(workspaceSectionHeights))
    } catch {
      /* Local view preferences are optional. */
    }
  }, [workspaceSectionHeights])

  useEffect(() => {
    try {
      window.localStorage.setItem(recentGenerationPreferencesKey(), JSON.stringify({
        group: recentGenerationGroup,
        sort: recentGenerationSort,
        types: [...recentGenerationTypes],
      }))
    } catch {
      /* Local picker preferences are optional. */
    }
  }, [recentGenerationGroup, recentGenerationSort, recentGenerationTypes])
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
    // reloadTick: timeline operations (sync/trim/reorder) re-pull the files.
  }, [reloadTick])

  const chunksById = useMemo(
    () => new Map((shotList?.chunks ?? []).map((chunk) => [String(chunk.id || ''), chunk])),
    [shotList],
  )
  const promptsById = useMemo(
    () => new Map((promptDoc?.items ?? []).map((item) => [promptItemId(item), item])),
    [promptDoc],
  )
  const finalCutWorkspaceAssetById = useMemo(
    () => new Map((finalCut?.workspace_assets ?? []).map((asset) => [asset.id, asset])),
    [finalCut],
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
    if (finalCut) {
      const eventByPid = new Map(
        baseEvents.map((event) => [String(event.pacing_image_id || event.id || ''), event]),
      )
      return finalCut.layers
        .filter((layer) => layer.kind === 'video')
        .flatMap((layer) => [...(layer.items ?? [])]
          .filter((item) => item.media_kind !== 'gap')
          .sort((a, b) => Number(a.start_s || 0) - Number(b.start_s || 0))
          .map((item) => {
            const pid = String(item.shot_id || item.id)
            const workspaceAsset = finalCutWorkspaceAssetById.get(String(item.workspace_asset_id || ''))
            const event = eventByPid.get(pid)
            const promptItem = promptsById.get(pid)
            const path = String(item.source || '').replace(new RegExp(`^sessions/${activeSession()}/`), '')
            const start = Number(item.start_s || 0)
            const duration = Math.max(0.1, Number(item.duration_s || 0))
            const mediaType = item.media_kind === 'video' || item.media_kind === 'image'
              ? item.media_kind
              : mediaKindFromPath(path)
            const chunkId = String(event?.chunk_id || '')
            const chunk = chunksById.get(chunkId)
            const sourceLabel = String(workspaceAsset?.label || '').trim()
            const displayLabel = workspaceTimelineLabel(workspaceAsset, String(item.shot_id || item.source_shot_id || pid))
            return {
              id: item.id,
              chunkId,
              title: String(item.worldkit_ref || sourceLabel || event?.summary || chunk?.scene_title || chunk?.summary || pid),
              start,
              end: start + duration,
              duration,
              mediaType,
              mediaSrc: contentSrc(path, String(item.source_sha || '')),
              prompt: String(promptForType(promptItem, mediaType === 'video' ? 'video' : 'image') || event?.video_prompt || event?.prompt || event?.image_prompt || event?.visual_direction || ''),
              firstWord: String(event?.first_word || ''),
              lastWord: String(event?.last_word || ''),
              caption: captionById.get(String(event?.id || pid)) || captionById.get(pid) || '',
              selectedType: mediaType === 'video' ? 'video' as const : 'image' as const,
              generatedDuration: Number(event?.generated_duration_s || 0) || undefined,
              pid,
              trimIn: Number(item.source_in_s || 0),
              trimOut: Number(item.source_out_s || 0) || undefined,
              clipDuration: Number(item.clip_duration_s || 0) || undefined,
              layerId: layer.id,
              layerLabel: layer.label,
              muted: Boolean(layer.muted || item.muted),
              audioDetached: Boolean(item.audio_detached),
              excluded: Boolean(item.excluded),
              locked: Boolean(item.locked),
              borrowed: Boolean(item.borrowed),
              worldKitRef: item.worldkit_ref,
              linkGroupId: item.link_group_id,
              displayLabel,
              sourceLabel: sourceLabel || displayLabel,
              volumePct: Number(item.volume_pct ?? 100),
              layerVolumePct: Number(layer.volume_pct ?? 100),
              audioFadeIn: Number(item.audio_fade_in_s ?? 0),
              audioFadeOut: Number(item.audio_fade_out_s ?? 0),
            }
          }))
    }
    return baseEvents
      .map((event) => {
        const id = String(event.id || event.pacing_image_id || event.chunk_id || '').trim()
        const promptItem = promptsById.get(id)
        const fallbackType = event.image_source === 'generated_video' || mediaKindFromPath(String(event.generated_video_path || event.image_path || '')) === 'video'
          ? 'video'
          : 'image'
        const activeType = selectedMediaType(promptItem, fallbackType)
        // The manifest keys takes by the PERMANENT shot id; the segment id
        // stays positional (timeline/caption keys) on purpose.
        const manifestItem = mediaManifestItem(manifest, String(event.pacing_image_id || '').trim() || id, activeType)
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
          pid: String(event.pacing_image_id || '').trim() || id,
          trimIn: Number(event.start_from_sec || 0) || 0,
          trimOut: Number(event.trim_out_s || 0) || undefined,
          clipDuration: Number(event.clip_duration_s || 0) || undefined,
        }
      })
      .filter((segment) => segment.id)
      .sort((a, b) => a.start - b.start)
  }, [chunksById, finalCut, finalCutWorkspaceAssetById, manifest, promptsById, shotList])

  const totalSec = useMemo(() => Math.max(
    0,
    ...segments.map((segment) => segment.end),
    ...(finalCut?.layers.flatMap((layer) => layer.items.map((item) => (
      Number(item.start_s || 0) + Number(item.duration_s || 0)
    ))) ?? []),
  ), [finalCut, segments])
  const videoLayersTopFirst = useMemo(() => (
    finalCut?.layers
      .filter((layer) => layer.kind === 'video')
      .sort((a, b) => Number(b.z_index || 0) - Number(a.z_index || 0))
    ?? []
  ), [finalCut])
  const audioLayers = useMemo(() => (
    finalCut?.layers.filter((layer) => layer.kind === 'audio') ?? []
  ), [finalCut])
  const workspaceAssets = useMemo<FinalCutWorkspaceAsset[]>(() => {
    if (finalCut?.workspace_assets?.length) return finalCut.workspace_assets
    return segments.map((segment) => ({
      id: `legacy:${segment.id}`,
      shot_id: segment.pid,
      label: segment.pid,
      source: segment.mediaSrc,
      media_kind: segment.mediaType === 'video' ? 'video' : 'image',
      duration_s: segment.duration,
      origin: 'timeline',
    }))
  }, [finalCut, segments])
  const workspaceVisualAssets = useMemo(
    () => workspaceAssets.filter((asset) => asset.media_kind !== 'audio'),
    [workspaceAssets],
  )
  const workspaceAudioAssets = useMemo(
    () => workspaceAssets.filter((asset) => asset.media_kind === 'audio'),
    [workspaceAssets],
  )
  const workspaceVisualsExpanded = workspaceVisualAssets.length > 0 && workspaceVisualsOpen
  const recentGenerationEntries = useMemo(() => (
    (recentGenerationLibrary ?? []).flatMap((group) => (
      group.takes.map((take, takeIndex) => ({
        group,
        take,
        takeIndex,
      }))
    ))
  ), [recentGenerationLibrary])
  const recentGenerationGroupOptions = useMemo(() => (
    (recentGenerationLibrary ?? []).map((group) => group.id)
  ), [recentGenerationLibrary])
  const visibleRecentGenerations = useMemo(() => {
    const compatible = ({ take }: { take: RecentGenerationTake }) => (
      !recentGenerationTarget
      || (recentGenerationTarget.kind === 'audio'
        ? take.kind === 'audio'
        : take.kind === 'image' || take.kind === 'video')
    )
    const filtered = recentGenerationEntries.filter((entry) => {
      if (!compatible(entry) || !recentGenerationTypes.has(entry.take.kind)) return false
      if (recentGenerationGroup === 'current') return entry.group.on_board === true
      if (recentGenerationGroup === 'deleted') return entry.group.on_board === false
      if (recentGenerationGroup !== 'all') return entry.group.id === recentGenerationGroup
      return true
    })
    if (recentGenerationSort === 'default') return filtered
    return [...filtered].sort((a, b) => {
      if (recentGenerationSort === 'newest') return Number(b.take.mtime || 0) - Number(a.take.mtime || 0)
      if (recentGenerationSort === 'oldest') return Number(a.take.mtime || 0) - Number(b.take.mtime || 0)
      return `${a.group.id} ${a.take.original_name || a.take.path}`
        .localeCompare(`${b.group.id} ${b.take.original_name || b.take.path}`)
    })
  }, [
    recentGenerationEntries,
    recentGenerationGroup,
    recentGenerationSort,
    recentGenerationTarget,
    recentGenerationTypes,
  ])
  const recentGenerationAlreadyAttached = useCallback((take: RecentGenerationTake) => (
    workspaceAssets.some((asset) => (
      asset.origin_path === take.path
      || asset.source === take.path
    ))
  ), [workspaceAssets])

  // ---- FINAL-CUT TIMELINE OPERATIONS ------------------------------------
  // Before generation the timeline is an estimate; these snap it to reality.
  const saveFinalCut = async (document: FinalCutDoc, message?: string) => {
    setTimelineSaveState('saving')
    const out = await postAction<{ final_cut?: FinalCutDoc }>({
      action: 'save_final_cut',
      final_cut: document,
      expected_revision: finalCut?.revision ?? document.revision,
    })
    if (!out || out.ok === false || !out.data?.final_cut) {
      setTimelineSaveState('idle')
      throw new Error(out?.error || 'Could not save the final cut.')
    }
    setFinalCut(out.data.final_cut)
    useWorkflowStore.getState().staleFinalRender()
    setTimelineSaveState('saved')
    window.setTimeout(() => setTimelineSaveState('idle'), 1400)
    if (message) onToast?.(message)
    return out.data.final_cut
  }
  const editFinalCut = async (edit: (document: FinalCutDoc) => void, message: string) => {
    if (!finalCut) return
    const next = structuredClone(finalCut)
    edit(next)
    setTimelineBusy('save')
    try {
      await saveFinalCut(next, message)
    } catch (e) {
      setTimelineSaveState('idle')
      onToast?.(e instanceof Error ? e.message : 'Could not save the final cut.')
    } finally {
      setTimelineBusy('')
    }
  }
  const runFinalCutAction = async (
    payload: Record<string, unknown>,
    message?: string,
  ) => {
    setTimelineBusy('save')
    try {
      const out = await postAction<{ final_cut?: FinalCutDoc }>(payload)
      if (!out || out.ok === false || !out.data?.final_cut) {
        throw new Error(out?.error || 'Could not update the final cut.')
      }
      setFinalCut(out.data.final_cut)
      useWorkflowStore.getState().staleFinalRender()
      if (message) onToast?.(message)
      return out.data.final_cut
    } catch (error) {
      onToast?.(error instanceof Error ? error.message : 'Could not update the final cut.')
      return null
    } finally {
      setTimelineBusy('')
    }
  }
  const findFinalCutItem = (document: FinalCutDoc, itemId: string) => {
    for (const layer of document.layers) {
      const item = layer.items.find((candidate) => candidate.id === itemId)
      if (item) return { layer, item }
    }
    return null
  }
  const uniqueFinalCutItemId = (document: FinalCutDoc, base: string) => {
    const ids = new Set(document.layers.flatMap((layer) => layer.items.map((item) => item.id)))
    let serial = 1
    let id = `${base}:copy-${serial}`
    while (ids.has(id)) {
      serial += 1
      id = `${base}:copy-${serial}`
    }
    return id
  }
  const deleteFinalCutItems = async (
    itemIds: Iterable<string>,
    label = 'Clip',
    mode: 'remove' | 'close-gap' | 'leave-gap' = 'remove',
  ) => {
    const requested = new Set(itemIds)
    const ids = new Set(
      finalCut?.layers.flatMap((layer) => (
        layer.locked
          ? []
          : layer.items.filter((item) => requested.has(item.id) && !item.locked).map((item) => item.id)
      )) ?? [],
    )
    if (!ids.size && requested.size) {
      onToast?.('Unlock the selected clip before deleting it.')
      setTimelineContextMenu(null)
      return
    }
    if (!ids.size) return
    setTimelineContextMenu(null)
    if (ids.size === 1) {
      await runFinalCutAction({
        action: 'remove_final_cut_item',
        item_id: [...ids][0],
        mode,
      }, `${label} deleted${mode === 'close-gap' ? ' and the gap was closed' : mode === 'leave-gap' ? '; the gap was kept' : ''}.`)
    } else {
      await editFinalCut((document) => {
        for (const layer of document.layers) {
          if (layer.locked) continue
          layer.items = layer.items.filter((item) => !ids.has(item.id))
        }
      }, `${ids.size} clips deleted from the timeline; files remain in Workspace.`)
    }
    setSelectedTimelineIds(new Set())
    setSelectedId('')
    setSelectedAudioId('')
    setTimelineUndoNotice(`${ids.size === 1 ? label : `${ids.size} clips`} deleted`)
  }
  const duplicateFinalCutItems = async (itemIds: Iterable<string>) => {
    const requested = new Set(itemIds)
    const ids = new Set(
      finalCut?.layers.flatMap((layer) => (
        layer.locked
          ? []
          : layer.items.filter((item) => requested.has(item.id) && !item.locked).map((item) => item.id)
      )) ?? [],
    )
    if (!ids.size && requested.size) {
      onToast?.('Unlock the selected clip before duplicating it.')
      return
    }
    if (!ids.size) return
    const nextSelected: string[] = []
    await editFinalCut((document) => {
      for (const layer of document.layers) {
        if (layer.locked) continue
        const copies = layer.items
          .filter((item) => ids.has(item.id) && !item.locked)
          .sort((a, b) => Number(a.start_s || 0) - Number(b.start_s || 0))
          .map((item) => {
            const copy = structuredClone(item)
            copy.id = uniqueFinalCutItemId(document, item.id)
            copy.start_s = round3(Number(item.start_s || 0) + Number(item.duration_s || 0))
            copy.manual_move = true
            nextSelected.push(copy.id)
            return copy
          })
        layer.items.push(...copies)
      }
    }, `${ids.size === 1 ? 'Clip' : `${ids.size} clips`} duplicated.`)
    if (nextSelected.length) setSelectedTimelineIds(new Set(nextSelected))
  }
  const splitFinalCutItemAtPlayhead = async (itemId: string) => {
    const source = finalCut ? findFinalCutItem(finalCut, itemId) : null
    if (!source || source.layer.locked || source.item.locked) {
      if (source?.item.locked) onToast?.('Unlock the clip before splitting it.')
      return
    }
    const start = Number(source.item.start_s || 0)
    const duration = Number(source.item.duration_s || 0)
    const offset = time - start
    if (offset < 0.2 || offset > duration - 0.2) {
      onToast?.('Move the playhead inside the clip, at least 0.2s from either edge.')
      return
    }
    let rightId = ''
    await editFinalCut((document) => {
      const hit = findFinalCutItem(document, itemId)
      if (!hit) return
      const item = hit.item
      const right = structuredClone(item)
      rightId = uniqueFinalCutItemId(document, `${item.id}:split`)
      right.id = rightId
      right.start_s = round3(time)
      right.source_in_s = round3(Number(item.source_in_s || 0) + offset)
      right.duration_s = round3(duration - offset)
      right.source_out_s = round3(Number(right.source_in_s || 0) + Number(right.duration_s || 0))
      right.manual_move = true
      item.duration_s = round3(offset)
      item.source_out_s = round3(Number(item.source_in_s || 0) + offset)
      item.manual_move = true
      hit.layer.items.push(right)
    }, `Clip split at ${fmtTime(time)}.`)
    if (rightId) setSelectedTimelineIds(new Set([rightId]))
  }
  const copyFinalCutItems = (itemIds: Iterable<string>) => {
    if (!finalCut) return
    const ids = new Set(itemIds)
    const sourceLayer = finalCut.layers.find((layer) => layer.items.some((item) => ids.has(item.id)))
    if (!sourceLayer) return
    const items = sourceLayer.items
      .filter((item) => ids.has(item.id))
      .sort((a, b) => Number(a.start_s || 0) - Number(b.start_s || 0))
      .map((item) => structuredClone(item))
    if (!items.length) return
    setClipClipboard({ kind: sourceLayer.kind, sourceLayerId: sourceLayer.id, items })
    onToast?.(`${items.length} clip${items.length === 1 ? '' : 's'} copied.`)
  }
  const pasteFinalCutItems = async () => {
    if (!finalCut || !clipClipboard?.items.length) return
    const target = finalCut.layers.find((layer) => (
      layer.id === activeLayerId && layer.kind === clipClipboard.kind && !layer.locked
    )) ?? finalCut.layers.find((layer) => (
      layer.id === clipClipboard.sourceLayerId && layer.kind === clipClipboard.kind && !layer.locked
    ))
    if (!target) {
      onToast?.(`Add or unlock a ${clipClipboard.kind} layer before pasting.`)
      return
    }
    const baseStart = Math.min(...clipClipboard.items.map((item) => Number(item.start_s || 0)))
    const nextSelected: string[] = []
    await editFinalCut((document) => {
      const layer = document.layers.find((item) => item.id === target.id)
      if (!layer) return
      for (const source of clipClipboard.items) {
        const copy = structuredClone(source)
        copy.id = uniqueFinalCutItemId(document, source.id)
        copy.locked = false
        copy.start_s = round3(time + Number(source.start_s || 0) - baseStart)
        copy.manual_move = true
        layer.items.push(copy)
        nextSelected.push(copy.id)
      }
    }, `${clipClipboard.items.length} clip${clipClipboard.items.length === 1 ? '' : 's'} pasted at ${fmtTime(time)}.`)
    if (nextSelected.length) setSelectedTimelineIds(new Set(nextSelected))
  }
  const syncClipTiming = async () => {
    setTimelineBusy('sync')
    try {
      if (finalCut) {
        const out = await postAction<{ final_cut?: FinalCutDoc; summary?: { updated?: number; new?: number; conflicts?: number } }>({ action: 'reconcile_final_cut' })
        if (!out || out.ok === false || !out.data?.final_cut) throw new Error(out?.error || 'Could not update the final cut.')
        setFinalCut(out.data.final_cut)
        const summary = out.data.summary
        onToast?.(`Final cut updated · ${summary?.updated ?? 0} changed · ${summary?.new ?? 0} new${summary?.conflicts ? ` · ${summary.conflicts} need review` : ''}`)
        return
      }
      const out = await postAction<{ events_measured?: number; total_duration_s?: number }>({ action: 'sync_clip_timing' })
      if (!out || out.ok === false) throw new Error(out?.error || 'Could not sync the timeline.')
      onToast?.(`Timeline synced to ${out.data?.events_measured ?? 0} real clip(s) · total ${fmtTime(out.data?.total_duration_s || 0)}`)
      setReloadTick((t) => t + 1)
    } catch (e) {
      onToast?.(e instanceof Error ? e.message : 'Could not sync the timeline.')
    } finally {
      setTimelineBusy('')
    }
  }
  const sendTrim = async (seg: ReviewSegment, trimIn: number, trimOut: number, clear = false) => {
    setTimelineBusy('trim')
    try {
      if (finalCut) {
        const next = structuredClone(finalCut)
        const hit = findFinalCutItem(next, seg.id)
        if (!hit) throw new Error('That final-cut item no longer exists.')
        if (hit.layer.locked || hit.item.locked) throw new Error('Unlock the clip before trimming it.')
        const item = hit.item
        const oldIn = Number(item.source_in_s || 0)
        const clip = Number(item.clip_duration_s || seg.clipDuration || 0)
        const outPoint = trimOut || clip
        item.start_s = Math.max(0, Number(item.start_s || 0) + (trimIn - oldIn))
        item.source_in_s = trimIn
        item.source_out_s = outPoint
        item.duration_s = Math.max(0.2, outPoint - trimIn)
        fitItemAudioFades(item)
        const saved = await saveFinalCut(next)
        setFinalCut(saved)
        onToast?.(clear ? `${seg.pid}: full clip restored.` : `${seg.pid}: trim saved in Final cut.`)
        return
      }
      const out = await postAction({ action: 'set_clip_trim', shot_id: seg.pid, trim_in_s: Math.round(trimIn * 10) / 10, trim_out_s: Math.round(trimOut * 10) / 10 })
      if (!out || out.ok === false) throw new Error(out?.error || 'Could not set the trim.')
      onToast?.(clear ? `${seg.pid}: trim cleared — the full clip plays.` : `${seg.pid}: trimmed — timeline re-synced to the real clips.`)
      setReloadTick((t) => t + 1)
    } catch (e) {
      onToast?.(e instanceof Error ? e.message : 'Could not set the trim.')
    } finally {
      setTimelineBusy('')
    }
  }
  const timelineHistory = async (dir: 'undo' | 'redo') => {
    if (!sessionModeReady || !timelineHistoryReady) {
      onToast?.('Timeline history is still loading.')
      return
    }
    if (videoFirstSession && !finalCut) {
      onToast?.('Final Cut is still loading.')
      return
    }
    setTimelineBusy(dir)
    try {
      const out = await postAction<{
        final_cut?: FinalCutDoc
        history?: TimelineHistoryState
        undo_depth?: number
        redo_depth?: number
      }>({
        action: videoFirstSession
          ? (dir === 'undo' ? 'final_cut_undo' : 'final_cut_redo')
          : (dir === 'undo' ? 'timeline_undo' : 'timeline_redo'),
      })
      if (!out || out.ok === false) throw new Error(out?.error || `Nothing to ${dir}.`)
      if (videoFirstSession && out.data?.final_cut) setFinalCut(out.data.final_cut)
      if (out.data?.history) {
        setTimelineHistoryState(out.data.history)
      } else {
        setTimelineHistoryState({
          undo: Number(out.data?.undo_depth || 0),
          redo: Number(out.data?.redo_depth || 0),
        })
      }
      onToast?.(dir === 'undo' ? 'Timeline change undone.' : 'Timeline change redone.')
      setReloadTick((t) => t + 1)
    } catch (e) {
      onToast?.(e instanceof Error ? e.message : `Nothing to ${dir}.`)
    } finally {
      setTimelineBusy('')
    }
  }
  useEffect(() => {
    timelineHistoryRef.current = (direction) => {
      void timelineHistory(direction)
    }
  })
  useEffect(() => {
    setStepUndo({
      stepId: stageId,
      count: timelineHistoryState.undo,
      run: () => timelineHistoryRef.current('undo'),
      redoCount: timelineHistoryState.redo,
      redo: () => timelineHistoryRef.current('redo'),
      busy: !sessionModeReady || !timelineHistoryReady || Boolean(timelineBusy),
    })
    return () => {
      if (useWorkflowStore.getState().stepUndo?.stepId === stageId) setStepUndo(null)
    }
  }, [
    sessionModeReady,
    setStepUndo,
    stageId,
    timelineBusy,
    timelineHistoryReady,
    timelineHistoryState.redo,
    timelineHistoryState.undo,
  ])
  const resetToFullClips = async () => {
    setTimelineBusy('sync')
    try {
      if (finalCut) {
        const out = await postAction<{ final_cut?: FinalCutDoc }>({ action: 'reset_final_cut' })
        if (!out || out.ok === false || !out.data?.final_cut) throw new Error(out?.error || 'Could not reset the final cut.')
        setFinalCut(out.data.final_cut)
        onToast?.('Final cut reset to the full current clips.')
        return
      }
      const out = await postAction<{ events_measured?: number; total_duration_s?: number }>({ action: 'sync_clip_timing', clear_trims: true })
      if (!out || out.ok === false) throw new Error(out?.error || 'Could not reset the timeline.')
      onToast?.(`All trims cleared — every clip plays full length · total ${fmtTime(out.data?.total_duration_s || 0)}`)
      setReloadTick((t) => t + 1)
    } catch (e) {
      onToast?.(e instanceof Error ? e.message : 'Could not reset the timeline.')
    } finally {
      setTimelineBusy('')
    }
  }
  const applyReorder = async (fromPid: string, insertAt: number) => {
    if (finalCut) return
    const current = segments.map((s) => s.pid)
    const order = [...current]
    const fromIdx = order.indexOf(fromPid)
    if (fromIdx < 0) return
    order.splice(fromIdx, 1)
    order.splice(Math.max(0, Math.min(order.length, insertAt)), 0, fromPid)
    if (order.join('|') === current.join('|')) return
    setTimelineBusy('reorder')
    try {
      const out = await postAction({ action: 'reorder_shots', order })
      if (!out || out.ok === false) throw new Error(out?.error || 'Could not reorder the clips.')
      // BOARD IS TRUTH: the plan changed; carry the new order through the
      // existing code-first sync chain (screenplay + shot-list recompile —
      // permanent ids keep every take attached), then snap to real clips.
      const job = await fetch(jobsUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: activeSession(), tenant: 'local', kind: 'update_screenplay', from_plan: true, allow_cost: true }),
      }).then((r) => r.json()).catch(() => null)
      const jobId = String(job?.data?.id || '')
      if (!jobId) throw new Error(job?.message || job?.error || 'Reordered, but the sync job did not start.')
      for (let i = 0; i < 240; i += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 2500))
        const jr = await fetch(jobsUrl(jobId)).then((r) => (r.ok ? r.json() : null)).catch(() => null)
        const status = String(jr?.data?.status || '')
        if (status === 'done') break
        if (status === 'failed') throw new Error(jr?.data?.message || jr?.data?.error || 'Sync failed after the reorder.')
      }
      await postAction({ action: 'sync_clip_timing' }).catch(() => null)
      onToast?.('Clips reordered — the board, script and timeline all follow.')
      setReloadTick((t) => t + 1)
    } catch (e) {
      onToast?.(e instanceof Error ? e.message : 'Could not reorder the clips.')
    } finally {
      setTimelineBusy('')
    }
  }
  const moveFinalCutItem = async (segment: ReviewSegment, start: number) => {
    await runFinalCutAction({
      action: 'move_final_cut_item',
      item_id: segment.id,
      start_s: round3(start),
    }, `${segment.pid}: moved to ${fmtTime(start)}${segment.linkGroupId ? ' with linked media' : ''}.`)
  }
  const reorderFinalCutLayer = async (segment: ReviewSegment, insertAt: number) => {
    await runFinalCutAction({
      action: 'reorder_final_cut_item',
      item_id: segment.id,
      insert_at: insertAt,
    }, `${segment.pid}: reordered on ${segment.layerLabel || 'Vid 1'}${segment.linkGroupId ? ' with linked media' : ''}.`)
  }
  const toggleFinalCutItem = async (segment: ReviewSegment, field: 'muted' | 'excluded') => {
    await editFinalCut((document) => {
      const hit = findFinalCutItem(document, segment.id)
      if (hit && !hit.layer.locked && !hit.item.locked) hit.item[field] = !hit.item[field]
    }, field === 'excluded'
      ? `${segment.pid}: ${segment.excluded ? 'included in' : 'excluded from'} the render.`
      : `${segment.pid}: ${segment.muted ? 'sound restored' : 'muted'}.`)
  }
  const toggleFinalCutAudioItem = async (chunk: AudioChunk, field: 'muted' | 'excluded') => {
    await editFinalCut((document) => {
      const hit = findFinalCutItem(document, chunk.id)
      if (hit && !hit.layer.locked && !hit.item.locked) hit.item[field] = !hit.item[field]
    }, field === 'excluded'
      ? `${chunk.title} audio: ${chunk.excluded ? 'included in' : 'excluded from'} the render.`
      : `${chunk.title} audio: ${chunk.muted ? 'unmuted' : 'muted'}.`)
  }
  const saveAudioPlacement = async (
    chunk: AudioChunk,
    values: { start?: number; sourceIn?: number; sourceOut?: number },
  ) => {
    if (values.start != null && values.sourceIn == null && values.sourceOut == null) {
      await runFinalCutAction({
        action: 'move_final_cut_item',
        item_id: chunk.id,
        start_s: round3(values.start),
      }, `${chunk.title} audio moved${chunk.linkGroupId ? ' with linked media' : ''}.`)
      return
    }
    await editFinalCut((document) => {
      const hit = findFinalCutItem(document, chunk.id)
      if (!hit || hit.layer.locked || hit.item.locked) return
      if (values.start != null) hit.item.start_s = Math.round(Math.max(0, values.start) * 1000) / 1000
      if (values.sourceIn != null) hit.item.source_in_s = Math.round(values.sourceIn * 1000) / 1000
      if (values.sourceOut != null) hit.item.source_out_s = Math.round(values.sourceOut * 1000) / 1000
      hit.item.duration_s = Math.max(0.2, Number(hit.item.source_out_s || 0) - Number(hit.item.source_in_s || 0))
      fitItemAudioFades(hit.item)
      hit.item.manual_move = true
    }, `${chunk.title} audio updated.`)
  }
  const toggleFinalCutLayer = async (layerId: string) => {
    const layer = finalCut?.layers.find((candidate) => candidate.id === layerId)
    await runFinalCutAction({
      action: 'set_final_cut_layer',
      layer_id: layerId,
      muted: !layer?.muted,
    }, `${layer?.label || layerId}: ${layer?.muted ? 'unmuted' : 'muted'}.`)
  }
  const openVolumeEditor = (
    kind: 'item' | 'layer',
    id: string,
    label: string,
    value: number | undefined,
    x: number,
    y: number,
  ) => {
    const nextValue = Math.max(0, Math.min(200, Number(value ?? 100)))
    setTimelineContextMenu(null)
    setLayerContextMenu(null)
    setAudioFadeEditor(null)
    setVolumeEditor({
      kind,
      id,
      label: shortTimelineLabel(label, kind === 'layer' ? 'Layer' : 'Clip', 34),
      x: Math.max(12, Math.min(x, window.innerWidth - 270)),
      y: Math.max(12, Math.min(y, window.innerHeight - 170)),
      value: nextValue,
      initial: nextValue,
    })
  }
  const openAudioFadeEditor = (
    id: string,
    label: string,
    duration: number,
    fadeIn: number | undefined,
    fadeOut: number | undefined,
    x: number,
    y: number,
  ) => {
    const safeDuration = Math.max(0.1, Number(duration || 0))
    const nextFadeIn = Math.max(0, Math.min(safeDuration, Number(fadeIn ?? 0)))
    const nextFadeOut = Math.max(0, Math.min(safeDuration - nextFadeIn, Number(fadeOut ?? 0)))
    setTimelineContextMenu(null)
    setLayerContextMenu(null)
    setVolumeEditor(null)
    setAudioFadeEditor({
      id,
      label: shortTimelineLabel(label, 'Clip', 34),
      x: Math.max(12, Math.min(x, window.innerWidth - 290)),
      y: Math.max(12, Math.min(y, window.innerHeight - 245)),
      duration: safeDuration,
      fadeIn: nextFadeIn,
      fadeOut: nextFadeOut,
      initialFadeIn: nextFadeIn,
      initialFadeOut: nextFadeOut,
    })
  }
  const saveVolumeEditor = async () => {
    const target = volumeEditor
    if (!target) return
    const volume = Math.max(0, Math.min(200, Math.round(target.value)))
    setVolumeEditor(null)
    await runFinalCutAction({
      action: target.kind === 'layer' ? 'set_final_cut_layer' : 'set_final_cut_item',
      [target.kind === 'layer' ? 'layer_id' : 'item_id']: target.id,
      volume_pct: volume,
    }, `${target.label}: volume set to ${volume}%.`)
  }
  const saveAudioFadeEditor = async () => {
    const target = audioFadeEditor
    if (!target) return
    const fadeIn = round3(Math.max(0, Math.min(target.duration, target.fadeIn)))
    const fadeOut = round3(Math.max(0, Math.min(target.duration - fadeIn, target.fadeOut)))
    setAudioFadeEditor(null)
    await runFinalCutAction({
      action: 'set_final_cut_item',
      item_id: target.id,
      audio_fade_in_s: fadeIn,
      audio_fade_out_s: fadeOut,
    }, `${target.label}: audio fade set to ${fadeIn.toFixed(1)}s in, ${fadeOut.toFixed(1)}s out.`)
  }
  const renameFinalCutLayer = async (layerId: string, label: string) => {
    const clean = label.trim().slice(0, 36)
    if (!clean) return
    await editFinalCut((document) => {
      const layer = document.layers.find((candidate) => candidate.id === layerId)
      if (!layer) return
      layer.label = clean
      layer.custom_label = true
    }, `Layer renamed to ${clean}.`)
    setLayerContextMenu(null)
  }
  const toggleFinalCutLayerLock = async (layerId: string) => {
    const layer = finalCut?.layers.find((candidate) => candidate.id === layerId)
    await runFinalCutAction({
      action: 'set_final_cut_layer',
      layer_id: layerId,
      locked: !layer?.locked,
    }, `${layer?.label || layerId}: ${layer?.locked ? 'unlocked' : 'locked'}.`)
  }
  const toggleFinalCutItemLock = async (itemIds: Iterable<string>) => {
    const ids = new Set(itemIds)
    const currentItems = finalCut?.layers.flatMap((layer) => (
      layer.items.filter((item) => ids.has(item.id)).map((item) => ({ layer, item }))
    )) ?? []
    const unlockedLayerItems = currentItems.filter(({ layer }) => !layer.locked)
    if (!unlockedLayerItems.length) {
      onToast?.('Unlock the layer before changing clip locks.')
      return
    }
    const shouldLock = unlockedLayerItems.some(({ item }) => !item.locked)
    await editFinalCut((document) => {
      for (const layer of document.layers) {
        if (layer.locked) continue
        for (const item of layer.items) {
          if (ids.has(item.id)) item.locked = shouldLock
        }
      }
    }, `${ids.size === 1 ? 'Clip' : `${ids.size} clips`} ${shouldLock ? 'locked' : 'unlocked'}.`)
  }
  const clearFinalCutLayer = async (layerId: string) => {
    const layer = finalCut?.layers.find((candidate) => candidate.id === layerId)
    if (!layer || layer.locked || !layer.items.length) return
    await editFinalCut((document) => {
      const next = document.layers.find((candidate) => candidate.id === layerId)
      if (next) next.items = []
    }, `${layer.label}: cleared; files remain in Workspace.`)
    setLayerContextMenu(null)
    setTimelineUndoNotice(`${layer.label} cleared`)
  }
  const deleteFinalCutLayer = async (layerId: string) => {
    const layer = finalCut?.layers.find((candidate) => candidate.id === layerId)
    const primaryVideoId = finalCut?.layers.find((candidate) => candidate.id === 'visuals')?.id
      ?? finalCut?.layers.find((candidate) => candidate.kind === 'video')?.id
    if (!layer || layer.locked || layer.id === primaryVideoId) return
    await editFinalCut((document) => {
      document.layers = document.layers.filter((candidate) => candidate.id !== layerId)
    }, `${layer.label}: layer deleted; files remain in Workspace.`)
    setLayerContextMenu(null)
    setTimelineUndoNotice(`${layer.label} deleted`)
  }
  const reorderFinalCutLayerStack = async (layerId: string, direction: -1 | 1) => {
    const layer = finalCut?.layers.find((candidate) => candidate.id === layerId)
    if (!layer) return
    const sameKind = layer.kind === 'video' ? videoLayersTopFirst : audioLayers
    const current = sameKind.findIndex((candidate) => candidate.id === layerId)
    const target = current + direction
    if (current < 0 || target < 0 || target >= sameKind.length) return
    await runFinalCutAction({
      action: 'reorder_final_cut_layer',
      layer_id: layerId,
      relative_layer_id: sameKind[target].id,
      stack_position: direction < 0 ? 'above' : 'below',
    }, `${layer.label}: layer order updated.`)
  }
  const setFinalCutLayerBehavior = async (
    layerId: string,
    values: { edit_mode?: 'magnetic' | 'free'; sync_lock?: boolean },
    message: string,
  ) => {
    await runFinalCutAction({
      action: 'set_final_cut_layer',
      layer_id: layerId,
      ...values,
    }, message)
    setLayerContextMenu(null)
  }
  const closeFinalCutLayerGaps = async (layerId: string, label: string) => {
    await runFinalCutAction({
      action: 'close_final_cut_gaps',
      layer_id: layerId,
    }, `${label}: visible gaps closed.`)
    setLayerContextMenu(null)
  }
  const linkFinalCutItems = async (itemIds: string[], unlink = false) => {
    if ((!unlink && itemIds.length < 2) || !itemIds.length) return
    await runFinalCutAction({
      action: unlink ? 'unlink_final_cut_items' : 'link_final_cut_items',
      item_ids: itemIds,
    }, unlink ? 'Selected clips unlinked.' : 'Selected clips linked; they now move and ripple together.')
    setTimelineContextMenu(null)
  }
  const moveFinalCutItemToLayer = async (itemId: string, layerId: string, label: string) => {
    await editFinalCut((document) => {
      const hit = findFinalCutItem(document, itemId)
      const target = document.layers.find((layer) => layer.id === layerId)
      if (!hit || !target || hit.layer.locked || hit.item.locked || target.locked || hit.layer.kind !== target.kind || hit.layer.id === target.id) return
      hit.layer.items = hit.layer.items.filter((item) => item.id !== itemId)
      target.items.push(hit.item)
    }, `${label} moved to ${finalCut?.layers.find((layer) => layer.id === layerId)?.label || layerId}.`)
  }
  const addFinalCutLayer = async (kind: 'video' | 'audio') => {
    await editFinalCut((document) => {
      const count = 1 + document.layers.filter((layer) => layer.kind === kind).length
      document.layers.push({
        id: `${kind}-${count}`,
        kind,
        label: `${kind === 'video' ? 'Vid' : 'Aud'} ${count}`,
        muted: false,
        volume_pct: 100,
        locked: false,
        edit_mode: 'free',
        sync_lock: true,
        z_index: kind === 'video'
          ? Math.max(-1, ...document.layers.filter((layer) => layer.kind === 'video').map((layer) => Number(layer.z_index || 0))) + 1
          : 0,
        items: [],
      })
    }, `${kind === 'video' ? 'Vid' : 'Aud'} layer added.`)
  }
  const separateClipAudio = async (source: ReviewSegment) => {
    if (!finalCut) return
    setTimelineBusy('audio')
    try {
      const out = await postAction<{ final_cut?: FinalCutDoc; history?: TimelineHistoryState }>({
        action: 'separate_final_cut_audio',
        item_id: source.id,
      })
      if (!out || out.ok === false || !out.data?.final_cut) throw new Error(out?.error || 'Could not separate the clip audio.')
      setFinalCut(out.data.final_cut)
      if (out.data.history) setTimelineHistoryState(out.data.history)
      useWorkflowStore.getState().staleFinalRender()
      onToast?.(`${source.displayLabel || source.pid}: audio separated and linked below the video.`)
    } catch (e) {
      onToast?.(e instanceof Error ? e.message : 'Could not separate the clip audio.')
    } finally {
      setTimelineBusy('')
    }
  }
  const reattachClipAudio = async (source: ReviewSegment) => {
    if (!finalCut) return
    setTimelineBusy('audio')
    try {
      const out = await postAction<{ final_cut?: FinalCutDoc; history?: TimelineHistoryState }>({
        action: 'reattach_final_cut_audio',
        item_id: source.id,
      })
      if (!out || out.ok === false || !out.data?.final_cut) throw new Error(out?.error || 'Could not reattach the clip audio.')
      setFinalCut(out.data.final_cut)
      if (out.data.history) setTimelineHistoryState(out.data.history)
      useWorkflowStore.getState().staleFinalRender()
      onToast?.(`${source.displayLabel || source.pid}: embedded audio restored; the reusable Aud file remains in Workspace.`)
    } catch (e) {
      onToast?.(e instanceof Error ? e.message : 'Could not reattach the clip audio.')
    } finally {
      setTimelineBusy('')
    }
  }
  async function placeWorkspaceAsset(
    assetId: string,
    start: number,
    layerId = '',
    showToast = true,
    intent: 'place' | 'insert' | 'replace' = 'place',
    options: {
      replaceItemId?: string
      relativeLayerId?: string
      stackPosition?: 'above' | 'below'
    } = {},
  ) {
    setTimelineBusy('place')
    try {
      const out = await postAction<{ final_cut?: FinalCutDoc }>({
        action: 'place_workspace_asset',
        asset_id: assetId,
        start_s: start,
        duration_s: workspaceAssets.find((asset) => asset.id === assetId)?.media_kind === 'image' ? 10 : undefined,
        layer_id: layerId || undefined,
        intent,
        replace_item_id: options.replaceItemId,
        relative_layer_id: options.relativeLayerId,
        stack_position: options.stackPosition,
      })
      if (!out || out.ok === false || !out.data?.final_cut) throw new Error(out?.error || 'Could not place the Workspace item.')
      setFinalCut(out.data.final_cut)
      useWorkflowStore.getState().staleFinalRender()
      if (showToast) {
        const asset = workspaceAssets.find((item) => item.id === assetId)
        const targetKind = asset?.media_kind === 'audio' ? 'audio' : 'video'
        const target = layerId
          ? out.data.final_cut.layers.find((layer) => layer.id === layerId)
          : [...out.data.final_cut.layers].reverse().find((layer) => (
            layer.kind === targetKind
            && layer.items.some((item) => item.workspace_asset_id === assetId)
          ))
        onToast?.(`${intent === 'replace' ? 'Replaced clip' : intent === 'insert' ? 'Inserted' : 'Placed'} at ${fmtTime(start)} on ${target?.label || 'a new layer'}.`)
      }
      return out.data.final_cut
    } catch (error) {
      onToast?.(error instanceof Error ? error.message : 'Could not place the Workspace item.')
      return null
    } finally {
      setTimelineBusy('')
      commitWorkspaceDrop(null)
    }
  }
  const loadRecentGenerationLibrary = async () => {
    setRecentGenerationError('')
    setRecentGenerationLibrary(null)
    try {
      const out = await getJson<{ data?: { library?: RecentGenerationGroup[] } }>(
        apiUrl('asset-library', { session: activeSession(), include_audio: 1 }),
      )
      const library = out?.data?.library
      if (!Array.isArray(library)) throw new Error('Could not load recent generations.')
      setRecentGenerationLibrary(library)
      setRecentGenerationGroup((current) => (
        ['all', 'current', 'deleted'].includes(current)
        || library.some((group) => group.id === current)
          ? current
          : 'all'
      ))
    } catch (error) {
      setRecentGenerationLibrary([])
      setRecentGenerationError(error instanceof Error ? error.message : 'Could not load recent generations.')
    }
  }
  const openRecentGenerations = (target: LayerAttachTarget | null) => {
    setAttachMenuOpen(false)
    setAttachTarget(null)
    setRecentGenerationTarget(target)
    setSelectedRecentGenerations(new Set())
    setRecentGenerationsOpen(true)
    void loadRecentGenerationLibrary()
  }
  const closeRecentGenerations = () => {
    setRecentGenerationsOpen(false)
    setRecentGenerationTarget(null)
    setSelectedRecentGenerations(new Set())
    setRecentGenerationError('')
  }
  const toggleRecentGenerationType = (kind: 'image' | 'video' | 'audio') => {
    if (
      recentGenerationTarget
      && ((recentGenerationTarget.kind === 'audio') !== (kind === 'audio'))
    ) return
    setRecentGenerationTypes((current) => {
      const next = new Set(current)
      if (next.has(kind)) next.delete(kind)
      else next.add(kind)
      return next
    })
  }
  const attachSelectedRecentGenerations = async () => {
    const selected = recentGenerationEntries.filter(({ take }) => (
      selectedRecentGenerations.has(take.path)
      && !recentGenerationAlreadyAttached(take)
      && (!recentGenerationTarget || (
        recentGenerationTarget.kind === 'audio'
          ? take.kind === 'audio'
          : take.kind === 'image' || take.kind === 'video'
      ))
    ))
    if (!selected.length) return
    setTimelineBusy('recent')
    setRecentGenerationError('')
    try {
      let placementTime = time
      let attachedCount = 0
      for (const { group, take } of selected) {
        const label = take.active
          ? group.id
          : `${group.id} · ${formatGenerationStamp(take.stamp)}`
        const attached = await postAction<{ final_cut?: FinalCutDoc; asset?: FinalCutWorkspaceAsset }>({
          action: 'attach_workspace_media',
          path: take.path,
          label,
          origin: 'recent-generation',
        })
        if (!attached || attached.ok === false || !attached.data?.final_cut || !attached.data?.asset?.id) {
          throw new Error(attached?.error || `Could not attach ${label}.`)
        }
        let latest = attached.data.final_cut
        const asset = attached.data.asset
        attachedCount += 1
        if (recentGenerationTarget) {
          const placed = await postAction<{ final_cut?: FinalCutDoc }>({
            action: 'place_workspace_asset',
            asset_id: asset.id,
            start_s: placementTime,
            duration_s: take.kind === 'image' ? 10 : undefined,
            layer_id: recentGenerationTarget.id,
            insert_mode: false,
          })
          if (!placed || placed.ok === false || !placed.data?.final_cut) {
            throw new Error(placed?.error || `Could not place ${label} on ${recentGenerationTarget.label}.`)
          }
          latest = placed.data.final_cut
          placementTime += take.kind === 'image'
            ? 10
            : Math.max(0.2, Number(asset.duration_s || 0))
          useWorkflowStore.getState().staleFinalRender()
        }
        setFinalCut(latest)
      }
      onToast?.(
        recentGenerationTarget
          ? `${attachedCount} generation${attachedCount === 1 ? '' : 's'} added to Workspace and placed on ${recentGenerationTarget.label}.`
          : `${attachedCount} generation${attachedCount === 1 ? '' : 's'} added to Workspace.`,
      )
      closeRecentGenerations()
    } catch (error) {
      setRecentGenerationError(error instanceof Error ? error.message : 'Could not attach the selected generations.')
    } finally {
      setTimelineBusy('')
    }
  }
  const attachWorldKitToWorkspace = async (
    item: WorldKitVisual,
    target: LayerAttachTarget | null,
  ) => {
    const path = target?.kind === 'audio'
      ? worldKitAudioPath(item)
      : item.media_path || item.image_path || ''
    if (!path) return false
    setTimelineBusy('worldkit')
    try {
      const out = await postAction<{ final_cut?: FinalCutDoc; asset?: { id?: string } }>({
        action: 'attach_workspace_visual',
        ref_id: item.name,
        path,
      })
      if (!out || out.ok === false || !out.data?.final_cut) throw new Error(out?.error || 'Could not attach the World Kit visual.')
      setFinalCut(out.data.final_cut)
      const assetId = String(out.data.asset?.id || '')
      if (target && assetId) {
        const placed = await placeWorkspaceAsset(assetId, time, target.id, false, 'place')
        if (!placed) return false
        onToast?.(`${item.name} attached to the Workspace and placed on ${target.label}.`)
      } else {
        onToast?.(`${item.name} attached to the Workspace. Drag it onto the timeline when you want to use it.`)
      }
      return true
    } catch (e) {
      onToast?.(e instanceof Error ? e.message : 'Could not attach the World Kit visual.')
      return false
    } finally {
      setTimelineBusy('')
    }
  }
  const attachSelectedWorldKit = async () => {
    const items = worldKitVisuals.filter((item) => (
      selectedWorldKit.has(item.name)
      && (worldKitTarget?.kind === 'audio'
        ? Boolean(worldKitAudioPath(item))
        : Boolean(item.media_path || item.image_path))
    ))
    if (!items.length) return
    for (const item of items) await attachWorldKitToWorkspace(item, worldKitTarget)
    setSelectedWorldKit(new Set())
    setWorldKitOpen(false)
    setWorldKitTarget(null)
  }
  const uploadWorkspaceAsset = async (file: File | undefined) => {
    if (!file) return
    setTimelineBusy('upload')
    try {
      const out = await uploadFinalCutAsset(file)
      const document = out?.data?.final_cut as FinalCutDoc | undefined
      const assetId = String(out?.data?.asset?.id || '')
      if (!out || out.ok === false || !document) throw new Error(out?.error || 'Could not attach that file.')
      setFinalCut(document)
      if (uploadTarget && assetId) {
        const placed = await placeWorkspaceAsset(assetId, time, uploadTarget.id, false, 'place')
        if (placed) onToast?.(`${file.name} attached to the Workspace and placed on ${uploadTarget.label}.`)
      } else {
        onToast?.(`${file.name} attached to the Workspace. Drag it onto the timeline when you want to use it.`)
      }
    } catch (error) {
      onToast?.(error instanceof Error ? error.message : 'Could not attach that file.')
    } finally {
      setTimelineBusy('')
      setUploadTarget(null)
      if (finalCutUploadRef.current) finalCutUploadRef.current.value = ''
    }
  }
  useEffect(() => {
    if (!finalCut) return
    const onTimelineKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      const ids = selectedTimelineIds.size
        ? [...selectedTimelineIds]
        : [selectedId || selectedAudioId].filter(Boolean)
      if ((event.key === 'Delete' || event.key === 'Backspace') && ids.length) {
        event.preventDefault()
        void deleteFinalCutItems(ids, ids.length === 1 ? 'Clip' : `${ids.length} clips`)
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c' && ids.length) {
        event.preventDefault()
        copyFinalCutItems(ids)
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v' && clipClipboard) {
        event.preventDefault()
        void pasteFinalCutItems()
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd' && ids.length) {
        event.preventDefault()
        void duplicateFinalCutItems(ids)
      }
    }
    window.addEventListener('keydown', onTimelineKey)
    return () => window.removeEventListener('keydown', onTimelineKey)
  })
  useEffect(() => {
    if (!layoutCommand || layoutCommand.id === lastLayoutCommandIdRef.current) return
    lastLayoutCommandIdRef.current = layoutCommand.id
    const timer = window.setTimeout(() => {
      if (layoutCommand.action === 'save') saveCurrentLayoutDefault()
      else if (layoutCommand.action === 'reset') resetCurrentLayoutDefault()
      else if (layoutCommand.action === 'undo') void timelineHistory('undo')
      else if (layoutCommand.action === 'redo') void timelineHistory('redo')
      else void syncClipTiming()
    }, 0)
    return () => window.clearTimeout(timer)
    // Timeline commands intentionally use the render that received this
    // command id. Adding their non-memoized handlers would cancel the queued
    // command after the id had already been consumed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutCommand, resetCurrentLayoutDefault, saveCurrentLayoutDefault])

  // ---- TIMELINE POINTER GESTURES (CapCut-style) -------------------------
  // Grab a clip's EDGE to trim it (left = start, right = end), grab its
  // BODY and drag to reorder (an insertion line shows where it lands).
  // Pointer-based, not HTML5 drag — the track's scrubber ate dragstart.
  type TimelineGesture = {
    mode: 'in' | 'out' | 'move'
    segment: ReviewSegment
    startX: number
    trackEl: HTMLElement
    started: boolean
    reorder: boolean
    view: {
      dIn: number
      dOut: number
      dStart: number
      insertAt: number
      snapLabel: string
      collision: boolean
    }
  }
  const gestureRef = useRef<TimelineGesture | null>(null)
  const [gestureView, setGestureView] = useState<{
    id: string
    mode: string
    reorder: boolean
    dIn: number
    dOut: number
    dStart: number
    insertAt: number
    snapLabel: string
    collision: boolean
  } | null>(null)
  const segmentsRef = useRef(segments)
  useEffect(() => {
    segmentsRef.current = segments
  }, [segments])
  const suppressClickRef = useRef(false)
  const selectTimelineItem = (
    itemId: string,
    kind: 'video' | 'audio',
    layerId: string,
    additive = false,
  ) => {
    setSelectedTimelineIds((current) => {
      if (!additive) return new Set([itemId])
      const next = new Set(current)
      if (next.has(itemId)) next.delete(itemId)
      else next.add(itemId)
      return next
    })
    setActiveLayerId(layerId)
    if (kind === 'video') {
      setSelectedId(itemId)
      setSelectedAudioId('')
    } else {
      setSelectedAudioId(itemId)
      setSelectedId('')
    }
  }
  const autoScrollTimeline = (clientX: number, trackEl: HTMLElement) => {
    const scroller = trackEl.closest<HTMLElement>('.vp-timeline-scroll')
    if (!scroller) return
    const rect = scroller.getBoundingClientRect()
    const edge = 52
    if (clientX < rect.left + edge) scroller.scrollLeft -= 18
    else if (clientX > rect.right - edge) scroller.scrollLeft += 18
  }
  const onGestureMove = useCallback((e: PointerEvent) => {
    const g = gestureRef.current
    if (!g) return
    const dx = e.clientX - g.startX
    const rect = g.trackEl.getBoundingClientRect()
    const total = Math.max(0.001, ...segmentsRef.current.map((s) => s.end))
    autoScrollTimeline(e.clientX, g.trackEl)
    if (g.mode === 'move') {
      if (!g.started && Math.abs(dx) < 6) return
      g.started = true
      if (g.reorder) {
        const peers = segmentsRef.current
          .filter((segment) => segment.layerId === g.segment.layerId && segment.id !== g.segment.id)
          .sort((a, b) => a.start - b.start)
        const secondsPerPx = total / Math.max(1, rect.width)
        const rawMidpoint = Math.max(
          0,
          Math.min(total, g.segment.start + dx * secondsPerPx + g.segment.duration / 2),
        )
        // Reordering is decided by the dragged clip's midpoint. The first and
        // last candidates sit at the timeline ends; between clips, the target
        // is halfway through the gap between their adjoining edges.
        const boundaries = peers.length
          ? [
              {
                at: Math.max(0, peers[0].start),
                insertAt: 0,
                label: `Insert before ${peers[0].pid}`,
              },
              ...peers.slice(1).map((next, index) => {
                const previous = peers[index]
                return {
                  at: (previous.end + next.start) / 2,
                  insertAt: index + 1,
                  label: `Insert between ${previous.pid} and ${next.pid}`,
                }
              }),
              {
                at: Math.min(total, peers[peers.length - 1].end),
                insertAt: peers.length,
                label: `Insert after ${peers[peers.length - 1].pid}`,
              },
            ]
          : [{ at: 0, insertAt: 0, label: 'Insert at start' }]
        const nearest = boundaries
          .map((boundary) => ({ ...boundary, distance: Math.abs(boundary.at - rawMidpoint) }))
          .sort((a, b) => a.distance - b.distance)[0]
        const snapThreshold = secondsPerPx * 14
        const displayedMidpoint = nearest.distance <= snapThreshold ? nearest.at : rawMidpoint
        g.view.insertAt = nearest.insertAt
        g.view.dStart = displayedMidpoint - g.segment.start - g.segment.duration / 2
        g.view.snapLabel = nearest.label
        g.view.collision = false
      } else if (g.segment.layerId) {
        const rawStart = Math.max(0, g.segment.start + dx * (total / Math.max(1, rect.width)))
        const peers = segmentsRef.current.filter((segment) => (
          segment.layerId === g.segment.layerId && segment.id !== g.segment.id
        ))
        const allPeers = segmentsRef.current.filter((segment) => segment.id !== g.segment.id)
        const snapStarts = [
          { at: 0, label: 'Timeline start' },
          { at: timelineTimeRef.current, label: 'Start to playhead' },
          { at: timelineTimeRef.current - g.segment.duration, label: 'End to playhead' },
          ...Array.from({ length: Math.floor(total / 5) }, (_, index) => ({
            at: (index + 1) * 5,
            label: `Start to ${(index + 1) * 5}s`,
          })),
          ...allPeers.flatMap((segment) => [
            { at: segment.start, label: `Start to ${segment.pid} start` },
            { at: segment.end, label: `Start to ${segment.pid} end` },
            { at: segment.start - g.segment.duration, label: `End to ${segment.pid} start` },
            { at: segment.end - g.segment.duration, label: `End to ${segment.pid} end` },
          ]),
        ]
        const snapThreshold = total / Math.max(1, rect.width) * 12
        const nearest = snapStarts
          .map((point) => ({ ...point, at: Math.max(0, point.at), distance: Math.abs(Math.max(0, point.at) - rawStart) }))
          .sort((a, b) => a.distance - b.distance)[0]
        const snappedStart = nearest && nearest.distance <= snapThreshold ? nearest.at : rawStart
        g.view.dStart = snappedStart - g.segment.start
        g.view.snapLabel = nearest && nearest.distance <= snapThreshold ? `Snapped · ${nearest.label}` : ''
        const end = snappedStart + g.segment.duration
        g.view.collision = peers.some((segment) => snappedStart < segment.end && end > segment.start)
        if (g.view.collision) g.view.snapLabel = g.view.snapLabel ? `${g.view.snapLabel} · overlaps` : 'Overlaps another clip'
      } else {
        const t = ((e.clientX - rect.left) / Math.max(1, rect.width)) * total
        g.view.insertAt = segmentsRef.current.filter((s) => (s.start + s.end) / 2 < t).length
      }
    } else {
      g.started = true
      const dSec = dx * (total / Math.max(1, rect.width))
      const seg = g.segment
      const clip = seg.clipDuration || 0
      if (g.mode === 'in') {
        // The start handle lives between 0 and (end-trim − 0.2s).
        const upper = (seg.trimOut || clip || seg.trimIn + seg.duration) - 0.2
        g.view.dIn = Math.max(-seg.trimIn, Math.min(dSec, upper - seg.trimIn))
      } else {
        // The end handle lives between (start-trim + 0.2s) and the clip's
        // FULL length — a slot can never outgrow its source video.
        const base = seg.trimOut || clip || seg.trimIn + seg.duration
        let bounded = dSec
        if (clip) bounded = Math.min(bounded, clip - base)
        g.view.dOut = Math.max(bounded, seg.trimIn + 0.2 - base)
      }
    }
    setGestureView({ id: g.segment.id, mode: g.mode, reorder: g.reorder, ...g.view })
  }, [])
  const onGestureUp = () => {
    const g = gestureRef.current
    gestureRef.current = null
    window.removeEventListener('pointermove', onGestureMove)
    setGestureView(null)
    if (!g || !g.started) return
    suppressClickRef.current = true
    window.setTimeout(() => { suppressClickRef.current = false }, 250)
    const seg = g.segment
    if (g.mode === 'move') {
      if (g.reorder && g.view.insertAt >= 0) void reorderFinalCutLayer(seg, g.view.insertAt)
      else if (seg.layerId) void moveFinalCutItem(seg, seg.start + g.view.dStart)
      else if (g.view.insertAt >= 0) void applyReorder(seg.pid, g.view.insertAt)
      return
    }
    const clip = seg.clipDuration || seg.trimIn + seg.duration
    if (g.mode === 'in') {
      const upper = (seg.trimOut || clip) - 0.2
      const trimIn = Math.max(0, Math.min(upper, seg.trimIn + g.view.dIn))
      void sendTrim(seg, trimIn, seg.trimOut || 0, trimIn === 0 && !seg.trimOut)
    } else {
      const base = seg.trimOut || clip
      let trimOut = Math.max(seg.trimIn + 0.2, Math.min(clip, base + g.view.dOut))
      if (trimOut >= clip - 0.05) trimOut = 0 // dragged back to full length = no out-trim
      void sendTrim(seg, seg.trimIn, trimOut, trimOut === 0 && seg.trimIn === 0)
    }
  }
  const beginTimelineGesture = (e: ReactPointerEvent, segment: ReviewSegment, mode: 'in' | 'out' | 'move') => {
    if (timelineBusy) return
    // A secondary press must stay owned by the clip. If it bubbles into the
    // track scrubber, the track captures the pointer and Chrome retargets the
    // later contextmenu event to the background, producing its native menu.
    if (e.button !== 0) {
      if (e.button === 2) e.stopPropagation()
      return
    }
    if (mode !== 'move' && segment.mediaType !== 'video') return
    selectTimelineItem(
      segment.id,
      'video',
      segment.layerId || '',
      e.shiftKey || e.metaKey || e.ctrlKey,
    )
    const sourceLayer = finalCut?.layers.find((layer) => layer.id === segment.layerId)
    if (sourceLayer?.locked || segment.locked) {
      onToast?.(sourceLayer?.locked ? `${sourceLayer.label} is locked.` : `${segment.pid} is locked.`)
      return
    }
    e.stopPropagation()
    e.preventDefault()
    const trackEl = (e.currentTarget as HTMLElement).closest('.vp-tl-track') as HTMLElement | null
    if (!trackEl) return
    const reorder = mode === 'move' && sourceLayer?.edit_mode === 'magnetic'
    gestureRef.current = {
      mode,
      segment,
      startX: e.clientX,
      trackEl,
      started: mode !== 'move',
      reorder,
      view: { dIn: 0, dOut: 0, dStart: 0, insertAt: -1, snapLabel: '', collision: false },
    }
    setActiveLayerId(segment.layerId || '')
    if (mode !== 'move') setGestureView({
      id: segment.id,
      mode,
      reorder,
      dIn: 0,
      dOut: 0,
      dStart: 0,
      insertAt: -1,
      snapLabel: '',
      collision: false,
    })
    window.addEventListener('pointermove', onGestureMove)
    window.addEventListener('pointerup', onGestureUp, { once: true })
  }

  const audioChunks = useMemo<AudioChunk[]>(() => {
    if (finalCut) {
      const shotTitles = new Map(segments.map((segment) => [segment.pid, segment.title]))
      return finalCut.layers
        .filter((layer) => layer.kind === 'audio')
        .flatMap((layer) => (layer.items ?? []).map((item) => {
          const start = Number(item.start_s || 0)
          const sourceShot = String(item.source_shot_id || '')
          const workspaceAsset = finalCutWorkspaceAssetById.get(String(item.workspace_asset_id || ''))
          return {
            id: item.id,
            title: String(workspaceAsset?.label || sourceShot || shotTitles.get(sourceShot) || shortTimelineLabel(item.id, 'Audio')),
            start,
            end: start + Math.max(0.1, Number(item.duration_s || 0)),
            duration: Math.max(0.1, Number(item.duration_s || 0)),
            narration: '',
            src: downloadSrc(String(item.source || ''), String(item.source_sha || '')),
            layerId: layer.id,
            muted: Boolean(layer.muted || item.muted),
            excluded: Boolean(item.excluded),
            locked: Boolean(item.locked),
            borrowed: Boolean(item.borrowed),
            sourceIn: Number(item.source_in_s || 0),
            sourceOut: Number(item.source_out_s || 0),
            clipDuration: Number(item.clip_duration_s || 0),
            linkGroupId: item.link_group_id,
            volumePct: Number(item.volume_pct ?? 100),
            layerVolumePct: Number(layer.volume_pct ?? 100),
            audioFadeIn: Number(item.audio_fade_in_s ?? 0),
            audioFadeOut: Number(item.audio_fade_out_s ?? 0),
          }
        }))
        .sort((a, b) => a.start - b.start)
    }
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
  }, [finalCut, finalCutWorkspaceAssetById, segments, shotList])
  useEffect(() => {
    const sources = [
      ...audioChunks
        .filter((chunk) => chunk.src)
        .map((chunk) => ({
          id: chunk.id,
          src: chunk.src,
          sourceIn: Number(chunk.sourceIn || 0),
          sourceOut: Number(chunk.sourceOut || 0),
          duration: Number(chunk.duration || chunk.end - chunk.start),
        })),
      ...segments
        .filter((segment) => (
          finalCut
          && segment.mediaType === 'video'
          && !segment.audioDetached
          && Boolean(segment.mediaSrc)
        ))
        .map((segment) => ({
          id: segment.id,
          src: segment.mediaSrc,
          sourceIn: Number(segment.trimIn || 0),
          sourceOut: Number(segment.trimOut || 0),
          duration: Number(segment.duration),
        })),
    ]
    if (!sources.length || typeof window.AudioContext === 'undefined') return
    let live = true
    void (async () => {
      const rows: { id: string; peaks: number[] }[] = []
      for (const source of sources) {
        try {
          const decoded = await decodeWaveform(source.src)
          const sourceIn = source.sourceIn
          const sourceOut = source.sourceOut > sourceIn
            ? source.sourceOut
            : sourceIn + source.duration
          rows.push({
            id: source.id,
            peaks: visibleWaveform(decoded, sourceIn, sourceOut),
          })
        } catch {
          /* The clip still works when a browser cannot decode its waveform. */
        }
      }
      if (!live) return
      setAudioWaveforms((current) => {
        const next = { ...current }
        for (const row of rows) next[row.id] = row.peaks
        return next
      })
    })()
    return () => {
      live = false
    }
  }, [audioChunks, finalCut, segments])

  type AudioTimelineGesture = {
    mode: 'in' | 'out' | 'move'
    chunk: AudioChunk
    startX: number
    trackEl: HTMLElement
    started: boolean
    dStart: number
    dIn: number
    dOut: number
    snapLabel: string
    collision: boolean
  }
  const audioGestureRef = useRef<AudioTimelineGesture | null>(null)
  const [audioGestureView, setAudioGestureView] = useState<{
    id: string
    mode: AudioTimelineGesture['mode']
    dStart: number
    dIn: number
    dOut: number
    snapLabel: string
    collision: boolean
  } | null>(null)
  const onAudioGestureMove = useCallback((event: PointerEvent) => {
    const gesture = audioGestureRef.current
    if (!gesture) return
    const dx = event.clientX - gesture.startX
    if (!gesture.started && Math.abs(dx) < 6) return
    gesture.started = true
    const rect = gesture.trackEl.getBoundingClientRect()
    autoScrollTimeline(event.clientX, gesture.trackEl)
    const dSec = dx * (Math.max(0.001, totalSec) / Math.max(1, rect.width))
    const chunk = gesture.chunk
    if (gesture.mode === 'move') {
      const rawStart = Math.max(0, chunk.start + dSec)
      const peers = audioChunks.filter((item) => item.layerId === chunk.layerId && item.id !== chunk.id)
      const duration = chunk.duration || chunk.end - chunk.start
      const allEdges = [
        ...segments.flatMap((item) => [
          { at: item.start, label: `${item.pid} start` },
          { at: item.end, label: `${item.pid} end` },
        ]),
        ...audioChunks.filter((item) => item.id !== chunk.id).flatMap((item) => [
          { at: item.start, label: `${item.title} start` },
          { at: item.end, label: `${item.title} end` },
        ]),
      ]
      const points = [
        { at: 0, label: 'Timeline start' },
        { at: timelineTimeRef.current, label: 'Start to playhead' },
        { at: timelineTimeRef.current - duration, label: 'End to playhead' },
        ...Array.from({ length: Math.floor(totalSec / 5) }, (_, index) => ({
          at: (index + 1) * 5,
          label: `Start to ${(index + 1) * 5}s`,
        })),
        ...allEdges.flatMap((edge) => [
          { at: edge.at, label: `Start to ${edge.label}` },
          { at: edge.at - duration, label: `End to ${edge.label}` },
        ]),
      ]
      const threshold = Math.max(0.001, totalSec) / Math.max(1, rect.width) * 12
      const nearest = points
        .map((point) => ({ ...point, at: Math.max(0, point.at), distance: Math.abs(Math.max(0, point.at) - rawStart) }))
        .sort((a, b) => a.distance - b.distance)[0]
      const snappedStart = nearest && nearest.distance <= threshold ? nearest.at : rawStart
      gesture.dStart = snappedStart - chunk.start
      gesture.snapLabel = nearest && nearest.distance <= threshold ? `Snapped · ${nearest.label}` : ''
      gesture.collision = peers.some((item) => snappedStart < item.end && snappedStart + duration > item.start)
      if (gesture.collision) gesture.snapLabel = gesture.snapLabel ? `${gesture.snapLabel} · overlaps` : 'Overlaps another clip'
    } else if (gesture.mode === 'in') {
      const sourceIn = Number(chunk.sourceIn || 0)
      const sourceOut = Number(chunk.sourceOut || chunk.clipDuration || sourceIn + (chunk.duration || 0))
      gesture.dIn = Math.max(-sourceIn, Math.min(dSec, sourceOut - sourceIn - 0.2))
    } else {
      const sourceIn = Number(chunk.sourceIn || 0)
      const sourceOut = Number(chunk.sourceOut || chunk.clipDuration || sourceIn + (chunk.duration || 0))
      const clipDuration = Number(chunk.clipDuration || sourceOut)
      gesture.dOut = Math.max(sourceIn + 0.2 - sourceOut, Math.min(dSec, clipDuration - sourceOut))
    }
    setAudioGestureView({
      id: chunk.id,
      mode: gesture.mode,
      dStart: gesture.dStart,
      dIn: gesture.dIn,
      dOut: gesture.dOut,
      snapLabel: gesture.snapLabel,
      collision: gesture.collision,
    })
  }, [audioChunks, segments, totalSec])
  const onAudioGestureUp = () => {
    const gesture = audioGestureRef.current
    audioGestureRef.current = null
    window.removeEventListener('pointermove', onAudioGestureMove)
    setAudioGestureView(null)
    if (!gesture?.started) return
    suppressClickRef.current = true
    window.setTimeout(() => { suppressClickRef.current = false }, 250)
    const chunk = gesture.chunk
    if (gesture.mode === 'move') {
      void saveAudioPlacement(chunk, { start: chunk.start + gesture.dStart })
      return
    }
    const sourceIn = Number(chunk.sourceIn || 0)
    const sourceOut = Number(chunk.sourceOut || chunk.clipDuration || sourceIn + (chunk.duration || 0))
    if (gesture.mode === 'in') {
      void saveAudioPlacement(chunk, {
        start: chunk.start + gesture.dIn,
        sourceIn: sourceIn + gesture.dIn,
        sourceOut,
      })
    } else {
      void saveAudioPlacement(chunk, {
        sourceIn,
        sourceOut: sourceOut + gesture.dOut,
      })
    }
  }
  const beginAudioGesture = (
    event: ReactPointerEvent,
    chunk: AudioChunk,
    mode: AudioTimelineGesture['mode'],
  ) => {
    if (timelineBusy) return
    if (event.button !== 0) {
      if (event.button === 2) event.stopPropagation()
      return
    }
    selectTimelineItem(
      chunk.id,
      'audio',
      chunk.layerId || '',
      event.shiftKey || event.metaKey || event.ctrlKey,
    )
    const sourceLayer = finalCut?.layers.find((layer) => layer.id === chunk.layerId)
    if (sourceLayer?.locked || chunk.locked) {
      onToast?.(sourceLayer?.locked ? `${sourceLayer.label} is locked.` : `${chunk.title} audio is locked.`)
      return
    }
    event.stopPropagation()
    event.preventDefault()
    const trackEl = (event.currentTarget as HTMLElement).closest('.vp-tl-track') as HTMLElement | null
    if (!trackEl) return
    audioGestureRef.current = {
      mode,
      chunk,
      startX: event.clientX,
      trackEl,
      started: mode !== 'move',
      dStart: 0,
      dIn: 0,
      dOut: 0,
      snapLabel: '',
      collision: false,
    }
    setActiveLayerId(chunk.layerId || '')
    if (mode !== 'move') setAudioGestureView({
      id: chunk.id,
      mode,
      dStart: 0,
      dIn: 0,
      dOut: 0,
      snapLabel: '',
      collision: false,
    })
    window.addEventListener('pointermove', onAudioGestureMove)
    window.addEventListener('pointerup', onAudioGestureUp, { once: true })
  }

  const segmentAtTime = useCallback((nextTime: number) => {
    const visible = segments.filter((segment) => !segment.excluded)
    const zByLayer = new Map(videoLayersTopFirst.map((layer) => [layer.id, Number(layer.z_index || 0)]))
    return visible
      .filter((segment) => nextTime >= segment.start && nextTime < segment.end)
      .sort((a, b) => Number(zByLayer.get(b.layerId || '') || 0) - Number(zByLayer.get(a.layerId || '') || 0))[0]
      ?? (nextTime >= totalSec && visible.length ? visible[visible.length - 1] : undefined)
      ?? null
  }, [segments, totalSec, videoLayersTopFirst])

  const chunkAtTime = useCallback((nextTime: number) => {
    return audioChunks.find((item) => !item.excluded && nextTime >= item.start && nextTime < item.end)
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

  const activeVisualIds = useMemo(
    () => new Set(
      segments
        .filter((segment) => !segment.excluded && time >= segment.start && time < segment.end)
        .map((segment) => segment.id),
    ),
    [segments, time],
  )
  const previewSegments = useMemo(() => {
    if (finalCut) {
      const zByLayer = new Map(finalCut.layers.map((layer) => [layer.id, Number(layer.z_index || 0)]))
      return segments
        .filter((segment) => !segment.excluded)
        .sort((a, b) => Number(zByLayer.get(a.layerId || '') || 0) - Number(zByLayer.get(b.layerId || '') || 0))
    }
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
  }, [activeSegment, finalCut, segments])

  const setTimelineTime = (nextTime: number) => {
    timelineTimeRef.current = nextTime
    setTime(nextTime)
  }

  // Fit to container: find the largest shared tile size that fits the open
  // Visuals/Audio sections, including their real summary-row chrome. Closed
  // sections occupy only their summary; if the minimum is still too large,
  // keep media readable and let the Workspace scroll.
  const computeGalleryFit = useCallback(() => {
    const strip = galleryStripRef.current
    const slot = strip?.closest<HTMLElement>('.vr-panel-slot')
    if (!strip || !slot) return
    const width = strip.clientWidth
    const stripTop = strip.getBoundingClientRect().top - slot.getBoundingClientRect().top
    const bound = isExpandedCard && !isMobileReview
      ? slot.clientHeight
      : Math.min(slot.clientHeight, window.innerHeight / 3)
    const height = Math.max(100, bound - stripTop - 4)
    const sections = Array.from(strip.querySelectorAll<HTMLDetailsElement>('.vr-workspace-section'))
    const openSections = sections.filter((section) => section.open)
    const primaryVisuals = strip.querySelector<HTMLElement>('.vr-workspace-primary')
    const openSectionBodies: HTMLElement[] = [
      ...(primaryVisuals ? [primaryVisuals] : []),
      ...openSections,
    ]
    const sectionCounts = openSectionBodies.map(
      (section) => section.querySelectorAll('.vr-workspace-item').length,
    )
    const summaryHeight = sections.reduce((sum, section) => (
      sum + (section.querySelector<HTMLElement>(':scope > summary')?.offsetHeight || 28)
    ), 0)
    const openSectionPadding = openSectionBodies.length * 8
    const sectionGap = Math.max(0, openSectionBodies.length - 1) * 6
    const gap = 10
    const minTile = 112
    const ratio = canvasRatioRef.current || 16 / 9
    // Normal/mobile review is document-height, not a fixed canvas: Fit all
    // packs each section across the available width, then the outer Workspace
    // grows to the resulting content. Height-based shrinking belongs only to
    // the expanded editor where the card itself has a fixed viewport budget.
    if (!isExpandedCard || isMobileReview) {
      const maxItems = Math.max(1, ...sectionCounts)
      const maxColumns = Math.max(1, Math.floor((width + gap) / (minTile + gap)))
      setGalleryFitCols(Math.min(maxItems, maxColumns))
      return
    }
    let pick: number | null = null
    for (let cols = 1; ; cols++) {
      const tileW = (width - (cols - 1) * gap) / cols
      if (tileW < minTile) break
      const rowsBySection = sectionCounts.map((count) => Math.ceil(count / cols))
      const rowsNeeded = rowsBySection.reduce((sum, rows) => sum + rows, 0)
      const rowGaps = rowsBySection.reduce((sum, rows) => sum + Math.max(0, rows - 1) * gap, 0)
      const tileH = tileW / ratio
      const packedHeight = summaryHeight + openSectionPadding + sectionGap + rowsNeeded * tileH + rowGaps
      if (packedHeight <= height) { pick = cols; break }
    }
    setGalleryFitCols(pick ?? Math.max(1, Math.floor((width + gap) / (minTile + gap))))
  }, [isExpandedCard, isMobileReview])

  const chooseGalleryFit = (next: 'normal' | 'width' | 'all') => {
    galleryFitRef.current = next
    if (next !== 'all') setGalleryFitCols(null)
    setGalleryFit(next)
    setWorkspaceLayoutMenuOpen(false)
  }
  const startWorkspaceSectionResize = (
    event: ReactPointerEvent<HTMLButtonElement>,
    section: 'visuals' | 'audio',
  ) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const container = event.currentTarget.closest<HTMLElement>(
      '.vr-workspace-section, .vr-workspace-primary',
    )
    const body = container?.querySelector<HTMLElement>(':scope > .vr-workspace-section-body')
    if (!body) return
    const startY = event.clientY
    const startHeight = body.getBoundingClientRect().height
    const minimum = section === 'audio' ? 64 : 110
    const maximum = Math.max(minimum, Math.round(window.innerHeight * 0.72))
    const move = (pointerEvent: PointerEvent) => {
      const height = Math.max(minimum, Math.min(maximum, Math.round(startHeight + pointerEvent.clientY - startY)))
      setWorkspaceSectionHeights((current) => ({
        ...current,
        [layoutMode]: {
          ...(current[layoutMode] ?? {}),
          [section]: height,
        },
      }))
      window.requestAnimationFrame(() => applyDefaultSizesRef.current())
    }
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }
  const resetWorkspaceSectionHeights = () => {
    setWorkspaceSectionHeights((current) => {
      const next = { ...current }
      delete next[layoutMode]
      return next
    })
    setWorkspaceLayoutMenuOpen(false)
    window.requestAnimationFrame(() => applyDefaultSizesRef.current())
    onToast?.('Workspace row heights reset to fit their content.')
  }
  const openAttachMenu = (
    event: ReactMouseEvent<HTMLButtonElement>,
    target: LayerAttachTarget | null,
  ) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const menuWidth = 300
    const menuHeight = 190
    setAttachTarget(target)
    setAttachMenuPosition({
      left: Math.max(12, Math.min(window.innerWidth - menuWidth - 12, rect.right - menuWidth)),
      top: rect.bottom + menuHeight + 12 <= window.innerHeight
        ? rect.bottom + 5
        : Math.max(12, rect.top - menuHeight - 5),
    })
    setAttachMenuOpen(true)
  }
  const openWorkspaceLayoutMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const menuWidth = 240
    const menuHeight = 220
    setWorkspaceLayoutMenuPosition({
      left: Math.max(12, Math.min(window.innerWidth - menuWidth - 12, rect.right - menuWidth)),
      top: rect.bottom + menuHeight + 12 <= window.innerHeight
        ? rect.bottom + 5
        : Math.max(12, rect.top - menuHeight - 5),
    })
    setWorkspaceLayoutMenuOpen(true)
  }
  const toggleTimelineMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (!timelineMenuOpen) {
      const rect = event.currentTarget.getBoundingClientRect()
      const menuWidth = 190
      const menuHeight = 184
      setTimelineMenuPosition({
        left: Math.max(12, Math.min(window.innerWidth - menuWidth - 12, rect.left)),
        top: rect.bottom + menuHeight + 12 <= window.innerHeight
          ? rect.bottom + 5
          : Math.max(12, rect.top - menuHeight - 5),
      })
    }
    setTimelineMenuOpen((open) => !open)
  }
  const collapseTimelinePanel = () => {
    setTimelineMenuOpen(false)
    const panel = timelineMenuButtonRef.current?.closest<HTMLDetailsElement>('details.vr-timeline-panel')
    if (panel) panel.open = false
  }
  const openLayerContextMenu = (event: ReactMouseEvent<HTMLElement>, layerId: string) => {
    event.preventDefault()
    event.stopPropagation()
    setActiveLayerId(layerId)
    setLayerContextMenu({
      x: Math.max(12, Math.min(event.clientX, window.innerWidth - 220)),
      y: Math.max(12, Math.min(event.clientY, window.innerHeight - 560)),
      layerId,
    })
  }
  const beginLayerStackDrag = (event: ReactDragEvent<HTMLElement>, layerId: string) => {
    event.stopPropagation()
    setDraggedLayerId(layerId)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('application/x-spoolcast-layer', layerId)
  }
  const dropLayerStack = (
    event: ReactDragEvent<HTMLElement>,
    relativeLayerId: string,
  ) => {
    event.preventDefault()
    event.stopPropagation()
    const layerId = event.dataTransfer.getData('application/x-spoolcast-layer') || draggedLayerId
    setDraggedLayerId('')
    if (!layerId || layerId === relativeLayerId) return
    const rect = event.currentTarget.getBoundingClientRect()
    const stackPosition = event.clientY < rect.top + rect.height / 2 ? 'above' : 'below'
    void runFinalCutAction({
      action: 'reorder_final_cut_layer',
      layer_id: layerId,
      relative_layer_id: relativeLayerId,
      stack_position: stackPosition,
    }, `Layer moved ${stackPosition}.`)
  }
  const openTimelineItemContextMenu = (
    event: ReactMouseEvent<HTMLElement>,
    kind: 'video' | 'audio',
    itemId: string,
    layerId: string,
  ) => {
    event.preventDefault()
    event.stopPropagation()
    if (!selectedTimelineIds.has(itemId)) setSelectedTimelineIds(new Set([itemId]))
    setActiveLayerId(layerId)
    if (kind === 'video') {
      setSelectedId(itemId)
      setSelectedAudioId('')
    } else {
      setSelectedAudioId(itemId)
      setSelectedId('')
    }
    setTimelineContextMenu({
      x: event.clientX,
      y: event.clientY,
      kind,
      id: itemId,
    })
  }
  // Fallback for nested trim handles and browser pointer retargeting. The item
  // still comes from the real element under the pointer, so empty track space
  // keeps its normal browser context menu.
  const openTimelineTrackContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
    const hit = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>('[data-timeline-item-id]')
    if (!hit || !event.currentTarget.contains(hit)) return
    const itemId = String(hit.dataset.timelineItemId || '')
    const layerId = String(hit.dataset.timelineLayerId || '')
    if (!itemId || !layerId) return
    openTimelineItemContextMenu(
      event,
      hit.dataset.timelineItemKind === 'audio' ? 'audio' : 'video',
      itemId,
      layerId,
    )
  }
  const workspaceAssetDuration = (asset: FinalCutWorkspaceAsset | undefined) => (
    asset?.media_kind === 'image' ? 10 : Math.max(0.2, Number(asset?.duration_s || 3))
  )
  const workspaceDropStartForTrack = (
    clientX: number,
    track: HTMLElement,
    duration: number,
  ) => {
    const rect = track.getBoundingClientRect()
    const timelineDuration = Math.max(totalSec, duration, 0.001)
    const midpoint = ((clientX - rect.left) / Math.max(1, rect.width)) * timelineDuration
    const rawStart = Math.max(0, midpoint - duration / 2)
    const secondsPerPx = timelineDuration / Math.max(1, rect.width)
    const edges = finalCut?.layers.flatMap((layer) => layer.items.flatMap((item) => (
      item.media_kind === 'gap'
        ? []
        : [
            Number(item.start_s || 0),
            Number(item.start_s || 0) + Number(item.duration_s || 0),
          ]
    ))) ?? []
    const candidates = [0, ...edges].flatMap((edge) => [edge, edge - duration])
    const nearest = candidates
      .map((start) => ({ start: Math.max(0, start), distance: Math.abs(start - rawStart) }))
      .sort((a, b) => a.distance - b.distance)[0]
    return round3(nearest && nearest.distance <= secondsPerPx * 12 ? nearest.start : rawStart)
  }
  const workspaceAssetFitsLayer = (
    asset: FinalCutWorkspaceAsset | undefined,
    layer: FinalCutLayer,
  ) => Boolean(
    asset
    && !layer.locked
    && (asset.media_kind === 'audio' ? layer.kind === 'audio' : layer.kind === 'video'),
  )
  const workspaceDropForLayerAt = (
    clientX: number,
    track: HTMLElement,
    layer: FinalCutLayer,
    assetId: string,
  ): WorkspaceDropState => {
    const asset = workspaceAssets.find((item) => item.id === assetId)
    if (!workspaceAssetFitsLayer(asset, layer)) {
      return { assetId, start: 0, layerId: layer.id, mode: 'incompatible' }
    }
    const rect = track.getBoundingClientRect()
    autoScrollTimeline(clientX, track)
    const timelineDuration = Math.max(totalSec, workspaceAssetDuration(asset), 0.001)
    const duration = workspaceAssetDuration(asset)
    const rawMidpoint = Math.max(0, ((clientX - rect.left) / Math.max(1, rect.width)) * timelineDuration)
    const rawStart = Math.max(0, rawMidpoint - duration / 2)
    const ranges = [...(layer.items ?? [])]
      .filter((item) => item.media_kind !== 'gap')
      .map((item) => ({
        id: item.id,
        label: item.shot_id || item.worldkit_ref || item.id,
        start: Number(item.start_s || 0),
        end: Number(item.start_s || 0) + Number(item.duration_s || 0),
      }))
      .sort((a, b) => a.start - b.start)
    const secondsPerPx = timelineDuration / Math.max(1, rect.width)
    const snapThreshold = secondsPerPx * 12
    const replacement = ranges
      .map((range) => {
        const midpoint = (range.start + range.end) / 2
        const threshold = Math.max(snapThreshold, Math.min((range.end - range.start) * 0.22, secondsPerPx * 36))
        return { ...range, distance: Math.abs(midpoint - rawMidpoint), threshold }
      })
      .filter((range) => range.distance <= range.threshold)
      .sort((a, b) => a.distance - b.distance)[0]
    if (replacement) {
      return {
        assetId,
        start: round3(replacement.start),
        layerId: layer.id,
        mode: 'replace',
        replaceItemId: replacement.id,
        snapLabel: `Replace ${replacement.label}`,
      }
    }
    const allEdges = finalCut?.layers.flatMap((candidateLayer) => candidateLayer.items.flatMap((item) => (
      item.media_kind === 'gap'
        ? []
        : [
            {
              at: Number(item.start_s || 0),
              label: `${item.shot_id || item.worldkit_ref || item.id} start`,
            },
            {
              at: Number(item.start_s || 0) + Number(item.duration_s || 0),
              label: `${item.shot_id || item.worldkit_ref || item.id} end`,
            },
          ]
    ))) ?? []
    const boundary = [
      { at: 0, label: 'Timeline start' },
      ...allEdges,
    ]
      .map((point) => ({ ...point, distance: Math.abs(point.at - rawMidpoint) }))
      .sort((a, b) => a.distance - b.distance)[0]
    if (boundary && boundary.distance <= snapThreshold) {
      return {
        assetId,
        start: round3(boundary.at),
        layerId: layer.id,
        mode: 'insert',
        snapLabel: `Insert · ${boundary.label}`,
      }
    }
    const alignedStart = [
      { start: rawStart, label: '' },
      ...allEdges.flatMap((edge) => [
        { start: edge.at, label: `Start to ${edge.label}` },
        { start: edge.at - duration, label: `End to ${edge.label}` },
      ]),
    ]
      .map((candidate) => ({
        ...candidate,
        start: Math.max(0, candidate.start),
        distance: Math.abs(Math.max(0, candidate.start) - rawStart),
      }))
      .sort((a, b) => a.distance - b.distance)[0]
    const candidate = alignedStart && alignedStart.distance <= snapThreshold
      ? alignedStart.start
      : rawStart
    const gaps = [
      { start: 0, end: ranges[0]?.start ?? Number.POSITIVE_INFINITY },
      ...ranges.map((range, index) => ({
        start: range.end,
        end: ranges[index + 1]?.start ?? Number.POSITIVE_INFINITY,
      })),
    ]
    const gap = gaps.find((item) => (
      candidate >= item.start - 0.001
      && candidate <= item.end + 0.001
      && item.end - item.start >= duration - 0.001
    ))
    if (gap) {
      const maxStart = Number.isFinite(gap.end) ? Math.max(gap.start, gap.end - duration) : candidate
      return {
        assetId,
        start: round3(Math.max(gap.start, Math.min(candidate, maxStart))),
        layerId: layer.id,
        mode: 'free',
        snapLabel: alignedStart && alignedStart.distance <= snapThreshold ? alignedStart.label : 'Place in open time',
      }
    }
    const insertAt = ranges.filter((range) => (range.start + range.end) / 2 < rawMidpoint).length
    const insertStart = insertAt > 0 ? ranges[insertAt - 1].end : 0
    return {
      assetId,
      start: round3(insertStart),
      layerId: layer.id,
      mode: 'insert',
      snapLabel: insertAt > 0
        ? `Insert after ${ranges[insertAt - 1].label}`
        : `Insert before ${ranges[0]?.label || 'first clip'}`,
    }
  }
  const updateWorkspaceDropForLayer = (
    event: ReactDragEvent<HTMLElement>,
    layer: FinalCutLayer,
  ): WorkspaceDropState => {
    const assetId = event.dataTransfer.getData('application/x-spoolcast-workspace') || workspaceDropRef.current?.assetId || ''
    event.preventDefault()
    event.stopPropagation()
    const next = workspaceDropForLayerAt(event.clientX, event.currentTarget, layer, assetId)
    event.dataTransfer.dropEffect = next.mode === 'incompatible' ? 'none' : 'copy'
    commitWorkspaceDrop(next)
    return next
  }
  const dropWorkspaceAssetOnLayer = (
    event: ReactDragEvent<HTMLElement>,
    layer: FinalCutLayer,
  ) => {
    const drop = updateWorkspaceDropForLayer(event, layer)
    if (drop.layerId !== layer.id) return
    if (drop.mode === 'incompatible') {
      onToast?.(layer.locked
        ? `${layer.label} is locked.`
        : `${workspaceAssets.find((item) => item.id === drop.assetId)?.media_kind === 'audio' ? 'Audio requires an Aud layer.' : 'Images and video require a Vid layer.'}`)
      commitWorkspaceDrop(null)
      return
    }
    commitWorkspaceDrop(null)
    void placeWorkspaceAsset(
      drop.assetId,
      drop.start,
      layer.id,
      true,
      drop.mode === 'replace' ? 'replace' : drop.mode === 'insert' ? 'insert' : 'place',
      { replaceItemId: drop.replaceItemId },
    )
  }
  const workspaceDropAtPoint = (
    clientX: number,
    clientY: number,
    asset: FinalCutWorkspaceAsset,
  ): WorkspaceDropState => {
    const hit = document.elementFromPoint(clientX, clientY)
    const newLayerTrack = hit?.closest<HTMLElement>('[data-workspace-new-layer-kind]')
    const targetKind = asset.media_kind === 'audio' ? 'audio' : 'video'
    if (newLayerTrack?.dataset.workspaceNewLayerKind === targetKind) {
      return {
        assetId: asset.id,
        start: workspaceDropStartForTrack(clientX, newLayerTrack, workspaceAssetDuration(asset)),
        layerId: '',
        mode: 'new',
        relativeLayerId: newLayerTrack.dataset.workspaceRelativeLayerId,
        stackPosition: newLayerTrack.dataset.workspaceStackPosition === 'below' ? 'below' : 'above',
        snapLabel: newLayerTrack.dataset.workspaceBehind === 'true'
          ? 'New layer behind the row above'
          : 'New layer above',
      }
    }
    const layerTrack = hit?.closest<HTMLElement>('[data-workspace-layer-id]')
    const layer = finalCut?.layers.find((candidate) => candidate.id === layerTrack?.dataset.workspaceLayerId)
    if (layerTrack && layer) {
      return workspaceDropForLayerAt(clientX, layerTrack, layer, asset.id)
    }
    return {
      assetId: asset.id,
      start: workspaceDropRef.current?.start ?? time,
      layerId: '',
      mode: 'pending',
    }
  }
  const onWorkspaceAssetPointerMove = (event: PointerEvent) => {
    const gesture = workspacePointerGestureRef.current
    if (!gesture) return
    if (!gesture.dragging) {
      if (Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) < 6) return
      gesture.dragging = true
      commitWorkspaceDrop({
        assetId: gesture.assetId,
        start: time,
        layerId: '',
        mode: 'pending',
      })
    }
    event.preventDefault()
    const asset = workspaceAssets.find((item) => item.id === gesture.assetId)
    if (!asset) return
    commitWorkspaceDrop(workspaceDropAtPoint(event.clientX, event.clientY, asset))
  }
  const onWorkspaceAssetPointerUp = (event: PointerEvent) => {
    const gesture = workspacePointerGestureRef.current
    workspacePointerGestureRef.current = null
    window.removeEventListener('pointermove', onWorkspaceAssetPointerMove)
    window.removeEventListener('pointerup', onWorkspaceAssetPointerUp)
    if (!gesture?.dragging) {
      commitWorkspaceDrop(null)
      return
    }
    event.preventDefault()
    workspaceSuppressClickRef.current = true
    window.setTimeout(() => { workspaceSuppressClickRef.current = false }, 0)
    const asset = workspaceAssets.find((item) => item.id === gesture.assetId)
    const drop = asset
      ? workspaceDropAtPoint(event.clientX, event.clientY, asset)
      : workspaceDropRef.current
    commitWorkspaceDrop(null)
    if (!drop || drop.mode === 'pending') return
    if (drop.mode === 'incompatible') {
      const layer = finalCut?.layers.find((candidate) => candidate.id === drop.layerId)
      onToast?.(layer?.locked
        ? `${layer.label} is locked.`
        : `${asset?.media_kind === 'audio' ? 'Audio requires an Aud layer.' : 'Images and video require a Vid layer.'}`)
      return
    }
    void placeWorkspaceAsset(
      drop.assetId,
      drop.start,
      drop.layerId,
      true,
      drop.mode === 'replace' ? 'replace' : drop.mode === 'insert' ? 'insert' : 'place',
      {
        replaceItemId: drop.replaceItemId,
        relativeLayerId: drop.relativeLayerId,
        stackPosition: drop.stackPosition,
      },
    )
  }
  const beginWorkspaceAssetPointerDrag = (
    event: ReactPointerEvent,
    asset: FinalCutWorkspaceAsset,
  ) => {
    if (!finalCut || timelineBusy || event.button !== 0) return
    workspacePointerGestureRef.current = {
      assetId: asset.id,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
    }
    window.addEventListener('pointermove', onWorkspaceAssetPointerMove)
    window.addEventListener('pointerup', onWorkspaceAssetPointerUp, { once: true })
  }

  useEffect(() => {
    if (galleryFit === 'all') computeGalleryFit()
  }, [computeGalleryFit, galleryFit, isExpandedCard, workspaceAssets.length])

  // AFTER the packed grid is in the DOM (fit-cols state landed), re-run the
  // one sizing pass so the slot snaps to the grid's true height — and back
  // to content height when Fit turns off. Nothing left to clip either way.
  useEffect(() => {
    applyDefaultSizesRef.current()
  }, [galleryFit, galleryFitCols, workspaceAssets.length])

  // Prompts differ in length per clip — when the selection changes while
  // PAUSED, refit the sections to the new content. During playback heights
  // deliberately stay put (no jitter); the pass runs once playback stops.
  useEffect(() => {
    if (playing) return
    applyDefaultSizesRef.current()
  }, [activeSegment?.id, playing])

  const setVideoRef = (segmentId: string, node: HTMLVideoElement | null) => {
    if (node) videoRefs.current.set(segmentId, node)
    else videoRefs.current.delete(segmentId)
  }

  const pauseInactiveVideos = (active: string | Set<string> = '') => {
    const activeIds = typeof active === 'string' ? new Set(active ? [active] : []) : active
    videoRefs.current.forEach((video, id) => {
      if (!activeIds.has(id)) video.pause()
    })
  }
  const pauseFinalCutAudio = () => {
    finalCutAudioRefs.current.forEach((audio) => audio.pause())
    activeFinalCutAudioIdsRef.current = new Set()
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
    if (finalCut) {
      const activeSegments = segments.filter(
        (segment) => !segment.excluded && segment.mediaType === 'video'
          && nextTime >= segment.start && nextTime < segment.end,
      )
      const nextIds = new Set(activeSegments.map((segment) => segment.id))
      const previousIds = activeVideoIdsRef.current
      pauseInactiveVideos(nextIds)
      for (const segment of activeSegments) {
        const video = videoRefs.current.get(segment.id)
        if (!video) continue
        if (!previousIds.has(segment.id)) {
          const local = segment.trimIn + Math.max(0, nextTime - segment.start)
          try { if (Math.abs(video.currentTime - local) > 0.1) video.currentTime = local } catch { /* non-seekable */ }
        }
        video.muted = Boolean(segment.muted || segment.audioDetached)
        video.volume = Math.min(
          1,
          effectiveVolume(segment.volumePct, segment.layerVolumePct)
            * audioFadeGain(
              nextTime - segment.start,
              segment.duration,
              segment.audioFadeIn,
              segment.audioFadeOut,
            ),
        )
        if (shouldPlay) { if (video.paused) void video.play().catch(() => {}) }
        else if (!video.paused) video.pause()
      }
      activeVideoIdsRef.current = nextIds
      activeVideoIdRef.current = [...nextIds].at(-1) || ''

      const activeAudio = audioChunks.filter(
        (chunk) => !chunk.excluded && !chunk.muted
          && nextTime >= chunk.start && nextTime < chunk.end,
      )
      const nextAudioIds = new Set(activeAudio.map((chunk) => chunk.id))
      const previousAudioIds = activeFinalCutAudioIdsRef.current
      finalCutAudioRefs.current.forEach((audio, id) => {
        if (!nextAudioIds.has(id) && !audio.paused) audio.pause()
      })
      for (const chunk of activeAudio) {
        const audio = finalCutAudioRefs.current.get(chunk.id)
        if (!audio) continue
        if (!previousAudioIds.has(chunk.id)) {
          const local = Number(chunk.sourceIn || 0) + Math.max(0, nextTime - chunk.start)
          try { if (Math.abs(audio.currentTime - local) > 0.1) audio.currentTime = local } catch { /* non-seekable */ }
        }
        audio.volume = Math.min(
          1,
          effectiveVolume(chunk.volumePct, chunk.layerVolumePct)
            * audioFadeGain(
              nextTime - chunk.start,
              Number(chunk.duration || chunk.end - chunk.start),
              chunk.audioFadeIn,
              chunk.audioFadeOut,
            ),
        )
        if (shouldPlay) { if (audio.paused) void audio.play().catch(() => {}) }
        else if (!audio.paused) audio.pause()
      }
      activeFinalCutAudioIdsRef.current = nextAudioIds
      return
    }
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
      // Trim-in: timeline time 0-of-segment = trimIn seconds into the file.
      const local = segment.trimIn + Math.max(0, nextTime - segment.start)
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
    if (finalCut) {
      reconcileVideo(nextTime, shouldPlay)
      return
    }
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

    if (finalCut) {
      const activeVideos = segments.filter(
        (segment) => !segment.excluded && segment.mediaType === 'video'
          && bounded >= segment.start && bounded < segment.end,
      )
      const activeAudios = audioChunks.filter(
        (chunk) => !chunk.excluded && !chunk.muted
          && bounded >= chunk.start && bounded < chunk.end,
      )
      pauseInactiveVideos(new Set(activeVideos.map((segment) => segment.id)))
      finalCutAudioRefs.current.forEach((audio, id) => {
        if (!activeAudios.some((chunk) => chunk.id === id)) audio.pause()
      })
      await Promise.all([
        ...activeVideos.map(async (segment) => {
          const video = await waitForVideoRef(segment.id)
          if (!video) return
          const url = await blobUrlFor(segment.mediaSrc)
          if (video.src !== url) {
            video.src = url
            video.load()
          }
          await waitForMedia(video, ['loadedmetadata', 'canplay'], () => video.readyState >= 1)
          try { video.currentTime = segment.trimIn + Math.max(0, bounded - segment.start) } catch { /* ignore */ }
        }),
        ...activeAudios.map(async (chunk) => {
          const audio = finalCutAudioRefs.current.get(chunk.id)
          if (!audio) return
          const url = await blobUrlFor(chunk.src)
          if (audio.src !== url) {
            audio.src = url
            audio.load()
          }
          await waitForMedia(audio, ['loadedmetadata', 'canplay'], () => audio.readyState >= 1)
          try { audio.currentTime = Number(chunk.sourceIn || 0) + Math.max(0, bounded - chunk.start) } catch { /* ignore */ }
        }),
      ])
      if (seekTokenRef.current !== token) return null
      activeVideoIdsRef.current = new Set()
      activeFinalCutAudioIdsRef.current = new Set()
      reconcileVideo(bounded, resume)
      setSeeking(false)
      if (resume) {
        playAnchorRef.current = { timeline: bounded, startedAt: window.performance.now() }
        setPlaying(true)
      }
      return bounded
    }

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
        const local = segment.trimIn + Math.max(0, bounded - segment.start)
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
    pauseFinalCutAudio()
    pauseInactiveVideos()
    wakeControls()
  }

  // While dragging we only move the playhead and preview the current segment frame
  // (cheap); the precise audio+video seek happens once on release.
  const updateScrub = (value: number) => {
    const bounded = Math.min(Math.max(value, 0), totalSec || 0)
    lastScrubValueRef.current = bounded
    setTimelineTime(bounded)
    if (finalCut) {
      activeVideoIdsRef.current = new Set()
      activeFinalCutAudioIdsRef.current = new Set()
    }
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
      pauseFinalCutAudio()
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
      setRenderStatus('Ready')
      void refreshRenderInfo()
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
    const out = await postAction<{ status?: string; stdout?: string }>({
      action: 'render_with_audit',
      quality: renderQuality,
    })
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

  const headerRenderReady = Boolean(
    renderInfo?.current?.exists
    && renderInfo.current.matches_timeline
    && renderInfo.current.quality === renderQuality,
  )
  useEffect(() => {
    registerStepAIAction(stageId, {
      stageId,
      label: headerRenderReady ? 'Final video ready' : 'Compile final video',
      busy: renderState === 'rendering',
      disabled: renderState === 'rendering' || headerRenderReady,
      disabledReason: headerRenderReady
        ? 'The current timeline is already compiled at this quality'
        : undefined,
      usesTextModel: false,
      acceptsInstructions: false,
      run: startRender,
    })
    return () => registerStepAIAction(stageId, null)
    // startRender is the existing worker-backed final-cut compile action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headerRenderReady, registerStepAIAction, renderState, stageId])

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
    const current = renderInfo?.current
    if (!current?.exists || !current.matches_timeline) return
    const link = document.createElement('a')
    link.href = downloadUrl(current.path || RENDER_OUTPUT_PATH())
    link.download = current.name || RENDER_OUTPUT_NAME()
    document.body.appendChild(link)
    link.click()
    link.remove()
  }
  const downloadRenderExport = (record: RenderExportRecord) => {
    if (!record.path) return
    const link = document.createElement('a')
    link.href = downloadUrl(record.path)
    link.download = record.name || record.path.split('/').pop() || RENDER_OUTPUT_NAME()
    document.body.appendChild(link)
    link.click()
    link.remove()
  }
  const downloadWorkspaceAsset = (asset: FinalCutWorkspaceAsset) => {
    const relativePath = asset.source.replace(new RegExp(`^sessions/${activeSession()}/`), '')
    const sourceName = relativePath.split('/').pop() || asset.id
    const suffix = /\.[A-Za-z0-9]{2,5}$/.exec(sourceName)?.[0] || ''
    const label = asset.label || asset.source_shot_id || asset.shot_id || asset.worldkit_ref || asset.id
    const cleanLabel = label.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace-media'
    const link = document.createElement('a')
    link.href = asset.source.startsWith('http') ? asset.source : downloadUrl(relativePath)
    link.download = `${cleanLabel}${suffix}`
    document.body.appendChild(link)
    link.click()
    link.remove()
  }
  const workspaceUsageForAsset = (asset: FinalCutWorkspaceAsset) => {
    const allItems = finalCut?.layers.flatMap((layer) => (
      layer.items
        .filter((item) => item.media_kind !== 'gap')
        .map((item) => ({ layer, item }))
    )) ?? []
    const direct = allItems.filter(({ item }) => (
      item.workspace_asset_id === asset.id
      || (
        !item.workspace_asset_id
        && item.source === asset.source
        && (!asset.source_sha || !item.source_sha || item.source_sha === asset.source_sha)
      )
    ))
    const linkedGroups = new Set(
      direct.map(({ item }) => item.link_group_id).filter((id): id is string => Boolean(id)),
    )
    const directIds = new Set(direct.map(({ item }) => item.id))
    const affected = allItems.filter(({ item }) => (
      directIds.has(item.id)
      || Boolean(item.link_group_id && linkedGroups.has(item.link_group_id))
    ))
    return {
      directPlacements: direct.length,
      affectedPlacements: affected.length,
    }
  }
  const openWorkspaceContextMenu = (
    event: ReactMouseEvent<HTMLElement>,
    asset: FinalCutWorkspaceAsset,
  ) => {
    event.preventDefault()
    event.stopPropagation()
    setTimelineContextMenu(null)
    setLayerContextMenu(null)
    setWorkspaceContextMenu({
      x: Math.max(12, Math.min(event.clientX, window.innerWidth - 232)),
      y: Math.max(12, Math.min(event.clientY, window.innerHeight - 128)),
      assetId: asset.id,
    })
  }
  const removeWorkspaceAsset = async (asset: FinalCutWorkspaceAsset) => {
    setWorkspaceContextMenu(null)
    setWorkspaceRemoveConfirm(null)
    const usage = workspaceUsageForAsset(asset)
    const label = asset.label || asset.shot_id || asset.worldkit_ref || asset.id
    const removed = await runFinalCutAction({
      action: 'remove_workspace_asset',
      asset_id: asset.id,
    })
    if (!removed) return
    setTimelineUndoNotice(
      usage.affectedPlacements
        ? `${label} removed from Workspace and ${usage.affectedPlacements} timeline placement${usage.affectedPlacements === 1 ? '' : 's'}.`
        : `${label} removed from Workspace.`,
    )
  }
  const requestWorkspaceAssetRemoval = (asset: FinalCutWorkspaceAsset) => {
    setWorkspaceContextMenu(null)
    const usage = workspaceUsageForAsset(asset)
    if (!usage.affectedPlacements) {
      void removeWorkspaceAsset(asset)
      return
    }
    setWorkspaceRemoveConfirm({
      assetId: asset.id,
      ...usage,
    })
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
      if (!totalSec || event.button !== 0) return
      setSelectedTimelineIds((current) => current.size ? new Set() : current)
      setSelectedId('')
      setSelectedAudioId('')
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

  // Keep in sync with .vr-layout-resizer-row height in index.css.
  const layoutResizerSize = 8

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
    // +6: breathing room so sub-pixel rounding can never shave the last line.
    return Math.max(minHeight, summaryHeight + bodyContentHeight(body) + 6)
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
          // The Workspace in normal/mobile review is document-height. Fit all
          // changes the grid columns, never clips the outer panel.
          else if (slot.panelId === 'gallery' && !isExpandedCard) {
            target = Math.max(slot.minHeight, slot.contentHeight)
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
          // Expanded rows are pass-sized; a dragged row (any view) uses its
          // live height; otherwise the normal preview cap is 78vh. ~70px of
          // chrome sits above the video, +30 breathing room around its width.
          const previewHeight = isExpandedCard && !isMobileReview
            ? Math.max(140, (assignedVideoRowHeight ?? videoRow.getBoundingClientRect().height) - 70)
            : videoRow.classList.contains('is-row-sized')
              ? Math.max(140, videoRow.getBoundingClientRect().height - 44)
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
        // ADDITIVE: only the row above the lane changes; the row below keeps
        // its height and just moves with the boundary (the card grows or
        // shrinks and scrolls). Bounded by the row's min and its content.
        const minFirst = resizeMinHeight(first)
        const maxFirst = resizeContentHeight(first, minFirst)
        const nextFirst = Math.min(maxFirst, Math.max(minFirst, firstStart + delta))
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
    maxOverride?: number,
  ) => {
    const target = document.querySelector<HTMLElement>(`[data-layout-id="${id}"]`)
    if (!target) return
    const rect = target.getBoundingClientRect()
    const startSize = sizes[id] ?? (axis === 'x' ? rect.width : rect.height)
    const start = axis === 'x' ? event.clientX : event.clientY
    const move = (moveEvent: PointerEvent) => {
      const current = axis === 'x' ? moveEvent.clientX : moveEvent.clientY
      const delta = current - start
      // An explicit override REPLACES the content cap (a bottom boundary may
      // grow a row past its content — the extra is just empty space).
      const maxSize = maxOverride ?? (axis === 'y' ? resizeContentHeight(target, min) : Infinity)
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
  const rowPanelResizePlan = (rowId: string): RowPanelResizePlanData => {
    const row = document.querySelector<HTMLElement>(`[data-layout-id="${rowId}"]`)
    if (!row) return { rowStart: 0, columns: [] }
    const columns = Array.from(row.querySelectorAll<HTMLElement>(':scope > .vr-layout-col'))
      .map((column) => {
        const allSlots = columnSlots(column)
        const stackStart = allSlots.reduce((sum, slot) => sum + slot.getBoundingClientRect().height, 0)
          + Math.max(0, allSlots.length - 1) * layoutResizerSize
        return {
          stackStart,
          slots: allSlots
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
        }
      })
      .filter((column) => column.slots.length > 0)
    return { rowStart: row.getBoundingClientRect().height, columns }
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
    plan: RowPanelResizePlanData,
    delta: number,
  ) => {
    if (!plan.columns.length) return
    setPanelSizes((currentSizes) => {
      let changed = false
      const nextSizes = { ...currentSizes }
      for (const column of plan.columns) {
        // Shrinking eats the column's EMPTY space first: sections only give
        // up height by however much the new row height cuts into their stack.
        // Growing keeps pulling clipped sections toward their content.
        const effectiveDelta = delta >= 0
          ? delta
          : -Math.max(0, column.stackStart - (plan.rowStart + delta))
        const heights = distributeColumnResize(column.slots, effectiveDelta)
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

  // When a row drag ends, re-run the one sizing pass: the video column's
  // width re-derives from the row's NEW height, so the player is always as
  // big as the row allows — never a small video over a tall void.
  const repassAfterDrag = () => {
    const once = () => {
      window.removeEventListener('pointerup', once)
      window.setTimeout(() => applyDefaultSizesRef.current(), 0)
    }
    window.addEventListener('pointerup', once)
  }

  // A row's TOP boundary only resizes the row above it (additive — the row
  // below rides the boundary); a row's BOTTOM boundary resizes the row itself,
  // growing or shrinking between its minimum and its content.
  const startReviewRowResize = (
    event: ReactPointerEvent<HTMLButtonElement>,
    firstId: string,
    secondId: string,
  ) => {
    manualRowSizeIdsRef.current.add(firstId)
    repassAfterDrag()
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
    repassAfterDrag()
    const plan = rowPanelResizePlan(rowId)
    const row = document.querySelector<HTMLElement>(`[data-layout-id="${rowId}"]`)
    startSingleResize(event, 'y', rowId, rowSizes, setRowSizes, row ? resizeMinHeight(row) : 32, (delta) => {
      applyRowPanelResize(plan, delta)
    }, Number.POSITIVE_INFINITY)
  }

  // Normal view: the VIDEO row gets a real height drag — the row stores its
  // height, the video follows it (container units), and sections only give
  // way once pinched. Other rows keep the additive model (the card grows).
  const startNormalRowResize = (
    event: ReactPointerEvent<HTMLButtonElement>,
    rowId: string,
  ) => {
    const row = document.querySelector<HTMLElement>(`[data-layout-id="${rowId}"]`)
    if (!row?.querySelector('.vr-player-panel')) {
      startRowAdditiveResize(event, rowId)
      return
    }
    manualRowSizeIdsRef.current.add(rowId)
    repassAfterDrag()
    const plan = rowPanelResizePlan(rowId)
    startSingleResize(event, 'y', rowId, rowSizes, setRowSizes, resizeMinHeight(row), (delta) => {
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
    if (!plan.columns.length) return
    for (const column of plan.columns) for (const slot of column.slots) manualPanelSizeIdsRef.current.add(slot.id)
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
    // Shrinking the upper section frees space — the section BELOW absorbs it
    // immediately, up to what its content actually needs. Otherwise a clipped
    // lower section stays clipped over a growing void.
    const second = document.querySelector<HTMLElement>(`[data-layout-id="${secondId}"]`)
    const secondStart = second ? second.getBoundingClientRect().height : 0
    const secondContent = second ? resizeContentHeight(second, resizeMinHeight(second)) : 0
    startPairResize(event, 'y', firstId, secondId, panelSizes, setPanelSizes, (delta) => {
      if (!second || secondContent <= secondStart) return
      const target = Math.min(secondContent, Math.max(secondStart, secondStart - delta))
      manualPanelSizeIdsRef.current.add(secondId)
      setPanelSizes((current) => (
        Math.abs((current[secondId] ?? secondStart) - target) > 0.5
          ? { ...current, [secondId]: target }
          : current
      ))
    })
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
    if (dragFromInteractiveControl(event.target) && !timelinePanelEmptyDragTarget(event.target)) {
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
    const local = activeSegment.trimIn + Math.max(0, timelineTimeRef.current - activeSegment.start)
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
                // clipping. Only the ratio and centering live inline
                // (--vr-ratio feeds the width-bound height cap).
                ? { aspectRatio: `${canvasRatio}`, width: 'auto', margin: '0 auto', maxWidth: '100%', '--vr-ratio': `${canvasRatio}` } as CSSProperties
                : { aspectRatio: `${canvasRatio}`, maxHeight: '78vh', width: 'auto', margin: '0 auto', maxWidth: '100%', '--vr-ratio': `${canvasRatio}` } as CSSProperties}
              onMouseMove={wakeControls}
              onMouseEnter={wakeControls}
              onFocus={wakeControls}
            >
              {!previewReady ? (
                <span className="vr-preview-loading">
                  <span className="spin" />
                  Loading preview…
                </span>
              ) : previewSegments.map((segment) => (
                segment.mediaType === 'video' ? (
                  <video
                    ref={(node) => {
                      if (node) node.volume = Math.min(1, effectiveVolume(segment.volumePct, segment.layerVolumePct))
                      setVideoRef(segment.id, node)
                    }}
                    className={`vr-media ${finalCut ? (activeVisualIds.has(segment.id) ? 'on' : '') : (segment.id === activeSegment?.id ? 'on' : '')}`}
                    key={segment.id}
                    src={mediaBlobs[segment.mediaSrc] ?? segment.mediaSrc}
                    muted={finalCut ? Boolean(segment.muted || segment.audioDetached) : !videoSoundChunks.has(segment.chunkId)}
                    playsInline
                    preload="auto"
                    controls={false}
                  />
                ) : segment.mediaType === 'image' ? (
                  <img
                    className={`vr-media ${finalCut ? (activeVisualIds.has(segment.id) ? 'on' : '') : (segment.id === activeSegment?.id ? 'on' : '')}`}
                    key={segment.id}
                    src={segment.mediaSrc}
                    alt=""
                  />
                ) : segment.id === activeSegment?.id ? (
                  <span className="vr-media on" key={segment.id}>missing visual</span>
                ) : null
              ))}
              {previewReady ? <div className="vr-title-overlay">
                <b>{activeSegment?.title || 'Visual review'}</b>
                <span>
                  {activeSegment?.id || 'visual'} · {activeSegment?.selectedType || 'image'} → {activeSegment?.mediaType || 'missing'} · {fmtTime(activeSegment?.start || 0)}-{fmtTime(activeSegment?.end || 0)}
                </span>
              </div> : null}
              {previewReady ? <div className="vr-player-top-actions">
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
              </div> : null}
              {previewReady && subtitlesOn && (activeSegment?.caption || activeChunk?.narration) ? (
                <p className="vr-subtitles">
                  {activeSegment?.caption || activeChunk?.narration}
                </p>
              ) : null}
              {previewReady && seeking ? <span className="vr-seeking">Seeking…</span> : null}
              {previewReady ? <div className="vr-player-controls">
                <button type="button" className="vr-play-btn" title={playing ? 'Pause' : 'Play'} onClick={togglePlay}>
                  {playing ? '❚❚' : '▶'}
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
              </div> : null}
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
          </p>
        </ReviewPanel>
      )
    }

    if (panelId === 'gallery') {
      const renderWorkspaceAsset = (asset: FinalCutWorkspaceAsset) => {
        const matching = segments.filter((segment) =>
          segment.id === asset.id
          || segment.pid === asset.shot_id
          || (asset.worldkit_ref && segment.worldKitRef === asset.worldkit_ref),
        )
        const excluded = matching.length > 0 && matching.every((segment) => segment.excluded)
        const source = asset.source.startsWith('http')
          ? asset.source
          : contentSrc(asset.source, String(asset.source_sha || ''))
        const label = asset.label || asset.shot_id || asset.worldkit_ref || asset.id
        const duration = Number(asset.duration_s || 0)
        const metadata = [
          asset.media_kind,
          duration ? `${duration.toFixed(1)}s` : '',
          excluded ? 'not rendered' : '',
        ].filter(Boolean).join(' · ')
        const audioDescription = [
          asset.origin === 'extracted-audio'
            ? 'Extracted clip audio'
            : asset.origin === 'world-kit'
              ? 'World Kit audio'
              : asset.origin === 'recent-generation'
                ? 'Recent generation'
                : asset.origin === 'computer'
                  ? 'Attached from computer'
                  : 'Workspace audio',
          duration ? `${duration.toFixed(1)}s` : '',
        ].filter(Boolean).join(' · ')
        return (
          <div
            className={`vr-workspace-tile ${asset.media_kind}`}
            key={asset.id}
            onContextMenu={(event) => openWorkspaceContextMenu(event, asset)}
          >
            <button
              type="button"
              className={`vr-workspace-item ${asset.media_kind} ${matching.some((segment) => segment.id === activeSegment?.id) ? 'on' : ''}`}
              draggable={false}
              style={excluded ? { opacity: 0.55 } : undefined}
              title={`${label} · ${metadata}${finalCut ? ' · drag onto a compatible timeline layer' : ''}`}
              onMouseEnter={(event) => {
                const video = event.currentTarget.querySelector('video')
                if (video) void video.play().catch(() => { /* hover preview may be browser-blocked */ })
              }}
              onMouseLeave={(event) => {
                const video = event.currentTarget.querySelector('video')
                if (!video) return
                video.pause()
                try { video.currentTime = 0.01 } catch { /* metadata may not be ready yet */ }
              }}
              onPointerDown={finalCut ? (event) => beginWorkspaceAssetPointerDrag(event, asset) : undefined}
              onClick={() => {
                if (workspaceSuppressClickRef.current) return
                const segment = matching[0]
                if (!segment) return
                setSelectedId(segment.id)
                setSelectedAudioId('')
                setPlaybackTime(segment.start, false)
              }}
            >
              {asset.media_kind === 'video' ? (
                <video
                  src={source}
                  draggable={false}
                  style={{ aspectRatio: `${canvasRatio}` }}
                  muted
                  playsInline
                  preload="metadata"
                  onLoadedMetadata={(event) => {
                    const video = event.currentTarget
                    if (video.videoWidth && video.videoHeight) {
                      video.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`
                    }
                  }}
                />
              ) : asset.media_kind === 'image' ? (
                <img
                  src={source}
                  alt=""
                  draggable={false}
                  style={{ aspectRatio: `${canvasRatio}` }}
                  onLoad={(event) => {
                    const image = event.currentTarget
                    if (image.naturalWidth && image.naturalHeight) {
                      image.style.aspectRatio = `${image.naturalWidth} / ${image.naturalHeight}`
                    }
                  }}
                />
              ) : (
                <span className="vr-workspace-audio">
                  <i className="vr-speaker-icon" aria-hidden="true" />
                  <span className="vr-workspace-audio-copy">
                    <b>{label}</b>
                    <small>{audioDescription}</small>
                  </span>
                </span>
              )}
              {asset.media_kind !== 'audio' ? (
                <i className={`vr-media-kind ${asset.media_kind}`}>
                  {asset.media_kind === 'video' ? '▶' : '▧'}
                </i>
              ) : null}
              {asset.media_kind !== 'audio' ? (
                <span className="vr-workspace-info">
                  <b>{label}</b>
                  <small>{metadata}</small>
                </span>
              ) : null}
              {excluded ? <i className="vr-media-excluded">NOT RENDERED</i> : null}
            </button>
            <button
              type="button"
              className="vr-workspace-download"
              data-no-pan
              title={`Download ${label}`}
              aria-label={`Download ${label}`}
              onClick={() => downloadWorkspaceAsset(asset)}
            >
              ↓
            </button>
          </div>
        )
      }
      return (
        <ReviewPanel
          {...panelDragProps('gallery', rowId, columnId)}
          className={panelClassName('gallery', 'vr-gallery-panel')}
          title={finalCut ? 'Workspace' : 'Gallery'}
          meta={finalCut
            ? `${workspaceVisualAssets.length} visuals · ${workspaceAudioAssets.length} audio`
            : `${workspaceAssets.length} item${workspaceAssets.length === 1 ? '' : 's'}`}
          actions={(
            <span style={{ display: 'inline-flex', gap: 8 }}>
              {finalCut ? (
                <button
                  type="button"
                  className="vp-undo vr-workspace-visual-toggle"
                  title={`${workspaceVisualsExpanded ? 'Collapse' : 'Expand'} Workspace visuals`}
                  onClick={() => setWorkspaceVisualsOpen((open) => !open)}
                >
                  {workspaceVisualsExpanded ? '▾' : '▸'} Visuals
                </button>
              ) : null}
              {finalCut ? (
                <span className="vg-select-wrap">
                  <button
                    type="button"
                    className="vp-menu-btn vg-select-btn"
                    disabled={!!timelineBusy}
                    onClick={(event) => {
                      if (attachMenuOpen && !attachTarget) setAttachMenuOpen(false)
                      else openAttachMenu(event, null)
                    }}
                  >
                    Attach ▾
                  </button>
                  <input
                    ref={finalCutUploadRef}
                    type="file"
                    accept="video/mp4,video/webm,video/quicktime,image/png,image/jpeg,image/webp,image/gif,audio/mpeg,audio/wav,audio/mp4,audio/aac"
                    style={{ display: 'none' }}
                    onChange={(event) => void uploadWorkspaceAsset(event.target.files?.[0])}
                  />
                </span>
              ) : null}
              <button
                type="button"
                className={`vp-undo ${galleryFit === 'all' ? 'on' : ''}`}
                title="Choose how Workspace items fill this panel"
                onClick={openWorkspaceLayoutMenu}
              >
                Workspace layout ▾
              </button>
            </span>
          )}
        >
          <div
            className={`vr-workspace-sections ${galleryFit}`}
            ref={galleryStripRef}
          >
            {workspaceVisualsExpanded ? (
              <section className="vr-workspace-primary">
                <div
                  className={`vr-workspace-section-body ${currentWorkspaceSectionHeights.visuals ? 'is-sized' : ''}`}
                  style={currentWorkspaceSectionHeights.visuals ? { height: currentWorkspaceSectionHeights.visuals } : undefined}
                >
              <div
                className={`vr-strip vr-workspace vr-workspace-grid ${galleryFit}`}
                style={galleryFit === 'all' && galleryFitCols ? { gridTemplateColumns: `repeat(${galleryFitCols}, 1fr)` } : undefined}
              >
                {workspaceVisualAssets.map(renderWorkspaceAsset)}
                {!workspaceVisualAssets.length ? <p className="vp-hint">No visual media attached.</p> : null}
              </div>
                </div>
                <button
                  type="button"
                  className="vr-workspace-section-resizer"
                  data-no-pan
                  aria-label="Resize Visuals Workspace row"
                  title="Drag to resize visuals row"
                  onPointerDown={(event) => startWorkspaceSectionResize(event, 'visuals')}
                />
              </section>
            ) : null}
            <WorkspaceSection
              key={`audio-${workspaceAudioAssets.length > 0}`}
              title="Audio"
              count={workspaceAudioAssets.length}
              unit="files"
              height={currentWorkspaceSectionHeights.audio}
              onResizeStart={(event) => startWorkspaceSectionResize(event, 'audio')}
              onOpenChange={() => {
                window.requestAnimationFrame(() => {
                  if (galleryFitRef.current === 'all') computeGalleryFit()
                  window.requestAnimationFrame(() => applyDefaultSizesRef.current())
                })
              }}
            >
              <div
                className={`vr-strip vr-workspace vr-workspace-grid vr-workspace-audio-grid ${galleryFit}`}
                style={galleryFit === 'all' && galleryFitCols ? { gridTemplateColumns: `repeat(${galleryFitCols}, 1fr)` } : undefined}
              >
                {workspaceAudioAssets.map(renderWorkspaceAsset)}
                {!workspaceAudioAssets.length ? <p className="vp-hint">No audio files attached.</p> : null}
              </div>
            </WorkspaceSection>
          </div>
        </ReviewPanel>
      )
    }

    const renderWorkspaceNewLayerDropRow = (
      kind: 'video' | 'audio',
      relativeLayerId = '',
      stackPosition: 'above' | 'below' = 'above',
      behind = false,
    ) => {
      if (!finalCut || !workspaceDrop) return null
      const asset = workspaceAssets.find((item) => item.id === workspaceDrop.assetId)
      if (!asset) return null
      const targetKind = asset.media_kind === 'audio' ? 'audio' : 'video'
      if (targetKind !== kind) return null
      const duration = workspaceAssetDuration(asset)
      const nextLayerNumber = finalCut.layers.filter((layer) => layer.kind === kind).length + 1
      const displayLabel = `${kind === 'audio' ? 'Aud' : 'Vid'} ${nextLayerNumber}`
      const active = workspaceDrop.mode === 'new'
        && workspaceDrop.relativeLayerId === relativeLayerId
        && workspaceDrop.stackPosition === stackPosition
      return (
        <div
          className={`vp-tl-row vr-workspace-drop-row ${active ? 'active' : ''}`}
          key={`drop-${kind}-${relativeLayerId || 'none'}-${stackPosition}`}
        >
          <span className="vp-tl-label">{displayLabel}</span>
          <div
            className={`vp-tl-track ${kind === 'audio' ? 'audio' : 'visuals'} vr-workspace-drop`}
            data-no-pan
            data-workspace-new-layer-kind={kind}
            data-workspace-relative-layer-id={relativeLayerId}
            data-workspace-stack-position={stackPosition}
            data-workspace-behind={behind ? 'true' : 'false'}
          >
            {active ? (
              <span
                className="vr-workspace-drop-preview"
                style={{
                  left: `${pct(workspaceDrop.start)}%`,
                  width: `${Math.max(0.8, pct(duration))}%`,
                }}
              >
                {workspaceDrop.snapLabel || `${asset.label || asset.shot_id || asset.worldkit_ref || 'Workspace item'} · ${duration.toFixed(1)}s`}
              </span>
            ) : <span className="vr-new-layer-label">{behind ? `Create ${displayLabel} behind` : `Create ${displayLabel} above`}</span>}
          </div>
        </div>
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
          position={time}
          duration={totalSec}
          hint="Drag clips to reorder on Vid 1; added layers move freely · Shift/Command-click to select multiple · right-click for clip actions"
          notice={timelineUndoNotice ? (
            <span className="vr-timeline-undo" data-no-pan>
              <span>{timelineUndoNotice}</span>
              <button type="button" className="vp-undo" onClick={() => {
                setTimelineUndoNotice('')
                void timelineHistory('undo')
              }}>
                Undo
              </button>
              <button type="button" className="vp-undo" aria-label="Dismiss" onClick={() => setTimelineUndoNotice('')}>×</button>
            </span>
          ) : null}
          toolbarActions={finalCut ? (
            <button
              ref={timelineMenuButtonRef}
              type="button"
              className={`vp-row-menu vr-timeline-combo ${timelineSaveState}`}
              disabled={!!timelineBusy}
              title={[
                'Timeline actions and collapse',
                timelineSaveState === 'saving'
                  ? 'saving'
                  : timelineSaveState === 'saved'
                    ? 'saved'
                    : selectedTimelineIds.size > 1
                      ? `${selectedTimelineIds.size} clips selected`
                      : '',
              ].filter(Boolean).join(' · ')}
              aria-label="Timeline actions and collapse"
              onClick={toggleTimelineMenu}
            >
              ⋯
            </button>
          ) : null}
        >
          <div className={`vr-timeline-stack ${finalCut ? 'is-final-cut' : ''}`}>
            <span
              className={`vr-playhead-full ${scrubbing ? 'scrubbing' : ''}`}
              style={{ left: `calc(var(--vr-timeline-offset, 76px) + (100% - var(--vr-timeline-offset, 76px)) * ${pct(time) / 100})` }}
            >
              <span className="vr-playhead-knob" />
            </span>
          {/* DEDICATED SCRUB ROW: the clips row now reorders/trims on drag,
              so this strip is pure navigation — click or drag anywhere to
              move the playhead. */}
          <div className="vp-tl-row">
            <span className="vp-tl-label vr-timeline-combo-cell" data-no-pan />
            <div className="vp-tl-track vr-scrubbable vr-scrubrow" aria-label="Timeline ruler" {...timelineScrubHandlers}>
              {ticks.map((tick) => (
                <span key={`ruler-${tick}`} className="vr-scrub-tick" style={{ left: `${pct(tick)}%` }}>{fmtTime(tick)}</span>
              ))}
              <span className="vr-scrub-tick end" style={{ left: '100%' }}>{fmtTime(totalSec)}</span>
            </div>
          </div>
          {(finalCut ? videoLayersTopFirst : [{ id: 'visuals', label: 'Visuals', kind: 'video' as const, muted: false, items: [] }]).map((layer) => {
            const layerSegments = finalCut ? segments.filter((segment) => segment.layerId === layer.id) : segments
            const layerGaps = finalCut
              ? layer.items.filter((item) => item.media_kind === 'gap')
              : []
            const displayLabel = finalCut
              ? (layer.custom_label ? layer.label : compactLayerLabel('video', Number(layer.z_index || 0)))
              : 'Visuals'
            const layerDrop = workspaceDrop?.layerId === layer.id ? workspaceDrop : null
            return (
          <Fragment key={`video-stack-${layer.id}`}>
          {finalCut ? renderWorkspaceNewLayerDropRow('video', layer.id, 'above') : null}
          <div
            className={`vp-tl-row vr-layer-row ${layerSegments.length ? '' : 'is-empty'} ${layer.locked ? 'is-locked' : ''} ${layerDrop ? `is-drop-${layerDrop.mode}` : ''}`}
          >
            <span
              className={`vp-tl-label ${draggedLayerId === layer.id ? 'is-layer-dragging' : ''}`}
              onContextMenu={(event) => openLayerContextMenu(event, layer.id)}
              onDragOver={(event) => {
                if (draggedLayerId && draggedLayerId !== layer.id) event.preventDefault()
              }}
              onDrop={(event) => dropLayerStack(event, layer.id)}
            >
              {finalCut ? (
                <>
                  <button
                    type="button"
                    className="vr-layer-name"
                    draggable
                    aria-label={`${displayLabel} layer actions`}
                    title="Drag to reorder the layer · right-click for layer actions"
                    onDragStart={(event) => beginLayerStackDrag(event, layer.id)}
                    onDragEnd={() => setDraggedLayerId('')}
                  >
                    {displayLabel}
                    {layer.locked ? <i className="vr-padlock-icon" aria-hidden="true" /> : null}
                    {Math.abs(Number(layer.volume_pct ?? 100) - 100) > 0.5
                      ? <i className="vr-layer-volume-value">{Math.round(Number(layer.volume_pct))}%</i>
                      : null}
                  </button>
                  <button
                    type="button"
                    className={`vr-layer-mute ${layer.muted ? 'muted' : ''}`}
                    disabled={!!timelineBusy}
                    title={`${layer.muted ? 'Unmute' : 'Mute'} ${displayLabel} · right-click for volume`}
                    aria-label={`${layer.muted ? 'Unmute' : 'Mute'} ${displayLabel}`}
                    onClick={() => void toggleFinalCutLayer(layer.id)}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      openVolumeEditor('layer', layer.id, displayLabel, layer.volume_pct, event.clientX, event.clientY)
                    }}
                  >
                    <i className="vr-speaker-icon" aria-hidden="true" />
                  </button>
                </>
              ) : 'Visuals'}
            </span>
            <div
              className="vp-tl-track visuals vr-scrubbable"
              data-workspace-layer-id={layer.id}
              data-workspace-layer-kind="video"
              onDragOver={finalCut ? (event) => updateWorkspaceDropForLayer(event, layer) : undefined}
              onDrop={finalCut ? (event) => dropWorkspaceAssetOnLayer(event, layer) : undefined}
              onContextMenu={finalCut ? openTimelineTrackContextMenu : undefined}
              {...timelineScrubHandlers}
            >
              {finalCut && !layerSegments.length && !workspaceDrop ? (
                <button
                  type="button"
                  className="vr-empty-layer-action"
                  data-no-pan
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => openAttachMenu(event, { id: layer.id, kind: 'video', label: displayLabel })}
                >
                  + Add item to layer
                </button>
              ) : null}
              {layerGaps.map((gap) => (
                <span
                  key={gap.id}
                  className="vr-gap-block"
                  style={{
                    left: `${pct(Number(gap.start_s || 0))}%`,
                    width: `${Math.max(0.35, pct(Number(gap.duration_s || 0)))}%`,
                  }}
                  title={`Gap · ${Number(gap.duration_s || 0).toFixed(1)}s · use the layer menu to close gaps`}
                >
                  Gap · {Number(gap.duration_s || 0).toFixed(1)}s
                </span>
              ))}
              {layerSegments.map((segment) => {
                const gv = gestureView && gestureView.id === segment.id ? gestureView : null
                const dIn = gv?.mode === 'in' ? gv.dIn : 0
                const dOut = gv?.mode === 'out' ? gv.dOut : 0
                const liveDuration = Math.max(0.2, segment.duration - dIn + dOut)
                const selected = selectedTimelineIds.has(segment.id)
                const liveFade = audioFadeEditor?.id === segment.id ? audioFadeEditor : null
                const fadeIn = liveFade?.fadeIn ?? segment.audioFadeIn
                const fadeOut = liveFade?.fadeOut ?? segment.audioFadeOut
                return (
                <button
                  type="button"
                  key={segment.id}
                  className={`vp-seg ${!finalCut && segment.id === activeSegment?.id ? 'on' : ''} ${selected ? 'selected' : ''} ${segment.mediaType === 'video' ? 'video' : ''} ${gv ? 'gesturing source' : ''} ${segment.excluded ? 'excluded' : ''} ${segment.locked ? 'locked' : ''} ${segment.muted ? 'muted' : ''}`}
                  style={{
                    left: `${pct(segment.start + dIn)}%`,
                    width: `${Math.max(0.35, pct(liveDuration))}%`,
                  }}
                  data-no-pan
                  data-timeline-item-id={segment.id}
                  data-timeline-item-kind="video"
                  data-timeline-layer-id={layer.id}
                  onPointerDown={(e) => beginTimelineGesture(e, segment, 'move')}
                  onContextMenu={(event) => openTimelineItemContextMenu(event, 'video', segment.id, layer.id)}
                  onClick={() => {
                    if (suppressClickRef.current) return
                    setPlaybackTime(segment.start, false)
                  }}
                  onPointerEnter={(event) => setTimelineTooltip({
                    x: event.clientX,
                    y: event.clientY,
                    text: `${segment.sourceLabel || segment.displayLabel || segment.pid} · ${segment.mediaType} · ${fmtTime(segment.start)}–${fmtTime(segment.end)} · ${segment.duration.toFixed(1)}s${Math.abs(Number(segment.volumePct ?? 100) - 100) > 0.5 ? ` · ${Math.round(Number(segment.volumePct))}% volume` : ''}${segment.locked ? ' · locked' : ''}${segment.muted ? ' · muted' : ''}${segment.excluded ? ' · not rendered' : ''}`,
                  })}
                  onPointerMove={(event) => setTimelineTooltip((current) => current ? { ...current, x: event.clientX, y: event.clientY } : current)}
                  onPointerLeave={() => setTimelineTooltip(null)}
                  title={`${segment.pid} · ${segment.locked ? 'LOCKED · ' : ''}${segment.excluded ? 'EXCLUDED FROM RENDER · ' : ''}${segment.muted ? 'MUTED · ' : ''}${segment.linkGroupId ? 'LINKED · ' : ''}${segment.duration.toFixed(1)}s${segment.trimIn || segment.trimOut ? ` · trimmed ${segment.trimIn.toFixed(1)}–${(segment.trimOut ?? segment.clipDuration ?? 0).toFixed(1)}s` : ''} — ${segment.locked ? 'unlock from the right-click menu to edit' : `drag to ${layer.edit_mode === 'magnetic' || !finalCut ? 'reorder' : 'position freely'}, drag an edge to trim`}`}
                >
                  <i className="vr-drag-grip" aria-hidden="true" />
                  {segment.mediaType === 'video' && !segment.audioDetached && audioWaveforms[segment.id]?.length ? (
                    <span className="vr-audio-waveform vr-video-waveform" aria-hidden="true">
                      {audioWaveforms[segment.id].map((peak, peakIndex) => (
                        <i key={`${segment.id}-video-wave-${peakIndex}`} style={{ height: `${Math.max(8, peak * 88)}%` }} />
                      ))}
                    </span>
                  ) : null}
                  {segment.mediaType === 'video' && !segment.audioDetached ? (
                    <AudioFadeEnvelope duration={liveDuration} fadeIn={fadeIn} fadeOut={fadeOut} />
                  ) : null}
                  <span className="vr-clip-label" onContextMenu={(event) => openTimelineItemContextMenu(event, 'video', segment.id, layer.id)}>
                    {gv ? `${liveDuration.toFixed(1)}s` : segment.displayLabel || segment.pid}
                  </span>
                  {segment.linkGroupId ? (
                    <i
                      className="vr-clip-link-badge"
                      title="Linked — moving, trimming, or removing this clip also affects its linked clip"
                      aria-label="Linked clip"
                    >
                      <span className="vr-link-icon" aria-hidden="true" />
                    </i>
                  ) : null}
                  {segment.locked || segment.muted || Math.abs(Number(segment.volumePct ?? 100) - 100) > 0.5 ? (
                    <i className={`vr-clip-state-icons ${segment.linkGroupId ? 'has-link' : ''}`} aria-hidden="true">
                      {segment.locked ? <span className="vr-padlock-icon" /> : null}
                      {segment.muted ? <span className="vr-speaker-icon vr-muted-icon" /> : null}
                      {Math.abs(Number(segment.volumePct ?? 100) - 100) > 0.5
                        ? <span className="vr-volume-value">{Math.round(Number(segment.volumePct))}%</span>
                        : null}
                    </i>
                  ) : null}
                  {segment.mediaType === 'video' ? (
                    <>
                      <i
                        className="vr-trim-handle l"
                        title="Drag to trim the clip's start"
                        onPointerDown={(event) => beginTimelineGesture(event, segment, 'in')}
                        onContextMenu={(event) => openTimelineItemContextMenu(event, 'video', segment.id, layer.id)}
                      />
                      <i
                        className="vr-trim-handle r"
                        title="Drag to trim the clip's end"
                        onPointerDown={(event) => beginTimelineGesture(event, segment, 'out')}
                        onContextMenu={(event) => openTimelineItemContextMenu(event, 'video', segment.id, layer.id)}
                      />
                    </>
                  ) : null}
                </button>
                )
              })}
              {gestureView?.mode === 'move' ? (() => {
                const segment = layerSegments.find((item) => item.id === gestureView.id)
                if (!segment) return null
                const ghostStart = Math.max(0, segment.start + gestureView.dStart)
                return (
                  <span
                    className={`vr-clip-drag-ghost ${gestureView.collision ? 'collision' : ''}`}
                    style={{
                      left: `${pct(ghostStart)}%`,
                      width: `${Math.max(0.35, pct(segment.duration))}%`,
                    }}
                  >
                    <b>{segment.pid}</b>
                    <small>{gestureView.snapLabel || `${fmtTime(ghostStart)}–${fmtTime(ghostStart + segment.duration)}`}</small>
                  </span>
                )
              })() : null}
              {gestureView?.mode === 'move' && gestureView.insertAt >= 0 && (
                !finalCut || (
                  gestureView.reorder
                  && layer.edit_mode === 'magnetic'
                  && layerSegments.some((segment) => segment.id === gestureView.id)
                )
              ) ? (() => {
                const dragging = layerSegments.find((segment) => segment.id === gestureView.id)
                const peers = finalCut
                  ? layerSegments
                    .filter((segment) => segment.id !== gestureView.id)
                    .sort((a, b) => a.start - b.start)
                  : segments
                const previous = gestureView.insertAt === 0 ? null : peers[gestureView.insertAt - 1]
                return (
                  <span
                    className="vr-insert-slot"
                    style={{
                      left: `${pct(previous?.end ?? 0)}%`,
                      width: `${Math.max(0.35, pct(dragging?.duration || 0.2))}%`,
                    }}
                  >
                    Insert here
                  </span>
                )
              })() : null}
              {layerDrop ? (() => {
                const asset = workspaceAssets.find((item) => item.id === layerDrop.assetId)
                if (!asset) return null
                return (
                  <span
                    className={`vr-workspace-layer-preview ${layerDrop.mode}`}
                    style={layerDrop.mode === 'incompatible' ? undefined : {
                      left: `${pct(layerDrop.start)}%`,
                      width: `${Math.max(0.8, pct(workspaceAssetDuration(asset)))}%`,
                    }}
                  >
                    {layerDrop.mode === 'incompatible'
                      ? (layer.locked ? 'Layer locked' : 'Requires a compatible layer')
                      : `${layerDrop.snapLabel || (layerDrop.mode === 'replace' ? 'Replace clip' : layerDrop.mode === 'insert' ? 'Insert' : 'Place')} · ${workspaceAssetDuration(asset).toFixed(1)}s`}
                  </span>
                )
              })() : null}
            </div>
            {finalCut ? (
              <button
                type="button"
                className="vr-layer-attach"
                data-no-pan
                disabled={!!timelineBusy}
                title={`Attach media to ${displayLabel}`}
                aria-label={`Attach media to ${displayLabel}`}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => openAttachMenu(event, { id: layer.id, kind: 'video', label: displayLabel })}
              >
                +
              </button>
            ) : null}
          </div>
          </Fragment>
            )
          })}
          {finalCut ? (
            videoLayersTopFirst.length
              ? renderWorkspaceNewLayerDropRow('video', videoLayersTopFirst[videoLayersTopFirst.length - 1].id, 'below', true)
              : renderWorkspaceNewLayerDropRow('video')
          ) : null}
          {finalCut ? audioLayers.map((layer, layerIndex) => {
            const displayLabel = layer.custom_label ? layer.label : compactLayerLabel('audio', layerIndex)
            const layerChunks = audioChunks.filter((chunk) => chunk.layerId === layer.id)
            const layerDrop = workspaceDrop?.layerId === layer.id ? workspaceDrop : null
            return (
          <div
            className={`vp-tl-row vr-layer-row ${layerChunks.length ? '' : 'is-empty'} ${layer.locked ? 'is-locked' : ''} ${layerDrop ? `is-drop-${layerDrop.mode}` : ''}`}
            key={layer.id}
          >
            <span
              className={`vp-tl-label ${draggedLayerId === layer.id ? 'is-layer-dragging' : ''}`}
              onContextMenu={(event) => openLayerContextMenu(event, layer.id)}
              onDragOver={(event) => {
                if (draggedLayerId && draggedLayerId !== layer.id) event.preventDefault()
              }}
              onDrop={(event) => dropLayerStack(event, layer.id)}
            >
              <button
                type="button"
                className="vr-layer-name"
                draggable
                aria-label={`${displayLabel} layer actions`}
                title="Drag to reorder the layer · right-click for layer actions"
                onDragStart={(event) => beginLayerStackDrag(event, layer.id)}
                onDragEnd={() => setDraggedLayerId('')}
              >
                {displayLabel}
                  {layer.locked ? <i className="vr-padlock-icon" aria-hidden="true" /> : null}
                  {Math.abs(Number(layer.volume_pct ?? 100) - 100) > 0.5
                    ? <i className="vr-layer-volume-value">{Math.round(Number(layer.volume_pct))}%</i>
                    : null}
                </button>
              <button
                type="button"
                className={`vr-layer-mute ${layer.muted ? 'muted' : ''}`}
                disabled={!!timelineBusy}
                title={`${layer.muted ? 'Unmute' : 'Mute'} ${displayLabel} · right-click for volume`}
                aria-label={`${layer.muted ? 'Unmute' : 'Mute'} ${displayLabel}`}
                onClick={() => void toggleFinalCutLayer(layer.id)}
                onContextMenu={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  openVolumeEditor('layer', layer.id, displayLabel, layer.volume_pct, event.clientX, event.clientY)
                }}
              >
                <i className="vr-speaker-icon" aria-hidden="true" />
              </button>
            </span>
            <div
              className="vp-tl-track audio vr-scrubbable"
              data-workspace-layer-id={layer.id}
              data-workspace-layer-kind="audio"
              onDragOver={(event) => updateWorkspaceDropForLayer(event, layer)}
              onDrop={(event) => dropWorkspaceAssetOnLayer(event, layer)}
              onContextMenu={openTimelineTrackContextMenu}
              {...timelineScrubHandlers}
            >
              {!layerChunks.length && !workspaceDrop ? (
                <button
                  type="button"
                  className="vr-empty-layer-action"
                  data-no-pan
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => openAttachMenu(event, { id: layer.id, kind: 'audio', label: displayLabel })}
                >
                  + Add item to layer
                </button>
              ) : null}
              {layerChunks.map((chunk, index) => {
                const gesture = audioGestureView?.id === chunk.id ? audioGestureView : null
                const dStart = gesture?.mode === 'move' ? gesture.dStart : 0
                const dIn = gesture?.mode === 'in' ? gesture.dIn : 0
                const dOut = gesture?.mode === 'out' ? gesture.dOut : 0
                const liveDuration = Math.max(0.2, (chunk.duration || chunk.end - chunk.start) - dIn + dOut)
                const liveFade = audioFadeEditor?.id === chunk.id ? audioFadeEditor : null
                const fadeIn = liveFade?.fadeIn ?? chunk.audioFadeIn
                const fadeOut = liveFade?.fadeOut ?? chunk.audioFadeOut
                return (
                <button
                  type="button"
                  key={chunk.id}
                  className={`vp-ruler-seg ${index % 2 ? 'alt' : ''} ${!finalCut && (chunk.id === selectedAudioId || chunk.id === activeChunk?.id) ? 'on' : ''} ${selectedTimelineIds.has(chunk.id) ? 'selected' : ''} ${chunk.excluded ? 'excluded' : ''} ${chunk.locked ? 'locked' : ''} ${chunk.muted ? 'muted' : ''} ${gesture?.collision ? 'collision' : ''}`}
                  style={{
                    left: `${pct(chunk.start + dStart + dIn)}%`,
                    width: `${Math.max(0.35, pct(liveDuration))}%`,
                  }}
                  data-no-pan
                  data-timeline-item-id={chunk.id}
                  data-timeline-item-kind="audio"
                  data-timeline-layer-id={layer.id}
                  onPointerDown={(event) => beginAudioGesture(event, chunk, 'move')}
                  onContextMenu={(event) => openTimelineItemContextMenu(event, 'audio', chunk.id, layer.id)}
                  onClick={() => {
                    if (suppressClickRef.current) return
                    setPlaybackTime(chunk.start, false)
                  }}
                  onPointerEnter={(event) => setTimelineTooltip({
                    x: event.clientX,
                    y: event.clientY,
                    text: `${chunk.title} · audio · ${fmtTime(chunk.start)}–${fmtTime(chunk.end)} · ${(chunk.duration || chunk.end - chunk.start).toFixed(1)}s${Math.abs(Number(chunk.volumePct ?? 100) - 100) > 0.5 ? ` · ${Math.round(Number(chunk.volumePct))}% volume` : ''}${chunk.locked ? ' · locked' : ''}${chunk.muted ? ' · muted' : ''}${chunk.excluded ? ' · not rendered' : ''}`,
                  })}
                  onPointerMove={(event) => setTimelineTooltip((current) => current ? { ...current, x: event.clientX, y: event.clientY } : current)}
                  onPointerLeave={() => setTimelineTooltip(null)}
                  title={`${chunk.title}${chunk.locked ? ' · LOCKED' : ''}${chunk.linkGroupId ? ' · LINKED' : ''}${chunk.borrowed ? ' · borrowed audio' : ''} — ${chunk.locked ? 'unlock from the right-click menu to edit' : 'drag to position freely, drag an edge to trim'}`}
                >
                  <span className="vr-audio-waveform" aria-hidden="true">
                    {(audioWaveforms[chunk.id] || []).map((peak, peakIndex) => (
                      <i key={`${chunk.id}-peak-${peakIndex}`} style={{ height: `${Math.max(8, peak * 100)}%` }} />
                    ))}
                  </span>
                  <AudioFadeEnvelope duration={liveDuration} fadeIn={fadeIn} fadeOut={fadeOut} />
                  <span className="vr-clip-label" onContextMenu={(event) => openTimelineItemContextMenu(event, 'audio', chunk.id, layer.id)}>
                    {gesture ? `${liveDuration.toFixed(1)}s` : shortTimelineLabel(chunk.title.replace(/\s+audio$/i, ''), 'Audio', 18)}
                  </span>
                  {chunk.linkGroupId ? (
                    <i
                      className="vr-clip-link-badge"
                      title="Linked — moving, trimming, or removing this clip also affects its linked clip"
                      aria-label="Linked clip"
                    >
                      <span className="vr-link-icon" aria-hidden="true" />
                    </i>
                  ) : null}
                  {chunk.locked || chunk.muted || Math.abs(Number(chunk.volumePct ?? 100) - 100) > 0.5 ? (
                    <i className={`vr-clip-state-icons ${chunk.linkGroupId ? 'has-link' : ''}`} aria-hidden="true">
                      {chunk.locked ? <span className="vr-padlock-icon" /> : null}
                      {chunk.muted ? <span className="vr-speaker-icon vr-muted-icon" /> : null}
                      {Math.abs(Number(chunk.volumePct ?? 100) - 100) > 0.5
                        ? <span className="vr-volume-value">{Math.round(Number(chunk.volumePct))}%</span>
                        : null}
                    </i>
                  ) : null}
                  {gesture?.snapLabel ? <small className="vr-audio-snap">{gesture.snapLabel}</small> : null}
                  <i
                    className="vr-trim-handle l"
                    title="Drag to trim the audio start"
                    onPointerDown={(event) => beginAudioGesture(event, chunk, 'in')}
                    onContextMenu={(event) => openTimelineItemContextMenu(event, 'audio', chunk.id, layer.id)}
                  />
                  <i
                    className="vr-trim-handle r"
                    title="Drag to trim the audio end"
                    onPointerDown={(event) => beginAudioGesture(event, chunk, 'out')}
                    onContextMenu={(event) => openTimelineItemContextMenu(event, 'audio', chunk.id, layer.id)}
                  />
                </button>
                )
              })}
              {layerDrop ? (() => {
                const asset = workspaceAssets.find((item) => item.id === layerDrop.assetId)
                if (!asset) return null
                return (
                  <span
                    className={`vr-workspace-layer-preview ${layerDrop.mode}`}
                    style={layerDrop.mode === 'incompatible' ? undefined : {
                      left: `${pct(layerDrop.start)}%`,
                      width: `${Math.max(0.8, pct(workspaceAssetDuration(asset)))}%`,
                    }}
                  >
                    {layerDrop.mode === 'incompatible'
                      ? (layer.locked ? 'Layer locked' : 'Requires an Aud layer')
                      : `${layerDrop.snapLabel || (layerDrop.mode === 'replace' ? 'Replace clip' : layerDrop.mode === 'insert' ? 'Insert' : 'Place')} · ${workspaceAssetDuration(asset).toFixed(1)}s`}
                  </span>
                )
              })() : null}
            </div>
            <button
              type="button"
              className="vr-layer-attach"
              data-no-pan
              disabled={!!timelineBusy}
              title={`Attach audio to ${displayLabel}`}
              aria-label={`Attach audio to ${displayLabel}`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => openAttachMenu(event, { id: layer.id, kind: 'audio', label: displayLabel })}
            >
              +
            </button>
          </div>
            )
          }) : videoFirstSession ? null : (
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
          )}
          {finalCut ? (
            audioLayers.length
              ? renderWorkspaceNewLayerDropRow('audio', audioLayers[audioLayers.length - 1].id, 'below')
              : renderWorkspaceNewLayerDropRow('audio')
          ) : null}
          </div>
          {finalCut?.conflicts?.length ? (
            <p className="vp-hint" style={{ color: 'var(--amber)', margin: '8px 0 0' }}>
              {finalCut.conflicts.length} upstream change{finalCut.conflicts.length === 1 ? '' : 's'} need review before compile: {finalCut.conflicts.map((conflict) => `${conflict.shot_id || conflict.item_id}: ${conflict.reason}`).join(' · ')}
            </p>
          ) : null}
        </TimelineScroller>
      </ReviewPanel>
    )
  }

  const selectedRenderProfile = renderInfo?.profiles.find((profile) => profile.id === renderQuality)
  const currentRender = renderInfo?.current ?? null
  const renderReady = Boolean(currentRender?.exists && currentRender.matches_timeline)
  const selectedQualityDiffers = Boolean(
    currentRender?.exists && currentRender.quality !== renderQuality,
  )
  const fallbackRenderDimensions = renderDimensionsForRatio(canvasRatio)
  const renderWidth = renderReady && currentRender?.width
    ? currentRender.width
    : fallbackRenderDimensions.width
  const renderHeight = renderReady && currentRender?.height
    ? currentRender.height
    : fallbackRenderDimensions.height
  const renderDuration = Number(
    (renderReady ? currentRender?.duration_s : renderInfo?.duration_s) || totalSec,
  )
  const renderSummary = renderReady
    ? [
        'Ready',
        currentRender?.quality_label || currentRender?.quality || 'Compiled',
        formatMegabytes(currentRender?.size_mb),
        `${renderWidth}×${renderHeight}`,
        currentRender?.render_fps ? `${Number(currentRender.render_fps).toFixed(0)} fps` : '',
        fmtTime(renderDuration, 'whole'),
      ].filter(Boolean).join(' · ')
    : [
        selectedRenderProfile?.label || renderQuality,
        selectedRenderProfile?.estimated_size_mb
          ? `about ${formatMegabytes(selectedRenderProfile.estimated_size_mb)}`
          : '',
        `${renderWidth}×${renderHeight}`,
        fmtTime(renderDuration, 'whole'),
      ].filter(Boolean).join(' · ')

  return (
    <div className="vr panel-flat" onClick={(event) => {
      if (event.target === event.currentTarget) {
        setSelectedId('')
        setSelectedAudioId('')
        setSelectedTimelineIds(new Set())
      }
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
      {finalCut ? audioChunks.filter((chunk) => !chunk.excluded).map((chunk) => (
        <audio
          key={chunk.id}
          ref={(node) => {
            if (node) {
              node.volume = Math.min(1, effectiveVolume(chunk.volumePct, chunk.layerVolumePct))
              finalCutAudioRefs.current.set(chunk.id, node)
            }
            else finalCutAudioRefs.current.delete(chunk.id)
          }}
          src={mediaBlobs[chunk.src] ?? chunk.src}
          muted={Boolean(chunk.muted)}
          preload="auto"
        />
      )) : null}

      {loading ? <p className="vp-hint">Loading generated visual timeline...</p> : null}
      {error ? <p className="vp-hint">{error}</p> : null}

      {segments.length || workspaceAssets.length ? (
        <div
          ref={workspaceRef}
          className={`vr-layout ${isMobileReview ? 'is-mobile' : ''} ${draggedPanel ? 'is-dragging' : ''}`}
          style={renderState === 'rendering' ? { opacity: 0.4, pointerEvents: 'none' } : undefined}
        >
          {layoutRows.map((row, rowIndex) => (
            <Fragment key={row.id}>
              <div
                data-layout-id={row.id}
                // is-row-sized: this row has an explicit dragged height — the
                // video inside sizes to it (container units) instead of 78vh.
                className={`vr-layout-row vr-layout-row-${row.id}${rowSizes[row.id] ? ' is-row-sized' : ''} ${dropTarget?.kind === 'new-row' && dropTarget.rowId === row.id ? `is-drop-target drop-${dropTarget.position}` : ''}`}
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
                    : startNormalRowResize(event, row.id)}
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
                    : startNormalRowResize(event, row.id)}
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

      {timelineTooltip && !gestureView && !audioGestureView ? (
        <span
          className="vr-timeline-tooltip"
          style={{
            left: Math.min(window.innerWidth - 320, timelineTooltip.x + 12),
            top: Math.max(12, timelineTooltip.y - 42),
          }}
        >
          {timelineTooltip.text}
        </span>
      ) : null}

      {attachMenuOpen ? (
        <>
          <span className="vp-menu-backdrop" onClick={() => {
            setAttachMenuOpen(false)
            setAttachTarget(null)
          }} />
          <span className="vg-select-wrap">
            <span
              className="vp-menu"
              style={{ position: 'fixed', left: attachMenuPosition.left, top: attachMenuPosition.top, minWidth: 300 }}
            >
              <span className="vp-menu-h">ATTACH TO {attachTarget?.label.toUpperCase() || 'WORKSPACE'}</span>
              <button type="button" onClick={() => openRecentGenerations(attachTarget)}>
                <span>Recent generations…</span>
                <small>
                  {attachTarget
                    ? `Choose compatible media · also saved in Workspace`
                    : 'Choose current or previous generations from this episode'}
                </small>
              </button>
              <button type="button" onClick={() => {
                setAttachMenuOpen(false)
                setSelectedWorldKit(new Set())
                setWorldKitTarget(attachTarget)
                setWorldKitOpen(true)
              }}>
                <span>From World Kit…</span>
                <small>
                  {attachTarget?.kind === 'audio'
                    ? `Choose reference audio · also saved in Workspace`
                    : attachTarget
                      ? `Choose visual references · also saved in Workspace`
                      : 'Choose references; nothing is placed on the timeline yet'}
                </small>
              </button>
              <button type="button" onClick={() => {
                setAttachMenuOpen(false)
                setUploadTarget(attachTarget)
                if (finalCutUploadRef.current) {
                  finalCutUploadRef.current.accept = attachTarget?.kind === 'audio'
                    ? 'audio/mpeg,audio/wav,audio/mp4,audio/aac,.mp3,.wav,.m4a,.aac'
                    : attachTarget?.kind === 'video'
                      ? 'video/mp4,video/webm,video/quicktime,image/png,image/jpeg,image/webp,image/gif'
                      : 'video/mp4,video/webm,video/quicktime,image/png,image/jpeg,image/webp,image/gif,audio/mpeg,audio/wav,audio/mp4,audio/aac,.mp3,.wav,.m4a,.aac'
                }
                finalCutUploadRef.current?.click()
              }}>
                <span>From computer…</span>
                <small>
                  {attachTarget?.kind === 'audio'
                    ? 'MP3, WAV, M4A, or AAC · also saved in Workspace'
                    : attachTarget
                      ? 'Image or video · also saved in Workspace'
                      : 'Image, video, or audio · stored in this episode’s Workspace'}
                </small>
              </button>
            </span>
          </span>
        </>
      ) : null}

      {workspaceLayoutMenuOpen ? (
        <>
          <span className="vp-menu-backdrop" onClick={() => setWorkspaceLayoutMenuOpen(false)} />
          <span
            className="vp-menu"
            style={{
              position: 'fixed',
              left: workspaceLayoutMenuPosition.left,
              top: workspaceLayoutMenuPosition.top,
              minWidth: 240,
            }}
          >
            <span className="vp-menu-h">WORKSPACE LAYOUT</span>
            <button type="button" className={galleryFit === 'normal' ? 'on' : ''} onClick={() => chooseGalleryFit('normal')}>
              <span>Standard tiles</span>
              <small>Generous, consistent media size</small>
            </button>
            <button type="button" className={galleryFit === 'width' ? 'on' : ''} onClick={() => chooseGalleryFit('width')}>
              <span>Fill width</span>
              <small>Use the full width of each row</small>
            </button>
            <button type="button" className={galleryFit === 'all' ? 'on' : ''} onClick={() => chooseGalleryFit('all')}>
              <span>Fit all</span>
              <small>Pack every item into the visible panel</small>
            </button>
            <span className="vp-menu-div" />
            <button
              type="button"
              disabled={!currentWorkspaceSectionHeights.visuals && !currentWorkspaceSectionHeights.audio}
              onClick={resetWorkspaceSectionHeights}
            >
              <span>Reset row heights</span>
              <small>Fit Visuals and Audio to their content</small>
            </button>
          </span>
        </>
      ) : null}

      {workspaceContextMenu ? (() => {
        const asset = workspaceAssets.find((candidate) => candidate.id === workspaceContextMenu.assetId)
        if (!asset) return null
        const label = asset.label || asset.shot_id || asset.worldkit_ref || asset.id
        const usage = workspaceUsageForAsset(asset)
        return (
          <>
            <span
              className="vp-menu-backdrop"
              onClick={() => setWorkspaceContextMenu(null)}
              onContextMenu={(event) => {
                event.preventDefault()
                setWorkspaceContextMenu(null)
              }}
            />
            <span
              className="vp-menu"
              style={{ left: workspaceContextMenu.x, top: workspaceContextMenu.y, minWidth: 220 }}
            >
              <span className="vp-menu-h">{label}</span>
              <button type="button" onClick={() => {
                setWorkspaceContextMenu(null)
                downloadWorkspaceAsset(asset)
              }}>
                Download
              </button>
              <span className="vp-menu-div" style={{ display: 'block' }} />
              <button
                type="button"
                className="danger"
                disabled={Boolean(timelineBusy)}
                onClick={() => requestWorkspaceAssetRemoval(asset)}
              >
                <span>Remove from Workspace</span>
                <small>
                  {usage.affectedPlacements
                    ? `Also removes ${usage.affectedPlacements} timeline placement${usage.affectedPlacements === 1 ? '' : 's'}`
                    : 'The original source remains available'}
                </small>
              </button>
            </span>
          </>
        )
      })() : null}

      {workspaceRemoveConfirm ? (() => {
        const asset = workspaceAssets.find((candidate) => candidate.id === workspaceRemoveConfirm.assetId)
        if (!asset) return null
        const label = asset.label || asset.shot_id || asset.worldkit_ref || asset.id
        const linkedPlacements = Math.max(
          0,
          workspaceRemoveConfirm.affectedPlacements - workspaceRemoveConfirm.directPlacements,
        )
        return (
          <div className="modal-scrim" onClick={() => setWorkspaceRemoveConfirm(null)}>
            <div className="confirm-modal" onClick={(event) => event.stopPropagation()}>
              <span className="need">WORKSPACE</span>
              <h3>Remove from Workspace and timeline?</h3>
              <p>
                <strong>{label}</strong> is used in {workspaceRemoveConfirm.directPlacements} timeline placement{workspaceRemoveConfirm.directPlacements === 1 ? '' : 's'}.
                {' '}Removing it from Workspace will remove {workspaceRemoveConfirm.affectedPlacements === 1 ? 'that placement' : `all ${workspaceRemoveConfirm.affectedPlacements} affected placements`} too.
              </p>
              {linkedPlacements ? (
                <p>
                  This includes {linkedPlacements} linked clip{linkedPlacements === 1 ? '' : 's'}.
                </p>
              ) : null}
              <p>The original generation, World Kit reference, or uploaded source file will not be deleted.</p>
              <div className="actions">
                <button type="button" onClick={() => setWorkspaceRemoveConfirm(null)}>Cancel</button>
                <button
                  type="button"
                  className="danger"
                  disabled={Boolean(timelineBusy)}
                  onClick={() => void removeWorkspaceAsset(asset)}
                >
                  Remove from both
                </button>
              </div>
            </div>
          </div>
        )
      })() : null}

      {timelineMenuOpen ? (
        <>
          <span className="vp-menu-backdrop" onClick={() => setTimelineMenuOpen(false)} />
          <span
            className="vp-menu"
            style={{ left: timelineMenuPosition.left, top: timelineMenuPosition.top, minWidth: 190 }}
          >
            <span className="vp-menu-h">TIMELINE</span>
            <button type="button" onClick={collapseTimelinePanel}>Collapse timeline</button>
            <span className="vp-menu-div" style={{ display: 'block' }} />
            <button type="button" onClick={() => { setTimelineMenuOpen(false); void addFinalCutLayer('video') }}>Add video layer</button>
            <button type="button" onClick={() => { setTimelineMenuOpen(false); void addFinalCutLayer('audio') }}>Add audio layer</button>
            <span className="vp-menu-div" style={{ display: 'block' }} />
            <button type="button" onClick={() => { setTimelineMenuOpen(false); void resetToFullClips() }}>Reset to full clips</button>
          </span>
        </>
      ) : null}

      {layerContextMenu && finalCut ? (() => {
        const layer = finalCut.layers.find((candidate) => candidate.id === layerContextMenu.layerId)
        if (!layer) return null
        const sameKind = layer.kind === 'video' ? videoLayersTopFirst : audioLayers
        const index = sameKind.findIndex((candidate) => candidate.id === layer.id)
        const primaryVideoId = finalCut.layers.find((candidate) => candidate.id === 'visuals')?.id
          ?? finalCut.layers.find((candidate) => candidate.kind === 'video')?.id
        return (
          <>
            <span className="vp-menu-backdrop" onClick={() => setLayerContextMenu(null)} onContextMenu={(event) => {
              event.preventDefault()
              setLayerContextMenu(null)
            }} />
            <span
              className="vp-menu vr-layer-context-menu"
              style={{ left: layerContextMenu.x, top: layerContextMenu.y, minWidth: 220 }}
            >
              <span className="vp-menu-h">{layer.label}</span>
              {layerContextMenu.rename ? (
                <form
                  className="vr-layer-rename"
                  onSubmit={(event) => {
                    event.preventDefault()
                    const input = event.currentTarget.elements.namedItem('layer-name') as HTMLInputElement | null
                    if (input) void renameFinalCutLayer(layer.id, input.value)
                  }}
                >
                  <input name="layer-name" defaultValue={layer.label} maxLength={36} autoFocus />
                  <button type="submit">Save name</button>
                </form>
              ) : (
                <>
                  <button type="button" onClick={() => setLayerContextMenu((current) => current ? { ...current, rename: true } : current)}>
                    Rename layer…
                  </button>
                  <button type="button" onClick={() => { setLayerContextMenu(null); void toggleFinalCutLayer(layer.id) }}>
                    {layer.muted ? 'Unmute layer' : 'Mute layer'}
                  </button>
                  <button
                    type="button"
                    onClick={() => openVolumeEditor(
                      'layer',
                      layer.id,
                      layer.label,
                      layer.volume_pct,
                      layerContextMenu.x,
                      layerContextMenu.y,
                    )}
                  >
                    Volume… <small>{Math.round(Number(layer.volume_pct ?? 100))}%</small>
                  </button>
                  <button type="button" onClick={() => { setLayerContextMenu(null); void toggleFinalCutLayerLock(layer.id) }}>
                    {layer.locked ? 'Unlock layer' : 'Lock layer'}
                  </button>
                  <div className="vp-menu-div" />
                  <button
                    type="button"
                    className={layer.edit_mode === 'magnetic' ? 'on' : ''}
                    onClick={() => void setFinalCutLayerBehavior(
                      layer.id,
                      { edit_mode: 'magnetic' },
                      `${layer.label}: clips now form a magnetic sequence.`,
                    )}
                  >
                    <span>Magnetic sequence</span>
                    <small>Insert/delete closes or opens time as one sequence</small>
                  </button>
                  <button
                    type="button"
                    className={layer.edit_mode !== 'magnetic' ? 'on' : ''}
                    onClick={() => void setFinalCutLayerBehavior(
                      layer.id,
                      { edit_mode: 'free' },
                      `${layer.label}: clips now position freely.`,
                    )}
                  >
                    <span>Free positioning</span>
                    <small>Empty time and overlaps are allowed</small>
                  </button>
                  <button
                    type="button"
                    className={layer.sync_lock ? 'on' : ''}
                    onClick={() => void setFinalCutLayerBehavior(
                      layer.id,
                      { sync_lock: !layer.sync_lock },
                      `${layer.label}: ${layer.sync_lock ? 'no longer follows' : 'now follows'} main-timeline ripples.`,
                    )}
                  >
                    <span>{layer.sync_lock ? 'Stop following main timeline' : 'Follow main timeline'}</span>
                    <small>Keep this row aligned when Vid 1 changes length</small>
                  </button>
                  {layer.items.some((item) => item.media_kind === 'gap') ? (
                    <button type="button" onClick={() => void closeFinalCutLayerGaps(layer.id, layer.label)}>
                      <span>Close visible gaps</span>
                      <small>Pull later linked clips left</small>
                    </button>
                  ) : null}
                  <div className="vp-menu-div" />
                  <button type="button" disabled={index <= 0} onClick={() => { setLayerContextMenu(null); void reorderFinalCutLayerStack(layer.id, -1) }}>
                    Move layer up
                  </button>
                  <button type="button" disabled={index < 0 || index >= sameKind.length - 1} onClick={() => { setLayerContextMenu(null); void reorderFinalCutLayerStack(layer.id, 1) }}>
                    Move layer down
                  </button>
                  <div className="vp-menu-div" />
                  <button type="button" disabled={layer.locked || !layer.items.length} onClick={() => void clearFinalCutLayer(layer.id)}>
                    Clear layer
                  </button>
                  {layer.id !== primaryVideoId ? (
                    <button type="button" className="danger" disabled={layer.locked} onClick={() => void deleteFinalCutLayer(layer.id)}>
                      Delete layer
                    </button>
                  ) : null}
                </>
              )}
            </span>
          </>
        )
      })() : null}

      {volumeEditor ? (
        <>
          <span className="vp-menu-backdrop" onClick={() => setVolumeEditor(null)} />
          <form
            className="vp-menu vr-volume-editor"
            style={{ left: volumeEditor.x, top: volumeEditor.y }}
            onSubmit={(event) => {
              event.preventDefault()
              void saveVolumeEditor()
            }}
          >
            <span className="vp-menu-h">{volumeEditor.label}</span>
            <label>
              <span>Volume</span>
              <output>{Math.round(volumeEditor.value)}%</output>
            </label>
            <input
              type="range"
              min="0"
              max="200"
              step="1"
              value={volumeEditor.value}
              autoFocus
              onChange={(event) => {
                const value = Number(event.currentTarget.value)
                setVolumeEditor((current) => (
                  current ? { ...current, value } : current
                ))
              }}
            />
            <div className="vr-volume-actions">
              <button
                type="button"
                disabled={Math.abs(volumeEditor.value - 100) < 0.5}
                onClick={() => setVolumeEditor((current) => current ? { ...current, value: 100 } : current)}
              >
                Reset
              </button>
              <button type="button" onClick={() => setVolumeEditor(null)}>Cancel</button>
              <button type="submit" className="on" disabled={Math.abs(volumeEditor.value - volumeEditor.initial) < 0.5}>
                Apply
              </button>
            </div>
          </form>
        </>
      ) : null}

      {audioFadeEditor ? (
        <>
          <span className="vp-menu-backdrop" onClick={() => setAudioFadeEditor(null)} />
          <form
            className="vp-menu vr-volume-editor vr-audio-fade-editor"
            style={{ left: audioFadeEditor.x, top: audioFadeEditor.y }}
            onSubmit={(event) => {
              event.preventDefault()
              void saveAudioFadeEditor()
            }}
          >
            <span className="vp-menu-h">{audioFadeEditor.label}</span>
            <label>
              <span>Fade in</span>
              <output>{audioFadeEditor.fadeIn.toFixed(1)}s</output>
            </label>
            <input
              type="range"
              min="0"
              max={Math.max(0, audioFadeEditor.duration - audioFadeEditor.fadeOut)}
              step="0.1"
              value={audioFadeEditor.fadeIn}
              autoFocus
              onChange={(event) => {
                const fadeIn = Number(event.currentTarget.value)
                setAudioFadeEditor((current) => (
                  current ? { ...current, fadeIn } : current
                ))
              }}
            />
            <label>
              <span>Fade out</span>
              <output>{audioFadeEditor.fadeOut.toFixed(1)}s</output>
            </label>
            <input
              type="range"
              min="0"
              max={Math.max(0, audioFadeEditor.duration - audioFadeEditor.fadeIn)}
              step="0.1"
              value={audioFadeEditor.fadeOut}
              onChange={(event) => {
                const fadeOut = Number(event.currentTarget.value)
                setAudioFadeEditor((current) => (
                  current ? { ...current, fadeOut } : current
                ))
              }}
            />
            <div className="vr-volume-actions">
              <button
                type="button"
                disabled={audioFadeEditor.fadeIn === 0 && audioFadeEditor.fadeOut === 0}
                onClick={() => setAudioFadeEditor((current) => (
                  current ? { ...current, fadeIn: 0, fadeOut: 0 } : current
                ))}
              >
                Reset
              </button>
              <button type="button" onClick={() => setAudioFadeEditor(null)}>Cancel</button>
              <button
                type="submit"
                className="on"
                disabled={
                  Math.abs(audioFadeEditor.fadeIn - audioFadeEditor.initialFadeIn) < 0.01
                  && Math.abs(audioFadeEditor.fadeOut - audioFadeEditor.initialFadeOut) < 0.01
                }
              >
                Apply
              </button>
            </div>
          </form>
        </>
      ) : null}

      {recentGenerationsOpen ? (
        <div className="modal-scrim" onClick={closeRecentGenerations}>
          <div className="confirm-modal vg-ref-modal vr-recent-picker" onClick={(event) => event.stopPropagation()}>
            <div className="vg-ref-modal-head">
              <div style={{ minWidth: 0, flex: 1 }}>
                <b>{recentGenerationTarget ? `Add recent generations to ${recentGenerationTarget.label}` : 'Add recent generations to Workspace'}</b>
                <p className="vp-hint" style={{ marginTop: 4 }}>
                  {recentGenerationTarget
                    ? 'Choose compatible media. It is saved in Workspace and placed on the selected layer at the playhead.'
                    : 'Choose current or previous generations from this episode. Nothing is placed on the timeline yet.'}
                </p>
              </div>
              <button type="button" className="vp-undo" onClick={closeRecentGenerations}>Close</button>
            </div>
            <div className="vr-recent-toolbar">
              <label>
                <span>Grouping</span>
                <select
                  value={recentGenerationGroup}
                  onChange={(event) => setRecentGenerationGroup(event.target.value)}
                >
                  <option value="all">All generations</option>
                  <option value="current">Current shots</option>
                  <option value="deleted">Deleted shots</option>
                  {recentGenerationGroupOptions.map((groupId) => (
                    <option key={groupId} value={groupId}>{groupId}</option>
                  ))}
                </select>
              </label>
              <div className="vr-recent-type-filter" aria-label="Media types">
                {(['video', 'image', 'audio'] as const).map((kind) => {
                  const incompatible = Boolean(
                    recentGenerationTarget
                    && ((recentGenerationTarget.kind === 'audio') !== (kind === 'audio')),
                  )
                  return (
                    <button
                      type="button"
                      key={kind}
                      className={recentGenerationTypes.has(kind) && !incompatible ? 'on' : ''}
                      disabled={incompatible}
                      aria-pressed={recentGenerationTypes.has(kind) && !incompatible}
                      onClick={() => toggleRecentGenerationType(kind)}
                    >
                      {kind === 'video' ? 'Video' : kind === 'image' ? 'Image' : 'Audio'}
                    </button>
                  )
                })}
              </div>
              <label>
                <span>Sort</span>
                <select
                  value={recentGenerationSort}
                  onChange={(event) => setRecentGenerationSort(event.target.value as RecentGenerationSort)}
                >
                  <option value="default">Default order</option>
                  <option value="newest">Newest first</option>
                  <option value="oldest">Oldest first</option>
                  <option value="name">Name</option>
                </select>
              </label>
            </div>
            <div className="vr-strip vr-recent-picker-grid">
              {recentGenerationLibrary === null ? (
                <p className="vp-hint vr-recent-loading"><span className="spin" /> Loading recent generations…</p>
              ) : null}
              {recentGenerationError ? (
                <div className="vr-recent-empty">
                  <p className="vp-hint">{recentGenerationError}</p>
                  <button type="button" className="vp-undo" onClick={() => void loadRecentGenerationLibrary()}>Try again</button>
                </div>
              ) : null}
              {recentGenerationLibrary !== null && !recentGenerationError && visibleRecentGenerations.map(({ group, take, takeIndex }) => {
                const attached = recentGenerationAlreadyAttached(take)
                const selected = selectedRecentGenerations.has(take.path)
                const source = contentSrc(take.path)
                const takeLabel = take.active
                  ? 'Current'
                  : formatGenerationStamp(take.stamp) || `Previous ${takeIndex + 1}`
                return (
                  <button
                    type="button"
                    key={take.path}
                    className={`vr-recent-tile ${selected ? 'on' : ''} ${attached ? 'already' : ''} ${take.kind}`}
                    disabled={attached}
                    aria-pressed={selected}
                    title={`${group.id} · ${take.kind} · ${attached ? 'Already in Workspace' : takeLabel}`}
                    onMouseEnter={(event) => {
                      const video = event.currentTarget.querySelector('video')
                      if (video) void video.play().catch(() => { /* hover preview may be browser-blocked */ })
                    }}
                    onMouseLeave={(event) => {
                      const video = event.currentTarget.querySelector('video')
                      if (!video) return
                      video.pause()
                      try { video.currentTime = 0.01 } catch { /* metadata may not be ready yet */ }
                    }}
                    onClick={() => {
                      setSelectedRecentGenerations((current) => {
                        const next = new Set(current)
                        if (next.has(take.path)) next.delete(take.path)
                        else next.add(take.path)
                        return next
                      })
                    }}
                  >
                    {take.kind === 'video' ? (
                      <video
                        src={source}
                        muted
                        playsInline
                        preload="metadata"
                        onLoadedMetadata={(event) => {
                          const video = event.currentTarget
                          if (video.videoWidth && video.videoHeight) {
                            video.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`
                          }
                        }}
                      />
                    ) : take.kind === 'image' ? (
                      <img
                        src={source}
                        alt=""
                        onLoad={(event) => {
                          const image = event.currentTarget
                          if (image.naturalWidth && image.naturalHeight) {
                            image.style.aspectRatio = `${image.naturalWidth} / ${image.naturalHeight}`
                          }
                        }}
                      />
                    ) : (
                      <span className="vr-recent-audio">
                        <i className="vr-speaker-icon" aria-hidden="true" />
                        <small>{take.original_name || 'Generated audio'}</small>
                      </span>
                    )}
                    <i className={`vr-media-kind ${take.kind}`}>
                      {take.kind === 'video' ? '▶' : take.kind === 'image' ? '▧' : <span className="vr-speaker-icon" aria-hidden="true" />}
                    </i>
                    {attached ? <i className="vr-recent-attached">Already in Workspace</i> : null}
                    <b>{group.id}</b>
                    <small>{take.kind} · {takeLabel}{group.on_board === false ? ' · deleted shot' : ''}</small>
                  </button>
                )
              })}
              {recentGenerationLibrary !== null && !recentGenerationError && !visibleRecentGenerations.length ? (
                <div className="vr-recent-empty">
                  <p className="vp-hint">No generations match this grouping and media filter.</p>
                  <button type="button" className="vp-undo" onClick={() => {
                    setRecentGenerationGroup('all')
                    setRecentGenerationTypes(new Set(['image', 'video', 'audio']))
                  }}>Show all compatible media</button>
                </div>
              ) : null}
            </div>
            <div className="vg-ref-modal-actions">
              <span className="vp-hint">
                {selectedRecentGenerations.size
                  ? `${selectedRecentGenerations.size} selected`
                  : 'Nothing selected'}
              </span>
              {selectedRecentGenerations.size ? (
                <button type="button" className="vp-undo" onClick={() => setSelectedRecentGenerations(new Set())}>Clear</button>
              ) : null}
              <button type="button" className="vp-undo" onClick={closeRecentGenerations}>Cancel</button>
              <button
                type="button"
                className="vp-undo"
                disabled={!selectedRecentGenerations.size || !!timelineBusy}
                onClick={() => void attachSelectedRecentGenerations()}
              >
                {timelineBusy === 'recent'
                  ? <><span className="spin" /> Adding…</>
                  : `Add to ${recentGenerationTarget?.label || 'Workspace'}`}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {worldKitOpen ? (
        <div className="modal-scrim" onClick={() => {
          setWorldKitOpen(false)
          setWorldKitTarget(null)
        }}>
          <div className="confirm-modal vg-ref-modal vr-worldkit-picker" onClick={(event) => event.stopPropagation()}>
            <div className="vg-ref-modal-head">
              <div style={{ minWidth: 0, flex: 1 }}>
                <b>{worldKitTarget?.kind === 'audio' ? 'Attach audio from World Kit' : 'Attach from World Kit'}</b>
                <p className="vp-hint" style={{ marginTop: 4 }}>
                  {worldKitTarget
                    ? `Choose one reference, or hold Shift to select several. Each is saved in Workspace and placed on ${worldKitTarget.label} at the playhead.`
                    : 'Choose one reference, or hold Shift to select several. They enter the Workspace only.'}
                </p>
              </div>
              <button type="button" className="vp-undo" onClick={() => {
                setWorldKitOpen(false)
                setWorldKitTarget(null)
              }}>Close</button>
            </div>
            <div className="vr-strip vr-worldkit-picker-grid">
              {worldKitVisuals.filter((item) => (
                worldKitTarget?.kind === 'audio'
                  ? Boolean(worldKitAudioPath(item))
                  : Boolean(item.media_path || item.image_path)
              )).map((item) => {
                const path = worldKitTarget?.kind === 'audio'
                  ? worldKitAudioPath(item)
                  : item.media_path || item.image_path || ''
                const kind = workspaceMediaKindFromPath(path)
                const attached = workspaceAssets.some((asset) => asset.worldkit_ref === item.name)
                return (
                  <button
                    type="button"
                    key={item.name}
                    className={`${selectedWorldKit.has(item.name) ? 'on' : ''} ${attached ? 'already' : ''}`}
                    disabled={attached}
                    title={`${item.name} · ${item.kind}${attached ? ' · already in Workspace' : ''}`}
                    onClick={(event) => {
                      setSelectedWorldKit((current) => {
                        if (!event.shiftKey) return new Set([item.name])
                        const next = new Set(current)
                        if (next.has(item.name)) next.delete(item.name)
                        else next.add(item.name)
                        return next
                      })
                    }}
                  >
                    {kind === 'video' ? (
                      <video
                        src={contentSrc(path)}
                        muted
                        playsInline
                        preload="metadata"
                        onLoadedMetadata={(event) => {
                          const video = event.currentTarget
                          if (video.videoWidth && video.videoHeight) {
                            video.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`
                          }
                        }}
                      />
                    ) : kind === 'image' ? (
                      <img
                        src={contentSrc(path)}
                        alt=""
                        onLoad={(event) => {
                          const image = event.currentTarget
                          if (image.naturalWidth && image.naturalHeight) {
                            image.style.aspectRatio = `${image.naturalWidth} / ${image.naturalHeight}`
                          }
                        }}
                      />
                    ) : (
                      <span className="vr-worldkit-audio">
                        <i className="vr-speaker-icon" aria-hidden="true" />
                        <b>{item.name}</b>
                        <small>{item.audio_samples?.length || 1} sample{item.audio_samples?.length === 1 ? '' : 's'}</small>
                      </span>
                    )}
                    <i className={`vr-media-kind ${kind}`}>
                      {kind === 'video' ? '▶' : kind === 'image' ? '▧' : <span className="vr-speaker-icon" aria-hidden="true" />}
                    </i>
                    {attached ? <i className="vr-recent-attached">Already in Workspace</i> : null}
                    <b>{item.name}</b>
                    <small>{item.kind}{attached ? ' · Already in Workspace' : ''}</small>
                  </button>
                )
              })}
              {!worldKitVisuals.some((item) => (
                worldKitTarget?.kind === 'audio'
                  ? Boolean(worldKitAudioPath(item))
                  : Boolean(item.media_path || item.image_path)
              )) ? (
                <p className="vp-hint">
                  {worldKitTarget?.kind === 'audio'
                    ? 'No World Kit references have audio samples yet.'
                    : 'No World Kit images or videos are available yet.'}
                </p>
              ) : null}
            </div>
            <div className="vg-ref-modal-actions">
              <span className="vp-hint">{selectedWorldKit.size ? `${selectedWorldKit.size} selected` : 'Nothing selected'}</span>
              <button type="button" className="vp-undo" onClick={() => {
                setWorldKitOpen(false)
                setWorldKitTarget(null)
              }}>Cancel</button>
              <button type="button" className="vp-undo" disabled={!selectedWorldKit.size || !!timelineBusy} onClick={() => void attachSelectedWorldKit()}>
                {timelineBusy === 'worldkit'
                  ? <><span className="spin" /> Attaching…</>
                  : `Attach to ${worldKitTarget?.label || 'Workspace'}`}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {timelineContextMenu && finalCut ? (() => {
        const segment = timelineContextMenu.kind === 'video'
          ? segments.find((item) => item.id === timelineContextMenu.id) ?? null
          : null
        const audio = timelineContextMenu.kind === 'audio'
          ? audioChunks.find((item) => item.id === timelineContextMenu.id) ?? null
          : null
        if (!segment && !audio) return null
        const contextId = segment?.id || audio?.id || ''
        const contextIds = selectedTimelineIds.has(contextId)
          ? [...selectedTimelineIds]
          : [contextId]
        const contextItems = finalCut.layers.flatMap((layer) => (
          layer.items
            .filter((item) => contextIds.includes(item.id))
            .map((item) => ({ layer, item }))
        ))
        const allContextItemsLocked = contextItems.length > 0 && contextItems.every(({ item }) => Boolean(item.locked))
        const contextEditLocked = contextItems.some(({ layer, item }) => Boolean(layer.locked || item.locked))
        const contextHasLink = contextItems.some(({ item }) => Boolean(item.link_group_id))
        const contextLayer = contextItems.find(({ item }) => item.id === contextId)?.layer
        const contextItem = contextItems.find(({ item }) => item.id === contextId)?.item
        const magneticDelete = contextIds.length === 1 && contextLayer?.edit_mode === 'magnetic'
        const canRestoreFullClip = Boolean(
          segment
          && (
            segment.trimIn > 0.01
            || (
              Number(segment.clipDuration || 0) > 0
              && Number(segment.trimOut ?? segment.clipDuration) < Number(segment.clipDuration) - 0.01
            )
          ),
        )
        return (
          <>
            <div className="vp-menu-backdrop" onClick={() => setTimelineContextMenu(null)} onContextMenu={(event) => { event.preventDefault(); setTimelineContextMenu(null) }} />
            <div
              ref={timelineContextMenuRef}
              className="vp-menu vr-clip-context-menu"
              style={{ left: timelineContextMenu.x, top: timelineContextMenu.y }}
            >
              <div className="vp-menu-h">
                {contextIds.length > 1
                  ? `${contextIds.length} clips selected`
                  : segment
                    ? segment.sourceLabel || segment.displayLabel || segment.pid
                    : `${shortTimelineLabel(String(audio?.title || '').replace(/\s+audio$/i, ''), 'Audio', 22)} audio · ${Number(audio?.duration || 0).toFixed(1)}s`}
              </div>
              {segment?.mediaType === 'video' && !segment.audioDetached ? (
                <button type="button" disabled={contextEditLocked} onClick={() => { setTimelineContextMenu(null); void separateClipAudio(segment) }}>
                  <span>Separate audio</span>
                  <small>Creates a linked Aud clip and removes sound from this video</small>
                </button>
              ) : null}
              {segment?.mediaType === 'video' && segment.audioDetached ? (
                <button type="button" disabled={contextEditLocked} onClick={() => { setTimelineContextMenu(null); void reattachClipAudio(segment) }}>
                  <span>Reattach audio</span>
                  <small>Restores embedded sound; the Aud file stays in Workspace</small>
                </button>
              ) : null}
              <button
                type="button"
                disabled={contextItems.every(({ layer }) => Boolean(layer.locked))}
                onClick={() => { setTimelineContextMenu(null); void toggleFinalCutItemLock(contextIds) }}
              >
                {allContextItemsLocked ? 'Unlock clip' : 'Lock clip'}
              </button>
              {segment ? (
                <button type="button" disabled={contextEditLocked} onClick={() => { setTimelineContextMenu(null); void splitFinalCutItemAtPlayhead(segment.id) }}>
                  Split at playhead
                </button>
              ) : null}
              {segment && canRestoreFullClip ? (
                <button type="button" disabled={contextEditLocked} onClick={() => {
                  setTimelineContextMenu(null)
                  void sendTrim(segment, 0, Number(segment.clipDuration || segment.duration), true)
                }}>
                  Restore full clip
                </button>
              ) : null}
              {segment ? <div className="vp-menu-div" /> : null}
              {contextIds.length >= 2 ? (
                <button type="button" disabled={contextEditLocked} onClick={() => void linkFinalCutItems(contextIds)}>
                  <span>Link selected clips</span>
                  <small>Move, ripple, and delete them together</small>
                </button>
              ) : null}
              {contextHasLink ? (
                <button type="button" disabled={contextEditLocked} onClick={() => void linkFinalCutItems(contextIds, true)}>
                  Unlink selected clip{contextIds.length === 1 ? '' : 's'}
                </button>
              ) : null}
              <button type="button" disabled={contextEditLocked} onClick={() => { setTimelineContextMenu(null); void duplicateFinalCutItems(contextIds) }}>
                Duplicate
              </button>
              <button type="button" onClick={() => { setTimelineContextMenu(null); copyFinalCutItems(contextIds) }}>
                Copy
              </button>
              {clipClipboard ? (
                <button type="button" onClick={() => { setTimelineContextMenu(null); void pasteFinalCutItems() }}>
                  Paste at playhead
                </button>
              ) : null}
              {segment ? (
                <>
                  <div className="vp-menu-div" />
                  {!segment.audioDetached ? (
                    <>
                      <button type="button" disabled={contextEditLocked} onClick={() => { setTimelineContextMenu(null); void toggleFinalCutItem(segment, 'muted') }}>
                        {segment.muted ? 'Unmute clip' : 'Mute clip'}
                      </button>
                      <button
                        type="button"
                        disabled={contextEditLocked}
                        onClick={() => openVolumeEditor(
                          'item',
                          segment.id,
                          segment.displayLabel || segment.pid,
                          contextItem?.volume_pct,
                          timelineContextMenu.x,
                          timelineContextMenu.y,
                        )}
                      >
                        Volume… <small>{Math.round(Number(contextItem?.volume_pct ?? 100))}%</small>
                      </button>
                      <button
                        type="button"
                        disabled={contextEditLocked}
                        onClick={() => openAudioFadeEditor(
                          segment.id,
                          segment.displayLabel || segment.pid,
                          segment.duration,
                          contextItem?.audio_fade_in_s,
                          contextItem?.audio_fade_out_s,
                          timelineContextMenu.x,
                          timelineContextMenu.y,
                        )}
                      >
                        Audio fade…
                        <small>
                          {Number(contextItem?.audio_fade_in_s || 0).toFixed(1)}s in · {Number(contextItem?.audio_fade_out_s || 0).toFixed(1)}s out
                        </small>
                      </button>
                    </>
                  ) : null}
                  <button type="button" disabled={contextEditLocked} onClick={() => { setTimelineContextMenu(null); void toggleFinalCutItem(segment, 'excluded') }}>
                    {segment.excluded ? 'Include in render' : 'Exclude from render'}
                  </button>
                  {finalCut.layers.filter((layer) => layer.kind === 'video' && layer.id !== segment.layerId).map((layer) => (
                    <button type="button" disabled={contextEditLocked || Boolean(layer.locked)} key={`ctx-${segment.id}-${layer.id}`} onClick={() => { setTimelineContextMenu(null); void moveFinalCutItemToLayer(segment.id, layer.id, segment.pid) }}>
                      Move to {layer.label}
                    </button>
                  ))}
                </>
              ) : audio ? (
                <>
                  <button type="button" disabled={contextEditLocked} onClick={() => { setTimelineContextMenu(null); void toggleFinalCutAudioItem(audio, 'muted') }}>
                    {audio.muted ? 'Unmute audio' : 'Mute audio'}
                  </button>
                  <button
                    type="button"
                    disabled={contextEditLocked}
                    onClick={() => openVolumeEditor(
                      'item',
                      audio.id,
                      `${shortTimelineLabel(audio.title.replace(/\s+audio$/i, ''), 'Audio', 22)} audio`,
                      contextItem?.volume_pct,
                      timelineContextMenu.x,
                      timelineContextMenu.y,
                    )}
                  >
                    Volume… <small>{Math.round(Number(contextItem?.volume_pct ?? 100))}%</small>
                  </button>
                  <button
                    type="button"
                    disabled={contextEditLocked}
                    onClick={() => openAudioFadeEditor(
                      audio.id,
                      `${shortTimelineLabel(audio.title.replace(/\s+audio$/i, ''), 'Audio', 22)} audio`,
                      Number(audio.duration || audio.end - audio.start),
                      contextItem?.audio_fade_in_s,
                      contextItem?.audio_fade_out_s,
                      timelineContextMenu.x,
                      timelineContextMenu.y,
                    )}
                  >
                    Audio fade…
                    <small>
                      {Number(contextItem?.audio_fade_in_s || 0).toFixed(1)}s in · {Number(contextItem?.audio_fade_out_s || 0).toFixed(1)}s out
                    </small>
                  </button>
                  <button type="button" disabled={contextEditLocked} onClick={() => { setTimelineContextMenu(null); void toggleFinalCutAudioItem(audio, 'excluded') }}>
                    {audio.excluded ? 'Include in render' : 'Exclude from render'}
                  </button>
                  {finalCut.layers.filter((layer) => layer.kind === 'audio' && layer.id !== audio.layerId).map((layer) => (
                    <button type="button" disabled={contextEditLocked || Boolean(layer.locked)} key={`ctx-${audio.id}-${layer.id}`} onClick={() => { setTimelineContextMenu(null); void moveFinalCutItemToLayer(audio.id, layer.id, `${audio.title} audio`) }}>
                      Move to {layer.label}
                    </button>
                  ))}
                </>
              ) : null}
              <div className="vp-menu-div" />
              {magneticDelete ? (
                <>
                  <button type="button" disabled={contextEditLocked} className="danger" onClick={() => void deleteFinalCutItems(contextIds, segment?.pid || `${audio?.title} audio`, 'close-gap')}>
                    <span>{contextHasLink ? 'Remove linked clips and close gap' : 'Remove and close gap'}</span>
                    <small>{contextHasLink ? 'Both linked placements are removed; later media moves left' : 'Later clips and linked media move left'}</small>
                  </button>
                  <button type="button" disabled={contextEditLocked} onClick={() => void deleteFinalCutItems(contextIds, segment?.pid || `${audio?.title} audio`, 'leave-gap')}>
                    <span>{contextHasLink ? 'Remove linked clips and leave gap' : 'Remove and leave gap'}</span>
                    <small>{contextHasLink ? 'Both linked placements are removed; keep empty time' : 'Keep a visible empty-time block'}</small>
                  </button>
                </>
              ) : (
                <button type="button" disabled={contextEditLocked} className="danger" onClick={() => void deleteFinalCutItems(contextIds, segment?.pid || `${audio?.title} audio`)}>
                  <span>{contextHasLink ? 'Remove linked clips from timeline' : 'Remove from timeline'}</span>
                  <small>{contextHasLink ? 'Both linked placements are removed; files remain in Workspace' : 'File remains available in Workspace'}</small>
                </button>
              )}
            </div>
          </>
        )
      })() : null}

      {segments.length ? (
        <section className="vr-export">
          <div className="vr-export-run">
            <div className="vr-export-status">
              <span className="vr-export-kicker">Export</span>
              {renderState === 'rendering' ? (
                <span className="voice-run-progress">
                  <span className="voice-run-status">
                    {renderStatus || 'Compiling'}{renderPct != null ? ` · ${renderPct}%` : ''}
                  </span>
                  {/* The track is always visible while compiling; it fills with
                      REAL frame counts once Remotion starts (setup phases sit at 0). */}
                  <span className="progress"><i style={{ width: `${renderPct ?? 0}%` }} /></span>
                </span>
              ) : (
                <span className={renderReady ? 'vr-export-ready-text' : 'vr-export-summary'}>
                  {renderSummary}
                </span>
              )}
            </div>
            <div className="vr-export-controls">
              {renderInfo?.history?.length ? (
                <span className="vp-menu-wrap">
                  <button
                    type="button"
                    disabled={renderState === 'rendering'}
                    aria-expanded={renderHistoryMenuOpen}
                    onClick={() => {
                      setRenderQualityMenuOpen(false)
                      setRenderHistoryMenuOpen((open) => !open)
                    }}
                  >
                    Previous ▾
                  </button>
                  {renderHistoryMenuOpen ? (
                    <>
                      <span className="vp-menu-backdrop" onClick={() => setRenderHistoryMenuOpen(false)} />
                      <span className="vp-menu vr-export-menu">
                        <span className="vp-menu-h">PREVIOUS EXPORTS</span>
                        {renderInfo.history.map((record) => (
                          <button
                            type="button"
                            key={`${record.path}-${record.compiled_at || record.archived_at || ''}`}
                            onClick={() => {
                              setRenderHistoryMenuOpen(false)
                              downloadRenderExport(record)
                            }}
                          >
                            <span>{record.quality_label || record.quality || 'Previous'}</span>
                            <small>
                              {[formatMegabytes(record.size_mb), record.width && record.height ? `${record.width}×${record.height}` : '']
                                .filter(Boolean).join(' · ')}
                            </small>
                          </button>
                        ))}
                      </span>
                    </>
                  ) : null}
                </span>
              ) : null}
              <span className="vp-menu-wrap">
                <button
                  type="button"
                  disabled={renderState === 'rendering'}
                  aria-expanded={renderQualityMenuOpen}
                  onClick={() => {
                    setRenderHistoryMenuOpen(false)
                    setRenderQualityMenuOpen((open) => !open)
                  }}
                >
                  {selectedRenderProfile?.label || renderQuality} ▾
                </button>
                {renderQualityMenuOpen ? (
                  <>
                    <span className="vp-menu-backdrop" onClick={() => setRenderQualityMenuOpen(false)} />
                    <span className="vp-menu vr-export-menu">
                      <span className="vp-menu-h">EXPORT QUALITY</span>
                      {(renderInfo?.profiles ?? []).map((profile) => (
                        <button
                          type="button"
                          className={profile.id === renderQuality ? 'on' : ''}
                          key={profile.id}
                          onClick={() => {
                            setRenderQuality(profile.id)
                            setRenderQualityMenuOpen(false)
                          }}
                        >
                          <span>{profile.label}{profile.default ? ' · Recommended' : ''}</span>
                          <small>{profile.description}</small>
                          <small>{profile.estimated_size_mb ? `About ${formatMegabytes(profile.estimated_size_mb)}` : ''}</small>
                        </button>
                      ))}
                    </span>
                  </>
                ) : null}
              </span>
              <button
                type="button"
                className={renderReady ? '' : 'save-continue'}
                onClick={startRender}
                disabled={renderState === 'rendering'}
              >
                {renderState === 'rendering'
                  ? (<><span className="spin" /> Compiling…</>)
                  : selectedQualityDiffers
                    ? `Compile ${selectedRenderProfile?.label || renderQuality}`
                  : currentRender?.exists
                    ? 'Compile again'
                    : 'Compile final video'}
              </button>
              <button
                type="button"
                className={renderReady && renderState !== 'rendering' ? 'save-continue vr-download-ready' : ''}
                onClick={downloadFinalVideo}
                disabled={!renderReady || renderState === 'rendering'}
              >
                {renderState === 'rendering'
                  ? 'Download after compile'
                  : renderReady
                    ? 'Download video'
                    : 'Download after compile'}
              </button>
            </div>
          </div>
          {renderState === 'stale' || (currentRender?.exists && !renderReady && renderState !== 'rendering') ? (
            <p className="vr-export-note">The timeline changed after this video was compiled. Compile again before downloading it.</p>
          ) : renderState === 'failed' && !renderError ? (
            <p className="vr-export-note">The last compile did not finish. The previous export is still available above.</p>
          ) : !currentRender?.exists && renderState !== 'rendering' ? (
            <p className="vr-export-note">Choose a quality and compile the current timeline. Social is recommended for normal sharing.</p>
          ) : null}
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
