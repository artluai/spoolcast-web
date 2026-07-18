import { useEffect, useRef, useState } from 'react'
import { activeSession, apiUrl, contentUrl, getFileJson, getJson, postAction, statusUrl } from '../../lib/api'
import { DEFAULT_MODEL_ID, draftReasoning } from '../../lib/draft-models'
import { DEFAULT_IMAGE_MODEL_ID, IMAGE_MODELS } from '../../lib/image-models'
import { ModelPicker } from './ModelPicker'
import { VariantModule } from './VariantModule'

// WORLD KIT CASTING PANEL — one kit item's reference image. Two labeled paths:
//   GENERATE (from the item's notes; options: model, canvas ratio, character
//   sheet, AI-improved prompt, image ingredients) — or ADD YOUR OWN (upload /
//   pick from the session). Every result is a kept version; the filmstrip is
//   the history and clicking picks the active one. Describe-with-AI appears
//   only for images that didn't come from a prompt.

type RefVersion = {
  id: string
  kind: 'generated' | 'uploaded' | 'mapped'
  file?: string
  path?: string
  prompt?: string
  // The character/subject prompt: what OTHER prompts import when they
  // reference this image (the person — never the sheet layout).
  subject?: string
  model?: string
  at?: string
}
type RefManifest = { versions: RefVersion[]; active: string | null }
type PoolImage = { path: string; name: string; size: number; ref?: string }

const KIND_BADGE: Record<RefVersion['kind'], string> = {
  generated: '✦ gen',
  uploaded: '↑ upload',
  mapped: '↦ mapped',
}

// ONE text box is the whole prompt: the item's notes are sent verbatim, and
// every control (character-sheet rewrite, attach/detach, improve-with-AI)
// edits that text in place — nothing is appended invisibly at send time.
//
// A character sheet is multiple angles of the same subject — a suffix can't
// turn a scene description into one, so the button routes through
// improve-with-AI with this pre-filled instruction to rewrite the prompt.
const SHEET_GUIDANCE =
  'Rewrite this as a character reference sheet: multiple angles of the same person (front, side, three-quarter view), identical face, hair and wardrobe in every view, isolated on a clean blank studio background, no scene.'
const REF_LINE_RE = /^Reference image \d+.*$/gm

const stripRefLines = (t: string) => t.replace(REF_LINE_RE, '').replace(/\n{3,}/g, '\n\n').trim()
const existingRefLines = (t: string) => (t.match(REF_LINE_RE) ?? []).join('\n')

// Job failures store the tail of stderr (ANSI-colored traceback). Dig out the
// human sentence — kie's msg=… if present, else the last "SomeError: …" line.
const jobErrorMessage = (raw: string): string => {
  const clean = raw.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b/g, '')
  const kie = /msg=(.*)\)\s*$/m.exec(clean)
  if (kie) return kie[1].trim()
  const errLine = clean
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[\w.]+Error(:|\b)/.test(l))
    .pop()
  return errLine ? errLine.replace(/^[\w.]+Error:\s*/, '') : ''
}

export function RefImagePanel({
  refId,
  notes,
  // notesLabel kept for API compat — the label now says what the prompt IS
  // (image vs subject), not which md column it came from.
  notesLabel: _notesLabel = 'NOTES',
  kind = '',
  fields,
  kitIndex = {},
  onDescribed,
  onNotesChange,
  onNotesInput,
  onNotesFocus,
  onToast,
  onVariantCreated,
  onAudioAdd,
  linkedTo = '',
}: {
  refId: string
  notes: string
  // Column name for the prompt box label (the panel owns the textarea so it
  // can toggle between the generation prompt and the character prompt).
  notesLabel?: string
  kind?: string
  // The item's editors (REF/KIND/SAVE TO) — rendered to the RIGHT of the
  // image so the card reads image-first with no dead space.
  fields?: React.ReactNode
  // Other kit items' kind + notes, keyed by ref: attached kit images bring
  // their own descriptions into the prompt so "the cast reference" means
  // something to the model.
  kitIndex?: Record<string, { kind: string; notes: string; section: string }>
  onDescribed: (text: string) => void
  // Replaces the item's notes wholesale — how sheet/attach/improve edit the
  // one prompt box (onDescribed appends; this overwrites). Snapshots undo.
  onNotesChange?: (text: string) => void
  // Keystroke-level notes edit (no undo snapshot; pair with onNotesFocus).
  onNotesInput?: (text: string) => void
  onNotesFocus?: () => void
  onToast: (message: string) => void
  // The engine writes variant/audio rows to the FILE; these callbacks let the
  // host editor mirror them into its unsaved draft so saving doesn't erase them.
  onVariantCreated?: (name: string, instruction: string) => void
  onAudioAdd?: (audio: { name: string; kind: string; linkedTo: string; source: string; notes: string }) => void
  // Audio objects: the kit item this sound belongs to (Linked to column).
  linkedTo?: string
}) {
  const [manifest, setManifest] = useState<RefManifest | null>(null)
  const [imgModel, setImgModel] = useState(DEFAULT_IMAGE_MODEL_ID)
  const [txtModel, setTxtModel] = useState(DEFAULT_MODEL_ID)
  const [generating, setGenerating] = useState(false)
  const [detailing, setDetailing] = useState(false)
  const [describing, setDescribing] = useState(false)
  const [galleryOpen, setGalleryOpen] = useState(false)
  const [pool, setPool] = useState<PoolImage[] | null>(null)
  // Masters are full scenes; the character-sheet rewrite only fits ingredients.
  const isMaster = /master/i.test(kind)
  // Audio objects (voice/music/ambience/sfx) have no image to generate —
  // their panel is the fields + prompt + source, nothing else.
  const isAudio = /^(voice|music|ambience|sfx|audio)\b/i.test(kind)
  // Canvas ratio for THIS generation ('auto' = the video's ratio). A wide
  // character sheet inside a vertical video is normal.
  const [ratio, setRatio] = useState('auto')
  const [sessionRatio, setSessionRatio] = useState('16:9')
  useEffect(() => {
    getFileJson<{ aspect_ratio?: string }>('session.json').then((cfg) => {
      if (cfg?.aspect_ratio) setSessionRatio(cfg.aspect_ratio)
    })
  }, [])
  const [dims, setDims] = useState('')
  // Ingredients: images that ride along with the prompt (how masters compose).
  const [attachOpen, setAttachOpen] = useState(false)
  const [attachPool, setAttachPool] = useState<PoolImage[] | null>(null)
  const [attached, setAttached] = useState<string[]>([])
  const fileRef = useRef<HTMLInputElement | null>(null)
  const timerRef = useRef<number | null>(null)

  const [createOpen, setCreateOpen] = useState(false)
  const [improveOpen, setImproveOpen] = useState(false)
  const [guidance, setGuidance] = useState('')
  // Last generation failure, shown in the panel until the next attempt.
  const [genError, setGenError] = useState('')
  // "Reduce AI aesthetic" — same pattern as the Character sheet button: it
  // opens improve-with-AI with the saved instruction pre-filled as guidance,
  // and Improve rewrites the whole prompt with that look woven in. The
  // instruction is editable in the guidance box; small buttons save the tweak
  // (engine resolution: this video's override -> global default -> built-in).
  const [lessMode, setLessMode] = useState(false)
  const lessTextRef = useRef<string | null>(null)
  const fetchLess = async (): Promise<string> => {
    if (lessTextRef.current !== null) return lessTextRef.current
    const out = await postAction<{ text?: string }>({ action: 'get_prompt_snippet', name: 'less-ai' })
    lessTextRef.current = out?.ok ? (out.data?.text ?? '').trim() : ''
    return lessTextRef.current
  }
  const openLessMode = () => {
    setLessMode(true)
    setImproveOpen(true)
    void fetchLess().then((text) => {
      if (text) setGuidance(text)
    })
  }
  const saveLess = (scope: 'session' | 'global') => {
    const text = guidance.trim()
    if (!text) return
    lessTextRef.current = text
    void postAction({ action: 'set_prompt_snippet', name: 'less-ai', scope, text })
    if (scope === 'global') {
      // The global default should now be what the user sees — drop any
      // session override so it doesn't silently win over the new default.
      void postAction({ action: 'set_prompt_snippet', name: 'less-ai', scope: 'session', text: '' })
      onToast('Saved as the default instruction for all videos.')
    } else {
      onToast('Saved as this video’s instruction.')
    }
  }
  // Dual-prompt state: charPrompt = the character prompt (imported when this
  // item is referenced elsewhere); notes stay the generation prompt. sheetMode
  // makes the next Improve produce BOTH (character first, sheet built from it).
  const [charPrompt, setCharPrompt] = useState<string | null>(null)
  const [promptView, setPromptView] = useState<'prompt' | 'character'>('prompt')
  const [sheetMode, setSheetMode] = useState(false)
  const dualImprove = !isMaster && (sheetMode || charPrompt !== null)

  const savedSubjectRef = useRef<string | null>(null)
  const saveSubject = (text: string) => {
    if (!manifest?.active) return
    savedSubjectRef.current = text
    void postAction({ action: 'set_ref_subject', ref: refId, id: manifest.active, text })
  }
  // Persist character-prompt edits automatically (debounced) — blur events
  // are unreliable and the card can close without one.
  useEffect(() => {
    if (charPrompt === null || charPrompt === savedSubjectRef.current) return
    const t = window.setTimeout(() => saveSubject(charPrompt), 800)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [charPrompt])
  // Switching versions swaps the prompt with the image: a generated version
  // carries the exact prompt it was made from, and picking it in HISTORY
  // writes that prompt into the box (uploads/mapped keep the notes as-is).
  // ONLY on an explicit pick — syncing on open would overwrite edits the user
  // saved after generating.
  const syncNotesToVersion = (v: RefVersion | undefined) => {
    if (v?.kind === 'generated' && v.prompt && v.prompt.trim() !== notes.trim()) {
      onNotesChange?.(v.prompt)
    }
  }

  const manifestPath = `source/world-kit-refs/${refId}/manifest.json`
  const loadManifest = () =>
    getFileJson<RefManifest>(manifestPath).then((m) => {
      const resolved = m ?? { versions: [], active: null }
      setManifest(resolved)
      return resolved
    })

  useEffect(() => {
    setManifest(null)
    setAttached([])
    setGenError('')
    setAttachOpen(false)
    setGalleryOpen(false)
    setImproveOpen(false)
    setGuidance('')
    setDims('')
    setCharPrompt(null)
    setPromptView('prompt')
    setSheetMode(false)
    setLessMode(false)
    // no image yet -> the create section is the whole point, start it open
    loadManifest().then((m) => {
      setCreateOpen(m.versions.length === 0)
      const act = m.versions.find((v) => v.id === m.active)
      savedSubjectRef.current = act?.subject ?? null
      if (act?.subject) setCharPrompt(act.subject)
      // Notes follow the SELECTED image — but only when they are plainly a
      // stale version prompt (empty, or identical to another version's stored
      // prompt). Hand-edited text is never overwritten on open.
      const noteText = notes.trim()
      const stale =
        noteText === '' || m.versions.some((v) => v.id !== m.active && (v.prompt ?? '').trim() === noteText)
      if (stale) syncNotesToVersion(m.versions.find((v) => v.id === m.active))
    })
    if (REF_LINE_RE.test(notes)) {
      REF_LINE_RE.lastIndex = 0
      void loadAttachPool().then((pool) => prefillAttached(notes, pool))
    }
    // HOLD MY PLACE: a generation started earlier keeps running engine-side
    // (durable job files) — leaving the step unmounted the panel and dropped
    // its poller. Find a live job for THIS item and show it again.
    void fetch(statusUrl())
      .then((r) => (r.ok ? r.json() : null))
      .then(async (out) => {
        const jobs = (out?.data?.jobs ?? []) as { job_id?: string; job?: string; state?: string }[]
        for (const j of jobs) {
          if (j.job !== 'generate_worldkit_ref' || !j.job_id) continue
          if (!['queued', 'running'].includes(j.state ?? '')) continue
          const st = await getFileJson<{ command?: string[] }>(`working/jobs/${j.job_id}.json`)
          const cmd = st?.command ?? []
          const ri = cmd.indexOf('--ref')
          if (ri >= 0 && cmd[ri + 1] === refId) {
            setGenerating(true)
            setCreateOpen(true)
            pollJob(j.job_id)
            return
          }
        }
      })
      .catch(() => {})
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refId])

  const versionUrl = (v: RefVersion) =>
    v.kind === 'mapped' ? contentUrl(v.path ?? '') : contentUrl(`source/world-kit-refs/${refId}/${v.file ?? ''}`)
  const versionRelPath = (v: RefVersion) =>
    v.kind === 'mapped' ? (v.path ?? '') : `source/world-kit-refs/${refId}/${v.file ?? ''}`
  const activeVersion = manifest?.versions.find((v) => v.id === manifest?.active) ?? null

  // VARIANT + LINKED AUDIO state (the buttons at the panel's foot).
  const [createMode, setCreateMode] = useState<'version' | 'variant'>('version')
  const [audioOpen, setAudioOpen] = useState(false)
  const [aName, setAName] = useState('')
  const [aKind, setAKind] = useState('voice')
  const [aNotes, setANotes] = useState('')
  const [aUrl, setAUrl] = useState('')
  const [aBusy, setABusy] = useState(false)
  // THE EAR: find the linked item's active image and ask AI what voice that
  // person would have — the user's idea, made a button.
  const voiceFromImage = async () => {
    if (!linkedTo) return
    const out = await getJson<{ ok?: boolean; data?: { images?: PoolImage[] } }>(
      apiUrl('source-images', { session: activeSession(), include_refs: 1 }),
    )
    const hit = (out?.data?.images ?? []).find((img) => img.ref === linkedTo)
    if (!hit) {
      onToast(`"${linkedTo}" has no image yet — pick or generate one there first.`)
      return
    }
    setDescribing(true)
    const res = await postAction<{ text?: string }>({ action: 'describe_ref_image', path: hit.path, voice: true, allow_cost: true })
    setDescribing(false)
    if (res?.ok && res.data?.text) {
      onDescribed(res.data.text)
      onToast(`Voice written from ${linkedTo}'s image — edit it like any prompt.`)
    } else {
      onToast(`Engine: ${res?.error || res?.message || 'could not describe the voice.'}`)
    }
  }

  const saveAudio = async (file?: File) => {
    setABusy(true)
    try {
      let source = aUrl.trim()
      if (file) {
        const safe = file.name.replace(/[^A-Za-z0-9._-]+/g, '-')
        const b64 = await new Promise<string>((resolve, reject) => {
          const rd = new FileReader()
          rd.onload = () => resolve(String(rd.result).split(',')[1] || '')
          rd.onerror = reject
          rd.readAsDataURL(file)
        })
        const up = await postAction<{ path?: string }>({ action: 'upload_file', filename: safe, content: b64, dir: 'audio-refs' })
        if (!up?.ok) {
          onToast(`Engine: ${up?.error || 'audio upload failed.'}`)
          return
        }
        source = `source/audio-refs/${safe}`
      }
      const name = (aName.trim() || `${refId}-${aKind}`).replace(/-+$/, '')
      onAudioAdd?.({ name, kind: aKind, linkedTo: refId, source, notes: aNotes.trim() })
      onToast(`${aKind} object "${name}" added, linked to ${refId} — save the step to keep it.`)
      setAName('')
      setANotes('')
      setAUrl('')
      setAudioOpen(false)
    } finally {
      setABusy(false)
    }
  }

  // Which kit item an attached image belongs to (by its world-kit-refs path,
  // or by the pool entry's ref for mapped actives).
  const itemForPath = (path: string): { ref: string; kind: string; notes: string } | null => {
    const m = /world-kit-refs\/([^/]+)\//.exec(path)
    const ref = m?.[1] ?? attachPool?.find((i) => i.path === path)?.ref ?? null
    if (!ref) return null
    const info = kitIndex[ref]
    return { ref, kind: info?.kind ?? '', notes: info?.notes ?? '' }
  }

  const versions = manifest?.versions ?? []
  const active = versions.find((v) => v.id === manifest?.active) ?? null

  const pollJob = (jobId: string) => {
    const tick = async () => {
      const state = await getFileJson<{ state?: string; error?: string }>(`working/jobs/${jobId}.json`)
      if (state?.state === 'succeeded') {
        setGenerating(false)
        await loadManifest()
        onToast('Reference generated — it joined this item’s history.')
        return
      }
      if (state?.state && ['failed', 'stopped', 'lost'].includes(state.state)) {
        setGenerating(false)
        const msg = jobErrorMessage(state.error ?? '')
        setGenError(msg || `Generation ${state.state} — see the job log (working/jobs/${jobId}.log).`)
        onToast(msg ? `Generation failed: ${msg}` : 'Reference generation failed — see the job log, then try again.')
        return
      }
      timerRef.current = window.setTimeout(tick, 4000)
    }
    timerRef.current = window.setTimeout(tick, 4000)
  }

  // The model can't know what "the cast reference" is — each attached image
  // gets a numbered line spelling out what it contains, written INTO the
  // notes box so the visible text is exactly what is sent. The description is
  // the engine's cached SUBJECT of the item's active image (a character sheet
  // yields the person, never the sheet layout); item notes are the fallback.
  // The imported description: the item's stored character prompt if its
  // active image has one, else its notes. NO automatic AI here — describing
  // an image is always the explicit ✦ Describe button on that item.
  const subjectsRef = useRef<Record<string, string | null>>({})
  const fetchSubject = async (ref: string): Promise<string | null> => {
    if (subjectsRef.current[ref] !== undefined) return subjectsRef.current[ref]
    const m = await getFileJson<RefManifest>(`source/world-kit-refs/${ref}/manifest.json`)
    const subject = m?.versions.find((v) => v.id === m.active)?.subject?.trim() || null
    subjectsRef.current[ref] = subject
    return subject
  }

  const buildRefLines = (paths: string[]) =>
    Promise.all(
      paths.map(async (p, i) => {
        const item = itemForPath(p)
        if (!item) return `Reference image ${i + 1}: ${p.split('/').pop()}`
        const desc = (await fetchSubject(item.ref)) ?? item.notes.replace(/\s+/g, ' ')
        const head = `Reference image ${i + 1} is the ${item.kind || 'item'} “${item.ref}”`
        return desc ? `${head}: ${desc}` : `${head}.`
      }),
    )

  const applyAttached = async (paths: string[]) => {
    if (paths.length === attached.length && paths.every((p, i) => p === attached[i])) return
    setAttached(paths)
    const base = stripRefLines(notes)
    if (!paths.length) {
      onNotesChange?.(base)
      return
    }
    const lines = await buildRefLines(paths)
    onNotesChange?.(`${base}\n\n${lines.join('\n')}`)
  }

  // kie.ai rejects prompts over the selected model's documented cap — stop
  // before spending the credit, with the counter showing how far over.
  // EVERY thumbnail grid obeys the same law as the walls: equal square
  // footage per image, shaped by its own w/h — never uniform crops.
  const equalArea = (area: number, capW = 240) => (e: React.SyntheticEvent<HTMLImageElement>) => {
    const im = e.currentTarget
    const r = im.naturalWidth / im.naturalHeight || 1
    let h = Math.sqrt(area / r)
    if (h * r > capW) h = capW / r
    im.style.height = `${Math.round(h)}px`
    im.style.width = `${Math.round(h * r)}px`
  }

  const promptLimit = IMAGE_MODELS.find((m) => m.id === imgModel)?.maxChars ?? 20000

  const generate = async () => {
    const prompt = notes.trim()
    if (!prompt) {
      onToast('Write a prompt description first — that’s what the image is generated from.')
      return
    }
    if (prompt.length > promptLimit) {
      setGenError(
        `Prompt is ${prompt.length.toLocaleString()} characters — this model accepts at most ${promptLimit.toLocaleString()}. Shorten it (Improve with AI can compress it).`,
      )
      return
    }
    if (/^Reference image \d+/m.test(prompt) && attached.length === 0) {
      setGenError(
        'The prompt mentions reference images but none are attached — attach them under ⧉ Reference images, or delete those lines.',
      )
      return
    }
    setGenError('')
    setGenerating(true)
    const out = await postAction<{ stdout?: string }>({
      action: 'generate_worldkit_ref',
      ref: refId,
      prompt,
      model: imgModel,
      ...(attached.length ? { ref_images: attached } : {}),
      ...(ratio !== 'auto' ? { aspect_ratio: ratio } : {}),
      ...(charPrompt?.trim() ? { subject: charPrompt.trim() } : {}),
      allow_cost: true,
    })
    const already = /already running as (\S+)/.exec(out?.details || '')?.[1]
    const jobId = already ?? /job (\S+)/.exec(out?.data?.stdout || '')?.[1] ?? null
    if (!out || (!out.ok && !already) || !jobId) {
      setGenerating(false)
      onToast(out ? `Engine: ${out.error || out.message || 'could not start generation.'}` : 'The engine is not reachable.')
      return
    }
    pollJob(jobId)
  }

  const expand = (text: string, extraGuidance: string) =>
    postAction<{ text?: string }>({
      action: 'expand_ref_prompt',
      text,
      ...(extraGuidance.trim() ? { guidance: extraGuidance.trim() } : {}),
      model: txtModel,
      ...(draftReasoning(txtModel) ? { reasoning: draftReasoning(txtModel) } : {}),
      allow_cost: true,
    })

  const detailPrompt = async () => {
    const base = (dualImprove && charPrompt?.trim()) || stripRefLines(notes)
    if (!base) {
      onToast('Write a short description first — the AI improves it.')
      return
    }
    setDetailing(true)
    if (dualImprove) {
      // Two prompts from one click: the CHARACTER prompt (imported when this
      // item is referenced elsewhere), then the SHEET prompt built from it
      // (what Generate uses to make the sheet image).
      const charOut = await expand(
        base,
        `Write it as a description of the character only — never mention a reference sheet, panels, multiple views or layout. ${guidance}`,
      )
      if (!charOut?.ok || !charOut.data?.text) {
        setDetailing(false)
        onToast(`Engine: ${charOut?.error || charOut?.message || 'could not improve the prompt.'}`)
        return
      }
      const sheetOut = await expand(charOut.data.text, SHEET_GUIDANCE)
      setDetailing(false)
      if (!sheetOut?.ok || !sheetOut.data?.text) {
        onToast(`Engine: ${sheetOut?.error || sheetOut?.message || 'could not build the sheet prompt.'}`)
        return
      }
      setCharPrompt(charOut.data.text)
      saveSubject(charOut.data.text)
      onNotesChange?.(sheetOut.data.text)
      setPromptView('prompt')
      setImproveOpen(false)
      if (lessMode) {
        setLessMode(false)
        setGuidance('')
      }
      onToast('Two prompts written — toggle between sheet and character above the text box.')
      return
    }
    const out = await expand(base, guidance)
    setDetailing(false)
    if (out?.ok && out.data?.text) {
      // Rewrite the description in place; the reference-image lines stay.
      const lines = existingRefLines(notes)
      onNotesChange?.(out.data.text + (lines ? `\n\n${lines}` : ''))
      setImproveOpen(false)
      if (lessMode) {
        setLessMode(false)
        setGuidance('')
      }
    } else {
      onToast(`Engine: ${out?.error || out?.message || 'could not improve the prompt.'}`)
    }
  }

  const describe = async () => {
    if (!active) return
    setDescribing(true)
    const out = await postAction<{ text?: string }>({
      action: 'describe_ref_image',
      path: versionRelPath(active),
      allow_cost: true,
    })
    setDescribing(false)
    if (out?.ok && out.data?.text) {
      onDescribed(out.data.text)
      onToast('Description written into the item’s notes.')
    } else {
      onToast(`Engine: ${out?.error || out?.message || 'could not describe the image.'}`)
    }
  }

  const upload = async (file: File) => {
    const b64 = await new Promise<string>((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
      r.onerror = reject
      r.readAsDataURL(file)
    })
    const out = await postAction({ action: 'add_ref_image', ref: refId, filename: file.name, content: b64 })
    if (out?.ok) {
      await loadManifest()
      onToast('Image added to this item’s history.')
    } else {
      onToast(`Engine: ${out?.error || 'upload failed.'}`)
    }
  }

  // Session-wide pool (kit actives carry .ref); the gallery filters out the
  // current item's own images at render time so the cache survives item
  // switches and the open-time prefill below.
  const loadAttachPool = async (): Promise<PoolImage[]> => {
    if (attachPool !== null) return attachPool
    const out = await getJson<{ ok?: boolean; data?: { images?: PoolImage[] } }>(
      apiUrl('source-images', { session: activeSession(), include_refs: 1 }),
    )
    // Mapped kit actives share a path with their source image — keep one
    // entry per path (prefer the kit one, which carries .ref).
    const seen = new Map<string, PoolImage>()
    for (const i of out?.data?.images ?? []) {
      if (!seen.has(i.path) || i.ref) seen.set(i.path, i)
    }
    const pool = [...seen.values()]
    setAttachPool(pool)
    return pool
  }

  const openAttach = () => {
    setAttachOpen((v) => !v)
    void loadAttachPool()
  }

  // "Reference image N …" lines in the prompt are the durable record of what
  // was attached — re-attach those images when the item opens, so the text
  // and the payload never disagree after a refresh.
  const prefillAttached = (text: string, pool: PoolImage[]) => {
    const paths: string[] = []
    for (const line of text.match(REF_LINE_RE) ?? []) {
      const named = /“([^”]+)”/.exec(line)?.[1]
      const file = named ? null : /^Reference image \d+:\s*(.+)$/.exec(line)?.[1]?.trim()
      const hit = named
        ? pool.find((i) => i.ref === named)
        : file
          ? pool.find((i) => i.name === file || i.path.endsWith(`/${file}`))
          : undefined
      if (hit && !paths.includes(hit.path)) paths.push(hit.path)
    }
    if (paths.length) setAttached(paths)
  }

  const openGallery = async () => {
    setGalleryOpen((v) => !v)
    if (pool === null) {
      const out = await getJson<{ ok?: boolean; data?: { images?: PoolImage[] } }>(
        apiUrl('source-images', { session: activeSession() }),
      )
      setPool(out?.data?.images ?? [])
    }
  }

  const mapImage = async (path: string) => {
    const out = await postAction({ action: 'map_ref_image', ref: refId, path })
    if (out?.ok) {
      setGalleryOpen(false)
      await loadManifest()
      onToast('Image added to this item’s history.')
    } else {
      onToast(`Engine: ${out?.error || 'could not use that image.'}`)
    }
  }

  const pick = async (v: RefVersion) => {
    if (manifest?.active === v.id) return
    setManifest((m) => (m ? { ...m, active: v.id } : m))
    const out = await postAction({ action: 'set_ref_active', ref: refId, id: v.id })
    if (!out?.ok) {
      onToast(`Engine: ${out?.error || 'could not set the reference.'}`)
      await loadManifest()
      return
    }
    syncNotesToVersion(v)
    savedSubjectRef.current = v.subject ?? null
    setCharPrompt(v.subject ?? null)
    setPromptView('prompt')
  }

  const small: React.CSSProperties = {
    background: 'var(--bg-3)', border: '1px solid var(--line-2)', color: 'var(--ink-2)',
    borderRadius: 6, padding: '7px 12px', fontSize: 12, cursor: 'pointer',
  }
  const clusterLabel: React.CSSProperties = {
    fontSize: 10, letterSpacing: '.1em', color: 'var(--ink-3)', fontFamily: 'var(--mono)',
  }

  return (
    <div style={{ borderTop: fields ? undefined : '1px dashed var(--line, #2a3142)', marginTop: fields ? 0 : 10, paddingTop: fields ? 0 : 12 }}>
      {/* IMAGE LEFT · FIELDS RIGHT */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ width: 210, flex: 'none' }}>
          {active ? (
            <>
              <img
                src={versionUrl(active)}
                alt=""
                onLoad={(e) => setDims(`${e.currentTarget.naturalWidth}×${e.currentTarget.naturalHeight}`)}
                style={{ width: 210, height: 'auto', display: 'block', borderRadius: 10, border: '1px solid var(--accent)' }}
              />
              <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 4 }}>
                {KIND_BADGE[active.kind]}{dims ? ` · ${dims}` : ''}
              </div>
              {active.kind !== 'generated' && (
                <button
                  type="button"
                  style={{ ...small, marginTop: 6, padding: '5px 10px', fontSize: 11.5 }}
                  disabled={describing}
                  onClick={describe}
                >
                  {describing ? (<><span className="spin" /> Describing…</>) : '✦ Describe with AI → notes'}
                </button>
              )}
            </>
          ) : (
            <div
              style={{
                width: 210, height: 160, borderRadius: 10, border: '1px dashed var(--line, #2a3142)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ink-3)', fontSize: 12,
                textAlign: 'center', padding: 10,
              }}
            >
              {manifest === null ? 'Loading…' : isAudio ? 'Audio object — describe the sound; attach a sample via SOURCE (file path or URL).' : 'No image yet — create one below.'}
            </div>
          )}
          {versions.some((v) => v.id !== manifest?.active) && (
            <div style={{ marginTop: 8 }}>
              <div style={{ ...clusterLabel, marginBottom: 5 }}>HISTORY — CLICK TO SWITCH</div>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                {/* The ACTIVE version is the big image above — repeating it
                    here showed the same picture twice. */}
                {versions.filter((v) => v.id !== manifest?.active).map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => pick(v)}
                    title={`${v.id} · ${v.kind}${v.model ? ` · ${v.model}` : ''}${v.prompt ? `\n\n${v.prompt.slice(0, 300)}` : ''}`}
                    style={{
                      padding: 0, borderRadius: 7, overflow: 'hidden', cursor: 'pointer', position: 'relative',
                      border: manifest?.active === v.id ? '2px solid var(--accent)' : '1px solid var(--line, #2a3142)',
                      background: 'none',
                    }}
                  >
                    {/* Natural proportions, generous size — the page scrolls,
                        cropped postage stamps hide what changed between takes. */}
                    <img src={versionUrl(v)} alt="" style={{ height: 170, width: 'auto', maxWidth: 340, display: 'block' }} />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        {fields && (
          <div style={{ flex: '1 1 280px', display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
            {fields}
            <div>
              <div style={{ fontSize: 11, color: 'var(--ink-3)', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                {charPrompt === null ? (
                  isAudio ? 'SOUND DESCRIPTION — how it sounds; rides into every clip of whatever it’s linked to' : 'IMAGE PROMPT — makes this item’s image'
                ) : (
                  <>
                    {(['prompt', 'character'] as const).map((v) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => setPromptView(v)}
                        style={{
                          background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                          fontSize: 11, letterSpacing: 'inherit', fontFamily: 'inherit',
                          color: promptView === v ? 'var(--ink-1)' : 'var(--ink-3)',
                          textDecoration: promptView === v ? 'underline' : 'none', textUnderlineOffset: 3,
                        }}
                      >
                        {v === 'prompt' ? 'IMAGE PROMPT' : 'SUBJECT PROMPT'}
                      </button>
                    ))}
                    <span>
                      {promptView === 'prompt'
                        ? '— makes this item’s image'
                        : '— describes the subject; other shots import this when they reference the item'}
                    </span>
                  </>
                )}
              </div>
              <textarea
                value={promptView === 'character' && charPrompt !== null ? charPrompt : notes}
                onFocus={promptView === 'character' ? undefined : onNotesFocus}
                onChange={(e) =>
                  promptView === 'character' && charPrompt !== null
                    ? setCharPrompt(e.target.value)
                    : onNotesInput?.(e.target.value)
                }
                onBlur={() => {
                  if (promptView === 'character' && charPrompt !== null) saveSubject(charPrompt)
                }}
                rows={5}
                ref={(el) => {
                  // Auto-grow to fit — attach/improve write lines in here and
                  // they must be visible, not hidden behind a scrollbar.
                  if (el && el.scrollHeight > el.clientHeight) el.style.height = `${el.scrollHeight + 4}px`
                }}
                style={{
                  display: 'block', width: '100%', boxSizing: 'border-box', resize: 'vertical', background: 'transparent',
                  color: 'var(--ink-2)', border: '1px solid var(--line, #2a3142)', borderRadius: 6,
                  padding: '8px 10px', fontSize: 13, lineHeight: 1.5, marginTop: 3,
                }}
              />
              {/* One row under the prompt: the two create entries left, the
                  character count right — with the text it measures. Audio
                  items instead get the ear: AI writes the voice the LINKED
                  item's picture suggests. */}
              {isAudio ? (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
                  <button
                    type="button"
                    className="vp-undo"
                    disabled={describing || !linkedTo}
                    title={linkedTo
                      ? `AI looks at ${linkedTo}'s picture and writes the voice they'd have`
                      : 'Set LINKED TO to a kit item with an image first'}
                    onClick={() => void voiceFromImage()}
                  >
                    {describing ? (<><span className="spin" /> Listening…</>) : `✦ Voice from ${linkedTo || 'linked'}’s image`}
                  </button>
                </div>
              ) : (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
                {(['version', 'variant'] as const).map((m) => {
                  const on = createOpen && createMode === m
                  return (
                    <button
                      key={m}
                      type="button"
                      className="vp-undo"
                      title={m === 'version'
                        ? 'Another take of THIS item — lands in its history, click a thumbnail to pick the active one'
                        : 'A NEW kit item derived from this one — one deliberate change, gets its own history. (Unrelated item? + Add on the section.)'}
                      style={on ? { borderColor: 'var(--accent)', color: 'var(--accent-2)' } : undefined}
                      onClick={() => {
                        if (on) setCreateOpen(false)
                        else {
                          setCreateMode(m)
                          setCreateOpen(true)
                        }
                      }}
                    >
                      {m === 'version' ? `${on ? '▾' : '▸'} Update existing` : `${on ? '▾' : '▸'} New variant`}
                    </button>
                  )
                })}
                <span
                  title="Prompt length vs. the selected model's limit"
                  style={{
                    marginLeft: 'auto', fontSize: 10.5, fontFamily: 'var(--mono)',
                    color: notes.trim().length > promptLimit ? 'var(--red, #e5534b)' : notes.trim().length > promptLimit * 0.8 ? 'var(--amber, #d29922)' : 'var(--ink-3)',
                  }}
                >
                  {notes.trim().length.toLocaleString()} / {promptLimit.toLocaleString()}
                </span>
              </div>
              )}
            </div>
      {createOpen && !isAudio && (
        <div style={{ position: 'relative', marginTop: 8 }}>
          <p style={{ fontSize: 11, color: 'var(--ink-3)', margin: '0 0 8px' }}>
            {createMode === 'version'
              ? `Another take of ${refId} — lands in its history above; click a thumbnail to pick the active one.`
              : `A NEW linked item — one deliberate change, its own history. Unrelated item? Use + Add on the section.`}
          </p>
          {createMode === 'variant' ? (
            <VariantModule
              inline
              base={{
                name: refId,
                kind,
                notes,
                image_path: activeVersion ? versionRelPath(activeVersion) : '',
                active_prompt: activeVersion?.prompt || '',
                active_model: activeVersion?.model || '',
              }}
              kit={[]}
              onClose={() => setCreateMode('version')}
              onCreated={(name, instruction) => {
                onToast(`Variant ${name} created.`)
                onVariantCreated?.(name, instruction)
                setCreateMode('version')
              }}
            />
          ) : (
            <>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
            <ModelPicker model={imgModel} onChange={setImgModel} disabled={generating} models={IMAGE_MODELS} primary={IMAGE_MODELS} />
            <select
              value={ratio}
              onChange={(e) => setRatio(e.target.value)}
              title="Canvas ratio for this generation"
              className="sc-select"
            >
              <option value="auto">ratio: {sessionRatio}</option>
              {['1:1', '16:9', '9:16', '4:3', '3:4'].filter((r) => r !== sessionRatio).map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
            {!isMaster && (
              <>
                <label className="vp-undo" style={{ display: 'inline-flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={sheetMode}
                    style={{ margin: 0, accentColor: 'var(--accent)' }}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSheetMode(true)
                        setImproveOpen(true)
                        // Sheets are wide (multiple angles side by side) —
                        // default the canvas to 16:9; still changeable above.
                        setRatio(sessionRatio === '16:9' ? 'auto' : '16:9')
                      } else {
                        setSheetMode(false)
                      }
                    }}
                  />
                  Generate as {/(character|cast)/i.test(kind) ? 'character' : 'object'} sheet
                </label>
                {/* The description lives NEXT TO the control it explains. */}
                <span style={{ fontSize: 11, color: 'var(--ink-3)', lineHeight: 1.4 }}>
                  {sheetMode
                    ? 'Improve writes 2 prompts: character (imported when referenced elsewhere) + sheet (what Generate uses).'
                    : 'multi-angle views of the same subject on a blank background'}
                </span>
              </>
            )}
          </div>
          {genError !== '' && (
            <div style={{ color: 'var(--red, #e5534b)', fontSize: 12.5, lineHeight: 1.5, marginBottom: 6 }}>
              ⚠ {genError}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
            <button type="button" className="vp-undo" onClick={() => setImproveOpen((v) => !v)}>
              ✎ Improve prompt with AI {improveOpen ? '▴' : '▾'}
            </button>
            <ModelPicker model={txtModel} onChange={setTxtModel} disabled={detailing} />
            <button
              type="button"
              className="vp-undo"
              title="Opens Improve with the saved instruction pre-filled — the AI rewrites the prompt to read like a casual phone snapshot instead of a clean AI render"
              onClick={openLessMode}
            >
              ◎ Reduce AI aesthetic
            </button>
            <button type="button" className="vp-undo" onClick={openAttach}>
              ⧉ Reference images{attached.length ? ` (${attached.length})` : ''} {attachOpen ? '▴' : '▾'}
            </button>
          </div>
          {improveOpen && (
            <div style={{ marginBottom: 6 }}>
              <textarea
                value={guidance}
                onChange={(e) => setGuidance(e.target.value)}
                rows={2}
                placeholder="Optional — tell the AI what to emphasize (e.g. “more specific about the wardrobe”, “moodier lighting”)…"
                style={{
                  width: '100%', boxSizing: 'border-box', resize: 'vertical', background: 'transparent',
                  color: 'var(--ink-2)', border: '1px solid var(--line, #2a3142)', borderRadius: 6,
                  padding: '7px 9px', fontSize: 12.5, lineHeight: 1.5, marginBottom: 6,
                }}
              />
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                {lessMode && (
                  <span style={{ fontSize: 11.5, color: 'var(--ink-3)', display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    save this instruction:
                    <button type="button" style={{ ...small, padding: '4px 8px', fontSize: 11.5 }} onClick={() => saveLess('session')}>
                      for this video
                    </button>
                    <button type="button" style={{ ...small, padding: '4px 8px', fontSize: 11.5 }} onClick={() => saveLess('global')}>
                      for all videos
                    </button>
                  </span>
                )}
              </div>
            </div>
          )}
          {attached.length > 0 && (
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 6 }}>
              {attached.map((path) => (
                <span key={path} style={{ position: 'relative', display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 3, maxWidth: 96 }}>
                  <img src={contentUrl(path)} alt="" style={{ height: 96, width: 'auto', borderRadius: 8, border: '1px solid var(--accent)', display: 'block' }} onLoad={equalArea(11000, 150)} />
                  <span style={{ fontSize: 10.5, color: 'var(--ink-3)', maxWidth: 96, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {itemForPath(path)?.ref ?? path.split('/').pop()}
                  </span>
                  <button
                    type="button"
                    title="Remove reference image"
                    onClick={() => applyAttached(attached.filter((x) => x !== path))}
                    style={{ position: 'absolute', top: -6, right: -6, width: 16, height: 16, lineHeight: '13px', padding: 0, borderRadius: 8, background: 'var(--bg-3)', border: '1px solid var(--line-2)', color: 'var(--ink-2)', fontSize: 10, cursor: 'pointer' }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          {attachOpen && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
              {attachPool === null ? (
                <span style={{ fontSize: 12, color: 'var(--ink-3)' }}><span className="spin" /> Loading…</span>
              ) : attachPool.length === 0 ? (
                <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>No other images in this session yet.</span>
              ) : (
                attachPool.filter((img) => !img.path.includes(`world-kit-refs/${refId}/`)).map((img) => (
                  <button
                    key={img.path}
                    type="button"
                    title={img.name}
                    onClick={() =>
                      applyAttached(
                        attached.includes(img.path)
                          ? attached.filter((x) => x !== img.path)
                          : attached.length < 4
                            ? [...attached, img.path]
                            : attached,
                      )
                    }
                    style={{
                      padding: 0, borderRadius: 8, overflow: 'hidden', cursor: 'pointer', background: 'none', position: 'relative',
                      border: attached.includes(img.path) ? '2px solid var(--accent)' : '1px solid var(--line, #2a3142)',
                    }}
                  >
                    <img src={contentUrl(img.path)} alt="" loading="lazy" style={{ height: 120, width: 'auto', display: 'block' }} onLoad={equalArea(20000)} />
                    <span style={{ position: 'absolute', left: 0, right: 0, bottom: 0, fontSize: 10.5, lineHeight: '16px', background: 'rgba(5,6,8,.78)', color: 'var(--ink-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', padding: '0 4px' }}>
                      {img.ref ?? img.name}
                    </span>
                  </button>
                ))
              )}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}>
            <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>or add your own:</span>
            <button type="button" className="vp-undo" onClick={() => fileRef.current?.click()}>↑ Upload</button>
            <button type="button" className="vp-undo" onClick={() => void openGallery()}>↦ Pick from session {galleryOpen ? '▴' : '▾'}</button>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void upload(f)
                e.target.value = ''
              }}
            />
          </div>
          {galleryOpen && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
              {pool === null ? (
                <span style={{ fontSize: 12, color: 'var(--ink-3)' }}><span className="spin" /> Loading session images…</span>
              ) : pool.length === 0 ? (
                <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>No images in this session yet — upload some in Video idea (source material).</span>
              ) : (
                pool.map((img) => (
                  <button
                    key={img.path}
                    type="button"
                    title={img.path}
                    onClick={() => mapImage(img.path)}
                    style={{ padding: 0, border: '1px solid var(--line, #2a3142)', borderRadius: 8, overflow: 'hidden', cursor: 'pointer', background: 'none' }}
                  >
                    <img src={contentUrl(img.path)} alt="" loading="lazy" style={{ height: 120, width: 'auto', display: 'block' }} onLoad={equalArea(20000)} />
                  </button>
                ))
              )}
            </div>
          )}
          {/* ONE primary action, bottom-right, like every other module. While
              the improve panel is open, improving IS the action; it closes on
              success and Generate returns. */}
          <div className="vp-edit-actions" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
            {improveOpen ? (
              <button type="button" className="vp-save" disabled={detailing} onClick={detailPrompt}>
                {detailing ? (<><span className="spin" /> Improving…</>) : '✦ Improve prompt'}
              </button>
            ) : (
              <button type="button" className="vp-save" disabled={generating} onClick={generate}>
                {generating ? (<><span className="spin" /> Generating…</>) : '✦ Generate'}
              </button>
            )}
          </div>
            </>
          )}
        </div>
      )}
          </div>
        )}
      </div>
      {/* LINKED AUDIO — a voice/music object that belongs to this item (a
          character's voice rides into every clip that references them). */}
      {!isAudio && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
          <button type="button" className="vp-undo" onClick={() => setAudioOpen((v) => !v)}>
            {audioOpen ? '▾' : '+'} Linked audio
          </button>
        </div>
      )}
      {audioOpen ? (
        <div style={{ border: '1px dashed var(--line, #2a3142)', borderRadius: 10, padding: 12, marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <label style={{ fontSize: 11, color: 'var(--ink-3)' }}>NAME
              <input
                value={aName}
                onChange={(e) => setAName(e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, '-'))}
                placeholder={`${refId}-voice`}
                style={{ display: 'block', background: 'transparent', color: 'var(--ink-2)', border: '1px solid var(--line, #2a3142)', borderRadius: 6, padding: '6px 8px', fontSize: 12, marginTop: 3 }}
              />
            </label>
            <label style={{ fontSize: 11, color: 'var(--ink-3)' }}>KIND
              <select
                value={aKind}
                onChange={(e) => setAKind(e.target.value)}
                className="sc-select"
                style={{ display: 'block', marginTop: 3 }}
              >
                <option value="voice">voice</option>
                <option value="music">music</option>
                <option value="ambience">ambience</option>
                <option value="sfx">sfx</option>
              </select>
            </label>
            <label style={{ fontSize: 11, color: 'var(--ink-3)', flex: 1, minWidth: 180 }}>AUDIO URL (optional)
              <input
                value={aUrl}
                onChange={(e) => setAUrl(e.target.value)}
                placeholder="https://…/sample.mp3"
                style={{ display: 'block', width: '100%', boxSizing: 'border-box', background: 'transparent', color: 'var(--ink-2)', border: '1px solid var(--line, #2a3142)', borderRadius: 6, padding: '6px 8px', fontSize: 12, marginTop: 3 }}
              />
            </label>
          </div>
          <label style={{ fontSize: 11, color: 'var(--ink-3)' }}>PROMPT — how it sounds
            <textarea
              rows={2}
              value={aNotes}
              onChange={(e) => setANotes(e.target.value)}
              placeholder="e.g. warm casual female voice, early 20s, relaxed pacing — same voice in every clip"
              style={{ display: 'block', width: '100%', boxSizing: 'border-box', resize: 'vertical', background: 'transparent', color: 'var(--ink-2)', border: '1px solid var(--line, #2a3142)', borderRadius: 6, padding: '8px 10px', fontSize: 13, marginTop: 3 }}
            />
          </label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button type="button" className="vp-save" disabled={aBusy || (!aNotes.trim() && !aUrl.trim())} onClick={() => void saveAudio()}>
              {aBusy ? 'Saving…' : 'Add audio object'}
            </button>
            <label className="vp-undo" style={{ cursor: 'pointer' }}>
              ↑ upload audio file
              <input
                type="file"
                accept="audio/mpeg,audio/wav,audio/mp4,.mp3,.wav,.m4a"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  e.target.value = ''
                  if (f) void saveAudio(f)
                }}
              />
            </label>
            <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>a prompt, a file, or a URL — any of the three works</span>
          </div>
        </div>
      ) : null}
    </div>
  )
}
