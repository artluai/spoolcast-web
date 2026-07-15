import { useEffect, useRef, useState } from 'react'
import { castByShow } from '../../data/cast'
import { parseWorldKit, serializeWorldKit, type WKDoc } from '../../lib/worldkit-md'
import { actionUrl, activeSession, apiUrl, contentUrl } from '../../lib/api'
import { RefImagePanel } from './RefImagePanel'
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

export function WorldKitEditor({ stageId, path, onToast }: { stageId: string; path: string; onToast?: (m: string) => void }) {
  // Toast plumbing is optional here (StageDraftEditor doesn't thread it yet) —
  // fall back to a console note rather than swallowing feedback.
  const toast = onToast ?? ((m: string) => console.info('[world-kit]', m))
  const draft = useWorkflowStore((s) => s.stageDrafts[stageId] ?? '')
  const setStageDraft = useWorkflowStore((s) => s.setStageDraft)
  const seedStageDraft = useWorkflowStore((s) => s.seedStageDraft)
  const historyRef = useRef<string[]>([])
  const redoRef = useRef<string[]>([])
  const [historyLen, setHistoryLen] = useState(0)
  const [redoLen, setRedoLen] = useState(0)
  const [raw, setRaw] = useState(false)
  // HOLD MY PLACE: which item is expanded survives hopping to other steps
  // (module memory — the component unmounts when the user leaves the step).
  const memKey = `${activeSession()}:${stageId}`
  const [expanded, setExpandedState] = useState<string | null>(() => EXPANDED_MEMORY[memKey] ?? null) // `${si}:${ri}`
  const setExpanded = (v: string | null) => {
    EXPANDED_MEMORY[memKey] = v
    setExpandedState(v)
  }
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
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

  if (!draft.trim()) {
    return <span className="label">Loading the inherited kit from the engine…</span>
  }

  let doc: WKDoc | null = null
  try {
    doc = parseWorldKit(draft)
  } catch {
    doc = null
  }
  const parseFailed = !doc || doc.sections.length === 0
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

  const snapshot = () => {
    historyRef.current.push(draft)
    if (historyRef.current.length > 50) historyRef.current.shift()
    redoRef.current = []
    setHistoryLen(historyRef.current.length)
    setRedoLen(0)
  }
  const undo = () => {
    const prev = historyRef.current.pop()
    if (prev != null) {
      redoRef.current.push(draft)
      if (redoRef.current.length > 50) redoRef.current.shift()
      setStageDraft(stageId, prev)
    }
    setHistoryLen(historyRef.current.length)
    setRedoLen(redoRef.current.length)
  }
  const redo = () => {
    const next = redoRef.current.pop()
    if (next != null) {
      historyRef.current.push(draft)
      if (historyRef.current.length > 50) historyRef.current.shift()
      setStageDraft(stageId, next)
    }
    setHistoryLen(historyRef.current.length)
    setRedoLen(redoRef.current.length)
  }
  const reset = async () => {
    // Reset to default = re-import the inherited kit (shared items only),
    // discarding every local edit and episode-only addition.
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
  }
  const apply = (d: WKDoc) => setStageDraft(stageId, serializeWorldKit(d))

  // Cast reference images from the show data, matched by ref id.
  const castImages: Record<string, string> = {}
  for (const show of Object.values(castByShow)) {
    for (const c of show.chars) castImages[c.ref] = c.img
  }

  const btn: React.CSSProperties = {
    background: 'none',
    border: '1px solid var(--line, #2a3142)',
    borderRadius: 6,
    color: 'var(--ink-2)',
    padding: '6px 12px',
    cursor: 'pointer',
    fontSize: 12,
  }
  const chip: React.CSSProperties = {
    background: 'rgba(255,255,255,.04)',
    border: '1px solid var(--line, #2a3142)',
    borderRadius: 8,
    color: 'var(--ink-1)',
    padding: '8px 14px',
    cursor: 'pointer',
    fontSize: 13,
  }

  return (
    <div style={{ marginTop: 4 }}>
      {/* HEADER: undo / reset to default / raw */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span className="label">{path}</span>
        <span style={{ flex: 1 }} />
        <button style={{ ...btn, opacity: historyLen ? 1 : 0.4 }} disabled={!historyLen} onClick={undo}>
          ↩ Undo
        </button>
        <button style={{ ...btn, opacity: redoLen ? 1 : 0.4 }} disabled={!redoLen} onClick={redo}>
          ↪ Redo
        </button>
        <button style={btn} onClick={reset} title="Discard all edits and re-import the show's shared items">
          Reset to default
        </button>
        <button style={btn} onClick={() => setRaw((v) => !v)}>
          {raw ? 'Formatted' : 'Raw .md'}
        </button>
      </div>

      {raw || parseFailed ? (
        <textarea
          value={draft}
          onFocus={snapshot}
          onChange={(e) => setStageDraft(stageId, e.target.value)}
          style={{
            width: '100%', minHeight: 320, resize: 'vertical', background: 'transparent',
            color: 'var(--ink-1, inherit)', border: '1px solid var(--line, #2a3142)', borderRadius: 8,
            padding: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13, lineHeight: 1.55,
          }}
        />
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
                  /ref/i.test(c) ? 'new-item' : /kind/i.test(c) ? 'prop' : /scope/i.test(c) ? 'episode-only' : '',
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
                rows={Math.max(2, section.text.split('\n').length)}
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
                    const scopeIdx = section.columns.findIndex((c) => /scope/i.test(c))
                    const descIdx = section.columns.length - 1
                    const key = `${si}:${ri}`
                    const shared = scopeIdx >= 0 && isSharedScope(row[scopeIdx])
                    const img = castImages[row[refIdx]] ?? (activeRefImages[row[refIdx]] ? contentUrl(activeRefImages[row[refIdx]]) : undefined)
                    if (img) {
                      // CHARACTER SHEET CARD: reference image + name + prompt excerpt
                      return (
                        <button
                          key={key}
                          onClick={() => setExpanded(expanded === key ? null : key)}
                          title={shared ? 'Shared with the show/template' : 'This episode only'}
                          style={{
                            width: 170,
                            textAlign: 'left',
                            background: 'rgba(255,255,255,.03)',
                            border: `1px solid ${expanded === key ? 'var(--ink-2)' : 'var(--line, #2a3142)'}`,
                            borderRadius: 10,
                            padding: 0,
                            cursor: 'pointer',
                            overflow: 'hidden',
                          }}
                        >
                          <img src={img} alt="" style={{ width: '100%', height: 150, objectFit: 'cover', display: 'block' }} />
                          <span style={{ display: 'block', padding: '8px 10px 2px', color: 'var(--ink-1)', fontSize: 13, fontWeight: 600 }}>
                            {row[refIdx]}
                            {shared && <span style={{ color: 'var(--amber)', marginLeft: 6 }}>⬡</span>}
                          </span>
                          <span
                            style={{
                              display: '-webkit-box',
                              WebkitLineClamp: 2,
                              WebkitBoxOrient: 'vertical',
                              overflow: 'hidden',
                              padding: '0 10px 10px',
                              color: 'var(--ink-3)',
                              fontSize: 12,
                              lineHeight: 1.4,
                            }}
                          >
                            {row[descIdx]}
                          </span>
                        </button>
                      )
                    }
                    return (
                      <button
                        key={key}
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
                                  style={{
                                    display: 'block', background: 'transparent',
                                    color: isSharedScope(scope) ? 'var(--amber)' : 'var(--ink-2)',
                                    border: '1px solid var(--line, #2a3142)', borderRadius: 6, padding: '6px 8px', fontSize: 12, marginTop: 3,
                                  }}
                                >
                                  {!scopeKnown && <option value={scope}>{scope}</option>}
                                  {SCOPE_OPTIONS.map((o) => (
                                    <option key={o.value} value={o.value}>{o.label}</option>
                                  ))}
                                </select>
                              </label>
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
                  return (
                    <div style={{ border: '1px solid var(--line, #2a3142)', borderRadius: 10, padding: 14, marginTop: 10 }}>
                      {row[refIdx].trim() !== '' ? (
                        <RefImagePanel
                          refId={row[refIdx].trim()}
                          kind={kindIdx >= 0 ? row[kindIdx] : ''}
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
                        />
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{fieldRows}</div>
                      )}
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}>
                            <button style={btn} onClick={() => setExpanded(null)}>Done</button>
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
    </div>
  )
}
