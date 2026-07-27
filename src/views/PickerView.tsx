import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { apiUrl, getJson, postAction, sessionsUrl, templatesUrl } from '../lib/api'
import { TEMPLATE_ART } from '../data/picker'

// /projects — the REAL home page: engine sessions (resume) + the engine's
// template registry (start new). Opening either resolves to /p/<session-id>;
// "new video from a template" runs the engine's create_session action.

type EngineTemplate = {
  id: string
  name: string
  format: string
  contract: string
  description?: string
}

type EngineSession = {
  id: string
  contract: string
  template?: string | null
  series?: string | null
  style?: string | null
  core_message?: string | null
  modified_at?: number
  done_stages: number
  stage_count: number
}

const timeAgo = (epochSeconds?: number) => {
  if (!epochSeconds) return ''
  const s = Math.max(0, Date.now() / 1000 - epochSeconds)
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

const slugify = (v: string) => v.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-_]/g, '')

export function PickerView({
  onOpenSession,
  onScrolled,
}: {
  onOpenSession: (id: string) => void
  onScrolled: (scrolled: boolean) => void
}) {
  const [q, setQ] = useState('')
  const [templates, setTemplates] = useState<EngineTemplate[]>([])
  const [sessions, setSessions] = useState<EngineSession[]>([])
  const [engineDown, setEngineDown] = useState(false)
  const [creating, setCreating] = useState<EngineTemplate | null>(null)
  const [creatingBlank, setCreatingBlank] = useState(false)
  const [blankError, setBlankError] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<EngineSession | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  // the picker mounts at the top, so the nav bar starts in its floating state
  useEffect(() => {
    onScrolled(false)
  }, [onScrolled])

  useEffect(() => {
    let cancelled = false
    Promise.all([
      getJson<{ ok?: boolean; data?: { templates?: EngineTemplate[] } }>(templatesUrl()),
      getJson<{ ok?: boolean; data?: { sessions?: EngineSession[] } }>(sessionsUrl()),
    ]).then(([tpl, ses]) => {
      if (cancelled) return
      const tplList = tpl?.data?.templates ?? []
      setTemplates(tplList)
      setEngineDown(!tpl?.ok)
      // Openable = built on a contract the template registry (and so this UI)
      // knows. Other content roots (e.g. the news show) are different products.
      const known = new Set(tplList.map((t) => t.contract))
      setSessions((ses?.data?.sessions ?? []).filter((s) => known.has(s.contract)))
    })
    return () => {
      cancelled = true
    }
  }, [])

  const query = q.trim().toLowerCase()
  const matches = (t: EngineTemplate) =>
    !query || `${t.name} ${t.format} ${t.description ?? ''}`.toLowerCase().includes(query)
  const anyShown = templates.some(matches)
  const createBlank = async () => {
    if (creatingBlank) return
    const existingIds = new Set(sessions.map((session) => session.id))
    let number = 1
    let id = 'untitled-01'
    while (existingIds.has(id)) id = `untitled-${String(++number).padStart(2, '0')}`

    setCreatingBlank(true)
    setBlankError('')
    const out = await postAction<{ session?: string }>({
      action: 'create_session',
      session: id,
      template: 'undecided',
    })
    setCreatingBlank(false)
    if (out?.ok && out.data?.session) {
      onOpenSession(out.data.session)
    } else {
      setBlankError(out?.message || out?.error || 'Could not start the project.')
    }
  }

  return (
    <section className="tpl-picker" onScroll={(e) => onScrolled(e.currentTarget.scrollTop > 8)}>
      <div className="inner">
        <div className="head">
          <h1>Start a project</h1>
          <p className="lede">Pick up where you left off, or start something new.</p>
        </div>

        <button className="blank-top solo" disabled={creatingBlank} onClick={() => void createBlank()}>
          <span className="bt-glyph">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </span>
          <span className="bt-text">
            <span className="bt-title">Standalone — start blank</span>
            <span className="bt-sub">Start with your idea. Choose a series or template in Step 1.</span>
          </span>
          <span className="bt-cta">
            {creatingBlank ? <span className="spin" /> : null}
            {creatingBlank ? 'Starting…' : 'Start blank →'}
          </span>
        </button>
        {blankError ? <p className="cs-error blank-error">{blankError}</p> : null}

        {sessions.length ? (
          <>
            <div className="section-label">
              <h2>Pick up where you left off</h2>
              <span className="hint">your videos, live from the engine</span>
            </div>
            <div className="resume-list">
              {sessions.map((s) => (
                <ResumeRow
                  key={s.id}
                  title={s.id}
                  sub={`${s.series ?? 'standalone'} · ${timeAgo(s.modified_at)}`}
                  step={`${String(s.done_stages).padStart(2, '0')} / ${s.stage_count}`}
                  pct={s.stage_count ? Math.round((s.done_stages / s.stage_count) * 100) : 0}
                  thumb={apiUrl('content', { path: `sessions/${s.id}/renders/${s.id}-thumbnail.png` })}
                  onClick={() => onOpenSession(s.id)}
                  onDelete={() => {
                    setDeleteError('')
                    setDeleteTarget(s)
                  }}
                />
              ))}
            </div>
          </>
        ) : null}

        <div className="section-label">
          <h2>Choose a template</h2>
          <div className="search">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="11" cy="11" r="7" />
              <path d="M21 21l-4.2-4.2" />
            </svg>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search templates…"
            />
          </div>
        </div>

        <div className="bento">
          {templates.map((t) => (
            <PickerTile
              key={t.id}
              tpl={t}
              hidden={!matches(t)}
              onUse={() => setCreating(t)}
            />
          ))}
        </div>
        {engineDown ? (
          <div className="no-results show">The engine isn’t reachable — start it to see your projects and templates.</div>
        ) : !anyShown ? (
          <div className="no-results show">No templates match “{q}”.</div>
        ) : null}
      </div>
      {creating ? (
        <CreateSessionModal
          template={creating}
          sessions={sessions}
          onCancel={() => setCreating(null)}
          onCreated={onOpenSession}
        />
      ) : null}
      {deleteTarget ? (
        <div
          className="modal-scrim"
          onClick={() => {
            if (!deleting) setDeleteTarget(null)
          }}
        >
          <div className="confirm-modal" onClick={(event) => event.stopPropagation()}>
            <span className="need">PERMANENT DELETE</span>
            <h3>Delete this project?</h3>
            <p>
              This permanently deletes its idea, attached files, drafts, generated media, approvals, and renders.
              It cannot be undone.
            </p>
            <div className="check">
              <b>{deleteTarget.id}</b>
            </div>
            {deleteError ? <p className="voice-error">{deleteError}</p> : null}
            <div className="actions">
              <button onClick={() => setDeleteTarget(null)} disabled={deleting}>Cancel</button>
              <button
                className="danger"
                disabled={deleting}
                onClick={async () => {
                  setDeleting(true)
                  setDeleteError('')
                  const out = await postAction<{ deleted?: boolean }>({
                    action: 'delete_session',
                    session: deleteTarget.id,
                  })
                  setDeleting(false)
                  if (out?.ok && out.data?.deleted) {
                    setSessions((current) => current.filter((session) => session.id !== deleteTarget.id))
                    setDeleteTarget(null)
                  } else {
                    setDeleteError(out?.message || out?.error || 'Could not delete the project.')
                  }
                }}
              >
                {deleting ? <span className="spin" /> : null}
                {deleting ? 'Deleting…' : 'Delete project'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}

function PickerTile({
  tpl,
  hidden,
  onUse,
}: {
  tpl: EngineTemplate
  hidden: boolean
  onUse: () => void
}) {
  const art = TEMPLATE_ART[tpl.id]
  const ref = useRef<HTMLVideoElement | null>(null)
  const [playing, setPlaying] = useState(false)
  return (
    <div
      className={`tile ${art?.cls ?? ''} ${playing ? 'playing' : ''}`}
      style={hidden ? { display: 'none' } : undefined}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('.act')) return
        const v = ref.current
        if (!v) return
        // tap toggles play / pause
        if (v.paused) {
          v.muted = false
          void v.play().catch(() => {})
          setPlaying(true)
        } else {
          v.pause()
          setPlaying(false)
        }
      }}
    >
      {art?.video ? (
        <video ref={ref} src={art.video} poster={art.poster} preload="metadata" playsInline />
      ) : null}
      {art?.duration ? <span className="badge tr">{art.duration}</span> : null}
      {art?.video ? (
        <button className="play" aria-label="Play preview">
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5v14l11-7z" />
          </svg>
        </button>
      ) : null}
      <div className="scrim">
        <div className="t-name">{tpl.name}</div>
        <div className="t-sig">{tpl.description}</div>
        <div className="acts">
          <button className="act primary" onClick={(e) => { e.stopPropagation(); onUse() }}>
            Use this template →
          </button>
        </div>
      </div>
    </div>
  )
}

// "New video" — names the session, optionally files it under a series
// (existing, or a new one the template's starter rules get stamped into),
// then runs the engine's create_session and opens the new workflow.
function CreateSessionModal({
  template,
  sessions,
  onCancel,
  onCreated,
}: {
  template: EngineTemplate
  sessions: EngineSession[]
  onCancel: () => void
  onCreated: (id: string) => void
}) {
  const existingIds = useMemo(() => new Set(sessions.map((s) => s.id)), [sessions])
  const seriesOptions = useMemo(
    () => [...new Set(sessions.map((s) => s.series).filter((v): v is string => !!v))].sort(),
    [sessions],
  )
  const [series, setSeries] = useState('')
  const [newSeries, setNewSeries] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // Suggested id: next number in the chosen series, else template-01 — always
  // free to overtype (slugified to a safe engine id on the way in).
  const suggest = (forSeries: string) => {
    const pool = forSeries ? sessions.filter((s) => s.series === forSeries) : []
    const numbered = pool
      .map((s) => /^(.*-)(\d+)$/.exec(s.id))
      .filter((m): m is RegExpExecArray => !!m)
    if (numbered.length) {
      const width = numbered[0][2].length
      const next = Math.max(...numbered.map((m) => Number(m[2]))) + 1
      return `${numbered[0][1]}${String(next).padStart(width, '0')}`
    }
    let n = 1
    let candidate = `${template.id}-01`
    while (existingIds.has(candidate)) candidate = `${template.id}-${String(++n).padStart(2, '0')}`
    return candidate
  }
  const [name, setName] = useState(() => suggest(''))

  const create = async () => {
    const id = slugify(name)
    if (!id) {
      setError('Give the video a name.')
      return
    }
    if (existingIds.has(id)) {
      setError(`“${id}” already exists — pick another name.`)
      return
    }
    setBusy(true)
    setError('')
    const out = await postAction<{ session?: string }>({
      action: 'create_session',
      session: id,
      template: template.id,
      ...(series && series !== '__new' ? { series } : {}),
      ...(series === '__new' && slugify(newSeries) ? { new_series: slugify(newSeries) } : {}),
    })
    setBusy(false)
    if (out?.ok && out.data?.session) {
      onCreated(out.data.session)
    } else {
      setError(out ? out.error || out.message || 'The engine rejected the new session.' : 'The engine is not reachable — is the local API running?')
    }
  }

  return (
    <div className="modal-scrim">
      <div className="confirm-modal create-session">
        <h3>New video — {template.name}</h3>
        <p>{template.description}</p>
        <label className="cs-field">
          <b>Video id</b>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => setName(slugify(name))}
            placeholder="my-next-video"
            autoFocus
          />
        </label>
        <label className="cs-field">
          <b>Series</b>
          <select
            value={series}
            onChange={(e) => {
              const v = e.target.value
              setSeries(v)
              if (v && v !== '__new') setName(suggest(v))
            }}
          >
            <option value="">No series — standalone</option>
            {seriesOptions.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
            <option value="__new">New series…</option>
          </select>
        </label>
        {series === '__new' ? (
          <label className="cs-field">
            <b>New series id</b>
            <input
              value={newSeries}
              onChange={(e) => setNewSeries(e.target.value)}
              onBlur={() => setNewSeries(slugify(newSeries))}
              placeholder="my-series"
            />
          </label>
        ) : null}
        <p className="cs-note">
          {series === '__new'
            ? 'The template’s starter rules are copied into the new series — that copy becomes the living rulebook.'
            : series
              ? 'The episode joins this series and works under its rulebook.'
              : 'The template’s defaults are stamped into the new session.'}
        </p>
        {error ? <p className="cs-error">{error}</p> : null}
        <div className="actions">
          <button onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="primary" onClick={create} disabled={busy}>
            {busy ? <span className="spin" /> : null}
            {busy ? 'Creating…' : 'Create video'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ResumeRow({
  title,
  sub,
  step,
  pct,
  thumb,
  onClick,
  onDelete,
}: {
  title: string
  sub: string
  step: string
  pct: number
  thumb?: string
  onClick: () => void
  onDelete: () => void
}) {
  const menuRef = useRef<HTMLButtonElement | null>(null)
  const [menuPos, setMenuPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null)
  const toggleMenu = () => {
    if (menuPos) {
      setMenuPos(null)
      return
    }
    const rect = menuRef.current?.getBoundingClientRect()
    if (!rect) return
    const vw = document.documentElement.clientWidth || window.innerWidth
    const vh = document.documentElement.clientHeight || window.innerHeight
    const left = Math.max(8, Math.min(rect.right - 184, vw - 192))
    if (vh && rect.bottom + 90 > vh) {
      setMenuPos({ left, bottom: vh - rect.top + 4 })
    } else {
      setMenuPos({ left, top: rect.bottom + 4 })
    }
  }
  return (
    <div className="resume-row">
      <button className="resume-open" onClick={onClick}>
        {thumb ? (
          <span className="r-thumb">
            <img
              src={thumb}
              alt=""
              loading="lazy"
              onError={(e) => {
                // no rendered thumbnail yet — drop the slot, keep the row
                ;(e.currentTarget.parentElement as HTMLElement).style.display = 'none'
              }}
            />
          </span>
        ) : null}
        <span className="r-meta">
          <span className="r-title">{title}</span>
          <span className="r-sub">{sub}</span>
        </span>
        <span className="r-prog">
          <span className="r-step">{step}</span>
          <span className="bar"><i style={{ width: `${pct}%` }} /></span>
        </span>
      </button>
      <button
        ref={menuRef}
        type="button"
        className="vp-row-menu"
        aria-label={`Project actions for ${title}`}
        title="Project actions"
        onClick={toggleMenu}
      >
        ⋯
      </button>
      {menuPos
        ? createPortal(
            <>
              <span className="vp-menu-backdrop" onClick={() => setMenuPos(null)} />
              <span className="vp-menu" style={{ ...menuPos, minWidth: 184 }}>
                <span className="vp-menu-h">{title}</span>
                <button
                  type="button"
                  className="danger"
                  onClick={() => {
                    setMenuPos(null)
                    onDelete()
                  }}
                >
                  Delete project
                </button>
              </span>
            </>,
            document.body,
          )
        : null}
    </div>
  )
}
