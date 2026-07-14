import { useState } from 'react'
import { ALL_MODELS, PRIMARY_MODELS } from '../../lib/draft-models'

// THE model dropdown for every "AI suggest/draft" button — the vp-menu pill
// design from the stage draft editor, backed by the one catalog in
// lib/draft-models.ts. Render it next to any button that spends text-model
// credits and send the chosen id (plus draftReasoning(id)) to the engine.
export function ModelPicker({
  model,
  onChange,
  disabled = false,
}: {
  model: string
  onChange: (id: string) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [showMore, setShowMore] = useState(false)
  return (
    <span style={{ position: 'relative' }}>
      <button
        type="button"
        className="vp-menu-btn"
        disabled={disabled}
        onClick={() => { setOpen((v) => !v); setShowMore(false) }}
        style={{ fontSize: 12, padding: '8px 12px' }}
      >
        {ALL_MODELS.find((m) => m.id === model)?.label ?? model} ▾
      </button>
      {open && (
        <>
          <span className="vp-menu-backdrop" onClick={() => setOpen(false)} />
          <span className="vp-menu" style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, minWidth: 250 }}>
            <span className="vp-menu-h">MODEL</span>
            {(showMore ? ALL_MODELS : PRIMARY_MODELS).map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => { onChange(m.id); setOpen(false) }}
                style={m.id === model ? { background: 'var(--bg-3)' } : undefined}
              >
                {m.label}
                <span style={{ display: 'block', color: 'var(--ink-3)', fontSize: 11 }}>
                  {m.cost} — {m.desc}
                </span>
              </button>
            ))}
            {!showMore && (
              <>
                <span className="vp-menu-div" style={{ display: 'block' }} />
                <button type="button" onClick={() => setShowMore(true)}>More models ▸</button>
              </>
            )}
          </span>
        </>
      )}
    </span>
  )
}
