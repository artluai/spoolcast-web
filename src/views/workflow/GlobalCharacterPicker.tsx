/**
 * GlobalCharacterPicker — pick a creator from the GLOBAL character library.
 *
 * The library is the read-only tier: every project can use these characters,
 * nobody can edit them. Picking one adds a reference row to the World Kit
 * (`use_global_asset`); "Make my own version" instead creates an editable
 * session-owned copy that remembers its parent (`make_ref_variation`).
 *
 * Visual-first by rule: the portraits are 4-view character sheets, so tiles are
 * large and uncropped — a face-sized thumbnail would throw away the angles that
 * make the sheet useful as a generation reference.
 *
 * Reuses the step-9 asset-library modal language (modal-scrim / confirm-modal
 * vg-ref-modal / vg-refs) rather than inventing a second picker style.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { apiUrl, globalContentUrl, postAction } from '../../lib/api'

export type GlobalCharacter = {
  id: string
  name: string
  description: string
  age?: number | null
  nationality?: string | null
  tags?: string[]
  content_path?: string | null
  /** Public CDN URL once the library is on object storage. Preferred over
   *  content_path so enabling R2 needs no frontend change. */
  image_url?: string | null
}

type Props = {
  /** Kit refs already in the session — used to mark characters as added. */
  existing: string[]
  onClose: () => void
  /** Fired after a successful add. `description` is the row's Notes text —
   *  empty for a global row (it resolves from the library), the copied text
   *  for a variation. `parent` is the library slug the row came from, so a
   *  variation's provenance is passed, never guessed from its name. */
  onAdded: (ref: string, variation: boolean, description: string, parent: string) => void
}

export default function GlobalCharacterPicker({ existing, onClose, onAdded }: Props) {
  const [chars, setChars] = useState<GlobalCharacter[] | null>(null)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const res = await fetch(apiUrl('global-assets', {}))
        const json = await res.json()
        if (alive) setChars(json?.data?.characters ?? [])
      } catch {
        if (alive) setChars([])
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  // Esc closes, matching every other modal in the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Filtering stays client-side: 30 characters is nothing, and it keeps
  // typing instant. The engine's ranked search backs the step-1 auto-pick.
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return chars ?? []
    const terms = q.split(/\s+/).filter(Boolean)
    return (chars ?? []).filter((c) => {
      const hay = [c.description, c.nationality ?? '', (c.tags ?? []).join(' '), c.name, String(c.age ?? '')]
        .join(' ')
        .toLowerCase()
      return terms.every((t) => hay.includes(t))
    })
  }, [chars, query])

  const added = useMemo(() => new Set(existing.map((r) => r.toLowerCase())), [existing])

  const run = async (slug: string, variation: boolean) => {
    setBusy(slug + (variation ? ':var' : ''))
    setError('')
    // postAction resolves with the error envelope rather than throwing, so the
    // failure path is a value check — not a catch.
    const res = await postAction<{ ref?: string; slug?: string }>(
      variation ? { action: 'make_ref_variation', slug } : { action: 'use_global_asset', slug },
    )
    setBusy('')
    if (!res) {
      setError('The engine is not responding — is it running?')
      return
    }
    if (res.ok === false) {
      setError(res.message || res.error || 'Could not add that character')
      return
    }
    const character = (chars ?? []).find((c) => c.id === slug)
    // The PARENT closes the modal — for both actions — and expands a new
    // variation so the user lands in its editor. Closing here too would fight
    // it, and leaving it open reads as "nothing happened".
    onAdded(
      String(res.data?.ref || res.data?.slug || slug),
      variation,
      variation ? String(character?.description ?? '') : '',
      slug,
    )
  }

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div
        className="confirm-modal vg-ref-modal"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 'min(1080px, 95vw)', maxHeight: '88vh', overflowY: 'auto' }}
      >
        <div className="vg-ref-modal-head">
          <b>Character library — pick a creator</b>
          <button type="button" className="vp-undo" onClick={onClose}>
            Close
          </button>
        </div>

        <p style={{ color: 'var(--ink-2)', fontSize: 13, margin: '10px 0 0', lineHeight: 1.5 }}>
          Real-looking UGC creators, shared by every project and read-only. Adding one links to the
          library, so it stays up to date. Need changes? Make your own version — an editable copy
          that remembers where it came from.
        </p>

        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search — try “korean skincare”, “fitness”, “luxury”, “25”…"
          autoFocus
          className="gcp-search"
        />

        {error ? (
          <p style={{ color: 'var(--warn, #e5a13a)', fontSize: 13, margin: '10px 0 0' }}>{error}</p>
        ) : null}

        {chars === null ? (
          <p style={{ color: 'var(--ink-2)', marginTop: 14 }}>Loading the library…</p>
        ) : !shown.length ? (
          <p style={{ color: 'var(--ink-2)', marginTop: 14 }}>
            {chars.length ? 'No creator matches that search.' : 'The library is empty.'}
          </p>
        ) : (
          <>
            <p className="vp-menu-h" style={{ margin: '16px 0 6px' }}>
              {shown.length} CREATOR{shown.length === 1 ? '' : 'S'}
              {query.trim() ? ' MATCHING' : ' — GLOBAL, READ-ONLY'}
            </p>
            {/* A GALLERY, not a list of cards: the sheets are the content, so
                they fill the grid edge to edge. Name and age ride ON the
                image; the description and the two actions surface on hover
                (and on keyboard focus). No box-in-a-box. */}
            <div className="gcp-grid">
              {shown.map((c) => {
                const isIn = added.has(c.id.toLowerCase())
                const src = c.image_url || (c.content_path ? globalContentUrl(c.content_path) : '')
                return (
                  <figure key={c.id} className="gcp-tile" tabIndex={0}>
                    {src ? (
                      <img src={src} alt={`${c.name} character sheet`} loading="lazy" />
                    ) : null}
                    {/* Always visible: who this is. */}
                    <figcaption className="gcp-name">
                      <b>{c.name}</b>
                      <span>{[c.age ? `${c.age}` : '', c.nationality ?? ''].filter(Boolean).join(' · ')}</span>
                    </figcaption>
                    {isIn ? <span className="gcp-in">✓ in this project</span> : null}
                    {/* On hover: what they look like, and what you can do. */}
                    <div className="gcp-over">
                      <p>{c.description}</p>
                      <div className="gcp-acts">
                        {!isIn && (
                          <button
                            type="button"
                            className="vp-undo"
                            disabled={!!busy}
                            onClick={() => void run(c.id, false)}
                          >
                            {busy === c.id ? 'Adding…' : 'Use this creator'}
                          </button>
                        )}
                        <button
                          type="button"
                          className="vp-undo"
                          disabled={!!busy}
                          title="Creates an editable copy in this project, linked to the original"
                          onClick={() => void run(c.id, true)}
                        >
                          {busy === `${c.id}:var` ? 'Copying…' : '⧉ Make my own version'}
                        </button>
                      </div>
                    </div>
                  </figure>
                )
              })}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
