import { useEffect, useMemo, useRef, useState } from 'react'
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
  onStandalone,
  onOpenSession,
  onScrolled,
}: {
  onStandalone: () => void
  onOpenSession: (id: string) => void
  onScrolled: (scrolled: boolean) => void
}) {
  const [q, setQ] = useState('')
  const [templates, setTemplates] = useState<EngineTemplate[]>([])
  const [sessions, setSessions] = useState<EngineSession[]>([])
  const [engineDown, setEngineDown] = useState(false)
  const [creating, setCreating] = useState<EngineTemplate | null>(null)
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

  return (
    <section className="tpl-picker" onScroll={(e) => onScrolled(e.currentTarget.scrollTop > 8)}>
      <div className="inner">
        <div className="head">
          <h1>Start a project</h1>
          <p className="lede">Pick up where you left off, or start something new.</p>
        </div>

        <button className="blank-top solo" onClick={onStandalone}>
          <span className="bt-glyph">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </span>
          <span className="bt-text">
            <span className="bt-title">Standalone — start blank</span>
            <span className="bt-sub">A true one-off. Choose format &amp; style from scratch — no template applied.</span>
          </span>
          <span className="bt-cta">Start blank →</span>
        </button>

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
              placeholder="Search template, format…"
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
      <span className="badge tl">{tpl.format}</span>
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
}: {
  title: string
  sub: string
  step: string
  pct: number
  thumb?: string
  onClick: () => void
}) {
  return (
    <button className="resume-row" onClick={onClick}>
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
      <div className="r-meta">
        <div className="r-title">{title}</div>
        <div className="r-sub">{sub}</div>
      </div>
      <div className="r-prog">
        <span className="r-step">{step}</span>
        <span className="bar"><i style={{ width: `${pct}%` }} /></span>
      </div>
    </button>
  )
}
