import { useEffect, useRef, useState, type ReactNode } from 'react'
import { appendUserRule, SERIES_RULES_ID } from '../../lib/rules'
import { postAction } from '../../lib/api'

/**
 * The house control for every AI re-draft/re-suggest action:
 * collapsed — one split pill: [▾ | label]; the ▾ zone opens the feedback box,
 * the main zone runs immediately.
 * expanded — a bordered box: the feedback textarea on top, the action row
 * (collapse ▴ + run button) BELOW it, so text can never slide under a button.
 * When the run finishes, the box collapses and clears itself — the screen
 * shows the result, not a leftover editing state.
 *
 * historyKey (optional): past notes persist per session (engine prompt-snippet
 * store) and show as a checklist — checked notes ride along with EVERY next
 * draft, so fixing problem B doesn't silently forget the note about problem A.
 * Unchecking parks a note; × removes it for good.
 */
type HistoryNote = { text: string; on: boolean }

export function FeedbackButton({
  label,
  busyLabel = 'Writing…',
  busy,
  disabled,
  title,
  placeholder = 'Tell the AI what to change — e.g. “easier to understand”, “shorter”, “more dramatic”…',
  rulesFocus = 'series-rules',
  historyKey,
  ruleStep,
  alwaysOpen = false,
  historyRideAlong = true,
  aboveActions,
  runExtras,
  onRun,
}: {
  label: string
  busyLabel?: string
  busy: boolean
  disabled?: boolean
  title?: string
  placeholder?: string
  // Which rulebook this step works under — the "view existing rules" link
  // deep-links there (Project Wiki). Defaults to the series rulebook.
  rulesFocus?: string
  // Persist notes under this snippet name (lowercase/dash) to enable history.
  historyKey?: string
  // Engine stage id: "save as a permanent rule" files into THIS step's rules
  // (series scope, template as fallback) instead of the legacy series rulebook.
  ruleStep?: string
  // Render the notebox permanently (no collapsed pill, no ▴) — for hosts that
  // put the control inside their own collapsible section.
  alwaysOpen?: boolean
  // true (drafters): checked past notes ride along with every run — a redraft
  // from scratch must not forget note A while fixing note B. false
  // (incremental updates): each run sends ONLY the textarea; past notes are a
  // click-to-reuse reference, never silent passengers.
  historyRideAlong?: boolean
  // Extra controls rendered on their own row between the textarea and the
  // action row (e.g. a host-owned checkbox).
  aboveActions?: ReactNode
  // Extra controls rendered in the action row, just left of the run button
  // (e.g. a model picker).
  runExtras?: ReactNode
  onRun: (feedback: string) => void
}) {
  const [open, setOpen] = useState(alwaysOpen)
  const [feedback, setFeedback] = useState('')
  // "Make it law": optionally save this feedback as a permanent series rule
  // (Project Wiki → Series rules → User-added rules) before running.
  const [asRule, setAsRule] = useState(false)
  const [ruleNote, setRuleNote] = useState<string | null>(null)
  const [history, setHistory] = useState<HistoryNote[] | null>(null)

  // Load past notes on mount (not on expand): the collapsed quick-run must
  // also honor the checked notes.
  useEffect(() => {
    if (!historyKey) return
    let alive = true
    void postAction<{ text?: string }>({ action: 'get_prompt_snippet', name: historyKey }).then((out) => {
      if (!alive) return
      let parsed: HistoryNote[] = []
      try {
        const raw = JSON.parse(out?.data?.text || '[]')
        if (Array.isArray(raw)) {
          parsed = raw
            .filter((n) => n && typeof n.text === 'string')
            .map((n) => ({ text: n.text, on: n.on !== false }))
        }
      } catch {
        /* unreadable history starts fresh */
      }
      setHistory(parsed)
    })
    return () => {
      alive = false
    }
  }, [historyKey])

  const saveHistory = (h: HistoryNote[]) => {
    setHistory(h)
    if (!historyKey) return
    void postAction({
      action: 'set_prompt_snippet',
      name: historyKey,
      scope: 'session',
      text: h.length ? JSON.stringify(h) : '',
    })
  }

  // What actually reaches the AI: every checked past note + the new one —
  // unless ride-along is off, in which case ONLY the textarea goes.
  const composeFeedback = (fresh: string) => {
    if (!historyRideAlong) return fresh.trim()
    const past = (history ?? []).filter((n) => n.on).map((n) => n.text)
    return [...past, fresh.trim()].filter(Boolean).join('\n')
  }

  const run = (fresh: string) => {
    if (historyKey && fresh.trim()) {
      saveHistory([...(history ?? []), { text: fresh.trim(), on: true }])
    }
    onRun(composeFeedback(fresh))
  }

  // Auto-collapse when a run completes (busy goes true → false).
  const wasBusy = useRef(false)
  useEffect(() => {
    if (wasBusy.current && !busy) {
      if (!alwaysOpen) setOpen(false)
      setFeedback('')
    }
    wasBusy.current = busy
  }, [alwaysOpen, busy])

  if (!open) {
    return (
      <span style={{ display: 'inline-flex' }}>
        <button
          type="button"
          className="save-continue"
          disabled={disabled || busy}
          title="Add feedback for the next draft"
          onClick={() => setOpen(true)}
          style={{ width: 'auto', borderRadius: '8px 0 0 8px', padding: '8px 11px', borderRight: '1px solid rgba(0,0,0,.3)' }}
        >
          ▾
        </button>
        <button
          type="button"
          className="save-continue"
          disabled={disabled || busy}
          title={title}
          onClick={() => run('')}
          style={{ width: 'auto', borderRadius: '0 8px 8px 0', padding: '8px 16px' }}
        >
          ✦ {busy ? busyLabel : label}
        </button>
      </span>
    )
  }

  return (
    <div
      style={{
        flexBasis: '100%',
        marginTop: 6,
        border: '1px dashed var(--line, #2a3142)',
        borderRadius: 8,
        background: 'rgba(255,255,255,.02)',
      }}
    >
      {historyKey && (history?.length ?? 0) > 0 && (
        <div style={{ padding: '10px 12px 0' }}>
          <div style={{ fontSize: 10, letterSpacing: '.1em', color: 'var(--ink-3)', fontFamily: 'var(--mono)', marginBottom: 5 }}>
            {historyRideAlong ? 'PAST NOTES — CHECKED ONES APPLY TO EVERY DRAFT' : 'PAST NOTES — CLICK ONE TO REUSE IT (nothing applies on its own)'}
          </div>
          {history!.map((n, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 7, marginBottom: 4 }}>
              {historyRideAlong ? (
                <input
                  type="checkbox"
                  checked={n.on}
                  title={n.on ? 'Applied to the next drafts — uncheck to park it' : 'Parked — check to apply it again'}
                  onChange={(e) => saveHistory(history!.map((x, xi) => (xi === i ? { ...x, on: e.target.checked } : x)))}
                  style={{ accentColor: 'var(--ink-2)', margin: '2px 0 0' }}
                />
              ) : null}
              <span
                title={historyRideAlong ? undefined : 'Click to put this note in the box'}
                onClick={historyRideAlong ? undefined : () => setFeedback((f) => (f.trim() ? `${f.trim()}\n${n.text}` : n.text))}
                style={{ flex: 1, fontSize: 12.5, lineHeight: 1.45, color: historyRideAlong && n.on ? 'var(--ink-2)' : 'var(--ink-3)', cursor: historyRideAlong ? undefined : 'pointer' }}
              >
                {n.text}
              </span>
              <button
                type="button"
                title="Remove this note for good"
                onClick={() => saveHistory(history!.filter((_, xi) => xi !== i))}
                style={{ background: 'none', border: 'none', color: 'var(--ink-3)', cursor: 'pointer', fontSize: 12, padding: '0 2px' }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <textarea
        autoFocus={!alwaysOpen}
        rows={3}
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        placeholder={
          historyKey && (history?.length ?? 0) === 0
            ? `${placeholder} Notes you run are remembered here and apply to every later draft.`
            : placeholder
        }
        style={{
          display: 'block',
          width: '100%',
          boxSizing: 'border-box',
          resize: 'vertical',
          background: 'transparent',
          color: 'var(--ink-1)',
          border: 'none',
          outline: 'none',
          padding: '11px 12px 4px',
          fontSize: 13,
          lineHeight: 1.5,
        }}
      />
      {aboveActions ? <div style={{ padding: '2px 10px 0' }}>{aboveActions}</div> : null}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 10px 10px' }}>
        <label
          title="Adds this to the series rulebook (Project Wiki) so EVERY future draft follows it — not just this one"
          style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--ink-3)', fontSize: 12, cursor: 'pointer' }}
        >
          <input
            type="checkbox"
            checked={asRule}
            onChange={(e) => setAsRule(e.target.checked)}
            style={{ accentColor: 'var(--ink-2)', margin: 0 }}
          />
          also save as a permanent rule
        </label>
        <a
          href={`/p/dev-log-12/rules?focus=${rulesFocus}`}
          title="Open the rulebook this step works under"
          style={{ color: 'var(--ink-3)', fontSize: 12, textDecoration: 'underline', textUnderlineOffset: 3 }}
        >
          view existing rules
        </a>
        {ruleNote ? <span style={{ color: 'var(--amber)', fontSize: 12 }}>{ruleNote}</span> : null}
        <span style={{ flex: 1 }} />
        {!alwaysOpen && (
          <button
            type="button"
            title="Collapse"
            onClick={() => setOpen(false)}
            style={{ background: 'none', border: 'none', color: 'var(--ink-3)', cursor: 'pointer', fontSize: 12, padding: 2 }}
          >
            ▴
          </button>
        )}
        {runExtras}
        <button
          type="button"
          className="save-continue"
          disabled={disabled || busy}
          title={title}
          onClick={async () => {
            setRuleNote(null)
            if (asRule && feedback.trim()) {
              if (ruleStep) {
                // File into THIS step's rules so every future draft of the
                // step obeys it (series first, template when no series).
                const id = feedback.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'rule'
                let res2 = await postAction({ action: 'set_rule', scope: 'series', id, step: ruleStep, text: feedback.trim() })
                if (!res2?.ok) {
                  res2 = await postAction({ action: 'set_rule', scope: 'template', id, step: ruleStep, text: feedback.trim() })
                }
                if (!res2?.ok) {
                  setRuleNote(res2?.error || 'Could not save the rule.')
                  return // don't run on a failed rule save — the user asked for both
                }
              } else {
                const res = await appendUserRule(SERIES_RULES_ID, feedback)
                if (!res.ok) {
                  setRuleNote(res.error)
                  return // don't run on a failed rule save — the user asked for both
                }
              }
            }
            run(feedback)
          }}
          style={{ width: 'auto', padding: '6px 14px', fontSize: 12 }}
        >
          ✦ {busy ? busyLabel : label}
        </button>
      </div>
    </div>
  )
}
