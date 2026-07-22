import { useEffect, useState } from 'react'
import { postAction } from '../../lib/api'

// SCOPED STEP RULES — the STEERING side of the quality system (ChecksPanel is
// the grading side). Every rule here rides inside every AI draft this step
// runs, injected engine-side by scripts/step_rules.py — one loader, so no
// drafter can silently drop its rules. Scopes mirror checks: template (all
// videos of this kind) / series / this video, with per-video on/off.
type Rule = { id: string; text: string; step: string; scope: 'template' | 'series' | 'video'; enabled: boolean }

const SCOPE_LABEL: Record<Rule['scope'], string> = {
  template: 'all videos of this kind',
  series: 'this series',
  video: 'this video only',
}

const slugify = (t: string) =>
  t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'rule'

export function RulesPanel({ step, onToast, title }: { step: string; onToast?: (m: string) => void; title?: string }) {
  const [open, setOpen] = useState(false)
  const [rules, setRules] = useState<Rule[] | null>(null)
  const [newText, setNewText] = useState('')
  const [newScope, setNewScope] = useState<Rule['scope']>('series')
  const [editing, setEditing] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [suggesting, setSuggesting] = useState(false)
  const [suggestions, setSuggestions] = useState<{ id: string; text: string }[]>([])

  const load = () =>
    postAction<{ rules?: Rule[] }>({ action: 'get_rules', step }).then((out) => {
      if (out?.ok) setRules(out.data?.rules ?? [])
    })
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  const smallBtn: React.CSSProperties = {
    background: 'var(--bg-3)', border: '1px solid var(--line-2)', color: 'var(--ink-2)',
    borderRadius: 6, padding: '4px 9px', fontSize: 11.5, cursor: 'pointer',
  }

  const setEnabled = async (r: Rule, enabled: boolean) => {
    setRules((rs) => rs?.map((x) => (x.id === r.id ? { ...x, enabled } : x)) ?? rs)
    await postAction({ action: 'set_rule_enabled', id: r.id, enabled })
  }
  const remove = async (r: Rule) => {
    setRules((rs) => rs?.filter((x) => x.id !== r.id) ?? rs)
    await postAction({ action: 'remove_rule', scope: r.scope, id: r.id })
  }
  const saveEdit = async (r: Rule) => {
    const text = editText.trim()
    setEditing(null)
    if (!text || text === r.text) return
    setRules((rs) => rs?.map((x) => (x.id === r.id ? { ...x, text } : x)) ?? rs)
    await postAction({ action: 'set_rule', scope: r.scope, id: r.id, step, text })
  }
  const add = async (text: string, scope: Rule['scope']) => {
    const t = text.trim()
    if (!t) return
    const out = await postAction({ action: 'set_rule', scope, id: slugify(t), step, text: t })
    if (out?.ok) await load()
    else onToast?.(`Engine: ${out?.error || 'could not save the rule.'}`)
  }

  const suggest = async () => {
    setSuggesting(true)
    const out = await postAction<{ suggestions?: { id: string; text: string }[] }>({ action: 'suggest_rules', step, allow_cost: true })
    setSuggesting(false)
    if (out?.ok) setSuggestions(out.data?.suggestions ?? [])
    else onToast?.(`Engine: ${out?.error || out?.message || 'could not suggest rules.'}`)
  }

  const onCount = rules?.filter((r) => r.enabled).length ?? 0
  const label = () => ({
    background: 'none', border: 'none', padding: 0, cursor: 'pointer',
    fontSize: 10, letterSpacing: '.1em', color: 'var(--ink-3)', fontFamily: 'var(--mono)',
    display: 'inline-flex', gap: 6, alignItems: 'center',
  }) as React.CSSProperties

  if (!open) {
    return (
      <div style={{ marginTop: 14 }}>
        <button type="button" onClick={() => setOpen(true)} style={label()}>
          <span style={{ fontSize: 10 }}>▸</span> {title ?? 'RULES FOR THIS STEP'}{rules ? ` (${onCount} ON)` : ''}
        </button>
      </div>
    )
  }

  return (
    <div style={{ marginTop: 14 }}>
      <button type="button" onClick={() => setOpen(false)} style={{ ...label(), marginBottom: 8 }}>
        <span style={{ fontSize: 10 }}>▾</span> {title ?? 'RULES FOR THIS STEP'} — EVERY AI DRAFT HERE OBEYS THEM
      </button>
      {rules === null ? (
        <div style={{ fontSize: 12, color: 'var(--ink-3)' }}><span className="spin" /> Loading…</div>
      ) : rules.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginBottom: 8 }}>
          Rules you add here steer every AI draft of this step, and the review holds the result to
          them. Save one for this video, the series, or every video of this kind.
        </div>
      ) : (
        rules.map((r) => (
          <div key={`${r.scope}:${r.id}`} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 6 }}>
            <input
              type="checkbox"
              checked={r.enabled}
              title={r.enabled ? 'On for this video — uncheck to skip it here (other videos unaffected)' : 'Off for this video'}
              onChange={(e) => void setEnabled(r, e.target.checked)}
              style={{ accentColor: 'var(--ink-2)', margin: '3px 0 0' }}
            />
            {editing === r.id ? (
              <input
                autoFocus
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                onBlur={() => void saveEdit(r)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveEdit(r)
                  if (e.key === 'Escape') setEditing(null)
                }}
                style={{
                  flex: 1, background: 'transparent', color: 'var(--ink-1)', fontSize: 12.5,
                  border: '1px solid var(--line, #2a3142)', borderRadius: 5, padding: '3px 7px',
                }}
              />
            ) : (
              <span
                title="Click to edit (edits apply everywhere this rule is used)"
                onClick={() => {
                  setEditing(r.id)
                  setEditText(r.text)
                }}
                style={{ flex: 1, fontSize: 12.5, lineHeight: 1.5, cursor: 'text', color: r.enabled ? 'var(--ink-2)' : 'var(--ink-3)' }}
              >
                {r.text}
              </span>
            )}
            <span style={{ fontSize: 10, color: 'var(--ink-3)', fontFamily: 'var(--mono)', whiteSpace: 'nowrap', marginTop: 3 }}>
              {SCOPE_LABEL[r.scope]}
            </span>
            <button
              type="button"
              title={`Delete this rule for ${SCOPE_LABEL[r.scope]} — to skip it just for this video, uncheck it instead`}
              onClick={() => void remove(r)}
              style={{ background: 'none', border: 'none', color: 'var(--ink-3)', cursor: 'pointer', fontSize: 12, padding: '0 2px' }}
            >
              ×
            </button>
          </div>
        ))
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}>
        <input
          value={newText}
          onChange={(e) => setNewText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              void add(newText, newScope)
              setNewText('')
            }
          }}
          placeholder="Add a rule the AI must follow on this step…"
          style={{
            flex: '1 1 260px', background: 'transparent', color: 'var(--ink-2)', fontSize: 12.5,
            border: '1px solid var(--line, #2a3142)', borderRadius: 6, padding: '6px 9px',
          }}
        />
        <select
          value={newScope}
          onChange={(e) => setNewScope(e.target.value as Rule['scope'])}
          style={{ background: 'var(--bg-3)', color: 'var(--ink-2)', border: '1px solid var(--line-2)', borderRadius: 6, padding: '6px 8px', fontSize: 11.5 }}
        >
          <option value="series">this series</option>
          <option value="template">all videos of this kind</option>
          <option value="video">this video only</option>
        </select>
        <button
          type="button"
          style={smallBtn}
          disabled={!newText.trim()}
          onClick={() => {
            void add(newText, newScope)
            setNewText('')
          }}
        >
          ＋ Add
        </button>
        <button
          type="button"
          className="save-continue"
          style={{ width: 'auto', padding: '7px 12px', fontSize: 12 }}
          disabled={suggesting}
          onClick={() => void suggest()}
          title="AI reads what this video is about and proposes rules for this step"
        >
          {suggesting ? (<><span className="spin" /> Suggesting…</>) : '✦ Suggest rules with AI'}
        </button>
      </div>
      {suggestions.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 10, letterSpacing: '.1em', color: 'var(--ink-3)', fontFamily: 'var(--mono)', marginBottom: 5 }}>
            SUGGESTIONS — SAVE THE ONES YOU WANT
          </div>
          {suggestions.map((sg) => (
            <div key={sg.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
              <span style={{ flex: '1 1 300px', fontSize: 12.5, lineHeight: 1.5, color: 'var(--ink-2)' }}>{sg.text}</span>
              {(['video', 'series', 'template'] as const).map((sc) => (
                <button
                  key={sc}
                  type="button"
                  style={{ ...smallBtn, padding: '3px 7px', fontSize: 10.5 }}
                  onClick={async () => {
                    await add(sg.text, sc)
                    setSuggestions((ss) => ss.filter((x) => x.id !== sg.id))
                  }}
                >
                  ＋ {SCOPE_LABEL[sc]}
                </button>
              ))}
              <button
                type="button"
                title="Dismiss"
                onClick={() => setSuggestions((ss) => ss.filter((x) => x.id !== sg.id))}
                style={{ background: 'none', border: 'none', color: 'var(--ink-3)', cursor: 'pointer', fontSize: 12 }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
