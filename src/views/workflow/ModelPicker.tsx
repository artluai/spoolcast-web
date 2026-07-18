import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ALL_MODELS, PRIMARY_MODELS } from '../../lib/draft-models'

// THE model dropdown for every "AI suggest/draft" button — the vp-menu pill
// design from the stage draft editor, backed by the one catalog in
// lib/draft-models.ts. Render it next to any button that spends text-model
// credits and send the chosen id (plus draftReasoning(id)) to the engine.
//
// The menu PORTALS to <body> at fixed viewport coordinates (and flips upward
// near the bottom edge): the trigger lives inside the detail card, whose
// overflow would clip an absolutely-positioned dropdown.
export function ModelPicker({
  model,
  onChange,
  disabled = false,
  // Alternate catalogs (e.g. IMAGE models for World Kit refs) reuse the same
  // pill + menu; default stays the text-drafting catalog.
  models = ALL_MODELS,
  primary = PRIMARY_MODELS,
}: {
  model: string
  onChange: (id: string) => void
  disabled?: boolean
  models?: typeof ALL_MODELS
  primary?: typeof PRIMARY_MODELS
}) {
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const [menuPos, setMenuPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null)
  const [showMore, setShowMore] = useState(false)
  const open = menuPos !== null

  // An id outside the catalog still deserves its family's short label:
  // 'gpt-image-2-image-to-image' IS GPT Image 2 to the user — the endpoint
  // suffix is our concern, not theirs. Raw id only when nothing matches.
  const stem = (s: string) => s.replace(/-(text|image)-to-image$/, '')
  const labelOf = (id: string) =>
    models.find((m) => m.id === id)?.label ?? models.find((m) => stem(m.id) === stem(id))?.label ?? id

  const toggle = () => {
    if (open) {
      setMenuPos(null)
      return
    }
    setShowMore(false)
    const r = btnRef.current?.getBoundingClientRect()
    if (!r) return
    // Embedded webviews can report 0 for every viewport metric — when that
    // happens, skip the clamping/flip math entirely and open downward (the
    // body portal already escapes any clipping).
    const vw = document.documentElement.clientWidth || window.innerWidth
    const vh = document.documentElement.clientHeight || window.innerHeight
    const left = vw ? Math.max(8, Math.min(r.left, vw - 258)) : r.left
    // Flip upward when the full list wouldn't fit below the trigger.
    if (vh && r.bottom + 330 > vh) {
      setMenuPos({ left, bottom: vh - r.top + 4 })
    } else {
      setMenuPos({ left, top: r.bottom + 4 })
    }
  }

  return (
    <span style={{ position: 'relative' }}>
      <button
        type="button"
        ref={btnRef}
        // Same footprint as every other button (.vp-menu-btn == .vp-undo
        // sizing) — dropdowns don't get to be bigger than their row.
        className="vp-menu-btn"
        disabled={disabled}
        onClick={toggle}
        style={{ whiteSpace: 'nowrap', maxWidth: 230, overflow: 'hidden', textOverflow: 'ellipsis' }}
      >
        {labelOf(model)} ▾
      </button>
      {open
        ? createPortal(
            <>
              <span className="vp-menu-backdrop" onClick={() => setMenuPos(null)} />
              <span className="vp-menu" style={{ ...menuPos, minWidth: 250, maxHeight: 'calc(100vh - 24px)', overflowY: 'auto' }}>
                <span className="vp-menu-h">MODEL</span>
                {(showMore ? models : primary).map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => { onChange(m.id); setMenuPos(null) }}
                    style={m.id === model ? { background: 'var(--bg-3)' } : undefined}
                  >
                    {m.label}
                    <span style={{ display: 'block', color: 'var(--ink-3)', fontSize: 11 }}>
                      {m.cost} — {m.desc}
                    </span>
                  </button>
                ))}
                {!showMore && models.length > primary.length && (
                  <>
                    <span className="vp-menu-div" style={{ display: 'block' }} />
                    <button type="button" onClick={() => setShowMore(true)}>More models ▸</button>
                  </>
                )}
              </span>
            </>,
            document.body,
          )
        : null}
    </span>
  )
}
