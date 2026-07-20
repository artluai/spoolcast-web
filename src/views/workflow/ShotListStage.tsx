import { useEffect, useMemo, useRef, useState } from 'react'
import { FeedbackButton } from './FeedbackButton'
import { RulesPanel } from './RulesPanel'
import { useWorkflowStore, type StageProcess } from '../../store/workflow'
import { TimelineScroller } from './TimelineScroller'
import { activeSession, actionUrl, apiUrl, contentUrl, downloadUrl, fileUrl, jobsUrl, statusUrl, templatesUrl } from '../../lib/api'
import { ModelPicker } from './ModelPicker'
import { DEFAULT_MODEL_ID, draftReasoning } from '../../lib/draft-models'
import { mergeKitWithDraft, useWorldKitDraft } from '../../lib/kit-draft'
import { useWorkflowStore as useWfStore } from '../../store/workflow'

// COMPILE SHOT LIST (step 08): the machine-precise lens over the pacing plan.
// The engine compiles shot-list/shot-list.json (code-law structure, AI polish,
// validated + xlsx in the same operation). This screen inspects the contract:
// audio chunks, base_layer visual events, and reaction overlays.

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
  // Compiler-set on SILENT chunks (Σ image holds) — no audio will supply it.
  duration_s?: number
  reaction_candidate?: boolean
  reaction_note?: string
  [k: string]: unknown
}
type BaseLayerEvent = {
  id: string
  role?: string
  image_source?: string
  chunk_id?: string
  pacing_image_id?: string
  image_path?: string
  visual_direction?: string
  references?: string[]
  start_s?: number
  end_s?: number
  duration_s?: number
  first_word_idx?: number
  last_word_idx?: number
  reason?: string
  visual_role?: string
  [k: string]: unknown
}
type Reaction = {
  id?: string
  source?: string
  start_chunk_id?: string
  chunk_id?: string
  base_layer_id?: string
  pacing_image_id?: string
  timing_start_s?: number
  duration_s?: number
  trigger?: string
  what?: string
  placement?: string
  [k: string]: unknown
}
type ShotList = {
  session_id?: string
  canvas?: { aspect_ratio?: string; fps?: number }
  notes?: string
  chunks: Chunk[]
  base_layer?: BaseLayerEvent[]
  reactions?: Reaction[]
  [k: string]: unknown
}

type Audit = { passed?: boolean; findings?: string; stderr?: string } | null
type DraftJob = {
  id: string
  status: 'queued' | 'running' | 'done' | 'failed'
  error?: string | null
  message?: string | null
  result?: {
    ok?: boolean
    error?: string
    message?: string
    data?: { audits?: { shot_list?: Audit } }
  } | null
}
type XlsxPreviewCell = { colIndex: number; value: string; colSpan?: number; rowSpan?: number }
type XlsxPreviewSheet = {
  name: string
  columns: { index: number; label: string; width: number }[]
  rows: { number: number; cells: XlsxPreviewCell[] }[]
  truncated?: boolean
}
type XlsxPreview = { sheets: XlsxPreviewSheet[] }

const WORDS_PER_SEC = 2.5
const FILE_PATH = 'shot-list/shot-list.json'

const estSec = (c: Chunk) => {
  const words = (c.beats ?? []).reduce((n, b) => n + (b.narration ?? '').split(/\s+/).filter(Boolean).length, 0)
  // SILENT CHUNK (no spoken words): the compiler carries its planned
  // duration (Σ image holds) — words ÷ rate would wrongly say ~0.
  if (words === 0) return Math.max(1, Number(c.duration_s ?? 0) || 3)
  return Math.max(1, words / WORDS_PER_SEC)
}
const fmtTime = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`
const pretty = (value: unknown) => JSON.stringify(value, null, 2)
const eventStart = (event: BaseLayerEvent) => Number(event.start_s ?? 0)
const eventEnd = (event: BaseLayerEvent) => {
  const start = eventStart(event)
  const explicitEnd = Number(event.end_s ?? 0)
  if (explicitEnd > start) return explicitEnd
  return start + Math.max(0.25, Number(event.duration_s ?? 1))
}
const reactionOffset = (reaction: Reaction) => Number(reaction.timing_start_s ?? 0)
const chunkNarration = (chunk: Chunk) => (chunk.beats ?? []).map((beat) => beat.narration).filter(Boolean).join(' ')
// The words THIS clip performs: sliced by the compiler's word indices when
// present, else the whole chunk (single-clip chunks).
const clipSpoken = (event: BaseLayerEvent, chunk?: Chunk) => {
  const all = chunk ? chunkNarration(chunk) : ''
  const words = all.split(/\s+/).filter(Boolean)
  const a = Number(event.first_word_idx)
  const b = Number(event.last_word_idx)
  if (Number.isFinite(a) && Number.isFinite(b) && b >= a && words.length) return words.slice(a, b + 1).join(' ')
  return all
}
const shortPath = (path?: string) => (path || '').split('/').slice(-2).join('/') || '—'

export function ShotListStage({ stageId }: { stageId: string }) {
  const draft = useWorkflowStore((s) => s.stageDrafts[stageId] ?? '')
  const setStageDraft = useWorkflowStore((s) => s.setStageDraft)
  const seedStageDraft = useWorkflowStore((s) => s.seedStageDraft)
  const stageProcess = useWorkflowStore((s) => s.stageProcesses[stageId] ?? null)
  const setStageProcess = useWorkflowStore((s) => s.setStageProcess)
  const seededRef = useRef(false)
  const pollingJobRef = useRef<string | null>(null)
  const mountedRef = useRef(true)
  const [building, setBuilding] = useState(false)
  const [model, setModel] = useState(DEFAULT_MODEL_ID)
  const [buildJob, setBuildJob] = useState<DraftJob | null>(null)
  const [checking, setChecking] = useState(false)
  const [audit, setAudit] = useState<Audit>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState('')
  const [zoom, setZoom] = useState(1)
  const [edited, setEdited] = useState(false)
  const [xlsxExists, setXlsxExists] = useState<boolean | null>(null)
  const [xlsxExporting, setXlsxExporting] = useState(false)
  const [xlsxLoading, setXlsxLoading] = useState(false)
  const [xlsxMessage, setXlsxMessage] = useState('')
  const [xlsxPreview, setXlsxPreview] = useState<XlsxPreview | null>(null)
  // TWO SHAPES, one signal. Audio-first: narration owns the clock, visuals
  // slot under it — the chunk-centric lens below. Video-first: each clip
  // generates picture AND sound, so the honest unit is the CLIP.
  const [videoFirst, setVideoFirst] = useState(false)
  // The exact assembled prompt per clip (working/generation-prompts.json,
  // built+approved at the generation step). READ-ONLY here: building it from
  // this step would reset its approval under a running batch.
  const [assembled, setAssembled] = useState<Record<string, string>>({})
  // Per-clip tab: the PROMPT is the default lens (read-only here — editing
  // lives at the generation step); the description is the second tab.
  const [clipTab, setClipTab] = useState<Record<string, 'prompt' | 'description'>>({})
  const [openCards, setOpenCards] = useState<Set<string>>(new Set())
  const toggleCard = (key: string) => setOpenCards((cur) => {
    const next = new Set(cur)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })
  // The World Kit, for CONFIRMING each clip's references visually: image refs
  // as thumbnails, prompt-only objects as chips, audio as ♪ chips — including
  // audio riding in via an object link (variants inherit).
  type KitLite = { name: string; kind: string; notes: string; image_path: string; linked_to?: string; variant_of?: string }
  const [rawKit, setKit] = useState<KitLite[]>([])
  const wkDraft = useWorldKitDraft()
  const kit = useMemo(() => mergeKitWithDraft(rawKit, wkDraft), [rawKit, wkDraft])
  // THE PLAN OWNS THE REFS; the compiled shot list snapshots them. Board
  // edits (attach audio, remap) land in the plan draft/file first — show the
  // freshest refs as PENDING until synced, and sync for free (no re-compile).
  const pacingDraft = useWfStore((st) => st.stageDrafts['visual_pacing'] ?? '')
  const [planFileMd, setPlanFileMd] = useState('')
  const [syncing, setSyncing] = useState(false)
  const planRefsById = useMemo(() => {
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
  const syncRefsFromPlan = async () => {
    setSyncing(true)
    try {
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
      const r = await fetch(actionUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: activeSession(), tenant: 'local', action: 'sync_shot_refs' }),
      })
      const out = await r.json().catch(() => null)
      if (!r.ok || out?.ok === false) throw new Error(out?.error || 'sync failed')
      const fresh = await fetch(fileUrl(FILE_PATH)).then((x) => (x.ok ? x.json() : null))
      if (typeof fresh?.data?.content === 'string') setStageDraft(stageId, fresh.data.content)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not sync refs from the plan.')
    } finally {
      setSyncing(false)
    }
  }
  useEffect(() => {
    let live = true
    Promise.all([
      fetch(fileUrl('session.json')).then((r) => (r.ok ? r.json() : null)),
      fetch(templatesUrl()).then((r) => (r.ok ? r.json() : null)),
      fetch(fileUrl('working/generation-prompts.json')).then((r) => (r.ok ? r.json() : null)),
      fetch(apiUrl('source-images', { session: activeSession(), include_refs: 1 })).then((r) => (r.ok ? r.json() : null)),
      fetch(fileUrl('working/visual-pacing-plan.md')).then((r) => (r.ok ? r.json() : null)),
    ]).then(([sess, reg, prompts, kitOut, planOut]) => {
      if (live && Array.isArray(kitOut?.data?.kit)) setKit(kitOut.data.kit as KitLite[])
      if (live && typeof planOut?.data?.content === 'string') setPlanFileMd(planOut.data.content)
      if (!live) return
      try {
        const cfg = JSON.parse(sess?.data?.content ?? 'null')
        const hit = reg?.data?.templates?.find((t: { id?: string }) => t.id === String(cfg?.template || ''))
        if (hit?.format === 'video-first') setVideoFirst(true)
      } catch { /* unknown template stays audio-first-shaped */ }
      try {
        const doc = JSON.parse(prompts?.data?.content ?? 'null')
        const map: Record<string, string> = {}
        for (const it of doc?.items ?? []) {
          const id = String(it?.id ?? '')
          const text = String(it?.prompt || it?.kie_request_preview?.input?.prompt || '')
          if (id && text) map[id] = text
        }
        setAssembled(map)
      } catch { /* no prompts doc yet — the clip cards say so */ }
    })
    return () => { live = false }
  }, [])
  const [xlsxSheetIndex, setXlsxSheetIndex] = useState(0)
  const autoExportRef = useRef(false)
  // Engine truth: is this stage actually buildable yet? A paid button must
  // never look ready on a blocked step.
  const [stageCurrent, setStageCurrent] = useState<boolean | null>(null)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  useEffect(() => {
    fetch(statusUrl())
      .then((r) => (r.ok ? r.json() : null))
      .then((out) => {
        const cur = out?.data?.current_contract_stage?.id
        if (typeof cur === 'string') setStageCurrent(cur === 'shot_list_json')
      })
      .catch(() => {})
  }, [])
  useEffect(() => {
    if (!stageProcess?.jobId || !['queued', 'running'].includes(stageProcess.status)) return
    if (pollingJobRef.current === stageProcess.jobId) return
    setBuilding(true)
    setBuildJob({ id: stageProcess.jobId, status: stageProcess.status, error: stageProcess.error, message: stageProcess.message })
    void pollBuildJob(stageProcess.jobId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageProcess?.jobId, stageProcess?.status])

  // Prefill from the engine's real file — never clobber an edit in progress.
  useEffect(() => {
    if (seededRef.current) return
    seededRef.current = true
    const store = useWorkflowStore.getState()
    if ((store.stageDrafts[stageId] ?? '').length > 0) return
    fetch(fileUrl(FILE_PATH))
      .then((r) => (r.ok ? r.json() : null))
      .then((out) => {
        if (out?.ok && out.data?.exists && typeof out.data.content === 'string') {
          const cur = useWorkflowStore.getState()
          if ((cur.stageDrafts[stageId] ?? '').length === 0) seedStageDraft(stageId, out.data.content)
        }
      })
      .catch(() => {})
  }, [stageId, seedStageDraft])

  const list: ShotList | null = (() => {
    try {
      return draft.trim() ? (JSON.parse(draft) as ShotList) : null
    } catch {
      return null
    }
  })()
  const chunks = list?.chunks ?? []
  const chunkById = new Map(chunks.map((chunk) => [chunk.id, chunk]))
  const baseLayer = list?.base_layer ?? []
  const reactions = list?.reactions ?? []
  const visualEvents: BaseLayerEvent[] = baseLayer.length
    ? baseLayer
    : chunks.map((chunk, index) => ({
      id: chunk.id,
      role: 'base_visual',
      chunk_id: chunk.id,
      image_path: String(chunk.image_path || ''),
      visual_direction: chunk.visual_direction,
      start_s: chunks.slice(0, index).reduce((n, prior) => n + estSec(prior), 0),
      duration_s: estSec(chunk),
    }))
  const totalSec = Math.max(
    1,
    ...visualEvents.map(eventEnd),
    chunks.reduce((n, c) => n + estSec(c), 0),
  )
  const unresolved = chunks.filter((c) => c.reaction_candidate === true)
  const activeProcess = !!stageProcess && ['queued', 'running'].includes(stageProcess.status)
  const processLabel = stageProcess?.label || (checking ? 'Checking shot list…' : 'AI is compiling the shot list…')
  const isBusy = building || checking || activeProcess

  // SYNC IS AUTOMATIC here too — one attempt per distinct upstream diff.
  const autoSyncSigRef = useRef('')
  useEffect(() => {
    if (!videoFirst || syncing || isBusy) return
    const parts: string[] = []
    for (const e of list?.base_layer ?? []) {
      const planned = planRefsById[String(e.pacing_image_id ?? '')]
      if (!planned) continue
      const cur = (e.references ?? []).map(String)
      const missing = planned.filter((n) => !cur.includes(n) && kit.some((k) => k.name === n))
      if (missing.length) parts.push(`${e.id}:${missing.join(',')}`)
    }
    const sig = parts.join(';')
    if (!sig || autoSyncSigRef.current === sig) return
    autoSyncSigRef.current = sig
    void syncRefsFromPlan()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoFirst, syncing, isBusy, list, planRefsById])

  const loadFreshShotList = async () => {
    const fr = await fetch(fileUrl(FILE_PATH))
    const fileOut = await fr.json().catch(() => null)
    if (fileOut?.ok && fileOut.data?.exists) {
      seedStageDraft(stageId, fileOut.data.content) // fresh from engine = clean state
      setEdited(false)
      return true
    }
    return false
  }

  const downloadXlsx = () => {
    const link = document.createElement('a')
    link.href = downloadUrl('shot-list/shot-list.xlsx')
    link.download = 'shot-list.xlsx'
    document.body.appendChild(link)
    link.click()
    link.remove()
  }

  const loadXlsxPreview = async () => {
    setXlsxLoading(true)
    try {
      const res = await fetch(apiUrl('xlsx-preview', { session: activeSession(), path: 'shot-list/shot-list.xlsx' }))
      const out = await res.json().catch(() => null)
      if (!res.ok || out?.ok === false) {
        setXlsxPreview(null)
        setXlsxMessage(out?.message || out?.error || 'Could not read the spreadsheet preview.')
        return false
      }
      if (!out?.data?.exists) {
        setXlsxPreview(null)
        setXlsxMessage('Spreadsheet export is missing.')
        return false
      }
      const workbook = out.data.workbook as XlsxPreview
      setXlsxPreview(workbook)
      setXlsxSheetIndex((cur) => Math.min(cur, Math.max(0, (workbook.sheets?.length ?? 1) - 1)))
      if (!xlsxMessage) setXlsxMessage('Preview is reading shot-list.xlsx directly.')
      return true
    } catch {
      setXlsxPreview(null)
      setXlsxMessage('Could not reach the engine for the spreadsheet preview.')
      return false
    } finally {
      setXlsxLoading(false)
    }
  }

  const loadXlsxStatus = async () => {
    const res = await fetch(statusUrl())
    const out = await res.json().catch(() => null)
    const artifact = (out?.data?.artifacts || []).find(
      (item: { stage_id?: string; pattern?: string }) =>
        item.stage_id === 'shot_list_json' && item.pattern === 'shot-list/shot-list.xlsx',
    )
    const exists = Boolean(artifact?.exists)
    setXlsxExists(exists)
    if (exists) await loadXlsxPreview()
    else setXlsxPreview(null)
    return exists
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadXlsxStatus().catch(() => setXlsxExists(false))
    }, 0)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const updateProcess = (job: DraftJob, label = processLabel) => {
    const next: StageProcess = {
      stageId,
      jobId: job.id,
      status: job.status,
      label,
      error: job.error || job.result?.error || null,
      message: job.message || job.result?.message || null,
      updatedAt: new Date().toISOString(),
    }
    setStageProcess(stageId, next)
  }

  async function pollBuildJob(jobId: string) {
    pollingJobRef.current = jobId
    for (let i = 0; i < 450; i += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 2000))
      if (!mountedRef.current) {
        pollingJobRef.current = null
        return
      }
      const jr = await fetch(jobsUrl(jobId))
      const jout = await jr.json().catch(() => null)
      if (!jr.ok || jout?.ok === false) {
        setError(jout?.message || jout?.error || 'Could not read shot-list job status.')
        setStageProcess(stageId, {
          stageId,
          jobId,
          status: 'failed',
          label: processLabel,
          error: jout?.error || 'job_status_failed',
          message: jout?.message || 'Could not read shot-list job status.',
          updatedAt: new Date().toISOString(),
        })
        pollingJobRef.current = null
        return
      }
      const job = jout.data as DraftJob
      setBuildJob(job)
      updateProcess(job)
      if (job.status === 'done') {
        setAudit(job.result?.data?.audits?.shot_list ?? null)
        if (!(await loadFreshShotList())) setError('Shot list finished, but the output file was not found.')
        await loadXlsxStatus().catch(() => {})
        setStageProcess(stageId, null)
        pollingJobRef.current = null
        return
      }
      if (job.status === 'failed') {
        setError(job.result?.message || job.message || job.result?.error || job.error || 'Build failed.')
        updateProcess(job)
        pollingJobRef.current = null
        return
      }
    }
    setError('Shot-list job is still running. You can leave this page and check back later.')
    pollingJobRef.current = null
  }

  const build = async (feedback = '') => {
    setBuilding(true)
    setBuildJob(null)
    setError(null)
    setAudit(null)
    try {
      const res = await fetch(jobsUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: activeSession(), tenant: 'local', kind: 'draft_stage', stage_id: stageId,
          allow_cost: true, model,
          ...(draftReasoning(model) ? { reasoning: draftReasoning(model) } : {}),
          ...(feedback.trim() ? { feedback: feedback.trim() } : {}),
        }),
      })
      const out = await res.json().catch(() => null)
      if (!res.ok || out?.ok === false) {
        setError(out?.message || out?.error || 'Build failed.')
        return
      }
      const job = out.data as DraftJob
      setBuildJob(job)
      setStageProcess(stageId, {
        stageId,
        jobId: job.id,
        status: job.status,
        label: 'AI is compiling the shot list…',
        error: null,
        message: null,
        updatedAt: new Date().toISOString(),
      })
      await pollBuildJob(job.id)
    } catch {
      setError('Could not reach the engine.')
    } finally {
      setBuilding(false)
    }
  }

  const exportXlsx = async ({ silent = false }: { silent?: boolean } = {}) => {
    setXlsxExporting(true)
    if (!silent) {
      setError(null)
      setXlsxMessage('Exporting shot-list.xlsx…')
    }
    try {
      const res = await fetch(actionUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: activeSession(), tenant: 'local', action: 'export_xlsx' }),
      })
      const out = await res.json().catch(() => null)
      if (!res.ok || out?.ok === false) {
        const message = out?.message || out?.error || 'Could not export the XLSX file.'
        if (!silent) {
          setError(message)
          setXlsxMessage(message)
        }
        setXlsxExists(false)
        return false
      }
      await loadXlsxStatus()
      if (!silent) {
        downloadXlsx()
        setXlsxMessage('Exported and downloaded the latest shot-list.xlsx.')
      }
      return true
    } catch {
      if (!silent) {
        setError('Could not reach the engine.')
        setXlsxMessage('Could not reach the engine.')
      }
      setXlsxExists(false)
      return false
    } finally {
      setXlsxExporting(false)
    }
  }

  // FREE RE-CHECK after manual edits: persist the edited JSON (contract-
  // whitelisted output), then run the official gate-token validation.
  const recheck = async () => {
    setChecking(true)
    setError(null)
    try {
      if (edited && draft.trim()) {
        const so = await fetch(actionUrl(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session: activeSession(), tenant: 'local', action: 'set_stage_output',
            stage_id: stageId, path: FILE_PATH, content: draft,
          }),
        })
        if (!so.ok) {
          setError('Could not save your edits to the engine.')
          return
        }
      }
      const res = await fetch(actionUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: activeSession(), tenant: 'local', action: 'run_audit', stage: 'shot-list' }),
      })
      const out = await res.json().catch(() => null)
      if (!res.ok || out?.ok === false) {
        setError(out?.message || out?.error || 'Re-check failed to run.')
        return
      }
      setAudit(out?.data ?? out)
      setEdited(false)
      await exportXlsx({ silent: true })
    } catch {
      setError('Could not reach the engine.')
    } finally {
      setChecking(false)
    }
  }

  const activeVisual = visualEvents.find((event) => `base:${event.id}` === selected) ?? null
  const activeReaction = reactions.find((reaction, index) => `reaction:${reaction.id || index}` === selected) ?? null
  const activeChunk = chunks.find((chunk) => `chunk:${chunk.id}` === selected) ?? null
  const selectedChunkId = activeChunk?.id || activeVisual?.chunk_id || activeReaction?.start_chunk_id || activeReaction?.chunk_id || ''
  const pct = (s: number) => (s / totalSec) * 100

  const positioned = visualEvents.map((event) => ({
    event,
    start: eventStart(event),
    dur: Math.max(0.25, eventEnd(event) - eventStart(event)),
    chunk: chunkById.get(event.chunk_id || ''),
  }))
  const reactionPositions = reactions.map((reaction, index) => {
    const owner = chunkById.get(reaction.start_chunk_id || reaction.chunk_id || '')
    const anchor = visualEvents.find((event) => event.id === reaction.base_layer_id)
    const start = (anchor ? eventStart(anchor) : 0) + reactionOffset(reaction)
    return {
      reaction,
      key: `reaction:${reaction.id || index}`,
      start,
      dur: Math.max(0.25, Number(reaction.duration_s ?? 1)),
      owner,
    }
  })
  const scenes: { scene: string; title: string; start: number; end: number }[] = []
  for (const p of positioned) {
    const sc = p.chunk?.scene ?? p.event.chunk_id ?? ''
    const last = scenes[scenes.length - 1]
    if (last && last.scene === sc) last.end = p.start + p.dur
    else scenes.push({ scene: sc, title: p.chunk?.scene_title ?? p.event.chunk_id ?? '', start: p.start, end: p.start + p.dur })
  }
  const chunkSections = chunks.map((chunk) => {
    const visuals = visualEvents.filter((event) => event.chunk_id === chunk.id)
    const overlayItems = reactions.filter((reaction) => (reaction.start_chunk_id || reaction.chunk_id) === chunk.id)
    const start = visuals.length ? Math.min(...visuals.map(eventStart)) : 0
    const end = visuals.length ? Math.max(...visuals.map(eventEnd)) : start + estSec(chunk)
    return { chunk, visuals, reactions: overlayItems, start, end }
  })
  const activeXlsxSheet = xlsxPreview?.sheets?.[xlsxSheetIndex] ?? xlsxPreview?.sheets?.[0] ?? null
  useEffect(() => {
    if (!chunks.length || xlsxExists !== false || xlsxExporting || isBusy || autoExportRef.current) return
    autoExportRef.current = true
    void exportXlsx({ silent: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chunks.length, xlsxExists, xlsxExporting, isBusy])

  return (
    <div className="vp panel-flat">
      {/* Build / re-build (paid, validated in the same operation). The button
          only appears when the engine says this stage is actually buildable —
          a paid action must never look ready on a blocked step. */}
      {stageCurrent || chunks.length > 0 ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
          <FeedbackButton
            label={chunks.length ? 'Re-compile shot list' : 'Compile shot list'}
            busyLabel={(buildJob?.status || stageProcess?.status) === 'queued' ? 'Queued…' : 'Building…'}
            busy={building || activeProcess}
            title="Compiles the approved pacing plan — structure copied by code, AI writes the picture directions, the validator certifies it before you see it. Uses model credits."
            rulesFocus="visual-pacing"
            onRun={(fb) => build(fb)}
          />
          <ModelPicker model={model} onChange={setModel} disabled={isBusy} />
          {chunks.length > 0 ? (
            <button type="button" className="vp-undo" disabled={isBusy} onClick={recheck} title="Free — saves your edits and reruns the validator">
              {checking ? 'Checking…' : edited ? 'Save & re-check' : 'Re-check'}
            </button>
          ) : null}
          {(buildJob || stageProcess) && (building || activeProcess) ? (
            <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>job {buildJob?.status || stageProcess?.status}</span>
          ) : null}
          {error ? <span style={{ color: 'var(--red)', fontSize: 13, flexBasis: '100%' }}>Engine: {error}</span> : null}
        </div>
      ) : null}

      <div style={{ position: 'relative' }}>
        {isBusy ? (
          <div style={{ position: 'absolute', inset: 0, zIndex: 3, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, background: 'rgba(10,12,18,.45)', borderRadius: 8, minHeight: 120 }}>
            <span className="spin" />
            <span style={{ color: 'var(--ink-1)', fontSize: 13 }}>{processLabel}</span>
          </div>
        ) : null}
        <div style={isBusy ? { opacity: 0.4, pointerEvents: 'none' } : undefined}>
      {/* Validation status — what the code certified, in plain sight. */}
      {audit ? (
        <div style={{ marginBottom: 14, fontSize: 13, color: audit.passed ? 'var(--ink-2)' : 'var(--amber)' }}>
          {audit.passed
            ? '✓ Validator passed — this shot-list contract is certified for image generation.'
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
        <p style={{ color: 'var(--amber)', fontSize: 13 }}>The shot-list file doesn’t parse as JSON — rebuild it, or fix it by hand on disk.</p>
      ) : null}

      {!chunks.length ? (
        // One line — the red blocker card below already explains the unlock,
        // so don't say it twice in a second width.
        <p style={{ color: 'var(--ink-2)', fontSize: 13, lineHeight: 1.6, margin: '4px 0 0' }}>
          No shot list yet — this step compiles your approved pacing plan into the image
          generator’s work order, validated before you see it.
          {stageCurrent ? ' Build it above, with optional feedback for the AI.' : ''}
        </p>
      ) : (
        <>
          {/* One line of facts. */}
          <div className="ch" style={{ borderBottom: 'none', paddingBottom: 0 }}>
            <h3>{videoFirst
              ? `Compile Shot List — ${baseLayer.length} clips · ~${fmtTime(totalSec)} · picture + sound per clip`
              : `Compile Shot List — ${chunks.length} audio chunks · ${baseLayer.length} base visuals · ${reactions.length} reactions · ~${fmtTime(totalSec)}`}</h3>
            <span>shot-list/shot-list.json · shot-list.xlsx</span>
          </div>
          {unresolved.length > 0 ? (
            <p className="vp-hint" style={{ color: 'var(--amber)' }}>
              {unresolved.length} overlay idea{unresolved.length === 1 ? '' : 's'} still without a file
              ({unresolved.map((c) => c.id).join(', ')}) — attach the GIF at Visual Pacing or record a skip; the validator blocks until resolved.
            </p>
          ) : null}

          {/* Timing preview over the compiled contract. */}
          <TimelineScroller
            zoom={zoom}
            setZoom={setZoom}
            hint="Click a base visual or reaction to highlight the audio section it belongs to · drag the timeline to pan when zoomed"
          >
              {!videoFirst ? (
              <div className="vp-tl-row">
                <span className="vp-tl-label">Audio</span>
                <div className="vp-tl-track ruler">
                  {scenes.map((s, i) => (
                    <div
                      key={`${s.scene}-${i}`}
                      className={`vp-ruler-seg ${i % 2 ? 'alt' : ''} ${activeVisual && activeVisual.chunk_id === s.scene ? 'on' : ''}`}
                      style={{ left: `${pct(s.start)}%`, width: `${pct(s.end - s.start)}%` }}
                      title={`${s.scene} · ${s.title}`}
                    >
                      <span>{s.title || s.scene}</span>
                    </div>
                  ))}
                </div>
              </div>
              ) : null}
              <div className="vp-tl-row">
                <span className="vp-tl-label">{videoFirst ? 'Clips' : 'Base'}</span>
                <div className="vp-tl-track visuals">
                  {positioned.map(({ event, start, dur }) => (
                    <button
                      type="button"
                      key={event.id}
                      className={`vp-seg ${`base:${event.id}` === selected ? 'on' : ''}`}
                      style={{ left: `${pct(start)}%`, width: `${pct(dur)}%` }}
                      onClick={() => setSelected((cur) => (cur === `base:${event.id}` ? '' : `base:${event.id}`))}
                      title={`${event.id} · ${event.chunk_id || 'audio'} · ~${dur.toFixed(1)}s`}
                    >
                      <span>{event.id}</span>
                    </button>
                  ))}
                </div>
              </div>
              {!videoFirst ? (
              <div className="vp-tl-row">
                <span className="vp-tl-label">React</span>
                <div className="vp-tl-track">
                  {reactionPositions.length ? reactionPositions.map(({ reaction, key, start, dur }) => (
                    <button
                      type="button"
                      key={key}
                      className={`vp-overlay-mark ${key === selected ? 'on' : ''}`}
                      style={{ left: `${pct(start)}%`, width: `${Math.max(2, pct(dur))}%` }}
                      onClick={() => setSelected((cur) => (cur === key ? '' : key))}
                      title={`${reaction.id || 'reaction'} · ${reaction.source || ''}`}
                    >
                      {reaction.id || 'R'}
                    </button>
                  )) : <span className="vp-tl-empty">no reaction overlays</span>}
                </div>
              </div>
              ) : null}
          </TimelineScroller>

          {videoFirst ? (
          <div className="sl-review">
            {positioned.map(({ event, start, dur }) => {
              const chunk = chunkById.get(String(event.chunk_id ?? ''))
              const spoken = clipSpoken(event, chunk)
              const isOpen = selected === `base:${event.id}`
              const grp = String((event as Record<string, unknown>).group ?? '')
              const agrp = String((event as Record<string, unknown>).audio_group ?? '')
              return (
                <section key={event.id} className={`sl-section ${isOpen ? 'on' : ''}`}>
                  <button
                    type="button"
                    className="sl-section-head"
                    onClick={() => setSelected((cur) => (cur === `base:${event.id}` ? '' : `base:${event.id}`))}
                  >
                    <span className="id">{event.id}</span>
                    <span className="sl-title">{spoken ? `“${spoken}”` : 'Silent clip'}</span>
                    <span className="sl-meta">{fmtTime(start)}-{fmtTime(start + dur)} · {dur.toFixed(1)}s{grp ? ` · ${grp}` : ''}{agrp ? ` · ♪ ${agrp}` : ''}</span>
                  </button>
                  {(() => {
                    const tab = clipTab[event.id] ?? 'prompt'
                    return (
                      <div style={{ marginTop: 12 }}>
                        <div style={{ marginBottom: 8 }}>
                          <span className="vp-viewtoggle" style={{ display: 'inline-flex' }}>
                            <button type="button" className={tab === 'prompt' ? 'on' : ''} onClick={() => setClipTab((c) => ({ ...c, [event.id]: 'prompt' }))}>Prompt</button>
                            <button type="button" className={tab === 'description' ? 'on' : ''} onClick={() => setClipTab((c) => ({ ...c, [event.id]: 'description' }))}>Description</button>
                          </span>
                        </div>
                        <div>
                          {tab === 'prompt' ? (
                            assembled[event.id] !== undefined ? (
                              <pre style={{ whiteSpace: 'pre-wrap', margin: 0, border: '1px solid var(--line, #2a3142)', borderRadius: 6, padding: '8px 10px', fontSize: 13, lineHeight: 1.55, fontFamily: 'var(--mono)', color: 'var(--ink-2)', maxHeight: 340, overflow: 'auto' }}>{assembled[event.id]}</pre>
                            ) : (
                              <p style={{ margin: 0, color: 'var(--ink-3)', fontSize: 13 }}>Prompts aren’t built yet — they’re composed and edited at the generation step.</p>
                            )
                          ) : (
                            <p style={{ margin: 0, border: '1px solid var(--line, #2a3142)', borderRadius: 6, padding: '8px 10px', fontSize: 13, lineHeight: 1.55, fontFamily: 'var(--mono)', color: 'var(--ink-2)' }}>{event.visual_direction || '—'}</p>
                          )}
                        </div>
                      </div>
                    )
                  })()}
                  {(() => {
                    // CONFIRM THE REFERENCES: what actually reaches this clip.
                    const refs = (event.references ?? []).map(String)
                    const find = (n: string) => kit.find((k) => k.name === n)
                    const AUD = new Set(['voice', 'music', 'ambience', 'sfx', 'audio'])
                    const imgs = refs.filter((n) => find(n)?.image_path)
                    const texts = refs.filter((n) => { const k = find(n); return k ? !k.image_path && !AUD.has(k.kind) : true })
                    const attachedAudio = refs.filter((n) => AUD.has(find(n)?.kind ?? ''))
                    const planned = planRefsById[String(event.pacing_image_id ?? '')] ?? null
                    const pending = planned ? planned.filter((n) => !refs.includes(n) && find(n)) : []
                    const inherited = kit
                      .filter((k) => AUD.has(k.kind) && k.linked_to && !attachedAudio.includes(k.name))
                      .filter((k) => refs.some((n) => n === k.linked_to || find(n)?.variant_of === k.linked_to))
                    if (!imgs.length && !texts.length && !attachedAudio.length && !inherited.length && !pending.length) return null
                    const cardFor = (key: string, chip: string, name: string, notes?: string) => {
                      const isOpen = openCards.has(key)
                      return (
                        <span
                          key={key}
                          className="vp-map-txtatt"
                          style={{ cursor: 'pointer', ...(isOpen ? { maxWidth: 420 } : {}) }}
                          title={isOpen ? 'Click to collapse' : 'Click to show the full content'}
                          onClick={() => toggleCard(key)}
                        >
                          <span className="vp-map-chip">{chip}</span>
                          <span className="vp-map-attname">{name}</span>
                          {notes ? <span className="txt-notes" style={isOpen ? { display: 'block', WebkitLineClamp: 'unset', overflow: 'visible' } : undefined}>{notes}</span> : null}
                        </span>
                      )
                    }
                    return (
                      <div style={{ marginTop: 10 }}>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                        {imgs.map((n) => (
                          <img
                            key={n}
                            src={contentUrl(find(n)!.image_path!)}
                            alt={n}
                            title={`${n} — reference image (uploads to the model)`}
                            style={{ height: 132, width: 'auto', borderRadius: 9, border: '1px solid var(--line-2)', display: 'block' }}
                            onLoad={(e) => {
                              // Visuals first: every thumb gets the same square
                              // footage at its true ratio, not the same height.
                              const im = e.currentTarget
                              const r = im.naturalWidth / im.naturalHeight || 1
                              const h = Math.min(200, Math.sqrt(19000 / r))
                              im.style.height = `${Math.round(h)}px`
                              im.style.width = `${Math.round(h * r)}px`
                            }}
                          />
                        ))}
                        {texts.map((n) => cardFor(`${event.id}:t:${n}`, find(n)?.kind || 'ref', n, find(n)?.notes))}
                        {attachedAudio.map((n) => cardFor(`${event.id}:a:${n}`, `♪ ${find(n)?.kind || 'audio'}`, `${n} · this clip`, find(n)?.notes))}
                        {inherited.map((k) => cardFor(`${event.id}:i:${k.name}`, `♪ ${k.kind}`, `${k.name} · via ${k.linked_to}`, k.notes))}
                        {pending.map((n) => (
                          <span key={`p-${n}`} className="vp-undo" style={{ cursor: 'default', borderColor: 'var(--amber)', color: 'var(--amber)' }} title={`${n} is attached in the pacing plan but not in the compiled shot list yet — Sync refs (free) applies it.`}>
                            {AUD.has(find(n)?.kind ?? '') ? '♪ ' : ''}{n} · in plan, not synced
                          </span>
                        ))}
                        {pending.length ? (
                          <button type="button" className="vp-undo" disabled={syncing} onClick={() => void syncRefsFromPlan()} title="Free — copies each shot's refs from the pacing plan into the compiled shot list (code only, prose untouched)">
                            {syncing ? 'Syncing…' : '⟳ Sync refs from plan'}
                          </button>
                        ) : null}
                        </div>
                      </div>
                    )
                  })()}
                  <details className="sl-json" style={{ marginLeft: 0 }}>
                    <summary>JSON for {event.id}</summary>
                    <pre>{pretty(event)}</pre>
                  </details>
                </section>
              )
            })}
          </div>
          ) : (
          <div className="sl-review">
            {chunkSections.map(({ chunk, visuals, reactions: chunkReactions, start, end }) => {
              const isOpen = selectedChunkId === chunk.id || selected === `chunk:${chunk.id}`
              return (
                <section key={chunk.id} className={`sl-section ${isOpen ? 'on' : ''}`}>
                  <button
                    type="button"
                    className="sl-section-head"
                    onClick={() => setSelected((cur) => (cur === `chunk:${chunk.id}` ? '' : `chunk:${chunk.id}`))}
                  >
                    <span className="id">{chunk.id}</span>
                    <span className="sl-title">{chunk.scene_title || chunk.summary || chunk.id}</span>
                    <span className="sl-meta">{fmtTime(start)}-{fmtTime(end)} · {visuals.length} visual{visuals.length === 1 ? '' : 's'} · {chunkReactions.length || 'no'} reaction{chunkReactions.length === 1 ? '' : 's'}</span>
                  </button>
                  <div className="sl-script">
                    <span>Script</span>
                    <p>{chunkNarration(chunk)}</p>
                  </div>
                  {chunk.summary ? <p className="sl-summary-line">{chunk.summary}</p> : null}

                  <div className="sl-part-grid">
                    <div className="sl-part">
                      <h4>Audio chunk</h4>
                      <dl>
                        <dt>scene</dt><dd>{chunk.scene || '—'}</dd>
                        <dt>beats</dt><dd>{chunk.beats?.map((beat) => beat.id).join(', ') || '—'}</dd>
                        <dt>image path</dt><dd>{String(chunk.image_path || '—')}</dd>
                      </dl>
                    </div>
                    <div className="sl-part">
                      <h4>Visuals</h4>
                      {visuals.length ? visuals.map((event) => (
                        <button
                          type="button"
                          key={event.id}
                          className={`sl-item ${selected === `base:${event.id}` ? 'on' : ''}`}
                          onClick={() => {
                            // Copying a prompt out of the row must not toggle it.
                            if (window.getSelection()?.toString()) return
                            setSelected((cur) => (cur === `base:${event.id}` ? '' : `base:${event.id}`))
                          }}
                        >
                          <span className="id">{event.id}</span>
                          <span>{event.pacing_image_id || 'visual'} · {Number(event.duration_s ?? eventEnd(event) - eventStart(event)).toFixed(1)}s</span>
                          <small>{event.visual_direction || event.image_path || 'No visual direction'}</small>
                        </button>
                      )) : <p className="sl-empty">No base visuals</p>}
                    </div>
                    <div className="sl-part">
                      <h4>Reactions</h4>
                      {chunkReactions.length ? chunkReactions.map((reaction, index) => {
                        const key = `reaction:${reaction.id || index}`
                        return (
                          <button
                            type="button"
                            key={key}
                            className={`sl-item ${selected === key ? 'on' : ''}`}
                            onClick={() => setSelected((cur) => (cur === key ? '' : key))}
                          >
                            <span className="id">{reaction.id || 'R'}</span>
                            <span>{reaction.trigger ? `"${reaction.trigger}"` : reaction.what || 'reaction overlay'}</span>
                            <small>{shortPath(reaction.source)}</small>
                          </button>
                        )
                      }) : <p className="sl-empty">No reactions</p>}
                    </div>
                  </div>

                  <details className="sl-json">
                    <summary>JSON parts for {chunk.id}</summary>
                    <div className="sl-json-grid">
                      <div>
                        <b>chunks[]</b>
                        <pre>{pretty(chunk)}</pre>
                      </div>
                      <div>
                        <b>base_layer[]</b>
                        <pre>{pretty(visuals)}</pre>
                      </div>
                      <div>
                        <b>reactions[]</b>
                        <pre>{pretty(chunkReactions)}</pre>
                      </div>
                    </div>
                  </details>
                </section>
              )
            })}
          </div>
          )}

          <details className="sl-full-json">
            <summary>
              <span>Full shot-list JSON file</span>
              <small>view or edit raw export</small>
            </summary>
            <pre className="vp-json-view">{pretty(list)}</pre>
            <details className="vp-section">
              <summary className="vp-section-sum">
                <span className="vp-sec-title">Raw JSON editor</span>
                <span className="vp-section-count">advanced</span>
              </summary>
              <textarea
                value={draft}
                onChange={(e) => {
                  setStageDraft(stageId, e.target.value)
                  setEdited(true)
                }}
                rows={18}
                spellCheck={false}
                className="sl-json-editor"
              />
              <div className="vp-edit-actions" style={{ marginTop: 10 }}>
                <span className="vp-edit-note">Manual edits require “Save & re-check” before approval.</span>
              </div>
            </details>
          </details>
          <details className="sl-full-json">
            <summary>
              <span>View .xlsx</span>
              <small>{xlsxExists ? 'shot-list/shot-list.xlsx' : xlsxExporting ? 'exporting spreadsheet' : 'spreadsheet export missing'}</small>
            </summary>
            <div className="sl-xlsx-bar">
              <span className={`status-pill ${xlsxExists ? 'done' : 'work'}`}>
                {xlsxExists ? 'XLSX READY' : xlsxExporting ? 'EXPORTING' : 'XLSX MISSING'}
              </span>
              <button type="button" className="vp-undo" disabled={xlsxExporting} onClick={() => void exportXlsx()}>
                {xlsxExporting ? 'Exporting…' : 'Export XLSX'}
              </button>
              {xlsxPreview?.sheets?.length ? (
                <span className="sl-sheet-tabs" aria-label="Workbook sheets">
                  {xlsxPreview.sheets.map((sheet, index) => (
                    <button
                      key={sheet.name}
                      type="button"
                      className={`vp-undo sl-sheet-tab ${index === xlsxSheetIndex ? 'on' : ''}`}
                      onClick={() => setXlsxSheetIndex(index)}
                    >
                      {sheet.name}
                    </button>
                  ))}
                </span>
              ) : null}
              <span className="sl-xlsx-note">{xlsxLoading ? 'Reading spreadsheet…' : xlsxMessage || 'Preview is reading shot-list.xlsx directly.'}</span>
            </div>
            {activeXlsxSheet ? (
              <div className="sl-xlsx-scroll">
                <table className="sl-sheet-table" aria-label={`${activeXlsxSheet.name} spreadsheet preview`}>
                  <colgroup>
                    <col style={{ width: 42 }} />
                    {activeXlsxSheet.columns.map((column) => (
                      <col key={column.index} style={{ width: Math.max(72, Math.min(520, Math.round(column.width * 8))) }} />
                    ))}
                  </colgroup>
                  <thead>
                    <tr>
                      <th className="sl-sheet-corner" />
                      {activeXlsxSheet.columns.map((column) => <th key={column.index}>{column.label}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {activeXlsxSheet.rows.map((row) => (
                      <tr key={row.number}>
                        <th className="sl-row-num">{row.number}</th>
                        {row.cells.map((cell) => (
                          <td
                            key={`${row.number}-${cell.colIndex}`}
                            colSpan={cell.colSpan || 1}
                            rowSpan={cell.rowSpan || 1}
                            title={cell.value || undefined}
                          >
                            {cell.value}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {activeXlsxSheet.truncated ? (
                  <p className="sl-xlsx-note">Preview is truncated. Export opens the complete file.</p>
                ) : null}
              </div>
            ) : (
              <p className="vp-hint" style={{ marginTop: 12 }}>
                {xlsxLoading ? 'Reading spreadsheet…' : 'Export the XLSX file to show the spreadsheet preview.'}
              </p>
            )}
          </details>
        </>
      )}
        </div>
      </div>
      <RulesPanel step="shot_list_json" />
    </div>
  )
}
