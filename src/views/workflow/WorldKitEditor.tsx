import { useCallback, useEffect, useRef, useState } from 'react'
import { castByShow } from '../../data/cast'
import { parseWorldKit, serializeWorldKit, type WKDoc, type WKSection } from '../../lib/worldkit-md'
import { actionUrl, activeSession, apiUrl, contentUrl } from '../../lib/api'
import { RefImagePanel } from './RefImagePanel'
import GlobalCharacterPicker from './GlobalCharacterPicker'
import { useWorkflowStore } from '../../store/workflow'

// Scope tokens (stored in the md) ↔ human labels shown in the per-item picker.
const SCOPE_OPTIONS = [
  { value: 'episode-only', label: 'This episode only (default)' },
  { value: 'show-shared', label: 'Show / subtemplate — affects future episodes' },
  { value: 'template-shared', label: 'Format template — affects every show on it' },
]
const isSharedScope = (scope: string) => /show|template|format/i.test(scope)

const SECTION_BLURBS: Record<string, string> = {
  Cast: 'Characters who appear.',
  Environments: 'Locations and backdrops.',
  'Props / Objects': 'Recurring objects and held items.',
  'Documents / Screens': 'On-screen UI, documents, and charts.',
  'Motion / Camera References': 'Camera moves and motion cues.',
  'Master Shots': 'The approved scenes your clips will start from — add cast + environment images as reference images, describe the moment, and generate.',
  'Beat-Specific Refs': 'One-off refs scoped to a single beat.',
  'Beat-Specific References': 'One-off refs scoped to a single beat.',
  'Master variants': 'Alternate takes of a master — same setup, one deliberate change.',
  Audio: 'Voices, music and ambience. A voice linked to a cast member rides into every clip that references them.',
}

/**
 * The World Kit panel, made real: data comes from world-kit.md (auto-seeded by
 * inheriting the show's shared items from the prior episode — deterministic,
 * free). Every item is a chip; click to expand and view/edit its prompt
 * description, change its save scope (episode default / show / template), or
 * remove it (with an impact warning). Undo / Reset / Raw live in the header.
 */
// Survives unmounts (step hops) within the app session; keyed session:stage.
const EXPANDED_MEMORY: Record<string, string | null> = {}

export function WorldKitEditor({ stageId, onToast }: { stageId: string; onToast?: (m: string) => void }) {
  // Toast plumbing is optional here (StageDraftEditor doesn't thread it yet) —
  // fall back to a console note rather than swallowing feedback.
  const toast = onToast ?? ((m: string) => console.info('[world-kit]', m))
  const draft = useWorkflowStore((s) => s.stageDrafts[stageId] ?? '')
  const setStageDraft = useWorkflowStore((s) => s.setStageDraft)
  const seedStageDraft = useWorkflowStore((s) => s.seedStageDraft)
  const historyKey = `${activeSession()}:${stageId}`
  const storedHistory = useWorkflowStore((s) => s.stepHistories[historyKey])
  const setStepHistory = useWorkflowStore((s) => s.setStepHistory)
  const setStepUndo = useWorkflowStore((s) => s.setStepUndo)
  const setStepMenu = useWorkflowStore((s) => s.setStepMenu)
  const initialUndoHistory = (storedHistory?.undo as string[] | undefined) ?? []
  const initialRedoHistory = (storedHistory?.redo as string[] | undefined) ?? []
  const historyRef = useRef<string[]>(initialUndoHistory)
  const redoRef = useRef<string[]>(initialRedoHistory)
  const [historyLen, setHistoryLen] = useState(initialUndoHistory.length)
  const [redoLen, setRedoLen] = useState(initialRedoHistory.length)
  const draftRef = useRef(draft)
  useEffect(() => {
    draftRef.current = draft
  }, [draft])
  const rememberHistory = useCallback(() => {
    setStepHistory(historyKey, {
      undo: historyRef.current,
      redo: redoRef.current,
    })
  }, [historyKey, setStepHistory])
  const [raw, setRaw] = useState(false)
  const [rawEditable, setRawEditable] = useState(false)
  // Descriptions under image cards — OFF by default: the wall is visual,
  // the words live one click away (expand the item).
  const [showDesc, setShowDesc] = useState(false)
  // HOLD MY PLACE: which item is expanded survives hopping to other steps
  // (module memory — the component unmounts when the user leaves the step).
  const memKey = `${activeSession()}:${stageId}`
  const [expanded, setExpandedState] = useState<string | null>(() => EXPANDED_MEMORY[memKey] ?? null) // `${si}:${ri}`
  const setExpanded = (v: string | null) => {
    EXPANDED_MEMORY[memKey] = v
    setExpandedState(v)
  }
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [libraryOpen, setLibraryOpen] = useState(false)
  // Which section has an AI fill in flight (only one at a time).
  const [aiSection, setAiSection] = useState('')
  // Active reference image per kit item (ref id -> session-rel path): chip
  // thumbnails. Refreshed when an item closes (generate/pick may change it).
  const [activeRefImages, setActiveRefImages] = useState<Record<string, string>>({})
  useEffect(() => {
    fetch(apiUrl('source-images', { session: activeSession(), include_refs: 1 }))
      .then((r) => (r.ok ? r.json() : null))
      .then((out) => {
        if (!out?.ok) return
        const map: Record<string, string> = {}
        for (const img of out.data?.images ?? []) {
          if (img.ref) map[img.ref] = img.path
        }
        setActiveRefImages(map)
      })
      .catch(() => {})
  }, [expanded])
  const inheritTriedRef = useRef(false)

  // AUTO-INHERIT: arriving with no kit pulls the show's shared items from the
  // prior episode (deterministic engine action, no cost, no AI). Seeded as
  // clean state — it mirrors what's now on disk.
  useEffect(() => {
    if (draft.trim() || inheritTriedRef.current) return
    inheritTriedRef.current = true
    fetch(actionUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: activeSession(), tenant: 'local', action: 'inherit_world_kit' }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((out) => {
        if (out?.ok && typeof out.data?.content === 'string') {
          const store = useWorkflowStore.getState()
          if ((store.stageDrafts[stageId] ?? '').trim() === '') {
            seedStageDraft(stageId, out.data.content)
          }
        }
      })
      .catch(() => {})
  }, [draft, stageId, seedStageDraft])

  let doc: WKDoc | null = null
  try {
    doc = parseWorldKit(draft)
  } catch {
    doc = null
  }
  const parseFailed = !doc || doc.sections.length === 0
  // AUDIO IS A FIRST-CLASS AREA: consistent voices, soundtrack, ambience,
  // SFX. Render the section even before any rows exist — + Add writes it
  // into the draft the moment the first object lands.
  if (doc && doc.sections.length > 0 && !doc.sections.some((sec) => sec.kind === 'table' && /^audio$/i.test(sec.heading.trim()))) {
    doc.sections.push({ heading: 'Audio', kind: 'table', columns: ['Ref', 'Kind', 'Scope', 'Linked to', 'Source', 'Notes'], rows: [] })
  }
  // Every kit item's kind + notes, keyed by ref — the casting panel uses it
  // to pull referenced items' TEXT into a composed generation's prompt.
  const kitIndex: Record<string, { kind: string; notes: string; section: string }> = {}
  for (const sec of doc?.sections ?? []) {
    if (sec.kind !== 'table') continue
    const rIdx = Math.max(0, sec.columns.findIndex((c) => /ref/i.test(c)))
    const kIdx = sec.columns.findIndex((c) => /kind/i.test(c))
    const dIdx = sec.columns.length - 1
    for (const r of sec.rows) {
      const ref = (r[rIdx] || '').trim()
      if (ref) kitIndex[ref] = { kind: kIdx >= 0 ? r[kIdx] : '', notes: dIdx !== rIdx ? r[dIdx] : '', section: sec.heading }
    }
  }

  const snapshot = useCallback(() => {
    historyRef.current.push(draftRef.current)
    if (historyRef.current.length > 50) historyRef.current.shift()
    redoRef.current = []
    rememberHistory()
    setHistoryLen(historyRef.current.length)
    setRedoLen(0)
  }, [rememberHistory])
  const undo = useCallback(() => {
    const prev = historyRef.current.pop()
    if (prev != null) {
      redoRef.current.push(draftRef.current)
      if (redoRef.current.length > 50) redoRef.current.shift()
      setStageDraft(stageId, prev)
    }
    rememberHistory()
    setHistoryLen(historyRef.current.length)
    setRedoLen(redoRef.current.length)
  }, [rememberHistory, setStageDraft, stageId])
  const redo = useCallback(() => {
    const next = redoRef.current.pop()
    if (next != null) {
      historyRef.current.push(draftRef.current)
      if (historyRef.current.length > 50) historyRef.current.shift()
      setStageDraft(stageId, next)
    }
    rememberHistory()
    setHistoryLen(historyRef.current.length)
    setRedoLen(redoRef.current.length)
  }, [rememberHistory, setStageDraft, stageId])
  const reset = useCallback(async () => {
    // Reset to default = re-import the inherited kit (shared items only),
    // discarding every local edit and episode-only addition. DESTRUCTIVE:
    // confirm first; the engine snapshots the old file into save-points.
    if (!window.confirm('Reset to default discards every edit and episode-only item in this kit. A backup lands in working/save-points. Continue?')) return
    snapshot()
    try {
      const r = await fetch(actionUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: activeSession(), tenant: 'local', action: 'inherit_world_kit', force: true }),
      })
      const out = await r.json().catch(() => null)
      if (out?.ok && typeof out.data?.content === 'string') setStageDraft(stageId, out.data.content)
    } catch {
      /* engine offline — keep current draft */
    }
  }, [setStageDraft, snapshot, stageId])
  useEffect(() => {
    setStepUndo({
      stepId: stageId,
      count: historyLen,
      run: undo,
      redoCount: redoLen,
      redo,
    })
    return () => {
      if (useWorkflowStore.getState().stepUndo?.stepId === stageId) setStepUndo(null)
    }
  }, [historyLen, redo, redoLen, setStepUndo, stageId, undo])
  useEffect(() => {
    setStepMenu({
      stepId: stageId,
      actions: [
        {
          id: 'world-kit-reset',
          label: 'Reset World Kit to default',
          title: 'Discard episode-only changes and restore the inherited World Kit',
          danger: true,
          run: reset,
        },
        {
          id: 'world-kit-descriptions',
          label: showDesc ? 'Hide card descriptions' : 'Show card descriptions',
          active: showDesc,
          run: () => setShowDesc((value) => !value),
        },
        {
          id: 'world-kit-raw',
          label: raw ? 'Show formatted World Kit' : 'View raw Markdown',
          active: raw,
          run: () => {
            setRawEditable(false)
            setRaw((value) => !value)
          },
        },
      ],
    })
    return () => {
      if (useWorkflowStore.getState().stepMenu?.stepId === stageId) setStepMenu(null)
    }
  }, [raw, reset, setStepMenu, showDesc, stageId])

  if (!draft.trim()) {
    return <span className="label">Loading the inherited kit from the engine…</span>
  }

  const apply = (d: WKDoc) => setStageDraft(stageId, serializeWorldKit(d))

  // Append a row into a named table section of the DRAFT (creating the
  // section when missing). Variant/audio creations write the FILE via the
  // engine; mirroring them here keeps the unsaved draft from erasing them
  // on the next save.
  // Returns the `${sectionIndex}:${rowIndex}` key of the row it wrote, so a
  // caller can expand the item it just created.
  const appendRowToTable = (heading: string, columns: string[], row: string[]): string | null => {
    if (!doc) return null
    snapshot()
    const d = JSON.parse(JSON.stringify(doc)) as WKDoc
    let sec = d.sections.find(
      (s): s is Extract<WKSection, { kind: 'table' }> => s.kind === 'table' && s.heading.toLowerCase() === heading.toLowerCase(),
    )
    if (!sec) {
      sec = { heading, kind: 'table', columns, rows: [] }
      d.sections.push(sec)
    } else if (columns.length > sec.columns.length) {
      // The caller widened the table (e.g. adding `Variant of`). Adopt the new
      // header and pad every existing row so the cells stay under the right
      // columns — a mismatch silently shifts values into neighbouring fields.
      const at = Math.max(0, columns.length - 2)
      sec.columns = columns
      for (const r of sec.rows) while (r.length < columns.length) r.splice(at, 0, '')
    }
    const out = row.slice(0, sec.columns.length)
    while (out.length < sec.columns.length) out.push('')
    sec.rows.push(out)
    apply(d)
    return `${d.sections.indexOf(sec)}:${sec.rows.length - 1}`
  }

  // PER-SECTION AI: fill one section instead of redrafting the whole kit, so a
  // hand-built Cast survives while Environments gets proposed. Paid (a text
  // model call) — gated by confirmation like every other paid action.
  const fillSectionWithAI = async (heading: string) => {
    if (aiSection) return
    if (
      !window.confirm(
        `Let AI propose items for “${heading}” from the story so far?\n\n` +
          'This uses text-model credits. Existing items are kept — proposals are added alongside them.',
      )
    )
      return
    setAiSection(heading)
    try {
      // The engine drafts against the file on disk and returns the merged
      // result, so any unsaved draft must land first or it would be lost.
      await fetch(actionUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: activeSession(),
          tenant: 'local',
          action: 'set_stage_output',
          stage_id: 'world_kit',
          path: 'working/world-kit.md',
          content: draftRef.current,
        }),
      })
      const r = await fetch(actionUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: activeSession(),
          tenant: 'local',
          action: 'draft_world_kit_section',
          section: heading,
          allow_cost: true,
        }),
      })
      const out = await r.json().catch(() => null)
      if (out?.ok && typeof out.data?.content === 'string') {
        snapshot()
        setStageDraft(stageId, out.data.content)
        const n = Number(out.data.added ?? 0)
        toast(n ? `AI added ${n} item${n === 1 ? '' : 's'} to ${heading}` : `No new ${heading} items proposed`)
      } else {
        toast(out?.message || out?.error || `Could not fill ${heading}`)
      }
    } catch {
      toast('The engine is not responding — is it running?')
    } finally {
      setAiSection('')
    }
  }

  // The engine's add/variation actions edit the kit FILE, so an unsaved draft
  // has to land first — otherwise the engine appends to a stale kit and the
  // user's pending edits are lost on the next save.
  const openLibrary = async () => {
    try {
      await fetch(actionUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: activeSession(),
          tenant: 'local',
          action: 'set_stage_output',
          stage_id: 'world_kit',
          path: 'working/world-kit.md',
          content: draftRef.current,
        }),
      })
    } catch {
      /* engine offline — the picker will surface the failure on add */
    }
    setLibraryOpen(true)
  }

  // A library pick / variation writes the FILE via the engine; mirror the row
  // into the unsaved draft too, exactly like variants and audio above, so a
  // pending edit isn't erased on the next save.
  const onLibraryAdded = (ref: string, variation: boolean, description: string, parent: string) => {
    const isGlobal = !variation
    // BY COLUMN NAME, never by position: the engine adds a `Variant of` column
    // to Cast the first time a variation is made, so a fixed 4-cell row lands
    // the description under the wrong header (it showed up in Variant of, with
    // an empty prompt).
    const castSec = doc?.sections.find(
      (s): s is Extract<WKSection, { kind: 'table' }> =>
        s.kind === 'table' && /^cast$/i.test(s.heading.trim()),
    )
    const cols = [...(castSec?.columns ?? ['Ref', 'Kind', 'Scope', 'Notes'])]
    // The engine adds `Variant of` to the FILE on the first variation; the
    // in-memory draft here predates that write, so mirror the column too —
    // otherwise the link is dropped on the next save.
    if (variation && !cols.some((c) => /^variant of$/i.test(c.trim().replace(/_/g, ' ')))) {
      cols.splice(Math.max(0, cols.length - 1), 0, 'Variant of')
    }
    const row = cols.map((c) => {
      const k = c.trim().toLowerCase().replace(/_/g, ' ')
      if (/^ref$/.test(k)) return ref
      if (/^kind$/.test(k)) return 'character'
      if (/^scope$/.test(k)) return isGlobal ? 'global' : 'episode-only'
      if (/^variant of$/.test(k)) return isGlobal ? '' : `global:${parent}`
      // A global row deliberately carries NO description — it resolves from
      // the library at read time. A variation owns its text.
      if (/^(notes|beats)$/.test(k)) return isGlobal ? '' : description
      return ''
    })
    const key = appendRowToTable('Cast', cols, row)
    // ALWAYS close: leaving the picker open reads as "nothing happened". The
    // proof of the add is seeing the item land in the kit behind it.
    setLibraryOpen(false)
    // A variation exists to be CHANGED, so open it — the user lands directly
    // in its editor with the copied description ready to edit. A global pick
    // is read-only, so there is nothing to expand into.
    if (key && variation) setExpanded(key)
    // Scroll the new item into view. Closing the modal drops you back at
    // whatever you were looking at, so without this the thing you just added
    // is off-screen and the add still reads as "nothing happened".
    // Retried: the row renders a frame or two after the draft updates, so a
    // single timeout races it.
    // The step panel scrolls INSIDE `.workflow-view`, not the window, and it
    // re-renders after the draft change — so drive that container directly,
    // and keep re-checking until the row is actually on screen.
    let tries = 0
    const reveal = () => {
      const el = document.querySelector(`[data-wk-ref="${ref}"]`)
      const box = document.querySelector('.workflow-view')
      if (el && box) {
        const elTop = el.getBoundingClientRect().top
        const boxTop = box.getBoundingClientRect().top
        const boxBottom = boxTop + box.clientHeight
        // Already on screen? Leave the scroll alone — re-running would fight
        // the user if they have started scrolling themselves.
        if (elTop >= boxTop && elTop <= boxBottom - 40) return
        const target = box.scrollTop + (elTop - boxTop) - box.clientHeight / 2 + el.clientHeight / 2
        box.scrollTo({ top: Math.max(0, target), behavior: 'smooth' })
        // Re-check: a re-render right after can reset scrollTop.
        if (tries++ < 6) window.setTimeout(reveal, 140)
      } else if (tries++ < 20) {
        window.setTimeout(reveal, 50)
      }
    }
    window.setTimeout(reveal, 50)
    toast(
      isGlobal
        ? `Added ${ref} from the character library`
        : `Made your own version: ${ref} — edit its description below`,
    )
  }

  // Cast reference images from the show data, matched by ref id.
  const castImages: Record<string, string> = {}
  for (const show of Object.values(castByShow)) {
    for (const c of show.chars) castImages[c.ref] = c.img
  }

  const btn: React.CSSProperties = {
    background: 'none',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--line, #2a3142)',
    borderRadius: 6,
    color: 'var(--ink-2)',
    padding: '6px 12px',
    cursor: 'pointer',
    fontSize: 12,
  }
  const chip: React.CSSProperties = {
    background: 'rgba(255,255,255,.04)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--line, #2a3142)',
    borderRadius: 8,
    color: 'var(--ink-1)',
    padding: '8px 14px',
    cursor: 'pointer',
    fontSize: 13,
  }

  return (
    <div style={{ marginTop: 4 }}>
      {raw || parseFailed ? (
        <>
          {/* READ-ONLY BY DEFAULT: this file is the registry behind every
              image in the kit — a stray edit (or an accidental select-all)
              in a raw textarea can wipe it. Editing is an explicit unlock,
              and parse failures still open editable (fixing IS the point). */}
          {!parseFailed && !rawEditable && (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', margin: '0 0 8px' }}>
              <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>Read-only — the images above hang off these rows.</span>
              <button type="button" className="vp-undo" onClick={() => { snapshot(); setRawEditable(true) }}>✎ Edit raw (snapshots undo)</button>
            </div>
          )}
          <textarea
            className="raw-source-textarea"
            value={draft}
            readOnly={!parseFailed && !rawEditable}
            onFocus={parseFailed || rawEditable ? snapshot : undefined}
            onChange={(e) => {
              if (parseFailed || rawEditable) setStageDraft(stageId, e.target.value)
            }}
            style={{
              width: '100%', minHeight: 320, resize: 'vertical', background: 'transparent',
              color: !parseFailed && !rawEditable ? 'var(--ink-3)' : 'var(--ink-1, inherit)',
              border: '1px solid var(--line, #2a3142)', borderRadius: 8,
              padding: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13, lineHeight: 1.55,
            }}
          />
        </>
      ) : (
        doc!.sections.map((section, si) => {
          const isStyleAnchor = /style anchor/i.test(section.heading)
          const addItem = () => {
            snapshot()
            const d = structuredClone(doc!)
            const sec = d.sections[si]
            if (sec.kind === 'table') {
              sec.rows.push(
                sec.columns.map((c) =>
                  /ref/i.test(c) ? 'new-item' : /kind/i.test(c) ? (/audio/i.test(section.heading) ? 'voice' : 'prop') : /scope/i.test(c) ? 'episode-only' : '',
                ),
              )
              apply(d)
              setExpanded(`${si}:${sec.rows.length - 1}`)
            } else {
              // prose item section → convert to a real item table with one new row
              const columns = /motion|camera/i.test(section.heading)
                ? ['Ref', 'Scope', 'Notes']
                : ['Ref', 'Kind', 'Scope', 'Beats']
              d.sections[si] = {
                heading: section.heading,
                kind: 'table',
                columns,
                rows: [
                  columns.map((c) =>
                    /ref/i.test(c) ? 'new-item' : /kind/i.test(c) ? 'prop' : /scope/i.test(c) ? 'episode-only' : '',
                  ),
                ],
              }
              apply(d)
              setExpanded(`${si}:0`)
            }
          }
          return (
          <div key={si} style={{ padding: '18px 0' }}>
            {/* CONSISTENT HEADER: title · blurb · + Add pinned right */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <h3 style={{ margin: 0, fontSize: 15 }}>{section.heading}</h3>
              {SECTION_BLURBS[section.heading] && (
                <span style={{ color: 'var(--ink-3)', fontSize: 12 }}>{SECTION_BLURBS[section.heading]}</span>
              )}
              <span style={{ flex: 1 }} />
              {!isStyleAnchor && (
                <button
                  style={{ ...btn, padding: '5px 12px' }}
                  disabled={aiSection === section.heading}
                  title={`Let AI fill in ${section.heading} from the story so far`}
                  onClick={() => void fillSectionWithAI(section.heading)}
                >
                  {aiSection === section.heading ? 'Thinking…' : '✦ Let AI fill this'}
                </button>
              )}
              {/* Cast picks from the GLOBAL library — real-looking creators
                  beat anything the image model invents from scratch. */}
              {!isStyleAnchor && /^cast$/i.test(section.heading) && (
                <button style={{ ...btn, padding: '5px 12px' }} onClick={() => void openLibrary()}>
                  ⧉ From library…
                </button>
              )}
              {!isStyleAnchor && (
                <button style={{ ...btn, padding: '5px 12px' }} onClick={addItem}>
                  + Add
                </button>
              )}
            </div>

            {section.kind === 'text' && isStyleAnchor ? (
              // Style Anchor is a property block, not an item list — text is correct here.
              <>
              <textarea
                value={section.text}
                onFocus={snapshot}
                onChange={(e) => {
                  const d = structuredClone(doc!)
                  const sec = d.sections[si]
                  if (sec.kind === 'text') sec.text = e.target.value
                  apply(d)
                }}
                style={{
                  width: '100%', resize: 'vertical', background: 'transparent', color: 'var(--ink-2)',
                  border: '1px solid var(--line, #2a3142)', borderRadius: 8, padding: 10, fontSize: 13, lineHeight: 1.5, marginTop: 8,
                }}
              />
              {/* EMPTY FIELDS SAY SO (user rule): blank Style/Anchor lines must
                  state their meaning instead of dangling as bare markdown. */}
              {(/\*\*Style:\*\*\s*($|\n)/.test(section.text) || /\*\*Anchor:\*\*\s*($|\n)/.test(section.text)) && (
                <p style={{ color: 'var(--ink-3)', fontSize: 12, margin: '6px 0 0', lineHeight: 1.5 }}>
                  No look chosen yet — Style and Anchor are empty. Project setup (Step 01) owns the
                  visual style; once it's picked there, this block names the look and the reference
                  every image gets checked against.
                </p>
              )}
              </>
            ) : section.kind === 'text' ? (
              // ITEM SECTION with no items yet: the note reads quietly; + Add
              // lives in the header like everywhere else.
              section.text ? (
                <p style={{ color: 'var(--ink-3)', fontSize: 13, margin: '8px 0 0', lineHeight: 1.5 }}>
                  {section.text}
                </p>
              ) : null
            ) : (
              <>
                {/* ITEMS: character-sheet cards for items with reference images,
                    chips for the rest, + add */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 10, alignItems: 'flex-start' }}>
                  {section.rows.map((row, ri) => {
                    const refIdx = Math.max(0, section.columns.findIndex((c) => /ref/i.test(c)))
                    const kindIdx = section.columns.findIndex((c) => /kind/i.test(c))
                    const scopeIdx = section.columns.findIndex((c) => /scope/i.test(c))
                    const descIdx = section.columns.length - 1
                    const key = `${si}:${ri}`
                    const shared = scopeIdx >= 0 && isSharedScope(row[scopeIdx])
                    const img = castImages[row[refIdx]] ?? (activeRefImages[row[refIdx]] ? contentUrl(activeRefImages[row[refIdx]]) : undefined)
                    if (img && !(expanded ?? '').startsWith(`${si}:`)) {
                      // CHARACTER SHEET CARD — same law as the mapping wall:
                      // visuals first. Every image gets the SAME square
                      // footage, shaped by its own w/h (portrait tall+narrow,
                      // landscape wide+short), the card HUGS the image, and
                      // the text wraps to the image's width — text is never
                      // the decider of the card's size. The EXPANDED item's
                      // card collapses to a name chip: its image is already
                      // large in the panel below.
                      return (
                        <button
                          key={key}
                          data-wk-ref={row[refIdx]}
                          onClick={() => setExpanded(expanded === key ? null : key)}
                          title={shared ? 'Shared with the show/template' : 'This episode only'}
                          style={{
                            width: 'fit-content',
                            textAlign: 'left',
                            background: 'rgba(255,255,255,.03)',
                            border: `1px solid ${expanded === key ? 'var(--ink-2)' : 'var(--line, #2a3142)'}`,
                            borderRadius: 10,
                            padding: 0,
                            cursor: 'pointer',
                            overflow: 'hidden',
                          }}
                        >
                          <span style={{ position: 'relative', display: 'block', lineHeight: 0 }}>
                            <img
                              src={img}
                              alt=""
                              style={{ height: 220, width: 'auto', display: 'block' }}
                              onLoad={(e) => {
                                const im = e.currentTarget
                                const r = im.naturalWidth / im.naturalHeight || 1
                                let h = Math.sqrt(52000 / r)
                                if (h * r > 460) h = 460 / r
                                im.style.height = `${Math.round(h)}px`
                                im.style.width = `${Math.round(h * r)}px`
                              }}
                            />
                            {/* Same labeling language as the mapping wall:
                                kind chip top-left, name ON the image. */}
                            {kindIdx >= 0 && row[kindIdx] ? (
                              <span
                                className={`vp-map-chip k-${(row[kindIdx] || '').trim().toLowerCase()}`}
                                style={{ position: 'absolute', top: 8, left: 8, lineHeight: 1.4, backdropFilter: 'blur(4px)' }}
                              >
                                {(row[kindIdx] || '').trim().toUpperCase()}
                              </span>
                            ) : null}
                            <span
                              style={{
                                position: 'absolute', left: 0, right: 0, bottom: 0,
                                padding: '24px 10px 8px', lineHeight: 1.4,
                                background: 'linear-gradient(transparent, rgba(8,10,15,.88))',
                                color: 'var(--ink)', fontFamily: 'var(--mono)', fontSize: 11,
                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left',
                              }}
                            >
                              {row[refIdx]}
                              {shared && <span style={{ color: 'var(--amber)', marginLeft: 6 }}>⬡</span>}
                            </span>
                          </span>
                          {showDesc && (row[descIdx] || '').trim() ? (
                            <span style={{ display: 'block', width: 0, minWidth: '100%', boxSizing: 'border-box' }}>
                              <span
                                style={{
                                  display: '-webkit-box',
                                  WebkitLineClamp: 2,
                                  WebkitBoxOrient: 'vertical',
                                  overflow: 'hidden',
                                  padding: '8px 10px 10px',
                                  color: 'var(--ink-3)',
                                  fontSize: 12,
                                  lineHeight: 1.4,
                                }}
                              >
                                {row[descIdx]}
                              </span>
                            </span>
                          ) : null}
                        </button>
                      )
                    }
                    const descText = descIdx !== refIdx ? (row[descIdx] || '').trim() : ''
                    if (descText && !(expanded ?? '').startsWith(`${si}:`)) {
                      // PROMPT-ONLY TEXT CARD — same rule as the mapping wall:
                      // a text object is a visual object and takes up space,
                      // in a footprint comparable to the image cards.
                      return (
                        <button
                          key={key}
                          data-wk-ref={row[refIdx]}
                          onClick={() => setExpanded(expanded === key ? null : key)}
                          title={shared ? 'Shared with the show/template' : 'This episode only'}
                          style={{
                            width: 232, height: 205, textAlign: 'left',
                            background: 'rgba(255,255,255,.03)',
                            border: `1px solid ${expanded === key ? 'var(--ink-2)' : 'var(--line, #2a3142)'}`,
                            borderRadius: 10, padding: 0, overflow: 'hidden', cursor: 'pointer',
                            display: 'flex', flexDirection: 'column',
                          }}
                        >
                          <span style={{ padding: '10px 12px 0', color: 'var(--ink-1)', fontSize: 13, fontWeight: 600 }}>
                            {row[refIdx] || '(unnamed)'}
                            {shared && <span style={{ color: 'var(--amber)', marginLeft: 6 }}>⬡</span>}
                          </span>
                          <span
                            style={{
                              flex: 1, padding: '6px 12px 10px', color: 'var(--ink-3)', fontSize: 11.5, lineHeight: 1.5,
                              overflow: 'hidden',
                              maskImage: 'linear-gradient(180deg, #000 68%, transparent 98%)',
                              WebkitMaskImage: 'linear-gradient(180deg, #000 68%, transparent 98%)',
                            }}
                          >
                            {descText}
                          </span>
                        </button>
                      )
                    }
                    return (
                      <button
                        key={key}
                        data-wk-ref={row[refIdx]}
                        style={{
                          ...chip,
                          borderColor: expanded === key ? 'var(--ink-2)' : 'var(--line, #2a3142)',
                        }}
                        title={shared ? 'Shared with the show/template' : 'This episode only'}
                        onClick={() => setExpanded(expanded === key ? null : key)}
                      >
                        {row[refIdx] || '(unnamed)'}
                        {shared && <span style={{ color: 'var(--amber)', marginLeft: 6 }}>⬡</span>}
                      </button>
                    )
                  })}
                </div>

                {/* EXPANDED ITEM: full view/edit of the selected chip */}
                {expanded?.startsWith(`${si}:`) && (() => {
                  const ri = Number(expanded.split(':')[1])
                  const row = section.rows[ri]
                  if (!row) return null
                  const refIdx = Math.max(0, section.columns.findIndex((c) => /ref/i.test(c)))
                  const kindIdx = section.columns.findIndex((c) => /kind/i.test(c))
                  const scopeIdx = section.columns.findIndex((c) => /scope/i.test(c))
                  const descIdx = section.columns.length - 1
                  const setCell = (ci: number, v: string) => {
                    const d = structuredClone(doc!)
                    const sec = d.sections[si]
                    if (sec.kind === 'table') sec.rows[ri][ci] = v
                    apply(d)
                  }
                  const scope = scopeIdx >= 0 ? row[scopeIdx] : 'episode-only'
                  const scopeKnown = SCOPE_OPTIONS.some((o) => o.value === scope)
                  const fieldRows = (
                    <>
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            <label style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                              REF
                              <input
                                value={row[refIdx]}
                                onFocus={snapshot}
                                onChange={(e) => setCell(refIdx, e.target.value)}
                                style={{
                                  display: 'block', width: 160, background: 'transparent', color: 'var(--ink-1)',
                                  border: '1px solid var(--line, #2a3142)', borderRadius: 6, padding: '6px 8px',
                                  fontSize: 13, fontFamily: 'ui-monospace, Menlo, monospace', marginTop: 3,
                                }}
                              />
                            </label>
                            {kindIdx >= 0 && kindIdx !== refIdx && kindIdx !== descIdx && (
                              <label style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                                KIND
                                <input
                                  value={row[kindIdx]}
                                  onFocus={snapshot}
                                  onChange={(e) => setCell(kindIdx, e.target.value)}
                                  style={{
                                    display: 'block', width: 120, background: 'transparent', color: 'var(--ink-2)',
                                    border: '1px solid var(--line, #2a3142)', borderRadius: 6, padding: '6px 8px', fontSize: 13, marginTop: 3,
                                  }}
                                />
                              </label>
                            )}
                            {scopeIdx >= 0 && (
                              <label style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                                SAVE TO
                                <select
                                  value={scope}
                                  onFocus={snapshot}
                                  onChange={(e) => setCell(scopeIdx, e.target.value)}
                                  className="sc-select"
                                  style={{ display: 'block', marginTop: 3, color: isSharedScope(scope) ? 'var(--amber)' : undefined }}
                                >
                                  {!scopeKnown && <option value={scope}>{scope}</option>}
                                  {SCOPE_OPTIONS.map((o) => (
                                    <option key={o.value} value={o.value}>{o.label}</option>
                                  ))}
                                </select>
                              </label>
                            )}
                            {/* The section's OTHER columns (Linked to, Source,
                                Group, Variant of…) — every cell is editable,
                                not just the famous three. */}
                            {section.columns.map((col, ci) =>
                              ci !== refIdx && ci !== kindIdx && ci !== scopeIdx && ci !== descIdx ? (
                                <label key={col} style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                                  {col.toUpperCase()}
                                  <input
                                    value={row[ci] ?? ''}
                                    onFocus={snapshot}
                                    onChange={(e) => setCell(ci, e.target.value)}
                                    style={{
                                      display: 'block', width: 170, background: 'transparent', color: 'var(--ink-2)',
                                      border: '1px solid var(--line, #2a3142)', borderRadius: 6, padding: '6px 8px', fontSize: 13, marginTop: 3,
                                    }}
                                  />
                                </label>
                              ) : null,
                            )}
                          </div>
                          {/* With a casting panel, the prompt textarea moves INTO
                              RefImagePanel (it owns the prompt/character toggle). */}
                          {descIdx !== refIdx && row[refIdx].trim() === '' && (
                            <label style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                              {section.columns[descIdx].toUpperCase()} — PROMPT DESCRIPTION
                              <textarea
                                value={row[descIdx]}
                                onFocus={snapshot}
                                onChange={(e) => setCell(descIdx, e.target.value)}
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
                            </label>
                          )}
                    </>
                  )
                  // THE OTHER SIDE OF THE LINK: audio objects pointing at this
                  // item render inside RefImagePanel's linked-audio row (chips
                  // + the one + panel) — computed here because the editor owns
                  // the kit doc. Draft edits only.
                  const audioLinks = (() => {
                    const isAudioKind = /^(voice|music|ambience|sfx|audio)\b/i.test(kindIdx >= 0 ? row[kindIdx] : '')
                    if (row[refIdx].trim() === '' || isAudioKind) return null
                    const asi = doc!.sections.findIndex(
                      (sec) => sec.kind === 'table' && /audio/i.test(sec.heading) && sec.columns.some((c) => /linked/i.test(c)),
                    )
                    if (asi < 0) return null
                    const aSec = doc!.sections[asi]
                    if (aSec.kind !== 'table') return null
                    const aRef = Math.max(0, aSec.columns.findIndex((c) => /ref/i.test(c)))
                    const aKindI = aSec.columns.findIndex((c) => /kind/i.test(c))
                    const aNotes = aSec.columns.findIndex((c) => /notes/i.test(c))
                    const aLink = aSec.columns.findIndex((c) => /linked/i.test(c))
                    if (aLink < 0) return null
                    const me = row[refIdx].trim()
                    const setAudioLink = (ri2: number, v: string) => {
                      snapshot()
                      const d = JSON.parse(JSON.stringify(doc)) as WKDoc
                      const sec2 = d.sections[asi]
                      if (sec2.kind === 'table') sec2.rows[ri2][aLink] = v
                      apply(d)
                    }
                    const toItem = (r2: string[], ri2: number) => ({
                      key: ri2,
                      name: (r2[aRef] || '').trim(),
                      kind: aKindI >= 0 ? (r2[aKindI] || '').trim() : '',
                      notes: aNotes >= 0 ? (r2[aNotes] || '').trim() : '',
                    })
                    return {
                      linked: aSec.rows.map(toItem).filter((a, ri2) => a.name && (aSec.rows[ri2][aLink] || '').trim() === me),
                      options: aSec.rows.map(toItem).filter((a, ri2) => a.name && (aSec.rows[ri2][aLink] || '').trim() !== me),
                      link: (key: number) => setAudioLink(key, me),
                      unlink: (key: number) => setAudioLink(key, ''),
                    }
                  })()
                  return (
                    <div style={{ position: 'relative', border: '1px solid var(--line, #2a3142)', borderRadius: 10, padding: 14, marginTop: 10 }}>
                      {/* Exit lives top-right too — Done stays at the foot. */}
                      <button
                        type="button"
                        className="vp-var-close"
                        title="Close"
                        onClick={() => setExpanded(null)}
                        style={{ position: 'absolute', top: 10, right: 10, zIndex: 2 }}
                      >✕</button>
                      {row[refIdx].trim() !== '' ? (
                        <RefImagePanel
                          refId={row[refIdx].trim()}
                          kind={kindIdx >= 0 ? row[kindIdx] : ''}
                          linkedTo={(() => {
                            const li = section.columns.findIndex((c) => /linked/i.test(c))
                            return li >= 0 ? (row[li] || '').trim() : ''
                          })()}
                          onApprove={() => setExpanded(null)}
                          onLinkedToChange={(v) => {
                            const li = section.columns.findIndex((c) => /linked/i.test(c))
                            if (li >= 0) {
                              snapshot()
                              setCell(li, v)
                            }
                          }}
                          notes={descIdx !== refIdx ? row[descIdx] : ''}
                          notesLabel={descIdx !== refIdx ? section.columns[descIdx].toUpperCase() : ''}
                          fields={fieldRows}
                          kitIndex={kitIndex}
                          onNotesInput={(text) => {
                            if (descIdx === refIdx) return
                            setCell(descIdx, text)
                          }}
                          onNotesFocus={snapshot}
                          onDescribed={(text) => {
                            if (descIdx === refIdx) return
                            snapshot()
                            setCell(descIdx, row[descIdx].trim() ? `${row[descIdx].trim()}\n\n${text}` : text)
                          }}
                          onNotesChange={(text) => {
                            if (descIdx === refIdx) return
                            snapshot()
                            setCell(descIdx, text)
                          }}
                          onToast={toast}
                          onVariantCreated={(name, instruction) => {
                            const groupIdx = section.columns.findIndex((c) => /group/i.test(c))
                            appendRowToTable(
                              'Master variants',
                              ['Ref', 'Kind', 'Scope', 'Group', 'Variant of', 'Notes'],
                              [name, 'variant', 'episode-only', groupIdx >= 0 ? row[groupIdx] : '', row[refIdx].trim(), instruction.replace(/\|/g, '/')],
                            )
                          }}
                          onAudioAdd={(a) => {
                            appendRowToTable(
                              'Audio',
                              ['Ref', 'Kind', 'Scope', 'Linked to', 'Source', 'Notes'],
                              [a.name, a.kind, 'episode-only', a.linkedTo, a.source, a.notes.replace(/\|/g, '/')],
                            )
                          }}
                          linkedAudio={audioLinks?.linked}
                          audioOptions={audioLinks?.options}
                          onAudioLink={audioLinks?.link}
                          onAudioUnlink={audioLinks?.unlink}
                        />
                      ) : null}
                      {row[refIdx].trim() === '' ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{fieldRows}</div>
                      ) : null}
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}>
                            {!/^(voice|music|ambience|sfx|audio)\b/i.test(kindIdx >= 0 ? row[kindIdx] : '') && (
                              <button style={btn} onClick={() => setExpanded(null)}>Done</button>
                            )}
                            {confirmRemove === expanded ? (
                              <>
                                <span style={{ color: 'var(--amber)', fontSize: 12 }}>
                                  ⚠{' '}
                                  {isSharedScope(scope)
                                    ? 'This item is SHARED — removing it can affect the whole show/template and future episodes.'
                                    : 'Remove this episode-only item? Later steps that reference it will lose it.'}
                                </span>
                                <button
                                  style={{ ...btn, color: 'var(--red)', borderColor: 'var(--red)' }}
                                  onClick={() => {
                                    snapshot()
                                    const d = structuredClone(doc!)
                                    const sec = d.sections[si]
                                    if (sec.kind === 'table') sec.rows.splice(ri, 1)
                                    apply(d)
                                    setConfirmRemove(null)
                                    setExpanded(null)
                                  }}
                                >
                                  Remove
                                </button>
                                <button style={btn} onClick={() => setConfirmRemove(null)}>Keep</button>
                              </>
                            ) : (
                              <button style={{ ...btn, color: 'var(--ink-3)' }} onClick={() => setConfirmRemove(expanded)}>
                                ✕ Remove
                              </button>
                            )}
                          </div>
                    </div>
                  )
                })()}
              </>
            )}
          </div>
          )
        })
      )}
      <span style={{ display: 'block', marginTop: 4, color: 'var(--ink-3)', fontSize: 12 }}>
        ⬡ = shared with the show/template · saved to the engine on “Approve &amp; continue”
      </span>
      {libraryOpen && (
        <GlobalCharacterPicker
          existing={Object.keys(kitIndex)}
          onClose={() => setLibraryOpen(false)}
          onAdded={onLibraryAdded}
        />
      )}
    </div>
  )
}
