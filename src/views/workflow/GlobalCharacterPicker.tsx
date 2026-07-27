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
import { activeSession, apiUrl, globalContentUrl, postAction, TENANT } from '../../lib/api'

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

export type MyCharacter = {
  id: string
  ref: string
  name: string
  description: string
  source_session: string
  project: string
  variant_of?: string
  has_image: boolean
  content_path?: string | null
  modified_at?: number
}

export type LibraryAdded = {
  ref: string
  description: string
  variantOf: string
  global: boolean
  open: boolean
  existing?: boolean
}

type Props = {
  /** Kit refs already in the session — used to mark characters as added. */
  existing: string[]
  onClose: () => void
  onAdded: (item: LibraryAdded) => void
}

export default function GlobalCharacterPicker({ existing, onClose, onAdded }: Props) {
  const [globalChars, setGlobalChars] = useState<GlobalCharacter[] | null>(null)
  const [myChars, setMyChars] = useState<MyCharacter[] | null>(null)
  const [tab, setTab] = useState<'mine' | 'spoolcast'>('mine')
  const [query, setQuery] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [imageFilter, setImageFilter] = useState<'all' | 'image' | 'prompt'>('all')
  const [projectFilter, setProjectFilter] = useState<'all' | 'current'>('all')
  const [sort, setSort] = useState<'newest' | 'name'>('newest')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  }, [onClose])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const [globalRes, myRes] = await Promise.all([
          fetch(apiUrl('global-assets')),
          fetch(apiUrl('my-characters', { tenant: TENANT })),
        ])
        const [globalJson, myJson] = await Promise.all([globalRes.json(), myRes.json()])
        if (alive) {
          setGlobalChars(globalJson?.data?.characters ?? [])
          setMyChars(myJson?.data?.characters ?? [])
        }
      } catch {
        if (alive) {
          setGlobalChars([])
          setMyChars([])
        }
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

  // Both catalogs are small enough to filter instantly in the picker.
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    const terms = q.split(/\s+/).filter(Boolean)
    if (tab === 'spoolcast') {
      return (globalChars ?? []).filter((c) => {
        const hasImage = !!(c.image_url || c.content_path)
        if (imageFilter === 'image' && !hasImage) return false
        if (imageFilter === 'prompt' && hasImage) return false
        const hay = [c.description, c.nationality ?? '', (c.tags ?? []).join(' '), c.name, String(c.age ?? '')]
          .join(' ')
          .toLowerCase()
        return terms.every((t) => hay.includes(t))
      })
    }
    const filtered = (myChars ?? []).filter((c) => {
      if (projectFilter === 'current' && c.source_session !== activeSession()) return false
      if (imageFilter === 'image' && !c.has_image) return false
      if (imageFilter === 'prompt' && c.has_image) return false
      const hay = [c.description, c.project, c.name, c.variant_of ?? '']
        .join(' ')
        .toLowerCase()
      return terms.every((t) => hay.includes(t))
    })
    return [...filtered].sort((a, b) =>
      sort === 'name'
        ? a.name.localeCompare(b.name)
        : Number(b.modified_at || 0) - Number(a.modified_at || 0),
    )
  }, [globalChars, imageFilter, myChars, projectFilter, query, sort, tab])

  const added = useMemo(() => new Set(existing.map((r) => r.toLowerCase())), [existing])

  const runGlobal = async (slug: string, variation: boolean) => {
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
    const character = (globalChars ?? []).find((c) => c.id === slug)
    // The PARENT closes the modal — for both actions — and expands a new
    // variation so the user lands in its editor. Closing here too would fight
    // it, and leaving it open reads as "nothing happened".
    onAdded({
      ref: String(res.data?.ref || res.data?.slug || slug),
      description: variation ? String(character?.description ?? '') : '',
      variantOf: variation ? `global:${slug}` : '',
      global: !variation,
      open: true,
    })
  }

  const selectExisting = (item: {
    ref: string
    description: string
    variantOf?: string
    global: boolean
  }) => {
    onAdded({
      ...item,
      variantOf: item.variantOf ?? '',
      open: true,
      existing: true,
    })
  }

  const runMine = async (character: MyCharacter) => {
    const key = `mine:${character.id}`
    setBusy(key)
    setError('')
    const res = await postAction<{
      ref?: string
      description?: string
      variant_of?: string
      added?: boolean
    }>({
      action: 'use_my_character',
      source_session: character.source_session,
      source_ref: character.ref,
    })
    setBusy('')
    if (!res) {
      setError('The engine is not responding — is it running?')
      return
    }
    if (res.ok === false) {
      setError(res.message || res.error || 'Could not add that character')
      return
    }
    onAdded({
      ref: String(res.data?.ref || character.ref),
      description: String(res.data?.description || character.description || ''),
      variantOf: String(res.data?.variant_of || `my:${character.source_session}:${character.ref}`),
      global: false,
      open: true,
    })
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

        <div className="gcp-toolbar">
          <div className="gcp-tabs" role="tablist" aria-label="Character library source">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'mine'}
              className={tab === 'mine' ? 'on' : ''}
              onClick={() => {
                setTab('mine')
                setImageFilter('all')
              }}
            >
              My Library
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'spoolcast'}
              className={tab === 'spoolcast' ? 'on' : ''}
              onClick={() => {
                setTab('spoolcast')
                setImageFilter('all')
              }}
            >
              Spoolcast Library
            </button>
          </div>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tab === 'mine' ? 'Search your characters or projects…' : 'Search — try “korean skincare”, “fitness”, “luxury”, “25”…'}
            autoFocus
            className="gcp-search"
          />
        </div>

        <p className="gcp-intro">
          {tab === 'mine'
            ? 'Your private characters from every project. Reusing one makes an editable copy here.'
            : 'Ready-made creators shared by every project and kept read-only.'}
        </p>

        <button type="button" className="utility-disclosure-toggle" onClick={() => setAdvanced((value) => !value)}>
          {advanced ? '▾' : '▸'} Advanced
        </button>
        {advanced ? (
          <div className="gcp-filters">
            <label>
              <span>Image</span>
              <select className="sc-select" value={imageFilter} onChange={(e) => setImageFilter(e.target.value as typeof imageFilter)}>
                <option value="all">All</option>
                <option value="image">Has image</option>
                <option value="prompt">Prompt only</option>
              </select>
            </label>
            {tab === 'mine' ? (
              <>
                <label>
                  <span>Project</span>
                  <select className="sc-select" value={projectFilter} onChange={(e) => setProjectFilter(e.target.value as typeof projectFilter)}>
                    <option value="all">All projects</option>
                    <option value="current">Current project</option>
                  </select>
                </label>
                <label>
                  <span>Sort</span>
                  <select className="sc-select" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
                    <option value="newest">Newest</option>
                    <option value="name">Name</option>
                  </select>
                </label>
              </>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <p style={{ color: 'var(--warn, #e5a13a)', fontSize: 13, margin: '10px 0 0' }}>{error}</p>
        ) : null}

        {(tab === 'mine' ? myChars : globalChars) === null ? (
          <p style={{ color: 'var(--ink-2)', marginTop: 14 }}>Loading the library…</p>
        ) : !shown.length ? (
          <p style={{ color: 'var(--ink-2)', marginTop: 14 }}>
            {(tab === 'mine' ? myChars : globalChars)?.length ? 'No creator matches these filters.' : 'The library is empty.'}
          </p>
        ) : (
          <>
            <p className="vp-menu-h" style={{ margin: '16px 0 6px' }}>
              {shown.length} CREATOR{shown.length === 1 ? '' : 'S'}
              {query.trim() ? ' MATCHING' : tab === 'mine' ? ' — PRIVATE' : ' — READ-ONLY'}
            </p>
            <div className="gcp-grid">
              {tab === 'mine' ? (shown as MyCharacter[]).map((c) => {
                const isIn = c.source_session === activeSession() && added.has(c.ref.toLowerCase())
                const src = c.content_path ? globalContentUrl(c.content_path) : ''
                return (
                  <figure key={c.id} className="gcp-tile" tabIndex={0}>
                    {src
                      ? <img src={src} alt={`${c.name} character sheet`} loading="lazy" />
                      : <div className="gcp-prompt-only"><span>PROMPT ONLY</span><p>{c.description || 'No image yet.'}</p></div>}
                    {c.variant_of ? <span className="gcp-variant">CHARACTER · VARIANT</span> : null}
                    <figcaption className="gcp-name">
                      <b>{c.name}</b>
                      <span>{c.project}</span>
                    </figcaption>
                    {isIn ? <span className="gcp-in">✓ in this project</span> : null}
                    <div className="gcp-over">
                      <p>{c.description || 'Prompt-only character.'}</p>
                      <div className="gcp-acts">
                        {isIn ? (
                          <button
                            type="button"
                            className="vp-undo"
                            disabled={!!busy}
                            onClick={() => selectExisting({
                              ref: c.ref,
                              description: c.description,
                              variantOf: c.variant_of,
                              global: false,
                            })}
                          >
                            Select character
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="vp-undo"
                            disabled={!!busy}
                            onClick={() => void runMine(c)}
                          >
                            {busy === `mine:${c.id}` ? 'Adding…' : 'Add to Cast'}
                          </button>
                        )}
                      </div>
                    </div>
                  </figure>
                )
              }) : (shown as GlobalCharacter[]).map((c) => {
                const isIn = added.has(c.id.toLowerCase())
                const src = c.image_url || (c.content_path ? globalContentUrl(c.content_path) : '')
                return (
                  <figure key={c.id} className="gcp-tile" tabIndex={0}>
                    {src
                      ? <img src={src} alt={`${c.name} character sheet`} loading="lazy" />
                      : <div className="gcp-prompt-only"><span>PROMPT ONLY</span><p>{c.description}</p></div>}
                    <figcaption className="gcp-name">
                      <b>{c.name}</b>
                      <span>{[c.age ? `${c.age}` : '', c.nationality ?? ''].filter(Boolean).join(' · ')}</span>
                    </figcaption>
                    {isIn ? <span className="gcp-in">✓ in this project</span> : null}
                    <div className="gcp-over">
                      {/* Audition-sheet framing: this text is the AI actor,
                          not the character they'll play in a video. */}
                      <span className="gcp-over-label">AI ACTOR DESCRIPTION</span>
                      <p>{c.description}</p>
                      <div className="gcp-acts">
                        {isIn ? (
                          <button
                            type="button"
                            className="vp-undo"
                            disabled={!!busy}
                            onClick={() => selectExisting({
                              ref: c.id,
                              description: '',
                              global: true,
                            })}
                          >
                            Select character
                          </button>
                        ) : (
                          <button type="button" className="vp-undo" disabled={!!busy} onClick={() => void runGlobal(c.id, false)}>
                            {busy === c.id ? 'Adding…' : 'Use this creator'}
                          </button>
                        )}
                        <button
                          type="button"
                          className="vp-undo"
                          disabled={!!busy}
                          title="Creates an editable character in My Library and this Cast"
                          onClick={() => void runGlobal(c.id, true)}
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
