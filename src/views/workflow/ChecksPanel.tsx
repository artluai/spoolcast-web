import { useEffect, useState } from 'react'
import { postAction } from '../../lib/api'

// SCOPED QUALITY CHECKS — the plain-language checklist the AI review judges
// the script against. Three scopes: template (every video of this kind),
// series (this show), video (this one only). Inherited checks are switched
// off per-video with the checkbox; × deletes a check from its scope for good.
type Check = { id: string; text: string; scope: 'template' | 'series' | 'video'; enabled: boolean }
type Suggestion = { id: string; text: string }

const SCOPE_LABEL: Record<Check['scope'], string> = {
  template: 'all videos of this kind',
  series: 'this series',
  video: 'this video only',
}

const slugify = (t: string) =>
  t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'check'

export function ChecksPanel({ onToast }: { onToast?: (m: string) => void }) {
  const [open, setOpen] = useState(false)
  const [checks, setChecks] = useState<Check[] | null>(null)
  const [newText, setNewText] = useState('')
  const [newScope, setNewScope] = useState<Check['scope']>('video')
  const [editing, setEditing] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [suggesting, setSuggesting] = useState(false)
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])

  const load = () =>
    postAction<{ checks?: Check[] }>({ action: 'get_checks' }).then((out) => {
      if (out?.ok) setChecks(out.data?.checks ?? [])
    })
  useEffect(() => {
    void load()
  }, [])

  const smallBtn: React.CSSProperties = {
    background: 'var(--bg-3)', border: '1px solid var(--line-2)', color: 'var(--ink-2)',
    borderRadius: 6, padding: '4px 9px', fontSize: 11.5, cursor: 'pointer',
  }

  const setEnabled = async (c: Check, enabled: boolean) => {
    setChecks((cs) => cs?.map((x) => (x.id === c.id ? { ...x, enabled } : x)) ?? cs)
    await postAction({ action: 'set_check_enabled', id: c.id, enabled })
  }
  const remove = async (c: Check) => {
    setChecks((cs) => cs?.filter((x) => x.id !== c.id) ?? cs)
    await postAction({ action: 'remove_check', scope: c.scope, id: c.id })
  }
  const saveEdit = async (c: Check) => {
    const text = editText.trim()
    setEditing(null)
    if (!text || text === c.text) return
    setChecks((cs) => cs?.map((x) => (x.id === c.id ? { ...x, text } : x)) ?? cs)
    await postAction({ action: 'set_check', scope: c.scope, id: c.id, text })
  }
  const add = async (text: string, scope: Check['scope']) => {
    const t = text.trim()
    if (!t) return
    const out = await postAction({ action: 'set_check', scope, id: slugify(t), text: t })
    if (out?.ok) {
      await load()
    } else {
      onToast?.(`Engine: ${out?.error || 'could not save the check.'}`)
    }
  }
  const suggest = async () => {
    setSuggesting(true)
    const out = await postAction<{ suggestions?: Suggestion[] }>({ action: 'suggest_checks', allow_cost: true })
    setSuggesting(false)
    if (out?.ok) setSuggestions(out.data?.suggestions ?? [])
    else onToast?.(`Engine: ${out?.error || out?.message || 'could not suggest checks.'}`)
  }

  const onCount = checks?.filter((c) => c.enabled).length ?? 0

  if (!open) {
    return (
      <div style={{ marginTop: 14 }}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          style={{
            background: 'none', border: 'none', padding: 0, cursor: 'pointer',
            fontSize: 10, letterSpacing: '.1em', color: 'var(--ink-3)', fontFamily: 'var(--mono)',
            display: 'inline-flex', gap: 6, alignItems: 'center',
          }}
        >
          <span style={{ fontSize: 10 }}>▸</span> CHECKS FOR THIS VIDEO{checks ? ` (${onCount} ON)` : ''}
        </button>
      </div>
    )
  }

  return (
    <div style={{ marginTop: 14 }}>
      <button
        type="button"
        onClick={() => setOpen(false)}
        style={{
          background: 'none', border: 'none', padding: 0, cursor: 'pointer', marginBottom: 8,
          fontSize: 10, letterSpacing: '.1em', color: 'var(--ink-3)', fontFamily: 'var(--mono)',
          display: 'inline-flex', gap: 6, alignItems: 'center',
        }}
      >
        <span style={{ fontSize: 10 }}>▾</span> CHECKS FOR THIS VIDEO — WHAT THE SCRIPT REVIEW LOOKS FOR
      </button>
      {checks === null ? (
        <div style={{ fontSize: 12, color: 'var(--ink-3)' }}><span className="spin" /> Loading…</div>
      ) : checks.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginBottom: 8 }}>
          No checks yet — add your own below, or let the AI suggest some from what this video is about.
        </div>
      ) : (
        checks.map((c) => (
          <div key={`${c.scope}:${c.id}`} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 6 }}>
            <input
              type="checkbox"
              checked={c.enabled}
              title={c.enabled ? 'On for this video — uncheck to skip it here (other videos unaffected)' : 'Off for this video'}
              onChange={(e) => void setEnabled(c, e.target.checked)}
              style={{ accentColor: 'var(--ink-2)', margin: '3px 0 0' }}
            />
            {editing === c.id ? (
              <input
                autoFocus
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                onBlur={() => void saveEdit(c)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveEdit(c)
                  if (e.key === 'Escape') setEditing(null)
                }}
                style={{
                  flex: 1, background: 'transparent', color: 'var(--ink-1)', fontSize: 12.5,
                  border: '1px solid var(--line, #2a3142)', borderRadius: 5, padding: '3px 7px',
                }}
              />
            ) : (
              <span
                title="Click to edit (edits apply everywhere this check is used)"
                onClick={() => {
                  setEditing(c.id)
                  setEditText(c.text)
                }}
                style={{ flex: 1, fontSize: 12.5, lineHeight: 1.5, cursor: 'text', color: c.enabled ? 'var(--ink-2)' : 'var(--ink-3)' }}
              >
                {c.text}
              </span>
            )}
            <span style={{ fontSize: 10, color: 'var(--ink-3)', fontFamily: 'var(--mono)', whiteSpace: 'nowrap', marginTop: 3 }}>
              {SCOPE_LABEL[c.scope]}
            </span>
            <button
              type="button"
              title={`Delete this check for ${SCOPE_LABEL[c.scope]} — to skip it just for this video, uncheck it instead`}
              onClick={() => void remove(c)}
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
          placeholder="Add a check — e.g. “No clear CTA; keep it native”…"
          style={{
            flex: '1 1 260px', background: 'transparent', color: 'var(--ink-2)', fontSize: 12.5,
            border: '1px solid var(--line, #2a3142)', borderRadius: 6, padding: '6px 9px',
          }}
        />
        <select
          value={newScope}
          onChange={(e) => setNewScope(e.target.value as Check['scope'])}
          style={{ background: 'var(--bg-3)', color: 'var(--ink-2)', border: '1px solid var(--line-2)', borderRadius: 6, padding: '6px 8px', fontSize: 11.5 }}
        >
          <option value="video">this video only</option>
          <option value="series">this series</option>
          <option value="template">all videos of this kind</option>
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
        <button type="button" style={smallBtn} disabled={suggesting} onClick={() => void suggest()} title="AI reads what this video is about and proposes checks — uses model credits">
          {suggesting ? (<><span className="spin" /> Suggesting…</>) : '✦ Suggest checks with AI'}
        </button>
      </div>
      {suggestions.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 10, letterSpacing: '.1em', color: 'var(--ink-3)', fontFamily: 'var(--mono)', marginBottom: 5 }}>
            SUGGESTIONS — SAVE THE ONES YOU WANT
          </div>
          {suggestions.map((s) => (
            <div key={s.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
              <span style={{ flex: '1 1 300px', fontSize: 12.5, lineHeight: 1.5, color: 'var(--ink-2)' }}>{s.text}</span>
              {(['video', 'series', 'template'] as const).map((sc) => (
                <button
                  key={sc}
                  type="button"
                  style={{ ...smallBtn, padding: '3px 7px', fontSize: 10.5 }}
                  onClick={async () => {
                    await add(s.text, sc)
                    setSuggestions((ss) => ss.filter((x) => x.id !== s.id))
                  }}
                >
                  ＋ {SCOPE_LABEL[sc]}
                </button>
              ))}
              <button
                type="button"
                title="Dismiss"
                onClick={() => setSuggestions((ss) => ss.filter((x) => x.id !== s.id))}
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
