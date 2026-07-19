import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { useWorkflowStore } from '../../store/workflow'
import { API_BASE, activeSession, actionUrl, contentUrl, downloadUrl, fileUrl, templatesUrl } from '../../lib/api'

const API = API_BASE
const PROMPTS_PATH = 'working/generation-prompts.json'
const SCENE_STATUS_PATH = 'working/batch-scenes-status.json'
const SCENE_MANIFEST_PATH = 'manifests/scenes.manifest.json'
const DEFAULT_IMAGE_MODEL = 'gpt-image-2-text-to-image'
const DEFAULT_VIDEO_MODEL = 'seedance-2-fast'

type OutputType = 'image' | 'video' | 'auto'
type RowStatus = 'not_run' | 'generating' | 'image_ready' | 'video_ready' | 'failed'

type PromptReference = {
  name?: string
  role?: string
  status?: string
  image_url?: string
  local_path?: string
}

type GenerationPromptItem = {
  id?: string
  chunk_id?: string
  scene?: string
  duration_s?: number
  visual_direction?: string
  prompt?: string
  prompt_variants?: Partial<Record<'image' | 'video', { prompt?: string }>>
  references?: PromptReference[]
  reference_image_policy?: string
  first_frame_removed?: boolean
  model?: string
  output_type?: OutputType
  kie_request_preview?: {
    model?: string
    input?: Record<string, unknown>
    ready_for_submit?: boolean
    note?: string
  }
}

type GenerationPromptsDoc = {
  schema?: string
  session_id?: string
  generated_at?: string
  source?: string
  preferred_image_model?: string
  preferred_video_model?: string
  default_image_model?: string
  default_video_model?: string
  // Legacy: kept readable for old files, but not used for media generation.
  preferred_model?: string
  default_output_type?: OutputType
  template_output_type?: OutputType
  aspect_ratio?: string
  resolution?: string
  output_format?: string
  items?: GenerationPromptItem[]
}

type BatchScenesStatus = {
  media_type?: 'image' | 'video'
  state?: string
  total?: number
  completed_count?: number
  failed_count?: number
  updated_at?: string
  only?: string[]
  completed?: string[]
  failed?: Record<string, string>
}

type SceneManifestItem = {
  id?: string
  chunk_id?: string
  role?: string
  status?: string
  local_path?: string
  mime_type?: string
  prompt?: string
}

type SceneManifest = {
  items?: SceneManifestItem[]
}

type PromptRow = {
  item: GenerationPromptItem
  id: string
  type: OutputType
  status: RowStatus
  title: string
  duration: string
  prompt: string
  mediaModel: string
  aspect: string
  resolution: string
  referenceUrls: string[]
  references: PromptReference[]
  draftText: string
  parseError?: string
}

type PreviewMedia = {
  kind: 'image' | 'video'
  src: string
}

const imageModels = [
  { id: 'nano-banana-2', label: 'Nano Banana 2', note: 'image · fast draft quality' },
  { id: 'nano-banana-pro', label: 'Nano Banana Pro', note: 'image · higher quality' },
  { id: 'gpt-image-2-text-to-image', label: 'GPT Image 2', note: 'image · strong prompt following' },
]

const videoModels = [
  { id: 'seedance-2-fast', label: 'Seedance 2 Fast', note: 'video · faster, lower cost · max 15s', maxSeconds: 15 },
  { id: 'seedance-2', label: 'Seedance 2', note: 'video · higher quality · max 15s', maxSeconds: 15 },
]

function modelLabel(models: { id: string; label: string }[], id: string) {
  return models.find((model) => model.id === id)?.label || id
}

function selectedVideoModelLimit(modelId: string) {
  return videoModels.find((model) => model.id === modelId)?.maxSeconds ?? 8
}

function rowDurationSeconds(row: PromptRow) {
  return Number(row.item.duration_s || 0)
}

function prettyJson(value: unknown) {
  return JSON.stringify(value, null, 2)
}

function promptParts(item: GenerationPromptItem, doc: GenerationPromptsDoc) {
  const input = item.kie_request_preview?.input ?? {}
  const refs = (item.references ?? [])
    .map((ref) => String(ref.local_path || ref.image_url || '').trim())
    .filter(Boolean)
  return {
    id: item.id,
    chunk_id: item.chunk_id,
    duration: item.duration_s,
    aspect_ratio: String(input.aspect_ratio || doc.aspect_ratio || '16:9'),
    resolution: String(input.resolution || doc.resolution || '1K'),
    prompt: item.prompt || input.prompt || '',
    reference_image_urls: refs,
  }
}

function activeOutputType(item: GenerationPromptItem, fallback: OutputType): 'image' | 'video' {
  const type = item.output_type || fallback
  return type === 'video' ? 'video' : 'image'
}

function itemPromptForType(item: GenerationPromptItem, type: 'image' | 'video') {
  const variantPrompt = item.prompt_variants?.[type]?.prompt
  if (variantPrompt) return variantPrompt
  const currentPrompt = String(item.prompt || item.kie_request_preview?.input?.prompt || '')
  if (!item.output_type || item.output_type === type) return currentPrompt
  return currentPrompt
}

function withPromptForType(item: GenerationPromptItem, type: 'image' | 'video', prompt: string): GenerationPromptItem {
  const input = { ...(item.kie_request_preview?.input ?? {}) }
  if (prompt) input.prompt = prompt
  return {
    ...item,
    prompt,
    output_type: type,
    prompt_variants: {
      ...(item.prompt_variants ?? {}),
      [type]: {
        ...(item.prompt_variants?.[type] ?? {}),
        prompt,
      },
    },
    kie_request_preview: {
      ...(item.kie_request_preview ?? {}),
      input,
    },
  }
}

function rememberCurrentPrompt(item: GenerationPromptItem, fallback: OutputType): GenerationPromptItem {
  const currentType = activeOutputType(item, fallback)
  const prompt = String(item.prompt || item.kie_request_preview?.input?.prompt || '')
  if (!prompt) return item
  return {
    ...item,
    prompt_variants: {
      ...(item.prompt_variants ?? {}),
      [currentType]: {
        ...(item.prompt_variants?.[currentType] ?? {}),
        prompt,
      },
    },
  }
}

function generatedSceneRel(id: string) {
  return `source/generated-assets/scenes/${id}.png`
}

function defaultFirstFrameReference(id: string): PromptReference {
  return {
    name: `${id} first frame`,
    role: 'first_frame',
    status: 'selected',
    image_url: '',
    local_path: generatedSceneRel(id),
  }
}

function hasFirstFrameReference(refs: PromptReference[], relPath: string) {
  return refs.some((ref) => ref.role === 'first_frame' || String(ref.local_path || '') === relPath)
}

function mediaReadyMap(manifest: SceneManifest | null) {
  const ready = new Map<string, 'image' | 'video'>()
  for (const item of manifest?.items ?? []) {
    if (item.status && item.status !== 'success') continue
    const id = String(item.id || item.chunk_id || '').trim()
    const chunkId = String(item.chunk_id || item.id || '').trim()
    const role = String(item.role || '').trim()
    const mime = String(item.mime_type || '').trim()
    const path = String(item.local_path || '').trim().toLowerCase()
    const type: 'image' | 'video' | '' = role === 'scene-video' || mime.startsWith('video/') || path.endsWith('.mp4') || path.endsWith('.mov') || path.endsWith('.webm')
      ? 'video'
      : role === 'scene' || mime.startsWith('image/') || path.endsWith('.png') || path.endsWith('.jpg') || path.endsWith('.jpeg') || path.endsWith('.webp')
        ? 'image'
        : ''
    if (!type) continue
    if (id) ready.set(id, type)
    if (chunkId) ready.set(chunkId, type)
  }
  return ready
}

function mediaManifestItem(manifest: SceneManifest | null, id: string, type: 'image' | 'video') {
  return (manifest?.items ?? []).find((item) => {
    if (item.status && item.status !== 'success') return false
    const itemId = String(item.id || item.chunk_id || '').trim()
    const chunkId = String(item.chunk_id || item.id || '').trim()
    if (itemId !== id && chunkId !== id) return false
    const role = String(item.role || '')
    const mime = String(item.mime_type || '')
    const path = String(item.local_path || '').toLowerCase()
    if (type === 'video') return role === 'scene-video' || mime.startsWith('video/') || path.endsWith('.mp4') || path.endsWith('.mov') || path.endsWith('.webm')
    return role === 'scene' || mime.startsWith('image/') || path.endsWith('.png') || path.endsWith('.jpg') || path.endsWith('.jpeg') || path.endsWith('.webp')
  })
}

function manifestContentPath(item: SceneManifestItem | undefined) {
  const value = String(item?.local_path || '').trim()
  if (!value) return ''
  const contentMarker = '/spoolcast-content/'
  const contentIndex = value.indexOf(contentMarker)
  return contentIndex >= 0 ? value.slice(contentIndex + contentMarker.length) : value.replace(/^\/+/, '')
}

function withManifestPromptVariants(
  doc: GenerationPromptsDoc | null,
  manifest: SceneManifest | null,
): { doc: GenerationPromptsDoc | null; changed: boolean } {
  if (!doc?.items?.length || !manifest?.items?.length) return { doc, changed: false }
  let changed = false
  const items = doc.items.map((item) => {
    const id = String(item.id || item.chunk_id || '').trim()
    if (!id) return item
    const imagePrompt = String(mediaManifestItem(manifest, id, 'image')?.prompt || '').trim()
    const videoPrompt = String(mediaManifestItem(manifest, id, 'video')?.prompt || '').trim()
    if (!imagePrompt && !videoPrompt) return item
    const variants = { ...(item.prompt_variants ?? {}) }
    let itemChanged = false
    if (imagePrompt && !variants.image?.prompt) {
      variants.image = { ...(variants.image ?? {}), prompt: imagePrompt }
      itemChanged = true
    }
    if (videoPrompt && !variants.video?.prompt) {
      variants.video = { ...(variants.video ?? {}), prompt: videoPrompt }
      itemChanged = true
    }
    if (!itemChanged) return item
    changed = true
    return { ...item, prompt_variants: variants }
  })
  return changed ? { doc: { ...doc, items }, changed } : { doc, changed: false }
}

function withDefaultFirstFrameRefs(
  doc: GenerationPromptsDoc | null,
  status: BatchScenesStatus | null,
  manifest: SceneManifest | null,
): { doc: GenerationPromptsDoc | null; changed: boolean } {
  if (!doc?.items?.length) return { doc, changed: false }
  const completed = new Set(status?.media_type === 'image' ? status?.completed ?? [] : [])
  const manifestReady = mediaReadyMap(manifest)
  let changed = false
  const items = doc.items.map((item) => {
    const id = String(item.id || item.chunk_id || '').trim()
    if (!id || item.output_type !== 'video' || item.first_frame_removed || (!completed.has(id) && manifestReady.get(id) !== 'image')) return item
    const relPath = generatedSceneRel(id)
    const refs = Array.isArray(item.references) ? item.references : []
    if (hasFirstFrameReference(refs, relPath)) return item
    changed = true
    return {
      ...item,
      references: [defaultFirstFrameReference(id), ...refs],
    }
  })
  return changed ? { doc: { ...doc, items }, changed } : { doc, changed: false }
}

function normalizeRows(
  doc: GenerationPromptsDoc | null,
  status: BatchScenesStatus | null,
  manifest: SceneManifest | null,
  defaultType: OutputType,
  imageModel: string,
  videoModel: string,
  drafts: Record<string, string>,
  errors: Record<string, string>,
): PromptRow[] {
  if (!doc?.items?.length) return []
  const completed = new Set(status?.completed ?? [])
  const failed = status?.failed ?? {}
  const state = String(status?.state || '')
  const running = state === 'running'
  const doneIds = completed
  const targetIds = new Set(status?.only ?? [])
  const ready = mediaReadyMap(manifest)
  return doc.items.map((item) => {
    const id = String(item.id || item.chunk_id || '')
    const type = item.output_type || defaultType
    const mediaType = type === 'video' ? 'video' : 'image'
    const payload = promptParts(item, doc)
    const prompt = itemPromptForType(item, mediaType)
    const mediaModel = type === 'video' ? videoModel : imageModel
    let rowStatus: RowStatus = 'not_run'
    if (failed[id]) rowStatus = 'failed'
    else if (running && (!targetIds.size || targetIds.has(id)) && !doneIds.has(id)) rowStatus = 'generating'
    else if (ready.get(id) === 'video' && type === 'video') rowStatus = 'video_ready'
    else if (ready.get(id) === 'image' && type !== 'video') rowStatus = 'image_ready'
    else if (doneIds.has(id)) rowStatus = type === 'video' ? 'video_ready' : 'image_ready'
    return {
      item,
      id,
      type,
      status: rowStatus,
      title: String(item.scene || item.chunk_id || id),
      duration: typeof item.duration_s === 'number' ? `${item.duration_s.toFixed(1)}s` : '',
      prompt,
      mediaModel,
      aspect: String(payload.aspect_ratio || ''),
      resolution: String(payload.resolution || ''),
      referenceUrls: Array.isArray(payload.reference_image_urls) ? payload.reference_image_urls : [],
      references: item.references ?? [],
      draftText: drafts[id] ?? prompt,
      parseError: errors[id],
    }
  }).filter((row) => row.id)
}

function updateDocItemFromDraft(doc: GenerationPromptsDoc, id: string, draftText: string): GenerationPromptsDoc {
  const prompt = draftText.trim()
  return {
    ...doc,
    items: (doc.items ?? []).map((item) => {
      if (String(item.id || item.chunk_id || '') !== id) return item
      return withPromptForType(item, activeOutputType(item, doc.default_output_type || 'image'), prompt || String(item.prompt || ''))
    }),
  }
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  const res = await fetch(fileUrl(path))
  if (!res.ok) return null
  const out = await res.json().catch(() => null)
  if (!out?.ok || !out.data?.content) return null
  return JSON.parse(out.data.content) as T
}

async function savePromptDoc(doc: GenerationPromptsDoc) {
  const res = await fetch(actionUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session: activeSession(),
      tenant: 'local',
      action: 'set_stage_output',
      stage_id: 'visual_assets',
      path: PROMPTS_PATH,
      content: prettyJson(doc) + '\n',
    }),
  })
  const out = await res.json().catch(() => null)
  if (!res.ok || out?.ok === false) throw new Error(out?.message || out?.error || 'Could not save prompt edits.')
}

export function VisualGenerationStage({ stageId }: { stageId: string }) {
  const [doc, setDoc] = useState<GenerationPromptsDoc | null>(null)
  const [batchStatus, setBatchStatus] = useState<BatchScenesStatus | null>(null)
  const [sceneManifest, setSceneManifest] = useState<SceneManifest | null>(null)
  const [loading, setLoading] = useState(true)
  const [buildError, setBuildError] = useState('')
  const [defaultType, setDefaultType] = useState<OutputType>('image')
  const [view, setView] = useState<'prompts' | 'gallery'>('prompts')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saveNote, setSaveNote] = useState('')
  const [advancedMenu, setAdvancedMenu] = useState(false)
  const [advancedSelectMenu, setAdvancedSelectMenu] = useState<'generate' | 'image' | 'video' | null>(null)
  const [generateMode, setGenerateMode] = useState<'image' | 'video'>('image')
  const [generateModeTouched, setGenerateModeTouched] = useState(false)
  const [regenNoteOpen, setRegenNoteOpen] = useState(false)
  const [regenNote, setRegenNote] = useState('')
  const [promptBusyIds, setPromptBusyIds] = useState<Set<string>>(new Set())
  const [timingSyncing, setTimingSyncing] = useState(false)
  const [imageModel, setImageModel] = useState(DEFAULT_IMAGE_MODEL)
  const [videoModel, setVideoModel] = useState(DEFAULT_VIDEO_MODEL)
  const [history, setHistory] = useState<GenerationPromptsDoc[]>([])
  const [redoHistory, setRedoHistory] = useState<GenerationPromptsDoc[]>([])
  const [previewRef, setPreviewRef] = useState<{ src: string; name: string; rowId: string; refIndex: number; role: 'first_frame' | 'reference' } | null>(null)
  // Full-screen view of a row's generated media.
  const [mediaLightbox, setMediaLightbox] = useState<{ kind: 'image' | 'video'; src: string } | null>(null)
  // The World Kit — so every association shows for what it IS: image refs
  // attach as reference images (1st frame flagged), prompt-only objects join
  // the prompt as text, audio rides as sound (attached or via object link).
  type KitLite = { name: string; kind: string; notes?: string; image_path?: string; linked_to?: string; variant_of?: string }
  const [kitObjs, setKitObjs] = useState<KitLite[]>([])
  useEffect(() => {
    let live = true
    fetch(`${API}/source-images?session=${encodeURIComponent(activeSession())}&include_refs=1`)
      .then((r) => (r.ok ? r.json() : null))
      .then((out) => { if (live && Array.isArray(out?.data?.kit)) setKitObjs(out.data.kit as KitLite[]) })
      .catch(() => { /* engine offline — thumbs still render from the doc */ })
    return () => { live = false }
  }, [])
  const pollingRef = useRef('')
  const savePromptChainRef = useRef<Promise<void>>(Promise.resolve())
  const undoRef = useRef<() => void>(() => {})
  const redoRef = useRef<() => void>(() => {})
  const stageProcess = useWorkflowStore((s) => s.stageProcesses[stageId] ?? null)
  const setStageProcess = useWorkflowStore((s) => s.setStageProcess)
  const setStepUndo = useWorkflowStore((s) => s.setStepUndo)
  // Regenerating visuals or re-syncing timing invalidates a compiled final video.
  const staleFinalRender = useWorkflowStore((s) => s.staleFinalRender)

  const activeProcess = !!stageProcess && ['queued', 'running'].includes(stageProcess.status)

  const queueSavePromptDoc = (nextDoc: GenerationPromptsDoc) => {
    const save = savePromptChainRef.current.catch(() => undefined).then(() => savePromptDoc(nextDoc))
    savePromptChainRef.current = save.catch(() => undefined)
    return save
  }

  const snapshotDoc = () => {
    if (!doc) return
    setHistory((prev) => [...prev.slice(-49), doc])
    setRedoHistory([])
  }

  const undo = async () => {
    const prev = history[history.length - 1]
    if (!prev || !doc) return
    try {
      await queueSavePromptDoc(prev)
      setRedoHistory((stack) => [...stack.slice(-49), doc])
      setDoc(prev)
      setDrafts({})
      setErrors({})
      setHistory((stack) => stack.slice(0, -1))
      setSaveNote('Undo restored previous prompts')
    } catch (err) {
      setBuildError(err instanceof Error ? err.message : 'Could not undo prompt change.')
    }
  }
  undoRef.current = undo

  const redo = async () => {
    const next = redoHistory[redoHistory.length - 1]
    if (!next || !doc) return
    try {
      await queueSavePromptDoc(next)
      setHistory((stack) => [...stack.slice(-49), doc])
      setDoc(next)
      setDrafts({})
      setErrors({})
      setRedoHistory((stack) => stack.slice(0, -1))
      setSaveNote('Redo restored prompt change')
    } catch (err) {
      setBuildError(err instanceof Error ? err.message : 'Could not redo prompt change.')
    }
  }
  redoRef.current = redo

  useEffect(() => {
    setStepUndo({
      count: history.length,
      run: () => undoRef.current(),
      redoCount: redoHistory.length,
      redo: () => redoRef.current(),
    })
    return () => setStepUndo(null)
  }, [history.length, redoHistory.length, setStepUndo])

  const load = async () => {
    setLoading(true)
    try {
      const [promptDoc, statusDoc, manifestDoc] = await Promise.all([
        readJsonFile<GenerationPromptsDoc>(PROMPTS_PATH).catch(() => null),
        readJsonFile<BatchScenesStatus>(SCENE_STATUS_PATH).catch(() => null),
        readJsonFile<SceneManifest>(SCENE_MANIFEST_PATH).catch(() => null),
      ])
      const promptVariantMigrated = withManifestPromptVariants(promptDoc, manifestDoc)
      const migrated = withDefaultFirstFrameRefs(promptVariantMigrated.doc, statusDoc, manifestDoc)
      const nextPromptDoc = migrated.doc
      if ((promptVariantMigrated.changed || migrated.changed) && nextPromptDoc) void queueSavePromptDoc(nextPromptDoc).catch(() => {})
      if (nextPromptDoc?.preferred_image_model) setImageModel(nextPromptDoc.preferred_image_model)
      if (nextPromptDoc?.preferred_video_model && videoModels.some((model) => model.id === nextPromptDoc.preferred_video_model)) {
        setVideoModel(nextPromptDoc.preferred_video_model)
      }
      if (!generateModeTouched) {
        const defaultOutput = nextPromptDoc?.default_output_type || nextPromptDoc?.template_output_type || defaultType
        setGenerateMode(defaultOutput === 'video' ? 'video' : 'image')
      }
      setDoc(nextPromptDoc)
      setBatchStatus(statusDoc)
      setSceneManifest(manifestDoc)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0)
    return () => window.clearTimeout(timer)
  }, [])

  // THE MEDIUM WAS DECIDED UPSTREAM (template clock / session shot_medium) —
  // the pre-build type picker READS that decision instead of assuming stills.
  // Video-first templates force video; a mix policy starts on "Let AI choose".
  useEffect(() => {
    let live = true
    Promise.all([
      fetch(fileUrl('session.json')).then((r) => (r.ok ? r.json() : null)),
      fetch(templatesUrl()).then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([sess, reg]) => {
        if (!live || typeof sess?.data?.content !== 'string') return
        const cfg = JSON.parse(sess.data.content)
        const hit = reg?.data?.templates?.find((t: { id?: string; format?: string }) => t.id === String(cfg?.template || ''))
        const policy = String(cfg?.shot_medium || '')
        if (hit?.format === 'video-first' || policy === 'video') setDefaultType('video')
        else if (policy === 'mix') setDefaultType('auto')
        else if (policy === 'image') setDefaultType('image')
      })
      .catch(() => {
        /* engine offline — the picker keeps its stills default */
      })
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    if (!stageProcess?.jobId || !activeProcess) return
    pollingRef.current = stageProcess.jobId
    let cancelled = false
    const poll = async () => {
      try {
        const [job, statusDoc, manifestDoc] = await Promise.all([
          readJsonFile<{ state?: string; error?: string; job?: string }>(`working/jobs/${stageProcess.jobId}.json`).catch(() => null),
          readJsonFile<BatchScenesStatus>(SCENE_STATUS_PATH).catch(() => null),
          readJsonFile<SceneManifest>(SCENE_MANIFEST_PATH).catch(() => null),
        ])
        if (cancelled) return
        if (statusDoc) setBatchStatus(statusDoc)
        if (manifestDoc) setSceneManifest(manifestDoc)
        const state = String(job?.state || '')
        if (['succeeded', 'failed', 'stopped', 'lost'].includes(state)) {
          await load()
          pollingRef.current = ''
          if (state === 'succeeded') {
            const media = statusDoc?.media_type === 'video' ? 'Video' : 'Image'
            setSaveNote(job?.job === 'batch_scenes' ? `${media} generation completed` : 'Prompt regeneration completed')
            if (job?.job !== 'batch_scenes') setPromptBusyIds(new Set())
            setStageProcess(stageId, null)
          }
          else {
            const message = job?.error || state
            setBuildError(message)
            setPromptBusyIds(new Set())
            setStageProcess(stageId, { ...stageProcess, status: 'failed', error: message })
          }
        }
      } catch {
        // Status file polling is best-effort; the job state remains visible in the header.
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 3000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      if (pollingRef.current === stageProcess.jobId) pollingRef.current = ''
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageProcess?.jobId, activeProcess])

  const rows = useMemo(
    () => normalizeRows(doc, batchStatus, sceneManifest, defaultType, imageModel, videoModel, drafts, errors),
    [doc, batchStatus, sceneManifest, defaultType, imageModel, videoModel, drafts, errors],
  )

  const progress = useMemo(() => {
    const total = rows.length
    const ready = mediaReadyMap(sceneManifest)
    const done = rows.filter((row) => ready.has(row.id) || row.status === 'image_ready' || row.status === 'video_ready').length
    return { total, done, pct: total ? Math.round((done / total) * 100) : 0 }
  }, [rows, sceneManifest])
  const showProgressBar = activeProcess || progress.done > 0

  const selectedRows = rows.filter((row) => selected.has(row.id))
  const selectedImageRows = selectedRows.filter((row) => row.type !== 'video')
  const selectedVideoRows = selectedRows.filter((row) => row.type === 'video')
  const failedRows = rows.filter((row) => row.status === 'failed')
  const videoMaxSeconds = selectedVideoModelLimit(videoModel)
  const videoTooLong = (row: PromptRow) => rowDurationSeconds(row) > videoMaxSeconds
  const videoDisabledTitle = (row: PromptRow) => `Video disabled: ${row.duration || 'this row'} exceeds ${modelLabel(videoModels, videoModel)} max ${videoMaxSeconds}s.`
  const selectedEligibleVideoRows = selectedVideoRows.filter((row) => !videoTooLong(row))
  const generateCount = generateMode === 'image' ? selectedImageRows.length : selectedEligibleVideoRows.length
  const generateLabel = generateMode === 'image' ? 'Generate selected images' : 'Generate selected videos'
  const selectedVideoTooLong = selectedVideoRows.some(videoTooLong)
  const generateDisabled = activeProcess || generateCount === 0 || (generateMode === 'video' && selectedVideoTooLong)
  const regenCurrentDisabled = activeProcess || selectedRows.length === 0
  const regenImageDisabled = activeProcess || selectedRows.length === 0 || selectedVideoRows.length === 0
  const regenVideoDisabled = activeProcess || selectedRows.length === 0 || selectedImageRows.length === 0
  const failedImageRows = failedRows.filter((row) => row.type !== 'video')
  const hasPrompts = rows.length > 0
  const defaultImageModel = doc?.default_image_model || DEFAULT_IMAGE_MODEL
  const defaultVideoModel = doc?.default_video_model || DEFAULT_VIDEO_MODEL
  const imageModelDefaultNote = imageModel === defaultImageModel
    ? 'default'
    : `default: ${modelLabel(imageModels, defaultImageModel)}`
  const videoModelDefaultNote = videoModel === defaultVideoModel
    ? 'default'
    : `default: ${modelLabel(videoModels, defaultVideoModel)}`
  const buildPrompts = async () => {
    setBuildError('')
    snapshotDoc()
    setStageProcess(stageId, {
      stageId,
      status: 'running',
      label: 'Building generation prompts…',
      updatedAt: new Date().toISOString(),
    })
    try {
      const res = await fetch(actionUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: activeSession(),
          tenant: 'local',
          action: 'build_generation_prompts',
          image_model: imageModel,
          video_model: videoModel,
        }),
      })
      const out = await res.json().catch(() => null)
      if (!res.ok || out?.ok === false) throw new Error(out?.message || out?.error || 'Could not build generation prompts.')
      setDrafts({})
      setErrors({})
      await load()
      setStageProcess(stageId, null)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not build generation prompts.'
      setBuildError(message)
      setStageProcess(stageId, { stageId, status: 'failed', label: 'Build generation prompts', error: message })
    }
  }

  const syncAudioTiming = async () => {
    setBuildError('')
    setTimingSyncing(true)
    try {
      const res = await fetch(actionUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: activeSession(),
          tenant: 'local',
          action: 'sync_audio_timing',
        }),
      })
      const out = await res.json().catch(() => null)
      if (!res.ok || out?.ok === false) throw new Error(out?.message || out?.error || 'Could not sync timing from narration audio.')
      await load()
      const data = out?.data ?? {}
      setSaveNote(`Synced ${data.events_updated ?? 0} visual timings from Step 09 audio`)
      staleFinalRender()
    } catch (err) {
      setBuildError(err instanceof Error ? err.message : 'Could not sync timing from narration audio.')
    } finally {
      setTimingSyncing(false)
    }
  }

  const persistDraft = async (id: string) => {
    if (!doc) return
    try {
      const draftText = drafts[id]
      if (!draftText) return
      const nextDoc = updateDocItemFromDraft(doc, id, draftText)
      snapshotDoc()
      await queueSavePromptDoc(nextDoc)
      setDoc(nextDoc)
      setSaveNote(`${id} saved`)
      setErrors((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not save prompt.'
      setErrors((prev) => ({ ...prev, [id]: message }))
    }
  }

  const setMediaModel = (kind: 'image' | 'video', modelId: string) => {
    if (kind === 'image') setImageModel(modelId)
    else setVideoModel(modelId)
    setAdvancedSelectMenu(null)
    if (!doc) return
    const nextDoc = {
      ...doc,
      preferred_image_model: kind === 'image' ? modelId : (doc.preferred_image_model || imageModel),
      preferred_video_model: kind === 'video' ? modelId : (doc.preferred_video_model || videoModel),
    }
    snapshotDoc()
    setDoc(nextDoc)
    void queueSavePromptDoc(nextDoc)
      .then(() => setSaveNote(`${kind === 'image' ? 'Image' : 'Video'} model saved`))
      .catch((err) => setBuildError(err instanceof Error ? err.message : 'Could not save media model.'))
  }

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleAllSelection = () => {
    setSelected((prev) => (prev.size === rows.length ? new Set() : new Set(rows.map((row) => row.id))))
  }

  const regeneratePromptRows = async (outputType: 'image' | 'video' | 'current') => {
    if (!doc?.items?.length) return
    const targetRows = selectedRows
    if (!targetRows.length) return
    const targetIds = new Set(targetRows.map((row) => row.id))
    const scopeLabel = `${targetIds.size} selected`
    const instruction = outputType === 'current' ? regenNote.trim() : ''
    setBuildError('')
    setPromptBusyIds(targetIds)
    snapshotDoc()
    setStageProcess(stageId, {
      stageId,
      status: 'running',
      label: `Regenerating ${scopeLabel} prompt${targetIds.size === 1 ? '' : 's'}…`,
      updatedAt: new Date().toISOString(),
    })
    try {
      const res = await fetch(actionUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: activeSession(),
          tenant: 'local',
          action: 'rewrite_generation_prompts',
          allow_cost: true,
          ids: Array.from(targetIds),
          output_type: outputType,
          instruction,
        }),
      })
      const out = await res.json().catch(() => null)
      if (!res.ok || out?.ok === false) throw new Error(out?.message || out?.error || 'Could not regenerate prompts.')
      const jobId = String(out?.data?.stdout || '').match(/started\s+\S+\s+job\s+([^\s]+)/)?.[1]
      if (!jobId) throw new Error('Prompt regeneration started but did not return a job id.')
      setDrafts({})
      setErrors({})
      setRegenNoteOpen(false)
      setSaveNote(`${targetIds.size} prompt${targetIds.size === 1 ? '' : 's'} regenerating by AI`)
      setStageProcess(stageId, {
        stageId,
        jobId,
        status: 'running',
        label: `Regenerating ${scopeLabel} prompt${targetIds.size === 1 ? '' : 's'}…`,
        updatedAt: new Date().toISOString(),
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not regenerate prompts.'
      setPromptBusyIds(new Set())
      setBuildError(message)
      setStageProcess(stageId, { stageId, status: 'failed', label: 'Regenerate prompts', error: message })
    }
  }

  const generateImages = async (onlyIds?: string[], force = false) => {
    const ids = onlyIds ?? selectedRows.filter((row) => row.type !== 'video').map((row) => row.id)
    if (!ids.length) return
    setBuildError('')
    setStageProcess(stageId, {
      stageId,
      status: 'queued',
      label: `Generating ${ids.length} image${ids.length === 1 ? '' : 's'}…`,
      updatedAt: new Date().toISOString(),
    })
    try {
      let approvedDoc = doc
      if (approvedDoc && approvedDoc.preferred_image_model !== imageModel) {
        approvedDoc = { ...approvedDoc, preferred_image_model: imageModel }
      }
      const draftIds = ids.filter((id) => drafts[id]?.trim())
      if (approvedDoc && draftIds.length) {
        for (const id of draftIds) {
          approvedDoc = updateDocItemFromDraft(approvedDoc, id, drafts[id])
        }
      }
      if (approvedDoc) {
        await queueSavePromptDoc(approvedDoc)
        setDoc(approvedDoc)
        if (draftIds.length) {
          setDrafts((prev) => {
            const next = { ...prev }
            for (const id of draftIds) delete next[id]
            return next
          })
        }
      }

      const approvalRes = await fetch(actionUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: activeSession(),
          tenant: 'local',
          action: 'approve_generation_prompts',
          allow_cost: true,
          ids,
          media_type: 'image',
        }),
      })
      const approvalOut = await approvalRes.json().catch(() => null)
      if (!approvalRes.ok || approvalOut?.ok === false) {
        throw new Error(approvalOut?.message || approvalOut?.error || 'Could not approve selected prompts.')
      }

      const extraArgs = ['--only', ids.join(',')]
      if (force) extraArgs.push('--force')
      const res = await fetch(actionUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: activeSession(),
          tenant: 'local',
          action: 'batch_scenes',
          allow_cost: true,
          extra_args: extraArgs,
        }),
      })
      const out = await res.json().catch(() => null)
      if (!res.ok || out?.ok === false) throw new Error(out?.details || out?.message || out?.error || 'Could not start image generation.')
      const jobId = String(out?.data?.stdout || '').match(/started\s+\S+\s+job\s+([^\s]+)/)?.[1]
      setStageProcess(stageId, {
        stageId,
        jobId,
        status: 'running',
        label: `Generating ${ids.length} image${ids.length === 1 ? '' : 's'}…`,
        updatedAt: new Date().toISOString(),
      })
      staleFinalRender()
      await load()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not start image generation.'
      setBuildError(message)
      setStageProcess(stageId, null)
    }
  }

  const generateVideos = async (onlyIds?: string[], force = false) => {
    const sourceRows = onlyIds ? rows.filter((row) => onlyIds.includes(row.id)) : selectedVideoRows
    if (sourceRows.some(videoTooLong)) {
      setBuildError(`Video generation disabled: one selected row exceeds ${modelLabel(videoModels, videoModel)} max ${videoMaxSeconds}s.`)
      return
    }
    const ids = sourceRows.filter((row) => row.type === 'video').map((row) => row.id)
    if (!ids.length) return
    setBuildError('')
    setStageProcess(stageId, {
      stageId,
      status: 'queued',
      label: `Generating ${ids.length} video${ids.length === 1 ? '' : 's'}…`,
      updatedAt: new Date().toISOString(),
    })
    try {
      let approvedDoc = doc
      if (approvedDoc && approvedDoc.preferred_video_model !== videoModel) {
        approvedDoc = { ...approvedDoc, preferred_video_model: videoModel }
      }
      const draftIds = ids.filter((id) => drafts[id]?.trim())
      if (approvedDoc && draftIds.length) {
        for (const id of draftIds) {
          approvedDoc = updateDocItemFromDraft(approvedDoc, id, drafts[id])
        }
      }
      if (approvedDoc) {
        await queueSavePromptDoc(approvedDoc)
        setDoc(approvedDoc)
        if (draftIds.length) {
          setDrafts((prev) => {
            const next = { ...prev }
            for (const id of draftIds) delete next[id]
            return next
          })
        }
      }

      const approvalRes = await fetch(actionUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: activeSession(),
          tenant: 'local',
          action: 'approve_generation_prompts',
          allow_cost: true,
          ids,
          media_type: 'video',
        }),
      })
      const approvalOut = await approvalRes.json().catch(() => null)
      if (!approvalRes.ok || approvalOut?.ok === false) {
        throw new Error(approvalOut?.message || approvalOut?.error || 'Could not approve selected prompts.')
      }

      const extraArgs = ['--media-type', 'video', '--only', ids.join(',')]
      if (force) extraArgs.push('--force')
      const res = await fetch(actionUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: activeSession(),
          tenant: 'local',
          action: 'batch_scenes',
          allow_cost: true,
          extra_args: extraArgs,
        }),
      })
      const out = await res.json().catch(() => null)
      if (!res.ok || out?.ok === false) throw new Error(out?.details || out?.message || out?.error || 'Could not start video generation.')
      const jobId = String(out?.data?.stdout || '').match(/started\s+\S+\s+job\s+([^\s]+)/)?.[1]
      setStageProcess(stageId, {
        stageId,
        jobId,
        status: 'running',
        label: `Generating ${ids.length} video${ids.length === 1 ? '' : 's'}…`,
        updatedAt: new Date().toISOString(),
      })
      staleFinalRender()
      await load()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not start video generation.'
      setBuildError(message)
      setStageProcess(stageId, null)
    }
  }

  const runSelectedGeneration = () => {
    if (generateMode === 'image') void generateImages()
    else void generateVideos()
  }

  const updateRowTypes = (ids: string[], type: OutputType) => {
    if (!doc || !ids.length) return { changed: 0, skipped: 0 }
    const idSet = new Set(ids)
    const completed = new Set(batchStatus?.completed ?? [])
    let changed = 0
    const targetType = type === 'video' ? 'video' : 'image'
    const nextDoc = {
      ...doc,
      items: (doc.items ?? []).map((item) => {
        const itemId = String(item.id || item.chunk_id || '').trim()
        if (!idSet.has(itemId)) return item
        if (item.output_type === type) return item
        changed += 1
        const remembered = rememberCurrentPrompt(item, defaultType)
        const targetPrompt = itemPromptForType(remembered, targetType)
        const withTargetPrompt = withPromptForType(remembered, targetType, targetPrompt)
        if (type === 'video') {
          const refs = Array.isArray(withTargetPrompt.references) ? withTargetPrompt.references : []
          const relPath = generatedSceneRel(itemId)
          const nextRefs = completed.has(itemId) && !hasFirstFrameReference(refs, relPath)
            ? [defaultFirstFrameReference(itemId), ...refs]
            : refs
          return { ...withTargetPrompt, output_type: type, first_frame_removed: false, references: nextRefs }
        }
        return {
          ...withTargetPrompt,
          output_type: type,
          references: (withTargetPrompt.references ?? []).filter((ref) => ref.role !== 'first_frame'),
        }
      }),
    }
    if (changed) {
      snapshotDoc()
      setDoc(nextDoc)
      setDrafts((prev) => {
        const next = { ...prev }
        for (const id of ids) delete next[id]
        return next
      })
      void queueSavePromptDoc(nextDoc).catch((err) => setBuildError(err instanceof Error ? err.message : 'Could not save type.'))
    }
    return { changed, skipped: 0 }
  }

  const selectGenerateMode = (mode: 'image' | 'video') => {
    setGenerateMode(mode)
    setGenerateModeTouched(true)
    setAdvancedSelectMenu(null)
    const selectedIds = Array.from(selected)
    if (!selectedIds.length) return
    const { changed, skipped } = updateRowTypes(selectedIds, mode)
    if (changed || skipped) {
      const switched = changed ? `${changed} selected row${changed === 1 ? '' : 's'} switched to ${mode}` : ''
      const tooLong = skipped ? `${skipped} too long for ${modelLabel(videoModels, videoModel)}` : ''
      setSaveNote([switched, tooLong].filter(Boolean).join(' · '))
    }
  }

  const changeRowType = (id: string, type: OutputType) => {
    const { changed } = updateRowTypes([id], type)
    if (changed) setSaveNote(`${id} switched to ${type}`)
  }

  const referenceSrc = (value: string) => {
    if (value.startsWith('http://') || value.startsWith('https://')) return value
    const contentMarker = '/spoolcast-content/'
    const contentIndex = value.indexOf(contentMarker)
    const contentRel = contentIndex >= 0 ? value.slice(contentIndex + contentMarker.length) : value.replace(/^\/+/, '')
    if (contentRel.startsWith('styles/') || contentRel.startsWith('shows/') || contentRel.startsWith('sessions/')) {
      return `${API}/content?path=${encodeURIComponent(contentRel)}`
    }
    return downloadUrl(contentRel)
  }

  const sceneImageSrc = (id: string) => {
    const manifestPath = manifestContentPath(mediaManifestItem(sceneManifest, id, 'image'))
    const path = manifestPath || `sessions/${activeSession()}/source/generated-assets/scenes/${id}.png`
    const version = encodeURIComponent(batchStatus?.updated_at || '')
    return `${API}/content?path=${encodeURIComponent(path)}${version ? `&v=${version}` : ''}`
  }

  const sceneVideoSrc = (id: string) => {
    const manifestPath = manifestContentPath(mediaManifestItem(sceneManifest, id, 'video'))
    if (!manifestPath) return ''
    const version = encodeURIComponent(batchStatus?.updated_at || '')
    return `${API}/content?path=${encodeURIComponent(manifestPath)}${version ? `&v=${version}` : ''}`
  }

  const referenceValue = (ref: PromptReference) => String(ref.local_path || ref.image_url || '').trim()

  const firstFrameReference = (row: PromptRow) => (
    row.references.find((ref) => ref.role === 'first_frame' && referenceValue(ref))
  )

  const rowPreviewMedia = (row: PromptRow): PreviewMedia | null => {
    if (row.type === 'video' && row.status === 'video_ready') {
      const videoSrc = sceneVideoSrc(row.id)
      if (videoSrc) return { kind: 'video', src: videoSrc }
    }
    const firstFrame = firstFrameReference(row)
    if (row.type === 'video' && firstFrame) return { kind: 'image', src: referenceSrc(referenceValue(firstFrame)) }
    if (row.status === 'image_ready') return { kind: 'image', src: sceneImageSrc(row.id) }
    return null
  }

  const removeReferenceAsset = async (rowId: string, refIndex: number) => {
    if (!doc) return
    const nextDoc = {
      ...doc,
      items: (doc.items ?? []).map((item) => {
        if (String(item.id || item.chunk_id || '') !== rowId) return item
        const ref = item.references?.[refIndex]
        return {
          ...item,
          first_frame_removed: ref?.role === 'first_frame' ? true : item.first_frame_removed,
          references: (item.references ?? []).filter((_, index) => index !== refIndex),
        }
      }),
    }
    try {
      snapshotDoc()
      await queueSavePromptDoc(nextDoc)
      setDoc(nextDoc)
      setPreviewRef(null)
      setSaveNote(`${rowId} reference asset removed`)
    } catch (err) {
      setBuildError(err instanceof Error ? err.message : 'Could not remove reference asset.')
    }
  }

  const setFirstFrameAsReference = async (rowId: string, refIndex: number) => {
    if (!doc) return
    const nextDoc = {
      ...doc,
      items: (doc.items ?? []).map((item) => {
        if (String(item.id || item.chunk_id || '') !== rowId) return item
        return {
          ...item,
          first_frame_removed: true,
          references: (item.references ?? []).map((ref, index) => {
            if (index !== refIndex) return ref
            const { role, ...rest } = ref
            return rest
          }),
        }
      }),
    }
    try {
      snapshotDoc()
      await queueSavePromptDoc(nextDoc)
      setDoc(nextDoc)
      setPreviewRef(null)
      setSaveNote(`${rowId} first frame moved to reference images`)
    } catch (err) {
      setBuildError(err instanceof Error ? err.message : 'Could not move first frame.')
    }
  }

  const fileToBase64 = async (file: File) => {
    const buffer = await file.arrayBuffer()
    let binary = ''
    const bytes = new Uint8Array(buffer)
    const chunkSize = 0x8000
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.slice(i, i + chunkSize))
    }
    return btoa(binary)
  }

  const uploadReferenceAsset = async (rowId: string, event: ChangeEvent<HTMLInputElement>, role: 'reference' | 'first_frame' = 'reference') => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || !doc) return
    try {
      const content = await fileToBase64(file)
      const safeName = `${rowId}-${file.name}`.replace(/[^a-zA-Z0-9._-]/g, '-')
      const res = await fetch(actionUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: activeSession(),
          tenant: 'local',
          action: 'upload_file',
          filename: safeName,
          content,
        }),
      })
      const out = await res.json().catch(() => null)
      if (!res.ok || out?.ok === false) throw new Error(out?.error || 'Could not upload asset.')
      const localPath = `source/${safeName}`
      const nextDoc = {
        ...doc,
        items: (doc.items ?? []).map((item) => {
          if (String(item.id || item.chunk_id || '') !== rowId) return item
          const refs = item.references ?? []
          const uploadedRef = {
            name: role === 'first_frame' ? `${rowId} first frame` : file.name,
            role: role === 'first_frame' ? 'first_frame' : undefined,
            status: 'uploaded',
            local_path: localPath,
          }
          return {
            ...item,
            first_frame_removed: role === 'first_frame' ? false : item.first_frame_removed,
            references: role === 'first_frame'
              ? [uploadedRef, ...refs.filter((ref) => ref.role !== 'first_frame')]
              : [...refs, uploadedRef],
          }
        }),
      }
      snapshotDoc()
      await queueSavePromptDoc(nextDoc)
      setDoc(nextDoc)
      setPreviewRef(null)
      setSaveNote(role === 'first_frame' ? `${rowId} first frame uploaded` : `${rowId} reference image uploaded`)
    } catch (err) {
      setBuildError(err instanceof Error ? err.message : 'Could not upload asset.')
    }
  }

  const busyLabel = stageProcess?.label || 'Working…'

  return (
    <div className="visual-gen panel-flat">
      {!hasPrompts ? (
        <div className="gal-bar">
          <span>No generation prompts yet</span>
        </div>
      ) : null}

      <div className={`vg-stage ${activeProcess ? 'is-busy' : ''}`}>
        {activeProcess ? (
          <div className="vg-busy">
            <span className="spin" />
            {busyLabel}
          </div>
        ) : null}

        {!hasPrompts && !loading ? (
          <div className="vg-empty">
            <div className="vg-typepick">
              <button type="button" className={defaultType === 'image' ? 'on' : ''} onClick={() => setDefaultType('image')}>Images · template</button>
              <button type="button" className={defaultType === 'video' ? 'on' : ''} onClick={() => setDefaultType('video')}>Videos</button>
              <button type="button" className={defaultType === 'auto' ? 'on' : ''} onClick={() => setDefaultType('auto')}>Let AI choose</button>
            </div>
            <button type="button" className="save-continue" onClick={buildPrompts}>
              Build generation prompts
            </button>
            <p className="vp-hint">This reads the approved shot-list JSON and composes the exact request text for each image/video slot. It does not generate paid media yet.</p>
          </div>
        ) : null}

        {hasPrompts ? (
          <>
            <div className="vg-actions">
              <button
                type="button"
                className="save-continue"
                disabled={generateDisabled}
                onClick={runSelectedGeneration}
                title={generateMode === 'video' && selectedVideoTooLong ? `Some selected rows exceed ${modelLabel(videoModels, videoModel)} max ${videoMaxSeconds}s.` : undefined}
              >
                <span aria-hidden="true">{generateMode === 'image' ? '▧' : '▶'}</span>
                {generateLabel}
              </button>
              <button type="button" className="vg-advanced-toggle" onClick={() => setAdvancedMenu((v) => !v)}>
                Advanced {advancedMenu ? '▴' : '▾'}
              </button>
              <div className="vp-viewtoggle vg-viewtoggle">
                <button type="button" className={view === 'prompts' ? 'on' : ''} onClick={() => setView('prompts')}>Prompts</button>
                <button type="button" className={view === 'gallery' ? 'on' : ''} onClick={() => setView('gallery')}>Gallery</button>
              </div>
            </div>

            {advancedMenu ? (
              <div className="vg-advanced-panel">
                <div className="vg-advanced-section">
                  <span className="vp-menu-h">GENERATE MODE</span>
                  <span className="vg-select-wrap">
                    <button type="button" className="vp-menu-btn vg-select-btn" onClick={() => setAdvancedSelectMenu((m) => (m === 'generate' ? null : 'generate'))}>
                      {generateMode === 'image' ? 'Generate images' : 'Generate videos'} ▾
                    </button>
                    {advancedSelectMenu === 'generate' ? (
                      <>
                        <span className="vp-menu-backdrop" onClick={() => setAdvancedSelectMenu(null)} />
                        <span className="vp-menu">
                          <span className="vp-menu-h">GENERATE MODE</span>
                          <button type="button" className={generateMode === 'image' ? 'on' : ''} onClick={() => selectGenerateMode('image')}>
                            <span>▧ Generate images</span>
                            <small>{selectedImageRows.length} selected</small>
                          </button>
                          <button type="button" className={generateMode === 'video' ? 'on' : ''} onClick={() => selectGenerateMode('video')}>
                            <span>▶ Generate videos</span>
                            <small>{selectedEligibleVideoRows.length}/{selectedVideoRows.length} valid</small>
                          </button>
                        </span>
                      </>
                    ) : null}
                  </span>
                </div>

                <div className="vg-advanced-section">
                  <span className="vp-menu-h">IMAGE MODEL</span>
                  <span className="vg-select-wrap">
                    <button type="button" className="vp-menu-btn vg-select-btn" onClick={() => setAdvancedSelectMenu((m) => (m === 'image' ? null : 'image'))}>
                      {modelLabel(imageModels, imageModel)} · {imageModelDefaultNote} ▾
                    </button>
                    {advancedSelectMenu === 'image' ? (
                      <>
                        <span className="vp-menu-backdrop" onClick={() => setAdvancedSelectMenu(null)} />
                        <span className="vp-menu">
                          <span className="vp-menu-h">IMAGE MODEL</span>
                          {imageModels.map((model) => (
                            <button type="button" key={model.id} className={imageModel === model.id ? 'on' : ''} onClick={() => setMediaModel('image', model.id)}>
                              <span>{model.label}</span>
                              <small>{model.id === defaultImageModel ? 'default' : model.note}</small>
                            </button>
                          ))}
                        </span>
                      </>
                    ) : null}
                  </span>
                </div>

                <div className="vg-advanced-section">
                  <span className="vp-menu-h">VIDEO MODEL</span>
                  <span className="vg-select-wrap">
                    <button type="button" className="vp-menu-btn vg-select-btn" onClick={() => setAdvancedSelectMenu((m) => (m === 'video' ? null : 'video'))}>
                      {modelLabel(videoModels, videoModel)} · {videoModelDefaultNote} ▾
                    </button>
                    {advancedSelectMenu === 'video' ? (
                      <>
                        <span className="vp-menu-backdrop" onClick={() => setAdvancedSelectMenu(null)} />
                        <span className="vp-menu">
                          <span className="vp-menu-h">VIDEO MODEL</span>
                          {videoModels.map((model) => (
                            <button type="button" key={model.id} className={videoModel === model.id ? 'on' : ''} onClick={() => setMediaModel('video', model.id)}>
                              <span>{model.label}</span>
                              <small>{model.id === defaultVideoModel ? 'default' : model.note}</small>
                            </button>
                          ))}
                        </span>
                      </>
                    ) : null}
                  </span>
                </div>

                <div className="vg-advanced-section wide">
                  <span className="vp-menu-h">PROMPT ACTIONS</span>
                  <div className="vg-advanced-actions">
                    <button
                      type="button"
                      className="vp-undo vg-action-btn"
                      disabled={activeProcess}
                      title="Free — recomposes every prompt from the approved shot list (picks up composer/style changes). Replaces all prompt text, discards manual prompt edits, and resets the approval."
                      onClick={() => {
                        if (window.confirm('Rebuild ALL prompts from the shot list? Manual prompt edits are replaced and the approval resets.')) void buildPrompts()
                      }}
                    >
                      Rebuild from shot list
                    </button>
                    <button type="button" className="vp-undo vg-action-btn" disabled={activeProcess || timingSyncing} onClick={syncAudioTiming}>
                      {timingSyncing ? 'Syncing timing…' : 'Sync timing from narration audio'}
                    </button>
                    <span className={`vg-split-action ${regenNoteOpen ? 'open' : ''}`}>
                      <button
                        type="button"
                        className="vg-split-toggle"
                        disabled={regenCurrentDisabled}
                        onClick={() => setRegenNoteOpen((value) => !value)}
                        title="Add a note before regenerating prompts"
                      >
                        ▾
                      </button>
                      <button type="button" className="vp-undo vg-split-main" disabled={regenCurrentDisabled} onClick={() => regeneratePromptRows('current')}>
                        Regenerate prompts
                      </button>
                    </span>
                    {failedImageRows.length ? (
                      <button
                        type="button"
                        className="vp-undo vg-action-btn"
                        disabled={activeProcess}
                        onClick={() => generateImages(failedImageRows.map((row) => row.id), true)}
                      >
                        Retry failed images
                      </button>
                    ) : null}
                    <button type="button" className="vp-undo vg-action-btn" disabled={regenImageDisabled} onClick={() => regeneratePromptRows('image')}>
                      Regenerate as image prompts
                    </button>
                    <button type="button" className="vp-undo vg-action-btn" disabled={regenVideoDisabled} onClick={() => regeneratePromptRows('video')}>
                      Regenerate as video prompts
                    </button>
                  </div>
                  {regenNoteOpen ? (
                    <div className="vg-regen-note-panel">
                      <textarea
                        value={regenNote}
                        onChange={(e) => setRegenNote(e.target.value)}
                        placeholder="Tell the AI what to change — e.g. more motion, simpler wording, less UI detail..."
                        rows={3}
                      />
                      <button type="button" className="vp-undo" disabled={regenCurrentDisabled} onClick={() => regeneratePromptRows('current')}>
                        Regenerate prompts
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}

            <div className="vg-modelbar">
              <span className="vg-prompt-count">{rows.length} generation prompts from shot-list JSON</span>
              <span className="vg-progress-group">
                {showProgressBar ? (
                  <span className={`progress ${progress.total && progress.done >= progress.total ? 'done' : ''}`}>
                    <i style={{ width: `${progress.pct}%` }} />
                  </span>
                ) : null}
                <span className="vg-progress-count">{progress.total ? `${progress.done}/${progress.total} generated` : 'waiting for generation'}</span>
              </span>
              <span className="vg-model-summary">
                {generateMode === 'image'
                  ? `${modelLabel(imageModels, imageModel)} · ${imageModelDefaultNote}`
                  : `${modelLabel(videoModels, videoModel)} · ${videoModelDefaultNote}`}
              </span>
            </div>
          </>
        ) : null}

        {loading ? <p className="vp-hint">Loading visual generation state…</p> : null}
        {buildError ? <p className="run-error">{buildError}</p> : null}
        {hasPrompts && view === 'prompts' ? (
          <div className="vg-list">
            <div className="vg-selectionbar">
              <button type="button" className="vp-undo" onClick={toggleAllSelection}>
                {selected.size === rows.length ? 'Deselect all' : 'Select all'}
              </button>
              <span className="vg-note">{selected.size} selected</span>
              {saveNote ? <span className="vg-save-note">{saveNote}</span> : null}
            </div>
            {rows.map((row) => {
              const previewMedia = rowPreviewMedia(row)
              const firstFrameEntries = row.references
                .map((ref, index) => ({ ref, index }))
                .filter(({ ref }) => ref.role === 'first_frame' && referenceValue(ref))
              const referenceEntries = row.references
                .map((ref, index) => ({ ref, index }))
                .filter(({ ref }) => ref.role !== 'first_frame' && referenceValue(ref))
              const AUD = new Set(['voice', 'music', 'ambience', 'sfx', 'audio'])
              const kitOf = (n: string) => kitObjs.find((k) => k.name === n)
              // Associations with no image slot: prompt-only objects and audio.
              const namedRefs = row.references.map((ref) => String(ref.name || '')).filter(Boolean)
              // Kit-attached image refs resolve their picture from the KIT
              // (the doc row carries only the name until upload time).
              const kitImageEntries = row.references
                .map((ref, index) => ({ ref, index, name: String(ref.name || '') }))
                .filter(({ ref, name }) => !referenceValue(ref) && kitOf(name)?.image_path)
              const textAssoc = row.references
                .map((ref, index) => ({ ref, index, name: String(ref.name || '') }))
                .filter(({ ref, name }) => !referenceValue(ref) && name && !AUD.has(kitOf(name)?.kind ?? '') && !kitOf(name)?.image_path)
              const audioAssoc = namedRefs.filter((n) => AUD.has(kitOf(n)?.kind ?? ''))
              const audioInherited = kitObjs
                .filter((k) => AUD.has(k.kind) && k.linked_to && !audioAssoc.includes(k.name))
                .filter((k) => namedRefs.some((n) => n === k.linked_to || kitOf(n)?.variant_of === k.linked_to))
              const renderAssetThumb = ({ ref, index }: { ref: PromptReference; index: number }, variant: 'first_frame' | 'reference') => {
                const value = referenceValue(ref)
                const src = referenceSrc(value)
                const name = ref.name || value
                return (
                  <span className={`vg-ref-thumb ${variant === 'first_frame' ? 'first-frame' : ''}`} key={`${row.id}-${value}-${index}`} title={variant === 'first_frame' ? `${name} — attached as the 1ST FRAME (the video opens on this exact image)` : `${name} — attached as a reference image (uploads to the model)`}>
                    {variant === 'first_frame' ? <i className="vg-ff-flag">1st frame</i> : null}
                    <button
                      type="button"
                      className="vg-ref-img"
                      title={name}
                      onClick={() => setPreviewRef({ src, name, rowId: row.id, refIndex: index, role: variant })}
                    >
                      <img src={src} alt={name} />
                    </button>
                    <button
                      type="button"
                      className="vg-ref-remove"
                      title="Remove asset"
                      onClick={(event) => {
                        event.stopPropagation()
                        void removeReferenceAsset(row.id, index)
                      }}
                    >
                      ×
                    </button>
                  </span>
                )
              }
              return (
              <section className={`vg-row ${selected.has(row.id) ? 'on' : ''} ${row.status === 'generating' || promptBusyIds.has(row.id) ? 'busy' : ''}`} key={row.id}>
                <div className="vg-row-head">
                  <label className="vg-select">
                    <input type="checkbox" checked={selected.has(row.id)} onChange={() => toggle(row.id)} />
                    <span className="id">{row.id}</span>
                  </label>
                  <b>{row.title}</b>
                  <span className="vg-meta">{row.duration} · {row.aspect} · {row.resolution} · {row.mediaModel}</span>
                  <span className="vg-typepick vg-row-type">
                    <button type="button" className={row.type === 'image' ? 'on' : ''} onClick={() => changeRowType(row.id, 'image')}>Image</button>
                    <button
                      type="button"
                      className={row.type === 'video' ? 'on' : ''}
                      title={videoTooLong(row) ? `${videoDisabledTitle(row)} Generation stays disabled until the model/duration fits.` : `Use ${modelLabel(videoModels, videoModel)} for this row`}
                      onClick={() => changeRowType(row.id, 'video')}
                    >
                      Video
                    </button>
                  </span>
                  <span className={`status-pill ${row.status === 'image_ready' || row.status === 'video_ready' ? 'done' : row.status === 'generating' || promptBusyIds.has(row.id) ? 'work' : ''}`}>
                    {promptBusyIds.has(row.id) ? 'prompt rewrite' : row.status.replace('_', ' ')}
                  </span>
                </div>
                <div className="vg-body">
                  <div className="vg-media-col">
                    <div className="vg-preview" style={{ aspectRatio: row.aspect ? row.aspect.replace(':', ' / ') : undefined }}>
                      {previewMedia ? (
                        <button
                          type="button"
                          className="vg-enlarge"
                          title="View full size"
                          onClick={() => setMediaLightbox({ kind: previewMedia.kind, src: previewMedia.src })}
                        >⤢</button>
                      ) : null}
                      {previewMedia?.kind === 'video' ? (
                        <video src={previewMedia.src} muted playsInline autoPlay controls />
                      ) : previewMedia?.kind === 'image' ? (
                        <img src={previewMedia.src} alt="" onClick={() => setMediaLightbox({ kind: 'image', src: previewMedia.src })} style={{ cursor: 'zoom-in' }} />
                      ) : (
                        <span>{row.type === 'video' ? 'video planned' : 'image preview'}</span>
                      )}
                    </div>
                    {row.type === 'video' ? (
                      <div className="vg-first-frame">
                        <div className="vg-asset-head">
                          <span className="vg-asset-label">First frame</span>
                          {!firstFrameEntries.length ? (
                            <label className="vp-undo">
                              Upload first image frame
                              <input type="file" accept="image/*" onChange={(event) => uploadReferenceAsset(row.id, event, 'first_frame')} />
                            </label>
                          ) : null}
                        </div>
                        <div className="vg-first-frame-row">
                          <span className="vg-refs">
                            {firstFrameEntries.length ? firstFrameEntries.map((entry) => renderAssetThumb(entry, 'first_frame')) : <span>no first frame image</span>}
                          </span>
                        </div>
                      </div>
                    ) : null}
                  </div>
                  <div className="vg-prompt">
                    <div className="vg-prompt-editor">
                      <textarea
                        value={row.draftText}
                        onChange={(e) => setDrafts((prev) => ({ ...prev, [row.id]: e.target.value }))}
                        onBlur={() => persistDraft(row.id)}
                        spellCheck={false}
                      />
                      <div className="vg-row-actions">
                        {row.status === 'generating' ? (
                          <span className="vg-row-run">
                            Generating {batchStatus?.media_type === 'video' ? 'video' : 'image'}...
                          </span>
                        ) : null}
                        <label className="vp-undo">
                          Upload reference image
                          <input type="file" accept="image/*" onChange={(event) => uploadReferenceAsset(row.id, event, 'reference')} />
                        </label>
                        {row.type === 'image' ? (
                          <button type="button" className="vp-undo vg-generate-main" disabled={activeProcess} onClick={() => generateImages([row.id], row.status === 'image_ready')}>
                            {row.status === 'image_ready' ? '▧ Regenerate image' : '▧ Generate image'}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="vp-undo vg-generate-main"
                            disabled={activeProcess || videoTooLong(row)}
                            title={videoTooLong(row) ? videoDisabledTitle(row) : `Use ${modelLabel(videoModels, videoModel)} for this row`}
                            onClick={() => generateVideos([row.id], row.status === 'video_ready')}
                          >
                            {row.status === 'video_ready' ? '▶ Regenerate video' : '▶ Generate video'}
                          </button>
                        )}
                      </div>
                    </div>
                    {row.parseError ? <p className="run-error">{row.parseError}</p> : null}
                    {row.status === 'failed' && batchStatus?.failed?.[row.id] ? <p className="run-error">{batchStatus.failed[row.id]}</p> : null}
                    <div className="vg-assetbar">
                      <span className="vg-refs">
                        {kitImageEntries.map(({ ref, name, index }) => (
                          <span
                            className={`vg-ref-thumb ${ref.role === 'first_frame' ? 'first-frame' : ''}`}
                            key={`kit-${index}`}
                            title={ref.role === 'first_frame'
                              ? `${name} — attached as the 1ST FRAME (the video opens on this exact image)`
                              : `${name} — attached as a reference image from the World Kit (uploads to the model)`}
                          >
                            {ref.role === 'first_frame' ? <i className="vg-ff-flag">1st frame</i> : null}
                            <span className="vg-ref-img" style={{ cursor: 'default' }}>
                              <img src={contentUrl(kitOf(name)!.image_path!)} alt={name} />
                            </span>
                          </span>
                        ))}
                        {referenceEntries.map((entry) => renderAssetThumb(entry, 'reference'))}
                        {!kitImageEntries.length && !referenceEntries.length ? <span>no reference images attached</span> : null}
                      </span>
                    </div>
                    {textAssoc.length || audioAssoc.length || audioInherited.length ? (
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
                        {textAssoc.map(({ name, index }) => (
                          <span key={`t-${index}`} className="vp-undo" style={{ cursor: 'default', borderStyle: 'dashed' }} title={kitOf(name)?.notes || `${name} — prompt-only: its description joins the prompt as text (no image goes to the model)`}>
                            {kitOf(name)?.kind || 'ref'} · {name}
                          </span>
                        ))}
                        {audioAssoc.map((n) => (
                          <span key={`a-${n}`} className="vp-undo" style={{ cursor: 'default' }} title={kitOf(n)?.notes || `${n} — sound direction + reference audio for this clip`}>
                            ♪ {n} · this clip
                          </span>
                        ))}
                        {audioInherited.map((k) => (
                          <span key={`i-${k.name}`} className="vp-undo" style={{ cursor: 'default' }} title={k.notes || k.name}>
                            ♪ {k.name}{k.kind !== 'voice' ? ` (${k.kind})` : ''} · via {k.linked_to}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              </section>
              )
            })}
          </div>
        ) : null}

        {mediaLightbox ? (
          <div className="vg-lightbox" onClick={() => setMediaLightbox(null)}>
            <button type="button" className="vg-lightbox-close" title="Close" onClick={() => setMediaLightbox(null)}>✕</button>
            {mediaLightbox.kind === 'video' ? (
              <video src={mediaLightbox.src} controls autoPlay playsInline onClick={(e) => e.stopPropagation()} />
            ) : (
              <img src={mediaLightbox.src} alt="" onClick={(e) => e.stopPropagation()} />
            )}
          </div>
        ) : null}

        {hasPrompts && view === 'gallery' ? (
          <div className="vg-gallery">
            {rows.map((row) => {
              const previewMedia = rowPreviewMedia(row)
              return (
                <button type="button" className={`vg-tile ${selected.has(row.id) ? 'on' : ''}`} key={row.id} onClick={() => { toggle(row.id); setView('prompts') }}>
                  {previewMedia?.kind === 'video' ? (
                    <video
                      src={previewMedia.src}
                      muted
                      playsInline
                      preload="metadata"
                      onMouseEnter={(event) => {
                        event.currentTarget.currentTime = 0
                        void event.currentTarget.play()
                      }}
                      onMouseLeave={(event) => {
                        event.currentTarget.pause()
                        event.currentTarget.currentTime = 0
                      }}
                      onFocus={(event) => {
                        event.currentTarget.currentTime = 0
                        void event.currentTarget.play()
                      }}
                      onBlur={(event) => {
                        event.currentTarget.pause()
                        event.currentTarget.currentTime = 0
                      }}
                    />
                  ) : previewMedia?.kind === 'image' ? (
                    <img src={previewMedia.src} alt="" />
                  ) : (
                    <span>{row.id}</span>
                  )}
                  <b>{row.title}</b>
                  <small>{row.status.replace('_', ' ')}</small>
                </button>
              )
            })}
          </div>
        ) : null}

        {previewRef ? (
          <div className="modal-scrim" onClick={() => setPreviewRef(null)}>
            <div className="confirm-modal vg-ref-modal" onClick={(event) => event.stopPropagation()}>
              <div className="vg-ref-modal-head">
                <b>{previewRef.name}</b>
                <button type="button" className="vp-undo" onClick={() => setPreviewRef(null)}>Close</button>
              </div>
              <img src={previewRef.src} alt={previewRef.name} />
              <div className="vg-ref-modal-actions">
                {previewRef.role === 'first_frame' ? (
                  <>
                    <label className="vp-undo">
                      Replace first frame
                      <input type="file" accept="image/*" onChange={(event) => uploadReferenceAsset(previewRef.rowId, event, 'first_frame')} />
                    </label>
                    <button type="button" className="vp-undo" onClick={() => setFirstFrameAsReference(previewRef.rowId, previewRef.refIndex)}>
                      Set as reference image
                    </button>
                  </>
                ) : null}
                <button type="button" className="vp-undo danger" onClick={() => removeReferenceAsset(previewRef.rowId, previewRef.refIndex)}>
                  Remove
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
