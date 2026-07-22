import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { useWorkflowStore } from '../../store/workflow'
import { API_BASE, activeSession, actionUrl, contentUrl, downloadUrl, fileUrl, templatesUrl, uploadTake } from '../../lib/api'
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
  // The PERMANENT shot id — media files are named by this, never by the
  // positional item id (which shifts when shots are added or deleted).
  pacing_image_id?: string
  // Past working prompts, oldest first (engine compile/AI-rewrite and user
  // edits all append; capped engine-side).
  prompt_history?: { prompt?: string; at?: string; by?: string }[]
  // Past "Improve prompt with AI" instructions, oldest first (engine appends
  // on each rewrite; carried across rebuilds).
  improve_notes?: { note?: string; at?: string }[]
  // Per-clip model override — beats the doc-level preferred model.
  video_model?: string
  image_model?: string
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
  /** Media key: the permanent shot id that owns this row's takes on disk. */
  mid: string
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

// One take in the session's asset library: any media file on disk, grouped
// by the permanent shot id that owns it. Orphaned owners (shot deleted from
// the board) keep their takes forever — attachable to any shot.
type LibraryTake = {
  path: string
  kind: 'image' | 'video'
  active: boolean
  stamp: string
  origin: string
  model?: string
  original_name?: string
}

type LibraryGroup = {
  id: string
  on_board: boolean
  takes: LibraryTake[]
}

const imageModels = [
  { id: 'nano-banana-2', label: 'Nano Banana 2', note: 'fast draft quality' },
  { id: 'nano-banana-pro', label: 'Nano Banana Pro', note: 'higher quality' },
  { id: 'gpt-image-2-text-to-image', label: 'GPT Image 2', note: 'strong prompt following' },
]

// Prompt/duration limits per kie.ai docs — each model enforces its own cap
// at submit, so the counter must show the limit of the model the ROW uses.
const videoModels = [
  { id: 'seedance-2-fast', label: 'Seedance 2 Fast', note: 'faster, lower cost · max 15s', maxSeconds: 15, maxChars: 20000 },
  { id: 'seedance-2', label: 'Seedance 2', note: 'higher quality · max 15s', maxSeconds: 15, maxChars: 20000 },
  { id: 'kling-3.0', label: 'Kling 3.0', note: 'std/pro/4K · max 15s · prompt ≤2,500', maxSeconds: 15, maxChars: 2500 },
  { id: 'kling-3.0-turbo', label: 'Kling 3.0 Turbo', note: 'faster kling · max 15s · one image only', maxSeconds: 15, maxChars: 2500 },
  { id: 'veo-3.1', label: 'Veo 3.1', note: 'always with audio · 4/6/8s only', maxSeconds: 8, maxChars: 5000 },
  { id: 'veo-3.1-fast', label: 'Veo 3.1 Fast', note: 'faster veo · 4/6/8s only', maxSeconds: 8, maxChars: 5000 },
  { id: 'happyhorse-1.1', label: 'HappyHorse 1.1', note: 'up to 9 refs · max 15s', maxSeconds: 15, maxChars: 5000 },
]

function modelLabel(models: { id: string; label: string }[], id: string) {
  return models.find((model) => model.id === id)?.label || id
}

function selectedVideoModelLimit(modelId: string) {
  return videoModels.find((model) => model.id === modelId)?.maxSeconds ?? 8
}

function videoModelMaxChars(modelId: string) {
  return videoModels.find((model) => model.id === modelId)?.maxChars ?? 20000
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

/** Permanent shot id for a prompt item — the key its media files live under.
 *  Old docs (before the engine stamped pacing_image_id on items) fall back to
 *  the item id; the two only diverge after shots are added or deleted. */
function itemMediaId(item: GenerationPromptItem, pids?: Record<string, string>) {
  const id = String(item.id || item.chunk_id || '').trim()
  return String(item.pacing_image_id || '').trim() || (pids?.[id] ?? '') || id
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

// THE WORKING PROMPT IS ALWAYS THE NEWEST TEXT (engine recompile or user
// edit) — never silently shadowed by what the current take happened to be
// generated from. An earlier build back-filled prompt_variants from the
// manifest's as-sent prompts, which permanently hid fresh recompiles behind
// stale text (user report 2026-07-22). Those echoes are stripped here —
// including ones already saved into existing docs; "what was sent" lives in
// the record fold under each row instead. Variants the user created by
// toggling image/video don't match any as-sent prompt and survive.
function stripManifestEchoVariants(
  doc: GenerationPromptsDoc | null,
  manifest: SceneManifest | null,
): { doc: GenerationPromptsDoc | null; changed: boolean } {
  if (!doc?.items?.length || !manifest?.items?.length) return { doc, changed: false }
  // ANY as-sent prompt counts as an echo — the old overlay matched the
  // manifest by POSITIONAL id, so an item can carry a different shot's
  // as-sent text. A byte-identical copy of a sent prompt is never
  // user-authored.
  const sentPrompts = new Set(
    (manifest.items ?? [])
      .map((row) => String(row.prompt || '').trim())
      .filter(Boolean),
  )
  let changed = false
  const items = doc.items.map((item) => {
    const variants = item.prompt_variants
    if (!variants) return item
    const next = { ...variants }
    let itemChanged = false
    for (const type of ['image', 'video'] as const) {
      const variantPrompt = String(next[type]?.prompt || '').trim()
      if (!variantPrompt) continue
      if (sentPrompts.has(variantPrompt)) {
        delete next[type]
        itemChanged = true
      }
    }
    if (!itemChanged) return item
    changed = true
    if (!Object.keys(next).length) {
      const { prompt_variants: _stripped, ...rest } = item
      return rest
    }
    return { ...item, prompt_variants: next }
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
    const mid = itemMediaId(item)
    if (!id || item.output_type !== 'video' || item.first_frame_removed || (!completed.has(id) && manifestReady.get(mid) !== 'image')) return item
    const relPath = generatedSceneRel(mid)
    const refs = Array.isArray(item.references) ? item.references : []
    if (hasFirstFrameReference(refs, relPath)) return item
    changed = true
    return {
      ...item,
      references: [defaultFirstFrameReference(mid), ...refs],
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
  pids?: Record<string, string>,
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
    // Batch status keys by the positional item id; media (the manifest) keys
    // by the permanent shot id. Both are consulted on purpose.
    const mid = itemMediaId(item, pids)
    const type = item.output_type || defaultType
    const mediaType = type === 'video' ? 'video' : 'image'
    const payload = promptParts(item, doc)
    const prompt = itemPromptForType(item, mediaType)
    const mediaModel = (type === 'video' ? (item.video_model as string | undefined) : (item.image_model as string | undefined))
      || (type === 'video' ? videoModel : imageModel)
    let rowStatus: RowStatus = 'not_run'
    if (failed[id]) rowStatus = 'failed'
    else if (running && (!targetIds.size || targetIds.has(id)) && !doneIds.has(id)) rowStatus = 'generating'
    else if (ready.get(mid) === 'video' && type === 'video') rowStatus = 'video_ready'
    else if (ready.get(mid) === 'image' && type !== 'video') rowStatus = 'image_ready'
    // The completed list keys by the POSITIONAL id of the run that wrote it,
    // so after shots move it can vouch for the wrong row. Only trust it while
    // a run is live (manifest not landed yet) or when no manifest exists.
    else if (doneIds.has(id) && (running || !manifest?.items?.length)) rowStatus = type === 'video' ? 'video_ready' : 'image_ready'
    return {
      item,
      id,
      mid,
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
      const type = activeOutputType(item, doc.default_output_type || 'image')
      // PAST PROMPTS ARE KEPT: a user edit that replaces the working prompt
      // records the outgoing one (same list the engine appends to).
      const oldPrompt = itemPromptForType(item, type === 'video' ? 'video' : 'image').trim()
      const next = withPromptForType(item, type, prompt || String(item.prompt || ''))
      if (!prompt || !oldPrompt || oldPrompt === prompt) return next
      const hist = Array.isArray(item.prompt_history) ? item.prompt_history : []
      return { ...next, prompt_history: [...hist, { prompt: oldPrompt, at: new Date().toISOString().slice(0, 19), by: 'you' }].slice(-12) }
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
  // Video-first: the clips carry their own sound, so there is no narration
  // track to sync timing from — that action is meaningless here.
  const [videoFirst, setVideoFirst] = useState(false)
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
  // Which text-reference cards are expanded to full content (`rowId:name`).
  const [openTxtCards, setOpenTxtCards] = useState<Set<string>>(new Set())
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
  // THE PROMPT EACH CLIP WAS ACTUALLY MADE FROM — frozen at submit time by
  // the engine, never edited by anyone. The textarea above is the WORKING
  // prompt for the NEXT generation; this is the record of the current one.
  const [usedPrompts, setUsedPrompts] = useState<Record<string, { prompt: string; model?: string; generated_at?: string }>>({})
  const loadUsedPrompts = async (pairs: { id: string; mid: string }[]) => {
    // Sidecars live next to the media → named by the PERMANENT shot id;
    // stored under the row id, which is what the render below looks up.
    const entries = await Promise.all(pairs.map(async ({ id, mid }) => {
      const out = await fetch(fileUrl(`source/generated-assets/videos/${mid}.json`)).then((r) => (r.ok ? r.json() : null)).catch(() => null)
      try {
        const j = JSON.parse(out?.data?.content ?? 'null')
        if (j?.prompt) return [id, { prompt: String(j.prompt), model: j.model, generated_at: j.generated_at }] as const
      } catch { /* no sidecar for this clip (pre-provenance generation) */ }
      return null
    }))
    setUsedPrompts(Object.fromEntries(entries.filter((e): e is NonNullable<typeof e> => !!e)))
  }
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
  // THE ASSET LIBRARY: every take on disk grouped by its permanent owner.
  // Deleting a shot orphans its takes — they stay here, attachable to any
  // shot. Attaching COPIES (the same asset may serve several shots).
  const [library, setLibrary] = useState<LibraryGroup[] | null>(null)
  const [attachPickFor, setAttachPickFor] = useState<string | null>(null)
  const [attachBusy, setAttachBusy] = useState(false)
  const loadLibrary = async () => {
    const out = await fetch(`${API}/asset-library?session=${encodeURIComponent(activeSession())}`).then((r) => (r.ok ? r.json() : null)).catch(() => null)
    if (out?.ok && Array.isArray(out.data?.library)) setLibrary(out.data.library as LibraryGroup[])
  }
  const refreshAfterTakeChange = async () => {
    await load()
    await Promise.all([loadMediaHistory(), loadLibrary()])
  }
  const attachTake = async (row: PromptRow, take: LibraryTake) => {
    setAttachBusy(true)
    try {
      const r = await fetch(actionUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: activeSession(), tenant: 'local', action: 'attach_take_to_shot', path: take.path, shot_id: row.mid }),
      })
      const out = await r.json().catch(() => null)
      if (!r.ok || out?.ok === false) throw new Error(out?.error || 'Could not attach the take.')
      setAttachPickFor(null)
      // Keep the row's medium in step with what it now shows.
      if (take.kind === 'video' && row.type !== 'video') changeRowType(row.id, 'video')
      else if (take.kind === 'image' && row.type === 'video') changeRowType(row.id, 'image')
      setSaveNote(`${row.mid}: take attached from the library — anything it replaced moved to previous versions.`)
      await refreshAfterTakeChange()
    } catch (err) {
      setBuildError(err instanceof Error ? err.message : 'Could not attach the take.')
    } finally {
      setAttachBusy(false)
    }
  }
  const uploadOwnTake = async (row: PromptRow, event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setAttachBusy(true)
    try {
      const out = await uploadTake(row.mid, file)
      if (!out || out.ok === false) throw new Error(out?.error || 'Could not upload the file.')
      const kind = out.data?.kind
      if (kind === 'video' && row.type !== 'video') changeRowType(row.id, 'video')
      else if (kind === 'image' && row.type === 'video') changeRowType(row.id, 'image')
      setSaveNote(`${row.mid}: your own ${kind || 'file'} is now this shot's take — anything it replaced moved to previous versions.`)
      await refreshAfterTakeChange()
    } catch (err) {
      setBuildError(err instanceof Error ? err.message : 'Could not upload the file.')
    } finally {
      setAttachBusy(false)
    }
  }
  const planRefsByPid = useMemo(() => {
    const md = (pacingDraft || planFileMd || '').trim()
    const map: Record<string, string[]> = {}
    if (!md) return map
    for (const line of md.split('\n')) {
      // Plan ids come in every generation: I3, I07b, IMG01, S06.
      const m = /^\|\s*([A-Za-z]{1,4}\d+[a-z]?)\s*\|[^|]*\|([^|]*)\|/.exec(line.trim())
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
      // The KIT draft must reach the file too: the engine's sync validates
      // ref names against world-kit.md, so a draft-only object (a new audio
      // added at step 5, unsaved) would be dropped as dangling every attempt.
      if (wkDraft.trim()) {
        await fetch(actionUrl(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session: activeSession(), tenant: 'local', action: 'set_stage_output', stage_id: 'world_kit', path: 'working/world-kit.md', content: wkDraft }),
        }).catch(() => null)
      }
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

  // A RUNNING BATCH SURVIVES NAVIGATION AND RELOADS (same pattern as step
  // 7's compile job): the job id persists in localStorage; on mount, if the
  // engine says it is still running, the watch resumes — without this a
  // reload orphaned the batch and finished videos never populated the rows.
  const batchJobKey = `spoolcast-batch-job:${activeSession()}`
  useEffect(() => {
    if (stageProcess) return
    const jobId = window.localStorage.getItem(batchJobKey)
    if (!jobId) return
    void readJsonFile<{ state?: string; job?: string; command?: string[] }>(`working/jobs/${jobId}.json`)
      .then((job) => {
        if (['created', 'running'].includes(String(job?.state || ''))) {
          // Prompt rewrites carry their target rows in the job command
          // (--ids S04,…) — restore the per-row busy marks too, so a
          // reload mid-rewrite still shows which prompt is cooking.
          if (job?.job === 'rewrite_generation_prompts' && Array.isArray(job.command)) {
            const idx = job.command.indexOf('--ids')
            const ids = idx >= 0 ? String(job.command[idx + 1] || '').split(',').filter(Boolean) : []
            if (ids.length) setPromptBusyIds(new Set(ids))
          }
          setStageProcess(stageId, { stageId, jobId, status: 'running', label: 'Resuming background work…', updatedAt: new Date().toISOString() })
        } else {
          window.localStorage.removeItem(batchJobKey)
        }
      })
      .catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // CLICK EACH ROW, THEY ALL RUN: clicks during a running batch queue up and
  // flush together the moment the job ends (the batch parallelizes inside).
  const [genQueue, setGenQueue] = useState<{ id: string; type: 'image' | 'video' }[]>([])
  // Per-row "✦ Update prompt with AI": click drops the note box; the note
  // runs a single-row rewrite (script/voice lines protected by the rewriter).
  const [rowAiFor, setRowAiFor] = useState<string | null>(null)
  const [rowAiNote, setRowAiNote] = useState('')
  const [rowAiBusy, setRowAiBusy] = useState<string | null>(null)
  // Which row's model-override menu is open (same vp-menu design as ADVANCED).
  const [rowModelMenu, setRowModelMenu] = useState<string | null>(null)
  const rowAiUpdate = async (id: string) => {
    const instruction = rowAiNote.trim()
    if (!instruction) return
    setRowAiBusy(id)
    try {
      const r = await fetch(actionUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: activeSession(), tenant: 'local', action: 'rewrite_generation_prompts', allow_cost: true, ids: [id], output_type: 'current', instruction }),
      })
      const out = await r.json().catch(() => null)
      if (!r.ok || out?.ok === false) throw new Error(out?.message || out?.error || 'AI update failed.')
      // HEAVY ACTION: the engine returns "started … job <id>" immediately —
      // the rewrite itself takes minutes. Track the job like every other
      // background run (the poll effect reloads the doc when it lands);
      // reporting success here made the button look like it did nothing.
      const jobId = String(out?.data?.stdout || '').match(/started\s+\S+\s+job\s+([^\s]+)/)?.[1]
      if (!jobId) throw new Error('AI update started but did not return a job id.')
      window.localStorage.setItem(batchJobKey, jobId)
      setDrafts((prev) => { const n = { ...prev }; delete n[id]; return n })
      setPromptBusyIds(new Set([id]))
      setRowAiFor(null)
      setRowAiNote('')
      setSaveNote(`${id}: AI is rewriting the prompt — it lands here when done.`)
      setStageProcess(stageId, {
        stageId,
        jobId,
        status: 'running',
        label: `${id}: AI is rewriting the prompt…`,
        updatedAt: new Date().toISOString(),
      })
    } catch (err) {
      setBuildError(err instanceof Error ? err.message : 'AI update failed.')
    } finally {
      setRowAiBusy(null)
    }
  }
  const setRowModel = async (id: string, type: 'image' | 'video', modelId: string) => {
    if (!doc) return
    const key = type === 'video' ? 'video_model' : 'image_model'
    const nextDoc = { ...doc, items: (doc.items ?? []).map((it) => (String(it.id || it.chunk_id || '') === id ? { ...it, [key]: modelId } : it)) }
    snapshotDoc()
    await queueSavePromptDoc(nextDoc)
    setDoc(nextDoc)
    setSaveNote(`${id}: model set to ${modelLabel(type === 'video' ? videoModels : imageModels, modelId)}.`)
  }
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
      const promptVariantMigrated = stripManifestEchoVariants(promptDoc, manifestDoc)
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
        if (hit?.format === 'video-first' || policy === 'video') { setDefaultType('video'); setVideoFirst(true) }
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
          window.localStorage.removeItem(batchJobKey)
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

  // Fallback pid map for docs older than the engine's pacing_image_id stamp.
  const rowPids = useMemo(
    () => Object.fromEntries(Object.entries(shotEvents).map(([id, ev]) => [id, ev.pid])),
    [shotEvents],
  )
  const rows = useMemo(
    () => normalizeRows(doc, batchStatus, sceneManifest, defaultType, imageModel, videoModel, drafts, errors, rowPids),
    [doc, batchStatus, sceneManifest, defaultType, imageModel, videoModel, drafts, errors, rowPids],
  )

  const progress = useMemo(() => {
    const total = rows.length
    const ready = mediaReadyMap(sceneManifest)
    const done = rows.filter((row) => ready.has(row.mid) || row.status === 'image_ready' || row.status === 'video_ready').length
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
  useEffect(() => {
    const ids = rows.filter((r) => r.type === 'video').map((r) => ({ id: r.id, mid: r.mid }))
    if (ids.length && !activeProcess) void loadUsedPrompts(ids)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length, activeProcess])
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
      window.localStorage.setItem(batchJobKey, jobId)
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
      if (jobId) window.localStorage.setItem(batchJobKey, jobId)
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
      if (jobId) window.localStorage.setItem(batchJobKey, jobId)
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
          const mid = itemMediaId(item, rowPids)
          const relPath = generatedSceneRel(mid)
          const nextRefs = completed.has(itemId) && !hasFirstFrameReference(refs, relPath)
            ? [defaultFirstFrameReference(mid), ...refs]
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
      const videoSrc = sceneVideoSrc(row.mid)
      if (videoSrc) return { kind: 'video', src: videoSrc }
    }
    const firstFrame = firstFrameReference(row)
    if (row.type === 'video' && firstFrame) return { kind: 'image', src: referenceSrc(referenceValue(firstFrame)) }
    if (row.status === 'image_ready') return { kind: 'image', src: sceneImageSrc(row.mid) }
    return null
  }

  // A TAKE BELONGS TO THE PROMPT THAT MADE IT (user rule, option A): when
  // the working prompt no longer matches the active take's as-sent prompt,
  // the slot PRESENTS as empty ("nothing generated for this prompt yet")
  // and the take is listed under Previous versions. The FILE stays in place
  // until regeneration archives it, so step 9 and the final cut keep
  // working — merely marked stale — while the user edits.
  const sentPromptFor = (row: PromptRow): string => (
    usedPrompts[row.id]?.prompt
    || String(mediaManifestItem(sceneManifest, row.mid, row.type === 'video' ? 'video' : 'image')?.prompt || '')
  )
  const takeOutdated = (row: PromptRow): boolean => {
    if (row.status !== 'video_ready' && row.status !== 'image_ready') return false
    const sent = sentPromptFor(row).trim()
    if (!sent) return false
    const working = String(row.draftText ?? row.prompt).trim()
    // The engine appends (voice pins, speech guards) to the prompt before
    // sending — a sent prompt that STARTS with the working text is the same
    // prompt, not a newer one.
    return !(sent === working || sent.startsWith(working))
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
                    <button
                      type="button"
                      className="vp-undo vg-action-btn"
                      disabled={activeProcess || timingSyncing || videoFirst}
                      title={videoFirst ? 'Video-first — the clips carry their own sound; there is no narration track to sync from.' : undefined}
                      onClick={syncAudioTiming}
                    >
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
              <button
                type="button"
                className="vp-undo"
                disabled={!rows.some((row) => row.status !== 'image_ready' && row.status !== 'video_ready')}
                title="Select only the clips with no generated file yet"
                onClick={() => setSelected(new Set(rows.filter((row) => row.status !== 'image_ready' && row.status !== 'video_ready').map((row) => row.id)))}
              >
                Select remaining
              </button>
              <span className="vg-note">{selected.size} selected</span>
              {saveNote ? <span className="vg-save-note">{saveNote}</span> : null}
            </div>
            {rows.map((row) => {
              const outdated = takeOutdated(row)
              const previewMedia = outdated ? null : rowPreviewMedia(row)
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
                    <span className="vp-map-cardacts" onClick={(event) => event.stopPropagation()}>
                      {ref.name && kitOf(String(ref.name)) ? (
                        <span
                          title={`Edit ${ref.name} — a new take of this object, or a variant (one deliberate change). Lands in the World Kit, shows on every step.`}
                          onClick={(event) => {
                            setRefEditPos({ x: Math.max(16, Math.min(window.innerWidth - 700, event.clientX - 340)), y: Math.max(70, event.clientY - 40) })
                            setRefEdit(refEdit && refEdit.name === ref.name && refEdit.rowId === row.id ? null : { rowId: row.id, name: String(ref.name), mode: 'update' })
                          }}
                        >✎</span>
                      ) : null}
                      <span title="Remove asset" onClick={() => { void removeReferenceAsset(row.id, index) }}>✕</span>
                    </span>
                  </span>
                )
              }
              return (
              <section className={`vg-row ${selected.has(row.id) ? 'on' : ''} ${row.status === 'generating' || promptBusyIds.has(row.id) ? 'busy' : ''}`} key={row.id}>
                <div className="vg-row-head">
                  <label className="vg-select">
                    <input type="checkbox" checked={selected.has(row.id)} onChange={() => toggle(row.id)} />
                    {/* The board's permanent shot id, not the positional
                        compiled id — step 7 diffs say "regenerate S08" and
                        this list must speak the same language. */}
                    <span className="id">{shotEvents[row.id]?.pid || row.id}</span>
                  </label>
                  <b>{row.title}</b>
                  <span className="vg-meta">{row.duration} · {row.aspect} · {row.resolution} ·{' '}
                    <span className="vg-select-wrap" style={{ display: 'inline-block' }} onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        className="vp-menu-btn vg-select-btn"
                        title="Model for THIS clip — overrides the session default"
                        onClick={() => setRowModelMenu(rowModelMenu === row.id ? null : row.id)}
                      >
                        {modelLabel(row.type === 'video' ? videoModels : imageModels, row.mediaModel)} ▾
                      </button>
                      {rowModelMenu === row.id ? (
                        <>
                          <span className="vp-menu-backdrop" onClick={() => setRowModelMenu(null)} />
                          <span className="vp-menu">
                            <span className="vp-menu-h">{row.type === 'video' ? 'VIDEO MODEL' : 'IMAGE MODEL'}</span>
                            {(row.type === 'video' ? videoModels : imageModels).map((m) => (
                              <button
                                type="button"
                                key={m.id}
                                className={row.mediaModel === m.id ? 'on' : ''}
                                onClick={() => { setRowModelMenu(null); void setRowModel(row.id, row.type === 'video' ? 'video' : 'image', m.id) }}
                              >
                                <span>{m.label}</span>
                                <small>{m.id === (row.type === 'video' ? defaultVideoModel : defaultImageModel) ? 'default' : m.note}</small>
                              </button>
                            ))}
                          </span>
                        </>
                      ) : null}
                    </span>
                  </span>
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
                  <span
                    className={`status-pill ${outdated ? '' : row.status === 'image_ready' || row.status === 'video_ready' ? 'done' : row.status === 'generating' || promptBusyIds.has(row.id) ? 'work' : ''}`}
                    title={outdated ? 'Nothing generated for the current prompt yet — the earlier take (made from an older prompt) is under Previous versions.' : undefined}
                  >
                    {promptBusyIds.has(row.id) ? 'prompt rewrite' : outdated ? 'not run' : row.status.replace('_', ' ')}
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
                        <span>{row.status === 'generating'
                          ? <><span className="spin" /> generating {row.type === 'video' ? 'video' : 'image'}…</>
                          : outdated
                            ? 'prompt changed — nothing generated for this prompt yet'
                            : row.type === 'video' ? 'video planned' : 'image preview'}</span>
                      )}
                    </div>
                  </div>
                  <div className="vg-prompt">
                    <div className="vg-prompt-editor">
                      <textarea
                        value={row.draftText}
                        onChange={(e) => setDrafts((prev) => ({ ...prev, [row.id]: e.target.value }))}
                        onBlur={() => persistDraft(row.id)}
                        spellCheck={false}
                      />
                      <div className="vg-row-actions" style={{ justifyContent: 'space-between', margin: '4px 0 10px' }}>
                        <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
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
                        {row.type === 'video' ? (
                          <label className="vp-undo" title="The video OPENS on this exact image (kie first-frame mode)">
                            Upload first frame
                            <input type="file" accept="image/*" onChange={(event) => uploadReferenceAsset(row.id, event, 'first_frame')} />
                          </label>
                        ) : null}
                        </span>
                        <span style={{ display: 'flex', gap: 10, alignItems: 'center', marginLeft: 'auto' }}>
                        {row.status === 'generating' ? (
                          <span className="vg-row-run">
                            Generating {batchStatus?.media_type === 'video' ? 'video' : 'image'}...
                          </span>
                        ) : promptBusyIds.has(row.id) ? (
                          <span className="vg-row-run" title="The AI rewrite runs in the background (a minute or two) — the new prompt replaces this box when it lands.">
                            <span className="spin" /> AI rewriting this prompt…
                          </span>
                        ) : null}
                        <span
                          style={{ fontSize: 10.5, fontFamily: 'var(--mono)', color: row.draftText.length > videoModelMaxChars(row.mediaModel) || row.draftText.trim().length < 3 ? 'var(--red, #e5534b)' : 'var(--ink-3)' }}
                          title="Prompt length vs this row's model limit (kie docs)"
                        >
                          {row.draftText.length.toLocaleString()} / {videoModelMaxChars(row.mediaModel).toLocaleString()}
                        </span>
                        <button
                          type="button"
                          className="vp-undo"
                          disabled={rowAiBusy === row.id || promptBusyIds.has(row.id)}
                          title="Opens a note — tell the AI how this prompt should change (uses model credits)"
                          onClick={() => { setRowAiFor(rowAiFor === row.id ? null : row.id); setRowAiNote('') }}
                        >
                          {promptBusyIds.has(row.id) ? '⏳ AI rewriting…' : <>✎ Improve prompt with AI {rowAiFor === row.id ? '▴' : '▾'}</>}
                        </button>
                        </span>
                      </div>
                      {rowAiFor === row.id ? (
                        <div className="vg-regen-note-panel">
                          <textarea
                            value={rowAiNote}
                            onChange={(e) => setRowAiNote(e.target.value)}
                            placeholder="Tell the AI what to change — e.g. focus on one shoe, slower motion, tighter framing..."
                            rows={3}
                          />
                          {(row.item.improve_notes ?? []).length ? (
                            <details className="sl-json" style={{ margin: '6px 0 0', borderTop: 'none', paddingTop: 0 }}>
                              <summary>Past notes · {(row.item.improve_notes ?? []).length}</summary>
                              {[...(row.item.improve_notes ?? [])].reverse().map((n, i) => (
                                <button
                                  type="button"
                                  key={`${row.id}-in-${i}`}
                                  className="vp-undo"
                                  style={{ display: 'block', width: '100%', textAlign: 'left', marginTop: 6, whiteSpace: 'normal', textTransform: 'none', letterSpacing: 0 }}
                                  title={`Reuse this note${n.at ? ` (from ${String(n.at).slice(5, 16).replace('T', ' ')})` : ''}`}
                                  onClick={() => setRowAiNote(String(n.note || ''))}
                                >
                                  {n.note}
                                </button>
                              ))}
                            </details>
                          ) : null}
                          {/* Step-5 pattern: while the improve panel is open,
                              improving IS the action — one vp-save, bottom right. */}
                          <div className="vp-edit-actions" style={{ justifyContent: 'flex-end', marginTop: 6 }}>
                            <button type="button" className="vp-save" disabled={rowAiBusy === row.id || !rowAiNote.trim()} onClick={() => void rowAiUpdate(row.id)}>
                              {rowAiBusy === row.id ? (<><span className="spin" /> Improving…</>) : '✦ Improve prompt'}
                            </button>
                          </div>
                        </div>
                      ) : null}
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
                            <span className="vp-map-cardacts" onClick={(e) => e.stopPropagation()}>
                              <span
                                title={`Edit ${name} — a new take of this object, or a variant (one deliberate change). Lands in the World Kit, shows on every step.`}
                                onClick={(e) => {
                                  setRefEditPos({ x: Math.max(16, Math.min(window.innerWidth - 700, e.clientX - 340)), y: Math.max(70, e.clientY - 40) })
                                  setRefEdit(refEdit?.name === name && refEdit.rowId === row.id ? null : { rowId: row.id, name, mode: 'update' })
                                }}
                              >✎</span>
                              <span
                                title={`Detach ${name} from this shot — everywhere (plan, shot list, prompts)`}
                                onClick={() => { void editShotRef(row.id, name, { detach: true }).catch((err) => setBuildError(err instanceof Error ? err.message : 'detach failed')) }}
                              >✕</span>
                            </span>
                          </span>
                        ))}
                        {firstFrameEntries.map((entry) => renderAssetThumb(entry, 'first_frame'))}
                        {referenceEntries.map((entry) => renderAssetThumb(entry, 'reference'))}
                        {textAssoc.map(({ name, index }) => {
                          const openKey = `${row.id}:${name}`
                          const isOpen = openTxtCards.has(openKey)
                          return (
                            <span
                              key={`t-${index}`}
                              className="vp-map-txtatt"
                              style={{ cursor: 'pointer', ...(isOpen ? { maxWidth: 420 } : {}) }}
                              title={isOpen ? 'Click to collapse' : 'Click to show the full description'}
                              onClick={() => setOpenTxtCards((cur) => {
                                const next = new Set(cur)
                                if (next.has(openKey)) next.delete(openKey)
                                else next.add(openKey)
                                return next
                              })}
                            >
                              <span className="vp-map-chip">{kitOf(name)?.kind || 'ref'}</span>
                              <span className="vp-map-attname">{name}</span>
                              {kitOf(name)?.notes ? (
                                <span className="txt-notes" style={isOpen ? { display: 'block', WebkitLineClamp: 'unset', overflow: 'visible' } : undefined}>
                                  {kitOf(name)!.notes}
                                </span>
                              ) : null}
                            </span>
                          )
                        })}
                        {[...audioAssoc.map((n) => ({ key: `${row.id}:a:${n}`, chip: `♪ ${kitOf(n)?.kind || 'audio'}`, label: `${n} · this clip`, notes: kitOf(n)?.notes })),
                          ...audioInherited.map((k) => ({ key: `${row.id}:i:${k.name}`, chip: `♪ ${k.kind}`, label: `${k.name} · via ${k.linked_to}`, notes: k.notes }))].map((c) => {
                          const isOpen = openTxtCards.has(c.key)
                          return (
                            <span
                              key={c.key}
                              className="vp-map-txtatt"
                              style={{ cursor: 'pointer', ...(isOpen ? { maxWidth: 420 } : {}) }}
                              title={isOpen ? 'Click to collapse' : 'Click to show the full content'}
                              onClick={() => setOpenTxtCards((cur) => { const next = new Set(cur); if (next.has(c.key)) next.delete(c.key); else next.add(c.key); return next })}
                            >
                              <span className="vp-map-chip">{c.chip}</span>
                              <span className="vp-map-attname">{c.label}</span>
                              {c.notes ? <span className="txt-notes" style={isOpen ? { display: 'block', WebkitLineClamp: 'unset', overflow: 'visible' } : undefined}>{c.notes}</span> : null}
                            </span>
                          )
                        })}
                        {!kitImageEntries.length && !referenceEntries.length && !firstFrameEntries.length && !textAssoc.length ? <span>no reference images attached</span> : null}
                      </span>
                    </div>
                    {textAssoc.length || audioAssoc.length || audioInherited.length || pendingRefs.length ? (
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8, minWidth: 0 }}>


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
                    {/* THE row action, bottom right — above the collapsed
                        history sections, same spot as every other module. */}
                    <div className="vp-edit-actions" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
                      <label
                        className="vp-undo"
                        title="Use your own video or image as this shot's take. The current take moves to previous versions — nothing is ever deleted."
                      >
                        ⬆ Upload my own
                        <input
                          type="file"
                          accept="video/mp4,video/webm,video/quicktime,image/png,image/jpeg,image/webp"
                          disabled={attachBusy}
                          onChange={(event) => void uploadOwnTake(row, event)}
                        />
                      </label>
                      <button
                        type="button"
                        className="vp-undo"
                        disabled={attachBusy}
                        title="Attach a take from the asset library — takes from deleted shots and copies of other shots' takes."
                        onClick={() => { setAttachPickFor(row.id); void loadLibrary() }}
                      >
                        ⧉ Attach from library…
                      </button>
                      {row.type === 'image' ? (
                        <button
                          type="button"
                          className="vp-undo vg-generate-main"
                          disabled={genQueue.some((e) => e.id === row.id) || row.status === 'generating'}
                          title={activeProcess ? 'A batch is running — this row queues and starts the moment it finishes' : undefined}
                          onClick={() => queueRowGeneration(row.id, 'image')}
                        >
                          {genQueue.some((e) => e.id === row.id) ? '⏳ Queued' : row.status === 'generating' ? '⏳ Generating…' : row.status === 'image_ready' && !outdated ? '▧ Regenerate image' : '▧ Generate image'}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="vp-undo vg-generate-main"
                          disabled={genQueue.some((e) => e.id === row.id) || row.status === 'generating' || videoTooLong(row)}
                          title={videoTooLong(row) ? videoDisabledTitle(row) : activeProcess ? 'A batch is running — this row queues and starts the moment it finishes' : `Use ${modelLabel(videoModels, row.mediaModel)} for this row`}
                          onClick={() => queueRowGeneration(row.id, 'video')}
                        >
                          {genQueue.some((e) => e.id === row.id) ? '⏳ Queued' : row.status === 'generating' ? '⏳ Generating…' : row.status === 'video_ready' && !outdated ? '▶ Regenerate video' : '▶ Generate video'}
                        </button>
                      )}
                    </div>
                    {(() => {
                      // THE RECORD, not the working text: sidecar first (has
                      // the timestamp), else the manifest's as-sent prompt —
                      // the textarea above always keeps the NEWEST prompt.
                      const sent = usedPrompts[row.id]
                        || (() => {
                          const asSent = String(mediaManifestItem(sceneManifest, row.mid, row.type === 'video' ? 'video' : 'image')?.prompt || '').trim()
                          return asSent ? { prompt: asSent } : null
                        })()
                      if (!sent) return null
                      return (
                        <details className="sl-json" style={{ margin: '10px 0 0', borderTop: 'none', paddingTop: 0 }}>
                          <summary>Prompt used for this take{sent.generated_at ? ` · ${sent.generated_at.slice(5, 16).replace('T', ' ')}` : ''}</summary>
                          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.55, color: 'var(--ink-2)', margin: '8px 0 0', fontFamily: 'var(--mono)' }}>{sent.prompt}</pre>
                        </details>
                      )
                    })()}
                    {(row.item.prompt_history ?? []).length ? (
                      <details className="sl-json" style={{ margin: '10px 0 0', borderTop: 'none', paddingTop: 0 }}>
                        <summary>Past prompts · {(row.item.prompt_history ?? []).length}</summary>
                        {[...(row.item.prompt_history ?? [])].reverse().map((h, i) => (
                          <div key={`${row.id}-ph-${i}`} style={{ marginTop: 8 }}>
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11, color: 'var(--ink-2)', textTransform: 'uppercase', letterSpacing: '.04em' }}>
                              <span>{h.by === 'you' ? 'before your edit' : h.by === 'ai-rewrite' ? 'before AI rewrite' : 'before recompile'}{h.at ? ` · ${String(h.at).slice(5, 16).replace('T', ' ')}` : ''}</span>
                              <button
                                type="button"
                                className="vp-undo"
                                title="Put this past prompt back in the box — nothing is sent until you generate"
                                onClick={() => setDrafts((prev) => ({ ...prev, [row.id]: String(h.prompt || '') }))}
                              >↺ use</button>
                            </div>
                            <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.55, color: 'var(--ink-2)', margin: '4px 0 0', fontFamily: 'var(--mono)' }}>{h.prompt}</pre>
                          </div>
                        ))}
                      </details>
                    ) : null}
                    {(() => {
                      // An OUTDATED active take (prompt moved on) joins the
                      // list too — first, unstamped, no restore (it is still
                      // the file in the slot until a regeneration archives it).
                      const demoted = outdated
                        ? (() => {
                          const rel = manifestContentPath(mediaManifestItem(sceneManifest, row.mid, row.type === 'video' ? 'video' : 'image'))
                            .replace(new RegExp(`^sessions/${activeSession()}/`), '')
                          return rel ? [{ path: rel, stamp: '', kind: (row.type === 'video' ? 'video' : 'image') as 'video' | 'image' }] : []
                        })()
                        : []
                      const versions = [...demoted, ...(mediaHistory[row.mid] ?? [])]
                      return versions.length ? (
                      <details className="sl-json" style={{ margin: '10px 0 0', borderTop: 'none', paddingTop: 0 }}>
                        <summary>Previous versions · {versions.length}</summary>
                        <div className="vg-refs" style={{ marginTop: 8 }}>
                          {versions.map((v) => {
                            const src = contentUrl(v.path)
                            const when = v.stamp
                              ? `${v.stamp.slice(4, 6)}/${v.stamp.slice(6, 8)} ${v.stamp.slice(9, 11)}:${v.stamp.slice(11, 13)}`
                              : 'made from an older prompt'
                            return (
                              <span key={v.path} className="vg-ref-thumb">
                                {v.kind === 'video' ? (
                                  <video
                                    src={src}
                                    muted
                                    playsInline
                                    preload="auto"
                                    style={{ cursor: 'zoom-in' }}
                                    title={`${v.stamp ? `Archived ${when}` : 'Current file — made from an older prompt'} — hover to play, click to view full size`}
                                    onLoadedMetadata={(e) => {
                                      const el = e.currentTarget
                                      const r = el.videoWidth / el.videoHeight || 1
                                      const h = Math.min(190, Math.sqrt(20000 / r))
                                      el.style.height = `${Math.round(h)}px`
                                      el.style.width = `${Math.round(h * r)}px`
                                      el.currentTime = 0.01
                                    }}
                                    onMouseEnter={(e) => { void e.currentTarget.play().catch(() => undefined) }}
                                    onMouseLeave={(e) => { e.currentTarget.pause(); e.currentTarget.currentTime = 0.01 }}
                                    onClick={() => setMediaLightbox({ kind: 'video', src })}
                                  />
                                ) : (
                                  <img
                                    src={src}
                                    alt=""
                                    style={{ cursor: 'zoom-in' }}
                                    title={`${v.stamp ? `Archived ${when}` : 'Current file — made from an older prompt'} — click to view full size`}
                                    onLoad={equalAreaThumb}
                                    onClick={() => setMediaLightbox({ kind: 'image', src })}
                                  />
                                )}
                                {v.stamp ? (
                                  <span className="vp-map-cardacts">
                                    <span
                                      title={`Restore this version from ${when} (the current one is archived, not lost)`}
                                      onClick={() => void restoreVersion(row.id, v.path)}
                                    >↺</span>
                                  </span>
                                ) : (
                                  <small style={{ display: 'block', marginTop: 4, color: 'var(--ink-2)' }}>made from an older prompt</small>
                                )}
                              </span>
                            )
                          })}
                        </div>
                      </details>
                      ) : null
                    })()}
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

        {attachPickFor ? (() => {
          const row = rows.find((r) => r.id === attachPickFor)
          if (!row) return null
          // The row's own takes live under "Previous versions" already — the
          // library popup is about EVERYTHING ELSE: orphaned takes first
          // (that is what the library is for), then other shots' takes.
          const others = (library ?? []).filter((g) => g.id !== row.mid && g.takes.length)
          const orphaned = others.filter((g) => !g.on_board)
          const owned = others.filter((g) => g.on_board)
          const takeTile = (group: LibraryGroup, take: LibraryTake) => {
            const src = contentUrl(take.path)
            const when = take.stamp ? `${take.stamp.slice(4, 6)}/${take.stamp.slice(6, 8)} ${take.stamp.slice(9, 11)}:${take.stamp.slice(11, 13)}` : ''
            const label = [
              group.on_board ? `shot ${group.id}` : `deleted shot ${group.id}`,
              take.active ? 'current take' : when,
              take.origin !== 'generated' ? take.origin : take.model || '',
            ].filter(Boolean).join(' · ')
            return (
              <span key={take.path} className="vg-ref-thumb" style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start' }} title={`${label} — click to attach a copy to ${row.mid}`}>
                {take.kind === 'video' ? (
                  <video
                    src={src}
                    muted
                    playsInline
                    preload="auto"
                    style={{ cursor: attachBusy ? 'wait' : 'copy' }}
                    onLoadedMetadata={(e) => {
                      const el = e.currentTarget
                      const r = el.videoWidth / el.videoHeight || 1
                      const h = Math.min(190, Math.sqrt(20000 / r))
                      el.style.height = `${Math.round(h)}px`
                      el.style.width = `${Math.round(h * r)}px`
                      el.currentTime = 0.01
                    }}
                    onMouseEnter={(e) => { void e.currentTarget.play().catch(() => undefined) }}
                    onMouseLeave={(e) => { e.currentTarget.pause(); e.currentTarget.currentTime = 0.01 }}
                    onClick={() => { if (!attachBusy) void attachTake(row, take) }}
                  />
                ) : (
                  <img
                    src={src}
                    alt=""
                    style={{ cursor: attachBusy ? 'wait' : 'copy' }}
                    onLoad={equalAreaThumb}
                    onClick={() => { if (!attachBusy) void attachTake(row, take) }}
                  />
                )}
                <small style={{ display: 'block', marginTop: 4, color: 'var(--ink-2)' }}>{label}</small>
              </span>
            )
          }
          return (
            <div className="modal-scrim" onClick={() => setAttachPickFor(null)}>
              <div className="confirm-modal vg-ref-modal" onClick={(event) => event.stopPropagation()} style={{ width: 'min(880px, 94vw)', maxHeight: '86vh', overflowY: 'auto' }}>
                <div className="vg-ref-modal-head">
                  <b>Asset library — attach a take to {row.mid}</b>
                  <button type="button" className="vp-undo" onClick={() => setAttachPickFor(null)}>Close</button>
                </div>
                {library === null ? (
                  <p style={{ color: 'var(--ink-2)' }}>Loading the library…</p>
                ) : !orphaned.length && !owned.length ? (
                  <p style={{ color: 'var(--ink-2)' }}>
                    Nothing to attach yet. Takes land here when a shot is deleted (its media is
                    kept, never thrown away) and every shot's takes can be copied to another shot.
                  </p>
                ) : (
                  <>
                    {orphaned.length ? (
                      <>
                        <p className="vp-menu-h" style={{ margin: '12px 0 4px' }}>TAKES FROM DELETED SHOTS</p>
                        <div className="vg-refs">{orphaned.flatMap((g) => g.takes.map((t) => takeTile(g, t)))}</div>
                      </>
                    ) : null}
                    {owned.length ? (
                      <>
                        <p className="vp-menu-h" style={{ margin: '16px 0 4px' }}>OTHER SHOTS' TAKES — attaching makes a copy; the other shot keeps its own</p>
                        <div className="vg-refs">{owned.flatMap((g) => g.takes.map((t) => takeTile(g, t)))}</div>
                      </>
                    ) : null}
                  </>
                )}
              </div>
            </div>
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
              const previewMedia = takeOutdated(row) ? null : rowPreviewMedia(row)
              // True proportion: the tile adopts the row's own aspect ratio.
              const tileAspect = { aspectRatio: (row.aspect || '16:9').replace(':', ' / ') }
              return (
                <button type="button" className={`vg-tile ${selected.has(row.id) ? 'on' : ''}`} key={row.id} onClick={() => { toggle(row.id); setView('prompts') }}>
                  {previewMedia?.kind === 'video' ? (
                    <video
                      src={previewMedia.src}
                      style={tileAspect}
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
                    <img src={previewMedia.src} alt="" style={tileAspect} />
                  ) : (
                    <span style={tileAspect}>{row.id}</span>
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
