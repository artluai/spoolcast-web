import { useEffect, useRef, useState } from 'react'

/**
 * The house control for every AI re-draft/re-suggest action:
 * collapsed — one split pill: [▾ | label]; the ▾ zone opens the feedback box,
 * the main zone runs immediately.
 * expanded — a bordered box: the feedback textarea on top, the action row
 * (collapse ▴ + run button) BELOW it, so text can never slide under a button.
 * When the run finishes, the box collapses and clears itself — the screen
 * shows the result, not a leftover editing state.
 */
export function FeedbackButton({
  label,
  busyLabel = 'Writing…',
  busy,
  disabled,
  title,
  placeholder = 'Tell the AI what to change — e.g. “easier to understand”, “shorter”, “more dramatic”…',
  onRun,
}: {
  label: string
  busyLabel?: string
  busy: boolean
  disabled?: boolean
  title?: string
  placeholder?: string
  onRun: (feedback: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [feedback, setFeedback] = useState('')

  // Auto-collapse when a run completes (busy goes true → false).
  const wasBusy = useRef(false)
  useEffect(() => {
    if (wasBusy.current && !busy) {
      setOpen(false)
      setFeedback('')
    }
    wasBusy.current = busy
  }, [busy])

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
          onClick={() => onRun('')}
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
      <textarea
        autoFocus
        rows={3}
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        placeholder={placeholder}
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
      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10, padding: '4px 10px 10px' }}>
        <button
          type="button"
          title="Collapse"
          onClick={() => setOpen(false)}
          style={{ background: 'none', border: 'none', color: 'var(--ink-3)', cursor: 'pointer', fontSize: 12, padding: 2 }}
        >
          ▴
        </button>
        <button
          type="button"
          className="save-continue"
          disabled={disabled || busy}
          title={title}
          onClick={() => onRun(feedback)}
          style={{ width: 'auto', padding: '6px 14px', fontSize: 12 }}
        >
          ✦ {busy ? busyLabel : label}
        </button>
      </div>
    </div>
  )
}
