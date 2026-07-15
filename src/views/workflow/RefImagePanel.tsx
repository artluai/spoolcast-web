import { useEffect, useRef, useState } from 'react'
import { activeSession, apiUrl, contentUrl, getFileJson, getJson, postAction } from '../../lib/api'
import { DEFAULT_MODEL_ID, draftReasoning } from '../../lib/draft-models'
import { DEFAULT_IMAGE_MODEL_ID, IMAGE_MODELS } from '../../lib/image-models'
import { ModelPicker } from './ModelPicker'

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
  notesLabel = 'NOTES',
  kind = '',
  fields,
  kitIndex = {},
  onDescribed,
  onNotesChange,
  onNotesInput,
  onNotesFocus,
  onToast,
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
  // "Less AI" snippet: editable degradation text inserted into the prompt.
  // Edits save as THIS video's override; a button promotes it to the global
  // default. Resolution lives engine-side: session -> global -> built-in.
  const [lessOpen, setLessOpen] = useState(false)
  const [lessText, setLessText] = useState<string | null>(null)
  const [lessSource, setLessSource] = useState('')
  const savedLessRef = useRef<string | null>(null)
  const lastInsertedRef = useRef('')

  const openLess = () => {
    setLessOpen((v) => !v)
    if (lessText === null) {
      void postAction<{ text?: string; source?: string }>({ action: 'get_prompt_snippet', name: 'less-ai' }).then((out) => {
        if (out?.ok) {
          savedLessRef.current = out.data?.text ?? ''
          setLessText(out.data?.text ?? '')
          setLessSource(out.data?.source ?? '')
        }
      })
    }
  }
  useEffect(() => {
    if (lessText === null || lessText === savedLessRef.current) return
    const t = window.setTimeout(() => {
      savedLessRef.current = lessText
      setLessSource('session')
      void postAction({ action: 'set_prompt_snippet', name: 'less-ai', scope: 'session', text: lessText })
    }, 800)
    return () => window.clearTimeout(t)
  }, [lessText])

  const insertLess = () => {
    const text = (lessText ?? '').trim()
    if (!text) return
    let base = stripRefLines(notes)
    const prev = lastInsertedRef.current
    if (prev && base.includes(prev)) base = base.replace(prev, text).trim()
    else base = base ? `${base}\n${text}` : text
    const lines = existingRefLines(notes)
    onNotesChange?.(base + (lines ? `\n\n${lines}` : ''))
    lastInsertedRef.current = text
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
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refId])

  const versionUrl = (v: RefVersion) =>
    v.kind === 'mapped' ? contentUrl(v.path ?? '') : contentUrl(`source/world-kit-refs/${refId}/${v.file ?? ''}`)
  const versionRelPath = (v: RefVersion) =>
    v.kind === 'mapped' ? (v.path ?? '') : `source/world-kit-refs/${refId}/${v.file ?? ''}`

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
        'The prompt mentions reference images but none are attached — attach them under 🖇 Reference images, or delete those lines.',
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
              {manifest === null ? 'Loading…' : 'No image yet — create one below.'}
            </div>
          )}
          {versions.length > 1 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ ...clusterLabel, marginBottom: 5 }}>HISTORY — CLICK TO SWITCH</div>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                {versions.map((v) => (
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
                    <img src={versionUrl(v)} alt="" style={{ height: 72, width: 'auto', maxWidth: 128, display: 'block' }} />
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
              <div style={{ fontSize: 11, color: 'var(--ink-3)', display: 'flex', gap: 10, alignItems: 'center' }}>
                {charPrompt === null ? (
                  `${notesLabel} — PROMPT DESCRIPTION`
                ) : (
                  <>
                    {notesLabel} —
                    {(['prompt', 'character'] as const).map((v) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => setPromptView(v)}
                        title={v === 'prompt' ? 'What Generate uses to make this item’s image' : 'What other prompts import when they reference this image'}
                        style={{
                          background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                          fontSize: 11, letterSpacing: 'inherit', fontFamily: 'inherit',
                          color: promptView === v ? 'var(--ink-1)' : 'var(--ink-3)',
                          textDecoration: promptView === v ? 'underline' : 'none', textUnderlineOffset: 3,
                        }}
                      >
                        {v === 'prompt' ? 'GENERATION PROMPT' : 'CHARACTER PROMPT'}
                      </button>
                    ))}
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
            </div>
      {/* CREATE — collapsed by default; the whole point when no image exists */}
      {!createOpen && (
        <div style={{ marginTop: 4 }}>
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            style={{
              background: 'none', border: 'none', padding: 0, cursor: 'pointer',
              ...clusterLabel, display: 'inline-flex', gap: 6, alignItems: 'center',
            }}
          >
            <span style={{ fontSize: 10 }}>▸</span> CREATE A NEW VERSION
          </button>
        </div>
      )}
      {createOpen && (
        <div style={{ position: 'relative', marginTop: 8 }}>
          <button
            type="button"
            title="Collapse"
            onClick={() => setCreateOpen(false)}
            style={{ position: 'absolute', right: 8, top: 6, background: 'none', border: 'none', color: 'var(--ink-3)', cursor: 'pointer', fontSize: 12, padding: 2 }}
          >
            ▴
          </button>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
            <button type="button" className="core-create" style={{ marginLeft: 0 }} disabled={generating} onClick={generate}>
              {generating ? (<><span className="spin" /> Generating…</>) : '✦ Generate'}
            </button>
            <ModelPicker model={imgModel} onChange={setImgModel} disabled={generating} models={IMAGE_MODELS} primary={IMAGE_MODELS} />
            <select
              value={ratio}
              onChange={(e) => setRatio(e.target.value)}
              title="Canvas ratio for this generation"
              style={{ background: 'var(--bg-3)', color: 'var(--ink-2)', border: '1px solid var(--line-2)', borderRadius: 6, padding: '7px 8px', fontSize: 12, fontFamily: 'var(--mono)' }}
            >
              <option value="auto">ratio: {sessionRatio}</option>
              {['1:1', '16:9', '9:16', '4:3', '3:4'].filter((r) => r !== sessionRatio).map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
            {!isMaster && (
              <button
                type="button"
                style={small}
                title="Rewrite the prompt with AI into a multi-angle character sheet on a blank background"
                onClick={() => {
                  setSheetMode(true)
                  setImproveOpen(true)
                  // Sheets are wide (multiple angles side by side) — default the
                  // canvas to 16:9; still changeable in the ratio select.
                  setRatio(sessionRatio === '16:9' ? 'auto' : '16:9')
                }}
              >
                ⊞ Character sheet…
              </button>
            )}
            <span
              title="Prompt length vs. the selected model's limit"
              style={{
                fontSize: 10.5, fontFamily: 'var(--mono)',
                color: notes.trim().length > promptLimit ? 'var(--red, #e5534b)' : notes.trim().length > promptLimit * 0.8 ? 'var(--amber, #d29922)' : 'var(--ink-3)',
              }}
            >
              {notes.trim().length.toLocaleString()} / {promptLimit.toLocaleString()}
            </span>
          </div>
          {genError !== '' && (
            <div style={{ color: 'var(--red, #e5534b)', fontSize: 12.5, lineHeight: 1.5, marginBottom: 6 }}>
              ⚠ {genError}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
            <button type="button" style={small} onClick={() => setImproveOpen((v) => !v)}>
              ✎ Improve prompt with AI {improveOpen ? '▴' : '▾'}
            </button>
            <button type="button" style={small} onClick={openAttach}>
              🖇 Reference images{attached.length ? ` (${attached.length})` : ''} {attachOpen ? '▴' : '▾'}
            </button>
            <button
              type="button"
              style={small}
              title="Editable snippet that makes the result look like a casual phone photo instead of a clean AI render"
              onClick={openLess}
            >
              📷 Less AI {lessOpen ? '▴' : '▾'}
            </button>
          </div>
          {improveOpen && (
            <div style={{ marginBottom: 6 }}>
              {dualImprove && (
                <div style={{ fontSize: 11.5, color: 'var(--ink-3)', marginBottom: 6 }}>
                  Makes 2 prompts: <b>character</b> (imported when this item is referenced elsewhere) and{' '}
                  <b>sheet</b> (what Generate uses for the sheet image). Toggle between them above the text box.
                </div>
              )}
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
                <button type="button" style={small} disabled={detailing} onClick={detailPrompt}>
                  {detailing ? (<><span className="spin" /> Improving…</>) : '✎ Improve'}
                </button>
                <ModelPicker model={txtModel} onChange={setTxtModel} disabled={detailing} />
              </div>
            </div>
          )}
          {lessOpen && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 11.5, color: 'var(--ink-3)', marginBottom: 6 }}>
                Added to the prompt as plain text — edit it there like anything else. Edits here save for{' '}
                <b>this video</b>{lessSource === 'global' ? ' (currently using your saved default)' : lessSource === 'default' ? ' (currently using the built-in text)' : ''}.
              </div>
              <textarea
                value={lessText ?? ''}
                onChange={(e) => setLessText(e.target.value)}
                rows={3}
                placeholder={lessText === null ? 'Loading…' : ''}
                style={{
                  width: '100%', boxSizing: 'border-box', resize: 'vertical', background: 'transparent',
                  color: 'var(--ink-2)', border: '1px solid var(--line, #2a3142)', borderRadius: 6,
                  padding: '7px 9px', fontSize: 12.5, lineHeight: 1.5, marginBottom: 6,
                }}
              />
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <button type="button" style={small} disabled={!lessText?.trim()} onClick={insertLess}>
                  ＋ Add to prompt
                </button>
                <button
                  type="button"
                  style={small}
                  disabled={!lessText?.trim()}
                  onClick={() => {
                    void postAction({ action: 'set_prompt_snippet', name: 'less-ai', scope: 'global', text: (lessText ?? '').trim() })
                    onToast('Saved as the default for all videos.')
                  }}
                >
                  Save as default for all videos
                </button>
              </div>
            </div>
          )}
          {attached.length > 0 && (
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 6 }}>
              {attached.map((path) => (
                <span key={path} style={{ position: 'relative', display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 3, maxWidth: 96 }}>
                  <img src={contentUrl(path)} alt="" style={{ width: 96, height: 96, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--accent)', display: 'block' }} />
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
                    <img src={contentUrl(img.path)} alt="" style={{ width: 120, height: 120, objectFit: 'cover', display: 'block' }} />
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
            <button type="button" style={small} onClick={() => fileRef.current?.click()}>↑ Upload</button>
            <button type="button" style={small} onClick={() => void openGallery()}>↦ Pick from session {galleryOpen ? '▴' : '▾'}</button>
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
                    <img src={contentUrl(img.path)} alt="" style={{ width: 120, height: 120, objectFit: 'cover', display: 'block' }} />
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      )}
          </div>
        )}
      </div>
    </div>
  )
}
