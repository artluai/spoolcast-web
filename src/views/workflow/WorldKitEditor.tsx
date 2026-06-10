import { useRef, useState } from 'react'
import { parseWorldKit, serializeWorldKit, type WKDoc } from '../../lib/worldkit-md'
import { useWorkflowStore } from '../../store/workflow'

const SCOPES = ['episode-only', 'show-shared', 'template-shared']
const isSharedScope = (scope: string) => /show|template|format/i.test(scope)

/**
 * Structured editor over the world-kit.md draft: every item (cast, environment,
 * prop, reference) is an editable card with its prompt description; items can be
 * added/removed (removal warns — shared-scope items may affect the whole show or
 * template); Undo and Reset-to-default live in the header. All edits serialize
 * back to the same markdown the engine reads.
 */
export function WorldKitEditor({ stageId, path }: { stageId: string; path: string }) {
  const draft = useWorkflowStore((s) => s.stageDrafts[stageId] ?? '')
  const setStageDraft = useWorkflowStore((s) => s.setStageDraft)
  const historyRef = useRef<string[]>([])
  const [historyLen, setHistoryLen] = useState(0)
  const [raw, setRaw] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null) // `${sectionIdx}:${rowIdx}`

  if (!draft.trim()) return null

  let doc: WKDoc | null = null
  try {
    doc = parseWorldKit(draft)
  } catch {
    doc = null
  }
  const parseFailed = !doc || doc.sections.length === 0

  // UNDO: snapshot the markdown before each mutation (on focus for typing, at
  // action time for add/remove/reset), capped at 50 entries.
  const snapshot = () => {
    historyRef.current.push(draft)
    if (historyRef.current.length > 50) historyRef.current.shift()
    setHistoryLen(historyRef.current.length)
  }
  const undo = () => {
    const prev = historyRef.current.pop()
    setHistoryLen(historyRef.current.length)
    if (prev != null) setStageDraft(stageId, prev)
  }
  // RESET TO DEFAULT: discard local edits, reload the kit as last saved to the
  // engine (the on-disk file).
  const reset = async () => {
    snapshot()
    try {
      const r = await fetch(
        `http://localhost:8000/api/file?session=spoolcast-dev-log-12&path=${encodeURIComponent(path)}`,
      )
      const out = await r.json().catch(() => null)
      if (out?.ok && out.data?.exists && typeof out.data.content === 'string') {
        setStageDraft(stageId, out.data.content)
      }
    } catch {
      /* engine offline — keep current draft */
    }
  }
  const apply = (d: WKDoc) => setStageDraft(stageId, serializeWorldKit(d))

  const headerBtn: React.CSSProperties = {
    background: 'none',
    border: '1px solid var(--line, #2a3142)',
    borderRadius: 6,
    color: 'var(--ink-2)',
    padding: '6px 12px',
    cursor: 'pointer',
    fontSize: 12,
  }

  return (
    <div style={{ marginTop: 4 }}>
      {/* HEADER: undo / reset / raw toggle */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span className="label">{path}</span>
        <span style={{ flex: 1 }} />
        <button style={{ ...headerBtn, opacity: historyLen ? 1 : 0.4 }} disabled={!historyLen} onClick={undo}>
          ↩ Undo
        </button>
        <button style={headerBtn} onClick={reset} title="Discard edits and reload the kit as last saved to the engine">
          Reset to default
        </button>
        <button style={headerBtn} onClick={() => setRaw((v) => !v)}>
          {raw ? 'Formatted' : 'Raw .md'}
        </button>
      </div>

      {raw || parseFailed ? (
        <textarea
          value={draft}
          onFocus={snapshot}
          onChange={(e) => setStageDraft(stageId, e.target.value)}
          style={{
            width: '100%',
            minHeight: 320,
            resize: 'vertical',
            background: 'transparent',
            color: 'var(--ink-1, inherit)',
            border: '1px solid var(--line, #2a3142)',
            borderRadius: 8,
            padding: 12,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 13,
            lineHeight: 1.55,
          }}
        />
      ) : (
        doc!.sections.map((section, si) => (
          <div key={si} style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <h3 style={{ margin: 0, fontSize: 14 }}>{section.heading}</h3>
              {section.kind === 'table' && (
                <button
                  style={{ ...headerBtn, padding: '3px 10px' }}
                  onClick={() => {
                    snapshot()
                    const d = structuredClone(doc!)
                    const sec = d.sections[si]
                    if (sec.kind !== 'table') return
                    sec.rows.push(
                      sec.columns.map((c) =>
                        /ref/i.test(c) ? 'new-item' : /kind/i.test(c) ? 'prop' : /scope/i.test(c) ? 'episode-only' : '',
                      ),
                    )
                    apply(d)
                  }}
                >
                  + Add
                </button>
              )}
            </div>

            {section.kind === 'text' ? (
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
                  width: '100%',
                  resize: 'vertical',
                  background: 'transparent',
                  color: 'var(--ink-2)',
                  border: '1px solid var(--line, #2a3142)',
                  borderRadius: 8,
                  padding: 10,
                  fontSize: 13,
                  lineHeight: 1.5,
                }}
              />
            ) : (
              section.rows.map((row, ri) => {
                const refIdx = section.columns.findIndex((c) => /ref/i.test(c))
                const scopeIdx = section.columns.findIndex((c) => /scope/i.test(c))
                const descIdx = section.columns.length - 1
                const key = `${si}:${ri}`
                const scope = scopeIdx >= 0 ? row[scopeIdx] : ''
                return (
                  <div
                    key={key}
                    style={{
                      display: 'flex',
                      gap: 8,
                      alignItems: 'flex-start',
                      border: '1px solid var(--line, #2a3142)',
                      borderRadius: 8,
                      padding: 10,
                      marginBottom: 8,
                      flexWrap: 'wrap',
                    }}
                  >
                    {section.columns.map((_col, ci) => {
                      const set = (v: string) => {
                        const d = structuredClone(doc!)
                        const sec = d.sections[si]
                        if (sec.kind === 'table') sec.rows[ri][ci] = v
                        apply(d)
                      }
                      if (ci === scopeIdx) {
                        const opts = SCOPES.includes(row[ci]) ? SCOPES : [row[ci], ...SCOPES]
                        return (
                          <select
                            key={ci}
                            value={row[ci]}
                            onFocus={snapshot}
                            onChange={(e) => set(e.target.value)}
                            title="Scope — shared items affect other episodes"
                            style={{
                              background: 'transparent',
                              color: isSharedScope(row[ci]) ? 'var(--amber)' : 'var(--ink-2)',
                              border: '1px solid var(--line, #2a3142)',
                              borderRadius: 6,
                              padding: '6px 8px',
                              fontSize: 12,
                            }}
                          >
                            {opts.map((o) => (
                              <option key={o} value={o}>{o}</option>
                            ))}
                          </select>
                        )
                      }
                      if (ci === descIdx && descIdx !== refIdx) {
                        return (
                          <textarea
                            key={ci}
                            value={row[ci]}
                            onFocus={snapshot}
                            onChange={(e) => set(e.target.value)}
                            placeholder={section.columns[ci]}
                            rows={2}
                            title={`${section.columns[ci]} — the prompt description used for image generation`}
                            style={{
                              flex: '1 1 260px',
                              resize: 'vertical',
                              background: 'transparent',
                              color: 'var(--ink-2)',
                              border: '1px solid var(--line, #2a3142)',
                              borderRadius: 6,
                              padding: '6px 8px',
                              fontSize: 13,
                              lineHeight: 1.5,
                            }}
                          />
                        )
                      }
                      return (
                        <input
                          key={ci}
                          value={row[ci]}
                          onFocus={snapshot}
                          onChange={(e) => set(e.target.value)}
                          placeholder={section.columns[ci]}
                          style={{
                            width: ci === refIdx ? 140 : 110,
                            background: 'transparent',
                            color: ci === refIdx ? 'var(--ink-1)' : 'var(--ink-2)',
                            border: '1px solid var(--line, #2a3142)',
                            borderRadius: 6,
                            padding: '6px 8px',
                            fontSize: 13,
                            fontFamily: ci === refIdx ? 'ui-monospace, Menlo, monospace' : undefined,
                          }}
                        />
                      )
                    })}
                    {confirmRemove === key ? (
                      <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexBasis: '100%' }}>
                        <span style={{ color: 'var(--amber)', fontSize: 12 }}>
                          ⚠ Remove “{refIdx >= 0 ? row[refIdx] : 'item'}”?{' '}
                          {isSharedScope(scope)
                            ? 'This item is SHARED — removing it can affect the whole show/template and future episodes.'
                            : 'Episode-only item; later steps that reference it will lose it.'}
                        </span>
                        <button
                          style={{ ...headerBtn, color: 'var(--red)', borderColor: 'var(--red)' }}
                          onClick={() => {
                            snapshot()
                            const d = structuredClone(doc!)
                            const sec = d.sections[si]
                            if (sec.kind === 'table') sec.rows.splice(ri, 1)
                            apply(d)
                            setConfirmRemove(null)
                          }}
                        >
                          Remove
                        </button>
                        <button style={headerBtn} onClick={() => setConfirmRemove(null)}>
                          Keep
                        </button>
                      </span>
                    ) : (
                      <button
                        title="Remove this item"
                        onClick={() => setConfirmRemove(key)}
                        style={{ ...headerBtn, padding: '6px 9px', color: 'var(--ink-3)' }}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                )
              })
            )}
          </div>
        ))
      )}
      <span className="label" style={{ display: 'block', marginTop: 4 }}>
        Saved to the engine on “Approve & continue”. Descriptions are the prompts used for image generation.
      </span>
    </div>
  )
}
