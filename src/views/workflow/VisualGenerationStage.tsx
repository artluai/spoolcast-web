import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { useWorkflowStore } from '../../store/workflow'
import { API_BASE, activeSession, actionUrl, contentUrl, downloadUrl, fileUrl, templatesUrl } from '../../lib/api'
import { appendDraftVariantRow, mergeKitWithDraft, patchDraftShotRefs, useWorldKitDraft } from '../../lib/kit-draft'
import { VariantModule, type VariantBase } from './VariantModule'
import { IMAGE_MODELS, DEFAULT_IMAGE_MODEL_ID } from '../../lib/image-models'
import { ModelPicker } from './ModelPicker'

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
  type KitLite = { name: string; kind: string; notes: string; image_path: string; linked_to?: string; variant_of?: string }
  const [rawKitObjs, setKitObjs] = useState<KitLite[]>([])
  const wkDraft = useWorldKitDraft()
  const kitObjs = useMemo(() => mergeKitWithDraft(rawKitObjs, wkDraft), [rawKitObjs, wkDraft])
  // UPSTREAM TRUTH for refs: the pacing plan (draft over file) and the shot
  // list. Anything attached there that hasn't reached this doc shows as a
  // PENDING chip, and one free sync carries it all the way through.
  const pacingDraft = useWorkflowStore((st) => st.stageDrafts['visual_pacing'] ?? '')
  const [planFileMd, setPlanFileMd] = useState('')
  const [shotEvents, setShotEvents] = useState<Record<string, { refs: string[]; pid: string }>>({})
  const [refSyncing, setRefSyncing] = useState(false)
  const [kitPickFor, setKitPickFor] = useState<string | null>(null)
  // EDIT THE OBJECT ITSELF from step 9 — one source of truth, so a variant
  // or a new take made here lands in the World Kit and shows on every step.
  const [refEdit, setRefEdit] = useState<{ rowId: string; name: string; mode: 'variant' | 'update' } | null>(null)
  const [refEditPos, setRefEditPos] = useState<{ x: number; y: number } | undefined>(undefined)
  const [updInstr, setUpdInstr] = useState('')
  const [updModel, setUpdModel] = useState(DEFAULT_IMAGE_MODEL_ID)
  const [updBusy, setUpdBusy] = useState(false)
  const loadKit = async () => {
    const out = await fetch(`${API}/source-images?session=${encodeURIComponent(activeSession())}&include_refs=1`).then((r) => (r.ok ? r.json() : null)).catch(() => null)
    if (out?.ok && Array.isArray(out.data?.kit)) setKitObjs(out.data.kit as KitLite[])
  }
  // A generated new take lands as the object's ACTIVE image (new file path).
  // Poll the kit until the path flips, then every thumbnail is the new take.
  const watchKitImage = (name: string, oldPath: string) => {
    let ticks = 0
    const iv = window.setInterval(async () => {
      ticks += 1
      const out = await fetch(`${API}/source-images?session=${encodeURIComponent(activeSession())}&include_refs=1`).then((r) => (r.ok ? r.json() : null)).catch(() => null)
      const fresh = (out?.data?.kit as KitLite[] | undefined)?.find((k) => k.name === name)
      if (fresh?.image_path && fresh.image_path !== oldPath) {
        window.clearInterval(iv)
        setKitObjs(out.data.kit as KitLite[])
        // Refresh the doc's stored reference paths (free, prompt-text-safe)
        // so thumbs and uploads point at the new take, not the snapshot.
        await fetch(actionUrl(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session: activeSession(), tenant: 'local', action: 'sync_prompt_refs' }),
        }).catch(() => null)
        await load()
        setSaveNote(`"${name}" updated — the new take is now the active image everywhere.`)
      } else if (ticks > 60) {
        window.clearInterval(iv)
      }
    }, 5000)
  }
  const runUpdateExisting = async () => {
    if (!refEdit) return
    const base = kitObjs.find((k) => k.name === refEdit.name)
    if (!base) return
    const instruction = updInstr.trim()
    if (!instruction) return
    setUpdBusy(true)
    try {
      const prompt = `${(base.notes || '').trim()}\n\nChange for this new take: ${instruction}`.trim()
      const r = await fetch(actionUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: activeSession(), tenant: 'local', action: 'generate_worldkit_ref',
          ref: refEdit.name, prompt, model: updModel,
          ...(base.image_path ? { ref_images: [base.image_path] } : {}),
          allow_cost: true,
        }),
      })
      const out = await r.json().catch(() => null)
      if (!r.ok || (out?.ok === false && !/already running/.test(out?.details || ''))) {
        throw new Error(out?.error || out?.message || 'Could not start the update generation.')
      }
      setSaveNote(`"${refEdit.name}" is regenerating — the new take becomes the active image on every step when it lands.`)
      watchKitImage(refEdit.name, base.image_path)
      setRefEdit(null)
      setUpdInstr('')
    } catch (err) {
      setBuildError(err instanceof Error ? err.message : 'Update failed.')
    } finally {
      setUpdBusy(false)
    }
  }
  // Previous generated versions per clip — regeneration archives what it
  // replaces; nothing is ever silently overwritten.
  const [mediaHistory, setMediaHistory] = useState<Record<string, { path: string; stamp: string; kind: 'image' | 'video' }[]>>({})
  const loadMediaHistory = async () => {
    const out = await fetch(`${API}/media-history?session=${encodeURIComponent(activeSession())}`).then((r) => (r.ok ? r.json() : null)).catch(() => null)
    if (out?.ok && out.data?.history) setMediaHistory(out.data.history)
  }
  useEffect(() => { void loadMediaHistory() }, [])
  const restoreVersion = async (rowId: string, path: string) => {
    const r = await fetch(actionUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: activeSession(), tenant: 'local', action: 'restore_media_version', path }),
    })
    const out = await r.json().catch(() => null)
    if (!r.ok || out?.ok === false) {
      setBuildError(out?.error || 'Could not restore the version.')
      return
    }
    setSaveNote(`${rowId}: previous version restored (the replaced one is archived too).`)
    await loadMediaHistory()
  }
  const planRefsByPid = useMemo(() => {
    const md = (pacingDraft || planFileMd || '').trim()
    const map: Record<string, string[]> = {}
    if (!md) return map
    for (const line of md.split('\n')) {
      const m = /^\|\s*(I\d+)\s*\|[^|]*\|([^|]*)\|/.exec(line.trim())
      if (!m) continue
      map[m[1]] = m[2].split(',').map((x) => x.trim().replace(/^\^/, '')).filter((x) => x && x !== '—' && x !== '-')
    }
    return map
  }, [pacingDraft, planFileMd])
  useEffect(() => {
    let live = true
    Promise.all([
      fetch(fileUrl('working/visual-pacing-plan.md')).then((r) => (r.ok ? r.json() : null)),
      fetch(fileUrl('shot-list/shot-list.json')).then((r) => (r.ok ? r.json() : null)),
    ]).then(([plan, slOut]) => {
      if (!live) return
      if (typeof plan?.data?.content === 'string') setPlanFileMd(plan.data.content)
      try {
        const sl = JSON.parse(slOut?.data?.content ?? 'null')
        const map: Record<string, { refs: string[]; pid: string }> = {}
        for (const e of sl?.base_layer ?? []) {
          map[String(e.id ?? '')] = { refs: (e.references ?? []).map(String), pid: String(e.pacing_image_id ?? '') }
        }
        setShotEvents(map)
      } catch { /* no shot list yet */ }
    })
    return () => { live = false }
  }, [])
  // BACKWARD EDIT from step 9: write the shot's refs in the PLAN (upstream
  // truth), mirror any live pacing draft, refresh, and let auto-sync carry it
  // forward. Editing only the doc would fight the sync (uploads vanish,
  // removals resurrect).
  const editShotRef = async (rowId: string, name: string, opts?: { detach?: boolean; firstFrame?: boolean }) => {
    const pid = shotEvents[rowId]?.pid
    if (!pid) throw new Error(`No pacing id for ${rowId} — re-compile the shot list first.`)
    const r = await fetch(actionUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: activeSession(), tenant: 'local', action: 'attach_ref_to_shot', image: pid, name, detach: !!opts?.detach, first_frame: !!opts?.firstFrame }),
    })
    const out = await r.json().catch(() => null)
    if (!r.ok || out?.ok === false) throw new Error(out?.error || 'Could not update the shot refs.')
    patchDraftShotRefs(pid, name, opts)
    const plan = await fetch(fileUrl('working/visual-pacing-plan.md')).then((x) => (x.ok ? x.json() : null))
    if (typeof plan?.data?.content === 'string') setPlanFileMd(plan.data.content)
  }
  const syncRefsThrough = async () => {
    setRefSyncing(true)
    try {
      // Let queued doc saves land BEFORE syncing — otherwise an older
      // in-memory doc could overwrite the synced file right after.
      await savePromptChainRef.current.catch(() => undefined)
      if (pacingDraft.trim()) {
        await fetch(actionUrl(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session: activeSession(), tenant: 'local', action: 'set_stage_output', stage_id: 'visual_pacing', path: 'working/visual-pacing-plan.md', content: pacingDraft }),
        }).catch(() => null)
      }
      for (const act of ['sync_shot_refs', 'sync_prompt_refs']) {
        const r = await fetch(actionUrl(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session: activeSession(), tenant: 'local', action: act }),
        })
        const out = await r.json().catch(() => null)
        if (!r.ok || out?.ok === false) throw new Error(out?.error || `${act} failed`)
      }
      await load()
      const slOut = await fetch(fileUrl('shot-list/shot-list.json')).then((r) => (r.ok ? r.json() : null))
      try {
        const sl = JSON.parse(slOut?.data?.content ?? 'null')
        const map: Record<string, { refs: string[]; pid: string }> = {}
        for (const e of sl?.base_layer ?? []) map[String(e.id ?? '')] = { refs: (e.references ?? []).map(String), pid: String(e.pacing_image_id ?? '') }
        setShotEvents(map)
      } catch { /* fine */ }
      setSaveNote('References synced from the plan — prompt text untouched.')
    } catch (err) {
      setBuildError(err instanceof Error ? err.message : 'Could not sync references.')
    } finally {
      setRefSyncing(false)
    }
  }
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
  useEffect(() => { if (!activeProcess) void loadMediaHistory() }, [activeProcess])
  // CLICK EACH ROW, THEY ALL RUN: clicks during a running batch queue up and
  // flush together the moment the job ends (the batch parallelizes inside).
  const [genQueue, setGenQueue] = useState<{ id: string; type: 'image' | 'video' }[]>([])
  const queueRowGeneration = (id: string, type: 'image' | 'video') => {
    if (!activeProcess) {
      if (type === 'video') void generateVideos([id])
      else void generateImages([id])
      return
    }
    setGenQueue((q) => (q.some((e) => e.id === id) ? q : [...q, { id, type }]))
  }
  useEffect(() => {
    if (activeProcess || !genQueue.length) return
    const vids = genQueue.filter((e) => e.type === 'video').map((e) => e.id)
    const imgs = genQueue.filter((e) => e.type === 'image').map((e) => e.id)
    setGenQueue([])
    if (vids.length) void generateVideos(vids)
    else if (imgs.length) void generateImages(imgs)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProcess, genQueue.length])

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
  const pendingSignature = useMemo(() => {
    const parts: string[] = []
    for (const row of rows) {
      const ev = shotEvents[row.id]
      const freshest = (ev && planRefsByPid[ev.pid]) || ev?.refs || null
      if (!freshest) continue
      const names = row.references.map((ref) => String(ref.name || '')).filter(Boolean)
      // Dangling names (no kit object) are junk, not pending work — the sync
      // drops them server-side; counting them here would loop forever.
      const missing = freshest.filter((n) => !names.includes(n) && kitObjs.some((k) => k.name === n))
      if (missing.length) parts.push(`${row.id}:${missing.join(',')}`)
    }
    return parts.join(';')
  }, [rows, shotEvents, planRefsByPid])
  // SYNC IS AUTOMATIC and SELF-HEALING: an upstream attach flows through
  // without a click. Free, prompt-text-safe, never during a running batch.
  // A diff that survives an attempt retries on a cooldown (a one-shot guard
  // left chips stuck amber after any hiccup); a few tries per distinct diff
  // caps hard-failure loops — the manual button stays as the last resort.
  const autoSyncRef = useRef({ sig: '', at: 0, tries: 0 })
  useEffect(() => {
    if (!pendingSignature || refSyncing || activeProcess) return
    const st = autoSyncRef.current
    const now = Date.now()
    if (st.sig === pendingSignature) {
      if (st.tries >= 4 || now - st.at < 15_000) return
      st.tries += 1
    } else {
      autoSyncRef.current = { sig: pendingSignature, at: now, tries: 1 }
    }
    autoSyncRef.current.at = now
    void syncRefsThrough()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSignature, refSyncing, activeProcess])
  // Re-check on an interval too — the diff can persist without any state
  // change to re-fire the effect.
  const [autoTick, setAutoTick] = useState(0)
  useEffect(() => {
    const iv = window.setInterval(() => setAutoTick((t) => t + 1), 16_000)
    return () => window.clearInterval(iv)
  }, [])
  useEffect(() => {
    if (pendingSignature && !refSyncing && !activeProcess) {
      const st = autoSyncRef.current
      if (st.sig === pendingSignature && st.tries < 4 && Date.now() - st.at >= 15_000) {
        st.tries += 1
        st.at = Date.now()
        void syncRefsThrough()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoTick])

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
    // Same regenerate rule as videos: an existing image + generate = force.
    {
      const src = onlyIds ? rows.filter((row) => onlyIds.includes(row.id)) : selectedImageRows
      force = force || src.some((row) => row.status === 'image_ready')
    }
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
    // Generating a row whose clip already EXISTS means regenerate — without
    // --force the batch skips it, reports "succeeded", and nothing reaches
    // kie (observed: 3 "regenerated" clips, zero requests).
    force = force || sourceRows.some((row) => row.status === 'video_ready')
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
  // THE STEP-7 LAW everywhere images meet: equal square footage at true
  // proportions — never a fixed crop box deciding what survives.
  const equalAreaThumb = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const im = e.currentTarget
    const r = im.naturalWidth / im.naturalHeight || 1
    const h = Math.min(190, Math.sqrt(20000 / r))
    im.style.height = `${Math.round(h)}px`
    im.style.width = `${Math.round(h * r)}px`
  }

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
    // A ref that exists upstream must be detached THERE — deleting only the
    // doc row would resurrect it on the next auto-sync.
    {
      const item = (doc.items ?? []).find((it) => String(it.id || it.chunk_id || '') === rowId)
      const name = String(item?.references?.[refIndex]?.name || '')
      const ev = shotEvents[rowId]
      const upstream = (ev && ((planRefsByPid[ev.pid] ?? ev.refs) || [])) || []
      if (name && upstream.includes(name)) {
        try {
          await editShotRef(rowId, name, { detach: true })
          setPreviewRef(null)
          setSaveNote(`${name} detached from ${rowId} — synced everywhere.`)
        } catch (err) {
          setBuildError(err instanceof Error ? err.message : 'Could not detach the reference.')
        }
        return
      }
    }
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
      // BACKWARD COMPATIBLE: the upload becomes a World Kit object (idempotent
      // by path) attached to this shot in the plan — visible at steps 5/7/8 —
      // and auto-sync carries it into these prompts.
      const imp = await fetch(actionUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: activeSession(), tenant: 'local', action: 'import_source_ref', path: localPath }),
      })
      const impOut = await imp.json().catch(() => null)
      const kitName = impOut?.data?.name as string | undefined
      if (!imp.ok || impOut?.ok === false || !kitName) throw new Error(impOut?.error || 'Could not import the upload into the World Kit.')
      await editShotRef(rowId, kitName, { firstFrame: role === 'first_frame' })
      setPreviewRef(null)
      setSaveNote(role === 'first_frame'
        ? `${rowId} first frame set — "${kitName}" joined the World Kit and syncs through.`
        : `"${kitName}" joined the World Kit, attached to ${rowId} — syncing through.`)
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
              // Freshest upstream refs for this clip: plan (draft over file)
              // by pacing id, else the compiled shot list. Anything there but
              // not in THIS doc is pending a free sync.
              const ev = shotEvents[row.id]
              const freshest = (ev && planRefsByPid[ev.pid]) || ev?.refs || null
              const pendingRefs = freshest ? freshest.filter((n) => !namedRefs.includes(n) && kitOf(n)) : []
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
                      <img src={src} alt={name} onLoad={equalAreaThumb} />
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
                    {ref.name && kitOf(String(ref.name)) ? (
                      <button
                        type="button"
                        className="vg-ref-remove"
                        style={{ right: 30 }}
                        title={`Edit ${ref.name} — a new take of this object, or a variant (one deliberate change). Lands in the World Kit, shows on every step.`}
                        onClick={(event) => {
                          event.stopPropagation()
                          setRefEditPos({ x: Math.max(16, Math.min(window.innerWidth - 700, event.clientX - 340)), y: Math.max(70, event.clientY - 40) })
                          setRefEdit(refEdit && refEdit.name === ref.name && refEdit.rowId === row.id ? null : { rowId: row.id, name: String(ref.name), mode: 'update' })
                        }}
                      >✎</button>
                    ) : null}
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
                    {(mediaHistory[row.id] ?? []).length ? (
                      <div style={{ marginTop: 10 }}>
                        <span style={{ fontSize: 10, letterSpacing: '.08em', color: 'var(--ink-3)', fontFamily: 'var(--mono)' }}>PREVIOUS VERSIONS</span>
                        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 6 }}>
                          {(mediaHistory[row.id] ?? []).map((v) => {
                            const src = `${API}/content?session=${encodeURIComponent(activeSession())}&path=${encodeURIComponent(v.path)}`
                            const when = `${v.stamp.slice(4, 6)}/${v.stamp.slice(6, 8)} ${v.stamp.slice(9, 11)}:${v.stamp.slice(11, 13)}`
                            return (
                              <div key={v.path} style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
                                <div
                                  style={{
                                    aspectRatio: row.aspect ? row.aspect.replace(':', ' / ') : '9 / 16',
                                    height: 132, flex: 'none', border: '1px solid var(--line-2)', borderRadius: 8, overflow: 'hidden',
                                    background: 'var(--bg-4)', cursor: 'zoom-in', position: 'relative', lineHeight: 0,
                                  }}
                                  title={`Archived ${when} — click to view full size`}
                                  onClick={() => setMediaLightbox({ kind: v.kind, src })}
                                >
                                  {v.kind === 'video' ? (
                                    <video src={src} muted playsInline preload="auto" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                                  ) : (
                                    <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                                  )}
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, alignSelf: 'stretch' }}>
                                  <span style={{ fontSize: 9.5, fontFamily: 'var(--mono)', color: 'var(--ink-3)' }}>{when}</span>
                                  <button
                                    type="button"
                                    className="vp-undo"
                                    style={{ fontSize: 9, padding: '2px 7px' }}
                                    title="Make this the active version again (the current one is archived, not lost)"
                                    onClick={() => void restoreVersion(row.id, v.path)}
                                  >restore</button>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    ) : null}
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
                        <button
                          type="button"
                          className="vp-undo"
                          title="Attach an existing World Kit image to this shot — lands in the plan and syncs everywhere"
                          onClick={() => setKitPickFor(kitPickFor === row.id ? null : row.id)}
                        >
                          {kitPickFor === row.id ? '▾' : '⧉'} Attach from kit
                        </button>
                        <label className="vp-undo">
                          Upload reference image
                          <input type="file" accept="image/*" onChange={(event) => uploadReferenceAsset(row.id, event, 'reference')} />
                        </label>
                        {row.type === 'image' ? (
                          <button
                            type="button"
                            className="vp-undo vg-generate-main"
                            disabled={genQueue.some((e) => e.id === row.id) || row.status === 'generating'}
                            title={activeProcess ? 'A batch is running — this row queues and starts the moment it finishes' : undefined}
                            onClick={() => queueRowGeneration(row.id, 'image')}
                          >
                            {genQueue.some((e) => e.id === row.id) ? '⏳ Queued' : row.status === 'image_ready' ? '▧ Regenerate image' : '▧ Generate image'}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="vp-undo vg-generate-main"
                            disabled={genQueue.some((e) => e.id === row.id) || row.status === 'generating' || videoTooLong(row)}
                            title={videoTooLong(row) ? videoDisabledTitle(row) : activeProcess ? 'A batch is running — this row queues and starts the moment it finishes' : `Use ${modelLabel(videoModels, videoModel)} for this row`}
                            onClick={() => queueRowGeneration(row.id, 'video')}
                          >
                            {genQueue.some((e) => e.id === row.id) ? '⏳ Queued' : row.status === 'video_ready' ? '▶ Regenerate video' : '▶ Generate video'}
                          </button>
                        )}
                      </div>
                    </div>
                    {refEdit && refEdit.rowId === row.id && refEdit.mode === 'update' ? (
                      <div style={{ border: '1px dashed var(--line-2)', borderRadius: 10, padding: 12, marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 11, color: 'var(--ink-3)', fontFamily: 'var(--mono)' }}>EDIT {refEdit.name.toUpperCase()}</span>
                          <button type="button" className="vp-undo" style={{ borderColor: 'var(--accent)', color: 'var(--accent-2)' }}>▾ Update existing</button>
                          <button type="button" className="vp-undo" title="A NEW kit object derived from this one — one deliberate change, its own history" onClick={() => setRefEdit({ ...refEdit, mode: 'variant' })}>▸ New variant</button>
                          <button type="button" className="vp-undo" style={{ marginLeft: 'auto' }} onClick={() => setRefEdit(null)}>✕</button>
                        </div>
                        <p style={{ fontSize: 11.5, color: 'var(--ink-3)', margin: 0 }}>
                          Another take of {refEdit.name} — replaces its active image EVERYWHERE (kit, board, shots, prompts) when it lands; the old take stays in its history.
                        </p>
                        <textarea
                          rows={2}
                          value={updInstr}
                          onChange={(e) => setUpdInstr(e.target.value)}
                          placeholder="e.g. show only ONE shoe, not the pair — the model reads a pair as one object"
                          style={{ display: 'block', width: '100%', boxSizing: 'border-box', resize: 'vertical', background: 'transparent', color: 'var(--ink-2)', border: '1px solid var(--line, #2a3142)', borderRadius: 6, padding: '8px 10px', fontSize: 13 }}
                        />
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end' }}>
                          <ModelPicker model={updModel} onChange={setUpdModel} disabled={updBusy} models={IMAGE_MODELS} primary={IMAGE_MODELS} />
                          <button type="button" className="vp-save" disabled={updBusy || !updInstr.trim()} onClick={() => void runUpdateExisting()}>
                            {updBusy ? 'Starting…' : '✦ Generate new take'}
                          </button>
                        </div>
                      </div>
                    ) : null}
                    {kitPickFor === row.id ? (
                      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap', border: '1px dashed var(--line-2)', borderRadius: 10, padding: 10, marginTop: 8 }}>
                        {(() => {
                          const ev = shotEvents[row.id]
                          const current = new Set([...namedRefs, ...(((ev && planRefsByPid[ev.pid]) || ev?.refs) ?? [])])
                          const options = kitObjs.filter((k) => k.image_path && !current.has(k.name))
                          if (!options.length) return <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>Every kit image is already on this shot.</span>
                          return options.map((k) => (
                            <button
                              key={k.name}
                              type="button"
                              title={`Attach ${k.name} to ${row.id}`}
                              style={{ padding: 0, border: '1px solid var(--line-2)', borderRadius: 8, overflow: 'hidden', cursor: 'pointer', background: 'none', lineHeight: 0 }}
                              onClick={() => { setKitPickFor(null); void editShotRef(row.id, k.name).catch((err) => setBuildError(err instanceof Error ? err.message : 'attach failed')) }}
                            >
                              <img src={contentUrl(k.image_path)} alt={k.name} loading="lazy" style={{ height: 72, width: 'auto', display: 'block' }} />
                            </button>
                          ))
                        })()}
                      </div>
                    ) : null}
                    {row.parseError ? <p className="run-error">{row.parseError}</p> : null}
                    {row.status === 'failed' && batchStatus?.failed?.[row.id] ? <p className="run-error">{batchStatus.failed[row.id]}</p> : null}
                    <div className="vg-assetbar" style={{ marginTop: 10 }}>
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
                              <img src={contentUrl(kitOf(name)!.image_path!)} alt={name} onLoad={equalAreaThumb} />
                            </span>
                            <button
                              type="button"
                              className="vg-ref-remove"
                              title={`Detach ${name} from this shot — everywhere (plan, shot list, prompts)`}
                              onClick={(e) => { e.stopPropagation(); void editShotRef(row.id, name, { detach: true }).catch((err) => setBuildError(err instanceof Error ? err.message : 'detach failed')) }}
                            >×</button>
                            <button
                              type="button"
                              className="vg-ref-remove"
                              style={{ right: 30 }}
                              title={`Edit ${name} — a new take of this object, or a variant (one deliberate change). Lands in the World Kit, shows on every step.`}
                              onClick={(e) => {
                                e.stopPropagation()
                                setRefEditPos({ x: Math.max(16, Math.min(window.innerWidth - 700, e.clientX - 340)), y: Math.max(70, e.clientY - 40) })
                                setRefEdit(refEdit?.name === name && refEdit.rowId === row.id ? null : { rowId: row.id, name, mode: 'update' })
                              }}
                            >✎</button>
                          </span>
                        ))}
                        {referenceEntries.map((entry) => renderAssetThumb(entry, 'reference'))}
                        {!kitImageEntries.length && !referenceEntries.length ? <span>no reference images attached</span> : null}
                      </span>
                    </div>
                    {textAssoc.length || audioAssoc.length || audioInherited.length || pendingRefs.length ? (
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8, minWidth: 0 }}>
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
                        {pendingRefs.map((n) => (
                          <span key={`pd-${n}`} className="vp-undo" style={{ cursor: 'default', borderColor: 'var(--amber)', color: 'var(--amber)' }} title={`${n} is attached upstream (plan/shot list) but not in these prompts yet — Sync refs (free) carries it through without touching prompt text.`}>
                            {AUD.has(kitOf(n)?.kind ?? '') ? '♪ ' : ''}{n} · upstream, not synced
                          </span>
                        ))}
                        {pendingRefs.length ? (
                          <button type="button" className="vp-undo" disabled={refSyncing || activeProcess} onClick={() => void syncRefsThrough()} title="Free — plan → shot list → these prompts. Reference rows update; prompt text is untouched.">
                            {refSyncing ? 'Syncing…' : '⟳ Sync refs'}
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>
              </section>
              )
            })}
          </div>
        ) : null}

        {refEdit?.mode === 'variant' ? (() => {
          const base = kitObjs.find((k) => k.name === refEdit.name)
          if (!base) return null
          return (
            <VariantModule
              base={base as VariantBase}
              kit={kitObjs.filter((k) => k.image_path) as VariantBase[]}
              initialPos={refEditPos}
              onClose={() => setRefEdit(null)}
              onCreated={(newName, instruction) => {
                appendDraftVariantRow(newName, refEdit.name, instruction)
                // THE POINT of making the variant here: this clip should use
                // it — swap it in for the base on this shot; the base object
                // itself is untouched for every other shot.
                void (async () => {
                  try {
                    await editShotRef(refEdit.rowId, newName)
                    await editShotRef(refEdit.rowId, refEdit.name, { detach: true })
                    setSaveNote(`"${newName}" created from ${refEdit.name} and swapped onto ${refEdit.rowId} — its image lands when generation finishes.`)
                  } catch (err) {
                    setBuildError(err instanceof Error ? err.message : 'Variant created but the swap failed — attach it from the kit.')
                  }
                  await loadKit()
                })()
                setRefEdit(null)
              }}
            />
          )
        })() : null}

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
