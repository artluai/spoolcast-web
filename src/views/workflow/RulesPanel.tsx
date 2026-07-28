import { useState } from 'react'
import { ResolvedRules } from '../../components/ResolvedRules'

// The per-step disclosure and the main Rules page render the same resolved
// rule component. The engine owns merge logic, provenance, and permissions.
export function RulesPanel({
  step,
  onToast,
  title,
}: {
  step: string
  onToast?: (message: string) => void
  title?: string
}) {
  const [open, setOpen] = useState(false)
  const [onCount, setOnCount] = useState<number | null>(null)

  return (
    <div className="resolved-rules-panel">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="utility-disclosure-toggle"
        aria-expanded={open}
      >
        <span>{open ? '▾' : '▸'}</span>{' '}
        {title ?? 'RULES FOR THIS STEP'}
        {onCount === null ? '' : ` (${onCount} ON)`}
      </button>
      <ResolvedRules
        step={step}
        compact
        hidden={!open}
        onCountChange={setOnCount}
        onToast={onToast}
      />
    </div>
  )
}
