import { useState } from 'react'

/**
 * The house control for every AI re-draft/re-suggest action:
 * collapsed — one split pill: [▾ | label]; the ▾ zone opens the feedback box,
 * the main zone runs immediately.
 * expanded — a multiline feedback textarea with the run button inside it
 * (bottom-right) and a ▴ to collapse.
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
    <div style={{ position: 'relative', flexBasis: '100%', marginTop: 6 }}>
      <textarea
        autoFocus
        rows={3}
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        placeholder={placeholder}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          resize: 'vertical',
          background: 'rgba(255,255,255,.02)',
          color: 'var(--ink-1)',
          border: '1px dashed var(--line, #2a3142)',
          borderRadius: 8,
          padding: '11px 12px 46px',
          fontSize: 13,
          lineHeight: 1.5,
        }}
      />
      <button
        type="button"
        title="Collapse"
        onClick={() => setOpen(false)}
        style={{
          position: 'absolute', right: 8, top: 8,
          background: 'none', border: 'none', color: 'var(--ink-3)',
          cursor: 'pointer', fontSize: 12, padding: 2,
        }}
      >
        ▴
      </button>
      <button
        type="button"
        className="save-continue"
        disabled={disabled || busy}
        title={title}
        onClick={() => onRun(feedback)}
        style={{ position: 'absolute', right: 8, bottom: 12, width: 'auto', padding: '6px 14px', fontSize: 12 }}
      >
        ✦ {busy ? busyLabel : label}
      </button>
    </div>
  )
}
