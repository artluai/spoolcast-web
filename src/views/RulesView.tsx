import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { appendUserRule, removeUserRules, saveRuleContent, USER_RULES_HEADER } from '../lib/rules'

// Split a section body into prose chunks and individual bullet rules, so each
// rule can get its own hover actions (edit / remove) while prose stays prose.
type Block = { kind: 'md' | 'rule'; text: string }
function parseBlocks(body: string): Block[] {
  const lines = body.split('\n')
  const blocks: Block[] = []
  let buf: string[] = []
  const flush = () => {
    if (buf.length) {
      blocks.push({ kind: 'md', text: buf.join('\n') })
      buf = []
    }
  }
  let i = 0
  while (i < lines.length) {
    if (/^\s*[-*]\s+/.test(lines[i])) {
      flush()
      const rule = [lines[i]]
      i += 1
      while (i < lines.length && /^\s{2,}\S/.test(lines[i])) {
        rule.push(lines[i])
        i += 1
      }
      blocks.push({ kind: 'rule', text: rule.join('\n') })
    } else {
      buf.push(lines[i])
      i += 1
    }
  }
  flush()
  return blocks
}

const flattenRule = (raw: string) => raw.replace(/^\s*[-*]\s+/, '').replace(/\n\s+/g, ' ').trim()

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
  // Quick "Add rule": one input, lands under '## User-added rules' in the
  // open rulebook — no raw-markdown editing required.
  const [adding, setAdding] = useState(false)
  const [newRule, setNewRule] = useState('')
  const [savingRule, setSavingRule] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  // Per-rule hover actions: edit one bullet in place, or remove just it.
  const [hoverRule, setHoverRule] = useState<string | null>(null)
  const [ruleEdit, setRuleEdit] = useState<{ si: number; bi: number; text: string } | null>(null)
  const saveBlocks = async (si: number, mutate: (blocks: Block[]) => Block[] | null) => {
    if (!active) return
    const blocks = mutate(parseBlocks(sections[si].body))
    if (blocks === null) return
    const newBody = blocks.map((b) => b.text).join('\n')
    const content = sections.map((s, i) => (i === si ? newBody : s.body)).join('\n')
    setSavingRule(true)
    setNote(null)
    const res = await saveRuleContent(active.id, content)
    if (!res.ok) setNote(res.error)
    else setRules((rs) => (rs ? rs.map((r) => (r.id === active.id ? { ...r, content: res.content } : r)) : rs))
    setSavingRule(false)
    setRuleEdit(null)
  }
  const saveRuleEdit = () => {
    if (!ruleEdit) return
    const text = ruleEdit.text.trim().replace(/\s*\n+\s*/g, ' ')
    void saveBlocks(ruleEdit.si, (blocks) => {
      if (!text) return null
      const next = [...blocks]
      next[ruleEdit.bi] = { kind: 'rule', text: `- ${text}` }
      return next
    })
  }
  const removeRule = (si: number, bi: number) => {
    void saveBlocks(si, (blocks) => blocks.filter((_, i) => i !== bi))
  }
  const addRule = async () => {
    if (!active || !newRule.trim()) return
    setSavingRule(true)
    setNote(null)
    const res = await appendUserRule(active.id, newRule)
    if (!res.ok) {
      setNote(res.error)
    } else {
      setRules((rs) => (rs ? rs.map((r) => (r.id === active.id ? { ...r, content: res.content } : r)) : rs))
      setNewRule('')
      setAdding(false)
      setNote('Rule added — every AI draft from now on works under it.')
    }
    setSavingRule(false)
  }
  const resetUserRules = async () => {
    if (!active) return
    setSavingRule(true)
    setNote(null)
    const res = await removeUserRules(active.id)
    if (!res.ok) setNote(res.error)
    else {
      setRules((rs) => (rs ? rs.map((r) => (r.id === active.id ? { ...r, content: res.content } : r)) : rs))
      setNote('User-added rules removed — back to the rulebook’s defaults.')
    }
    setConfirmReset(false)
    setSavingRule(false)
  }

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
                      <>
                        <button className="vp-undo" type="button" title="Add one rule to this rulebook — no file editing needed" onClick={() => setAdding((v) => !v)}>
                          + Add rule
                        </button>
                        {active.content.includes(USER_RULES_HEADER) ? (
                          <button
                            className="vp-undo"
                            type="button"
                            disabled={savingRule}
                            style={confirmReset ? { color: 'var(--amber)' } : undefined}
                            title="Removes every user-added rule from this rulebook (the built-in rules stay)"
                            onClick={() => (confirmReset ? resetUserRules() : setConfirmReset(true))}
                            onBlur={() => setConfirmReset(false)}
                          >
                            {confirmReset ? 'Really remove user rules?' : 'Set to default'}
                          </button>
                        ) : null}
                        <button className="vp-undo" type="button" title="Edit the exact file the drafters read" onClick={startEdit}>
                          Edit as text
                        </button>
                      </>
                    )}
                  </div>
                  {adding && !editing ? (
                    <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                      <input
                        autoFocus
                        value={newRule}
                        onChange={(e) => setNewRule(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') addRule() }}
                        placeholder="Write the rule in plain words — e.g. “Always bridge the cold open into the intro with one sentence.”"
                        style={{
                          flex: 1, background: 'rgba(255,255,255,.02)', color: 'var(--ink-1)',
                          border: '1px dashed var(--line, #2a3142)', borderRadius: 8,
                          padding: '9px 12px', fontSize: 13,
                        }}
                      />
                      <button className="vp-undo" type="button" disabled={savingRule || !newRule.trim()} onClick={addRule}>
                        {savingRule ? 'Adding…' : 'Add'}
                      </button>
                    </div>
                  ) : null}
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
                      const blocks = parseBlocks(s.body)
                      return (
                        <div
                          key={i}
                          id={`rule-sec-${i}`}
                          style={{ borderBottom: '1px solid var(--line, #2a3142)', padding: '4px 0 12px', marginBottom: 12 }}
                        >
                          {blocks.map((b, bi) =>
                            b.kind === 'md' ? (
                              b.text.trim() ? (
                                <div
                                  key={bi}
                                  className="md-preview"
                                  dangerouslySetInnerHTML={{
                                    __html: DOMPurify.sanitize(marked.parse(b.text, { async: false }) as string),
                                  }}
                                />
                              ) : null
                            ) : ruleEdit && ruleEdit.si === i && ruleEdit.bi === bi ? (
                              // EDIT THIS RULE in place
                              <div key={bi} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', margin: '4px 0' }}>
                                <textarea
                                  autoFocus
                                  rows={2}
                                  value={ruleEdit.text}
                                  onChange={(e) => setRuleEdit((d) => (d ? { ...d, text: e.target.value } : d))}
                                  style={{
                                    flex: 1, background: 'rgba(255,255,255,.02)', color: 'var(--ink-1)',
                                    border: '1px dashed var(--line, #2a3142)', borderRadius: 8,
                                    padding: '8px 10px', fontSize: 13, lineHeight: 1.5, resize: 'vertical',
                                  }}
                                />
                                <button className="vp-undo" type="button" disabled={savingRule} onClick={saveRuleEdit}>
                                  {savingRule ? 'Saving…' : 'Save'}
                                </button>
                                <button className="vp-undo" type="button" onClick={() => setRuleEdit(null)}>Cancel</button>
                              </div>
                            ) : (
                              // ONE RULE — hover for edit/remove
                              <div
                                key={bi}
                                onMouseEnter={() => setHoverRule(`${i}:${bi}`)}
                                onMouseLeave={() => setHoverRule(null)}
                                style={{ position: 'relative', paddingRight: 64 }}
                              >
                                <div
                                  className="md-preview"
                                  dangerouslySetInnerHTML={{
                                    __html: DOMPurify.sanitize(marked.parse(b.text, { async: false }) as string),
                                  }}
                                />
                                {hoverRule === `${i}:${bi}` ? (
                                  <span style={{ position: 'absolute', right: 0, top: 4, display: 'inline-flex', gap: 4 }}>
                                    <button
                                      type="button"
                                      className="vp-undo"
                                      title="Edit just this rule"
                                      style={{ padding: '2px 8px', fontSize: 11 }}
                                      onClick={() => setRuleEdit({ si: i, bi, text: flattenRule(b.text) })}
                                    >
                                      ✎
                                    </button>
                                    <button
                                      type="button"
                                      className="vp-undo"
                                      title="Remove just this rule"
                                      style={{ padding: '2px 8px', fontSize: 11 }}
                                      disabled={savingRule}
                                      onClick={() => removeRule(i, bi)}
                                    >
                                      ✕
                                    </button>
                                  </span>
                                ) : null}
                              </div>
                            ),
                          )}
                        </div>
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
