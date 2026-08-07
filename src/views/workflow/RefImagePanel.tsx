import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { activeSession, apiUrl, contentUrl, getFileJson, getJson, globalContentUrl, postAction, statusUrl } from '../../lib/api'
import { DEFAULT_MODEL_ID, DEFAULT_VISION_MODEL_ID, VISION_MODELS, draftReasoning } from '../../lib/draft-models'
import { DEFAULT_IMAGE_MODEL_ID, IMAGE_MODELS } from '../../lib/image-models'
import { ModelPicker } from './ModelPicker'
import { VariantModule } from './VariantModule'

// WORLD KIT CASTING PANEL — one kit item's reference image. Two labeled paths:
//   GENERATE (from the item's notes; options: model, canvas ratio, character
//   sheet, image ingredients) — or USE AN EXISTING IMAGE (upload / pick from
//   the session). Every result is a kept version; the filmstrip is
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
  aspect_ratio?: string
  ref_images?: string[]
  at?: string
}
type RefManifest = {
  versions: RefVersion[]
  active: string | null
  stale?: {
    changed_refs?: string[]
    artifacts_preserved?: boolean
  }
}
type PoolImage = { path: string; name: string; size?: number; ref?: string; mtime?: number }
type AssetLibraryGroup = {
  id: string
  takes: { path: string; kind: 'image' | 'video' | 'audio'; active: boolean; stamp: string; mtime?: number }[]
}

const KIND_BADGE: Record<RefVersion['kind'], string> = {
  generated: '✦ gen',
  uploaded: '↑ upload',
  mapped: '↦ mapped',
}

// Character-sheet and aesthetic prompt preparation happen only after Generate
// is clicked. They are output settings, not extra prompt editors.
const CHARACTER_SHEET_LAYOUT =
  'a character reference sheet with full-body front, side/profile, rear, and three-quarter views plus one chest-up talking-head portrait; identical face, hair, body proportions, and wardrobe in every view; clean blank studio background; no scene'
const OBJECT_SHEET_LAYOUT =
  'an object reference sheet with front, side, rear, three-quarter, and close-up detail views of the same object; identical materials, colors, and proportions in every view; clean blank studio background; no scene'
const REF_LINE_RE = /^Reference image \d+.*$/gm

const stripRefLines = (t: string) => t.replace(REF_LINE_RE, '').replace(/\n{3,}/g, '\n\n').trim()
const looksLikeSheetPrompt = (text: string) =>
  /(character|object) (reference )?sheet|multi(?:ple)?[- ]angle|front.{0,40}(side|profile)|three-quarter view/i.test(text)
const looksLikeCompleteCharacterSheetPrompt = (text: string) =>
  looksLikeSheetPrompt(text) && /(talking[- ]head|chest[- ]up|head[- ]and[- ]shoulders|close-up portrait)/i.test(text)

const OUTPUT_RATIOS = [
  { value: '1:1', label: 'Square', width: 16, height: 16 },
  { value: '16:9', label: 'Widescreen', width: 22, height: 12 },
  { value: '9:16', label: 'Portrait', width: 11, height: 19 },
  { value: '4:3', label: 'Landscape', width: 20, height: 15 },
  { value: '3:4', label: 'Portrait', width: 12, height: 16 },
] as const

const ratioMeta = (value: string) =>
  OUTPUT_RATIOS.find((choice) => choice.value === value) ?? OUTPUT_RATIOS[1]

function RatioGlyph({ value }: { value: string }) {
  const meta = ratioMeta(value)
  return (
    <i
      className="ratio-glyph"
      aria-hidden="true"
      style={{ width: meta.width, height: meta.height }}
    />
  )
}

function RatioPicker({
  value,
  sessionRatio,
  onChange,
  disabled = false,
}: {
  value: string
  sessionRatio: string
  onChange: (value: string) => void
  disabled?: boolean
}) {
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const [menuPos, setMenuPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null)

  const toggle = () => {
    if (menuPos) {
      setMenuPos(null)
      return
    }
    const rect = buttonRef.current?.getBoundingClientRect()
    if (!rect) return
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight
    const left = Math.max(8, rect.right - 160)
    setMenuPos(
      viewportHeight && rect.bottom + 250 > viewportHeight
        ? { left, bottom: viewportHeight - rect.top + 4 }
        : { left, top: rect.bottom + 4 },
    )
  }

  const choices = [
    { value: 'auto', label: `Video default · ${sessionRatio}`, description: ratioMeta(sessionRatio).label },
    ...OUTPUT_RATIOS.map((choice) => ({
      value: choice.value,
      label: choice.value,
      description: choice.label,
    })),
  ]
  return (
    <span>
      <button
        ref={buttonRef}
        type="button"
        className="vp-menu-btn"
        disabled={disabled}
        title="Output ratio for this generation"
        onClick={toggle}
      >
        Ratio · {value === 'auto' ? sessionRatio : value} ▾
      </button>
      {menuPos
        ? createPortal(
            <>
              <span className="vp-menu-backdrop" onClick={() => setMenuPos(null)} />
              <span className="vp-menu" style={{ ...menuPos, minWidth: 160 }}>
                <span className="vp-menu-h">OUTPUT RATIO</span>
                {choices.map((choice) => (
                  <button
                    key={choice.value}
                    type="button"
                    onClick={() => {
                      onChange(choice.value)
                      setMenuPos(null)
                    }}
                    style={value === choice.value ? { background: 'var(--bg-3)' } : undefined}
                  >
                    <span className="ratio-menu-choice">
                      <RatioGlyph value={choice.value === 'auto' ? sessionRatio : choice.value} />
                      <span>
                        <span>{choice.label}</span>
                        <small>{choice.description}</small>
                      </span>
                    </span>
                  </button>
                ))}
              </span>
            </>,
            document.body,
          )
        : null}
    </span>
  )
}

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
  linkedAudio,
  audioOptions,
  onAudioLink,
  onAudioUnlink,
  linkedTo = '',
  onLinkedToChange,
  onApprove,
  readOnly = false,
  readOnlyImage = '',
  readOnlyPath = '',
}: {
  refId: string
  notes: string
  // A GLOBAL library item: shared by every project, editable by nobody. Its
  // image cannot be replaced, so "save as a new variant" is forced on and
  // locked rather than letting the user hit a 403 after writing a prompt.
  readOnly?: boolean
  // Ready-to-use URL for a global item's sheet. It lives outside the session,
  // so there is no ref manifest to resolve it from.
  readOnlyImage?: string
  // The same sheet as a CONTENT-ROOT path — what gets sent to the engine as
  // the variant's base reference (URLs are for display only).
  readOnlyPath?: string
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
  onVariantCreated?: (name: string, generationPrompt: string) => void
  onAudioAdd?: (audio: { name: string; kind: string; linkedTo: string; source: string; notes: string }) => void
  // Non-audio items: audio objects already pointing at this item (chips with
  // unlink) and the ones that could (LINK EXISTING inside the + panel). The
  // host editor owns the kit doc, so link/unlink go back to it by row key.
  linkedAudio?: { key: number; name: string; kind: string; notes?: string }[]
  audioOptions?: { key: number; name: string; kind: string; notes?: string }[]
  onAudioLink?: (key: number) => void
  onAudioUnlink?: (key: number) => void
  // Audio objects: the kit item this sound belongs to (Linked to column).
  linkedTo?: string
  onLinkedToChange?: (name: string) => void
  // Audio items: the bottom-right slot shows Approve until a link exists.
  onApprove?: () => void
}) {
  const [manifest, setManifest] = useState<RefManifest | null>(null)
  const [imgModel, setImgModel] = useState(DEFAULT_IMAGE_MODEL_ID)
  const txtModel = DEFAULT_MODEL_ID
  // Vision tasks (reading the linked image) — GLM has no eyes; Qwen default.
  const [visionModel, setVisionModel] = useState(DEFAULT_VISION_MODEL_ID)
  const [generating, setGenerating] = useState(false)
  const [describing, setDescribing] = useState(false)
  const [galleryOpen, setGalleryOpen] = useState(false)
  const [referencesOpen, setReferencesOpen] = useState(false)
  const [lightboxUrl, setLightboxUrl] = useState('')
  const [galleryTab, setGalleryTab] = useState<'world-kit' | 'recent'>('world-kit')
  const [pool, setPool] = useState<PoolImage[] | null>(null)
  const [recentPool, setRecentPool] = useState<PoolImage[] | null>(null)
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
  useEffect(() => {
    if (!lightboxUrl) return
    const closeLightbox = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setLightboxUrl('')
    }
    window.addEventListener('keydown', closeLightbox)
    return () => window.removeEventListener('keydown', closeLightbox)
  }, [lightboxUrl])
  const [dims, setDims] = useState('')
  const [previewWidth, setPreviewWidth] = useState(420)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const promptBoxRef = useRef<HTMLTextAreaElement | null>(null)
  const timerRef = useRef<number | null>(null)

  const [createOpen, setCreateOpen] = useState(false)
  // Opening the generate panel means you are about to WORK on the prompt, so
  // grow the box to its full text — the ref callback only fires on mount, and
  // a long description otherwise sits behind a scrollbar exactly when it
  // matters most.
  // Size the prompt box to its text. Clearing the inline height FIRST is what
  // makes it shrink as well as grow — measuring scrollHeight while a tall
  // height is still applied just returns that height and compounds it.
  const fitPromptBox = (el: HTMLTextAreaElement | null) => {
    if (!el) return
    // The panel can be measured while its column is still collapsed (the kit
    // wall lays out horizontally). At ~0 width the text wraps one character
    // per line and scrollHeight reports thousands of px — leave the height
    // alone until there is a real width to measure against.
    if (el.clientWidth < 80) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight + 4, 600)}px`
  }
  // Re-fit on open AND whenever the item or its text changes: React reuses the
  // textarea node between items, so a height set for a long prompt otherwise
  // survives onto a short one as a wall of empty box.
  useEffect(() => {
    // Two passes: now, and after layout settles — on the first render inside
    // the kit wall the column can still be 0-wide, which makes the measurement
    // meaningless (see fitPromptBox).
    fitPromptBox(promptBoxRef.current)
    const t = window.setTimeout(() => fitPromptBox(promptBoxRef.current), 80)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createOpen, refId, notes])
  // The two generation toggles live in one menu — see "⚙ Options".
  const [optionsOpen, setOptionsOpen] = useState(false)
  const optionsButtonRef = useRef<HTMLButtonElement | null>(null)
  const [optionsPosition, setOptionsPosition] = useState<{
    left: number
    top?: number
    bottom?: number
    maxHeight: number
  } | null>(null)
  // Last generation failure, shown in the panel until the next attempt.
  const [genError, setGenError] = useState('')
  // "Reduce AI aesthetic" is also an output setting. Its saved engine snippet
  // is folded into the prompt internally when Generate is clicked.
  const [lessMode, setLessMode] = useState(false)
  const lessTextRef = useRef<string | null>(null)
  const fetchLess = async (): Promise<string> => {
    if (lessTextRef.current !== null) return lessTextRef.current
    const out = await postAction<{ text?: string }>({ action: 'get_prompt_snippet', name: 'less-ai' })
    lessTextRef.current = out?.ok ? (out.data?.text ?? '').trim() : ''
    return lessTextRef.current
  }
  // Dual-prompt state: charPrompt = the character prompt (imported when this
  // item is referenced elsewhere); notes stay the generation prompt.
  const [charPrompt, setCharPrompt] = useState<string | null>(null)
  const [promptView, setPromptView] = useState<'prompt' | 'character'>('prompt')
  const [sheetMode, setSheetMode] = useState(false)
  // Shown on the ⚙ Options button so an active toggle stays visible while the
  // menu is shut — a hidden checkbox that changes the output must not be silent.
  const optionCount = (sheetMode ? 1 : 0) + (lessMode ? 1 : 0)

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

  // Older variants stored only the short "what changed" instruction in the
  // World Kit row even though the image manifest correctly kept the complete
  // prompt sent to the model. Repair only that recognizable mismatch; a
  // genuinely hand-edited prompt remains untouched.
  const syncShortInstructionToVersion = (v: RefVersion | undefined) => {
    const savedPrompt = v?.kind === 'generated' ? (v.prompt ?? '').trim() : ''
    const visiblePrompt = notes.trim()
    if (
      savedPrompt
      && savedPrompt !== visiblePrompt
      && (
        visiblePrompt === ''
        || (
          visiblePrompt.length < savedPrompt.length
          && savedPrompt.toLowerCase().includes(visiblePrompt.toLowerCase())
        )
      )
    ) {
      onNotesChange?.(savedPrompt)
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
    setGenError('')
    setGalleryOpen(false)
    setReferencesOpen(false)
    setLightboxUrl('')
    setOptionsOpen(false)
    setOptionsPosition(null)
    setDims('')
    setPreviewWidth(420)
    setCharPrompt(null)
    setPromptView('prompt')
    setSheetMode(false)
    setLessMode(false)
    // no image yet -> the create section is the whole point, start it open
    loadManifest().then((m) => {
      setCreateOpen(m.versions.length === 0)
      const act = m.versions.find((v) => v.id === m.active)
      setRatio(act?.aspect_ratio || 'auto')
      savedSubjectRef.current = act?.subject ?? null
      if (act?.subject) setCharPrompt(act.subject)
      // Notes follow the SELECTED image — but only when they are plainly a
      // stale version prompt (empty, or identical to another version's stored
      // prompt). Hand-edited text is never overwritten on open.
      const noteText = notes.trim()
      const stale =
        noteText === '' || m.versions.some((v) => v.id !== m.active && (v.prompt ?? '').trim() === noteText)
      if (stale) {
        syncNotesToVersion(m.versions.find((v) => v.id === m.active))
      } else {
        syncShortInstructionToVersion(m.versions.find((v) => v.id === m.active))
      }
    })
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
  const referenceUrl = (path: string) =>
    /^(source|working|output)\//.test(path) ? contentUrl(path) : globalContentUrl(path)
  const activeVersion = manifest?.versions.find((v) => v.id === manifest?.active) ?? null

  // VARIANT + LINKED AUDIO state (the buttons at the panel's foot).
  const [createMode, setCreateMode] = useState<'version' | 'variant'>('version')
  const [audioOpen, setAudioOpen] = useState(false)
  const [aName, setAName] = useState('')
  const [aKind, setAKind] = useState('voice')
  const [aNotes, setANotes] = useState('')
  const [aUrl, setAUrl] = useState('')
  const [aBusy, setABusy] = useState(false)
  // LINK BY PICTURE: pick the kit item this sound belongs to from a grid of
  // its images instead of typing the name. "Whole family" stores the BASE
  // name — the engine already makes variants inherit their base's voice, so
  // one link covers the base and every variant (child/parent alike).
  type KitLite = { name: string; kind: string; image_path: string; variant_of?: string }
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkPool, setLinkPool] = useState<KitLite[] | null>(null)
  const [linkFamily, setLinkFamily] = useState(true)
  const openLinkPicker = async () => {
    setLinkOpen((v) => !v)
    if (linkPool === null) {
      const out = await getJson<{ ok?: boolean; data?: { kit?: KitLite[] } }>(
        apiUrl('source-images', { session: activeSession(), include_refs: 1 }),
      )
      setLinkPool((out?.data?.kit ?? []).filter((k) => k.image_path))
    }
  }
  const familyRoot = (k: KitLite) => (k.variant_of || k.name)
  const pickLink = (k: KitLite) => {
    const target = linkFamily ? familyRoot(k) : k.name
    onLinkedToChange?.(target)
    setLinkOpen(false)
    const hasFamily = !!k.variant_of || (linkPool ?? []).some((x) => x.variant_of === k.name)
    onToast(
      linkFamily && hasFamily
        ? `Linked to ${target} — its variants inherit this voice.`
        : `Linked to ${target}.`,
    )
  }

  // THE EAR: derive the voice from the LINKED OBJECT — its image when it has
  // one, its prompt text otherwise. Either way AI writes the voice that
  // subject would have.
  const generateVoiceFromLinked = async () => {
    if (!linkedTo) return
    setDescribing(true)
    try {
      const out = await getJson<{ ok?: boolean; data?: { images?: PoolImage[] } }>(
        apiUrl('source-images', { session: activeSession(), include_refs: 1 }),
      )
      const hit = (out?.data?.images ?? []).find((img) => img.ref === linkedTo)
      let res: { ok?: boolean; error?: string; message?: string; data?: { text?: string } } | null
      if (hit) {
        res = await postAction<{ text?: string }>({ action: 'describe_ref_image', path: hit.path, voice: true, model: visionModel, allow_cost: true })
      } else {
        // No image on the linked object — derive the voice from its PROMPT.
        const linkedNotes = (kitIndex[linkedTo]?.notes || '').trim()
        if (!linkedNotes) {
          onToast(`"${linkedTo}" has no image or description yet — add one there first.`)
          return
        }
        res = await postAction<{ text?: string }>({
          action: 'edit_snippet',
          text: linkedNotes,
          instruction:
            'Write a one-sentence VOICE description for AI video generation matching this subject: age range, gender if evident, tone, pacing, energy, texture — worded so a generator produces the same voice in every clip. Output only the sentence.',
          model: visionModel,
          allow_cost: true,
        })
      }
      if (res?.ok && res.data?.text) {
        onDescribed(res.data.text)
        onToast(`Voice written from ${linkedTo}'s ${hit ? 'image' : 'description'} — edit it like any prompt.`)
      } else {
        onToast(`Engine: ${res?.error || res?.message || 'could not write the voice.'}`)
      }
    } finally {
      setDescribing(false)
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

  const versions = manifest?.versions ?? []
  const active = versions.find((v) => v.id === manifest?.active) ?? null

  const pollJob = (jobId: string) => {
    const tick = async () => {
      const state = await getFileJson<{ state?: string; error?: string }>(`working/jobs/${jobId}.json`)
      if (state?.state === 'succeeded') {
        setGenerating(false)
        setReferencesOpen(false)
        const nextManifest = await loadManifest()
        syncNotesToVersion(nextManifest.versions.find((v) => v.id === nextManifest.active))
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

  // The selected image gets a larger, equal-area canvas: a landscape and a
  // portrait occupy roughly the same amount of screen instead of both being
  // forced to 420px wide (which made portrait images tower over the editor).
  const fitSelectedPreview = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const image = e.currentTarget
    const naturalWidth = image.naturalWidth || 1
    const naturalHeight = image.naturalHeight || 1
    const imageRatio = naturalWidth / naturalHeight
    const targetArea = 420 * 236
    const maxSide = 420
    let width = Math.sqrt(targetArea * imageRatio)
    let height = targetArea / width
    const scale = Math.min(1, maxSide / Math.max(width, height))
    width *= scale
    height *= scale
    image.style.width = `${Math.round(width)}px`
    image.style.height = `${Math.round(height)}px`
    setPreviewWidth(Math.round(width))
    setDims(`${naturalWidth}×${naturalHeight}`)
  }

  const promptLimit = IMAGE_MODELS.find((m) => m.id === imgModel)?.maxChars ?? 20000

  const expand = (text: string, extraGuidance: string) =>
    postAction<{ text?: string }>({
      action: 'expand_ref_prompt',
      text,
      ...(extraGuidance.trim() ? { guidance: extraGuidance.trim() } : {}),
      model: txtModel,
      ...(draftReasoning(txtModel) ? { reasoning: draftReasoning(txtModel) } : {}),
      allow_cost: true,
    })

  const prepareGenerationPrompt = async (basePrompt: string) => {
    const cleanPrompt = stripRefLines(basePrompt)
    const guidance: string[] = []
    const characterSheet = /(character|cast)/i.test(kind)
    const completeSheetPrompt = characterSheet
      ? looksLikeCompleteCharacterSheetPrompt(cleanPrompt)
      : looksLikeSheetPrompt(cleanPrompt)
    const sheetLayout = characterSheet ? CHARACTER_SHEET_LAYOUT : OBJECT_SHEET_LAYOUT
    if (sheetMode && !completeSheetPrompt) {
      guidance.push(
        `Rewrite the prompt so the finished image is ${sheetLayout}. ` +
        'Change only the layout: preserve every stated subject, wardrobe, material, color, and style detail exactly; do not invent or infer missing details.',
      )
    }
    if (lessMode) {
      const less = await fetchLess()
      if (less) guidance.push(less)
    }
    if (!cleanPrompt || !guidance.length) return cleanPrompt
    const out = await expand(cleanPrompt, guidance.join('\n\n'))
    if (!out?.ok || !out.data?.text) {
      throw new Error(out?.error || out?.message || 'Could not prepare the generation prompt.')
    }
    return out.data.text.trim()
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

  const openGallery = async () => {
    if (galleryOpen) {
      setGalleryOpen(false)
      return
    }
    setGalleryOpen(true)
    setGalleryTab('world-kit')
    if (pool === null) {
      const out = await getJson<{ ok?: boolean; data?: { images?: PoolImage[] } }>(
        apiUrl('source-images', { session: activeSession(), include_refs: 1 }),
      )
      const byRef = new Map<string, PoolImage>()
      for (const image of out?.data?.images ?? []) {
        if (image.ref && image.ref !== refId) {
          byRef.set(image.ref, { ...image, name: image.ref })
        }
      }
      setPool([...byRef.values()])
    }
    if (recentPool === null) {
      const out = await getJson<{ ok?: boolean; data?: { library?: AssetLibraryGroup[] } }>(
        apiUrl('asset-library', { session: activeSession() }),
      )
      const recent = (out?.data?.library ?? [])
        .flatMap((group) =>
          group.takes
            .filter((take) => take.kind === 'image')
            .map((take) => ({
              path: take.path,
              name: take.active ? `${group.id} · current` : `${group.id} · ${take.stamp}`,
              mtime: take.mtime,
            })),
        )
        .sort((a, b) => Number(b.mtime || 0) - Number(a.mtime || 0))
      setRecentPool(recent)
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
    setReferencesOpen(false)
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
    setRatio(v.aspect_ratio || 'auto')
    setPromptView('prompt')
  }

  const clusterLabel: React.CSSProperties = {
    fontSize: 10, letterSpacing: '.1em', color: 'var(--ink-3)', fontFamily: 'var(--mono)',
  }

  const toggleOptions = () => {
    if (optionsOpen) {
      setOptionsOpen(false)
      setOptionsPosition(null)
      return
    }
    const rect = optionsButtonRef.current?.getBoundingClientRect()
    if (!rect) return
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight
    const menuWidth = 340
    const left = Math.max(8, Math.min(rect.left, viewportWidth - menuWidth - 8))
    const roomAbove = Math.max(0, rect.top - 12)
    const roomBelow = Math.max(0, viewportHeight - rect.bottom - 12)
    const openUp = roomAbove >= roomBelow
    setOptionsPosition({
      left,
      ...(openUp
        ? { bottom: viewportHeight - rect.top + 6 }
        : { top: rect.bottom + 6 }),
      maxHeight: Math.max(180, (openUp ? roomAbove : roomBelow) - 6),
    })
    setOptionsOpen(true)
  }

  // EVERY secondary generation control lives behind one menu, so the panel
  // shows a prompt, a checkbox and a button — the rest is one click away.
  // Shared by both modes (update and variant) so the two read identically.
  const optionsMenu = (
    <span className="vg-select-wrap" style={{ position: 'relative' }}>
      <button
        ref={optionsButtonRef}
        type="button"
        className="vp-menu-btn vg-select-btn"
        onClick={toggleOptions}
      >
        ⚙ Options{optionCount ? ` · ${optionCount}` : ''} ▾
      </button>
      {optionsOpen && optionsPosition
        ? createPortal(
          <>
          <span
            className="vp-menu-backdrop"
            onClick={() => {
              setOptionsOpen(false)
              setOptionsPosition(null)
            }}
          />
          <span
            className="vp-menu ref-options-menu"
            style={{
              ...optionsPosition,
              width: 340,
              maxWidth: 'calc(100vw - 16px)',
              overflowY: 'auto',
            }}
          >
            <span className="vp-menu-h">GENERATE</span>
            <span style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '2px 9px 8px', flexWrap: 'wrap' }}>
              <ModelPicker model={imgModel} onChange={setImgModel} disabled={generating} models={IMAGE_MODELS} primary={IMAGE_MODELS} />
              <RatioPicker
                value={ratio}
                sessionRatio={sessionRatio}
                onChange={setRatio}
                disabled={generating}
              />
            </span>
            {!isMaster && (
              <>
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={sheetMode}
                  className={sheetMode ? 'on' : ''}
                  onClick={() => {
                    if (!sheetMode) {
                      setSheetMode(true)
                      setRatio(sessionRatio === '16:9' ? 'auto' : '16:9')
                    } else {
                      setSheetMode(false)
                    }
                  }}
                >
                  <span className="vg-select-choice">
                    <i className={`vg-menu-check ${sheetMode ? 'on' : ''}`} />
                    Generate as {/(character|cast)/i.test(kind) ? 'character' : 'object'} sheet
                  </span>
                  <small>
                    {/(character|cast)/i.test(kind)
                      ? 'full-body angles + a chest-up talking-head portrait'
                      : 'multiple angles + a close-up detail view'}
                  </small>
                </button>
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={lessMode}
                  className={lessMode ? 'on' : ''}
                  onClick={() => setLessMode((value) => !value)}
                >
                  <span className="vg-select-choice">
                    <i className={`vg-menu-check ${lessMode ? 'on' : ''}`} />
                    Reduce AI aesthetic
                  </span>
                  <small>makes the result feel like a casual phone snapshot</small>
                </button>
              </>
            )}
            <span className="vp-menu-h">REPLACE EXISTING IMAGE · NO AI</span>
            {/* Setting the item's OWN picture — not a reference for the next
                generation. Rare, so it lives in the menu rather than a row. */}
            <button
              type="button"
              onClick={() => {
                setOptionsOpen(false)
                fileRef.current?.click()
              }}
            >
              <span className="vg-select-choice">↑ Upload from computer</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setOptionsOpen(false)
                void openGallery()
              }}
            >
              <span className="vg-select-choice">↦ Choose from project</span>
            </button>
            {active && active.kind !== 'generated' ? <span className="vp-menu-h">PROMPT TOOL · AI</span> : null}
            {active && active.kind !== 'generated' ? (
              <button
                type="button"
                disabled={describing}
                onClick={() => {
                  setOptionsOpen(false)
                  void describe()
                }}
              >
                <span className="vg-select-choice">
                  {describing ? (<><span className="spin" /> Reading the image…</>) : '✦ Describe current image'}
                </span>
                <small>fills the Image prompt above</small>
              </button>
            ) : null}
          </span>
          </>,
          document.body,
        )
        : null}
    </span>
  )

  // Suggested variant name: <ref>-v2, then -v3… skipping any that already
  // exist. Prefilled as the placeholder so leaving the box alone gives the
  // name you were shown; click to write your own.
  const suggestedVariantName = (() => {
    const base = refId.replace(/-v\d+$/, '')
    const taken = new Set(Object.keys(kitIndex).map((k) => k.toLowerCase()))
    let n = 2
    while (taken.has(`${base}-v${n}`.toLowerCase()) && n < 99) n += 1
    return `${base}-v${n}`
  })()

  // Locked on for a global library item — its image belongs to every project,
  // so the only legal outcome is a copy of your own. Saying so HERE beats a
  // 403 after the user has already written a prompt.
  const variantToggle = (
    <label
      className="vp-varflag"
      style={{ cursor: readOnly ? 'default' : 'pointer', opacity: readOnly ? 0.75 : 1 }}
      title={readOnly
        ? 'Library characters are shared and read-only — your changes are saved as your own variant'
        : 'Save the result as a NEW kit item instead of replacing this one'}
    >
      <input
        type="checkbox"
        // DERIVED, not just set on open: a read-only item is always a variant,
        // whatever createMode holds (an inner close can reset it).
        checked={readOnly || createMode === 'variant'}
        disabled={readOnly}
        style={{ margin: 0, accentColor: 'var(--accent)' }}
        onChange={(e) => setCreateMode(e.target.checked ? 'variant' : 'version')}
      />
      Save as a new variant
    </label>
  )

  return (
    <div style={{ borderTop: fields ? undefined : '1px dashed var(--line, #2a3142)', marginTop: fields ? 0 : 10, paddingTop: fields ? 0 : 12 }}>
      {/* IMAGE LEFT · FIELDS RIGHT — audio has no image, so no image column */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {!(isAudio && !active) && (
          <div className="ref-selected-column" style={{ width: previewWidth }}>
          {/* A global item has no session manifest — its sheet comes in ready
              as a URL. Shown without the version controls below: there are no
              versions to pick, and nothing here can be edited. */}
          {!active && readOnlyImage ? (
            <>
              <div className="ref-selected-frame">
                <img
                  src={readOnlyImage}
                  alt={refId}
                  onLoad={fitSelectedPreview}
                  style={{ borderColor: 'var(--line, #2a3142)' }}
                />
                <button
                  type="button"
                  className="vg-enlarge"
                  aria-label={`Enlarge ${refId}`}
                  onClick={() => setLightboxUrl(readOnlyImage)}
                >
                  ⤢
                </button>
              </div>
              <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 4 }}>
                from the library{dims ? ` · ${dims}` : ''}
              </div>
            </>
          ) : active ? (
            <>
              <div className="ref-selected-frame">
                <img
                  src={versionUrl(active)}
                  alt={`${refId} selected image`}
                  onLoad={fitSelectedPreview}
                  style={{ borderColor: 'var(--accent)' }}
                />
                <button
                  type="button"
                  className="vg-enlarge"
                  aria-label={`Enlarge ${refId}`}
                  onClick={() => setLightboxUrl(versionUrl(active))}
                >
                  ⤢
                </button>
              </div>
              <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 4 }}>
                {KIND_BADGE[active.kind]}{dims ? ` · ${dims}` : ''}
              </div>
              {manifest?.stale ? (
                <div
                  aria-live="polite"
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 8,
                    marginTop: 8,
                    color: 'var(--ink-2)',
                    fontSize: 12,
                    lineHeight: 1.4,
                  }}
                >
                  <span className="status-pill work">Needs update</span>
                  <span>
                    Its source {manifest.stale.changed_refs?.length === 1 ? 'item changed' : 'items changed'}.
                    The existing image is preserved; generate a new take when ready.
                  </span>
                </div>
              ) : null}
              {(active.ref_images?.length ?? 0) > 0 ? (
                <div className="ref-source-panel">
                  <button
                    type="button"
                    className="ref-source-toggle"
                    aria-expanded={referencesOpen}
                    onClick={() => setReferencesOpen((value) => !value)}
                  >
                    <span>{referencesOpen ? '▾' : '▸'} References</span>
                    <span>· {active.ref_images?.length}</span>
                  </button>
                  {referencesOpen ? (
                    <div className="ref-source-grid">
                      {active.ref_images?.map((path, index) => (
                        <img
                          key={`${path}:${index}`}
                          src={referenceUrl(path)}
                          alt={`Reference ${index + 1} used for ${refId}`}
                          title={path}
                          loading="lazy"
                        />
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {/* "Describe with AI" now lives in ⚙ Options as "Write the
                  prompt from this image" — it fills the prompt box, so it
                  belongs with the other generation controls, not floating
                  under the thumbnail. */}
            </>
          ) : (
            <div
              style={{
                width: 420, maxWidth: '100%', height: 236, borderRadius: 10, border: '1px dashed var(--line, #2a3142)',
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
        )}
        {fields && (
          <div className="ref-selected-fields" style={{ flex: '1 1 280px', display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
            {fields}
            <div>
              <div style={{ fontSize: 11, color: 'var(--ink-3)', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                {charPrompt === null ? (
                  isAudio ? 'SOUND DESCRIPTION — how it sounds; rides into every clip of whatever it’s linked to'
                    // A GLOBAL library row shows the creator's audition sheet:
                    // it describes the AI actor, never their role in this video.
                    : readOnly ? 'AI ACTOR DESCRIPTION — the creator’s look, not their role in this video'
                    : 'IMAGE PROMPT — makes this item’s image'
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
                  promptBoxRef.current = el
                }}
                // Re-fit as the text changes, so deleting lines shrinks it back.
                onInput={(e) => fitPromptBox(e.currentTarget)}
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
                    title="Pick which kit item this sound belongs to — from its picture"
                    onClick={() => void openLinkPicker()}
                  >
                    ⧉ Link image{linkedTo ? ` · ${linkedTo}` : ''} {linkOpen ? '▴' : '▾'}
                  </button>
                  <button
                    type="button"
                    className="vp-save"
                    style={{ fontSize: 10, fontFamily: 'var(--mono)', fontWeight: 500, padding: '5px 11px' }}
                    disabled={describing || !linkedTo}
                    title={linkedTo
                      ? `AI derives the sound from ${linkedTo} — its image if it has one, its description otherwise`
                      : 'Link an object first'}
                    onClick={() => void generateVoiceFromLinked()}
                  >
                    {describing ? (<><span className="spin" /> Listening…</>) : '✦ Generate sound description with AI'}
                  </button>
                  <ModelPicker model={visionModel} onChange={setVisionModel} disabled={describing} models={VISION_MODELS} primary={VISION_MODELS} />
                </div>
              ) : (
              // ONE flow. "New variant" is not a separate mode any more — it's
              // a checkbox on the same panel, because both do the same thing
              // (make an image from this item) and differed only in where the
              // result lands.
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
                <button
                  type="button"
                  className="vp-undo"
                  title="Make an image for this item"
                  style={createOpen ? { borderColor: 'var(--accent)', color: 'var(--accent-2)' } : undefined}
                  onClick={() => {
                    if (createOpen) setCreateOpen(false)
                    else {
                      // A read-only library item can never replace its own
                      // image — open straight into variant mode.
                      setCreateMode(readOnly ? 'variant' : 'version')
                      setCreateOpen(true)
                    }
                  }}
                >
                  {/* Always the same label: this button only opens the editor.
                      WHAT happens is the checkbox next to Generate. */}
                  {createOpen ? '▾' : '▸'} Update existing
                </button>
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
              {isAudio && linkOpen ? (
                <div style={{ border: '1px dashed var(--line, #2a3142)', borderRadius: 10, padding: 10, marginTop: 8 }}>
                  <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 11.5, color: 'var(--ink-3)', cursor: 'pointer', marginBottom: 8 }}>
                    <input type="checkbox" checked={linkFamily} style={{ margin: 0, accentColor: 'var(--accent)' }} onChange={(e) => setLinkFamily(e.target.checked)} />
                    include its variants — the whole family shares this voice
                  </label>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {linkPool === null ? (
                      <span style={{ fontSize: 12, color: 'var(--ink-3)' }}><span className="spin" /> Loading kit…</span>
                    ) : linkPool.length === 0 ? (
                      <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>No image-backed kit items yet.</span>
                    ) : (
                      linkPool.map((k) => {
                        const on = linkedTo && (k.name === linkedTo || (linkFamily && familyRoot(k) === linkedTo))
                        return (
                          <button
                            key={k.name}
                            type="button"
                            title={k.variant_of ? `${k.name} — variant of ${k.variant_of}` : k.name}
                            onClick={() => pickLink(k)}
                            style={{
                              padding: 0, border: `2px solid ${on ? 'var(--accent)' : 'var(--line, #2a3142)'}`,
                              borderRadius: 9, overflow: 'hidden', cursor: 'pointer', background: 'none', lineHeight: 0,
                            }}
                          >
                            <img src={contentUrl(k.image_path)} alt={k.name} loading="lazy" style={{ height: 84, width: 'auto', display: 'block' }} onLoad={equalArea(9500, 140)} />
                          </button>
                        )
                      })
                    )}
                  </div>
                </div>
              ) : null}
              {isAudio ? (
                <div className="vp-edit-actions" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
                  <button
                    type="button"
                    className="vp-save"
                    disabled={!notes.trim()}
                    title={notes.trim() ? 'Keep this audio prompt and close' : 'Write or generate the sound description first'}
                    onClick={() => onApprove?.()}
                  >
                    ✓ Add audio prompt
                  </button>
                </div>
              ) : null}
            </div>
      {createOpen && !isAudio && (
        <div style={{ position: 'relative', marginTop: 8 }}>
          <p style={{ fontSize: 11, color: 'var(--ink-3)', margin: '0 0 8px' }}>
            {readOnly
              ? `${refId} is a library character — shared by every project and read-only. Your change is saved as your own variant, linked to the original.`
              : createMode === 'version'
                ? `Another take of ${refId} — lands in its history above; click a thumbnail to pick the active one.`
                : `A NEW linked item — one deliberate change, its own history. Unrelated item? Use + Add on the section.`}
          </p>
          {genError !== '' && (
            <div style={{ color: 'var(--red, #e5534b)', fontSize: 12.5, lineHeight: 1.5, marginBottom: 8 }}>
              ⚠ {genError}
            </div>
          )}
          {/* ONE body for both outcomes. The fields never change — the
              checkbox next to Generate decides only WHERE the result lands:
              another take in this item's history, or a new character based on
              it. A global item can only ever do the latter. */}
          <VariantModule
              inline
              base={{
                name: refId,
                kind,
                notes,
                // A GLOBAL item has no session version, but its library sheet
                // is exactly the shot the variant must stay faithful to — pass
                // the content-root path (the engine's resolver falls back to
                // CONTENT_ROOT for non-session-prefixed paths).
                image_path: activeVersion ? versionRelPath(activeVersion) : readOnlyPath,
                active_prompt: activeVersion?.prompt || '',
                active_model: activeVersion?.model || '',
              }}
              kit={[]}
              // The panel owns these now, so the variant form and the update
              // form show the SAME controls in the same place.
              actionsSlot={<>{optionsMenu}{variantToggle}</>}
              hideImportPrompt
              hideModelPicker
              modelOverride={imgModel}
              aspectRatioOverride={ratio}
              characterSheet={sheetMode}
              sheetLayoutPrompt={
                /(character|cast)/i.test(kind)
                  ? CHARACTER_SHEET_LAYOUT
                  : OBJECT_SHEET_LAYOUT
              }
              preparePrompt={sheetMode || lessMode ? prepareGenerationPrompt : undefined}
              busyOverride={generating ? 'Generation already running…' : ''}
              suggestedName={suggestedVariantName}
              // Unchecked: the change becomes another take of THIS item.
              asVersion={!readOnly && createMode === 'version'}
              // A read-only library item has no legal "version" mode to fall
              // back to — leave the checkbox where it is.
              onClose={() => !readOnly && setCreateMode('version')}
              onCreated={(name, _instruction, generationPrompt) => {
                const madeVersion = !readOnly && createMode === 'version'
                if (madeVersion) {
                  setReferencesOpen(false)
                  onNotesChange?.(generationPrompt)
                  void loadManifest()
                }
                onToast(
                  madeVersion
                    ? `New take of ${refId} is now selected.`
                    : `${name} was added to Cast and My Library.`,
                )
                if (!madeVersion) onVariantCreated?.(name, generationPrompt)
                if (!readOnly) setCreateMode('version')
              }}
            />
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
          {/* Project image picker, opened from ⚙ Options. It is deliberately
              bounded and collapsible so a large library cannot take over the
              entire World Kit page. */}
          {galleryOpen && (
            <div className="ref-project-picker">
              <div className="ref-project-picker-head">
                <span className="vg-typepick" role="tablist" aria-label="Project image source">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={galleryTab === 'world-kit'}
                    className={galleryTab === 'world-kit' ? 'on' : ''}
                    onClick={() => setGalleryTab('world-kit')}
                  >
                    World Kit
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={galleryTab === 'recent'}
                    className={galleryTab === 'recent' ? 'on' : ''}
                    onClick={() => setGalleryTab('recent')}
                  >
                    Recent generations
                  </button>
                </span>
                <button type="button" className="vp-undo" onClick={() => setGalleryOpen(false)}>
                  ▴ Collapse
                </button>
              </div>
              <div className="ref-project-picker-grid">
              {(galleryTab === 'world-kit' ? pool : recentPool) === null ? (
                <span className="ref-project-picker-empty"><span className="spin" /> Loading images…</span>
              ) : (galleryTab === 'world-kit' ? pool : recentPool)?.length === 0 ? (
                <span className="ref-project-picker-empty">
                  {galleryTab === 'world-kit'
                    ? 'No other World Kit images yet.'
                    : 'No recent image generations yet.'}
                </span>
              ) : (
                (galleryTab === 'world-kit' ? pool : recentPool)?.map((img) => (
                  <button
                    key={img.path}
                    type="button"
                    title={`${img.name}\n${img.path}`}
                    onClick={() => mapImage(img.path)}
                    className="ref-project-picker-tile"
                  >
                    <img src={contentUrl(img.path)} alt="" loading="lazy" />
                    <span>{img.name}</span>
                  </button>
                ))
              )}
              </div>
            </div>
          )}
        </div>
      )}
          </div>
        )}
      </div>
      {/* LINKED AUDIO — ONE row, one panel. Chips show what's already linked
          (unlink on the ×); the + panel links an existing audio object or
          creates a new one. */}
      {!isAudio && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12, alignItems: 'stretch' }}>
          {/* Linked audio renders as a CARD, not a pill — it's a kit object
              (like a thumbnail), and pill-shaped it read as one more button
              next to + Linked audio. */}
          {(linkedAudio ?? []).map((a) => (
            <div
              key={a.key}
              title={a.notes || a.name}
              style={{
                position: 'relative', minWidth: 170, maxWidth: 240, border: '1px solid var(--line, #2a3142)',
                borderRadius: 10, padding: '9px 26px 9px 11px', background: 'var(--bg-2, rgba(255,255,255,.02))',
                display: 'flex', flexDirection: 'column', gap: 4,
              }}
            >
              <span className="vp-map-chip" style={{ position: 'static', alignSelf: 'flex-start' }}>{a.kind || 'audio'}</span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-1, var(--ink))' }}>♪ {a.name}</span>
              {a.notes ? (
                <span style={{ fontSize: 11, color: 'var(--ink-3)', lineHeight: 1.35, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                  {a.notes}
                </span>
              ) : null}
              <button
                type="button"
                title={`Unlink ${a.name} from ${refId}`}
                onClick={() => onAudioUnlink?.(a.key)}
                style={{ position: 'absolute', top: 6, right: 8, background: 'none', border: 'none', color: 'var(--ink-3)', cursor: 'pointer', padding: 0, fontSize: 12 }}
              >×</button>
            </div>
          ))}
          <button type="button" className="vp-undo" style={{ alignSelf: 'center' }} onClick={() => setAudioOpen((v) => !v)}>
            {/* A verb: the button DOES something, it isn't a label. */}
            {audioOpen ? '▾ Link audio' : '+ Link audio'}
          </button>
        </div>
      )}
      {audioOpen ? (
        <div style={{ border: '1px dashed var(--line, #2a3142)', borderRadius: 10, padding: 12, marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {(audioOptions ?? []).length > 0 && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>LINK EXISTING</span>
              {(audioOptions ?? []).map((a) => (
                <button
                  key={a.key}
                  type="button"
                  className="vp-undo"
                  title={a.notes || `Link ${a.name} to ${refId}`}
                  onClick={() => { onAudioLink?.(a.key); setAudioOpen(false) }}
                >
                  ♪ {a.name}{a.kind ? ` (${a.kind})` : ''}
                </button>
              ))}
              <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>— or make a new one:</span>
            </div>
          )}
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
      {lightboxUrl
        ? createPortal(
          <div
            className="vg-lightbox"
            role="dialog"
            aria-modal="true"
            aria-label={`${refId} enlarged image`}
            onClick={() => setLightboxUrl('')}
          >
            <button
              type="button"
              className="vg-lightbox-close"
              aria-label="Close enlarged image"
              onClick={() => setLightboxUrl('')}
            >
              ✕
            </button>
            <img
              src={lightboxUrl}
              alt={`${refId} enlarged`}
              onClick={(event) => event.stopPropagation()}
            />
          </div>,
          document.body,
        )
        : null}
    </div>
  )
}
