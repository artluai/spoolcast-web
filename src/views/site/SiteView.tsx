import { useEffect, useState } from 'react'
import { Link, Navigate, Route, Routes, useParams } from 'react-router-dom'
import AdminView from './AdminView'

// The viewer site (display layer). Own chrome — none of the editor header
// belongs here. Public visitors see public rows; a signed-in creator can also
// manage and watch private videos on their own profile.

type Creator = { id: number; handle: string; name: string; bio: string; avatar_url: string }
type Series = {
  id: number
  slug: string
  title: string
  description: string
  cover_url: string
  creator_handle?: string
  creator_name?: string
}
type Video = {
  id: number
  series_id: number | null
  slug: string
  title: string
  description: string
  episode: number | null
  media_url: string
  poster_url: string
  duration_s: number | null
  creator_handle?: string
  creator_name?: string
  series_title?: string
  series_slug?: string
  public: number
}

const getSite = async <T,>(path: string): Promise<T | null> => {
  try {
    const r = await fetch(`/api/site/${path}`)
    if (!r.ok) return null
    const out = await r.json()
    return (out?.data ?? null) as T
  } catch {
    return null
  }
}

const fmtDuration = (s: number | null) => {
  if (!s || s <= 0) return ''
  const m = Math.floor(s / 60)
  return `${m}:${String(Math.round(s % 60)).padStart(2, '0')}`
}

type User = { id: number; email: string; handle: string | null; name: string; role: string }

function SiteHeader() {
  const [user, setUser] = useState<User | null>(null)
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [note, setNote] = useState('')
  useEffect(() => {
    void fetch('/api/auth/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((out) => setUser(out?.data?.user ?? null))
      .catch(() => {})
  }, [])
  const request = async () => {
    setNote('')
    const r = await fetch('/api/auth/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    }).then((x) => x.json()).catch(() => null)
    if (!r?.ok) {
      setNote(r?.data?.error || 'Could not send the link.')
      return
    }
    // dev_link exists only in local development (AUTH_DEV_ECHO) — in
    // production the link arrives by email.
    setNote(r.data.dev_link ? `Dev link: ${r.data.dev_link}` : 'Check your email for the sign-in link.')
  }
  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
    setUser(null)
  }
  return (
    <header className="site-header">
      <Link to="/watch" className="site-brand">
        <b>Spoolcast</b>
      </Link>
      <div className="site-auth">
        {/* The editor's front door — /projects is the maker side. */}
        <Link className="site-create" to="/projects">+ Create</Link>
        {user ? (
          <>
            {user.handle ? (
              <Link className="site-auth-who" to={`/u/${user.handle}`}>@{user.handle}</Link>
            ) : (
              <span className="site-auth-who">{user.email}</span>
            )}
            <button type="button" onClick={() => void logout()}>Sign out</button>
          </>
        ) : open ? (
          <form
            className="site-auth-form"
            onSubmit={(e) => {
              e.preventDefault()
              void request()
            }}
          >
            {/* Google is the primary path; the email link stays as the
                fallback (and the local-dev login). */}
            <a className="site-auth-google" href="/api/auth/google">Continue with Google</a>
            <span className="site-auth-note">or</span>
            <input
              type="email"
              value={email}
              placeholder="you@email.com"
              onChange={(e) => setEmail(e.target.value)}
            />
            <button type="submit">Send link</button>
            {note && <span className="site-auth-note">{note}</span>}
          </form>
        ) : (
          <button type="button" onClick={() => setOpen(true)}>Sign in</button>
        )}
      </div>
    </header>
  )
}

function VideoCard({
  v,
  manage = false,
  changing = false,
  onVisibilityChange,
}: {
  v: Video
  manage?: boolean
  changing?: boolean
  onVisibilityChange?: (video: Video, isPublic: boolean) => void
}) {
  const card = (
    <Link to={`/watch/v/${v.slug}`} className="site-card">
      {v.poster_url ? (
        <img src={v.poster_url} alt={v.title} loading="lazy" />
      ) : (
        <div className="site-card-blank">
          <span>{v.title}</span>
        </div>
      )}
      <div className="site-card-meta">
        <b>{v.episode != null ? `${v.episode}. ` : ''}{v.title}</b>
        <span>{[v.creator_name, fmtDuration(v.duration_s)].filter(Boolean).join(' · ')}</span>
      </div>
    </Link>
  )
  if (!manage) return card
  return (
    <div className="site-card-manage">
      {card}
      <div className="site-card-actions">
        <span className={`admin-badge ${v.public ? 'live' : ''}`}>{v.public ? 'PUBLIC' : 'PRIVATE'}</span>
        <button
          type="button"
          className="admin-btn"
          disabled={changing}
          onClick={() => onVisibilityChange?.(v, !v.public)}
        >
          {changing ? 'Saving…' : v.public ? 'Make private' : 'Make public'}
        </button>
      </div>
    </div>
  )
}

function SiteHome() {
  const [latest, setLatest] = useState<Video[]>([])
  const [rows, setRows] = useState<{ series: Series; videos: Video[] }[]>([])
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    void getSite<{ latest: Video[]; rows: { series: Series; videos: Video[] }[] }>('home').then((d) => {
      if (d) {
        setLatest(d.latest)
        setRows(d.rows)
      }
      setLoaded(true)
    })
  }, [])
  return (
    <>
      {loaded && !latest.length && !rows.length && (
        <p className="site-empty">Nothing published yet.</p>
      )}
      {latest.length > 0 && (
        <section className="site-row">
          <h2>Latest</h2>
          <div className="site-strip">{latest.map((v) => <VideoCard key={v.id} v={v} />)}</div>
        </section>
      )}
      {rows.map(({ series, videos }) => (
        <section className="site-row" key={series.id}>
          <h2>
            <Link to={`/watch/s/${series.slug}`}>{series.title}</Link>
            {series.creator_handle && (
              <Link className="site-by" to={`/u/${series.creator_handle}`}>by {series.creator_name}</Link>
            )}
          </h2>
          <div className="site-strip">{videos.map((v) => <VideoCard key={v.id} v={v} />)}</div>
        </section>
      ))}
    </>
  )
}

function SiteSeries() {
  const { slug } = useParams()
  const [data, setData] = useState<{ series: Series; creator: Creator; videos: Video[] } | null>(null)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    void getSite<{ series: Series; creator: Creator; videos: Video[] }>(`s/${slug}`).then((d) => {
      setData(d)
      setLoaded(true)
    })
  }, [slug])
  if (!data) return loaded ? <p className="site-empty">This series isn’t public.</p> : null
  return (
    <>
      <section className="site-hero">
        <h1>{data.series.title}</h1>
        <p className="site-hero-by">
          <Link to={`/u/${data.creator.handle}`}>{data.creator.name}</Link>
          {' · '}{data.videos.length} episode{data.videos.length === 1 ? '' : 's'}
        </p>
        {data.series.description && <p className="site-hero-desc">{data.series.description}</p>}
      </section>
      <div className="site-grid">{data.videos.map((v) => <VideoCard key={v.id} v={v} />)}</div>
    </>
  )
}

function SiteProfile() {
  const { handle } = useParams()
  const [data, setData] = useState<{
    creator: Creator
    series: Series[]
    videos: Video[]
    owner: boolean
  } | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [changingId, setChangingId] = useState<number | null>(null)
  const [note, setNote] = useState('')
  useEffect(() => {
    void getSite<{
      creator: Creator
      series: Series[]
      videos: Video[]
      owner: boolean
    }>(`u/${handle}`).then((d) => {
      setData(d)
      setLoaded(true)
    })
  }, [handle])
  if (!data) return loaded ? <p className="site-empty">No such creator.</p> : null
  const setVisibility = async (video: Video, isPublic: boolean) => {
    setChangingId(video.id)
    setNote('')
    const response = await fetch(`/api/site/v/${video.slug}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ public: isPublic }),
    }).catch(() => null)
    const out = await response?.json().catch(() => null)
    if (!response?.ok || !out?.data?.video) {
      setNote(out?.data?.error || 'Could not change visibility.')
    } else {
      setData((current) => current && {
        ...current,
        videos: current.videos.map((v) => (v.id === video.id ? out.data.video : v)),
      })
      setNote(isPublic ? 'Video is now public.' : 'Video is now private.')
    }
    setChangingId(null)
  }
  const loose = data.videos.filter((v) => !data.series.some((s) => s.id === v.series_id))
  return (
    <>
      <section className="site-hero">
        <h1>{data.creator.name}</h1>
        <p className="site-hero-by">
          @{data.creator.handle}
          {data.owner ? ' · Your dashboard' : ''}
        </p>
        {data.creator.bio && <p className="site-hero-desc">{data.creator.bio}</p>}
        {note && <p className="site-owner-note" role="status">{note}</p>}
      </section>
      {data.series.map((s) => {
        const vids = data.videos.filter((v) => v.series_id === s.id)
        if (!vids.length) return null
        return (
          <section className="site-row" key={s.id}>
            <h2><Link to={`/watch/s/${s.slug}`}>{s.title}</Link></h2>
            <div className="site-strip">
              {vids.map((v) => (
                <VideoCard
                  key={v.id}
                  v={v}
                  manage={data.owner}
                  changing={changingId === v.id}
                  onVisibilityChange={setVisibility}
                />
              ))}
            </div>
          </section>
        )
      })}
      {loose.length > 0 && (
        <section className="site-row">
          <h2>Videos</h2>
          <div className="site-strip">
            {loose.map((v) => (
              <VideoCard
                key={v.id}
                v={v}
                manage={data.owner}
                changing={changingId === v.id}
                onVisibilityChange={setVisibility}
              />
            ))}
          </div>
        </section>
      )}
    </>
  )
}

function SitePlayer() {
  const { slug } = useParams()
  const [data, setData] = useState<{
    video: Video
    creator: Creator
    series: Series | null
    siblings: Video[]
    owner: boolean
  } | null>(null)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    void getSite<{
      video: Video
      creator: Creator
      series: Series | null
      siblings: Video[]
      owner: boolean
    }>(
      `v/${slug}`,
    ).then((d) => {
      setData(d)
      setLoaded(true)
    })
  }, [slug])
  if (!data) return loaded ? <p className="site-empty">This video isn’t public.</p> : null
  const { video, creator, series, siblings } = data
  const others = siblings.filter((s) => s.slug !== video.slug)
  return (
    <div className="site-player">
      <div className="site-player-main">
        <video key={video.slug} src={video.media_url} poster={video.poster_url || undefined} controls autoPlay playsInline />
        <h1>{video.episode != null ? `${video.episode}. ` : ''}{video.title}</h1>
        <p className="site-hero-by">
          <Link to={`/u/${creator.handle}`}>{creator.name}</Link>
          {series && <>{' · '}<Link to={`/watch/s/${series.slug}`}>{series.title}</Link></>}
          {data.owner && !video.public ? ' · Private' : ''}
        </p>
        {video.description && <p className="site-hero-desc">{video.description}</p>}
      </div>
      {others.length > 0 && (
        <aside className="site-player-side">
          <h2>In this series</h2>
          {others.map((v) => <VideoCard key={v.id} v={v} />)}
        </aside>
      )}
    </div>
  )
}

export default function SiteView() {
  return (
    <div className="site">
      <SiteHeader />
      <main className="site-main">
        <Routes>
          <Route path="/" element={<Navigate to="/watch" replace />} />
          <Route path="/watch" element={<SiteHome />} />
          <Route path="/watch/s/:slug" element={<SiteSeries />} />
          <Route path="/watch/v/:slug" element={<SitePlayer />} />
          <Route path="/u/:handle" element={<SiteProfile />} />
          <Route path="/admin" element={<AdminView />} />
        </Routes>
      </main>
    </div>
  )
}
