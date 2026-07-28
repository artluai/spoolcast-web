import { useEffect, useMemo, useRef, useState } from 'react'
import { postAction, seriesUrl } from '../lib/api'

type SeriesOption = {
  id: string
  template?: string
}

const displayId = (id: string) =>
  id
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())

const seriesIdFromName = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

export function SeriesMenu({
  series,
  label,
  onViewSeries,
}: {
  series: string
  label: string
  onViewSeries?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'menu' | 'move' | 'create'>('menu')
  const [options, setOptions] = useState<SeriesOption[]>([])
  const [name, setName] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const rootRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    let live = true
    fetch(seriesUrl())
      .then((response) => (response.ok ? response.json() : null))
      .then((out) => {
        if (!live) return
        const rows = Array.isArray(out?.data?.series) ? out.data.series as SeriesOption[] : []
        setOptions(rows.sort((a, b) => a.id.localeCompare(b.id)))
      })
      .catch(() => {
        if (live) setOptions([])
      })
    return () => {
      live = false
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const available = useMemo(
    () => options.filter((option) => option.id !== series),
    [options, series],
  )

  const run = async (action: 'join_series' | 'leave_series' | 'create_series_from_project', target = '') => {
    if (busy) return
    setBusy(target || action)
    setError('')
    const out = await postAction({
      action,
      ...(target ? { series: target } : {}),
    })
    if (out?.ok) {
      window.location.reload()
      return
    }
    setBusy('')
    setError(out?.message || out?.error || 'Could not update the series.')
  }

  const createId = seriesIdFromName(name)

  return (
    <span className="series-crumb" ref={rootRef}>
      <button
        type="button"
        className="crumb-secondary series-crumb-trigger"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value)
          setMode('menu')
          setError('')
        }}
      >
        {label} <span aria-hidden="true">▾</span>
      </button>
      {open ? (
        <span className="vp-menu series-crumb-popover">
          {mode === 'menu' ? (
            <>
              {series && onViewSeries ? (
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false)
                    onViewSeries()
                  }}
                >
                  View series
                  <small>Rules, voice, defaults, and pipeline</small>
                </button>
              ) : null}
              <button type="button" onClick={() => setMode('move')}>
                {series ? 'Move to another series' : 'Add to a series'}
              </button>
              <button type="button" onClick={() => setMode('create')}>
                Make this a new series
                <small>This project becomes its first episode</small>
              </button>
              {series ? (
                <>
                  <span className="vp-menu-div" />
                  <button
                    type="button"
                    className="danger"
                    disabled={!!busy}
                    onClick={() => void run('leave_series')}
                  >
                    {busy === 'leave_series' ? 'Removing…' : 'Remove from series'}
                  </button>
                </>
              ) : null}
            </>
          ) : mode === 'move' ? (
            <>
              <button type="button" className="series-menu-back" onClick={() => setMode('menu')}>
                ← Series
              </button>
              <span className="vp-menu-h">CHOOSE A SERIES</span>
              {available.length ? available.map((option) => (
                <button
                  type="button"
                  key={option.id}
                  disabled={!!busy}
                  onClick={() => void run('join_series', option.id)}
                >
                  {busy === option.id ? 'Moving…' : displayId(option.id)}
                  {option.template ? <small>{displayId(option.template)} template</small> : null}
                </button>
              )) : (
                <span className="series-menu-empty">No other series yet.</span>
              )}
            </>
          ) : (
            <>
              <button type="button" className="series-menu-back" onClick={() => setMode('menu')}>
                ← Series
              </button>
              <span className="vp-menu-h">MAKE THIS A NEW SERIES</span>
              <span className="series-menu-form">
                <input
                  autoFocus
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && createId) {
                      void run('create_series_from_project', createId)
                    }
                  }}
                  placeholder="Series name"
                />
                {createId ? <small>ID: {createId}</small> : null}
                <button
                  type="button"
                  className="vp-undo"
                  disabled={!createId || !!busy}
                  onClick={() => void run('create_series_from_project', createId)}
                >
                  {busy && busy === createId ? 'Creating…' : 'Create series'}
                </button>
              </span>
            </>
          )}
          {error ? <span className="series-menu-error">{error}</span> : null}
        </span>
      ) : null}
    </span>
  )
}
