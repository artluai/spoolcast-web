import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

// HOUSE RULES: the canonical rule files every AI drafter works under, made
// visible and editable. The files stay the single source of truth (engine
// reads them fresh on every draft run — edits apply with no restart); this
// view is just a door to them. Scope tags show how far a rulebook reaches.

type RuleFile = { id: string; label: string; scope: 'global' | 'series'; file: string; content: string }

const SCOPE_LABEL: Record<string, string> = {
  global: 'every video',
  series: 'this series only',
}

// Which steps consult each rulebook (kept in sync with the drafters/gates —
// see DRAFT_SCRIPTS inputs and gate.py source lists).
const USED_BY: Record<string, string> = {
  rules: 'whole pipeline',
  story: 'structure · script',
  visuals: 'world kit · pacing · storyboard · images',
  'visual-pacing': 'pacing · storyboard',
}

export function RulesView() {
  const navigate = useNavigate()
  const params = useParams()
  const [rules, setRules] = useState<RuleFile[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string>('')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  useEffect(() => {
    fetch('http://localhost:8000/api/rules?session=spoolcast-dev-log-12')
      .then((r) => (r.ok ? r.json() : null))
      .then((out) => {
        if (out?.ok && Array.isArray(out.data?.rules)) {
          const list: RuleFile[] = out.data.rules
          setRules(list)
          // Deep link: ?focus=voice / ?focus=series-rules / a rule id —
          // arriving from a "read or edit" button lands on the right book.
          const focus = new URLSearchParams(window.location.search).get('focus')
          const target =
            focus === 'voice'
              ? list.find((r) => r.id.endsWith(':voice'))
              : focus === 'series-rules'
                ? list.find((r) => r.scope === 'series' && r.id.endsWith(':rules'))
                : list.find((r) => r.id === focus)
          if (target) setSelected(target.id)
          else if (list.length > 0) setSelected(list[0].id)
        } else setError('The engine did not return the rulebooks.')
      })
      .catch(() => setError('Could not reach the engine — is it running?'))
  }, [])

  const active = rules?.find((r) => r.id === selected) ?? null

  // Split the active file into its ## sections for the side nav + search.
  const sections = useMemo(() => {
    if (!active) return []
    const out: { title: string; body: string }[] = []
    const lines = active.content.split('\n')
    let title = '(intro)'
    let buf: string[] = []
    const flush = () => {
      if (buf.join('').trim()) out.push({ title, body: buf.join('\n') })
      buf = []
    }
    for (const line of lines) {
      if (line.startsWith('## ')) {
        flush()
        title = line.slice(3).trim()
        buf = [line]
      } else buf.push(line)
    }
    flush()
    return out
  }, [active])

  const q = search.trim().toLowerCase()
  const visibleSections = q
    ? sections.filter((s) => s.title.toLowerCase().includes(q) || s.body.toLowerCase().includes(q))
    : sections

  const startEdit = () => {
    if (!active) return
    setDraft(active.content)
    setEditing(true)
    setNote(null)
  }
  const save = async () => {
    if (!active) return
    setSaving(true)
    setNote(null)
    try {
      const res = await fetch('http://localhost:8000/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: 'spoolcast-dev-log-12',
          tenant: 'local',
          action: 'set_rule_file',
          rule_id: active.id,
          content: draft,
        }),
      })
      const out = await res.json().catch(() => null)
      if (!res.ok || out?.ok === false) {
        setNote(`Engine: ${out?.message || out?.error || 'could not save the rulebook.'}`)
        return
      }
      setRules((rs) => (rs ? rs.map((r) => (r.id === active.id ? { ...r, content: draft } : r)) : rs))
      setEditing(false)
      setNote('Saved — the next AI draft works under the updated rules.')
    } catch {
      setNote('Could not reach the engine.')
    } finally {
      setSaving(false)
    }
  }

  const chip: React.CSSProperties = {
    fontSize: 10, letterSpacing: '.05em', padding: '2px 8px', borderRadius: 99,
    border: '1px solid var(--line, #2a3142)', color: 'var(--ink-3)', whiteSpace: 'nowrap',
  }

  return (
    <section className="cast-view">
      <div className="cast-wrap">
        <div className="cast-head">
          <button className="back-btn" onClick={() => navigate(`/p/${params.id ?? 'dev-log-12'}`)}>←</button>
          <div>
            <div className="eyebrow">Project Wiki</div>
            <div className="title-row">
              <h1>The rulebooks the AI works under</h1>
            </div>
            <p>
              Every AI draft gets the relevant rulebook pasted into its instructions, and the
              validators enforce the checkable parts in code. Editing a rulebook here changes
              behavior from the very next draft — no restart needed.
            </p>
          </div>
        </div>

        {error ? <p style={{ color: 'var(--red)' }}>{error}</p> : null}
        {!rules && !error ? <p className="label">Loading the rulebooks from the engine…</p> : null}

        {rules ? (
          <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start' }}>
            {/* Left: rulebook list + section nav */}
            <div style={{ width: 260, flexShrink: 0, position: 'sticky', top: 16 }}>
              {rules.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => { setSelected(r.id); setEditing(false); setNote(null); setSearch('') }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                    background: r.id === selected ? 'var(--bg-3, rgba(255,255,255,.04))' : 'none',
                    border: 'none', borderLeft: r.id === selected ? '2px solid var(--ink-2)' : '2px solid transparent',
                    color: r.id === selected ? 'var(--ink)' : 'var(--ink-2)',
                    padding: '8px 10px', cursor: 'pointer', textAlign: 'left', fontSize: 13,
                  }}
                >
                  <span style={{ flex: 1 }}>
                    {r.label}
                    {USED_BY[r.id] ? (
                      <span style={{ display: 'block', color: 'var(--ink-3)', fontSize: 11 }}>{USED_BY[r.id]}</span>
                    ) : null}
                  </span>
                  <span style={chip}>{SCOPE_LABEL[r.scope]}</span>
                </button>
              ))}
              {active && !editing ? (
                <>
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search this rulebook…"
                    style={{
                      width: '100%', boxSizing: 'border-box', margin: '14px 0 6px',
                      background: 'rgba(255,255,255,.02)', color: 'var(--ink-1)',
                      border: '1px solid var(--line, #2a3142)', borderRadius: 6,
                      padding: '7px 10px', fontSize: 12,
                    }}
                  />
                  {sections.map((s, i) =>
                    visibleSections.includes(s) ? (
                      <button
                        key={i}
                        type="button"
                        onClick={() => document.getElementById(`rule-sec-${i}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                        style={{
                          display: 'block', width: '100%', background: 'none', border: 'none',
                          color: 'var(--ink-3)', padding: '3px 10px', cursor: 'pointer',
                          textAlign: 'left', fontSize: 12,
                        }}
                      >
                        {s.title}
                      </button>
                    ) : null,
                  )}
                </>
              ) : null}
            </div>

            {/* Right: the rulebook itself */}
            <div style={{ flex: 1, minWidth: 0 }}>
              {active ? (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                    <code style={{ color: 'var(--ink-3)', fontSize: 12 }}>{active.file}</code>
                    <span style={chip}>{SCOPE_LABEL[active.scope]}</span>
                    <span style={{ flex: 1 }} />
                    {editing ? (
                      <>
                        <button className="vp-undo" type="button" disabled={saving} onClick={save}>
                          {saving ? 'Saving…' : 'Save rulebook'}
                        </button>
                        <button className="vp-undo" type="button" onClick={() => setEditing(false)}>Cancel</button>
                      </>
                    ) : (
                      <button className="vp-undo" type="button" title="Edit the exact file the drafters read" onClick={startEdit}>
                        Edit as text
                      </button>
                    )}
                  </div>
                  {note ? <p className="label" style={{ margin: '0 0 10px' }}>{note}</p> : null}
                  {editing ? (
                    <textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      style={{
                        width: '100%', minHeight: '70vh', minWidth: 360, maxWidth: '100%', resize: 'both', boxSizing: 'border-box',
                        background: 'transparent', color: 'var(--ink-1, inherit)',
                        border: '1px solid var(--line, #2a3142)', borderRadius: 8, padding: 12,
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                        fontSize: 13, lineHeight: 1.55,
                      }}
                    />
                  ) : (
                    visibleSections.map((s) => {
                      const i = sections.indexOf(s)
                      return (
                        <div
                          key={i}
                          id={`rule-sec-${i}`}
                          className="md-preview"
                          style={{ borderBottom: '1px solid var(--line, #2a3142)', padding: '4px 0 12px', marginBottom: 12 }}
                          dangerouslySetInnerHTML={{
                            __html: DOMPurify.sanitize(marked.parse(s.body, { async: false }) as string),
                          }}
                        />
                      )
                    })
                  )}
                  {!editing && q && visibleSections.length === 0 ? (
                    <p className="label">No sections match “{search}”.</p>
                  ) : null}
                </>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  )
}
